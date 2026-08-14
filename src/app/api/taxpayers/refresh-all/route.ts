import { NextResponse } from "next/server";
import { authenticateRequest, isAdminSession, READ_ONLY_FORBIDDEN_MESSAGE } from "@/lib/app-auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { invokeTaxpayerBatchRefresh } from "@/lib/xinvoice-worker";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const QUEUE_STATES = ["queued", "running", "retry", "success", "dead_letter", "cancelled"] as const;
type QueueState = (typeof QUEUE_STATES)[number];
type RefreshMode = "start" | "continue" | "stop";

type QueueStatus = Record<QueueState, number> & { pending: number; total: number; completed: number };

async function getQueueStatus(supabase: ReturnType<typeof createAdminClient>): Promise<QueueStatus> {
  const results = await Promise.all(QUEUE_STATES.map(async (state) => {
    const result = await supabase
      .from("refresh_queue")
      .select("tax_code", { count: "exact", head: true })
      .eq("state", state);
    return { state, count: result.count ?? 0, error: result.error };
  }));

  const failedResult = results.find((result) => result.error);
  if (failedResult?.error) throw failedResult.error;

  const counts = Object.fromEntries(results.map((result) => [result.state, result.count])) as Record<QueueState, number>;
  const total = QUEUE_STATES.reduce((sum, state) => sum + counts[state], 0);
  const completed = counts.success + counts.dead_letter + counts.cancelled;
  return {
    ...counts,
    pending: counts.queued + counts.running + counts.retry,
    total,
    completed,
  };
}

export async function POST(request: Request) {
  const session = await authenticateRequest(request);
  if (!session) {
    return NextResponse.json({ error: "Bạn cần đăng nhập." }, { status: 401 });
  }
  if (!isAdminSession(session)) {
    return NextResponse.json({ error: READ_ONLY_FORBIDDEN_MESSAGE }, { status: 403 });
  }

  let body: { mode?: RefreshMode } = {};
  try {
    body = await request.json() as { mode?: RefreshMode };
  } catch {
    // An empty body starts a manual refresh run.
  }

  const mode = body.mode ?? "start";
  if (mode !== "start" && mode !== "continue" && mode !== "stop") {
    return NextResponse.json({ error: "Chế độ cập nhật toàn bộ không hợp lệ." }, { status: 400 });
  }

  const supabase = createAdminClient();
  let queue = await getQueueStatus(supabase);
  let enqueued = 0;

  if (mode === "stop") {
    const { data, error } = await supabase.rpc("cancel_pending_taxpayer_refreshes");
    if (error) {
      console.error("manual all-taxpayer cancellation failed", error);
      return NextResponse.json({ error: "Không thể dừng hàng đợi cập nhật toàn bộ." }, { status: 500 });
    }

    queue = await getQueueStatus(supabase);
    return NextResponse.json({
      ok: true,
      done: queue.pending === 0,
      stopped: true,
      cancelled: Number(data ?? 0),
      total: queue.total,
      completed: queue.completed,
      pending: queue.pending,
      queue,
      message: queue.pending === 0
        ? "Đã dừng cập nhật toàn bộ."
        : "Đã dừng nhận các MST mới; các MST đang xử lý sẽ hoàn tất lượt hiện tại.",
    });
  }

  // A new manual run always requeues the full catalogue. The frontend locks
  // the button while the run is active, so a normal start refreshes every MST
  // instead of draining only the leftover retry rows.
  if (mode === "start") {
    const { data, error } = await supabase.rpc("enqueue_all_taxpayer_refreshes");
    if (error) {
      console.error("manual all-taxpayer enqueue failed", error);
      return NextResponse.json({ error: "Không thể đưa toàn bộ MST vào hàng đợi cập nhật." }, { status: 500 });
    }
    enqueued = Number(data ?? 0);
    queue = await getQueueStatus(supabase);
  }

  if (mode === "continue" && queue.pending === 0) {
    return NextResponse.json({
      ok: true,
      done: true,
      enqueued,
      processed: 0,
      skipped: 0,
      total: queue.total,
      completed: queue.completed,
      pending: 0,
      queue,
    });
  }

  try {
    const workerPayload = await invokeTaxpayerBatchRefresh();
    queue = await getQueueStatus(supabase);
    const processed = workerPayload.processed ?? 0;
    const skipped = workerPayload.results?.filter((result) => result.skipped).length ?? 0;
    const done = queue.pending === 0;

    return NextResponse.json({
      ok: true,
      done,
      enqueued,
      processed,
      skipped,
      total: queue.total,
      completed: queue.completed,
      pending: queue.pending,
      queue,
      message: done
        ? "Đã xử lý xong hàng đợi cập nhật toàn bộ."
        : processed === 0
          ? "Hàng đợi đang chờ lượt xử lý tiếp theo."
          : undefined,
    });
  } catch (error) {
    return NextResponse.json({
      ok: true,
      done: false,
      enqueued,
      processed: 0,
      total: queue.total,
      completed: queue.completed,
      pending: queue.pending,
      queue,
      message: error instanceof Error
        ? `Đã giữ hàng đợi để thử lại: ${error.message}`
        : "Đã giữ hàng đợi để thử lại ở lượt tiếp theo.",
    }, { status: 202 });
  }
}

import { NextResponse } from "next/server";
import { authenticateRequest, isAdminSession, READ_ONLY_FORBIDDEN_MESSAGE } from "@/lib/app-auth";
import { createAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const REFRESH_PAUSED_KEY = "refresh_worker_paused";
const QUEUE_STATES = ["queued", "running", "retry", "success", "dead_letter", "cancelled"] as const;
type QueueState = (typeof QUEUE_STATES)[number];
type RefreshMode = "start" | "start_errors" | "status" | "continue" | "pause" | "resume" | "stop";

type QueueStatus = Record<QueueState, number> & {
  pending: number;
  total: number;
  completed: number;
};

type RefreshStatus = QueueStatus & { paused: boolean };

async function authenticateAdmin(request: Request) {
  const session = await authenticateRequest(request);
  if (!session) {
    return { response: NextResponse.json({ error: "Bạn cần đăng nhập." }, { status: 401 }) };
  }
  if (!isAdminSession(session)) {
    return { response: NextResponse.json({ error: READ_ONLY_FORBIDDEN_MESSAGE }, { status: 403 }) };
  }
  return { session };
}

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

async function getRefreshPaused(supabase: ReturnType<typeof createAdminClient>) {
  const { data, error } = await supabase
    .from("app_settings")
    .select("setting_value")
    .eq("setting_key", REFRESH_PAUSED_KEY)
    .maybeSingle<{ setting_value: string }>();
  if (error) throw error;
  return data?.setting_value.toLowerCase() === "true";
}

async function setRefreshPaused(supabase: ReturnType<typeof createAdminClient>, paused: boolean) {
  const { data, error } = await supabase.rpc("set_refresh_worker_paused", { p_paused: paused });
  if (error) throw error;
  return Boolean(data);
}

async function getRefreshStatus(supabase: ReturnType<typeof createAdminClient>): Promise<RefreshStatus> {
  const [queue, paused] = await Promise.all([getQueueStatus(supabase), getRefreshPaused(supabase)]);
  return { ...queue, paused };
}

function statusResponse(status: RefreshStatus, extra: Record<string, unknown> = {}) {
  const done = status.pending === 0;
  return NextResponse.json({
    ok: true,
    done,
    active: !done,
    paused: status.paused,
    total: status.total,
    completed: status.completed,
    pending: status.pending,
    queue: status,
    ...extra,
  });
}

export async function GET(request: Request) {
  const auth = await authenticateAdmin(request);
  if (auth.response) return auth.response;

  try {
    const status = await getRefreshStatus(createAdminClient());
    return statusResponse(status);
  } catch (error) {
    console.error("refresh queue status read failed", error);
    return NextResponse.json({ error: "Không thể đọc tiến trình cập nhật MST." }, { status: 500 });
  }
}

export async function POST(request: Request) {
  const auth = await authenticateAdmin(request);
  if (auth.response) return auth.response;

  let body: { mode?: RefreshMode } = {};
  try {
    body = await request.json() as { mode?: RefreshMode };
  } catch {
    // An empty body starts a new full refresh run.
  }

  const mode = body.mode ?? "start";
  if (!["start", "start_errors", "status", "continue", "pause", "resume", "stop"].includes(mode)) {
    return NextResponse.json({ error: "Chế độ cập nhật toàn bộ không hợp lệ." }, { status: 400 });
  }

  const supabase = createAdminClient();
  try {
    if (mode === "start") {
      await setRefreshPaused(supabase, false);
      const { data, error } = await supabase.rpc("enqueue_all_taxpayer_refreshes");
      if (error) throw error;

      const status = await getRefreshStatus(supabase);
      return statusResponse(status, {
        started: true,
        enqueued: Number(data ?? 0),
        message: status.pending
          ? "Đã đưa toàn bộ MST vào hàng đợi. Supabase Cron sẽ xử lý theo từng batch."
          : "Không có MST cần đưa vào hàng đợi.",
      });
    }

    if (mode === "start_errors") {
      await setRefreshPaused(supabase, false);
      const { data, error } = await supabase.rpc("enqueue_error_taxpayer_refreshes");
      if (error) throw error;

      const status = await getRefreshStatus(supabase);
      return statusResponse(status, {
        started: true,
        enqueued: Number(data ?? 0),
        message: status.pending
          ? "Đã đưa các MST bị lỗi vào hàng đợi. Supabase Cron sẽ xử lý theo từng batch."
          : "Không có MST bị lỗi nào cần đưa vào hàng đợi.",
      });
    }

    if (mode === "pause" || mode === "stop") {
      await setRefreshPaused(supabase, true);
      const status = await getRefreshStatus(supabase);
      return statusResponse(status, {
        paused: true,
        stopped: mode === "stop",
        message: status.running
          ? "Đã tạm dừng batch mới. MST đang xử lý sẽ hoàn tất lượt hiện tại."
          : "Đã tạm dừng cập nhật. Vị trí trong hàng đợi được giữ nguyên.",
      });
    }

    if (mode === "resume") {
      await setRefreshPaused(supabase, false);
      const status = await getRefreshStatus(supabase);
      return statusResponse(status, {
        resumed: true,
        message: status.pending
          ? "Đã tiếp tục cập nhật. Supabase Cron sẽ gọi batch kế tiếp trong lượt gần nhất."
          : "Hàng đợi đã hoàn tất.",
      });
    }

    // `status` and the legacy `continue` mode are read-only. The worker is no
    // longer invoked by the browser; Supabase Cron owns queue draining.
    const status = await getRefreshStatus(supabase);
    return statusResponse(status);
  } catch (error) {
    console.error("refresh queue control failed", error);
    return NextResponse.json({ error: "Không thể điều khiển hàng đợi cập nhật MST." }, { status: 500 });
  }
}

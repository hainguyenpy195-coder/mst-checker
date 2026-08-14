import { NextResponse } from "next/server";
import { authenticateRequest } from "@/lib/app-auth";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  if (!(await authenticateRequest(request))) {
    return NextResponse.json({ error: "Bạn cần đăng nhập." }, { status: 401 });
  }

  const requestUrl = new URL(request.url);
  const requestedLimit = Number(requestUrl.searchParams.get("limit") ?? 100);
  const limit = Number.isFinite(requestedLimit)
    ? Math.min(Math.max(requestedLimit, 1), 200)
    : 100;
  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from("taxpayer_activity_logs")
    .select("id, action, import_id, tax_code, taxpayer_name, source_year, actor_username, details, created_at")
    .order("created_at", { ascending: false })
    .limit(limit);

  if (error) {
    console.error("taxpayer activity query failed", error);
    return NextResponse.json({ error: "Không thể tải lịch sử thao tác." }, { status: 500 });
  }

  return NextResponse.json({ rows: data ?? [] });
}

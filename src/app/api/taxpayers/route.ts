import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

const SHEETS = ["2023", "2024", "2025", "T2-26"] as const;

type TaxpayerRecord = {
  tax_code: string;
  name: string | null;
  org_type: string | null;
  address: string | null;
  tax_department: string | null;
  status: string | null;
  status_group: string | null;
  source_updated_at: string | null;
  last_checked_at: string | null;
  status_changed_at: string | null;
  last_error: string | null;
};

export async function GET(request: Request) {
  const requestUrl = new URL(request.url);
  const sheet = requestUrl.searchParams.get("sheet") ?? "all";
  const limit = Math.min(Math.max(Number(requestUrl.searchParams.get("limit") ?? 200), 1), 2500);

  if (sheet !== "all" && !SHEETS.includes(sheet as (typeof SHEETS)[number])) {
    return NextResponse.json({ error: "Sheet không hợp lệ." }, { status: 400 });
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) return NextResponse.json({ error: "Bạn cần đăng nhập." }, { status: 401 });

  const { data: profile } = await supabase
    .from("profiles")
    .select("approval_status")
    .eq("id", user.id)
    .maybeSingle<{ approval_status: string }>();

  if (profile?.approval_status !== "approved") {
    return NextResponse.json({ error: "Tài khoản chưa được phê duyệt." }, { status: 403 });
  }

  let sourceQuery = supabase
    .from("taxpayer_sources")
    .select("id, tax_code, source_sheet, source_year, source_row, source_vendor_name, source_note")
    .order("source_sheet", { ascending: true })
    .order("source_row", { ascending: true })
    .limit(limit);

  if (sheet !== "all") sourceQuery = sourceQuery.eq("source_sheet", sheet);

  const [{ data: sources, error: sourcesError }, totalCount, activeCount, staleCount, errorCount] = await Promise.all([
    sourceQuery,
    supabase.from("taxpayers").select("tax_code", { count: "exact", head: true }),
    supabase.from("taxpayers").select("tax_code", { count: "exact", head: true }).eq("status_group", "active"),
    supabase.from("refresh_queue").select("tax_code", { count: "exact", head: true }).in("state", ["queued", "retry", "running"]),
    supabase.from("taxpayers").select("tax_code", { count: "exact", head: true }).not("last_error", "is", null),
  ]);

  if (sourcesError) {
    console.error("taxpayer table query failed", sourcesError);
    return NextResponse.json({ error: "Không thể tải danh sách MST." }, { status: 500 });
  }

  const sourceRows = sources ?? [];
  const taxCodes = [...new Set(sourceRows.map((source) => source.tax_code))];
  const { data: taxpayers, error: taxpayersError } = taxCodes.length
    ? await supabase
        .from("taxpayers")
        .select("tax_code, name, org_type, address, tax_department, status, status_group, source_updated_at, last_checked_at, status_changed_at, last_error")
        .in("tax_code", taxCodes)
    : { data: [], error: null };

  if (taxpayersError) {
    console.error("taxpayer detail query failed", taxpayersError);
    return NextResponse.json({ error: "Không thể tải chi tiết MST." }, { status: 500 });
  }

  const byTaxCode = new Map((taxpayers as TaxpayerRecord[] | null ?? []).map((taxpayer) => [taxpayer.tax_code, taxpayer]));
  const rows = sourceRows.map((source) => ({
    ...source,
    taxpayer: byTaxCode.get(source.tax_code) ?? null,
  }));

  return NextResponse.json({
    rows,
    summary: {
      total: totalCount.count ?? 0,
      active: activeCount.count ?? 0,
      refreshPending: staleCount.count ?? 0,
      errors: errorCount.count ?? 0,
    },
    sheets: SHEETS,
  });
}

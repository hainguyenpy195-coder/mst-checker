import { NextResponse } from "next/server";
import { authenticateRequest, isAdminSession, READ_ONLY_FORBIDDEN_MESSAGE } from "@/lib/app-auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { isValidTaxCode, normalizeTaxCode, TAX_CODE_FORMAT_MESSAGE } from "@/lib/tax-code";
import { invokeTaxpayerRefresh } from "@/lib/xinvoice-worker";
import { readAllPages, readInCodeBatches } from "@/lib/supabase-pagination";

const YEAR_PATTERN = /^\d{4}$/;

type TaxpayerRecord = {
  tax_code: string;
  name: string | null;
  org_type: string | null;
  address: string | null;
  tax_department: string | null;
  status: string | null;
  status_group: string | null;
  source_updated_at: string | null;
  previous_checked_at: string | null;
  last_checked_at: string | null;
  status_changed_at: string | null;
  last_error: string | null;
  next_check_at: string | null;
};

function normalizeYear(value: string) {
  return value === "T2-26" || value === "T2-2026" ? "2026" : value;
}

export async function GET(request: Request) {
  if (!(await authenticateRequest(request))) {
    return NextResponse.json({ error: "Bạn cần đăng nhập." }, { status: 401 });
  }

  const requestUrl = new URL(request.url);
  const requestedYear = normalizeYear(requestUrl.searchParams.get("year") ?? requestUrl.searchParams.get("sheet") ?? "all");
  const year = requestedYear === "all" ? "all" : requestedYear;
  const limit = Math.min(Math.max(Number(requestUrl.searchParams.get("limit") ?? 5000), 1), 5000);

  if (year !== "all" && !YEAR_PATTERN.test(year)) {
    return NextResponse.json({ error: "Năm không hợp lệ." }, { status: 400 });
  }

  const supabase = createAdminClient();
  const [allYearRowsResult, sourceResult] = await Promise.all([
    readAllPages((from, to) => supabase
      .from("taxpayer_sources")
      .select("source_year")
      .not("source_year", "is", null)
      .range(from, to), 10000),
    readAllPages((from, to) => {
      let query = supabase
        .from("taxpayer_sources")
        .select("id, tax_code, source_sheet, source_year, source_row, source_vendor_name, source_note")
        .order("source_year", { ascending: true })
        .order("source_row", { ascending: true })
        .range(from, to);
      if (year !== "all") query = query.eq("source_year", year);
      return query;
    }, limit),
  ]);

  if (allYearRowsResult.error || sourceResult.error) {
    console.error("taxpayer source query failed", allYearRowsResult.error ?? sourceResult.error);
    return NextResponse.json({ error: "Không thể tải danh sách MST." }, { status: 500 });
  }

  const years = [...new Set((allYearRowsResult.data ?? []).map((row) => row.source_year).filter((value): value is string => Boolean(value)))]
    .sort((left, right) => Number(left) - Number(right));
  const sourceRows = sourceResult.data ?? [];
  const taxCodes = [...new Set(sourceRows.map((source) => normalizeTaxCode(source.tax_code)))];
  const taxpayerResult = taxCodes.length
    ? await readInCodeBatches(taxCodes, (batch) => supabase
        .from("taxpayers")
        .select("tax_code, name, org_type, address, tax_department, status, status_group, source_updated_at, previous_checked_at, last_checked_at, status_changed_at, last_error, next_check_at")
        .in("tax_code", batch))
    : { data: [], error: null };
  const { data: taxpayers, error: taxpayersError } = taxpayerResult;

  if (taxpayersError) {
    console.error("taxpayer detail query failed", taxpayersError);
    return NextResponse.json({ error: "Không thể tải chi tiết MST." }, { status: 500 });
  }

  const taxpayerRecords = (taxpayers as TaxpayerRecord[] | null) ?? [];
  const byTaxCode = new Map(taxpayerRecords.map((taxpayer) => [taxpayer.tax_code, taxpayer]));
  const rows = sourceRows.map((source) => ({ ...source, taxpayer: byTaxCode.get(source.tax_code) ?? null }));

  return NextResponse.json({
    rows,
    years,
  });
}

export async function POST(request: Request) {
  const session = await authenticateRequest(request);
  if (!session) {
    return NextResponse.json({ error: "Bạn cần đăng nhập." }, { status: 401 });
  }
  if (!isAdminSession(session)) {
    return NextResponse.json({ error: READ_ONLY_FORBIDDEN_MESSAGE }, { status: 403 });
  }

  let body: { taxCode?: string; name?: string; year?: string; note?: string };
  try {
    body = await request.json() as { taxCode?: string; name?: string; year?: string; note?: string };
  } catch {
    return NextResponse.json({ error: "Dữ liệu MST không hợp lệ." }, { status: 400 });
  }

  const taxCode = normalizeTaxCode(body.taxCode ?? "");
  const year = normalizeYear((body.year ?? "").trim());
  if (!isValidTaxCode(taxCode)) {
    return NextResponse.json({ error: TAX_CODE_FORMAT_MESSAGE }, { status: 400 });
  }
  if (!YEAR_PATTERN.test(year)) {
    return NextResponse.json({ error: "Năm theo dõi phải có 4 chữ số." }, { status: 400 });
  }

  const supabase = createAdminClient();
  const name = body.name?.trim() || null;
  const note = body.note?.trim() || null;
  const { data: existing, error: existingError } = await supabase.from("taxpayers").select("tax_code, name").eq("tax_code", taxCode).maybeSingle<{ tax_code: string; name: string | null }>();
  if (existingError) return NextResponse.json({ error: "Không thể kiểm tra MST hiện có." }, { status: 500 });
  if (existing) {
    return NextResponse.json({ error: `Mã số thuế ${taxCode} đã tồn tại trong danh mục, không thể thêm trùng.` }, { status: 409 });
  }

  const { error: taxpayerError } = await supabase.from("taxpayers").insert({ tax_code: taxCode, name, status_group: "unknown", next_check_at: new Date().toISOString() });
  if (taxpayerError) {
    if (taxpayerError.code === "23505") {
      return NextResponse.json({ error: `Mã số thuế ${taxCode} đã tồn tại trong danh mục, không thể thêm trùng.` }, { status: 409 });
    }
    return NextResponse.json({ error: "Không thể lưu MST vào cơ sở dữ liệu." }, { status: 500 });
  }

  const { error: sourceError } = await supabase
    .from("taxpayer_sources")
    .insert({ tax_code: taxCode, source_sheet: year, source_year: year, source_row: null, source_vendor_name: name, source_note: note });
  if (sourceError) return NextResponse.json({ error: "Không thể lưu năm theo dõi của MST." }, { status: 500 });

  const { error: queueError } = await supabase.rpc("request_taxpayer_refresh", { p_tax_code: taxCode });
  if (queueError) return NextResponse.json({ error: "Đã lưu MST nhưng không thể đưa vào hàng đợi cập nhật." }, { status: 500 });

  const { error: activityError } = await supabase.from("taxpayer_activity_logs").insert({
    action: "taxpayer_added",
    tax_code: taxCode,
    taxpayer_name: name,
    source_year: year,
    actor_username: session.username,
    details: { source_year: year, note },
  });
  if (activityError) console.error("taxpayer add activity log failed", activityError);

  let refreshRequested = false;
  let refreshWarning: string | undefined;
  try {
    const workerPayload = await invokeTaxpayerRefresh(taxCode);
    const result = workerPayload.results?.find((item) => item.tax_code === taxCode);
    refreshRequested = result?.ok === true;
    if (!refreshRequested) refreshWarning = result?.error ?? "MST đã được lưu nhưng đang chờ worker cập nhật.";
  } catch (error) {
    refreshWarning = error instanceof Error ? error.message : "MST đã được lưu nhưng chưa gọi được worker.";
  }

  return NextResponse.json({
    ok: true,
    taxCode,
    year,
    refreshRequested,
    refreshWarning,
    activityWarning: activityError ? "MST đã được thêm nhưng chưa ghi được lịch sử thao tác." : undefined,
  }, { status: 201 });
}

export async function DELETE(request: Request) {
  const session = await authenticateRequest(request);
  if (!session) {
    return NextResponse.json({ error: "Bạn cần đăng nhập." }, { status: 401 });
  }
  if (!isAdminSession(session)) {
    return NextResponse.json({ error: READ_ONLY_FORBIDDEN_MESSAGE }, { status: 403 });
  }

  let body: { taxCode?: string; confirmed?: boolean };
  try {
    body = await request.json() as { taxCode?: string; confirmed?: boolean };
  } catch {
    return NextResponse.json({ error: "Dữ liệu xóa MST không hợp lệ." }, { status: 400 });
  }

  const taxCode = normalizeTaxCode(body.taxCode ?? "");
  if (!isValidTaxCode(taxCode)) {
    return NextResponse.json({ error: TAX_CODE_FORMAT_MESSAGE }, { status: 400 });
  }
  if (body.confirmed !== true) {
    return NextResponse.json({ error: "Bạn cần xác nhận trước khi xóa MST." }, { status: 400 });
  }

  const supabase = createAdminClient();
  const [existingResult, sourceResult] = await Promise.all([
    supabase
      .from("taxpayers")
      .select("tax_code, name")
      .eq("tax_code", taxCode)
      .maybeSingle<{ tax_code: string; name: string | null }>(),
    supabase
      .from("taxpayer_sources")
      .select("source_year")
      .eq("tax_code", taxCode),
  ]);
  if (existingResult.error || sourceResult.error) {
    console.error("taxpayer delete lookup failed", existingResult.error ?? sourceResult.error);
    return NextResponse.json({ error: "Không thể kiểm tra MST cần xóa." }, { status: 500 });
  }
  const existing = existingResult.data;
  if (!existing) {
    return NextResponse.json({ error: `Không tìm thấy MST ${taxCode} trong danh mục.` }, { status: 404 });
  }

  // The schema cascades this deletion to source-year rows, refresh queue, and status history.
  const { error: deleteError } = await supabase.from("taxpayers").delete().eq("tax_code", taxCode);
  if (deleteError) {
    console.error("taxpayer delete failed", deleteError);
    return NextResponse.json({ error: "Không thể xóa MST khỏi cơ sở dữ liệu." }, { status: 500 });
  }

  const sourceYears = [...new Set((sourceResult.data ?? [])
    .map((source) => source.source_year)
    .filter((year): year is string => Boolean(year)))];
  const { error: activityError } = await supabase.from("taxpayer_activity_logs").insert({
    action: "taxpayer_deleted",
    tax_code: taxCode,
    taxpayer_name: existing.name,
    source_year: sourceYears.join(", ") || null,
    actor_username: session.username,
    details: { source_years: sourceYears },
  });
  if (activityError) console.error("taxpayer delete activity log failed", activityError);

  return NextResponse.json({
    ok: true,
    taxCode,
    message: `Đã xóa MST ${taxCode} khỏi danh mục.`,
    activityWarning: activityError ? "MST đã được xóa nhưng chưa ghi được lịch sử thao tác." : undefined,
  });
}

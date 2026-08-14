import { NextResponse } from "next/server";
import { authenticateRequest, isAdminSession, READ_ONLY_FORBIDDEN_MESSAGE } from "@/lib/app-auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { readInCodeBatches } from "@/lib/supabase-pagination";
import { getTaxpayerExcelMaxUploadBytes, parseTaxpayerWorkbook } from "@/lib/taxpayer-excel";
import {
  deleteTaxpayerImportFile,
  getTaxpayerImportSession,
  isTaxpayerImportId,
  TAXPAYER_IMPORT_BUCKET,
  TAXPAYER_IMPORT_STORAGE_MAX_BYTES,
} from "@/lib/taxpayer-import";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

type TaxpayerCodeRecord = { tax_code: string };

async function markImportFailed(supabase: ReturnType<typeof createAdminClient>, importId: string, message: string) {
  await supabase.from("taxpayer_excel_imports").update({
    status: "failed",
    error: message,
  }).eq("id", importId);
}

export async function POST(request: Request) {
  const session = await authenticateRequest(request);
  if (!session) return NextResponse.json({ error: "Bạn cần đăng nhập." }, { status: 401 });
  if (!isAdminSession(session)) {
    return NextResponse.json({ error: READ_ONLY_FORBIDDEN_MESSAGE }, { status: 403 });
  }

  let body: { importId?: unknown };
  try {
    body = await request.json() as { importId?: unknown };
  } catch {
    return NextResponse.json({ error: "Dữ liệu phiên nhập Excel không hợp lệ." }, { status: 400 });
  }
  if (!isTaxpayerImportId(body.importId)) {
    return NextResponse.json({ error: "Không xác định được phiên nhập Excel." }, { status: 400 });
  }

  const supabase = createAdminClient();
  const { data: importSession, error: sessionError } = await getTaxpayerImportSession(supabase, body.importId, session.username);
  if (sessionError) {
    console.error("taxpayer Excel import session lookup failed", sessionError);
    return NextResponse.json({ error: "Không thể kiểm tra phiên nhập Excel." }, { status: 500 });
  }
  if (!importSession) return NextResponse.json({ error: "Không tìm thấy phiên nhập Excel." }, { status: 404 });
  if (importSession.status !== "uploading") {
    return NextResponse.json({ error: "Phiên nhập Excel này đã được xử lý hoặc không còn hiệu lực." }, { status: 409 });
  }

  const { data: file, error: downloadError } = await supabase.storage
    .from(TAXPAYER_IMPORT_BUCKET)
    .download(importSession.storage_path);
  if (downloadError || !file) {
    const message = "Không thể đọc file Excel đã tải lên. Vui lòng thử lại.";
    console.error("taxpayer Excel temporary file download failed", downloadError);
    await markImportFailed(supabase, importSession.id, message);
    return NextResponse.json({ error: message }, { status: 422 });
  }

  const buffer = Buffer.from(await file.arrayBuffer());
  const maxBytes = Math.min(getTaxpayerExcelMaxUploadBytes(), TAXPAYER_IMPORT_STORAGE_MAX_BYTES);
  if (buffer.length <= 0) {
    const message = "File Excel đang rỗng.";
    await markImportFailed(supabase, importSession.id, message);
    await deleteTaxpayerImportFile(supabase, importSession.storage_path);
    return NextResponse.json({ error: message }, { status: 400 });
  }
  if (buffer.length > maxBytes) {
    const message = "File excel phải dưới 20MB";
    await markImportFailed(supabase, importSession.id, message);
    await deleteTaxpayerImportFile(supabase, importSession.storage_path);
    return NextResponse.json({ error: message }, { status: 413 });
  }

  let parsed: Awaited<ReturnType<typeof parseTaxpayerWorkbook>>;
  try {
    parsed = await parseTaxpayerWorkbook(buffer);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Không thể đọc cấu trúc file Excel.";
    console.error("taxpayer Excel parse failed", error);
    await markImportFailed(supabase, importSession.id, message);
    await deleteTaxpayerImportFile(supabase, importSession.storage_path);
    return NextResponse.json({ error: message }, { status: 422 });
  }

  const taxCodes = parsed.candidates.map((candidate) => candidate.taxCode);
  const existingResult = taxCodes.length
    ? await readInCodeBatches(taxCodes, (batch) => supabase
      .from("taxpayers")
      .select("tax_code")
      .in("tax_code", batch))
    : { data: [], error: null };
  if (existingResult.error) {
    const message = "Không thể kiểm tra MST đã có trong cơ sở dữ liệu.";
    console.error("taxpayer Excel existing-code lookup failed", existingResult.error);
    await markImportFailed(supabase, importSession.id, message);
    return NextResponse.json({ error: message }, { status: 500 });
  }

  const existingTaxCodes = new Set((existingResult.data as TaxpayerCodeRecord[]).map((row) => row.tax_code));
  // Keep existing MST candidates as well: their source rows may belong to a
  // new year or unit and must be recorded for yearly reports.
  const candidates = parsed.candidates;
  const newCandidateCount = candidates.filter((candidate) => !existingTaxCodes.has(candidate.taxCode)).length;
  const counts = {
    totalRows: parsed.totalRows,
    validRows: parsed.validRows,
    duplicateRows: parsed.duplicateRows,
    invalidRows: parsed.invalidRowCount,
    existing: existingTaxCodes.size,
    new: newCandidateCount,
  };
  const sourceYears = [...new Set(candidates.flatMap((candidate) => candidate.sources.map((source) => source.sourceYear)))].sort();

  const { error: previewError } = await supabase.from("taxpayer_excel_imports").update({
    status: "previewed",
    candidates,
    source_units: parsed.units,
    preview_stats: counts,
    source_years: sourceYears,
    previewed_at: new Date().toISOString(),
    error: null,
  }).eq("id", importSession.id).eq("status", "uploading");
  if (previewError) {
    console.error("taxpayer Excel preview session save failed", previewError);
    await markImportFailed(supabase, importSession.id, "Không thể lưu kết quả đọc file Excel.");
    return NextResponse.json({ error: "Không thể lưu kết quả đọc file Excel." }, { status: 500 });
  }

  const fileDeleted = await deleteTaxpayerImportFile(supabase, importSession.storage_path);
  if (fileDeleted) {
    await supabase.from("taxpayer_excel_imports").update({ file_deleted_at: new Date().toISOString() }).eq("id", importSession.id);
  }

  return NextResponse.json({
    ok: true,
    importId: importSession.id,
    fileName: importSession.file_name,
    candidates,
    units: parsed.units,
    counts,
    invalidRows: parsed.invalidRows,
    ignoredSheets: parsed.ignoredSheets,
    message: candidates.length
      ? `Đã đọc ${newCandidateCount.toLocaleString("vi-VN")} MST mới và ghi nhận nguồn dữ liệu cho ${existingTaxCodes.size.toLocaleString("vi-VN")} MST đã có.`
      : "Không tìm thấy MST hợp lệ trong file Excel.",
  }, { headers: { "cache-control": "no-store" } });
}

import { NextResponse } from "next/server";
import { authenticateRequest, isAdminSession, READ_ONLY_FORBIDDEN_MESSAGE } from "@/lib/app-auth";
import { parsePurchaseInvoiceWorkbook } from "@/lib/purchase-invoice-excel";
import {
  deletePurchaseInvoiceImportFile,
  getPurchaseInvoiceImportSession,
  isPurchaseInvoiceImportId,
  PURCHASE_INVOICE_IMPORT_BUCKET,
  PURCHASE_INVOICE_IMPORT_STORAGE_MAX_BYTES,
} from "@/lib/purchase-invoice-import";
import { readInCodeBatches } from "@/lib/supabase-pagination";
import { createAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Keep the Vercel Function response well below its body-size limit. The full
// candidate list remains in the server-side import session; the UI only needs
// a short sample to let the user validate the selected worksheet.
const PREVIEW_CANDIDATE_LIMIT = 30;
// SHA-256 fingerprints are much longer than tax codes. Keeping this low
// avoids an oversized PostgREST `in (...)` query string.
const FINGERPRINT_LOOKUP_BATCH_SIZE = 100;

type PurchaseInvoiceFingerprintRecord = { row_fingerprint: string };

async function markImportFailed(
  supabase: ReturnType<typeof createAdminClient>,
  importId: string,
  message: string,
) {
  await supabase.from("purchase_invoice_imports").update({
    status: "failed",
    error: message,
  }).eq("id", importId);
}

export async function POST(request: Request) {
  const session = await authenticateRequest(request);
  if (!session) return NextResponse.json({ error: "Bạn cần đăng nhập." }, { status: 401 });
  if (!isAdminSession(session)) return NextResponse.json({ error: READ_ONLY_FORBIDDEN_MESSAGE }, { status: 403 });

  let body: { importId?: unknown };
  try {
    body = await request.json() as { importId?: unknown };
  } catch {
    return NextResponse.json({ error: "Dữ liệu phiên nhập Excel không hợp lệ." }, { status: 400 });
  }
  if (!isPurchaseInvoiceImportId(body.importId)) {
    return NextResponse.json({ error: "Không xác định được phiên nhập Excel." }, { status: 400 });
  }

  const supabase = createAdminClient();
  const { data: importSession, error: sessionError } = await getPurchaseInvoiceImportSession(supabase, body.importId, session.username);
  if (sessionError) {
    console.error("purchase invoice Excel import session lookup failed", sessionError);
    return NextResponse.json({ error: "Không thể kiểm tra phiên nhập Excel." }, { status: 500 });
  }
  if (!importSession) return NextResponse.json({ error: "Không tìm thấy phiên nhập Excel." }, { status: 404 });
  if (importSession.status !== "uploading") {
    return NextResponse.json({ error: "Phiên nhập Excel này đã được xử lý hoặc không còn hiệu lực." }, { status: 409 });
  }

  const { data: file, error: downloadError } = await supabase.storage
    .from(PURCHASE_INVOICE_IMPORT_BUCKET)
    .download(importSession.storage_path);
  if (downloadError || !file) {
    const message = "Không thể đọc file Excel đã tải lên. Vui lòng thử lại.";
    console.error("purchase invoice Excel temporary file download failed", downloadError);
    await markImportFailed(supabase, importSession.id, message);
    return NextResponse.json({ error: message }, { status: 422 });
  }

  const buffer = Buffer.from(await file.arrayBuffer());
  if (buffer.length <= 0) {
    const message = "File Excel đang rỗng.";
    await markImportFailed(supabase, importSession.id, message);
    await deletePurchaseInvoiceImportFile(supabase, importSession.storage_path);
    return NextResponse.json({ error: message }, { status: 400 });
  }
  if (buffer.length > PURCHASE_INVOICE_IMPORT_STORAGE_MAX_BYTES) {
    const message = "File Excel phải dưới 20MB.";
    await markImportFailed(supabase, importSession.id, message);
    await deletePurchaseInvoiceImportFile(supabase, importSession.storage_path);
    return NextResponse.json({ error: message }, { status: 413 });
  }

  let parsed: Awaited<ReturnType<typeof parsePurchaseInvoiceWorkbook>>;
  try {
    parsed = await parsePurchaseInvoiceWorkbook(buffer);
  } catch (parseError) {
    const message = parseError instanceof Error ? parseError.message : "Không thể đọc cấu trúc file Excel.";
    console.error("purchase invoice Excel parse failed", parseError);
    await markImportFailed(supabase, importSession.id, message);
    await deletePurchaseInvoiceImportFile(supabase, importSession.storage_path);
    return NextResponse.json({ error: message }, { status: 422 });
  }

  const candidates = parsed.candidates;
  const fingerprints = [...new Set(candidates
    .map((candidate) => candidate.row_fingerprint)
    .filter((fingerprint): fingerprint is string => typeof fingerprint === "string" && fingerprint.length > 0))];
  if (fingerprints.length !== candidates.length) {
    const message = "Có dòng hóa đơn không có mã nhận diện nội bộ hợp lệ.";
    await markImportFailed(supabase, importSession.id, message);
    return NextResponse.json({ error: message }, { status: 422 });
  }

  const existingResult = fingerprints.length
    ? await readInCodeBatches(fingerprints, (batch) => supabase
      .from("purchase_invoices")
      .select("row_fingerprint")
      .in("row_fingerprint", batch), FINGERPRINT_LOOKUP_BATCH_SIZE)
    : { data: [], error: null };
  if (existingResult.error) {
    const message = "Không thể kiểm tra hóa đơn đã có trong cơ sở dữ liệu.";
    console.error("purchase invoice Excel existing fingerprint lookup failed", existingResult.error);
    await markImportFailed(supabase, importSession.id, message);
    return NextResponse.json({ error: message }, { status: 500 });
  }

  const existingFingerprints = new Set((existingResult.data as PurchaseInvoiceFingerprintRecord[]).map((row) => row.row_fingerprint));
  const invalidRows = 0;
  const counts = {
    totalRows: parsed.totalRows,
    validRows: parsed.validRows,
    duplicateRows: parsed.duplicateRows,
    invalidRows,
    existing: candidates.filter((candidate) => existingFingerprints.has(candidate.row_fingerprint)).length,
    new: candidates.filter((candidate) => !existingFingerprints.has(candidate.row_fingerprint)).length,
  };
  const previewStats = {
    ...counts,
    selectedSheet: parsed.selectedSheet,
    candidateSheets: parsed.candidateSheets,
    warnings: parsed.warnings,
  };

  const { error: previewError } = await supabase.from("purchase_invoice_imports").update({
    status: "previewed",
    candidates,
    preview_stats: previewStats,
    invalid_count: invalidRows,
    previewed_at: new Date().toISOString(),
    error: null,
  }).eq("id", importSession.id).eq("status", "uploading");
  if (previewError) {
    console.error("purchase invoice Excel preview session save failed", previewError);
    await markImportFailed(supabase, importSession.id, "Không thể lưu kết quả đọc file Excel.");
    return NextResponse.json({ error: "Không thể lưu kết quả đọc file Excel." }, { status: 500 });
  }

  const fileDeleted = await deletePurchaseInvoiceImportFile(supabase, importSession.storage_path);
  if (fileDeleted) {
    await supabase.from("purchase_invoice_imports").update({ file_deleted_at: new Date().toISOString() }).eq("id", importSession.id);
  }

  return NextResponse.json({
    ok: true,
    importId: importSession.id,
    fileName: importSession.file_name,
    candidates: candidates.slice(0, PREVIEW_CANDIDATE_LIMIT),
    totalCandidates: candidates.length,
    counts,
    warnings: parsed.warnings,
    selectedSheet: parsed.selectedSheet,
    candidateSheets: parsed.candidateSheets,
    message: candidates.length
      ? `Đã đọc ${counts.new.toLocaleString("vi-VN")} dòng mới và phát hiện ${counts.existing.toLocaleString("vi-VN")} dòng đã có.`
      : "Không tìm thấy dòng hóa đơn mua vào hợp lệ trong file Excel.",
  }, { headers: { "cache-control": "no-store" } });
}

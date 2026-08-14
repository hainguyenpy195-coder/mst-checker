import { NextResponse } from "next/server";
import { authenticateRequest, isAdminSession, READ_ONLY_FORBIDDEN_MESSAGE } from "@/lib/app-auth";
import {
  deletePurchaseInvoiceImportFile,
  getPurchaseInvoiceImportSession,
  isPurchaseInvoiceImportId,
  readStoredPurchaseInvoiceCandidates,
} from "@/lib/purchase-invoice-import";
import { readInCodeBatches } from "@/lib/supabase-pagination";
import { createAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const MAX_COMMIT_BATCH_SIZE = 100;

type PurchaseInvoiceFingerprintRecord = {
  row_fingerprint: string;
  import_id: string | null;
};

export async function POST(request: Request) {
  const session = await authenticateRequest(request);
  if (!session) return NextResponse.json({ error: "Bạn cần đăng nhập." }, { status: 401 });
  if (!isAdminSession(session)) return NextResponse.json({ error: READ_ONLY_FORBIDDEN_MESSAGE }, { status: 403 });

  let body: { importId?: unknown; offset?: unknown };
  try {
    body = await request.json() as { importId?: unknown; offset?: unknown };
  } catch {
    return NextResponse.json({ error: "Dữ liệu xác nhận nhập Excel không hợp lệ." }, { status: 400 });
  }
  if (!isPurchaseInvoiceImportId(body.importId)) {
    return NextResponse.json({ error: "Không xác định được phiên nhập Excel." }, { status: 400 });
  }

  const offset = typeof body.offset === "number" ? body.offset : Number(body.offset);
  if (!Number.isSafeInteger(offset) || offset < 0) {
    return NextResponse.json({ error: "Vị trí lô hóa đơn nhập vào không hợp lệ." }, { status: 400 });
  }

  const supabase = createAdminClient();
  const { data: importSession, error: sessionError } = await getPurchaseInvoiceImportSession(supabase, body.importId, session.username);
  if (sessionError) {
    console.error("purchase invoice Excel commit session lookup failed", sessionError);
    return NextResponse.json({ error: "Không thể kiểm tra phiên nhập Excel." }, { status: 500 });
  }
  if (!importSession) return NextResponse.json({ error: "Không tìm thấy phiên nhập Excel." }, { status: 404 });

  const candidates = readStoredPurchaseInvoiceCandidates(importSession.candidates);
  const storedCandidateCount = Array.isArray(importSession.candidates) ? importSession.candidates.length : 0;
  if (candidates.length !== storedCandidateCount) {
    return NextResponse.json({ error: "Dữ liệu hóa đơn đã lưu trong phiên nhập không hợp lệ." }, { status: 422 });
  }

  if (importSession.status === "completed") {
    return NextResponse.json({
      ok: true,
      done: true,
      nextOffset: importSession.commit_offset,
      totalCandidates: candidates.length,
      addedCount: importSession.added_count,
      skippedCount: importSession.skipped_count,
      failedCount: 0,
      insertedCount: 0,
    });
  }
  if (!['previewed', 'committing'].includes(importSession.status)) {
    return NextResponse.json({ error: "Phiên nhập Excel này không còn ở trạng thái chờ xác nhận." }, { status: 409 });
  }
  if (offset !== importSession.commit_offset) {
    return NextResponse.json({
      error: "Lô hóa đơn này không còn là lô kế tiếp cần xử lý.",
      nextOffset: importSession.commit_offset,
    }, { status: 409 });
  }
  if (offset >= candidates.length) {
    return NextResponse.json({
      ok: true,
      done: true,
      nextOffset: offset,
      totalCandidates: candidates.length,
      addedCount: importSession.added_count,
      skippedCount: importSession.skipped_count,
      failedCount: 0,
      insertedCount: 0,
    });
  }

  const batch = candidates.slice(offset, offset + MAX_COMMIT_BATCH_SIZE);
  const fingerprints = batch.map((candidate) => candidate.row_fingerprint);
  const existingResult = await readInCodeBatches(fingerprints, (fingerprintBatch) => supabase
    .from("purchase_invoices")
    .select("row_fingerprint, import_id")
    .in("row_fingerprint", fingerprintBatch));
  if (existingResult.error) {
    console.error("purchase invoice Excel commit existing fingerprint lookup failed", existingResult.error);
    return NextResponse.json({ error: "Không thể kiểm tra hóa đơn trước khi thêm." }, { status: 500 });
  }

  const existingRows = existingResult.data as PurchaseInvoiceFingerprintRecord[];
  const existingFingerprints = new Set(existingRows.map((row) => row.row_fingerprint));
  // A request can be interrupted after database insertion but before the
  // session cursor is advanced. Count rows already tied to this session as
  // added on retry, while treating every other existing fingerprint as skipped.
  const previouslyInsertedByThisSession = new Set(existingRows
    .filter((row) => row.import_id === importSession.id)
    .map((row) => row.row_fingerprint));
  const rowsToInsert = batch
    .filter((candidate) => !existingFingerprints.has(candidate.row_fingerprint))
    .map((candidate) => ({
      ...candidate,
      import_id: importSession.id,
      imported_by: session.username,
    }));

  let insertedFingerprints = new Set<string>();
  if (rowsToInsert.length) {
    const { data: insertedRows, error: insertError } = await supabase
      .from("purchase_invoices")
      .upsert(rowsToInsert, { onConflict: "row_fingerprint", ignoreDuplicates: true })
      .select("row_fingerprint");
    if (insertError) {
      console.error("purchase invoice Excel batch insert failed", insertError);
      return NextResponse.json({ error: "Không thể thêm hóa đơn hàng loạt. Hãy kiểm tra migration Mua vào trên Supabase." }, { status: 500 });
    }
    insertedFingerprints = new Set(((insertedRows ?? []) as unknown as PurchaseInvoiceFingerprintRecord[])
      .map((row) => row.row_fingerprint));
  }

  const insertedCount = insertedFingerprints.size;
  const addedThisBatch = insertedCount + previouslyInsertedByThisSession.size;
  const skippedThisBatch = batch.length - addedThisBatch;
  const nextOffset = offset + batch.length;
  const done = nextOffset >= candidates.length;
  const addedCount = importSession.added_count + addedThisBatch;
  const skippedCount = importSession.skipped_count + skippedThisBatch;
  const { data: updatedSession, error: updateError } = await supabase
    .from("purchase_invoice_imports")
    .update({
      status: done ? "completed" : "committing",
      commit_offset: nextOffset,
      added_count: addedCount,
      skipped_count: skippedCount,
      completed_at: done ? new Date().toISOString() : null,
      error: null,
    })
    .eq("id", importSession.id)
    .eq("commit_offset", offset)
    .in("status", ["previewed", "committing"])
    .select("id")
    .maybeSingle();
  if (updateError) {
    console.error("purchase invoice Excel commit session update failed", updateError);
    return NextResponse.json({ error: "Không thể cập nhật tiến trình nhập Excel." }, { status: 500 });
  }
  if (!updatedSession) {
    return NextResponse.json({
      error: "Lô hóa đơn này đã được xử lý bởi một phiên khác.",
      nextOffset: importSession.commit_offset,
    }, { status: 409 });
  }

  if (done && !importSession.file_deleted_at) {
    const fileDeleted = await deletePurchaseInvoiceImportFile(supabase, importSession.storage_path);
    if (fileDeleted) {
      await supabase.from("purchase_invoice_imports")
        .update({ file_deleted_at: new Date().toISOString() })
        .eq("id", importSession.id);
    }
  }

  return NextResponse.json({
    ok: true,
    done,
    nextOffset,
    totalCandidates: candidates.length,
    addedCount,
    skippedCount,
    failedCount: 0,
    insertedCount,
  }, { headers: { "cache-control": "no-store" } });
}

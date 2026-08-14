import { NextResponse } from "next/server";
import { authenticateRequest, isAdminSession, READ_ONLY_FORBIDDEN_MESSAGE } from "@/lib/app-auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { getTaxpayerExcelMaxUploadBytes } from "@/lib/taxpayer-excel";
import {
  deleteTaxpayerImportFile,
  getTaxpayerImportSession,
  getTaxpayerImportStoragePath,
  isTaxpayerImportId,
  TAXPAYER_IMPORT_BUCKET,
  TAXPAYER_IMPORT_STORAGE_MAX_BYTES,
} from "@/lib/taxpayer-import";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

const XLSX_MIME_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

export async function POST(request: Request) {
  const session = await authenticateRequest(request);
  if (!session) return NextResponse.json({ error: "Bạn cần đăng nhập." }, { status: 401 });
  if (!isAdminSession(session)) {
    return NextResponse.json({ error: READ_ONLY_FORBIDDEN_MESSAGE }, { status: 403 });
  }

  let body: { fileName?: unknown; fileSize?: unknown; contentType?: unknown };
  try {
    body = await request.json() as { fileName?: unknown; fileSize?: unknown; contentType?: unknown };
  } catch {
    return NextResponse.json({ error: "Thông tin file Excel không hợp lệ." }, { status: 400 });
  }

  const fileName = typeof body.fileName === "string" ? body.fileName.trim() : "";
  const fileSize = typeof body.fileSize === "number" ? body.fileSize : Number(body.fileSize);
  const contentType = typeof body.contentType === "string" ? body.contentType : "";
  if (!fileName || fileName.length > 255 || !fileName.toLowerCase().endsWith(".xlsx")) {
    return NextResponse.json({ error: "Chỉ chấp nhận file Excel định dạng .xlsx." }, { status: 415 });
  }
  if (!Number.isSafeInteger(fileSize) || fileSize <= 0) {
    return NextResponse.json({ error: "File Excel đang rỗng hoặc có kích thước không hợp lệ." }, { status: 400 });
  }
  if (contentType && contentType !== XLSX_MIME_TYPE && contentType !== "application/octet-stream") {
    return NextResponse.json({ error: "Kiểu file Excel không được hỗ trợ." }, { status: 415 });
  }

  const maxBytes = Math.min(getTaxpayerExcelMaxUploadBytes(), TAXPAYER_IMPORT_STORAGE_MAX_BYTES);
  if (fileSize > maxBytes) {
    return NextResponse.json({ error: "File excel phải dưới 20MB" }, { status: 413 });
  }

  const importId = crypto.randomUUID();
  const storagePath = getTaxpayerImportStoragePath(importId);
  const supabase = createAdminClient();
  const { error: insertError } = await supabase.from("taxpayer_excel_imports").insert({
    id: importId,
    storage_path: storagePath,
    file_name: fileName,
    file_size: fileSize,
    actor_username: session.username,
  });
  if (insertError) {
    console.error("taxpayer Excel import session creation failed", insertError);
    return NextResponse.json({ error: "Không thể tạo phiên nhập Excel." }, { status: 500 });
  }

  const { data: signedUpload, error: signedUploadError } = await supabase.storage
    .from(TAXPAYER_IMPORT_BUCKET)
    .createSignedUploadUrl(storagePath, { upsert: false });
  if (signedUploadError || !signedUpload) {
    console.error("taxpayer Excel signed upload URL creation failed", signedUploadError);
    await supabase.from("taxpayer_excel_imports").delete().eq("id", importId);
    return NextResponse.json({ error: "Không thể chuẩn bị nơi tải file Excel lên." }, { status: 500 });
  }

  return NextResponse.json({
    ok: true,
    importId,
    signedUrl: signedUpload.signedUrl,
    path: signedUpload.path,
    fileName,
  }, { headers: { "cache-control": "no-store" } });
}

export async function DELETE(request: Request) {
  const session = await authenticateRequest(request);
  if (!session) return NextResponse.json({ error: "Bạn cần đăng nhập." }, { status: 401 });
  if (!isAdminSession(session)) {
    return NextResponse.json({ error: READ_ONLY_FORBIDDEN_MESSAGE }, { status: 403 });
  }

  const importId = new URL(request.url).searchParams.get("importId");
  if (!isTaxpayerImportId(importId)) {
    return NextResponse.json({ error: "Không xác định được phiên nhập Excel." }, { status: 400 });
  }

  const supabase = createAdminClient();
  const { data: importSession, error: sessionError } = await getTaxpayerImportSession(supabase, importId, session.username);
  if (sessionError) {
    console.error("taxpayer Excel cancellation session lookup failed", sessionError);
    return NextResponse.json({ error: "Không thể kiểm tra phiên nhập Excel." }, { status: 500 });
  }
  if (!importSession) return NextResponse.json({ error: "Không tìm thấy phiên nhập Excel." }, { status: 404 });
  if (["committing", "completed"].includes(importSession.status)) {
    return NextResponse.json({ error: "Phiên nhập Excel đã bắt đầu ghi dữ liệu, không thể hủy." }, { status: 409 });
  }

  if (!importSession.file_deleted_at) {
    await deleteTaxpayerImportFile(supabase, importSession.storage_path);
  }
  const { error: updateError } = await supabase.from("taxpayer_excel_imports").update({
    status: "cancelled",
    error: null,
  }).eq("id", importSession.id);
  if (updateError) {
    console.error("taxpayer Excel cancellation update failed", updateError);
    return NextResponse.json({ error: "Không thể hủy phiên nhập Excel." }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}

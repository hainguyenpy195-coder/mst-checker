import { NextResponse } from "next/server";
import { authenticateRequest, isAdminSession, READ_ONLY_FORBIDDEN_MESSAGE } from "@/lib/app-auth";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  getImportSourceYears,
  getTaxpayerImportSession,
  isTaxpayerImportId,
  readStoredCandidates,
} from "@/lib/taxpayer-import";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

function readCount(value: unknown) {
  const count = typeof value === "number" ? value : Number(value);
  return Number.isSafeInteger(count) && count >= 0 ? count : null;
}

export async function POST(request: Request) {
  const session = await authenticateRequest(request);
  if (!session) return NextResponse.json({ error: "Bạn cần đăng nhập." }, { status: 401 });
  if (!isAdminSession(session)) {
    return NextResponse.json({ error: READ_ONLY_FORBIDDEN_MESSAGE }, { status: 403 });
  }

  let body: { importId?: unknown; updatedCount?: unknown; failedCount?: unknown; reviewCount?: unknown };
  try {
    body = await request.json() as { importId?: unknown; updatedCount?: unknown; failedCount?: unknown; reviewCount?: unknown };
  } catch {
    return NextResponse.json({ error: "Dữ liệu hoàn tất nhập Excel không hợp lệ." }, { status: 400 });
  }
  if (!isTaxpayerImportId(body.importId)) {
    return NextResponse.json({ error: "Không xác định được phiên nhập Excel." }, { status: 400 });
  }

  const updatedCount = readCount(body.updatedCount);
  const failedCount = readCount(body.failedCount);
  const reviewCount = readCount(body.reviewCount ?? 0);
  if (updatedCount === null || failedCount === null || reviewCount === null) {
    return NextResponse.json({ error: "Số liệu cập nhật MST không hợp lệ." }, { status: 400 });
  }

  const supabase = createAdminClient();
  const { data: importSession, error: sessionError } = await getTaxpayerImportSession(supabase, body.importId, session.username);
  if (sessionError) {
    console.error("taxpayer Excel completion session lookup failed", sessionError);
    return NextResponse.json({ error: "Không thể kiểm tra phiên nhập Excel." }, { status: 500 });
  }
  if (!importSession) return NextResponse.json({ error: "Không tìm thấy phiên nhập Excel." }, { status: 404 });

  if (importSession.status === "completed") {
    return NextResponse.json({
      ok: true,
      alreadyCompleted: true,
      addedCount: importSession.added_count,
      updatedCount: importSession.updated_count,
      failedCount: importSession.failed_count,
      reviewCount: importSession.review_count,
    });
  }
  if (!["previewed", "committing"].includes(importSession.status)) {
    return NextResponse.json({ error: "Phiên nhập Excel này không thể hoàn tất." }, { status: 409 });
  }

  const candidates = readStoredCandidates(importSession.candidates);
  if (importSession.commit_offset < candidates.length) {
    return NextResponse.json({ error: "Vẫn còn MST chưa được thêm vào cơ sở dữ liệu." }, { status: 409 });
  }
  if (updatedCount + failedCount + reviewCount > candidates.length) {
    return NextResponse.json({ error: "Số MST cập nhật vượt quá số MST đã thêm." }, { status: 400 });
  }

  const sourceYears = importSession.source_years.length
    ? importSession.source_years
    : getImportSourceYears(candidates);
  const previewStats = importSession.preview_stats;
  const details = {
    source: "excel_import",
    import_id: importSession.id,
    file_name: importSession.file_name,
    total_rows: previewStats.totalRows ?? 0,
    valid_rows: previewStats.validRows ?? 0,
    duplicate_rows: previewStats.duplicateRows ?? 0,
    invalid_rows: previewStats.invalidRows ?? 0,
    existing_count: previewStats.existing ?? 0,
    new_count: previewStats.new ?? candidates.length,
    added_count: importSession.added_count,
    updated_count: updatedCount,
    failed_count: failedCount,
    review_count: reviewCount,
    source_years: sourceYears,
  };
  const { error: activityError } = await supabase.from("taxpayer_activity_logs").insert({
    action: "excel_imported",
    import_id: importSession.id,
    tax_code: null,
    taxpayer_name: importSession.file_name,
    source_year: sourceYears.join(", ") || null,
    actor_username: session.username,
    details,
  });
  if (activityError && activityError.code !== "23505") {
    console.error("taxpayer Excel completion activity log failed", activityError);
    return NextResponse.json({ error: "Đã nhập MST nhưng chưa ghi được sự kiện vào Lịch sử." }, { status: 500 });
  }

  const { error: updateError } = await supabase.from("taxpayer_excel_imports").update({
    status: "completed",
    updated_count: updatedCount,
    failed_count: failedCount,
    review_count: reviewCount,
    completed_at: new Date().toISOString(),
    error: null,
  }).eq("id", importSession.id).in("status", ["previewed", "committing"]);
  if (updateError) {
    console.error("taxpayer Excel completion session update failed", updateError);
    return NextResponse.json({ error: "Không thể lưu trạng thái hoàn tất nhập Excel." }, { status: 500 });
  }

  return NextResponse.json({
    ok: true,
    addedCount: importSession.added_count,
    updatedCount,
    failedCount,
    reviewCount,
  });
}

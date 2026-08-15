import { NextResponse } from "next/server";
import { authenticateRequest, isAdminSession, READ_ONLY_FORBIDDEN_MESSAGE } from "@/lib/app-auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { isValidTaxCode, normalizeTaxCode, TAX_CODE_FORMAT_MESSAGE } from "@/lib/tax-code";
import type { TaxpayerEvidence } from "@/lib/types";
import {
  detectTaxpayerEvidenceMimeType,
  getTaxpayerEvidenceStoragePath,
  resolveTaxpayerEvidenceMimeType,
  sanitizeTaxpayerEvidenceFileName,
  TAXPAYER_EVIDENCE_BUCKET,
  TAXPAYER_EVIDENCE_MAX_BYTES,
} from "@/lib/taxpayer-evidence";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

type TaxpayerEvidenceRecord = TaxpayerEvidence & {
  tax_code: string;
  storage_path: string;
  uploaded_by: string;
};

function getTaxCode(request: Request) {
  const requestUrl = new URL(request.url);
  return normalizeTaxCode(requestUrl.searchParams.get("taxCode") ?? "");
}

function summarizeEvidence(record: TaxpayerEvidenceRecord) {
  return {
    file_name: record.file_name,
    content_type: record.content_type,
    file_size: Number(record.file_size),
    updated_at: record.updated_at,
  } satisfies TaxpayerEvidence;
}

export async function GET(request: Request) {
  const session = await authenticateRequest(request);
  if (!session) return NextResponse.json({ error: "Bạn cần đăng nhập." }, { status: 401 });

  const taxCode = getTaxCode(request);
  if (!isValidTaxCode(taxCode)) {
    return NextResponse.json({ error: TAX_CODE_FORMAT_MESSAGE }, { status: 400 });
  }

  const supabase = createAdminClient();
  const { data: evidence, error } = await supabase
    .from("taxpayer_evidence")
    .select("tax_code, storage_path, file_name, content_type, file_size, uploaded_by, updated_at")
    .eq("tax_code", taxCode)
    .maybeSingle<TaxpayerEvidenceRecord>();

  if (error) {
    console.error("taxpayer evidence lookup failed", error);
    return NextResponse.json({ error: "Không thể đọc ảnh bằng chứng." }, { status: 500 });
  }
  if (!evidence) return NextResponse.json({ evidence: null }, { headers: { "cache-control": "no-store" } });

  const { data: signedUrl, error: signedUrlError } = await supabase.storage
    .from(TAXPAYER_EVIDENCE_BUCKET)
    .createSignedUrl(evidence.storage_path, 15 * 60);
  if (signedUrlError || !signedUrl) {
    console.error("taxpayer evidence signed URL creation failed", signedUrlError);
    return NextResponse.json({ error: "Không thể mở ảnh bằng chứng." }, { status: 500 });
  }

  return NextResponse.json({
    evidence: {
      ...summarizeEvidence(evidence),
      url: signedUrl.signedUrl,
    },
  }, { headers: { "cache-control": "no-store" } });
}

export async function POST(request: Request) {
  const session = await authenticateRequest(request);
  if (!session) return NextResponse.json({ error: "Bạn cần đăng nhập." }, { status: 401 });
  if (!isAdminSession(session)) {
    return NextResponse.json({ error: READ_ONLY_FORBIDDEN_MESSAGE }, { status: 403 });
  }

  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return NextResponse.json({ error: "Không đọc được ảnh tải lên." }, { status: 400 });
  }

  const taxCode = normalizeTaxCode(String(formData.get("taxCode") ?? ""));
  if (!isValidTaxCode(taxCode)) {
    return NextResponse.json({ error: TAX_CODE_FORMAT_MESSAGE }, { status: 400 });
  }

  const fileValue = formData.get("file");
  if (!(fileValue instanceof File)) {
    return NextResponse.json({ error: "Vui lòng chọn ảnh bằng chứng." }, { status: 400 });
  }
  if (fileValue.size <= 0) {
    return NextResponse.json({ error: "Ảnh tải lên đang rỗng." }, { status: 400 });
  }
  if (fileValue.size > TAXPAYER_EVIDENCE_MAX_BYTES) {
    return NextResponse.json({ error: "Ảnh bằng chứng phải nhỏ hơn 4MB." }, { status: 413 });
  }

  const declaredMimeType = resolveTaxpayerEvidenceMimeType(fileValue.name, fileValue.type);
  if (!declaredMimeType) {
    return NextResponse.json({ error: "Chỉ chấp nhận ảnh PNG, JPG/JPEG hoặc WEBP." }, { status: 415 });
  }

  const bytes = new Uint8Array(await fileValue.arrayBuffer());
  if (bytes.length <= 0 || bytes.length > TAXPAYER_EVIDENCE_MAX_BYTES) {
    return NextResponse.json({ error: "Ảnh bằng chứng phải nhỏ hơn 4MB." }, { status: 413 });
  }
  const detectedMimeType = detectTaxpayerEvidenceMimeType(bytes);
  if (detectedMimeType !== declaredMimeType) {
    return NextResponse.json({ error: "Nội dung file không khớp với định dạng ảnh được chọn." }, { status: 415 });
  }

  const supabase = createAdminClient();
  const [taxpayerResult, existingResult] = await Promise.all([
    supabase.from("taxpayers").select("tax_code").eq("tax_code", taxCode).maybeSingle<{ tax_code: string }>(),
    supabase
      .from("taxpayer_evidence")
      .select("tax_code, storage_path, file_name, content_type, file_size, uploaded_by, updated_at")
      .eq("tax_code", taxCode)
      .maybeSingle<TaxpayerEvidenceRecord>(),
  ]);
  if (taxpayerResult.error || existingResult.error) {
    console.error("taxpayer evidence prerequisite lookup failed", taxpayerResult.error ?? existingResult.error);
    return NextResponse.json({ error: "Không thể kiểm tra MST và ảnh bằng chứng hiện có." }, { status: 500 });
  }
  if (!taxpayerResult.data) {
    return NextResponse.json({ error: `Không tìm thấy MST ${taxCode}.` }, { status: 404 });
  }

  const storagePath = getTaxpayerEvidenceStoragePath(taxCode, detectedMimeType);
  const { error: uploadError } = await supabase.storage
    .from(TAXPAYER_EVIDENCE_BUCKET)
    .upload(storagePath, bytes, {
      contentType: detectedMimeType,
      cacheControl: "31536000",
      upsert: false,
    });
  if (uploadError) {
    console.error("taxpayer evidence upload failed", uploadError);
    return NextResponse.json({ error: "Không thể lưu ảnh bằng chứng vào Storage." }, { status: 500 });
  }

  const { data: savedEvidence, error: saveError } = await supabase
    .from("taxpayer_evidence")
    .upsert({
      tax_code: taxCode,
      storage_path: storagePath,
      file_name: sanitizeTaxpayerEvidenceFileName(fileValue.name),
      content_type: detectedMimeType,
      file_size: bytes.length,
      uploaded_by: session.username,
    }, { onConflict: "tax_code" })
    .select("tax_code, storage_path, file_name, content_type, file_size, uploaded_by, updated_at")
    .single<TaxpayerEvidenceRecord>();

  if (saveError || !savedEvidence) {
    console.error("taxpayer evidence metadata save failed", saveError);
    await supabase.storage.from(TAXPAYER_EVIDENCE_BUCKET).remove([storagePath]);
    return NextResponse.json({ error: "Không thể lưu thông tin ảnh bằng chứng." }, { status: 500 });
  }

  let storageWarning: string | undefined;
  const oldStoragePath = existingResult.data?.storage_path;
  if (oldStoragePath && oldStoragePath !== storagePath) {
    const { error: removeOldError } = await supabase.storage
      .from(TAXPAYER_EVIDENCE_BUCKET)
      .remove([oldStoragePath]);
    if (removeOldError) {
      console.error("old taxpayer evidence cleanup failed", removeOldError);
      storageWarning = "Ảnh mới đã được cập nhật nhưng ảnh cũ chưa được dọn khỏi Storage.";
    }
  }

  return NextResponse.json({
    ok: true,
    evidence: summarizeEvidence(savedEvidence),
    storageWarning,
  }, { headers: { "cache-control": "no-store" } });
}

export async function DELETE(request: Request) {
  const session = await authenticateRequest(request);
  if (!session) return NextResponse.json({ error: "Bạn cần đăng nhập." }, { status: 401 });
  if (!isAdminSession(session)) {
    return NextResponse.json({ error: READ_ONLY_FORBIDDEN_MESSAGE }, { status: 403 });
  }

  const taxCode = getTaxCode(request);
  if (!isValidTaxCode(taxCode)) {
    return NextResponse.json({ error: TAX_CODE_FORMAT_MESSAGE }, { status: 400 });
  }

  const supabase = createAdminClient();
  const { data: evidence, error: lookupError } = await supabase
    .from("taxpayer_evidence")
    .select("tax_code, storage_path, file_name, content_type, file_size, uploaded_by, updated_at")
    .eq("tax_code", taxCode)
    .maybeSingle<TaxpayerEvidenceRecord>();
  if (lookupError) {
    console.error("taxpayer evidence deletion lookup failed", lookupError);
    return NextResponse.json({ error: "Không thể kiểm tra ảnh bằng chứng." }, { status: 500 });
  }
  if (!evidence) return NextResponse.json({ evidence: null });

  const { error: deleteError } = await supabase.from("taxpayer_evidence").delete().eq("tax_code", taxCode);
  if (deleteError) {
    console.error("taxpayer evidence metadata deletion failed", deleteError);
    return NextResponse.json({ error: "Không thể xóa thông tin ảnh bằng chứng." }, { status: 500 });
  }

  const { error: storageError } = await supabase.storage
    .from(TAXPAYER_EVIDENCE_BUCKET)
    .remove([evidence.storage_path]);
  return NextResponse.json({
    ok: true,
    storageWarning: storageError ? "Thông tin ảnh đã được xóa nhưng file cũ chưa được dọn khỏi Storage." : undefined,
  });
}

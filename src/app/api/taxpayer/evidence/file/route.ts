import { NextResponse } from "next/server";
import { authenticateRequest } from "@/lib/app-auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { readStorageObject } from "@/lib/storage/local";
import { isValidTaxCode, normalizeTaxCode, TAX_CODE_FORMAT_MESSAGE } from "@/lib/tax-code";
import { TAXPAYER_EVIDENCE_BUCKET } from "@/lib/taxpayer-evidence";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type EvidenceFileRecord = {
  storage_path: string;
  file_name: string;
  content_type: string;
};

export async function GET(request: Request) {
  const session = await authenticateRequest(request);
  if (!session) return NextResponse.json({ error: "Bạn cần đăng nhập." }, { status: 401 });

  const taxCode = normalizeTaxCode(new URL(request.url).searchParams.get("taxCode") ?? "");
  if (!isValidTaxCode(taxCode)) return NextResponse.json({ error: TAX_CODE_FORMAT_MESSAGE }, { status: 400 });

  const { data: evidence, error } = await createAdminClient()
    .from("taxpayer_evidence")
    .select("storage_path, file_name, content_type")
    .eq("tax_code", taxCode)
    .maybeSingle<EvidenceFileRecord>();
  if (error) {
    console.error("taxpayer evidence file lookup failed", error);
    return NextResponse.json({ error: "Không thể mở ảnh bằng chứng." }, { status: 500 });
  }
  if (!evidence) return NextResponse.json({ error: "Không tìm thấy ảnh bằng chứng." }, { status: 404 });

  try {
    const bytes = await readStorageObject(TAXPAYER_EVIDENCE_BUCKET, evidence.storage_path);
    const safeFileName = evidence.file_name.replace(/[\r\n"\\/]/g, "_");
    return new NextResponse(bytes, {
      headers: {
        "content-type": evidence.content_type,
        "content-length": String(bytes.length),
        "content-disposition": `inline; filename="${safeFileName}"`,
        "cache-control": "private, no-store",
        "x-content-type-options": "nosniff",
      },
    });
  } catch (storageError) {
    console.error("taxpayer evidence file read failed", storageError);
    return NextResponse.json({ error: "Không thể đọc file ảnh bằng chứng." }, { status: 404 });
  }
}

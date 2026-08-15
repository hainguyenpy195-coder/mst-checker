import { NextResponse } from "next/server";
import { authenticateRequest, isAdminSession, READ_ONLY_FORBIDDEN_MESSAGE } from "@/lib/app-auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { isValidTaxCode, normalizeTaxCode, TAX_CODE_FORMAT_MESSAGE } from "@/lib/tax-code";
import type { Taxpayer } from "@/lib/types";
import { invokeTaxpayerRefresh } from "@/lib/xinvoice-worker";

const FRESHNESS_MS = 24 * 60 * 60 * 1000;

type TaxpayerEvidenceRecord = {
  tax_code: string;
  file_name: string;
  content_type: string;
  file_size: number;
  updated_at: string;
};

function isStale(lastCheckedAt: string | null) {
  if (!lastCheckedAt) return true;
  return Date.now() - new Date(lastCheckedAt).getTime() > FRESHNESS_MS;
}

export async function GET(request: Request) {
  const session = await authenticateRequest(request);
  if (!session) {
    return NextResponse.json({ error: "Bạn cần đăng nhập để tra cứu." }, { status: 401 });
  }

  const requestUrl = new URL(request.url);
  const taxCode = normalizeTaxCode(requestUrl.searchParams.get("taxCode") ?? "");
  if (!isValidTaxCode(taxCode)) {
    return NextResponse.json(
      { error: TAX_CODE_FORMAT_MESSAGE },
      { status: 400 },
    );
  }

  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from("taxpayers")
    .select("tax_code, name, org_type, address, tax_department, status, status_group, source_updated_at, previous_checked_at, last_checked_at, status_changed_at, last_error, next_check_at, needs_manual_review, manual_review_reason, name_source")
    .eq("tax_code", taxCode)
    .maybeSingle<Taxpayer>();

  if (error) {
    console.error("taxpayer lookup failed", error);
    return NextResponse.json({ error: "Không thể truy vấn dữ liệu lúc này." }, { status: 500 });
  }

  const stale = isStale(data?.last_checked_at ?? null);
  let refreshRequested = false;
  if (data && stale && isAdminSession(session)) {
    const { error: refreshError } = await supabase.rpc("request_taxpayer_refresh", { p_tax_code: taxCode });
    refreshRequested = !refreshError;
  }

  return NextResponse.json({ data, meta: { stale, refreshRequested } });
}

export async function PATCH(request: Request) {
  const session = await authenticateRequest(request);
  if (!session) return NextResponse.json({ error: "Bạn cần đăng nhập." }, { status: 401 });
  if (!isAdminSession(session)) {
    return NextResponse.json({ error: READ_ONLY_FORBIDDEN_MESSAGE }, { status: 403 });
  }

  let body: { oldTaxCode?: unknown; newTaxCode?: unknown };
  try {
    body = await request.json() as { oldTaxCode?: unknown; newTaxCode?: unknown };
  } catch {
    return NextResponse.json({ error: "Dữ liệu sửa MST không hợp lệ." }, { status: 400 });
  }

  const oldTaxCode = normalizeTaxCode(typeof body.oldTaxCode === "string" ? body.oldTaxCode : "");
  const newTaxCode = normalizeTaxCode(typeof body.newTaxCode === "string" ? body.newTaxCode : "");
  if (!isValidTaxCode(oldTaxCode) || !isValidTaxCode(newTaxCode)) {
    return NextResponse.json({ error: TAX_CODE_FORMAT_MESSAGE }, { status: 400 });
  }

  const supabase = createAdminClient();
  if (oldTaxCode !== newTaxCode) {
    const { error: renameError } = await supabase.rpc("rename_taxpayer_code", {
      p_old_tax_code: oldTaxCode,
      p_new_tax_code: newTaxCode,
      p_actor_username: session.username,
    });
    if (renameError) {
      console.error("taxpayer code rename failed", renameError);
      const message = renameError.message.toLowerCase();
      if (message.includes("already exists")) {
        return NextResponse.json({ error: `Mã số thuế ${newTaxCode} đã tồn tại trong danh mục.` }, { status: 409 });
      }
      if (message.includes("not found")) {
        return NextResponse.json({ error: `Không tìm thấy MST ${oldTaxCode} trong danh mục.` }, { status: 404 });
      }
      if (message.includes("invalid tax code")) {
        return NextResponse.json({ error: TAX_CODE_FORMAT_MESSAGE }, { status: 400 });
      }
      return NextResponse.json({ error: "Không thể sửa mã số thuế trong cơ sở dữ liệu." }, { status: 500 });
    }
  }

  let refreshWarning: string | undefined;
  try {
    const workerPayload = await invokeTaxpayerRefresh(newTaxCode);
    const result = workerPayload.results?.find((item) => item.tax_code === newTaxCode);
    if (result?.ok !== true) refreshWarning = result?.error ?? "MST đã sửa nhưng chưa lấy được dữ liệu từ endpoint.";
  } catch (error) {
    refreshWarning = error instanceof Error ? error.message : "MST đã sửa nhưng chưa gọi được endpoint cập nhật.";
  }

  const [taxpayerResult, evidenceResult] = await Promise.all([
    supabase
      .from("taxpayers")
      .select("tax_code, name, org_type, address, tax_department, status, status_group, source_updated_at, previous_checked_at, last_checked_at, status_changed_at, last_error, next_check_at, needs_manual_review, manual_review_reason, name_source")
      .eq("tax_code", newTaxCode)
      .maybeSingle<Taxpayer>(),
    supabase
      .from("taxpayer_evidence")
      .select("tax_code, file_name, content_type, file_size, updated_at")
      .eq("tax_code", newTaxCode)
      .maybeSingle<TaxpayerEvidenceRecord>(),
  ]);

  if (taxpayerResult.error || evidenceResult.error || !taxpayerResult.data) {
    console.error("taxpayer code rename result lookup failed", taxpayerResult.error ?? evidenceResult.error);
    return NextResponse.json({ error: "MST đã sửa nhưng không thể tải lại dữ liệu mới." }, { status: 500 });
  }

  return NextResponse.json({
    ok: true,
    oldTaxCode,
    taxCode: newTaxCode,
    refreshWarning,
    taxpayer: { ...taxpayerResult.data, evidence: evidenceResult.data ?? null },
    message: refreshWarning
      ? `Đã sửa MST thành ${newTaxCode}, nhưng endpoint chưa trả về dữ liệu mới.`
      : `Đã sửa MST thành ${newTaxCode} và cập nhật dữ liệu từ endpoint.`,
  });
}

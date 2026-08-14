import { NextResponse } from "next/server";
import { authenticateRequest, isAdminSession, READ_ONLY_FORBIDDEN_MESSAGE } from "@/lib/app-auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { isValidTaxCode, normalizeTaxCode, TAX_CODE_FORMAT_MESSAGE } from "@/lib/tax-code";
import { invokeTaxpayerRefresh } from "@/lib/xinvoice-worker";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type TaxpayerDetail = {
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
};

async function readTaxpayerDetail(supabase: ReturnType<typeof createAdminClient>, taxCode: string) {
  const { data, error } = await supabase
    .from("taxpayers")
    .select("tax_code, name, org_type, address, tax_department, status, status_group, source_updated_at, previous_checked_at, last_checked_at, status_changed_at, last_error")
    .eq("tax_code", taxCode)
    .maybeSingle<TaxpayerDetail>();
  if (error) console.error("updated taxpayer detail read failed", error);
  return data;
}

export async function POST(request: Request) {
  const session = await authenticateRequest(request);
  if (!session) {
    return NextResponse.json({ error: "Bạn cần đăng nhập." }, { status: 401 });
  }
  if (!isAdminSession(session)) {
    return NextResponse.json({ error: READ_ONLY_FORBIDDEN_MESSAGE }, { status: 403 });
  }

  let body: { taxCode?: string };
  try {
    body = await request.json() as { taxCode?: string };
  } catch {
    return NextResponse.json({ error: "Dữ liệu MST không hợp lệ." }, { status: 400 });
  }

  const taxCode = normalizeTaxCode(body.taxCode ?? "");
  if (!isValidTaxCode(taxCode)) {
    return NextResponse.json({ error: TAX_CODE_FORMAT_MESSAGE }, { status: 400 });
  }

  const supabase = createAdminClient();
  const { data: taxpayer, error: taxpayerError } = await supabase
    .from("taxpayers")
    .select("tax_code")
    .eq("tax_code", taxCode)
    .maybeSingle<{ tax_code: string }>();

  if (taxpayerError) {
    return NextResponse.json({ error: "Không thể kiểm tra MST cần cập nhật." }, { status: 500 });
  }
  if (!taxpayer) {
    return NextResponse.json({ error: "MST chưa có trong danh mục quản lý." }, { status: 404 });
  }

  const { error: queueError } = await supabase.rpc("request_taxpayer_refresh", { p_tax_code: taxCode });
  if (queueError) {
    console.error("manual taxpayer refresh queue failed", queueError);
    return NextResponse.json({ error: "Không thể đưa MST vào hàng đợi cập nhật." }, { status: 500 });
  }

  try {
    const workerPayload = await invokeTaxpayerRefresh(taxCode);
    const result = workerPayload.results?.find((item) => item.tax_code === taxCode);

    if (workerPayload.processed === 0 || !result) {
      return NextResponse.json({
        ok: true,
        taxCode,
        pending: true,
        message: "MST đang được một lượt cập nhật khác xử lý.",
      }, { status: 202 });
    }

    if (!result.ok) {
      return NextResponse.json({ error: result.error ?? "Không thể cập nhật MST." }, { status: 502 });
    }

    const updatedTaxpayer = await readTaxpayerDetail(supabase, taxCode);
    return NextResponse.json({
      ok: true,
      taxCode,
      updated: !result.skipped,
      skipped: Boolean(result.skipped),
      taxpayer: updatedTaxpayer,
    });
  } catch (error) {
    console.error("manual taxpayer refresh failed", error);
    return NextResponse.json({
      ok: true,
      taxCode,
      pending: true,
      message: error instanceof Error
        ? `MST đã được đưa vào hàng đợi nhưng chưa gọi được worker: ${error.message}`
        : "MST đã được đưa vào hàng đợi nhưng chưa gọi được worker.",
    }, { status: 202 });
  }
}

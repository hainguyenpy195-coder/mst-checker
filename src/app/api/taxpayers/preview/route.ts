import { NextResponse } from "next/server";
import { authenticateRequest } from "@/lib/app-auth";
import { isValidTaxCode, normalizeTaxCode, TAX_CODE_FORMAT_MESSAGE } from "@/lib/tax-code";
import { createAdminClient } from "@/lib/supabase/admin";
import { invokeTaxpayerPreview } from "@/lib/xinvoice-worker";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function previewErrorMessage(error: unknown) {
  const message = error instanceof Error ? error.message : "";
  if (/RATE_LIMIT|429/i.test(message)) {
    return "Dịch vụ tra cứu đang giới hạn yêu cầu. Vui lòng thử lại sau ít phút hoặc nhập tên thủ công.";
  }
  if (/NO_DATA|HTTP_404/i.test(message)) {
    return "Không tìm thấy thông tin MST từ các endpoint. Bạn có thể nhập tên thủ công rồi lưu MST.";
  }
  return "Chưa thể tra cứu dữ liệu tự động. Bạn có thể nhập tên thủ công rồi lưu MST.";
}

export async function POST(request: Request) {
  if (!(await authenticateRequest(request))) {
    return NextResponse.json({ error: "Bạn cần đăng nhập." }, { status: 401 });
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
  const { data: existing, error: existingError } = await supabase
    .from("taxpayers")
    .select("tax_code, name")
    .eq("tax_code", taxCode)
    .maybeSingle<{ tax_code: string; name: string | null }>();
  if (existingError) {
    console.error("taxpayer preview duplicate check failed", existingError);
    return NextResponse.json({ error: "Không thể kiểm tra MST hiện có." }, { status: 500 });
  }
  if (existing) {
    return NextResponse.json({
      exists: true,
      taxCode,
      taxpayer: existing,
      message: `Mã số thuế ${taxCode} đã tồn tại trong danh mục, không thể thêm trùng.`,
    });
  }

  try {
    const workerPayload = await invokeTaxpayerPreview(taxCode);
    if (!workerPayload.preview) {
      return NextResponse.json({ error: "Worker không trả về thông tin MST." }, { status: 502 });
    }

    return NextResponse.json({
      exists: false,
      taxCode,
      preview: workerPayload.preview,
      provider: workerPayload.provider,
    });
  } catch (error) {
    console.error("taxpayer preview worker failed", error);
    return NextResponse.json({
      error: previewErrorMessage(error),
    }, { status: error instanceof Error && /RATE_LIMIT|429/i.test(error.message) ? 429 : 502 });
  }
}

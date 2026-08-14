import { NextResponse } from "next/server";
import { authenticateRequest, isAdminSession, READ_ONLY_FORBIDDEN_MESSAGE } from "@/lib/app-auth";
import { isValidTaxCode, normalizeTaxCode } from "@/lib/tax-code";
import { invokeTaxpayerBatchRefresh } from "@/lib/xinvoice-worker";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const MAX_WORKER_BATCH_SIZE = 10;

export async function POST(request: Request) {
  const session = await authenticateRequest(request);
  if (!session) return NextResponse.json({ error: "Bạn cần đăng nhập." }, { status: 401 });
  if (!isAdminSession(session)) {
    return NextResponse.json({ error: READ_ONLY_FORBIDDEN_MESSAGE }, { status: 403 });
  }

  let body: { taxCodes?: unknown };
  try {
    body = await request.json() as { taxCodes?: unknown };
  } catch {
    return NextResponse.json({ error: "Dữ liệu cập nhật MST không hợp lệ." }, { status: 400 });
  }

  if (!Array.isArray(body.taxCodes) || body.taxCodes.length === 0 || body.taxCodes.length > MAX_WORKER_BATCH_SIZE) {
    return NextResponse.json({ error: `Mỗi lượt cập nhật phải có từ 1 đến ${MAX_WORKER_BATCH_SIZE} MST.` }, { status: 400 });
  }

  const taxCodes = [...new Set(body.taxCodes
    .filter((taxCode): taxCode is string => typeof taxCode === "string")
    .map((taxCode) => normalizeTaxCode(taxCode)))];
  if (!taxCodes.length || taxCodes.some((taxCode) => !isValidTaxCode(taxCode))) {
    return NextResponse.json({ error: "Danh sách MST cập nhật có mã không đúng định dạng." }, { status: 400 });
  }

  try {
    const workerPayload = await invokeTaxpayerBatchRefresh(taxCodes);
    return NextResponse.json({ ok: true, taxCodes, ...workerPayload });
  } catch (error) {
    console.error("taxpayer Excel targeted refresh failed", error);
    return NextResponse.json({
      error: error instanceof Error ? error.message : "Không thể gọi worker cập nhật MST.",
    }, { status: 502 });
  }
}

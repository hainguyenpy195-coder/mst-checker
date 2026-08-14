import { NextResponse } from "next/server";
import { authenticateRequest, isAdminSession, READ_ONLY_FORBIDDEN_MESSAGE } from "@/lib/app-auth";
import { createTaxpayerTemplateWorkbook } from "@/lib/taxpayer-excel";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const session = await authenticateRequest(request);
  if (!session) return NextResponse.json({ error: "Bạn cần đăng nhập." }, { status: 401 });
  if (!isAdminSession(session)) {
    return NextResponse.json({ error: READ_ONLY_FORBIDDEN_MESSAGE }, { status: 403 });
  }

  const workbook = createTaxpayerTemplateWorkbook();
  const buffer = await workbook.xlsx.writeBuffer();
  return new NextResponse(new Uint8Array(buffer), {
    headers: {
      "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "content-disposition": 'attachment; filename="TAX-ID-Checker-import-template.xlsx"',
      "cache-control": "no-store",
    },
  });
}

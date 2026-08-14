import { NextResponse } from "next/server";
import { authenticateRequest } from "@/lib/app-auth";
import { readInvoiceTaxpayerMap, normalizeInvoiceSellerTaxCode } from "@/lib/invoice-taxpayer";
import { createAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  if (!(await authenticateRequest(request))) {
    return NextResponse.json({ error: "Bạn cần đăng nhập." }, { status: 401 });
  }

  const requestUrl = new URL(request.url);
  const taxCode = normalizeInvoiceSellerTaxCode(requestUrl.searchParams.get("taxCode"));
  if (!taxCode) {
    return NextResponse.json({ error: "MST không hợp lệ." }, { status: 400 });
  }

  try {
    const taxpayer = (await readInvoiceTaxpayerMap(createAdminClient(), [taxCode])).get(taxCode) ?? null;
    return NextResponse.json({ taxCode, taxpayer });
  } catch (error) {
    console.error("invoice taxpayer status read failed", error);
    return NextResponse.json({ error: "Không thể tải trạng thái MST." }, { status: 500 });
  }
}

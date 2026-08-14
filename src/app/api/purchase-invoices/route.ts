import { NextResponse } from "next/server";
import { authenticateRequest } from "@/lib/app-auth";
import { normalizeInvoiceSellerTaxCode, readInvoiceTaxpayerMap } from "@/lib/invoice-taxpayer";
import type { InvoiceTaxpayerSummary } from "@/lib/invoice-types";
import { createAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PAGE_SIZE = 100;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

const PURCHASE_INVOICE_SELECT = [
  "id",
  "row_fingerprint",
  "invoice_identity_key",
  "invoice_number",
  "invoice_issue_date",
  "seller_name",
  "seller_tax_code",
  "invoice_template_number",
  "invoice_symbol",
  "goods_services",
  "net_amount",
  "deductible_vat_amount",
  "accounting_voucher",
  "accounting_date",
  "tax_rate",
  "description",
  "department_code",
  "source_sheet",
  "source_row",
  "source_stt",
  "created_at",
].join(", ");

type PurchaseInvoiceRecord = {
  id: string;
  row_fingerprint: string;
  invoice_identity_key: string | null;
  invoice_number: string | null;
  invoice_issue_date: string | null;
  seller_name: string | null;
  seller_tax_code: string | null;
  invoice_template_number: string | null;
  invoice_symbol: string | null;
  goods_services: string | null;
  net_amount: number | string | null;
  deductible_vat_amount: number | string | null;
  accounting_voucher: string | null;
  accounting_date: string | null;
  tax_rate: string | null;
  description: string | null;
  department_code: string | null;
  source_sheet: string;
  source_row: number;
  source_stt: number | null;
  created_at: string;
};

type PurchaseInvoiceWithTaxpayer = PurchaseInvoiceRecord & {
  seller_taxpayer: InvoiceTaxpayerSummary | null;
};

function readDateFilter(value: string | null, label: string) {
  if (value === null || value === "") return { value: null };
  if (!DATE_PATTERN.test(value)) return { error: `${label} phải có định dạng YYYY-MM-DD.` };

  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    return { error: `${label} không phải ngày hợp lệ.` };
  }
  return { value };
}

export async function GET(request: Request) {
  if (!(await authenticateRequest(request))) {
    return NextResponse.json({ error: "Bạn cần đăng nhập." }, { status: 401 });
  }

  const requestUrl = new URL(request.url);
  const requestedPage = Number(requestUrl.searchParams.get("page") ?? "1");
  const page = Number.isInteger(requestedPage) && requestedPage > 0 ? requestedPage : 1;
  const queryText = (requestUrl.searchParams.get("q") ?? "").replace(/[%,()]/g, " ").trim().slice(0, 80);
  const dateFromResult = readDateFilter(requestUrl.searchParams.get("dateFrom"), "Ngày từ");
  const dateToResult = readDateFilter(requestUrl.searchParams.get("dateTo"), "Ngày đến");
  if (dateFromResult.error || dateToResult.error) {
    return NextResponse.json({ error: dateFromResult.error ?? dateToResult.error }, { status: 400 });
  }
  if (dateFromResult.value && dateToResult.value && dateFromResult.value > dateToResult.value) {
    return NextResponse.json({ error: "Ngày từ không thể lớn hơn ngày đến." }, { status: 400 });
  }

  const offset = (page - 1) * PAGE_SIZE;
  const supabase = createAdminClient();
  let purchaseQuery = supabase
    .from("purchase_invoices")
    .select(PURCHASE_INVOICE_SELECT, { count: "exact" })
    .order("invoice_issue_date", { ascending: false, nullsFirst: false })
    .order("created_at", { ascending: false })
    .range(offset, offset + PAGE_SIZE - 1);

  if (queryText) {
    purchaseQuery = purchaseQuery.or(
      "invoice_number.ilike.%" + queryText + "%"
        + ",seller_name.ilike.%" + queryText + "%"
        + ",seller_tax_code.ilike.%" + queryText + "%"
        + ",invoice_symbol.ilike.%" + queryText + "%"
        + ",goods_services.ilike.%" + queryText + "%"
        + ",description.ilike.%" + queryText + "%",
    );
  }
  if (dateFromResult.value) purchaseQuery = purchaseQuery.gte("invoice_issue_date", dateFromResult.value);
  if (dateToResult.value) purchaseQuery = purchaseQuery.lte("invoice_issue_date", dateToResult.value);

  const { data, error, count } = await purchaseQuery;
  if (error) {
    console.error("purchase invoice list query failed", error);
    return NextResponse.json({ error: "Không thể tải danh sách hóa đơn mua vào. Hãy kiểm tra migration Mua vào trên Supabase." }, { status: 500 });
  }

  const records = (data ?? []) as unknown as PurchaseInvoiceRecord[];
  let rows: PurchaseInvoiceWithTaxpayer[];
  try {
    const taxpayerByCode = await readInvoiceTaxpayerMap(supabase, records.map((record) => record.seller_tax_code ?? ""));
    rows = records.map((record) => {
      const taxCode = normalizeInvoiceSellerTaxCode(record.seller_tax_code);
      return {
        ...record,
        seller_taxpayer: taxCode ? taxpayerByCode.get(taxCode) ?? null : null,
      };
    });
  } catch (taxpayerError) {
    console.error("purchase invoice taxpayer status query failed", taxpayerError);
    return NextResponse.json({ error: "Không thể tải trạng thái MST người bán." }, { status: 500 });
  }

  const total = count ?? 0;
  return NextResponse.json({
    rows,
    total,
    page,
    pageSize: PAGE_SIZE,
    totalPages: Math.max(1, Math.ceil(total / PAGE_SIZE)),
  }, { headers: { "cache-control": "no-store" } });
}

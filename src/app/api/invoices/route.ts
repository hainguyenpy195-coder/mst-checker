import { NextResponse } from "next/server";
import { authenticateRequest } from "@/lib/app-auth";
import { INVOICE_SELECT, getVietnamMonthStart } from "@/lib/invoice-db";
import { normalizeInvoiceTemplateAndSymbol } from "@/lib/invoice-extraction";
import { attachInvoiceTaxpayers } from "@/lib/invoice-taxpayer";
import { createAdminClient } from "@/lib/supabase/admin";
import type { InvoiceRecord, InvoiceVerificationStatus } from "@/lib/invoice-types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PAGE_SIZE = 100;
const statuses = new Set<InvoiceVerificationStatus>(["unverified", "valid", "invalid", "error"]);

export async function GET(request: Request) {
  if (!(await authenticateRequest(request))) {
    return NextResponse.json({ error: "Bạn cần đăng nhập." }, { status: 401 });
  }

  const requestUrl = new URL(request.url);
  const requestedPage = Number(requestUrl.searchParams.get("page") ?? "1");
  const page = Number.isInteger(requestedPage) && requestedPage > 0 ? requestedPage : 1;
  const status = requestUrl.searchParams.get("status") ?? "all";
  const queryText = (requestUrl.searchParams.get("q") ?? "").replace(/[%,()]/g, " ").trim().slice(0, 80);
  const offset = (page - 1) * PAGE_SIZE;
  const supabase = createAdminClient();

  let invoiceQuery = supabase
    .from("invoices")
    .select(INVOICE_SELECT, { count: "exact" })
    .order("created_at", { ascending: false })
    .range(offset, offset + PAGE_SIZE - 1);

  if (statuses.has(status as InvoiceVerificationStatus)) {
    invoiceQuery = invoiceQuery.eq("verification_status", status);
  }
  if (queryText) {
    invoiceQuery = invoiceQuery.or(
      "invoice_number.ilike.%" + queryText + "%,seller_name.ilike.%" + queryText + "%,seller_tax_code.ilike.%" + queryText + "%",
    );
  }

  const summaryQueries = ["unverified", "valid", "invalid", "error"].map((value) =>
    supabase.from("invoices").select("id", { count: "exact", head: true }).eq("verification_status", value),
  );
  const [invoiceResult, usageResult, summaryUnverified, summaryValid, summaryInvalid, summaryError] = await Promise.all([
    invoiceQuery,
    supabase
      .from("invoice_scan_usage")
      .select("scan_count, monthly_limit")
      .eq("month_start", getVietnamMonthStart())
      .maybeSingle<{ scan_count: number; monthly_limit: number }>(),
    ...summaryQueries,
  ]);

  if (invoiceResult.error || usageResult.error || summaryUnverified.error || summaryValid.error || summaryInvalid.error || summaryError.error) {
    console.error("invoice list query failed", invoiceResult.error ?? usageResult.error ?? summaryUnverified.error ?? summaryValid.error ?? summaryInvalid.error ?? summaryError.error);
    return NextResponse.json({ error: "Không thể tải danh sách hóa đơn. Hãy kiểm tra migration invoices trên Supabase." }, { status: 500 });
  }

  const used = usageResult.data?.scan_count ?? 0;
  const limit = usageResult.data?.monthly_limit ?? Number(process.env.INVOICE_MONTHLY_SCAN_LIMIT ?? 200);
  const total = invoiceResult.count ?? 0;
  const normalizedRows = ((invoiceResult.data ?? []) as unknown as InvoiceRecord[]).map((row) => {
    const identity = normalizeInvoiceTemplateAndSymbol(row.invoice_template_number, row.invoice_symbol);
    return identity.templateNumber !== row.invoice_template_number || identity.symbol !== row.invoice_symbol
      ? { ...row, invoice_template_number: identity.templateNumber, invoice_symbol: identity.symbol }
      : row;
  });

  let rows: Awaited<ReturnType<typeof attachInvoiceTaxpayers>>;
  try {
    rows = await attachInvoiceTaxpayers(supabase, normalizedRows);
  } catch (error) {
    console.error("invoice taxpayer status query failed", error);
    return NextResponse.json({ error: "Không thể tải trạng thái MST của người bán." }, { status: 500 });
  }

  return NextResponse.json({
    rows,
    total,
    page,
    pageSize: PAGE_SIZE,
    totalPages: Math.max(1, Math.ceil(total / PAGE_SIZE)),
    usage: { used, limit, remaining: Math.max(0, limit - used) },
    summary: {
      total: (summaryUnverified.count ?? 0) + (summaryValid.count ?? 0) + (summaryInvalid.count ?? 0) + (summaryError.count ?? 0),
      unverified: summaryUnverified.count ?? 0,
      valid: summaryValid.count ?? 0,
      invalid: summaryInvalid.count ?? 0,
      error: summaryError.count ?? 0,
    },
  });
}

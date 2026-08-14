import { readInCodeBatches } from "@/lib/supabase-pagination";
import { isValidTaxCode, normalizeTaxCode } from "@/lib/tax-code";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { InvoiceRecord, InvoiceTaxpayerSummary, TaxpayerRefreshState } from "@/lib/invoice-types";

type InvoiceTaxpayerClient = SupabaseClient;

type TaxpayerRow = {
  tax_code: string;
  name: string | null;
  status: string | null;
  status_group: string | null;
  last_checked_at: string | null;
  last_error: string | null;
};

type RefreshQueueRow = {
  tax_code: string;
  state: string;
  last_error: string | null;
};

const TAXPAYER_SELECT = "tax_code, name, status, status_group, last_checked_at, last_error";
const REFRESH_QUEUE_SELECT = "tax_code, state, last_error";

export function normalizeInvoiceSellerTaxCode(value: string | null) {
  if (!value) return null;
  const taxCode = normalizeTaxCode(value);
  return isValidTaxCode(taxCode) ? taxCode : null;
}

export async function readInvoiceTaxpayerMap(supabase: InvoiceTaxpayerClient, taxCodes: string[]) {
  const normalizedCodes = [...new Set(taxCodes
    .map((taxCode) => normalizeInvoiceSellerTaxCode(taxCode))
    .filter((taxCode): taxCode is string => Boolean(taxCode)))];

  const map = new Map<string, InvoiceTaxpayerSummary>();
  if (!normalizedCodes.length) return map;

  const [taxpayerResult, queueResult] = await Promise.all([
    readInCodeBatches(normalizedCodes, (batch) => supabase
      .from("taxpayers")
      .select(TAXPAYER_SELECT)
      .in("tax_code", batch)),
    readInCodeBatches(normalizedCodes, (batch) => supabase
      .from("refresh_queue")
      .select(REFRESH_QUEUE_SELECT)
      .in("tax_code", batch)),
  ]);

  if (taxpayerResult.error || queueResult.error) {
    throw new Error("Không thể tải trạng thái MST của người bán.");
  }

  const taxpayers = (taxpayerResult.data ?? []) as TaxpayerRow[];
  const queueByTaxCode = new Map((queueResult.data ?? []).map((row) => [
    row.tax_code,
    row as RefreshQueueRow,
  ]));

  for (const taxpayer of taxpayers) {
    const queue = queueByTaxCode.get(taxpayer.tax_code);
    const refreshState = queue?.state as TaxpayerRefreshState | undefined;
    map.set(taxpayer.tax_code, {
      tax_code: taxpayer.tax_code,
      name: taxpayer.name,
      status: taxpayer.status,
      status_group: taxpayer.status_group,
      last_checked_at: taxpayer.last_checked_at,
      last_error: taxpayer.last_error ?? queue?.last_error ?? null,
      refresh_state: refreshState ?? null,
    });
  }

  return map;
}

export async function attachInvoiceTaxpayers<T extends Pick<InvoiceRecord, "seller_tax_code">>(
  supabase: InvoiceTaxpayerClient,
  invoices: T[],
) {
  const map = await readInvoiceTaxpayerMap(supabase, invoices.map((invoice) => invoice.seller_tax_code ?? ""));
  return invoices.map((invoice) => ({
    ...invoice,
    seller_taxpayer: invoice.seller_tax_code
      ? map.get(normalizeTaxCode(invoice.seller_tax_code)) ?? null
      : null,
  }));
}

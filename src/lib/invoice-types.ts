export type InvoiceVerificationStatus = "unverified" | "valid" | "invalid" | "error";

export type TaxpayerRefreshState = "queued" | "running" | "success" | "retry" | "dead_letter";

export type InvoiceTaxpayerSummary = {
  tax_code: string;
  name: string | null;
  status: string | null;
  status_group: string | null;
  needs_manual_review: boolean;
  last_checked_at: string | null;
  last_error: string | null;
  refresh_state: TaxpayerRefreshState | null;
};

export type InvoiceRecord = {
  id: string;
  invoice_number: string;
  invoice_number_key: string;
  seller_tax_code: string | null;
  seller_name: string | null;
  seller_taxpayer?: InvoiceTaxpayerSummary | null;
  invoice_template_number: string | null;
  invoice_symbol: string | null;
  lookup_url: string | null;
  lookup_code: string | null;
  invoice_date: string | null;
  tax_amount: number | string | null;
  total_amount: number | string | null;
  currency: string | null;
  extracted_text: string | null;
  source_file_name: string;
  source_file_mime_type: string;
  source_file_size: number;
  source_file_sha256: string;
  extracted_model: string;
  verification_status: InvoiceVerificationStatus;
  verification_message: string | null;
  verification_result: Record<string, unknown> | null;
  verified_at: string | null;
  imported_by: string;
  created_at: string;
  updated_at: string;
};

export type InvoiceQuota = {
  used: number;
  limit: number;
  remaining: number;
};

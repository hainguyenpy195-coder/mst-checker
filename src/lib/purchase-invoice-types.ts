export type PurchaseInvoiceCandidate = {
  row_fingerprint: string;
  invoice_identity_key: string | null;
  invoice_number: string | null;
  invoice_issue_date: string | null;
  seller_name: string | null;
  seller_tax_code: string | null;
  invoice_symbol: string | null;
  invoice_template_number: string | null;
  goods_services: string | null;
  net_amount: string | null;
  deductible_vat_amount: string | null;
  accounting_voucher: string | null;
  accounting_date: string | null;
  tax_rate: string | null;
  description: string | null;
  department_code: string | null;
  source_sheet: string;
  source_row: number;
  source_stt: number | null;
  raw_payload: Record<string, string | number | null>;
};

export type PurchaseInvoiceParseWarning = {
  sourceSheet: string;
  sourceRow: number;
  message: string;
};

export type PurchaseInvoiceFutureIssueDateSample = {
  sourceSheet: string;
  sourceRow: number;
  invoiceIssueDate: string;
};

export type PurchaseInvoiceFutureIssueDateWarning = {
  asOfDate: string;
  count: number;
  samples: PurchaseInvoiceFutureIssueDateSample[];
};

export type PurchaseInvoiceCandidateSheet = {
  sheetName: string;
  headerRow: number;
  dataRows: number;
  populatedTaxCodes: number;
  score: number;
};

export type PurchaseInvoiceParseResult = {
  candidates: PurchaseInvoiceCandidate[];
  totalRows: number;
  validRows: number;
  duplicateRows: number;
  warnings: PurchaseInvoiceParseWarning[];
  futureIssueDateWarning: PurchaseInvoiceFutureIssueDateWarning;
  selectedSheet: string;
  candidateSheets: PurchaseInvoiceCandidateSheet[];
};

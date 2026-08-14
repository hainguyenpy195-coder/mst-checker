export const INVOICE_SELECT = [
  "id",
  "invoice_number",
  "invoice_number_key",
  "seller_tax_code",
  "seller_name",
  "invoice_template_number",
  "invoice_symbol",
  "lookup_url",
  "lookup_code",
  "invoice_date",
  "tax_amount",
  "total_amount",
  "currency",
  "extracted_text",
  "source_file_name",
  "source_file_mime_type",
  "source_file_size",
  "source_file_sha256",
  "extracted_model",
  "verification_status",
  "verification_message",
  "verification_result",
  "verified_at",
  "imported_by",
  "created_at",
  "updated_at",
].join(", ");

export function getVietnamMonthStart(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Ho_Chi_Minh",
    year: "numeric",
    month: "2-digit",
  }).formatToParts(date);
  const year = parts.find((part) => part.type === "year")?.value ?? String(date.getUTCFullYear());
  const month = parts.find((part) => part.type === "month")?.value ?? String(date.getUTCMonth() + 1).padStart(2, "0");
  return year + "-" + month + "-01";
}

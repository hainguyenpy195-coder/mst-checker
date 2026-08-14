import { createGateway } from "@ai-sdk/gateway";
import { generateText, Output, type FilePart, type TextPart } from "ai";
import { createHash } from "node:crypto";
import { z } from "zod";
import { normalizeTaxCode } from "@/lib/tax-code";

export const INVOICE_MODEL_ID = "google/gemini-2.5-flash";
export const DEFAULT_INVOICE_MAX_UPLOAD_BYTES = 4 * 1024 * 1024;
export const DEFAULT_INVOICE_MONTHLY_SCAN_LIMIT = 200;

const supportedMimeTypes = new Map<string, string>([
  ["application/pdf", "application/pdf"],
  ["application/xml", "application/xml"],
  ["text/xml", "text/xml"],
  ["image/png", "image/png"],
  ["image/jpeg", "image/jpeg"],
  ["image/jpg", "image/jpeg"],
  ["image/webp", "image/webp"],
  ["image/gif", "image/gif"],
]);

const supportedExtensions = new Map<string, string>([
  [".pdf", "application/pdf"],
  [".xml", "application/xml"],
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".webp", "image/webp"],
  [".gif", "image/gif"],
]);

export type InvoiceFileDescriptor = {
  mediaType: string;
  kind: "pdf" | "xml" | "image";
};

export type InvoiceExtraction = {
  seller_tax_code: string | null;
  seller_name: string | null;
  invoice_template_number: string | null;
  invoice_symbol: string | null;
  lookup_url: string | null;
  lookup_code: string | null;
  invoice_number: string | null;
  invoice_date: string | null;
  tax_amount: number | null;
  total_amount: number | null;
  currency: string | null;
  extracted_text: string | null;
};

const nullableText = z
  .union([z.string(), z.number(), z.null()])
  .optional()
  .transform((value) => {
    if (value === null || value === undefined) return null;
    const text = String(value).trim();
    return text || null;
  });

const nullableAmount = z
  .union([z.string(), z.number(), z.null()])
  .optional()
  .transform((value) => parseInvoiceAmount(value));

const invoiceExtractionSchema = z.object({
  seller_tax_code: nullableText,
  seller_name: nullableText,
  invoice_template_number: nullableText,
  invoice_symbol: nullableText,
  lookup_url: nullableText,
  lookup_code: nullableText,
  invoice_number: nullableText,
  invoice_date: nullableText,
  tax_amount: nullableAmount,
  total_amount: nullableAmount,
  currency: nullableText,
  extracted_text: nullableText,
});

export function getInvoiceMaxUploadBytes() {
  const configured = Number(process.env.INVOICE_MAX_UPLOAD_BYTES ?? DEFAULT_INVOICE_MAX_UPLOAD_BYTES);
  return Number.isFinite(configured) && configured > 0
    ? Math.floor(configured)
    : DEFAULT_INVOICE_MAX_UPLOAD_BYTES;
}

export function getInvoiceMonthlyScanLimit() {
  const configured = Number(process.env.INVOICE_MONTHLY_SCAN_LIMIT ?? DEFAULT_INVOICE_MONTHLY_SCAN_LIMIT);
  return Number.isFinite(configured) && configured > 0
    ? Math.floor(configured)
    : DEFAULT_INVOICE_MONTHLY_SCAN_LIMIT;
}

export function resolveInvoiceFileDescriptor(fileName: string, mimeType: string | null | undefined): InvoiceFileDescriptor | null {
  const normalizedMimeType = (mimeType ?? "").toLowerCase().split(";", 1)[0].trim();
  const extension = fileName.toLowerCase().slice(fileName.lastIndexOf("."));
  const mediaType = supportedMimeTypes.get(normalizedMimeType)
    ?? supportedExtensions.get(extension)
    ?? (normalizedMimeType.startsWith("image/") ? normalizedMimeType : null);

  if (!mediaType) return null;
  const kind = mediaType === "application/pdf"
    ? "pdf"
    : mediaType === "application/xml" || mediaType === "text/xml"
      ? "xml"
      : "image";
  return { mediaType, kind };
}

export function normalizeInvoiceNumber(value: string) {
  return value.normalize("NFKC").replace(/\s+/g, "").trim().toLocaleUpperCase("vi-VN");
}

function cleanOptionalText(value: string | null | undefined) {
  const normalized = (value ?? "").normalize("NFKC").trim();
  if (!normalized || /^(?:—|-|null|n\/a|na)$/i.test(normalized)) return null;
  return normalized;
}

export function normalizeInvoiceSymbol(value: string | null | undefined) {
  const normalized = (value ?? "").normalize("NFKC").replace(/\s+/g, " ").trim();
  return cleanOptionalText(normalized);
}

export function normalizeInvoiceLookupUrl(value: string | null | undefined) {
  const normalized = cleanOptionalText(value)?.replace(/\s+/g, "");
  if (!normalized) return null;

  const candidate = /^https?:\/\//i.test(normalized) ? normalized : "https://" + normalized;
  try {
    const url = new URL(candidate);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.toString();
  } catch {
    return null;
  }
}

export function normalizeInvoiceLookupCode(value: string | null | undefined) {
  const normalized = cleanOptionalText(value);
  return normalized ? normalized.replace(/\s+/g, "") : null;
}

export function normalizeInvoiceTemplateAndSymbol(templateNumber: string | null | undefined, symbol: string | null | undefined) {
  const storedTemplate = cleanOptionalText(templateNumber);
  const normalizedSymbol = normalizeInvoiceSymbol(symbol);
  const compactSymbol = normalizedSymbol?.replace(/\s+/g, "").toLocaleUpperCase("vi-VN") ?? "";
  const combinedMatch = compactSymbol.match(/^([1-9])([A-Z]\d{2}[A-Z0-9]{3})$/u);

  if (combinedMatch && (!storedTemplate || storedTemplate === combinedMatch[1])) {
    return {
      templateNumber: storedTemplate ?? combinedMatch[1],
      symbol: combinedMatch[2],
    };
  }

  return {
    templateNumber: storedTemplate,
    symbol: normalizedSymbol,
  };
}

/**
 * Some electronic invoices print the template number and invoice symbol as
 * one seven-character value. Example: 1K26DAB -> template 1 + symbol K26DAB.
 */
export function deriveInvoiceTemplateNumber(symbol: string | null | undefined) {
  return normalizeInvoiceTemplateAndSymbol(null, symbol).templateNumber;
}

export function parseInvoiceAmount(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "number") return Number.isFinite(value) ? Math.round(value * 100) / 100 : null;

  let cleaned = value.replace(/[^\d,.-]/g, "");
  if (!cleaned || cleaned === "-" || cleaned === "." || cleaned === ",") return null;

  const commaIndex = cleaned.lastIndexOf(",");
  const dotIndex = cleaned.lastIndexOf(".");
  if (commaIndex >= 0 && dotIndex >= 0) {
    if (commaIndex > dotIndex) {
      cleaned = cleaned.replace(/\./g, "").replace(",", ".");
    } else {
      cleaned = cleaned.replace(/,/g, "");
    }
  } else if (commaIndex >= 0) {
    const decimalLength = cleaned.length - commaIndex - 1;
    cleaned = decimalLength > 2 ? cleaned.replace(/,/g, "") : cleaned.replace(",", ".");
  } else if (dotIndex >= 0) {
    const decimalLength = cleaned.length - dotIndex - 1;
    if (decimalLength === 3) cleaned = cleaned.replace(/\./g, "");
  }

  const parsed = Number(cleaned);
  return Number.isFinite(parsed) ? Math.round(parsed * 100) / 100 : null;
}

export function sha256Hex(data: Uint8Array) {
  return createHash("sha256").update(data).digest("hex");
}

function extractionPrompt(fileName: string, kind: InvoiceFileDescriptor["kind"]) {
  return [
    "Bạn là bộ phận kiểm tra hóa đơn điện tử tại Việt Nam.",
    "Đọc chính xác nội dung hóa đơn trong file đính kèm, không suy đoán và không tự điền dữ liệu không nhìn thấy.",
    "Trích xuất các trường: mã số thuế người bán, tên người bán, mẫu số, ký hiệu hóa đơn, số hóa đơn, ngày hóa đơn, tiền thuế, tổng tiền thanh toán, loại tiền tệ, địa chỉ trang tra cứu hóa đơn và mã tra cứu.",
    "Một số hóa đơn in chung trường Mẫu số/Ký hiệu, ví dụ 1C26MCM hoặc 1K26DAB. Hãy tách ký tự số đầu tiên thành mẫu số (1), phần còn lại thành ký hiệu (C26MCM hoặc K26DAB). Nếu chỉ in Ký hiệu nhưng có dạng 1K26DAB thì cũng tách theo quy tắc này.",
    "Số hóa đơn phải giữ nguyên các số 0 ở đầu. Các khoản tiền trả về dạng số, không có dấu phân cách.",
    "Địa chỉ trang tra cứu thường nằm ở cuối hóa đơn với nhãn Website tra cứu hóa đơn, Tra cứu hóa đơn điện tử hoặc tương tự; giữ nguyên URL http/https. Mã tra cứu có thể có nhãn Mã tra cứu, Mã số tra cứu, Mã nhận HĐ, Mã kiểm tra hoặc tương tự; giữ nguyên chính xác chuỗi mã.",
    "extracted_text phải là phần text nhìn thấy trên hóa đơn, trình bày ngắn gọn nhưng đủ để kiểm tra lại.",
    "Nếu không thấy trường nào thì trả về null. Chỉ trả về dữ liệu theo schema structured output.",
    "Tên file: " + fileName + ". Loại file: " + kind + ".",
  ].join("\n");
}

export async function extractInvoiceFromFile(options: {
  buffer: Buffer;
  fileName: string;
  descriptor: InvoiceFileDescriptor;
}) {
  const apiKey = process.env.AI_GATEWAY_API_KEY;
  if (!apiKey) throw new Error("Thiếu AI_GATEWAY_API_KEY trong môi trường server.");

  const content: Array<TextPart | FilePart> = [
    { type: "text", text: extractionPrompt(options.fileName, options.descriptor.kind) },
    {
      type: "file",
      data: options.buffer,
      mediaType: options.descriptor.mediaType,
      filename: options.fileName,
    },
  ];

  const result = await generateText({
    model: createGateway({ apiKey })(INVOICE_MODEL_ID),
    messages: [{ role: "user", content }],
    output: Output.object({ schema: invoiceExtractionSchema }),
    maxRetries: 0,
  });

  if (!result.output) throw new Error("Gemini không trả về dữ liệu hóa đơn.");
  return {
    extraction: result.output as InvoiceExtraction,
    usage: result.usage ?? null,
  };
}

export function normalizeExtractedInvoice(extraction: InvoiceExtraction) {
  const invoiceNumber = cleanOptionalText(extraction.invoice_number);
  const sellerTaxCode = cleanOptionalText(extraction.seller_tax_code);
  const identity = normalizeInvoiceTemplateAndSymbol(extraction.invoice_template_number, extraction.invoice_symbol);
  return {
    invoice_number: invoiceNumber,
    invoice_number_key: invoiceNumber ? normalizeInvoiceNumber(invoiceNumber) : null,
    seller_tax_code: sellerTaxCode ? normalizeTaxCode(sellerTaxCode) : null,
    seller_name: cleanOptionalText(extraction.seller_name),
    invoice_template_number: identity.templateNumber,
    invoice_symbol: identity.symbol,
    lookup_url: normalizeInvoiceLookupUrl(extraction.lookup_url),
    lookup_code: normalizeInvoiceLookupCode(extraction.lookup_code),
    invoice_date: cleanOptionalText(extraction.invoice_date),
    tax_amount: extraction.tax_amount,
    total_amount: extraction.total_amount,
    currency: cleanOptionalText(extraction.currency),
    extracted_text: cleanOptionalText(extraction.extracted_text),
  };
}

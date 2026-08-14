import { createHash } from "node:crypto";
import ExcelJS from "exceljs";
import { isValidTaxCode, normalizeTaxCode } from "@/lib/tax-code";
import type {
  PurchaseInvoiceCandidate,
  PurchaseInvoiceCandidateSheet,
  PurchaseInvoiceFutureIssueDateWarning,
  PurchaseInvoiceParseResult,
  PurchaseInvoiceParseWarning,
} from "@/lib/purchase-invoice-types";

export const DEFAULT_PURCHASE_INVOICE_EXCEL_MAX_ROWS = 10_000;
const FUTURE_ISSUE_DATE_SAMPLE_LIMIT = 5;

type PurchaseColumns = {
  serial: number;
  invoiceSymbol?: number;
  invoiceNumber: number;
  issueDate: number;
  sellerName?: number;
  sellerTaxCode: number;
  goodsServices?: number;
  netAmount: number;
  templateNumber?: number;
  deductibleVatAmount?: number;
  accountingVoucher?: number;
  accountingDate?: number;
  taxRate?: number;
  description?: number;
  departmentCode?: number;
};

type SheetMatch = {
  worksheet: ExcelJS.Worksheet;
  headerRow: number;
  columns: PurchaseColumns;
  dataRows: number;
  populatedTaxCodes: number;
  score: number;
};

function getMaxRows() {
  const configured = Number(process.env.PURCHASE_INVOICE_IMPORT_MAX_ROWS ?? DEFAULT_PURCHASE_INVOICE_EXCEL_MAX_ROWS);
  return Number.isFinite(configured) && configured > 0
    ? Math.floor(configured)
    : DEFAULT_PURCHASE_INVOICE_EXCEL_MAX_ROWS;
}

function getVietnamToday(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Ho_Chi_Minh",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const year = parts.find((part) => part.type === "year")?.value ?? String(date.getUTCFullYear());
  const month = parts.find((part) => part.type === "month")?.value ?? String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = parts.find((part) => part.type === "day")?.value ?? String(date.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function getFutureIssueDateWarning(candidates: Iterable<PurchaseInvoiceCandidate>): PurchaseInvoiceFutureIssueDateWarning {
  const asOfDate = getVietnamToday();
  let count = 0;
  const samples: PurchaseInvoiceFutureIssueDateWarning["samples"] = [];

  for (const candidate of candidates) {
    const issueDate = candidate.invoice_issue_date;
    if (!issueDate || issueDate <= asOfDate) continue;

    count += 1;
    if (samples.length < FUTURE_ISSUE_DATE_SAMPLE_LIMIT) {
      samples.push({
        sourceSheet: candidate.source_sheet,
        sourceRow: candidate.source_row,
        invoiceIssueDate: issueDate,
      });
    }
  }

  return { asOfDate, count, samples };
}

function cleanOptionalText(value: string | null | undefined) {
  const cleaned = (value ?? "").normalize("NFKC").replace(/\s+/g, " ").trim();
  return cleaned && !/^(?:-|—|n\/?a|null)$/iu.test(cleaned) ? cleaned : null;
}

function readCellValue(value: unknown): unknown {
  if (value && typeof value === "object" && "result" in value) {
    return (value as { result?: unknown }).result ?? null;
  }
  return value;
}

function cellText(cell: ExcelJS.Cell) {
  const value = readCellValue(cell.value);
  if (value === null || value === undefined) return "";

  // `cell.text` preserves leading zeroes in invoice numbers. Some ExcelJS
  // merged cells throw while formatting an empty merged value, so use it only
  // when it is safe and fall back to the raw value.
  try {
    const displayed = cell.text;
    if (displayed) return displayed.normalize("NFKC").trim();
  } catch {
    // Fall through to value handling below.
  }

  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return String(value).trim();
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (Array.isArray(record.richText)) {
      return record.richText
        .map((part) => (part && typeof part === "object" ? String((part as Record<string, unknown>).text ?? "") : ""))
        .join("")
        .trim();
    }
    if (typeof record.text === "string") return record.text.trim();
  }
  return String(value).trim();
}

function normalizedHeader(value: string) {
  return value
    .normalize("NFD")
    // Vietnamese "đ" is a distinct letter and is not decomposed by NFD.
    // Transliterate it before stripping marks so headings such as
    // "Số hóa đơn" remain detectable.
    .replace(/[đĐ]/g, "d")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function findColumn(headers: Map<number, string>, predicate: (header: string) => boolean) {
  return [...headers.entries()].find(([, header]) => predicate(header))?.[0];
}

function findPurchaseColumns(worksheet: ExcelJS.Worksheet): { headerRow: number; columns: PurchaseColumns } | null {
  const maxRows = Math.min(12, worksheet.rowCount);
  for (let rowNumber = 1; rowNumber <= maxRows; rowNumber += 1) {
    const row = worksheet.getRow(rowNumber);
    const headers = new Map<number, string>();
    for (let column = 1; column <= worksheet.columnCount; column += 1) {
      headers.set(column, normalizedHeader(cellText(row.getCell(column))));
    }

    const serial = findColumn(headers, (header) => header === "stt" || header === "stt ");
    const invoiceNumber = findColumn(headers, (header) => header.includes("so hoa don"));
    const issueDate = findColumn(headers, (header) => header.includes("ngay thang nam phat hanh"));
    const sellerTaxCode = findColumn(headers, (header) => header.includes("ma so thue nguoi ban"));
    const netAmount = findColumn(headers, (header) => header.includes("gia tri hhdv") && header.includes("mua vao") && header.includes("chua co thue"));

    if (!serial || !invoiceNumber || !issueDate || !sellerTaxCode || !netAmount) continue;

    return {
      headerRow: rowNumber,
      columns: {
        serial,
        invoiceNumber,
        issueDate,
        sellerTaxCode,
        netAmount,
        invoiceSymbol: findColumn(headers, (header) => header === "ky hieu" || header.startsWith("ky hieu ")),
        sellerName: findColumn(headers, (header) => header.includes("ten nguoi ban")),
        goodsServices: findColumn(headers, (header) => header === "mat hang" || header.includes("mat hang")),
        templateNumber: findColumn(headers, (header) => header === "mau so" || header.startsWith("mau so ")),
        deductibleVatAmount: findColumn(headers, (header) => header.includes("thue gtgt") && header.includes("khau tru")),
        accountingVoucher: findColumn(headers, (header) => header.includes("chung tu hach toan")),
        accountingDate: findColumn(headers, (header) => header === "ngay"),
        taxRate: findColumn(headers, (header) => header.includes("thue suat")),
        description: findColumn(headers, (header) => header.includes("dien giai")),
        departmentCode: findColumn(headers, (header) => header.includes("ma bo phan")),
      },
    };
  }

  return null;
}

function readPositiveInteger(cell: ExcelJS.Cell) {
  const value = readCellValue(cell.value);
  const raw = typeof value === "number" ? value : Number(cellText(cell).replace(/,/g, ""));
  return Number.isInteger(raw) && raw > 0 ? raw : null;
}

function formatDate(year: number, month: number, day: number) {
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const value = new Date(Date.UTC(year, month - 1, day));
  if (value.getUTCFullYear() !== year || value.getUTCMonth() !== month - 1 || value.getUTCDate() !== day) return null;
  return value.toISOString().slice(0, 10);
}

function parseExcelDate(cell: ExcelJS.Cell): string | null {
  const value = readCellValue(cell.value);
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString().slice(0, 10);

  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    const base = Date.UTC(1899, 11, 30);
    const date = new Date(base + Math.floor(value) * 86_400_000);
    return date.toISOString().slice(0, 10);
  }

  const text = cellText(cell);
  const iso = text.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/);
  if (iso) return formatDate(Number(iso[1]), Number(iso[2]), Number(iso[3]));
  const vietnamese = text.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/);
  if (vietnamese) return formatDate(Number(vietnamese[3]), Number(vietnamese[2]), Number(vietnamese[1]));
  return null;
}

function parseDecimal(cell: ExcelJS.Cell): string | null {
  const value = readCellValue(cell.value);
  if (typeof value === "number" && Number.isFinite(value)) return value.toFixed(2);

  let text = cellText(cell).replace(/\s/g, "").replace(/[^0-9,.-]/g, "");
  if (!text || text === "-" || text === "." || text === ",") return null;
  const comma = text.lastIndexOf(",");
  const dot = text.lastIndexOf(".");
  if (comma >= 0 && dot >= 0) {
    text = comma > dot ? text.replace(/\./g, "").replace(",", ".") : text.replace(/,/g, "");
  } else if (comma >= 0) {
    const decimals = text.length - comma - 1;
    text = decimals > 2 ? text.replace(/,/g, "") : text.replace(",", ".");
  } else if (dot >= 0 && text.length - dot - 1 === 3) {
    text = text.replace(/\./g, "");
  }

  const parsed = Number(text);
  return Number.isFinite(parsed) ? (Math.round(parsed * 100) / 100).toFixed(2) : null;
}

function canonicalText(value: string | null) {
  return value ? value.normalize("NFKC").replace(/\s+/g, " ").trim().toLocaleUpperCase("vi-VN") : "";
}

function normalizeSellerTaxCode(value: string | null) {
  if (!value) return null;

  const taxCode = normalizeTaxCode(value);
  // Numeric Excel cells can drop a leading zero from 10- or 12-digit MSTs.
  // Restore only lengths that become valid Vietnamese tax-code lengths so the
  // imported row can still join the existing MST catalogue.
  if (/^\d{9}$/.test(taxCode)) return taxCode.padStart(10, "0");
  if (/^\d{11}$/.test(taxCode)) return taxCode.padStart(12, "0");
  // Some workbooks export a branch code as thirteen continuous digits rather
  // than the standard 10-digit base plus a hyphen and 3-digit branch suffix.
  if (/^\d{13}$/.test(taxCode)) return `${taxCode.slice(0, 10)}-${taxCode.slice(10)}`;
  return taxCode;
}

function buildInvoiceIdentityKey(candidate: Pick<PurchaseInvoiceCandidate, "seller_tax_code" | "invoice_symbol" | "invoice_number" | "invoice_issue_date" | "net_amount">) {
  if (!candidate.seller_tax_code || !candidate.invoice_number || !candidate.invoice_issue_date || !candidate.net_amount) return null;
  return [
    `mst:${canonicalText(candidate.seller_tax_code)}`,
    `symbol:${canonicalText(candidate.invoice_symbol) || "none"}`,
    `number:${canonicalText(candidate.invoice_number)}`,
    `date:${candidate.invoice_issue_date}`,
    `net:${candidate.net_amount}`,
  ].join("|");
}

function buildRowFingerprint(candidate: Omit<PurchaseInvoiceCandidate, "row_fingerprint" | "invoice_identity_key" | "raw_payload" | "source_sheet" | "source_row" | "source_stt">) {
  const values = {
    seller_tax_code: canonicalText(candidate.seller_tax_code),
    invoice_symbol: canonicalText(candidate.invoice_symbol),
    invoice_number: canonicalText(candidate.invoice_number),
    invoice_issue_date: candidate.invoice_issue_date ?? "",
    seller_name: canonicalText(candidate.seller_name),
    invoice_template_number: canonicalText(candidate.invoice_template_number),
    goods_services: canonicalText(candidate.goods_services),
    net_amount: candidate.net_amount ?? "",
    deductible_vat_amount: candidate.deductible_vat_amount ?? "",
    accounting_voucher: canonicalText(candidate.accounting_voucher),
    accounting_date: candidate.accounting_date ?? "",
    tax_rate: canonicalText(candidate.tax_rate),
    description: canonicalText(candidate.description),
    department_code: canonicalText(candidate.department_code),
  };
  return createHash("sha256").update(JSON.stringify(values)).digest("hex");
}

function readCandidateRow(worksheet: ExcelJS.Worksheet, sourceRow: number, columns: PurchaseColumns): PurchaseInvoiceCandidate | null {
  const row = worksheet.getRow(sourceRow);
  const sourceStt = readPositiveInteger(row.getCell(columns.serial));
  if (!sourceStt) return null;

  const invoiceNumber = cleanOptionalText(cellText(row.getCell(columns.invoiceNumber)));
  const issueDate = parseExcelDate(row.getCell(columns.issueDate));
  const sellerTaxCode = normalizeSellerTaxCode(cleanOptionalText(cellText(row.getCell(columns.sellerTaxCode))));
  const sellerName = columns.sellerName ? cleanOptionalText(cellText(row.getCell(columns.sellerName))) : null;
  const goodsServices = columns.goodsServices ? cleanOptionalText(cellText(row.getCell(columns.goodsServices))) : null;
  const netAmount = parseDecimal(row.getCell(columns.netAmount));
  const invoiceSymbol = columns.invoiceSymbol ? cleanOptionalText(cellText(row.getCell(columns.invoiceSymbol))) : null;
  const templateNumber = columns.templateNumber ? cleanOptionalText(cellText(row.getCell(columns.templateNumber))) : null;
  const deductibleVatAmount = columns.deductibleVatAmount ? parseDecimal(row.getCell(columns.deductibleVatAmount)) : null;
  const accountingVoucher = columns.accountingVoucher ? cleanOptionalText(cellText(row.getCell(columns.accountingVoucher))) : null;
  const accountingDate = columns.accountingDate ? parseExcelDate(row.getCell(columns.accountingDate)) : null;
  const taxRate = columns.taxRate ? cleanOptionalText(cellText(row.getCell(columns.taxRate))) : null;
  const description = columns.description ? cleanOptionalText(cellText(row.getCell(columns.description))) : null;
  const departmentCode = columns.departmentCode ? cleanOptionalText(cellText(row.getCell(columns.departmentCode))) : null;

  // A numeric serial plus zero-valued totals is used by some category/footer
  // blocks in the sample workbook. Require at least one business-identifying
  // field, while still retaining imperfect rows such as those with a blank
  // MST or invoice number.
  if (!invoiceNumber && !sellerName && !sellerTaxCode && !goodsServices && !accountingVoucher && !description) return null;

  const base = {
    invoice_number: invoiceNumber,
    invoice_issue_date: issueDate,
    seller_name: sellerName,
    seller_tax_code: sellerTaxCode,
    invoice_symbol: invoiceSymbol,
    invoice_template_number: templateNumber,
    goods_services: goodsServices,
    net_amount: netAmount,
    deductible_vat_amount: deductibleVatAmount,
    accounting_voucher: accountingVoucher,
    accounting_date: accountingDate,
    tax_rate: taxRate,
    description,
    department_code: departmentCode,
  };

  const rawPayload: PurchaseInvoiceCandidate["raw_payload"] = {
    invoice_symbol: invoiceSymbol,
    invoice_number: invoiceNumber,
    invoice_issue_date: issueDate,
    seller_name: sellerName,
    seller_tax_code: sellerTaxCode,
    goods_services: goodsServices,
    net_amount: netAmount,
    invoice_template_number: templateNumber,
    deductible_vat_amount: deductibleVatAmount,
    accounting_voucher: accountingVoucher,
    accounting_date: accountingDate,
    source_stt: sourceStt,
    tax_rate: taxRate,
    description,
    department_code: departmentCode,
  };

  const preliminary = {
    ...base,
    source_sheet: worksheet.name,
    source_row: sourceRow,
    source_stt: sourceStt,
    raw_payload: rawPayload,
  };
  return {
    ...preliminary,
    invoice_identity_key: buildInvoiceIdentityKey(preliminary),
    row_fingerprint: buildRowFingerprint(base),
  };
}

function countSheetRows(worksheet: ExcelJS.Worksheet, headerRow: number, columns: PurchaseColumns) {
  let dataRows = 0;
  let populatedTaxCodes = 0;
  const lastRow = worksheet.lastRow?.number ?? worksheet.rowCount;
  for (let rowNumber = headerRow + 1; rowNumber <= lastRow; rowNumber += 1) {
    const candidate = readCandidateRow(worksheet, rowNumber, columns);
    if (!candidate) continue;
    dataRows += 1;
    if (candidate.seller_tax_code) populatedTaxCodes += 1;
  }
  return { dataRows, populatedTaxCodes };
}

function getSheetMatches(workbook: ExcelJS.Workbook): SheetMatch[] {
  const matches: SheetMatch[] = [];
  for (const worksheet of workbook.worksheets) {
    const found = findPurchaseColumns(worksheet);
    if (!found) continue;
    const counts = countSheetRows(worksheet, found.headerRow, found.columns);
    if (!counts.dataRows) continue;
    // The source worksheet and a manually filtered MST worksheet can share
    // headers. Prefer the one that preserves more populated MST values.
    const score = counts.dataRows * 10_000 + counts.populatedTaxCodes;
    matches.push({ worksheet, ...found, ...counts, score });
  }
  return matches.sort((left, right) => right.score - left.score || left.worksheet.name.localeCompare(right.worksheet.name, "vi"));
}

export async function parsePurchaseInvoiceWorkbook(buffer: Buffer | Uint8Array): Promise<PurchaseInvoiceParseResult> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer as unknown as Parameters<typeof workbook.xlsx.load>[0]);
  const matches = getSheetMatches(workbook);
  if (!matches.length) {
    throw new Error("Không tìm thấy sheet hóa đơn mua vào có các cột bắt buộc: STT, Số hóa đơn, Ngày phát hành, MST người bán và Giá trị HHDV mua vào chưa có thuế.");
  }

  const selected = matches[0];
  const candidates = new Map<string, PurchaseInvoiceCandidate>();
  const warnings: PurchaseInvoiceParseWarning[] = [];
  const maxRows = getMaxRows();
  let totalRows = 0;
  let duplicateRows = 0;
  const lastRow = selected.worksheet.lastRow?.number ?? selected.worksheet.rowCount;

  if (matches.length > 1) {
    warnings.push({
      sourceSheet: selected.worksheet.name,
      sourceRow: selected.headerRow,
      message: `Tìm thấy ${matches.length} sheet phù hợp; hệ thống chọn “${selected.worksheet.name}” vì có nhiều MST được giữ lại nhất.`,
    });
  }

  for (let rowNumber = selected.headerRow + 1; rowNumber <= lastRow; rowNumber += 1) {
    const candidate = readCandidateRow(selected.worksheet, rowNumber, selected.columns);
    if (!candidate) continue;
    totalRows += 1;
    if (totalRows > maxRows) throw new Error(`File Excel phải dưới ${maxRows.toLocaleString("vi-VN")} dòng hóa đơn mua vào.`);

    if (!candidate.seller_tax_code) {
      warnings.push({ sourceSheet: candidate.source_sheet, sourceRow: candidate.source_row, message: "Dòng không có MST người bán; vẫn được lưu nhưng chưa thể liên kết CSDL MST." });
    } else if (!isValidTaxCode(candidate.seller_tax_code)) {
      warnings.push({ sourceSheet: candidate.source_sheet, sourceRow: candidate.source_row, message: "MST người bán không đúng định dạng hiện có; vẫn được lưu nhưng chưa thể liên kết CSDL MST." });
    }
    if (!candidate.invoice_identity_key) {
      warnings.push({ sourceSheet: candidate.source_sheet, sourceRow: candidate.source_row, message: "Thiếu trường để lập khóa hóa đơn; hệ thống vẫn dùng fingerprint toàn dòng để chống nhập lặp." });
    }

    if (candidates.has(candidate.row_fingerprint)) {
      duplicateRows += 1;
      continue;
    }
    candidates.set(candidate.row_fingerprint, candidate);
  }

  const candidateRows = [...candidates.values()];
  return {
    candidates: candidateRows,
    totalRows,
    validRows: candidates.size,
    duplicateRows,
    warnings: warnings.slice(0, 100),
    futureIssueDateWarning: getFutureIssueDateWarning(candidateRows),
    selectedSheet: selected.worksheet.name,
    candidateSheets: matches.map((match): PurchaseInvoiceCandidateSheet => ({
      sheetName: match.worksheet.name,
      headerRow: match.headerRow,
      dataRows: match.dataRows,
      populatedTaxCodes: match.populatedTaxCodes,
      score: match.score,
    })),
  };
}

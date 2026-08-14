import ExcelJS from "exceljs";
import { isValidTaxCode, normalizeTaxCode } from "@/lib/tax-code";
import { resolveTaxpayerUnit, type TaxpayerUnitInfo } from "@/lib/taxpayer-units";

export const DEFAULT_TAXPAYER_EXCEL_MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
export const DEFAULT_TAXPAYER_EXCEL_MAX_ROWS = 10_000;
export const TAXPAYER_EXCEL_HEADERS = [
  "STT",
  "Tên người bán",
  "Mã số thuế",
  "Mặt hàng",
  "Tình trạng hoạt động của MST",
  "Thời điểm tra cứu lần trước",
  "Thời điểm tra cứu mới nhất",
  "Ghi chú (note tình trạng của những đối tượng có sự thay đổi so với lần tra cứu trước)",
] as const;

const YEAR_PATTERN = /^\d{4}$/;
const MONTH_YEAR_SHEET_PATTERN = /^T(?:0?[1-9]|1[0-2])-(\d{4})$/i;
const SHORT_MONTH_YEAR_SHEET_PATTERN = /^T(?:0?[1-9]|1[0-2])-(\d{2})$/i;
const INVALID_SHEET_NAME_MESSAGE = "tên sheet phải là năm 4 chữ số hoặc dạng T{tháng}-{năm}, ví dụ T2-2026";

export type TaxpayerExcelSource = {
  sourceSheet: string;
  sourceYear: string;
  sourceRow: number;
  sourceUnitKey: string | null;
  sourceUnitLabel: string | null;
  sourceUnitOrder: number | null;
};

export type TaxpayerExcelCandidate = {
  taxCode: string;
  sources: TaxpayerExcelSource[];
};

export type TaxpayerExcelInvalidRow = {
  sourceSheet: string;
  sourceRow: number;
  rawTaxCode: string;
  message: string;
};

export type TaxpayerExcelParseResult = {
  candidates: TaxpayerExcelCandidate[];
  totalRows: number;
  validRows: number;
  duplicateRows: number;
  invalidRowCount: number;
  invalidRows: TaxpayerExcelInvalidRow[];
  ignoredSheets: string[];
};

export type TaxpayerWorkbookExportRow = {
  name: string;
  taxCode: string;
  status: string;
  previousCheckedAt: string;
  lastCheckedAt: string;
  note: string;
  unitKey: string | null;
  unitLabel: string | null;
  unitOrder: number | null;
};

export function parseTaxpayerExcelSheetYear(sheetName: string): string | null {
  const normalizedName = sheetName.trim();
  if (YEAR_PATTERN.test(normalizedName)) return normalizedName;

  const fullYearMatch = normalizedName.match(MONTH_YEAR_SHEET_PATTERN);
  if (fullYearMatch) return fullYearMatch[1];

  const shortYearMatch = normalizedName.match(SHORT_MONTH_YEAR_SHEET_PATTERN);
  return shortYearMatch ? `20${shortYearMatch[1]}` : null;
}

export function getTaxpayerExcelMaxUploadBytes() {
  const configured = Number(process.env.MST_IMPORT_MAX_UPLOAD_BYTES ?? DEFAULT_TAXPAYER_EXCEL_MAX_UPLOAD_BYTES);
  return Number.isFinite(configured) && configured > 0
    ? Math.floor(configured)
    : DEFAULT_TAXPAYER_EXCEL_MAX_UPLOAD_BYTES;
}

export function getTaxpayerExcelMaxRows() {
  const configured = Number(process.env.MST_IMPORT_MAX_ROWS ?? DEFAULT_TAXPAYER_EXCEL_MAX_ROWS);
  return Number.isFinite(configured) && configured > 0
    ? Math.floor(configured)
    : DEFAULT_TAXPAYER_EXCEL_MAX_ROWS;
}

function cellText(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" || typeof value === "boolean") return String(value).trim();
  if (value instanceof Date) return value.toISOString();

  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (Array.isArray(record.richText)) {
      return record.richText
        .map((part) => (part && typeof part === "object" ? String((part as Record<string, unknown>).text ?? "") : ""))
        .join("")
        .trim();
    }
    if (typeof record.text === "string") return record.text.trim();
    if ("result" in record) return cellText(record.result);
  }

  return String(value).trim();
}

function normalizedHeader(value: unknown) {
  return cellText(value)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeExcelTaxCode(value: unknown) {
  const taxCode = normalizeTaxCode(cellText(value));

  // Excel stores codes entered as numbers without leading zeroes. Vietnamese
  // taxpayer codes are commonly 10 or 12 digits, so recover the omitted zero
  // for the only lengths that can become valid after numeric conversion.
  if (/^\d{9}$/.test(taxCode)) return taxCode.padStart(10, "0");
  if (/^\d{11}$/.test(taxCode)) return taxCode.padStart(12, "0");

  return taxCode;
}

function findColumn(headers: Map<number, string>, matcher: (value: string) => boolean) {
  return [...headers.entries()].find(([, value]) => matcher(value))?.[0];
}

function findHeader(worksheet: ExcelJS.Worksheet) {
  const maxHeaderRows = Math.min(10, worksheet.rowCount);
  for (let rowNumber = 1; rowNumber <= maxHeaderRows; rowNumber += 1) {
    const headers = new Map<number, string>();
    const row = worksheet.getRow(rowNumber);
    for (let column = 1; column <= worksheet.columnCount; column += 1) {
      headers.set(column, normalizedHeader(row.getCell(column).value));
    }

    const taxCodeColumn = findColumn(headers, (value) => value.includes("ma so thue"));
    if (!taxCodeColumn) continue;

    return {
      rowNumber,
      taxCodeColumn,
    };
  }

  return null;
}

const UNIT_MARKER_PATTERN = /^(?:I|II|III|IV|V|VI|VII|VIII|IX|X|XI|XII|XIII|XIV|XV|XVI|XVII|XVIII|XIX|XX)\.?$/i;

function findUnitHeading(worksheet: ExcelJS.Worksheet, rowNumber: number, taxCodeColumn: number): TaxpayerUnitInfo | null {
  const row = worksheet.getRow(rowNumber);
  const marker = cellText(row.getCell(1).value);
  const label = cellText(row.getCell(2).value);
  const taxCode = cellText(row.getCell(taxCodeColumn).value);
  if (!label || taxCode || !UNIT_MARKER_PATTERN.test(marker)) return null;
  return resolveTaxpayerUnit(label, marker);
}

export async function parseTaxpayerWorkbook(buffer: Buffer | Uint8Array): Promise<TaxpayerExcelParseResult> {
  const workbook = new ExcelJS.Workbook();
  const workbookBuffer = buffer as unknown as Parameters<typeof workbook.xlsx.load>[0];
  await workbook.xlsx.load(workbookBuffer);

  const candidates = new Map<string, TaxpayerExcelCandidate>();
  const invalidRows: TaxpayerExcelInvalidRow[] = [];
  const ignoredSheets: string[] = [];
  let totalRows = 0;
  let validRows = 0;
  let duplicateRows = 0;
  let invalidRowCount = 0;
  const maxRows = getTaxpayerExcelMaxRows();

  for (const worksheet of workbook.worksheets) {
    const sourceYear = parseTaxpayerExcelSheetYear(worksheet.name);
    if (!sourceYear) {
      ignoredSheets.push(`${worksheet.name} (${INVALID_SHEET_NAME_MESSAGE})`);
      continue;
    }

    const header = findHeader(worksheet);
    if (!header) {
      ignoredSheets.push(`${worksheet.name} (không tìm thấy cột Mã số thuế)`);
      continue;
    }

    let currentUnit: TaxpayerUnitInfo | null = null;
    const lastRowNumber = worksheet.lastRow?.number ?? worksheet.rowCount;
    for (let rowNumber = header.rowNumber + 1; rowNumber <= lastRowNumber; rowNumber += 1) {
      const unitHeading = findUnitHeading(worksheet, rowNumber, header.taxCodeColumn);
      if (unitHeading) {
        currentUnit = unitHeading;
        continue;
      }

      const row = worksheet.getRow(rowNumber);
      const rawTaxCode = cellText(row.getCell(header.taxCodeColumn).value);
      if (!rawTaxCode) continue;

      totalRows += 1;
      if (totalRows > maxRows) {
        throw new Error(`File excel phải dưới ${maxRows} dòng mã số thuế`);
      }

      const taxCode = normalizeExcelTaxCode(rawTaxCode);
      if (!isValidTaxCode(taxCode)) {
        invalidRowCount += 1;
        if (invalidRows.length < 100) {
          invalidRows.push({
            sourceSheet: worksheet.name,
            sourceRow: rowNumber,
            rawTaxCode,
            message: "Mã số thuế không đúng định dạng.",
          });
        }
        continue;
      }

      validRows += 1;
      const source: TaxpayerExcelSource = {
        sourceSheet: sourceYear,
        sourceYear,
        sourceRow: rowNumber,
        sourceUnitKey: currentUnit?.key ?? null,
        sourceUnitLabel: currentUnit?.sourceLabel ?? null,
        sourceUnitOrder: currentUnit?.order ?? null,
      };
      const current = candidates.get(taxCode);
      if (current) {
        duplicateRows += 1;
        current.sources.push(source);
        continue;
      }

      candidates.set(taxCode, {
        taxCode,
        sources: [source],
      });
    }
  }

  return {
    candidates: [...candidates.values()],
    totalRows,
    validRows,
    duplicateRows,
    invalidRowCount,
    invalidRows,
    ignoredSheets,
  };
}

export function addTaxpayerWorksheet(workbook: ExcelJS.Workbook, year: string, rows: TaxpayerWorkbookExportRow[]) {
  const worksheet = workbook.addWorksheet(year.slice(0, 31));
  worksheet.mergeCells("A1:H1");
  const titleCell = worksheet.getCell("A1");
  titleCell.value = `PHỤ LỤC 2: DANH SÁCH MST NGƯỜI BÁN THEO CÁC HÓA ĐƠN NĂM ${year}`;
  titleCell.font = { name: "Arial", size: 14, bold: true, color: { argb: "FF1F2937" } };
  titleCell.alignment = { horizontal: "center", vertical: "middle", wrapText: true };
  worksheet.getRow(1).height = 34;

  worksheet.getRow(2).values = [...TAXPAYER_EXCEL_HEADERS];
  worksheet.getRow(2).font = { name: "Arial", size: 10, bold: true, color: { argb: "FFFFFFFF" } };
  worksheet.getRow(2).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF0B83C6" } };
  worksheet.getRow(2).alignment = { horizontal: "center", vertical: "middle", wrapText: true };
  worksheet.getRow(2).height = 42;
  worksheet.views = [{ state: "frozen", ySplit: 2 }];
  worksheet.autoFilter = "A2:H2";
  worksheet.columns = [
    { key: "index", width: 8 },
    { key: "name", width: 42 },
    { key: "taxCode", width: 20 },
    { key: "item", width: 2 },
    { key: "status", width: 34 },
    { key: "previousCheckedAt", width: 25 },
    { key: "lastCheckedAt", width: 25 },
    { key: "note", width: 58 },
  ];
  worksheet.getColumn(4).hidden = true;

  let previousUnitKey: string | null = null;
  let dataIndex = 0;
  rows.forEach((row) => {
    const unitKey = row.unitKey ?? row.unitLabel ?? "unclassified";
    if (unitKey !== previousUnitKey) {
      const unitRow = worksheet.addRow([
        row.unitOrder && row.unitOrder <= 100 ? toRomanNumeral(row.unitOrder) : "",
        row.unitLabel || "Chưa phân loại",
        "",
        "",
        "",
        "",
        "",
        "",
      ]);
      unitRow.font = { name: "Arial", size: 10, bold: true, color: { argb: "FF0B5F8A" } };
      unitRow.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFE7F4FA" } };
      previousUnitKey = unitKey;
    }

    const worksheetRow = worksheet.addRow([
      dataIndex + 1,
      row.name,
      row.taxCode,
      "",
      row.status,
      row.previousCheckedAt,
      row.lastCheckedAt,
      row.note,
    ]);
    worksheetRow.alignment = { vertical: "top", wrapText: true };
    worksheetRow.font = { name: "Arial", size: 10 };
    if (dataIndex % 2 === 1) worksheetRow.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF7FAFC" } };
    dataIndex += 1;
  });

  return worksheet;
}

function toRomanNumeral(value: number) {
  const pairs: Array<[number, string]> = [[10, "X"], [9, "IX"], [5, "V"], [4, "IV"], [1, "I"]];
  let remainder = Math.max(1, Math.floor(value));
  let result = "";
  for (const [amount, symbol] of pairs) {
    while (remainder >= amount) {
      result += symbol;
      remainder -= amount;
    }
  }
  return result;
}

export function createTaxpayerTemplateWorkbook(year = new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Ho_Chi_Minh", year: "numeric" }).format(new Date())) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "TAX ID Checker";
  workbook.created = new Date();
  addTaxpayerWorksheet(workbook, year, []);
  return workbook;
}

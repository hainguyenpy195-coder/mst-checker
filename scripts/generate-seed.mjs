import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import ExcelJS from "exceljs";

const TARGET_SHEETS = [
  { workbookNames: ["2023"], dbYear: "2023" },
  { workbookNames: ["2024"], dbYear: "2024" },
  { workbookNames: ["2025"], dbYear: "2025" },
  // The source workbook is labelled T2-26/T2-2026, but the application
  // intentionally stores and displays it as year 2026.
  { workbookNames: ["T2-26", "T2-2026"], dbYear: "2026" },
];
const DEFAULT_INPUT = "2023, 2024, 2025, T2-26 (Trụ sở chính).xlsx";
const DEFAULT_OUTPUT = path.join("supabase", "seed.sql");

function getArg(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

function text(value) {
  return value == null ? "" : String(value).trim();
}

function cellText(cell) {
  if (cell == null || typeof cell !== "object" || !Object.prototype.hasOwnProperty.call(cell, "value")) {
    return text(cell);
  }
  const value = cell?.value;
  if (value == null) return "";
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "object") {
    if (Array.isArray(value.richText)) return value.richText.map((item) => item.text ?? "").join("");
    if (value.result != null) return text(value.result);
    if (value.text != null) return text(value.text);
  }
  return text(value);
}

function normalized(value) {
  return text(value)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/đ/gi, "d")
    .replace(/\s+/g, " ")
    .trim();
}

function sqlText(value) {
  const valueText = text(value);
  return valueText ? `'${valueText.replaceAll("'", "''")}'` : "null";
}

function isoDate(value) {
  const raw = text(value);
  if (!raw) return null;

  const match = raw.match(/^(\d{1,2})[\/-](\d{1,2})[\/-](\d{4})$/);
  if (match) {
    const [, day, month, year] = match;
    const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
    return isUsableDate(date)
      ? `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}T00:00:00+07:00`
      : null;
  }

  // ExcelJS can expose date cells as Excel serial numbers when the source
  // workbook stores the value as a number instead of a JavaScript Date.
  const serial = Number(raw);
  if (Number.isFinite(serial) && serial > 0 && serial < 100000) {
    const date = new Date(Date.UTC(1899, 11, 30) + serial * 24 * 60 * 60 * 1000);
    return isUsableDate(date) ? date.toISOString() : null;
  }

  const date = new Date(raw);
  return isUsableDate(date) ? date.toISOString() : null;
}

function isUsableDate(date) {
  if (Number.isNaN(date.getTime())) return false;
  const year = date.getUTCFullYear();
  return year >= 1900 && year <= 2100;
}

function normalizeTaxCode(value) {
  return text(value).replace(/\s+/g, "").replace(/[–—]/g, "-");
}

function suggestedTaxCode(value) {
  const code = normalizeTaxCode(value);
  if (/^\d{9}$/.test(code)) return `0${code}`;
  if (/^\d{13}$/.test(code)) return `${code.slice(0, 10)}-${code.slice(10)}`;
  return null;
}

function classifyStatus(value) {
  const status = normalized(value);
  if (status.includes("dang hoat dong")) return "active";
  if (status.includes("ngung") || status.includes("khong hoat dong") || status.includes("cham dut")) return "inactive";
  return "unknown";
}

function findHeaderIndex(rows) {
  return rows.findIndex((row) => row.some((cell) => {
    const value = normalized(cell);
    return value === "ma so thue" || value.includes("ma so thue");
  }));
}

function findColumn(header, patterns) {
  return header.findIndex((cell) => {
    const value = normalized(cell);
    return patterns.some((pattern) => pattern.test(value));
  });
}

const UNIT_MARKER_PATTERN = /^(?:I|II|III|IV|V|VI|VII|VIII|IX|X|XI|XII|XIII|XIV|XV|XVI|XVII|XVIII|XIX|XX)\.?$/i;
const UNIT_DEFINITIONS = new Map([
  ["xuong dvkt", { key: "xuong-dvkt", order: 1 }],
  ["xuong dich vu ky thuat", { key: "xuong-dvkt", order: 1 }],
  ["phong tckt", { key: "phong-tckt", order: 2 }],
  ["phong khkd", { key: "phong-khkd", order: 3 }],
  ["phong ktatcl", { key: "phong-ktatcl", order: 4 }],
  ["phong ncpt", { key: "phong-ncpt", order: 5 }],
  ["phong tccbld", { key: "phong-tccbld", order: 6 }],
  ["tt huan luyen cns", { key: "tt-huan-luyen-cns", order: 7 }],
  ["vpct", { key: "vpct", order: 8 }],
]);

function normalizeUnitLabel(value) {
  return text(value)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/gi, "d")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function romanNumeralToNumber(value) {
  const roman = text(value).replace(/\.$/, "").toUpperCase();
  const values = { I: 1, V: 5, X: 10, L: 50, C: 100 };
  let total = 0;
  let previous = 0;
  for (const character of [...roman].reverse()) {
    const current = values[character] ?? 0;
    total += current < previous ? -current : current;
    previous = current;
  }
  return total > 0 ? total : null;
}

function resolveSourceUnit(marker, label) {
  const sourceLabel = text(label);
  const definition = UNIT_DEFINITIONS.get(normalizeUnitLabel(sourceLabel));
  const generatedKey = normalizeUnitLabel(sourceLabel).replace(/\s+/g, "-");
  const key = definition?.key ?? (generatedKey || "unclassified");
  return {
    key,
    label: sourceLabel,
    order: definition?.order ?? romanNumeralToNumber(marker),
  };
}

function parseSheet(dbYear, worksheet) {
  const rows = [];
  worksheet.eachRow({ includeEmpty: true }, (row) => {
    rows.push(row.values.slice(1).map((cell) => cellText(cell)));
  });
  const headerIndex = findHeaderIndex(rows);

  if (headerIndex < 0) {
    return { records: [], units: [], issues: [{ sourceSheet: dbYear, sourceRow: null, rawTaxCode: null, issueType: "header_not_found" }] };
  }

  const header = rows[headerIndex];
  const taxCodeColumn = findColumn(header, [/ma so thue/]);
  const nameColumn = findColumn(header, [/ten nguoi ban/, /ten nguoi nop thue/, /ten doanh nghiep/]);
  const orgTypeColumn = findColumn(header, [/loai to chuc/, /org type/]);
  const statusColumn = findColumn(header, [/tinh trang hoat dong/, /^status$/]);
  const checkedAtColumn = findColumn(header, [/thoi diem tra cuu moi nhat/, /last checked/]);
  const noteColumn = findColumn(header, [/ghi chu/, /note/]);

  if (taxCodeColumn < 0) {
    return { records: [], units: [], issues: [{ sourceSheet: dbYear, sourceRow: headerIndex + 1, rawTaxCode: null, issueType: "tax_code_column_not_found" }] };
  }

  const records = [];
  const units = new Map();
  const issues = [];
  let currentUnit = null;

  rows.slice(headerIndex + 1).forEach((row, offset) => {
    const sourceRow = headerIndex + offset + 2;
    const rawTaxCode = text(row[taxCodeColumn]);
    const taxCode = normalizeTaxCode(rawTaxCode);
    const vendorName = nameColumn >= 0 ? text(row[nameColumn]) : "";

    if (UNIT_MARKER_PATTERN.test(text(row[0])) && text(row[1]) && !taxCode) {
      currentUnit = resolveSourceUnit(row[0], row[1]);
      if (currentUnit.order) {
        units.set(currentUnit.key, {
          sourceYear: dbYear,
          sourceUnitKey: currentUnit.key,
          sourceUnitLabel: currentUnit.label,
          sourceUnitOrder: currentUnit.order,
        });
      }
      return;
    }

    // Ignore blank/layout rows and section headings without a tax code.
    if (!taxCode) return;

    if (!/^(?:\d{10}|\d{12}|\d{10}-\d{3})$/.test(taxCode)) {
      issues.push({ sourceSheet: dbYear, sourceRow, rawTaxCode, suggestedTaxCode: suggestedTaxCode(taxCode), issueType: "invalid_tax_code" });
      return;
    }

    records.push({
      taxCode,
      sourceSheet: dbYear,
      sourceYear: dbYear,
      sourceRow,
      sourceUnitKey: currentUnit?.key ?? null,
      sourceUnitLabel: currentUnit?.label ?? null,
      sourceUnitOrder: currentUnit?.order ?? null,
      vendorName,
      orgType: orgTypeColumn >= 0 ? text(row[orgTypeColumn]) : "",
      status: statusColumn >= 0 ? text(row[statusColumn]) : "",
      checkedAt: checkedAtColumn >= 0 ? isoDate(row[checkedAtColumn]) : null,
      note: noteColumn >= 0 ? text(row[noteColumn]) : "",
    });
  });

  return { records, units: [...units.values()], issues };
}

async function createSql(inputPath, outputPath) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(inputPath);
  const allRecords = [];
  const allUnits = new Map();
  const allIssues = [];

  for (const target of TARGET_SHEETS) {
    const workbookSheetName = target.workbookNames.find((name) => workbook.getWorksheet(name));
    const worksheet = workbookSheetName ? workbook.getWorksheet(workbookSheetName) : undefined;
    if (!worksheet) {
      allIssues.push({ sourceSheet: target.dbYear, sourceRow: null, rawTaxCode: null, issueType: "sheet_not_found" });
      continue;
    }
    const parsed = parseSheet(target.dbYear, worksheet);
    allRecords.push(...parsed.records);
    for (const unit of parsed.units) allUnits.set(`${unit.sourceYear}:${unit.sourceUnitKey}`, unit);
    allIssues.push(...parsed.issues);
  }

  const unique = new Map();
  for (const record of allRecords) {
    const existing = unique.get(record.taxCode);
    if (!existing || record.checkedAt > (existing.checkedAt ?? "")) {
      unique.set(record.taxCode, record);
    }
  }

  const lines = [
    "-- GENERATED LOCALLY. This file contains confidential taxpayer data and is gitignored.",
    `-- Source: ${path.basename(inputPath)}`,
    `-- Rows read: ${allRecords.length}; unique valid MST: ${unique.size}; issues: ${allIssues.length}`,
    "begin;",
  ];

  for (const unit of [...allUnits.values()].sort((left, right) => Number(left.sourceYear) - Number(right.sourceYear) || left.sourceUnitOrder - right.sourceUnitOrder)) {
    lines.push(
      `insert into public.taxpayer_source_units (source_year, source_unit_key, source_unit_label, source_unit_order) values (${sqlText(unit.sourceYear)}, ${sqlText(unit.sourceUnitKey)}, ${sqlText(unit.sourceUnitLabel)}, ${unit.sourceUnitOrder}) on conflict (source_year, source_unit_key) do update set source_unit_label = excluded.source_unit_label, source_unit_order = excluded.source_unit_order, updated_at = now();`,
    );
  }

  for (const record of unique.values()) {
    const status = record.status || null;
    const checkedAt = record.checkedAt ? `'${record.checkedAt}'` : "null";
    lines.push(
      `insert into public.taxpayers (tax_code, name, org_type, status, status_group, last_checked_at, next_check_at) values (${sqlText(record.taxCode)}, ${sqlText(record.vendorName)}, ${sqlText(record.orgType)}, ${sqlText(status)}, ${sqlText(classifyStatus(status))}, ${checkedAt}, now()) on conflict (tax_code) do update set name = coalesce(excluded.name, public.taxpayers.name), org_type = coalesce(excluded.org_type, public.taxpayers.org_type), status = coalesce(excluded.status, public.taxpayers.status), status_group = case when excluded.status is null then public.taxpayers.status_group else excluded.status_group end, last_checked_at = coalesce(excluded.last_checked_at, public.taxpayers.last_checked_at), next_check_at = now(), updated_at = now();`,
    );
  }

  for (const record of allRecords) {
    lines.push(
      `insert into public.taxpayer_sources (tax_code, source_sheet, source_year, source_row, source_unit_key, source_unit_label, source_unit_order, source_vendor_name, source_note) values (${sqlText(record.taxCode)}, ${sqlText(record.sourceSheet)}, ${sqlText(record.sourceYear)}, ${record.sourceRow}, ${sqlText(record.sourceUnitKey)}, ${sqlText(record.sourceUnitLabel)}, ${record.sourceUnitOrder ?? "null"}, ${sqlText(record.vendorName)}, ${sqlText(record.note)}) on conflict (tax_code, source_sheet, source_row) do update set source_unit_key = excluded.source_unit_key, source_unit_label = excluded.source_unit_label, source_unit_order = excluded.source_unit_order, source_vendor_name = excluded.source_vendor_name, source_note = excluded.source_note;`,
    );
  }

  for (const issue of allIssues) {
    lines.push(
      `insert into public.import_issues (source_sheet, source_row, raw_tax_code, suggested_tax_code, issue_type, note) values (${sqlText(issue.sourceSheet)}, ${issue.sourceRow ?? "null"}, ${sqlText(issue.rawTaxCode)}, ${sqlText(issue.suggestedTaxCode)}, ${sqlText(issue.issueType)}, 'Review before adding to the taxpayer directory.');`,
    );
  }

  // Every valid unique MST is queued for the first XInvoice refresh. The
  // worker claims small batches and applies its own retry/backoff policy.
  for (const record of unique.values()) {
    lines.push(
      `insert into public.refresh_queue (tax_code, priority, state, run_after) values (${sqlText(record.taxCode)}, 0, 'queued', now()) on conflict (tax_code) do update set state = 'queued', run_after = now(), last_error = null, updated_at = now();`,
    );
  }

  lines.push("commit;", "");
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${lines.join("\n")}\n`, "utf8");

  console.log(`Generated ${outputPath}`);
  console.log(`Valid rows: ${allRecords.length}`);
  console.log(`Unique MST: ${unique.size}`);
  console.log(`Issues: ${allIssues.length}`);
}

const inputPath = path.resolve(getArg("--input", DEFAULT_INPUT));
const outputPath = path.resolve(getArg("--output", DEFAULT_OUTPUT));

if (!fs.existsSync(inputPath)) {
  console.error(`Input workbook not found: ${inputPath}`);
  process.exit(1);
}

await createSql(inputPath, outputPath);

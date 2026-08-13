import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import XLSX from "xlsx";

const TARGET_SHEETS = ["2023", "2024", "2025", "T2-26"];
const DEFAULT_INPUT = "2023, 2024, 2025, T2-26 (Trụ sở chính).xlsx";
const DEFAULT_OUTPUT = path.join("supabase", "seed.sql");

function getArg(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

function text(value) {
  return value == null ? "" : String(value).trim();
}

function normalized(value) {
  return text(value)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/đ/g, "d")
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
    return `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}T00:00:00+07:00`;
  }

  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
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

function parseSheet(sheetName, worksheet) {
  const rows = XLSX.utils.sheet_to_json(worksheet, { header: 1, defval: null, raw: false });
  const headerIndex = findHeaderIndex(rows);

  if (headerIndex < 0) {
    return { records: [], issues: [{ sourceSheet: sheetName, sourceRow: null, rawTaxCode: null, issueType: "header_not_found" }] };
  }

  const header = rows[headerIndex];
  const taxCodeColumn = findColumn(header, [/ma so thue/]);
  const nameColumn = findColumn(header, [/ten nguoi ban/, /ten nguoi nop thue/, /ten doanh nghiep/]);
  const orgTypeColumn = findColumn(header, [/loai to chuc/, /org type/]);
  const statusColumn = findColumn(header, [/tinh trang hoat dong/, /^status$/]);
  const checkedAtColumn = findColumn(header, [/thoi diem tra cuu moi nhat/, /last checked/]);
  const noteColumn = findColumn(header, [/ghi chu/, /note/]);

  if (taxCodeColumn < 0) {
    return { records: [], issues: [{ sourceSheet: sheetName, sourceRow: headerIndex + 1, rawTaxCode: null, issueType: "tax_code_column_not_found" }] };
  }

  const records = [];
  const issues = [];

  rows.slice(headerIndex + 1).forEach((row, offset) => {
    const sourceRow = headerIndex + offset + 2;
    const rawTaxCode = text(row[taxCodeColumn]);
    const taxCode = normalizeTaxCode(rawTaxCode);
    const vendorName = nameColumn >= 0 ? text(row[nameColumn]) : "";

    // Ignore blank/layout rows and section headings without a tax code.
    if (!taxCode) return;

    if (!/^(?:\d{10}|\d{12}|\d{10}-\d{3})$/.test(taxCode)) {
      issues.push({ sourceSheet: sheetName, sourceRow, rawTaxCode, suggestedTaxCode: suggestedTaxCode(taxCode), issueType: "invalid_tax_code" });
      return;
    }

    records.push({
      taxCode,
      sourceSheet: sheetName,
      sourceYear: sheetName,
      sourceRow,
      vendorName,
      orgType: orgTypeColumn >= 0 ? text(row[orgTypeColumn]) : "",
      status: statusColumn >= 0 ? text(row[statusColumn]) : "",
      checkedAt: checkedAtColumn >= 0 ? isoDate(row[checkedAtColumn]) : null,
      note: noteColumn >= 0 ? text(row[noteColumn]) : "",
    });
  });

  return { records, issues };
}

function createSql(inputPath, outputPath) {
  const workbook = XLSX.readFile(inputPath, { cellDates: false, raw: false });
  const allRecords = [];
  const allIssues = [];

  for (const sheetName of TARGET_SHEETS) {
    const worksheet = workbook.Sheets[sheetName];
    if (!worksheet) {
      allIssues.push({ sourceSheet: sheetName, sourceRow: null, rawTaxCode: null, issueType: "sheet_not_found" });
      continue;
    }
    const parsed = parseSheet(sheetName, worksheet);
    allRecords.push(...parsed.records);
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

  for (const record of unique.values()) {
    const status = record.status || null;
    const checkedAt = record.checkedAt ? `'${record.checkedAt}'` : "null";
    lines.push(
      `insert into public.taxpayers (tax_code, name, org_type, status, status_group, last_checked_at, next_check_at) values (${sqlText(record.taxCode)}, ${sqlText(record.vendorName)}, ${sqlText(record.orgType)}, ${sqlText(status)}, ${sqlText(classifyStatus(status))}, ${checkedAt}, now() + interval '24 hours') on conflict (tax_code) do update set name = excluded.name, org_type = excluded.org_type, status = coalesce(excluded.status, public.taxpayers.status), status_group = case when excluded.status is null then public.taxpayers.status_group else excluded.status_group end, last_checked_at = coalesce(excluded.last_checked_at, public.taxpayers.last_checked_at), updated_at = now();`,
    );
  }

  for (const record of allRecords) {
    lines.push(
      `insert into public.taxpayer_sources (tax_code, source_sheet, source_year, source_row, source_vendor_name, source_note) values (${sqlText(record.taxCode)}, ${sqlText(record.sourceSheet)}, ${sqlText(record.sourceYear)}, ${record.sourceRow}, ${sqlText(record.vendorName)}, ${sqlText(record.note)}) on conflict (tax_code, source_sheet, source_row) do update set source_vendor_name = excluded.source_vendor_name, source_note = excluded.source_note;`,
    );
  }

  for (const issue of allIssues) {
    lines.push(
      `insert into public.import_issues (source_sheet, source_row, raw_tax_code, suggested_tax_code, issue_type, note) values (${sqlText(issue.sourceSheet)}, ${issue.sourceRow ?? "null"}, ${sqlText(issue.rawTaxCode)}, ${sqlText(issue.suggestedTaxCode)}, ${sqlText(issue.issueType)}, 'Review before adding to the taxpayer directory.');`,
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

createSql(inputPath, outputPath);

import { NextResponse } from "next/server";
import { authenticateRequest, isAdminSession, READ_ONLY_FORBIDDEN_MESSAGE } from "@/lib/app-auth";
import { isValidTaxCode, normalizeTaxCode } from "@/lib/tax-code";
import { createAdminClient } from "@/lib/supabase/admin";
import { readInCodeBatches } from "@/lib/supabase-pagination";
import type { TaxpayerExcelCandidate, TaxpayerExcelSource } from "@/lib/taxpayer-excel";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const MAX_CANDIDATES_PER_COMMIT = 200;
const YEAR_PATTERN = /^\d{4}$/;

type TaxpayerCodeRecord = { tax_code: string };

function readText(value: unknown, maxLength: number) {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string" && typeof value !== "number") return null;
  const text = String(value).trim();
  return text ? text.slice(0, maxLength) : null;
}

function parseCandidates(value: unknown): { candidates?: TaxpayerExcelCandidate[]; error?: string } {
  if (!Array.isArray(value) || value.length === 0) {
    return { error: "Không có MST mới để thêm." };
  }
  if (value.length > MAX_CANDIDATES_PER_COMMIT) {
    return { error: `Mỗi lượt chỉ được thêm tối đa ${MAX_CANDIDATES_PER_COMMIT} MST.` };
  }

  const grouped = new Map<string, TaxpayerExcelCandidate>();
  for (const item of value) {
    if (!item || typeof item !== "object") return { error: "Dữ liệu MST nhập vào không hợp lệ." };
    const record = item as Record<string, unknown>;
    const taxCode = normalizeTaxCode(typeof record.taxCode === "string" ? record.taxCode : "");
    if (!isValidTaxCode(taxCode)) return { error: `MST ${taxCode || "không xác định"} không đúng định dạng.` };
    if (!Array.isArray(record.sources) || record.sources.length === 0) {
      return { error: `MST ${taxCode} không có thông tin sheet nguồn.` };
    }

    const candidate = grouped.get(taxCode) ?? {
      taxCode,
      sources: [],
    };

    for (const sourceValue of record.sources) {
      if (!sourceValue || typeof sourceValue !== "object") return { error: `Nguồn dữ liệu của MST ${taxCode} không hợp lệ.` };
      const sourceRecord = sourceValue as Record<string, unknown>;
      const sourceSheet = readText(sourceRecord.sourceSheet, 31);
      const sourceYear = readText(sourceRecord.sourceYear, 4);
      const sourceRow = Number(sourceRecord.sourceRow);
      if (!sourceSheet || !sourceYear || !YEAR_PATTERN.test(sourceYear) || sourceSheet !== sourceYear || !Number.isInteger(sourceRow) || sourceRow < 3) {
        return { error: `Nguồn dữ liệu của MST ${taxCode} có năm hoặc dòng Excel không hợp lệ.` };
      }

      const source: TaxpayerExcelSource = {
        sourceSheet,
        sourceYear,
        sourceRow,
      };
      const isDuplicateSource = candidate.sources.some((current) => current.sourceSheet === source.sourceSheet && current.sourceRow === source.sourceRow);
      if (!isDuplicateSource) candidate.sources.push(source);
    }

    grouped.set(taxCode, candidate);
  }

  return { candidates: [...grouped.values()] };
}

export async function POST(request: Request) {
  const session = await authenticateRequest(request);
  if (!session) return NextResponse.json({ error: "Bạn cần đăng nhập." }, { status: 401 });
  if (!isAdminSession(session)) {
    return NextResponse.json({ error: READ_ONLY_FORBIDDEN_MESSAGE }, { status: 403 });
  }

  let body: { candidates?: unknown };
  try {
    body = await request.json() as { candidates?: unknown };
  } catch {
    return NextResponse.json({ error: "Dữ liệu xác nhận nhập Excel không hợp lệ." }, { status: 400 });
  }

  const parsed = parseCandidates(body.candidates);
  if (!parsed.candidates) return NextResponse.json({ error: parsed.error }, { status: 400 });

  const supabase = createAdminClient();
  const taxCodes = parsed.candidates.map((candidate) => candidate.taxCode);
  const existingResult = await readInCodeBatches(taxCodes, (batch) => supabase
    .from("taxpayers")
    .select("tax_code")
    .in("tax_code", batch));
  if (existingResult.error) {
    console.error("taxpayer Excel commit existing-code lookup failed", existingResult.error);
    return NextResponse.json({ error: "Không thể kiểm tra MST trước khi thêm." }, { status: 500 });
  }

  const existingTaxCodes = new Set((existingResult.data as TaxpayerCodeRecord[]).map((row) => row.tax_code));
  const candidates = parsed.candidates.filter((candidate) => !existingTaxCodes.has(candidate.taxCode));
  if (!candidates.length) {
    return NextResponse.json({ ok: true, addedTaxCodes: [], addedCount: 0, skippedCount: parsed.candidates.length, sourceCount: 0 });
  }

  const rows = candidates.map((candidate) => ({
    tax_code: candidate.taxCode,
    sources: candidate.sources.map((source) => ({
      source_sheet: source.sourceSheet,
      source_year: source.sourceYear,
      source_row: source.sourceRow,
    })),
  }));
  const { data, error } = await supabase.rpc("import_taxpayer_batch", {
    p_rows: rows,
    p_actor_username: session.username,
  });
  if (error) {
    console.error("taxpayer Excel batch insert failed", error);
    return NextResponse.json({ error: "Không thể thêm MST hàng loạt. Hãy kiểm tra migration nhập Excel trên Supabase." }, { status: 500 });
  }

  const addedTaxCodes = (Array.isArray(data) ? data : [])
    .map((row) => (row && typeof row === "object" ? (row as { tax_code?: unknown }).tax_code : null))
    .filter((taxCode): taxCode is string => typeof taxCode === "string");
  const addedSet = new Set(addedTaxCodes);
  const sourceCount = candidates
    .filter((candidate) => addedSet.has(candidate.taxCode))
    .reduce((count, candidate) => count + candidate.sources.length, 0);

  return NextResponse.json({
    ok: true,
    addedTaxCodes,
    addedCount: addedTaxCodes.length,
    skippedCount: parsed.candidates.length - addedTaxCodes.length,
    sourceCount,
  }, { status: 201 });
}

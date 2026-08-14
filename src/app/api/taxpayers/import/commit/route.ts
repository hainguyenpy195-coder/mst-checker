import { NextResponse } from "next/server";
import { authenticateRequest, isAdminSession, READ_ONLY_FORBIDDEN_MESSAGE } from "@/lib/app-auth";
import { isValidTaxCode, normalizeTaxCode } from "@/lib/tax-code";
import { createAdminClient } from "@/lib/supabase/admin";
import { readInCodeBatches } from "@/lib/supabase-pagination";
import type { TaxpayerExcelCandidate, TaxpayerExcelSource } from "@/lib/taxpayer-excel";
import {
  getTaxpayerImportSession,
  isTaxpayerImportId,
  readStoredCandidates,
  readStoredSourceUnits,
} from "@/lib/taxpayer-import";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const MAX_COMMIT_BATCH_SIZE = 100;
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
  if (value.length > MAX_COMMIT_BATCH_SIZE) {
    return { error: `Mỗi lượt chỉ được thêm tối đa ${MAX_COMMIT_BATCH_SIZE} MST.` };
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

    const candidate = grouped.get(taxCode) ?? { taxCode, sources: [] };
    for (const sourceValue of record.sources) {
      if (!sourceValue || typeof sourceValue !== "object") return { error: `Nguồn dữ liệu của MST ${taxCode} không hợp lệ.` };
      const sourceRecord = sourceValue as Record<string, unknown>;
      const sourceSheet = readText(sourceRecord.sourceSheet, 31);
      const sourceYear = readText(sourceRecord.sourceYear, 4);
      const sourceRow = Number(sourceRecord.sourceRow);
      const sourceUnitKey = readText(sourceRecord.sourceUnitKey, 80);
      const sourceUnitLabel = readText(sourceRecord.sourceUnitLabel, 120);
      const sourceUnitOrderValue = sourceRecord.sourceUnitOrder === null || sourceRecord.sourceUnitOrder === undefined
        ? null
        : Number(sourceRecord.sourceUnitOrder);
      if (!sourceSheet || !sourceYear || !YEAR_PATTERN.test(sourceYear) || sourceSheet !== sourceYear || !Number.isInteger(sourceRow) || sourceRow < 3
        || (sourceUnitKey && !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(sourceUnitKey))
        || (sourceUnitOrderValue !== null && (!Number.isInteger(sourceUnitOrderValue) || sourceUnitOrderValue < 1 || sourceUnitOrderValue > 100))) {
        return { error: `Nguồn dữ liệu của MST ${taxCode} có năm hoặc dòng Excel không hợp lệ.` };
      }

      const source: TaxpayerExcelSource = {
        sourceSheet,
        sourceYear,
        sourceRow,
        sourceUnitKey,
        sourceUnitLabel,
        sourceUnitOrder: sourceUnitOrderValue,
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

  let body: { importId?: unknown; offset?: unknown };
  try {
    body = await request.json() as { importId?: unknown; offset?: unknown };
  } catch {
    return NextResponse.json({ error: "Dữ liệu xác nhận nhập Excel không hợp lệ." }, { status: 400 });
  }
  if (!isTaxpayerImportId(body.importId)) {
    return NextResponse.json({ error: "Không xác định được phiên nhập Excel." }, { status: 400 });
  }
  const offset = typeof body.offset === "number" ? body.offset : Number(body.offset);
  if (!Number.isSafeInteger(offset) || offset < 0) {
    return NextResponse.json({ error: "Vị trí lô MST nhập vào không hợp lệ." }, { status: 400 });
  }

  const supabase = createAdminClient();
  const { data: importSession, error: sessionError } = await getTaxpayerImportSession(supabase, body.importId, session.username);
  if (sessionError) {
    console.error("taxpayer Excel commit session lookup failed", sessionError);
    return NextResponse.json({ error: "Không thể kiểm tra phiên nhập Excel." }, { status: 500 });
  }
  if (!importSession) return NextResponse.json({ error: "Không tìm thấy phiên nhập Excel." }, { status: 404 });
  if (!["previewed", "committing"].includes(importSession.status)) {
    return NextResponse.json({ error: "Phiên nhập Excel này không còn ở trạng thái chờ xác nhận." }, { status: 409 });
  }

  const candidates = readStoredCandidates(importSession.candidates);
  if (offset !== importSession.commit_offset) {
    return NextResponse.json({
      error: "Lô MST này không còn là lô kế tiếp cần xử lý.",
      nextOffset: importSession.commit_offset,
    }, { status: 409 });
  }
  if (offset >= candidates.length) {
    return NextResponse.json({
      ok: true,
      done: true,
      nextOffset: offset,
      totalCandidates: candidates.length,
      addedTaxCodes: [],
      addedCount: importSession.added_count,
      skippedCount: 0,
      sourceCount: 0,
    });
  }

  const parsed = parseCandidates(candidates.slice(offset, offset + MAX_COMMIT_BATCH_SIZE));
  if (!parsed.candidates) return NextResponse.json({ error: parsed.error }, { status: 400 });
  const sourceUnits = readStoredSourceUnits(importSession.source_units);

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
  const existingCandidates = parsed.candidates.filter((candidate) => existingTaxCodes.has(candidate.taxCode));
  let addedTaxCodes: string[] = [];
  let sourceCount = 0;
  if (parsed.candidates.length) {
    const rows = parsed.candidates.map((candidate) => ({
      tax_code: candidate.taxCode,
      sources: candidate.sources.map((source) => ({
        source_sheet: source.sourceSheet,
        source_year: source.sourceYear,
        source_row: source.sourceRow,
        source_unit_key: source.sourceUnitKey,
        source_unit_label: source.sourceUnitLabel,
        source_unit_order: source.sourceUnitOrder,
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

    addedTaxCodes = (Array.isArray(data) ? data : [])
      .map((row) => (row && typeof row === "object" ? (row as { tax_code?: unknown }).tax_code : null))
      .filter((taxCode): taxCode is string => typeof taxCode === "string");
    sourceCount = parsed.candidates.reduce((count, candidate) => count + candidate.sources.length, 0);
  }

  if (offset === 0 && sourceUnits.length) {
    const { error: sourceUnitsError } = await supabase
      .from("taxpayer_source_units")
      .upsert(sourceUnits.map((unit) => ({
        source_year: unit.sourceYear,
        source_unit_key: unit.unitKey,
        source_unit_label: unit.unitLabel,
        source_unit_order: unit.unitOrder,
        updated_at: new Date().toISOString(),
      })), { onConflict: "source_year,source_unit_key" });
    if (sourceUnitsError) {
      console.error("taxpayer Excel source units save failed", sourceUnitsError);
      return NextResponse.json({ error: "Không thể lưu danh sách đơn vị từ file Excel." }, { status: 500 });
    }
  }

  const storedAddedTaxCodes = Array.isArray(importSession.added_tax_codes)
    ? importSession.added_tax_codes.filter((taxCode): taxCode is string => typeof taxCode === "string")
    : [];
  const allAddedTaxCodes = [...new Set([...storedAddedTaxCodes, ...addedTaxCodes])];
  const nextOffset = offset + parsed.candidates.length;
  const { error: updateError } = await supabase.from("taxpayer_excel_imports").update({
    status: "committing",
    commit_offset: nextOffset,
    added_tax_codes: allAddedTaxCodes,
    added_count: allAddedTaxCodes.length,
    error: null,
  }).eq("id", importSession.id).eq("commit_offset", offset);
  if (updateError) {
    console.error("taxpayer Excel commit session update failed", updateError);
    return NextResponse.json({ error: "Không thể cập nhật tiến trình nhập Excel." }, { status: 500 });
  }

  return NextResponse.json({
    ok: true,
    done: nextOffset >= candidates.length,
    nextOffset,
    totalCandidates: candidates.length,
    addedTaxCodes,
    addedCount: allAddedTaxCodes.length,
    skippedCount: Math.max(0, parsed.candidates.length - addedTaxCodes.length - existingCandidates.length),
    existingCount: existingCandidates.length,
    sourceCount,
  }, { status: 201 });
}

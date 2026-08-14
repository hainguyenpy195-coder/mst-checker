import { NextResponse } from "next/server";
import { authenticateRequest, isAdminSession, READ_ONLY_FORBIDDEN_MESSAGE } from "@/lib/app-auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { readInCodeBatches } from "@/lib/supabase-pagination";
import { getTaxpayerExcelMaxUploadBytes, parseTaxpayerWorkbook } from "@/lib/taxpayer-excel";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

type TaxpayerCodeRecord = { tax_code: string };

export async function POST(request: Request) {
  const session = await authenticateRequest(request);
  if (!session) return NextResponse.json({ error: "Bạn cần đăng nhập." }, { status: 401 });
  if (!isAdminSession(session)) {
    return NextResponse.json({ error: READ_ONLY_FORBIDDEN_MESSAGE }, { status: 403 });
  }

  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return NextResponse.json({ error: "Không đọc được file Excel tải lên." }, { status: 400 });
  }

  const fileValue = formData.get("file");
  if (!(fileValue instanceof File)) {
    return NextResponse.json({ error: "Vui lòng chọn một file Excel." }, { status: 400 });
  }
  if (fileValue.size <= 0) {
    return NextResponse.json({ error: "File Excel đang rỗng." }, { status: 400 });
  }
  if (!fileValue.name.toLowerCase().endsWith(".xlsx")) {
    return NextResponse.json({ error: "Chỉ chấp nhận file Excel định dạng .xlsx." }, { status: 415 });
  }

  const maxBytes = getTaxpayerExcelMaxUploadBytes();
  if (fileValue.size > maxBytes) {
    return NextResponse.json({ error: `File vượt quá giới hạn ${(maxBytes / 1024 / 1024).toFixed(0)} MiB.` }, { status: 413 });
  }

  const buffer = Buffer.from(await fileValue.arrayBuffer());
  if (buffer.length > maxBytes) {
    return NextResponse.json({ error: `File vượt quá giới hạn ${(maxBytes / 1024 / 1024).toFixed(0)} MiB.` }, { status: 413 });
  }

  let parsed: Awaited<ReturnType<typeof parseTaxpayerWorkbook>>;
  try {
    parsed = await parseTaxpayerWorkbook(buffer);
  } catch (error) {
    console.error("taxpayer Excel parse failed", error);
    return NextResponse.json({
      error: error instanceof Error ? error.message : "Không thể đọc cấu trúc file Excel.",
    }, { status: 422 });
  }

  if (!parsed.candidates.length) {
    return NextResponse.json({
      ok: true,
      candidates: [],
      counts: {
        totalRows: parsed.totalRows,
        validRows: parsed.validRows,
        duplicateRows: parsed.duplicateRows,
        invalidRows: parsed.invalidRowCount,
        existing: 0,
        new: 0,
      },
      invalidRows: parsed.invalidRows,
      ignoredSheets: parsed.ignoredSheets,
      message: "Không tìm thấy MST hợp lệ chưa có trong cơ sở dữ liệu.",
    });
  }

  const supabase = createAdminClient();
  const taxCodes = parsed.candidates.map((candidate) => candidate.taxCode);
  const existingResult = await readInCodeBatches(taxCodes, (batch) => supabase
    .from("taxpayers")
    .select("tax_code")
    .in("tax_code", batch));
  if (existingResult.error) {
    console.error("taxpayer Excel existing-code lookup failed", existingResult.error);
    return NextResponse.json({ error: "Không thể kiểm tra MST đã có trong cơ sở dữ liệu." }, { status: 500 });
  }

  const existingTaxCodes = new Set((existingResult.data as TaxpayerCodeRecord[]).map((row) => row.tax_code));
  const candidates = parsed.candidates.filter((candidate) => !existingTaxCodes.has(candidate.taxCode));

  return NextResponse.json({
    ok: true,
    candidates,
    counts: {
      totalRows: parsed.totalRows,
      validRows: parsed.validRows,
      duplicateRows: parsed.duplicateRows,
      invalidRows: parsed.invalidRowCount,
      existing: existingTaxCodes.size,
      new: candidates.length,
    },
    invalidRows: parsed.invalidRows,
    ignoredSheets: parsed.ignoredSheets,
    message: candidates.length
      ? `Phát hiện ${candidates.length.toLocaleString("vi-VN")} MST chưa có trong cơ sở dữ liệu.`
      : "Không tìm thấy MST mới chưa có trong cơ sở dữ liệu.",
  });
}

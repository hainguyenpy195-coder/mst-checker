import { NextResponse } from "next/server";
import ExcelJS from "exceljs";
import { authenticateRequest } from "@/lib/app-auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { readAllPages, readInCodeBatches } from "@/lib/supabase-pagination";
import { addTaxpayerWorksheet, type TaxpayerWorkbookExportRow } from "@/lib/taxpayer-excel";
import { getTaxpayerUnitDisplayName, getTaxpayerUnitOrder } from "@/lib/taxpayer-units";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type TaxpayerRecord = {
  tax_code: string;
  name: string | null;
  status: string | null;
  previous_checked_at: string | null;
  last_checked_at: string | null;
  last_error: string | null;
};

type StatusHistoryRecord = {
  tax_code: string;
  old_status: string | null;
  new_status: string | null;
  detected_at: string;
};

function formatDate(value: string | null) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("vi-VN", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    timeZone: "Asia/Ho_Chi_Minh",
  }).format(date);
}

function text(value: string | null | undefined) {
  return value?.trim() ?? "";
}

export async function GET(request: Request) {
  if (!(await authenticateRequest(request))) {
    return NextResponse.json({ error: "Bạn cần đăng nhập." }, { status: 401 });
  }

  const requestedYear = new URL(request.url).searchParams.get("year") ?? "all";
  if (requestedYear !== "all" && !/^\d{4}$/.test(requestedYear)) {
    return NextResponse.json({ error: "Năm xuất Excel không hợp lệ." }, { status: 400 });
  }

  const supabase = createAdminClient();
  const sourceResult = await readAllPages((from, to) => {
    let query = supabase
      .from("taxpayer_sources")
      .select("id, tax_code, source_sheet, source_year, source_row, source_unit_key, source_unit_label, source_unit_order, source_vendor_name, source_note")
      .order("source_year", { ascending: true })
      .order("source_unit_order", { ascending: true })
      .order("source_row", { ascending: true })
      .range(from, to);
    if (requestedYear !== "all") query = query.eq("source_year", requestedYear);
    return query;
  }, 10000);

  const { data: sources, error: sourceError } = sourceResult;
  if (sourceError) return NextResponse.json({ error: "Không thể tải dữ liệu để xuất Excel." }, { status: 500 });

  const rows = sources ?? [];
  const taxCodes = [...new Set(rows.map((row) => row.tax_code))];
  const taxpayerResult = taxCodes.length
    ? await readInCodeBatches(taxCodes, (batch) => supabase.from("taxpayers").select("tax_code, name, status, previous_checked_at, last_checked_at, last_error").in("tax_code", batch))
    : { data: [], error: null };
  const { data: taxpayers, error: taxpayerError } = taxpayerResult;
  if (taxpayerError) return NextResponse.json({ error: "Không thể tải trạng thái MST để xuất Excel." }, { status: 500 });

  const historyResult = taxCodes.length
    ? await readInCodeBatches(taxCodes, (batch) => supabase
        .from("taxpayer_status_history")
        .select("tax_code, old_status, new_status, detected_at")
        .in("tax_code", batch)
        .order("detected_at", { ascending: false }))
    : { data: [], error: null };
  const { data: statusHistory, error: historyError } = historyResult;
  if (historyError) return NextResponse.json({ error: "Không thể tải lịch sử trạng thái để xuất Excel." }, { status: 500 });

  const byTaxCode = new Map(((taxpayers as TaxpayerRecord[] | null) ?? []).map((taxpayer) => [taxpayer.tax_code, taxpayer]));
  const latestStatusChangeByTaxCode = new Map<string, StatusHistoryRecord>();
  for (const history of (statusHistory as StatusHistoryRecord[] | null) ?? []) {
    if (!latestStatusChangeByTaxCode.has(history.tax_code) && history.old_status !== history.new_status) {
      latestStatusChangeByTaxCode.set(history.tax_code, history);
    }
  }
  const grouped = new Map<string, typeof rows>();
  for (const row of rows) {
    const year = row.source_year ?? row.source_sheet ?? "Khác";
    const list = grouped.get(year) ?? [];
    list.push(row);
    grouped.set(year, list);
  }

  const workbook = new ExcelJS.Workbook();
  workbook.creator = "TAX ID Checker";
  workbook.created = new Date();
  const years = [...grouped.keys()].sort((left, right) => Number(left) - Number(right));

  for (const year of years) {
    const exportRows: TaxpayerWorkbookExportRow[] = (grouped.get(year) ?? [])
      .sort((left, right) => {
        const unitOrderDifference = getTaxpayerUnitOrder(left.source_unit_key, left.source_unit_order)
          - getTaxpayerUnitOrder(right.source_unit_key, right.source_unit_order);
        return unitOrderDifference || (left.source_row ?? Number.MAX_SAFE_INTEGER) - (right.source_row ?? Number.MAX_SAFE_INTEGER) || left.id - right.id;
      })
      .map((source) => {
      const taxpayer = byTaxCode.get(source.tax_code);
      const statusChange = latestStatusChangeByTaxCode.get(source.tax_code);
      const noteParts = [
        text(source.source_note),
        statusChange ? text(statusChange.new_status) : "",
        text(taxpayer?.last_error),
      ].filter(Boolean);
      return {
        name: text(taxpayer?.name) || text(source.source_vendor_name),
        taxCode: text(source.tax_code),
        status: text(taxpayer?.status),
        previousCheckedAt: formatDate(taxpayer?.previous_checked_at ?? null),
        lastCheckedAt: formatDate(taxpayer?.last_checked_at ?? null),
        note: [...new Set(noteParts)].join(" | "),
        unitKey: source.source_unit_key ?? null,
        unitLabel: getTaxpayerUnitDisplayName(source.source_unit_key, source.source_unit_label),
        unitOrder: Number.isInteger(source.source_unit_order) ? source.source_unit_order : null,
      };
    });
    addTaxpayerWorksheet(workbook, year, exportRows);
  }

  if (!years.length) workbook.addWorksheet("Danh sách trống");
  const buffer = await workbook.xlsx.writeBuffer();
  return new NextResponse(new Uint8Array(buffer), {
    headers: {
      "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "content-disposition": `attachment; filename="TAX-ID-Checker-${new Date().toISOString().slice(0, 10)}.xlsx"`,
      "cache-control": "no-store",
    },
  });
}

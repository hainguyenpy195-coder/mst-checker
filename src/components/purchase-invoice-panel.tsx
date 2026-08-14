"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  CaretLeft,
  CaretRight,
  CheckCircle,
  FileText,
  MagnifyingGlass,
  WarningCircle,
  X,
} from "@phosphor-icons/react";
import type { AppRole } from "@/lib/app-auth";
import { isValidTaxCode, normalizeTaxCode } from "@/lib/tax-code";
import PurchaseInvoiceExcelImportModal, {
  type PurchaseInvoiceImportSummary,
} from "@/components/purchase-invoice-excel-import-modal";

const PAGE_SIZE = 100;

type PurchaseTaxpayerSummary = {
  name: string | null;
  status: string | null;
  status_group: "active" | "inactive" | "unknown" | null;
  last_checked_at: string | null;
  last_error: string | null;
  refresh_state?: "queued" | "running" | "success" | "retry" | "dead_letter" | null;
};

type PurchaseInvoiceRecord = {
  id: string;
  invoice_number: string | null;
  invoice_template_number: string | null;
  invoice_symbol: string | null;
  invoice_issue_date: string | null;
  seller_tax_code: string | null;
  seller_name: string | null;
  seller_taxpayer: PurchaseTaxpayerSummary | null;
  net_amount: number | string | null;
  deductible_vat_amount: number | string | null;
  source_sheet: string | null;
  source_row: number | null;
};

type PurchaseInvoiceListResponse = {
  rows?: PurchaseInvoiceRecord[];
  total?: number;
  page?: number;
  pageSize?: number;
  totalPages?: number;
  error?: string;
};

type TaxpayerStatusMeta = {
  label: string;
  className: string;
  title: string;
};

function formatCount(value: number) {
  return Math.max(0, value).toLocaleString("vi-VN");
}

function formatAmount(value: number | string | null) {
  if (value === null || value === "") return "—";
  const amount = Number(value);
  if (!Number.isFinite(amount)) return String(value);

  return new Intl.NumberFormat("vi-VN", {
    style: "currency",
    currency: "VND",
    maximumFractionDigits: 0,
  }).format(amount);
}

function formatVietnameseDate(value: string | null | undefined) {
  if (!value) return "—";

  // Invoice issue dates are stored as date values. Formatting the YYYY-MM-DD
  // part directly avoids a timezone shift in browsers west of UTC.
  const dateOnly = value.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (dateOnly) return `${dateOnly[3]}/${dateOnly[2]}/${dateOnly[1]}`;

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("vi-VN", { dateStyle: "short" }).format(date);
}

function taxpayerStatusMeta(invoice: PurchaseInvoiceRecord): TaxpayerStatusMeta {
  const rawTaxCode = invoice.seller_tax_code?.trim() ?? "";
  const taxCode = rawTaxCode ? normalizeTaxCode(rawTaxCode) : "";
  const taxpayer = invoice.seller_taxpayer;

  if (!taxCode) {
    return {
      label: "Chưa có MST",
      className: "invoice-taxpayer-status invoice-taxpayer-unknown",
      title: "Dòng hóa đơn không có mã số thuế người bán.",
    };
  }

  if (!isValidTaxCode(taxCode)) {
    return {
      label: "MST không hợp lệ",
      className: "invoice-taxpayer-status invoice-taxpayer-unknown",
      title: "Mã số thuế người bán trong file Excel không đúng định dạng.",
    };
  }

  // This wording is a business requirement: a valid seller tax code without a
  // matching taxpayer catalogue record must be clearly distinguishable from a
  // blank or malformed code.
  if (!taxpayer) {
    return {
      label: "MST chưa có trên CSDL",
      className: "invoice-taxpayer-status purchase-taxpayer-missing",
      title: `MST ${taxCode} chưa có trong danh mục MST của hệ thống.`,
    };
  }

  if (taxpayer.last_error && taxpayer.refresh_state !== "success") {
    return {
      label: "Lỗi kiểm tra",
      className: "invoice-taxpayer-status invoice-taxpayer-error",
      title: taxpayer.last_error,
    };
  }

  if (taxpayer.refresh_state === "queued" || taxpayer.refresh_state === "running" || taxpayer.refresh_state === "retry") {
    return {
      label: "Đang kiểm tra",
      className: "invoice-taxpayer-status invoice-taxpayer-pending",
      title: "MST đã có trong danh mục và đang được cập nhật trạng thái.",
    };
  }

  if (taxpayer.status_group === "active") {
    return {
      label: "Đang hoạt động",
      className: "invoice-taxpayer-status invoice-taxpayer-active",
      title: taxpayer.status ?? "MST đang hoạt động.",
    };
  }

  if (taxpayer.status_group === "inactive") {
    return {
      label: "Ngừng hoạt động",
      className: "invoice-taxpayer-status invoice-taxpayer-inactive",
      title: taxpayer.status ?? "MST đã ngừng hoạt động.",
    };
  }

  return {
    label: "Chưa có dữ liệu",
    className: "invoice-taxpayer-status invoice-taxpayer-unknown",
    title: taxpayer.status ?? "Chưa có dữ liệu trạng thái MST.",
  };
}

function invoiceIdentity(invoice: PurchaseInvoiceRecord) {
  const template = invoice.invoice_template_number?.trim() || null;
  const symbol = invoice.invoice_symbol?.replace(/\s+/g, "").toUpperCase() || null;
  if (template && symbol) return `${template}${symbol}`;
  return symbol ?? template ?? "—";
}

function sourceLabel(invoice: PurchaseInvoiceRecord) {
  const sheet = invoice.source_sheet?.trim() || "—";
  return invoice.source_row ? `${sheet} · dòng ${invoice.source_row}` : sheet;
}

export default function PurchaseInvoicePanel({ role }: { role: AppRole }) {
  const canWrite = role === "admin";
  const [rows, setRows] = useState<PurchaseInvoiceRecord[]>([]);
  const [total, setTotal] = useState(0);
  const [totalPages, setTotalPages] = useState(1);
  const [page, setPage] = useState(1);
  const [query, setQuery] = useState("");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [isLoading, setIsLoading] = useState(true);
  const [showImportModal, setShowImportModal] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const loadPurchases = useCallback(async (signal?: AbortSignal, requestedPage = page) => {
    if (dateFrom && dateTo && dateFrom > dateTo) {
      setIsLoading(false);
      setError("Ngày bắt đầu không được sau ngày kết thúc.");
      return;
    }

    setIsLoading(true);
    try {
      const params = new URLSearchParams({ page: String(requestedPage) });
      if (query.trim()) params.set("q", query.trim());
      if (dateFrom) params.set("dateFrom", dateFrom);
      if (dateTo) params.set("dateTo", dateTo);

      const response = await fetch(`/api/purchase-invoices?${params.toString()}`, {
        cache: "no-store",
        signal,
      });
      const payload = await response.json().catch(() => ({})) as PurchaseInvoiceListResponse;
      if (!response.ok) throw new Error(payload.error ?? "Không thể tải danh sách hóa đơn mua vào.");

      setRows(payload.rows ?? []);
      setTotal(payload.total ?? 0);
      setTotalPages(Math.max(1, payload.totalPages ?? 1));
      setError(null);
    } catch (loadError) {
      if (loadError instanceof Error && loadError.name === "AbortError") return;
      setError(loadError instanceof Error ? loadError.message : "Không thể tải danh sách hóa đơn mua vào.");
    } finally {
      if (!signal?.aborted) setIsLoading(false);
    }
  }, [dateFrom, dateTo, page, query]);

  useEffect(() => {
    const controller = new AbortController();
    void loadPurchases(controller.signal);
    return () => controller.abort();
  }, [loadPurchases]);

  useEffect(() => {
    if (!notice) return;
    const timeout = window.setTimeout(() => setNotice(null), 4500);
    return () => window.clearTimeout(timeout);
  }, [notice]);

  const pageLabel = useMemo(() => {
    if (!total) return "0 dòng";
    const start = (page - 1) * PAGE_SIZE + 1;
    const end = Math.min(page * PAGE_SIZE, total);
    return `Hiển thị ${formatCount(start)}-${formatCount(end)} / ${formatCount(total)} dòng`;
  }, [page, total]);

  function updateQuery(value: string) {
    setPage(1);
    setQuery(value);
  }

  function updateDateFrom(value: string) {
    setPage(1);
    setDateFrom(value);
  }

  function updateDateTo(value: string) {
    setPage(1);
    setDateTo(value);
  }

  function handleImportCompleted(summary: PurchaseInvoiceImportSummary) {
    const message = summary.failedCount
      ? `Đã nhập ${formatCount(summary.addedCount)} dòng hóa đơn; bỏ qua ${formatCount(summary.skippedCount)} dòng trùng và còn ${formatCount(summary.failedCount)} dòng chưa hoàn tất.`
      : `Đã nhập ${formatCount(summary.addedCount)} dòng hóa đơn mua vào; bỏ qua ${formatCount(summary.skippedCount)} dòng trùng.`;
    setNotice(message);
    setPage(1);
    void loadPurchases(undefined, 1);
  }

  return <section className="invoice-page purchase-invoice-page">
    <div className="invoice-intro">
      <div>
        <span className="invoice-eyebrow">HÓA ĐƠN MUA VÀO</span>
        <h2>Bảng tổng hợp mua vào</h2>
        <p>Theo dõi hóa đơn mua vào từ file Excel. Dữ liệu được lọc theo ngày phát hành, số hóa đơn, nhà cung cấp hoặc mã số thuế.</p>
      </div>
      <div className="purchase-intro-actions">
        {canWrite ? <button className="outline-button" type="button" onClick={() => { setError(null); setShowImportModal(true); }}><FileText size={17} /> Nhập Excel</button> : null}
        <div className="invoice-quota purchase-total-card">
          <span>Tổng dòng</span>
          <strong>{formatCount(total)}</strong>
          <small>{pageLabel}</small>
        </div>
      </div>
    </div>

    {notice ? <div className="page-notice page-notice-success" role="status"><CheckCircle size={18} /> {notice}</div> : null}
    {error ? <div className="invoice-alert" role="alert"><WarningCircle size={18} /> {error}</div> : null}

    <section className="table-section invoice-table-section purchase-invoice-table-section">
      <div className="table-toolbar">
        <div><h2>Danh sách hóa đơn mua vào</h2><span>{pageLabel}</span></div>
        <div className="toolbar-tools purchase-toolbar-tools">
          <label className="table-search"><MagnifyingGlass size={16} /><input value={query} onChange={(event) => updateQuery(event.target.value)} placeholder="Tìm số HĐ, nhà cung cấp, MST..." aria-label="Tìm hóa đơn mua vào" /><button type="button" title="Xóa tìm kiếm" aria-label="Xóa tìm kiếm" disabled={!query} onClick={() => updateQuery("")}><X size={15} /></button></label>
          <div className="purchase-date-range" role="group" aria-label="Lọc theo ngày phát hành hóa đơn">
            <label className="purchase-date-filter"><span>Từ ngày</span><input type="date" lang="vi-VN" value={dateFrom} max={dateTo || undefined} onChange={(event) => updateDateFrom(event.target.value)} aria-label="Từ ngày phát hành" /></label>
            <label className="purchase-date-filter"><span>Đến ngày</span><input type="date" lang="vi-VN" value={dateTo} min={dateFrom || undefined} onChange={(event) => updateDateTo(event.target.value)} aria-label="Đến ngày phát hành" /></label>
          </div>
          <span className="purchase-date-hint">dd/MM/yyyy · gồm cả hai ngày</span>
        </div>
      </div>
      <div className="table-scroll">
        <table className="data-table invoice-data-table purchase-invoice-data-table">
          <thead><tr><th>Ngày HĐ</th><th>Số hóa đơn</th><th>Nhà cung cấp / MST</th><th>Tình trạng MST</th><th>Mẫu số · Ký hiệu</th><th>Giá trị HHDV</th><th>VAT được khấu trừ</th><th>Nguồn</th></tr></thead>
          <tbody>
            {isLoading ? <PurchaseInvoiceTableSkeleton /> : rows.length === 0 ? <tr><td colSpan={8}><div className="table-empty"><FileText size={26} /><strong>Chưa có hóa đơn mua vào</strong><span>{canWrite ? "Nhấn Nhập Excel để thêm danh sách hóa đơn từ workbook." : "Chưa có dữ liệu hóa đơn mua vào để hiển thị."}</span></div></td></tr> : rows.map((invoice) => <PurchaseInvoiceTableRow key={invoice.id} invoice={invoice} />)}
          </tbody>
        </table>
      </div>
      <div className="table-footer"><span>{PAGE_SIZE} dòng/trang</span><div className="pagination-controls" aria-label="Phân trang hóa đơn mua vào"><button className="pagination-button" type="button" onClick={() => setPage((current) => Math.max(1, current - 1))} disabled={page <= 1}><CaretLeft size={16} /></button><span>Trang {page} / {totalPages}</span><button className="pagination-button" type="button" onClick={() => setPage((current) => Math.min(totalPages, current + 1))} disabled={page >= totalPages}><CaretRight size={16} /></button></div></div>
    </section>

    {canWrite && showImportModal ? <PurchaseInvoiceExcelImportModal onClose={() => setShowImportModal(false)} onCompleted={handleImportCompleted} /> : null}
  </section>;
}

function PurchaseInvoiceTableRow({ invoice }: { invoice: PurchaseInvoiceRecord }) {
  const taxpayerStatus = taxpayerStatusMeta(invoice);
  const taxCode = invoice.seller_tax_code?.trim() ? normalizeTaxCode(invoice.seller_tax_code) : null;

  return <tr className="data-row invoice-data-row">
    <td className="amount-cell">{formatVietnameseDate(invoice.invoice_issue_date)}</td>
    <td className="invoice-number-cell"><strong>{invoice.invoice_number ?? "—"}</strong></td>
    <td><strong>{invoice.seller_name ?? invoice.seller_taxpayer?.name ?? "Chưa có tên người bán"}</strong><div className="invoice-seller-tax"><small className="mono-value">{taxCode ?? "Chưa có MST"}</small></div></td>
    <td><span className={taxpayerStatus.className} title={taxpayerStatus.title}>{taxpayerStatus.label}</span></td>
    <td><span>{invoiceIdentity(invoice)}</span><small>Mẫu {invoice.invoice_template_number ?? "—"} · Ký hiệu {invoice.invoice_symbol ?? "—"}</small></td>
    <td className="amount-cell">{formatAmount(invoice.net_amount)}</td>
    <td className="amount-cell">{formatAmount(invoice.deductible_vat_amount)}</td>
    <td><small>{sourceLabel(invoice)}</small></td>
  </tr>;
}

function PurchaseInvoiceTableSkeleton() {
  return <>{Array.from({ length: 7 }, (_, index) => <tr className="table-skeleton" key={index}>{Array.from({ length: 8 }, (_, cellIndex) => <td key={cellIndex}><span /></td>)}</tr>)}</>;
}

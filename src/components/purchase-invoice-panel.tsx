"use client";

import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import {
  CaretLeft,
  CaretRight,
  CheckCircle,
  FileText,
  MagnifyingGlass,
  Trash,
  WarningCircle,
  X,
} from "@phosphor-icons/react";
import type { AppRole } from "@/lib/app-auth";
import { isValidTaxCode, normalizeTaxCode } from "@/lib/tax-code";
import PurchaseInvoiceExcelImportModal, {
  type PurchaseInvoiceImportSummary,
} from "@/components/purchase-invoice-excel-import-modal";
import VietnameseDatePicker from "@/components/purchase-date-picker";

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
  goods_services: string | null;
  net_amount: number | string | null;
  deductible_vat_amount: number | string | null;
  accounting_voucher: string | null;
  accounting_date: string | null;
  tax_rate: string | null;
  description: string | null;
  department_code: string | null;
  source_sheet: string | null;
  source_row: number | null;
  source_stt: number | null;
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
  const [detailInvoice, setDetailInvoice] = useState<PurchaseInvoiceRecord | null>(null);
  const [deleteInvoiceTarget, setDeleteInvoiceTarget] = useState<PurchaseInvoiceRecord | null>(null);
  const [isDeletingInvoice, setIsDeletingInvoice] = useState(false);
  const [deleteInvoiceError, setDeleteInvoiceError] = useState<string | null>(null);
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

  useEffect(() => {
    if (!detailInvoice) return;

    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setDetailInvoice(null);
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [detailInvoice]);

  const pageLabel = useMemo(() => {
    if (!total) return "Hiển thị 0-0/0 hóa đơn";
    const start = (page - 1) * PAGE_SIZE + 1;
    const end = Math.min(page * PAGE_SIZE, total);
    return `Hiển thị ${formatCount(start)}-${formatCount(end)}/${formatCount(total)} hóa đơn`;
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

  function openDeleteInvoiceDialog(invoice: PurchaseInvoiceRecord) {
    if (!canWrite) return;
    setDetailInvoice(null);
    setDeleteInvoiceTarget(invoice);
    setDeleteInvoiceError(null);
  }

  async function deletePurchaseInvoice() {
    if (!canWrite || !deleteInvoiceTarget || isDeletingInvoice) return;

    setIsDeletingInvoice(true);
    setDeleteInvoiceError(null);
    try {
      const response = await fetch(`/api/purchase-invoices/${encodeURIComponent(deleteInvoiceTarget.id)}`, {
        method: "DELETE",
      });
      const payload = await response.json().catch(() => ({})) as { error?: string; message?: string };
      if (!response.ok) throw new Error(payload.error ?? "Không thể xóa dòng hóa đơn.");

      const deletedInvoiceNumber = deleteInvoiceTarget.invoice_number ?? "đã chọn";
      const nextTotal = Math.max(0, total - 1);
      const nextPage = Math.min(page, Math.max(1, Math.ceil(nextTotal / PAGE_SIZE)));
      setDeleteInvoiceTarget(null);
      setPage(nextPage);
      setNotice(payload.message ?? `Đã xóa dòng hóa đơn ${deletedInvoiceNumber}.`);
      await loadPurchases(undefined, nextPage);
    } catch (deleteError) {
      setDeleteInvoiceError(deleteError instanceof Error ? deleteError.message : "Không thể xóa dòng hóa đơn.");
    } finally {
      setIsDeletingInvoice(false);
    }
  }

  return <section className="invoice-page purchase-invoice-page">
    <div className="page-heading-row purchase-page-heading-row">
      <h1>Mua vào</h1>
      {canWrite ? <div className="heading-actions"><button className="outline-button" type="button" onClick={() => { setError(null); setShowImportModal(true); }}><FileText size={17} /> Nhập Excel</button></div> : null}
    </div>

    {notice ? <div className="page-notice page-notice-success" role="status"><CheckCircle size={18} /> {notice}</div> : null}
    {error ? <div className="invoice-alert" role="alert"><WarningCircle size={18} /> {error}</div> : null}

    <section className="table-section invoice-table-section purchase-invoice-table-section">
      <div className="table-toolbar">
        <div><h2>Danh sách hóa đơn mua vào</h2><span>{pageLabel}</span></div>
        <div className="toolbar-tools purchase-toolbar-tools">
          <label className="table-search"><MagnifyingGlass size={16} /><input value={query} onChange={(event) => updateQuery(event.target.value)} placeholder="Tìm số HĐ, nhà cung cấp, MST..." aria-label="Tìm hóa đơn mua vào" /><button type="button" title="Xóa tìm kiếm" aria-label="Xóa tìm kiếm" disabled={!query} onClick={() => updateQuery("")}><X size={15} /></button></label>
          <div className="purchase-date-range" role="group" aria-label="Lọc theo ngày phát hành hóa đơn">
            <VietnameseDatePicker label="Từ ngày" value={dateFrom} max={dateTo || undefined} onChange={updateDateFrom} />
            <VietnameseDatePicker label="Đến ngày" value={dateTo} min={dateFrom || undefined} onChange={updateDateTo} />
          </div>
        </div>
      </div>
      <div className="table-scroll">
        <table className="data-table invoice-data-table purchase-invoice-data-table">
          <thead><tr><th>Ngày HĐ</th><th>Số hóa đơn</th><th>Nhà cung cấp / MST</th><th>Mặt hàng / HHDV</th><th>Giá trị HHDV</th><th>VAT được khấu trừ</th><th>Mã bộ phận</th></tr></thead>
          <tbody>
            {isLoading ? <PurchaseInvoiceTableSkeleton /> : rows.length === 0 ? <tr><td colSpan={7}><div className="table-empty"><FileText size={26} /><strong>Chưa có hóa đơn mua vào</strong><span>{canWrite ? "Nhấn Nhập Excel để thêm danh sách hóa đơn từ workbook." : "Chưa có dữ liệu hóa đơn mua vào để hiển thị."}</span></div></td></tr> : rows.map((invoice) => <PurchaseInvoiceTableRow key={invoice.id} invoice={invoice} onViewDetail={setDetailInvoice} />)}
          </tbody>
        </table>
      </div>
      <div className="table-footer"><span>{PAGE_SIZE} dòng/trang</span><div className="pagination-controls" aria-label="Phân trang hóa đơn mua vào"><button className="pagination-button" type="button" onClick={() => setPage((current) => Math.max(1, current - 1))} disabled={page <= 1}><CaretLeft size={16} /></button><span>Trang {page} / {totalPages}</span><button className="pagination-button" type="button" onClick={() => setPage((current) => Math.min(totalPages, current + 1))} disabled={page >= totalPages}><CaretRight size={16} /></button></div></div>
    </section>

    {canWrite && showImportModal ? <PurchaseInvoiceExcelImportModal onClose={() => setShowImportModal(false)} onCompleted={handleImportCompleted} /> : null}
    {detailInvoice ? <PurchaseInvoiceDetailDialog invoice={detailInvoice} canDelete={canWrite} onClose={() => setDetailInvoice(null)} onRequestDelete={() => openDeleteInvoiceDialog(detailInvoice)} /> : null}
    {deleteInvoiceTarget ? <PurchaseInvoiceDeleteDialog invoice={deleteInvoiceTarget} isDeleting={isDeletingInvoice} error={deleteInvoiceError} onClose={() => { if (!isDeletingInvoice) { setDeleteInvoiceTarget(null); setDeleteInvoiceError(null); } }} onConfirm={() => void deletePurchaseInvoice()} /> : null}
  </section>;
}

function PurchaseInvoiceTableRow({ invoice, onViewDetail }: { invoice: PurchaseInvoiceRecord; onViewDetail: (invoice: PurchaseInvoiceRecord) => void }) {
  const taxpayerStatus = taxpayerStatusMeta(invoice);
  const taxCode = invoice.seller_tax_code?.trim() ? normalizeTaxCode(invoice.seller_tax_code) : null;

  function openDetail() {
    onViewDetail(invoice);
  }

  return <tr
    className="data-row invoice-data-row purchase-invoice-row"
    tabIndex={0}
    role="button"
    aria-label={`Xem chi tiết hóa đơn ${invoice.invoice_number ?? "chưa có số hóa đơn"}`}
    aria-haspopup="dialog"
    title="Chọn dòng để xem chi tiết"
    onClick={openDetail}
    onKeyDown={(event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      openDetail();
    }}
  >
    <td className="amount-cell">{formatVietnameseDate(invoice.invoice_issue_date)}</td>
    <td className="purchase-invoice-number-cell"><strong>{invoice.invoice_number ?? "—"}</strong></td>
    <td className="purchase-seller-cell"><strong>{invoice.seller_name ?? invoice.seller_taxpayer?.name ?? "Chưa có tên người bán"}</strong><div className="invoice-seller-tax"><small className="mono-value">{taxCode ?? "Chưa có MST"}</small><span className={taxpayerStatus.className} title={taxpayerStatus.title}>{taxpayerStatus.label}</span></div></td>
    <td className="purchase-goods-cell" title={invoice.goods_services ?? undefined}><span>{invoice.goods_services ?? "—"}</span></td>
    <td className="amount-cell">{formatAmount(invoice.net_amount)}</td>
    <td className="amount-cell">{formatAmount(invoice.deductible_vat_amount)}</td>
    <td className="purchase-department-cell"><span className="mono-value">{invoice.department_code ?? "—"}</span></td>
  </tr>;
}

function PurchaseInvoiceTableSkeleton() {
  return <>{Array.from({ length: 7 }, (_, index) => <tr className="table-skeleton" key={index}>{Array.from({ length: 7 }, (_, cellIndex) => <td key={cellIndex}><span /></td>)}</tr>)}</>;
}

function PurchaseInvoiceDetailDialog({ invoice, canDelete, onClose, onRequestDelete }: { invoice: PurchaseInvoiceRecord; canDelete: boolean; onClose: () => void; onRequestDelete: () => void }) {
  const taxpayerStatus = taxpayerStatusMeta(invoice);
  const taxCode = invoice.seller_tax_code?.trim() ? normalizeTaxCode(invoice.seller_tax_code) : "";

  return <div className="confirm-backdrop">
    <section className="confirm-dialog purchase-invoice-detail-dialog" role="dialog" aria-modal="true" aria-labelledby="purchase-invoice-detail-title" aria-describedby="purchase-invoice-detail-description">
      <div className="purchase-invoice-detail-heading">
        <div className="confirm-dialog-icon purchase-invoice-detail-icon"><FileText size={22} weight="duotone" /></div>
        <button className="icon-button" type="button" aria-label="Đóng chi tiết hóa đơn mua vào" onClick={onClose}><X size={17} /></button>
      </div>
      <h2 id="purchase-invoice-detail-title">Chi tiết hóa đơn mua vào</h2>
      <p id="purchase-invoice-detail-description">Thông tin được lưu nguyên theo từng dòng hạch toán trong file Excel.</p>
      <dl className="purchase-invoice-detail-grid">
        <PurchaseInvoiceDetailField label="Số hóa đơn" value={invoice.invoice_number} mono />
        <PurchaseInvoiceDetailField label="Ngày phát hành" value={formatVietnameseDate(invoice.invoice_issue_date)} />
        <PurchaseInvoiceDetailField label="Mẫu số" value={invoice.invoice_template_number} mono />
        <PurchaseInvoiceDetailField label="Ký hiệu" value={invoice.invoice_symbol} mono />
        <PurchaseInvoiceDetailField label="Người bán" value={invoice.seller_name ?? invoice.seller_taxpayer?.name} wide />
        <PurchaseInvoiceDetailField label="MST người bán" value={taxCode || invoice.seller_tax_code} mono />
        <PurchaseInvoiceDetailField label="Tình trạng MST" value={<span className={taxpayerStatus.className} title={taxpayerStatus.title}>{taxpayerStatus.label}</span>} />
        <PurchaseInvoiceDetailField label="Mặt hàng / HHDV" value={invoice.goods_services} wide />
        <PurchaseInvoiceDetailField label="Giá trị HHDV chưa thuế" value={formatAmount(invoice.net_amount)} />
        <PurchaseInvoiceDetailField label="VAT được khấu trừ" value={formatAmount(invoice.deductible_vat_amount)} />
        <PurchaseInvoiceDetailField label="Chứng từ hạch toán" value={invoice.accounting_voucher} mono />
        <PurchaseInvoiceDetailField label="Ngày hạch toán" value={formatVietnameseDate(invoice.accounting_date)} />
        <PurchaseInvoiceDetailField label="Thuế suất" value={invoice.tax_rate} />
        <PurchaseInvoiceDetailField label="Mã bộ phận" value={invoice.department_code} mono />
        <PurchaseInvoiceDetailField label="Diễn giải" value={invoice.description} wide />
        <PurchaseInvoiceDetailField label="Nguồn Excel" value={sourceLabel(invoice)} />
        <PurchaseInvoiceDetailField label="STT gốc trong sheet" value={invoice.source_stt == null ? null : String(invoice.source_stt)} />
      </dl>
      <div className="confirm-actions purchase-invoice-detail-actions">{canDelete ? <button className="danger-button" type="button" onClick={onRequestDelete}><Trash size={16} /> Xóa dòng này</button> : null}<button className="outline-button" type="button" onClick={onClose}>Đóng</button></div>
    </section>
  </div>;
}

function PurchaseInvoiceDeleteDialog({ invoice, isDeleting, error, onClose, onConfirm }: { invoice: PurchaseInvoiceRecord; isDeleting: boolean; error: string | null; onClose: () => void; onConfirm: () => void }) {
  const invoiceNumber = invoice.invoice_number ?? "chưa có số hóa đơn";

  return <div className="confirm-backdrop">
    <section className="confirm-dialog" role="dialog" aria-modal="true" aria-labelledby="delete-purchase-invoice-title" aria-describedby="delete-purchase-invoice-description">
      <div className="confirm-dialog-icon"><WarningCircle size={23} weight="duotone" /></div>
      <h2 id="delete-purchase-invoice-title">Xóa dòng hóa đơn?</h2>
      <p id="delete-purchase-invoice-description">Hóa đơn <strong>{invoiceNumber}</strong>{invoice.seller_name ? ` của ${invoice.seller_name}` : ""} sẽ bị xóa khỏi bảng tổng hợp. Chỉ dòng hạch toán đang chọn bị xóa; các dòng khác của cùng hóa đơn vẫn được giữ. Thao tác này không thể hoàn tác.</p>
      {error ? <div className="confirm-error" role="alert"><WarningCircle size={16} /> {error}</div> : null}
      <div className="confirm-actions"><button className="outline-button" type="button" disabled={isDeleting} onClick={onClose}>Hủy</button><button className="danger-button" type="button" disabled={isDeleting} onClick={onConfirm}>{isDeleting ? "Đang xóa..." : "Xóa dòng hóa đơn"}</button></div>
    </section>
  </div>;
}

function PurchaseInvoiceDetailField({ label, value, wide = false, mono = false }: { label: string; value: ReactNode | null | undefined; wide?: boolean; mono?: boolean }) {
  return <div className={"purchase-invoice-detail-field" + (wide ? " purchase-invoice-detail-field-wide" : "")}>
    <dt>{label}</dt>
    <dd className={mono ? "mono-value" : undefined}>{value || "—"}</dd>
  </div>;
}

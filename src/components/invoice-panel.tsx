"use client";

import { memo, type ChangeEvent, type DragEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowsClockwise,
  CaretLeft,
  CaretRight,
  CheckCircle,
  FileText,
  MagnifyingGlass,
  Receipt,
  ShieldCheck,
  UploadSimple,
  WarningCircle,
  X,
} from "@phosphor-icons/react";
import type { InvoiceQuota, InvoiceRecord, InvoiceVerificationStatus } from "@/lib/invoice-types";

const MAX_UPLOAD_BYTES = 4 * 1024 * 1024;
const PAGE_SIZE = 100;

type InvoiceListResponse = {
  rows?: InvoiceRecord[];
  total?: number;
  page?: number;
  pageSize?: number;
  totalPages?: number;
  usage?: InvoiceQuota;
  summary?: {
    total: number;
    unverified: number;
    valid: number;
    invalid: number;
    error: number;
  };
  error?: string;
};

type VerificationFields = {
  sellerTaxCode: string;
  templateNumber: string;
  symbol: string;
  invoiceNumber: string;
  taxAmount: number | string | null;
  totalAmount: number | string | null;
};

type VerificationState = {
  invoice: InvoiceRecord;
  invoiceId: string;
  challengeId: string;
  captchaDataUrl: string;
  fields: VerificationFields;
  captcha: string;
  error: string | null;
  isSubmitting: boolean;
};

const statusMeta: Record<InvoiceVerificationStatus, { label: string; className: string }> = {
  unverified: { label: "Chưa xác minh", className: "invoice-status invoice-status-unverified" },
  valid: { label: "Hợp lệ", className: "invoice-status invoice-status-valid" },
  invalid: { label: "Không hợp lệ", className: "invoice-status invoice-status-invalid" },
  error: { label: "Lỗi đối chiếu", className: "invoice-status invoice-status-error" },
};

function formatAmount(value: number | string | null) {
  if (value === null || value === "") return "—";
  const numberValue = Number(value);
  if (!Number.isFinite(numberValue)) return String(value);
  return new Intl.NumberFormat("vi-VN", {
    style: "currency",
    currency: "VND",
    maximumFractionDigits: 2,
  }).format(numberValue);
}

function formatDate(value: string | null) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("vi-VN", { dateStyle: "short", timeStyle: "short" }).format(date);
}

function formatFileSize(value: number) {
  if (value < 1024 * 1024) return Math.ceil(value / 1024) + " KB";
  return (value / (1024 * 1024)).toFixed(2) + " MB";
}

function effectiveInvoiceIdentity(invoice: Pick<InvoiceRecord, "invoice_template_number" | "invoice_symbol">) {
  const storedTemplate = invoice.invoice_template_number?.trim();
  const rawSymbol = invoice.invoice_symbol?.replace(/\s+/g, "").trim().toLocaleUpperCase("vi-VN") ?? "";
  const combinedMatch = rawSymbol.match(/^([1-9])([A-Z]\d{2}[A-Z0-9]{3})$/u);
  if (combinedMatch && (!storedTemplate || storedTemplate === combinedMatch[1])) {
    return { templateNumber: storedTemplate ?? combinedMatch[1], symbol: combinedMatch[2] };
  }
  return {
    templateNumber: storedTemplate && !/^(?:—|-|null)$/i.test(storedTemplate) ? storedTemplate : null,
    symbol: rawSymbol || null,
  };
}

function statusLabel(status: InvoiceVerificationStatus) {
  return statusMeta[status] ?? statusMeta.unverified;
}

function patchRows(current: InvoiceRecord[], nextInvoice: InvoiceRecord) {
  return current.map((row) => row.id === nextInvoice.id ? nextInvoice : row);
}

export default function InvoicePanel() {
  const [rows, setRows] = useState<InvoiceRecord[]>([]);
  const [total, setTotal] = useState(0);
  const [totalPages, setTotalPages] = useState(1);
  const [summary, setSummary] = useState({ total: 0, unverified: 0, valid: 0, invalid: 0, error: 0 });
  const [usage, setUsage] = useState<InvoiceQuota>({ used: 0, limit: 200, remaining: 200 });
  const [page, setPage] = useState(1);
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [isLoading, setIsLoading] = useState(true);
  const [isImporting, setIsImporting] = useState(false);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [verification, setVerification] = useState<VerificationState | null>(null);
  const [isStartingVerification, setIsStartingVerification] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const verificationIdRef = useRef<string | null>(null);

  const loadInvoices = useCallback(async (signal?: AbortSignal) => {
    setIsLoading(true);
    try {
      const params = new URLSearchParams({
        page: String(page),
        status: statusFilter,
      });
      if (query.trim()) params.set("q", query.trim());
      const response = await fetch("/api/invoices?" + params.toString(), { cache: "no-store", signal });
      const payload = await response.json() as InvoiceListResponse;
      if (!response.ok) throw new Error(payload.error ?? "Không thể tải danh sách hóa đơn.");
      setRows(payload.rows ?? []);
      setTotal(payload.total ?? 0);
      setTotalPages(payload.totalPages ?? 1);
      setUsage(payload.usage ?? { used: 0, limit: 200, remaining: 200 });
      setSummary(payload.summary ?? { total: payload.total ?? 0, unverified: 0, valid: 0, invalid: 0, error: 0 });
      setError(null);
    } catch (loadError) {
      if (loadError instanceof Error && loadError.name === "AbortError") return;
      setError(loadError instanceof Error ? loadError.message : "Không thể tải danh sách hóa đơn.");
    } finally {
      setIsLoading(false);
    }
  }, [page, query, statusFilter]);

  useEffect(() => {
    const controller = new AbortController();
    void loadInvoices(controller.signal);
    return () => controller.abort();
  }, [loadInvoices]);

  useEffect(() => {
    if (!notice) return;
    const timeout = window.setTimeout(() => setNotice(null), 4500);
    return () => window.clearTimeout(timeout);
  }, [notice]);

  const selectFile = useCallback((file: File | null) => {
    if (!file) return;
    if (file.size > MAX_UPLOAD_BYTES) {
      setSelectedFile(null);
      setError("File vượt quá giới hạn 4 MiB (4.194.304 bytes).");
      return;
    }
    setError(null);
    setSelectedFile(file);
  }, []);

  function onFileInput(event: ChangeEvent<HTMLInputElement>) {
    selectFile(event.target.files?.[0] ?? null);
  }

  function onDrop(event: DragEvent<HTMLButtonElement>) {
    event.preventDefault();
    setIsDragging(false);
    selectFile(event.dataTransfer.files?.[0] ?? null);
  }

  async function importFile() {
    if (!selectedFile || isImporting) return;
    setIsImporting(true);
    setError(null);
    setNotice(null);
    try {
      const formData = new FormData();
      formData.append("file", selectedFile);
      const response = await fetch("/api/invoices/import", { method: "POST", body: formData });
      const payload = await response.json() as InvoiceListResponse & { invoice?: InvoiceRecord; invoiceNumber?: string; invoiceExists?: boolean };
      if (!response.ok) {
        if (response.status === 409 || payload.invoiceExists) {
          throw new Error("Hóa đơn đã tồn tại" + (payload.invoiceNumber ? ": " + payload.invoiceNumber : "."));
        }
        throw new Error(payload.error ?? "Không thể import hóa đơn.");
      }
      setSelectedFile(null);
      if (fileInputRef.current) fileInputRef.current.value = "";
      setPage(1);
      setNotice("Đã trích xuất và lưu hóa đơn " + (payload.invoice?.invoice_number ?? "") + ".");
      await loadInvoices();
    } catch (importError) {
      setError(importError instanceof Error ? importError.message : "Không thể import hóa đơn.");
    } finally {
      setIsImporting(false);
    }
  }

  const beginVerification = useCallback(async (invoice: InvoiceRecord) => {
    if (verificationIdRef.current || isStartingVerification) return;
    verificationIdRef.current = invoice.id;
    setIsStartingVerification(true);
    setError(null);
    try {
      const response = await fetch("/api/invoices/" + invoice.id + "/verify", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "start" }),
      });
      const payload = await response.json() as {
        error?: string;
        challengeId?: string;
        captchaDataUrl?: string;
        fields?: VerificationFields;
      };
      if (!response.ok) throw new Error(payload.error ?? "Không thể mở phiên CAPTCHA.");
      if (!payload.challengeId || !payload.captchaDataUrl || !payload.fields) throw new Error("Cục Thuế chưa trả về CAPTCHA.");
      setVerification({
        invoice,
        invoiceId: invoice.id,
        challengeId: payload.challengeId,
        captchaDataUrl: payload.captchaDataUrl,
        fields: payload.fields,
        captcha: "",
        error: null,
        isSubmitting: false,
      });
    } catch (verificationError) {
      verificationIdRef.current = null;
      setError(verificationError instanceof Error ? verificationError.message : "Không thể mở phiên CAPTCHA.");
    } finally {
      setIsStartingVerification(false);
    }
  }, [isStartingVerification]);

  const patchInvoice = useCallback((invoice: InvoiceRecord) => {
    setRows((current) => patchRows(current, invoice));
    setSummary((current) => {
      const previous = rows.find((row) => row.id === invoice.id);
      if (!previous || previous.verification_status === invoice.verification_status) return current;
      const next = { ...current };
      next[previous.verification_status] = Math.max(0, next[previous.verification_status] - 1);
      next[invoice.verification_status] += 1;
      return next;
    });
  }, [rows]);

  async function submitVerification() {
    if (!verification || verification.isSubmitting) return;
    const current = verification;
    if (!current.captcha.trim()) {
      setVerification((state) => state ? { ...state, error: "Vui lòng nhập mã CAPTCHA." } : state);
      return;
    }

    setVerification((state) => state ? { ...state, error: null, isSubmitting: true } : state);
    try {
      const response = await fetch("/api/invoices/" + current.invoiceId + "/verify", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "submit", challengeId: current.challengeId, captcha: current.captcha }),
      });
      const payload = await response.json() as {
        error?: string;
        captchaDataUrl?: string;
        invoice?: InvoiceRecord;
      };
      if (payload.invoice) patchInvoice(payload.invoice);
      if (!response.ok) {
        if (payload.captchaDataUrl) {
          setVerification((state) => state ? {
            ...state,
            captchaDataUrl: payload.captchaDataUrl ?? state.captchaDataUrl,
            captcha: "",
            error: payload.error ?? "Mã CAPTCHA chưa đúng.",
            isSubmitting: false,
          } : state);
          return;
        }
        throw new Error(payload.error ?? "Không thể đối chiếu hóa đơn.");
      }
      verificationIdRef.current = null;
      setVerification(null);
      setNotice(payload.invoice?.verification_message ?? "Đã cập nhật tình trạng hóa đơn.");
    } catch (submitError) {
      setVerification((state) => state ? {
        ...state,
        error: submitError instanceof Error ? submitError.message : "Không thể đối chiếu hóa đơn.",
        isSubmitting: false,
      } : state);
    }
  }

  function closeVerification() {
    if (verification?.isSubmitting) return;
    verificationIdRef.current = null;
    setVerification(null);
  }

  const pageLabel = useMemo(() => {
    if (!total) return "0 dòng";
    const start = (page - 1) * PAGE_SIZE + 1;
    const end = Math.min(page * PAGE_SIZE, total);
    return "Hiển thị " + start + "-" + end + " / " + total + " dòng";
  }, [page, total]);

  return <section className="invoice-page">
    <div className="invoice-intro">
      <div>
        <span className="invoice-eyebrow">HÓA ĐƠN ĐIỆN TỬ</span>
        <h2>Kiểm tra và đối chiếu hóa đơn</h2>
        <p>Import PDF, XML hoặc hình ảnh để trích xuất thông tin. Mỗi số hóa đơn chỉ lưu một lần.</p>
      </div>
      <div className="invoice-quota">
        <span>Hạn mức quét tháng này</span>
        <strong>{usage.used.toLocaleString("vi-VN")} / {usage.limit.toLocaleString("vi-VN")}</strong>
        <small>Còn {usage.remaining.toLocaleString("vi-VN")} lượt</small>
      </div>
    </div>

    <div className="invoice-summary-grid">
      <InvoiceMetric label="Tổng hóa đơn" value={summary.total} tone="blue" />
      <InvoiceMetric label="Chưa xác minh" value={summary.unverified} tone="orange" />
      <InvoiceMetric label="Hợp lệ" value={summary.valid} tone="green" />
      <InvoiceMetric label="Không hợp lệ" value={summary.invalid} tone="red" />
    </div>

    <section className="invoice-import-card">
      <div className="invoice-import-heading">
        <div><strong>Import hóa đơn</strong><span>Giới hạn mỗi file: 4 MiB · Định dạng: PDF, XML, JPG/JPEG, PNG, WEBP, GIF</span></div>
        <Receipt size={24} weight="duotone" />
      </div>
      <button
        className={isDragging ? "invoice-dropzone invoice-dropzone-active" : "invoice-dropzone"}
        type="button"
        onClick={() => fileInputRef.current?.click()}
        onDragOver={(event) => { event.preventDefault(); setIsDragging(true); }}
        onDragLeave={() => setIsDragging(false)}
        onDrop={onDrop}
        aria-label="Chọn file hóa đơn"
      >
        <UploadSimple size={28} weight="duotone" />
        <strong>{selectedFile ? selectedFile.name : "Kéo thả file vào đây hoặc bấm để chọn"}</strong>
        <span>{selectedFile ? formatFileSize(selectedFile.size) + " · Sẵn sàng trích xuất" : "Hệ thống sẽ đọc nội dung và lưu thông tin vào cơ sở dữ liệu"}</span>
      </button>
      <input ref={fileInputRef} className="invoice-hidden-file-input" type="file" accept=".pdf,.xml,.jpg,.jpeg,.png,.webp,.gif,application/pdf,application/xml,text/xml,image/*" onChange={onFileInput} />
      <div className="invoice-import-actions">
        {selectedFile ? <button className="outline-button" type="button" onClick={() => { setSelectedFile(null); if (fileInputRef.current) fileInputRef.current.value = ""; }}>Bỏ chọn</button> : null}
        <button className="export-button" type="button" disabled={!selectedFile || isImporting || usage.remaining <= 0} onClick={() => void importFile()}>
          <ArrowsClockwise size={16} className={isImporting ? "update-icon-spinning" : ""} /> {isImporting ? "Đang trích xuất..." : "Trích xuất và lưu"}
        </button>
      </div>
    </section>

    {notice ? <div className="page-notice page-notice-success" role="status"><CheckCircle size={18} /> {notice}</div> : null}
    {error ? <div className="invoice-alert" role="alert"><WarningCircle size={18} /> {error}</div> : null}

    <section className="table-section invoice-table-section">
      <div className="table-toolbar">
        <div><h2>Bảng tổng hợp hóa đơn</h2><span>{pageLabel}</span></div>
        <div className="toolbar-tools">
          <label className="table-search"><MagnifyingGlass size={16} /><input value={query} onChange={(event) => { setPage(1); setQuery(event.target.value); }} placeholder="Tìm số hóa đơn, MST..." aria-label="Tìm hóa đơn" /><button type="button" title="Xóa tìm kiếm" aria-label="Xóa tìm kiếm" disabled={!query} onClick={() => { setPage(1); setQuery(""); }}><X size={15} /></button></label>
          <select className="filter-select" value={statusFilter} onChange={(event) => { setPage(1); setStatusFilter(event.target.value); }} aria-label="Lọc tình trạng hóa đơn">
            <option value="all">Tất cả</option>
            <option value="unverified">Chưa xác minh</option>
            <option value="valid">Hợp lệ</option>
            <option value="invalid">Không hợp lệ</option>
            <option value="error">Lỗi đối chiếu</option>
          </select>
        </div>
      </div>
      <div className="table-scroll">
        <table className="data-table invoice-data-table">
          <thead><tr><th>Số hóa đơn</th><th>Nhà cung cấp / MST</th><th>Ký hiệu · Mẫu số</th><th>Tiền thuế</th><th>Tổng tiền</th><th>Tình trạng</th><th>Import lúc</th></tr></thead>
          <tbody>
            {isLoading ? <InvoiceTableSkeleton /> : rows.length === 0 ? <tr><td colSpan={7}><div className="table-empty"><FileText size={26} /><strong>Chưa có hóa đơn</strong><span>Chọn file ở khu vực import để bắt đầu trích xuất.</span></div></td></tr> : rows.map((invoice) => <InvoiceTableRow key={invoice.id} invoice={invoice} isBusy={verificationIdRef.current === invoice.id || isStartingVerification} onVerify={beginVerification} />)}
          </tbody>
        </table>
      </div>
      <div className="table-footer"><span>{PAGE_SIZE} dòng/trang</span><div className="pagination-controls" aria-label="Phân trang hóa đơn"><button className="pagination-button" type="button" onClick={() => setPage((value) => Math.max(1, value - 1))} disabled={page <= 1}><CaretLeft size={16} /></button><span>Trang {page} / {totalPages}</span><button className="pagination-button" type="button" onClick={() => setPage((value) => Math.min(totalPages, value + 1))} disabled={page >= totalPages}><CaretRight size={16} /></button></div></div>
    </section>

    {verification ? <InvoiceVerificationDialog state={verification} onChange={setVerification} onClose={closeVerification} onRefresh={() => { const invoice = verification.invoice; verificationIdRef.current = null; setVerification(null); void beginVerification(invoice); }} onSubmit={() => void submitVerification()} /> : null}
  </section>;
}

function InvoiceMetric({ label, value, tone }: { label: string; value: number; tone: "blue" | "orange" | "green" | "red" }) {
  return <div className={"invoice-metric invoice-metric-" + tone}><span>{label}</span><strong>{value.toLocaleString("vi-VN")}</strong></div>;
}

type InvoiceTableRowProps = {
  invoice: InvoiceRecord;
  isBusy: boolean;
  onVerify: (invoice: InvoiceRecord) => void;
};

const InvoiceTableRow = memo(function InvoiceTableRow({ invoice, isBusy, onVerify }: InvoiceTableRowProps) {
  const status = statusLabel(invoice.verification_status);
  const identity = effectiveInvoiceIdentity(invoice);
  const canVerify = Boolean(invoice.seller_tax_code && identity.templateNumber && identity.symbol && invoice.invoice_number);
  return <tr className="data-row invoice-data-row">
    <td className="invoice-number-cell">
      <div className="invoice-number-action"><strong>{invoice.invoice_number}</strong><button className="invoice-verify-button" type="button" disabled={!canVerify || isBusy} title={canVerify ? "Đối chiếu với Cục Thuế" : "Thiếu MST, mẫu số/ký hiệu hoặc số hóa đơn"} onClick={() => onVerify(invoice)}><ShieldCheck size={15} /> {isBusy ? "Đang mở" : "Đối chiếu"}</button></div>
      {invoice.verification_message ? <small title={invoice.verification_message}>{invoice.verification_message}</small> : null}
    </td>
    <td><strong>{invoice.seller_name ?? "Chưa có tên"}</strong><small className="mono-value">{invoice.seller_tax_code ?? "Chưa có MST"}</small></td>
    <td><span>{identity.templateNumber && identity.symbol ? identity.templateNumber + identity.symbol : identity.symbol ?? "—"}</span><small>Mẫu {identity.templateNumber ?? "—"} · Ký hiệu {identity.symbol ?? "—"}</small></td>
    <td className="amount-cell">{formatAmount(invoice.tax_amount)}</td>
    <td className="amount-cell">{formatAmount(invoice.total_amount)}</td>
    <td><span className={status.className}>{status.label}</span></td>
    <td className="date-cell">{formatDate(invoice.created_at)}<small>{invoice.source_file_name}</small></td>
  </tr>;
});

function InvoiceTableSkeleton() {
  return <>{[1, 2, 3, 4].map((row) => <tr className="skeleton-row" key={row}>{[1, 2, 3, 4, 5, 6, 7].map((cell) => <td key={cell}><span /></td>)}</tr>)}</>;
}

function InvoiceVerificationDialog({
  state,
  onChange,
  onClose,
  onRefresh,
  onSubmit,
}: {
  state: VerificationState;
  onChange: (state: VerificationState | null) => void;
  onClose: () => void;
  onRefresh: () => void;
  onSubmit: () => void;
}) {
  const setField = (field: "captcha", value: string) => onChange({ ...state, [field]: value, error: null });
  return <div className="confirm-backdrop">
    <section className="confirm-dialog invoice-verification-dialog" role="dialog" aria-modal="true" aria-labelledby="invoice-verification-title">
      <div className="manual-lookup-heading"><div className="confirm-dialog-icon manual-lookup-icon"><ShieldCheck size={22} weight="duotone" /></div><button className="icon-button" type="button" aria-label="Đóng xác minh hóa đơn" disabled={state.isSubmitting} onClick={onClose}><X size={17} /></button></div>
      <h2 id="invoice-verification-title">Đối chiếu hóa đơn với Cục Thuế</h2>
      <p>Hệ thống đã điền sẵn thông tin tra cứu. Bạn chỉ cần nhập CAPTCHA trong ảnh rồi bấm đối chiếu.</p>
      <div className="invoice-prefill-grid">
        <InvoicePrefill label="MST người bán" value={state.fields.sellerTaxCode} mono />
        <InvoicePrefill label="Mẫu số" value={state.fields.templateNumber} />
        <InvoicePrefill label="Ký hiệu" value={state.fields.symbol} />
        <InvoicePrefill label="Số hóa đơn" value={state.fields.invoiceNumber} mono />
        <InvoicePrefill label="Tiền thuế" value={formatAmount(state.fields.taxAmount)} />
        <InvoicePrefill label="Tổng tiền" value={formatAmount(state.fields.totalAmount)} />
      </div>
      <div className="manual-captcha-box invoice-captcha-box"><img src={state.captchaDataUrl} alt="Mã CAPTCHA từ trang tra cứu hóa đơn Cục Thuế" /><button className="outline-button" type="button" disabled={state.isSubmitting} onClick={onRefresh}><ArrowsClockwise size={15} /> Mã khác</button></div>
      <label className="manual-captcha-input"><span>Mã xác nhận CAPTCHA</span><input value={state.captcha} onChange={(event) => setField("captcha", event.target.value)} disabled={state.isSubmitting} autoComplete="off" autoFocus maxLength={10} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); onSubmit(); } }} /></label>
      {state.error ? <div className="confirm-error"><WarningCircle size={16} /> {state.error}</div> : null}
      <p className="invoice-tax-note">Kết quả được gửi trực tiếp tới trang tra cứu hóa đơn điện tử của Tổng cục Thuế và lưu lại cho đúng dòng hóa đơn này.</p>
      <div className="confirm-actions"><button className="outline-button" type="button" disabled={state.isSubmitting} onClick={onClose}>Hủy</button><button className="export-button" type="button" disabled={state.isSubmitting} onClick={onSubmit}>{state.isSubmitting ? "Đang đối chiếu..." : "Đối chiếu"}</button></div>
    </section>
  </div>;
}

function InvoicePrefill({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return <div className="invoice-prefill"><span>{label}</span><strong className={mono ? "mono-value" : ""}>{value || "—"}</strong></div>;
}

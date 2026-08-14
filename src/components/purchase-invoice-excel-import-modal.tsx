"use client";

import { useRef, useState } from "react";
import {
  ArrowsClockwise,
  CheckCircle,
  FileText,
  WarningCircle,
  X,
} from "@phosphor-icons/react";

const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;
const COMMIT_BATCH_SIZE = 100;

type ImportPhase = "select" | "preview" | "committing" | "complete" | "error";

type PurchaseInvoiceCandidate = {
  row_fingerprint?: string;
  invoice_number?: string | null;
  invoice_issue_date?: string | null;
  invoice_template_number?: string | null;
  invoice_symbol?: string | null;
  seller_name?: string | null;
  seller_tax_code?: string | null;
  net_amount?: number | string | null;
  deductible_vat_amount?: number | string | null;
  source_sheet?: string | null;
  source_row?: number | null;
};

type ImportWarning = {
  sourceSheet?: string | null;
  sourceRow?: number | null;
  message?: string | null;
};

type PreviewResponse = {
  importId?: string;
  fileName?: string;
  candidates?: PurchaseInvoiceCandidate[];
  counts?: {
    totalRows?: number;
    validRows?: number;
    duplicateRows?: number;
    invalidRows?: number;
    existing?: number;
    new?: number;
  };
  warnings?: ImportWarning[];
  selectedSheet?: string;
  message?: string;
  error?: string;
};

type UploadResponse = {
  importId?: string;
  signedUrl?: string;
  error?: string;
};

type CommitResponse = {
  done?: boolean;
  nextOffset?: number;
  totalCandidates?: number;
  addedCount?: number;
  skippedCount?: number;
  failedCount?: number;
  insertedCount?: number;
  error?: string;
};

export type PurchaseInvoiceImportSummary = {
  addedCount: number;
  skippedCount: number;
  failedCount: number;
};

type Props = {
  onClose: () => void;
  onCompleted: (summary: PurchaseInvoiceImportSummary) => void;
};

function formatCount(value: number | undefined) {
  return Math.max(0, value ?? 0).toLocaleString("vi-VN");
}

function formatVietnameseDate(value: string | null | undefined) {
  if (!value) return "—";
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})/);
  return match ? `${match[3]}/${match[2]}/${match[1]}` : value;
}

function candidateLabel(candidate: PurchaseInvoiceCandidate) {
  const invoiceNumber = candidate.invoice_number?.trim() || "Chưa có số hóa đơn";
  const seller = candidate.seller_name?.trim() || candidate.seller_tax_code?.trim() || "Chưa có người bán";
  return { invoiceNumber, seller };
}

export default function PurchaseInvoiceExcelImportModal({ onClose, onCompleted }: Props) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [importId, setImportId] = useState<string | null>(null);
  const [phase, setPhase] = useState<ImportPhase>("select");
  const [isReading, setIsReading] = useState(false);
  const [preview, setPreview] = useState<PreviewResponse | null>(null);
  const [showWarnings, setShowWarnings] = useState(false);
  const [progress, setProgress] = useState({ current: 0, total: 0, added: 0, skipped: 0, failed: 0 });
  const [error, setError] = useState<string | null>(null);
  const [summary, setSummary] = useState<PurchaseInvoiceImportSummary | null>(null);

  const isBusy = phase === "committing";
  const candidates = preview?.candidates ?? [];
  const counts = preview?.counts;

  function chooseFile(nextFile: File | null) {
    setFile(nextFile);
    setImportId(null);
    setPreview(null);
    setShowWarnings(false);
    setSummary(null);
    setPhase("select");
    setError(nextFile && nextFile.size > MAX_UPLOAD_BYTES ? "File Excel phải dưới 20 MB." : null);
  }

  async function readAndFilterFile() {
    if (!file || isReading) return;
    if (file.size > MAX_UPLOAD_BYTES) {
      setError("File Excel phải dưới 20 MB.");
      return;
    }

    setIsReading(true);
    setError(null);
    try {
      const uploadResponse = await fetch("/api/purchase-invoices/import/upload", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ fileName: file.name, fileSize: file.size, contentType: file.type }),
        cache: "no-store",
      });
      const uploadPayload = await uploadResponse.json().catch(() => ({})) as UploadResponse;
      if (!uploadResponse.ok || !uploadPayload.importId || !uploadPayload.signedUrl) {
        throw new Error(uploadPayload.error ?? "Không thể chuẩn bị nơi tải file Excel lên.");
      }

      setImportId(uploadPayload.importId);
      const uploadBody = new FormData();
      uploadBody.append("cacheControl", "3600");
      uploadBody.append("", file);
      const storageResponse = await fetch(uploadPayload.signedUrl, {
        method: "PUT",
        headers: { "x-upsert": "false" },
        body: uploadBody,
      });
      if (!storageResponse.ok) throw new Error("Không thể tải file Excel lên kho lưu trữ.");

      const previewResponse = await fetch("/api/purchase-invoices/import/preview", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ importId: uploadPayload.importId }),
        cache: "no-store",
      });
      const previewPayload = await previewResponse.json().catch(() => ({})) as PreviewResponse;
      if (!previewResponse.ok) throw new Error(previewPayload.error ?? "Không thể đọc file Excel.");

      setImportId(previewPayload.importId ?? uploadPayload.importId);
      setPreview(previewPayload);
      setPhase("preview");
    } catch (readError) {
      setError(readError instanceof Error ? readError.message : "Không thể đọc file Excel.");
    } finally {
      setIsReading(false);
    }
  }

  async function startImport() {
    if (!importId || !candidates.length || isBusy) return;

    const total = candidates.length;
    let offset = 0;
    let addedCount = 0;
    let skippedCount = 0;
    let failedCount = 0;

    setError(null);
    setSummary(null);
    setProgress({ current: 0, total, added: 0, skipped: 0, failed: 0 });
    setPhase("committing");

    try {
      while (offset < total) {
        const response = await fetch("/api/purchase-invoices/import/commit", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ importId, offset }),
          cache: "no-store",
        });
        const payload = await response.json().catch(() => ({})) as CommitResponse;
        if (!response.ok) throw new Error(payload.error ?? "Không thể thêm hóa đơn từ file Excel.");

        // The API returns these counters cumulatively for the import session.
        addedCount = Math.max(addedCount, payload.addedCount ?? 0);
        skippedCount = Math.max(skippedCount, payload.skippedCount ?? 0);
        failedCount = Math.max(failedCount, payload.failedCount ?? 0);

        const nextOffset = payload.nextOffset ?? Math.min(offset + COMMIT_BATCH_SIZE, total);
        if (!payload.done && nextOffset <= offset) {
          throw new Error("Tiến trình nhập Excel không hợp lệ. Vui lòng thử lại.");
        }

        offset = Math.min(nextOffset, total);
        setProgress({
          current: offset,
          total: payload.totalCandidates ?? total,
          added: addedCount,
          skipped: skippedCount,
          failed: failedCount,
        });

        if (payload.done) break;
      }

      const completedSummary = { addedCount, skippedCount, failedCount };
      setSummary(completedSummary);
      setPhase("complete");
      onCompleted(completedSummary);
    } catch (importError) {
      setError(importError instanceof Error ? importError.message : "Không thể hoàn tất nhập Excel.");
      setPhase("error");
    }
  }

  function renderSelectStep() {
    return <>
      <p className="taxpayer-import-description" id="purchase-import-description">Chọn file Excel chứa danh sách hóa đơn mua vào. Hệ thống sẽ đọc sheet hợp lệ, lọc dòng trùng và cho bạn xem kết quả trước khi lưu.</p>
      <div className="taxpayer-import-file-picker">
        <input ref={fileInputRef} type="file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" onChange={(event) => chooseFile(event.target.files?.[0] ?? null)} />
        <FileText size={22} weight="duotone" />
        <strong>{file ? file.name : "Chưa chọn file Excel"}</strong>
        <span>{file ? `${(file.size / 1024).toFixed(1)} KiB` : "Định dạng hỗ trợ: .xlsx"}</span>
        <button className="outline-button" type="button" onClick={() => fileInputRef.current?.click()}>Chọn file</button>
      </div>
      {isReading ? <div className="taxpayer-import-uploading" role="status" aria-live="polite"><ArrowsClockwise size={17} className="update-icon-spinning" /> <span>Đang upload và đọc file Excel</span></div> : null}
      {error ? <div className="confirm-error"><WarningCircle size={16} /> {error}</div> : null}
    </>;
  }

  function renderPreviewStep() {
    const warnings = preview?.warnings ?? [];

    return <>
      <div className="taxpayer-import-summary-grid">
        <div><strong>{formatCount(counts?.new ?? candidates.length)}</strong><span>Dòng dự kiến thêm</span></div>
        <div><strong>{formatCount(counts?.existing)}</strong><span>Dòng đã có trong CSDL</span></div>
        <div><strong>{formatCount(counts?.duplicateRows)}</strong><span>Dòng trùng trong file</span></div>
        <button className={`taxpayer-import-summary-card${warnings.length ? " is-clickable" : ""}`} type="button" disabled={!warnings.length} aria-expanded={showWarnings} onClick={() => setShowWarnings((current) => !current)}>
          <strong>{formatCount(warnings.length)}</strong><span>Cảnh báo dữ liệu</span>{warnings.length ? <small>{showWarnings ? "Ẩn chi tiết" : "Xem chi tiết"}</small> : null}
        </button>
      </div>
      <div className="taxpayer-import-message" role="status"><CheckCircle size={18} /> {preview?.message ?? `Đã đọc ${formatCount(candidates.length)} dòng hóa đơn hợp lệ.`}</div>
      {preview?.selectedSheet ? <div className="taxpayer-import-template-link"><FileText size={16} /><span>Sheet được chọn: <strong>{preview.selectedSheet}</strong></span></div> : null}
      {candidates.length ? <div className="taxpayer-import-candidate-list"><strong>Một số dòng hóa đơn sẽ được lưu</strong><div className="taxpayer-import-candidate-scroll">{candidates.slice(0, 30).map((candidate, index) => {
        const label = candidateLabel(candidate);
        const source = [candidate.source_sheet, candidate.source_row ? `dòng ${candidate.source_row}` : null].filter(Boolean).join(" · ");
        return <div className="taxpayer-import-candidate-row" key={candidate.row_fingerprint ?? `${candidate.source_sheet}-${candidate.source_row}-${index}`}><span><strong>{label.invoiceNumber}</strong> · {formatVietnameseDate(candidate.invoice_issue_date)}</span><span>{label.seller}{source ? ` · ${source}` : ""}</span></div>;
      })}</div>{candidates.length > 30 ? <small>Đang hiển thị 30/{formatCount(candidates.length)} hóa đơn.</small> : null}</div> : null}
      {warnings.length ? <div className="taxpayer-import-warning"><WarningCircle size={16} /><span>File có {formatCount(warnings.length)} cảnh báo. Các dòng này vẫn được lưu nếu có dữ liệu nghiệp vụ.</span></div> : null}
      {showWarnings && warnings.length ? <div className="taxpayer-import-invalid-details"><div className="taxpayer-import-invalid-heading"><strong>Chi tiết cảnh báo dữ liệu</strong><span>Hiển thị tối đa 100 cảnh báo đầu tiên</span></div><div className="taxpayer-import-invalid-scroll">{warnings.map((warning, index) => <div className="taxpayer-import-invalid-row" key={`${warning.sourceSheet}-${warning.sourceRow}-${index}`}><span><strong>{warning.sourceSheet ?? "Sheet"}</strong> · dòng {warning.sourceRow ?? "—"}</span><span className="mono-value">Cảnh báo</span><span>{warning.message ?? "Dữ liệu cần được kiểm tra"}</span></div>)}</div></div> : null}
      {error ? <div className="confirm-error"><WarningCircle size={16} /> {error}</div> : null}
    </>;
  }

  function renderProgressStep() {
    const percent = progress.total ? Math.round(progress.current / progress.total * 100) : 0;
    return <div className="taxpayer-import-progress" role="status" aria-live="polite"><ArrowsClockwise size={30} className="update-icon-spinning" /><strong>Đang lưu {formatCount(progress.current)}/{formatCount(progress.total)} dòng hóa đơn</strong><div className="taxpayer-import-progress-track"><span style={{ width: `${percent}%` }} /></div><span>Đã thêm {formatCount(progress.added)} · bỏ qua {formatCount(progress.skipped)} · lỗi {formatCount(progress.failed)}</span></div>;
  }

  function renderCompleteStep() {
    if (!summary) return null;
    const message = summary.failedCount
      ? `Đã nhập ${formatCount(summary.addedCount)} dòng hóa đơn mua vào; bỏ qua ${formatCount(summary.skippedCount)} dòng trùng và còn ${formatCount(summary.failedCount)} dòng cần kiểm tra lại.`
      : `Đã hoàn tất nhập ${formatCount(summary.addedCount)} dòng hóa đơn mua vào. Đã bỏ qua ${formatCount(summary.skippedCount)} dòng trùng.`;
    return <div className="taxpayer-import-complete" role="status"><CheckCircle size={36} weight="duotone" /><strong>{message}</strong></div>;
  }

  return <div className="confirm-backdrop">
    <section className="confirm-dialog taxpayer-import-dialog" role="dialog" aria-modal="true" aria-labelledby="purchase-import-title" aria-describedby="purchase-import-description">
      <div className="taxpayer-import-heading"><div className="confirm-dialog-icon taxpayer-import-icon"><FileText size={22} weight="duotone" /></div><button className="icon-button" type="button" aria-label="Đóng nhập Excel mua vào" disabled={isBusy || isReading} onClick={onClose}><X size={17} /></button></div>
      <h2 id="purchase-import-title">Nhập hóa đơn mua vào từ Excel</h2>
      {phase === "select" ? renderSelectStep() : null}
      {phase === "preview" ? renderPreviewStep() : null}
      {phase === "committing" ? renderProgressStep() : null}
      {phase === "complete" ? renderCompleteStep() : null}
      {phase === "error" ? <div className="taxpayer-import-error"><WarningCircle size={30} weight="duotone" /><strong>{error ?? "Nhập Excel chưa hoàn tất."}</strong><span>Các hóa đơn đã được thêm vẫn được giữ trong cơ sở dữ liệu.</span></div> : null}
      <div className="confirm-actions">
        {isBusy || isReading ? null : <button className="outline-button" type="button" onClick={onClose}>{phase === "complete" || phase === "error" || !file ? "Đóng" : "Hủy"}</button>}
        {phase === "select" ? <button className="export-button" type="button" disabled={!file || isReading || Boolean(file && file.size > MAX_UPLOAD_BYTES)} onClick={() => void readAndFilterFile()}>{isReading ? "Đang đọc Excel" : "Đọc và lọc hóa đơn"}</button> : null}
        {phase === "preview" && candidates.length ? <button className="export-button" type="button" onClick={() => void startImport()}>Xác nhận nhập {formatCount(candidates.length)} dòng</button> : null}
      </div>
    </section>
  </div>;
}

"use client";

import { useRef, useState } from "react";
import {
  ArrowsClockwise,
  CheckCircle,
  DownloadSimple,
  FileText,
  WarningCircle,
  X,
} from "@phosphor-icons/react";
import type { TaxpayerExcelCandidate } from "@/lib/taxpayer-excel";
import { TAXPAYER_IMPORT_STORAGE_MAX_BYTES } from "@/lib/taxpayer-import";

type ImportPhase = "select" | "preview" | "adding" | "refreshing" | "complete" | "error";

type PreviewResponse = {
  importId?: string;
  fileName?: string;
  candidates?: TaxpayerExcelCandidate[];
  counts?: {
    totalRows: number;
    validRows: number;
    duplicateRows: number;
    invalidRows: number;
    existing: number;
    new: number;
  };
  invalidRows?: Array<{ sourceSheet: string; sourceRow: number; rawTaxCode: string; message: string }>;
  ignoredSheets?: string[];
  message?: string;
  error?: string;
};

type CommitResponse = {
  nextOffset?: number;
  totalCandidates?: number;
  done?: boolean;
  addedTaxCodes?: string[];
  addedCount?: number;
  skippedCount?: number;
  existingCount?: number;
  sourceCount?: number;
  error?: string;
};

type RefreshResponse = {
  results?: Array<{ tax_code?: string; ok?: boolean; error?: string; skipped?: boolean; skipReason?: string; needsManualReview?: boolean }>;
  error?: string;
};

type UploadResponse = {
  importId?: string;
  signedUrl?: string;
  error?: string;
};

type ImportSummary = {
  addedCount: number;
  updatedCount: number;
  failedCount: number;
  reviewCount: number;
};

type Props = {
  onClose: () => void;
  onCompleted: (summary: ImportSummary) => void;
};

const COMMIT_BATCH_SIZE = 100;
const REFRESH_BATCH_SIZE = 10;

function formatCount(value: number) {
  return value.toLocaleString("vi-VN");
}

export default function TaxpayerExcelImportModal({ onClose, onCompleted }: Props) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [importId, setImportId] = useState<string | null>(null);
  const [phase, setPhase] = useState<ImportPhase>("select");
  const [isReading, setIsReading] = useState(false);
  const [preview, setPreview] = useState<PreviewResponse | null>(null);
  const [showInvalidRows, setShowInvalidRows] = useState(false);
  const [progress, setProgress] = useState({ current: 0, total: 0, added: 0, updated: 0, failed: 0, review: 0 });
  const [error, setError] = useState<string | null>(null);
  const [refreshErrors, setRefreshErrors] = useState<string[]>([]);
  const [summary, setSummary] = useState<ImportSummary | null>(null);

  const isBusy = phase === "adding" || phase === "refreshing";
  const candidates = preview?.candidates ?? [];
  const counts = preview?.counts;

  function chooseFile(nextFile: File | null) {
    setFile(nextFile);
    setImportId(null);
    setPreview(null);
    setShowInvalidRows(false);
    setError(nextFile && nextFile.size > TAXPAYER_IMPORT_STORAGE_MAX_BYTES ? "File excel phải dưới 20MB" : null);
    setRefreshErrors([]);
    setSummary(null);
    setPhase("select");
  }

  async function readAndFilterFile() {
    if (!file || phase === "select" && !file) return;
    if (file.size > TAXPAYER_IMPORT_STORAGE_MAX_BYTES) {
      setError("File excel phải dưới 20MB");
      return;
    }
    setPhase("select");
    setIsReading(true);
    setError(null);
    let createdImportId: string | null = null;
    try {
      const uploadResponse = await fetch("/api/taxpayers/import/upload", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ fileName: file.name, fileSize: file.size, contentType: file.type }),
        cache: "no-store",
      });
      const uploadPayload = await uploadResponse.json().catch(() => ({})) as UploadResponse;
      if (!uploadResponse.ok || !uploadPayload.importId || !uploadPayload.signedUrl) {
        throw new Error(uploadPayload.error ?? "Không thể chuẩn bị nơi tải file Excel lên.");
      }
      createdImportId = uploadPayload.importId;
      setImportId(createdImportId);

      const uploadBody = new FormData();
      uploadBody.append("cacheControl", "3600");
      uploadBody.append("", file);
      const storageResponse = await fetch(uploadPayload.signedUrl, {
        method: "PUT",
        headers: { "x-upsert": "false" },
        body: uploadBody,
      });
      if (!storageResponse.ok) throw new Error("Không thể tải file Excel lên kho lưu trữ.");

      const response = await fetch("/api/taxpayers/import/preview", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ importId: createdImportId }),
        cache: "no-store",
      });
      const payload = await response.json().catch(() => ({})) as PreviewResponse;
      if (!response.ok) throw new Error(payload.error ?? "Không thể đọc file Excel.");
      setImportId(payload.importId ?? createdImportId);
      setPreview(payload);
      setPhase("preview");
    } catch (previewError) {
      if (createdImportId) {
        void fetch(`/api/taxpayers/import/upload?importId=${encodeURIComponent(createdImportId)}`, { method: "DELETE", cache: "no-store" });
      }
      setError(previewError instanceof Error ? previewError.message : "Không thể đọc file Excel.");
    } finally {
      setIsReading(false);
    }
  }

  async function startImport() {
    if (!candidates.length || !importId || isBusy) return;

    setError(null);
    setRefreshErrors([]);
    setSummary(null);
    setProgress({ current: 0, total: candidates.length, added: 0, updated: 0, failed: 0, review: 0 });
    setPhase("adding");

    const addedTaxCodes: string[] = [];
    try {
      for (let index = 0; index < candidates.length; index += COMMIT_BATCH_SIZE) {
        const response = await fetch("/api/taxpayers/import/commit", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ importId, offset: index }),
          cache: "no-store",
        });
        const payload = await response.json().catch(() => ({})) as CommitResponse;
        if (!response.ok) throw new Error(payload.error ?? "Không thể thêm MST từ file Excel.");
        for (const taxCode of payload.addedTaxCodes ?? []) {
          if (!addedTaxCodes.includes(taxCode)) addedTaxCodes.push(taxCode);
        }
        setProgress((current) => ({
          ...current,
          current: Math.min(payload.nextOffset ?? index + COMMIT_BATCH_SIZE, candidates.length),
          added: addedTaxCodes.length,
        }));
      }

      const refreshTaxCodes = candidates.map((candidate) => candidate.taxCode);
      setProgress((current) => ({ ...current, current: 0, total: refreshTaxCodes.length }));
      setPhase("refreshing");
      let updatedCount = 0;
      let failedCount = 0;
      let reviewCount = 0;
      const failures: string[] = [];

      for (let index = 0; index < refreshTaxCodes.length; index += REFRESH_BATCH_SIZE) {
        const batch = refreshTaxCodes.slice(index, index + REFRESH_BATCH_SIZE);
        try {
          const response = await fetch("/api/taxpayers/import/refresh", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ taxCodes: batch }),
            cache: "no-store",
          });
          const payload = await response.json().catch(() => ({})) as RefreshResponse;
          if (!response.ok) {
            failedCount += batch.length;
            failures.push(payload.error ?? `Không thể cập nhật ${batch.length} MST.`);
          } else {
            const results = payload.results ?? [];
            const reviewBatchCount = results.filter((result) => result.ok === true && result.needsManualReview === true).length;
            const successfulCount = results.filter((result) => result.ok === true && result.needsManualReview !== true).length;
            updatedCount += successfulCount;
            reviewCount += reviewBatchCount;
            failedCount += Math.max(0, batch.length - successfulCount - reviewBatchCount);
            failures.push(...results.filter((result) => result.ok !== true && result.error).map((result) => (result.tax_code ?? "MST") + ": " + result.error));
          }
        } catch (refreshError) {
          failedCount += batch.length;
          failures.push(refreshError instanceof Error ? refreshError.message : `Không thể cập nhật ${batch.length} MST.`);
        }

        setProgress((current) => ({
          ...current,
          current: Math.min(index + batch.length, refreshTaxCodes.length),
          added: addedTaxCodes.length,
          updated: updatedCount,
          failed: failedCount,
          review: reviewCount,
        }));
      }

      const completedSummary = { addedCount: addedTaxCodes.length, updatedCount, failedCount, reviewCount };
      setRefreshErrors(failures.slice(0, 20));
      await completeImport(importId, completedSummary.updatedCount, completedSummary.failedCount, completedSummary.reviewCount, completedSummary.addedCount);
    } catch (importError) {
      setError(importError instanceof Error ? importError.message : "Không thể hoàn tất nhập Excel.");
      setPhase("error");
    }
  }

  async function completeImport(currentImportId: string, updatedCount: number, failedCount: number, reviewCount: number, fallbackAddedCount: number) {
    const response = await fetch("/api/taxpayers/import/complete", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ importId: currentImportId, updatedCount, failedCount, reviewCount }),
      cache: "no-store",
    });
    const payload = await response.json().catch(() => ({})) as {
      addedCount?: number;
      updatedCount?: number;
      failedCount?: number;
      reviewCount?: number;
      error?: string;
    };
    if (!response.ok) throw new Error(payload.error ?? "Không thể ghi sự kiện nhập Excel vào Lịch sử.");

    const completedSummary = {
      addedCount: payload.addedCount ?? fallbackAddedCount,
      updatedCount: payload.updatedCount ?? updatedCount,
      failedCount: payload.failedCount ?? failedCount,
      reviewCount: payload.reviewCount ?? reviewCount,
    };
    setSummary(completedSummary);
    setPhase("complete");
    onCompleted(completedSummary);
  }

  function handleClose() {
    if (importId && phase === "preview") {
      void fetch(`/api/taxpayers/import/upload?importId=${encodeURIComponent(importId)}`, { method: "DELETE", cache: "no-store" });
    }
    onClose();
  }

  function renderSelectStep() {
    return <>
      <p className="taxpayer-import-description">Chọn file Excel có các worksheet đặt tên theo năm hoặc kỳ cập nhật, ví dụ <strong>2026</strong>, <strong>T2-2026</strong>, <strong>T6-2026</strong>.</p>
      <div className="taxpayer-import-file-picker">
        <input ref={fileInputRef} type="file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" onChange={(event) => chooseFile(event.target.files?.[0] ?? null)} />
        <FileText size={22} weight="duotone" />
        <strong>{file ? file.name : "Chưa chọn file Excel"}</strong>
        <span>{file ? `${(file.size / 1024).toFixed(1)} KiB` : "Định dạng hỗ trợ: .xlsx"}</span>
        <button className="outline-button" type="button" onClick={() => fileInputRef.current?.click()}>Chọn file</button>
      </div>
      <p className="taxpayer-import-template-link"><DownloadSimple size={16} /><a href="/api/taxpayers/import/template">Tải file Excel mẫu</a><span>— dùng tên sheet là năm hoặc T&#123;tháng&#125;-&#123;năm&#125; để phân loại dữ liệu</span></p>
      {isReading ? <div className="taxpayer-import-uploading" role="status" aria-live="polite"><ArrowsClockwise size={17} className="update-icon-spinning" /> <span>Đang upload file excel</span></div> : null}
      {error ? <div className="confirm-error"><WarningCircle size={16} /> {error}</div> : null}
    </>;
  }

  function renderPreviewStep() {
    const invalidRows = preview?.invalidRows ?? [];
    const invalidRowCount = counts?.invalidRows ?? invalidRows.length;

    return <>
      <div className="taxpayer-import-summary-grid">
        <div><strong>{formatCount(counts?.new ?? candidates.length)}</strong><span>MST chưa có trong CSDL</span></div>
        <div><strong>{formatCount(counts?.existing ?? 0)}</strong><span>MST đã tồn tại, ghi nhận nguồn</span></div>
        <div><strong>{formatCount(counts?.duplicateRows ?? 0)}</strong><span>Dòng trùng trong file</span></div>
        <button
          className={`taxpayer-import-summary-card${invalidRows.length ? " is-clickable" : ""}`}
          type="button"
          disabled={!invalidRows.length}
          aria-expanded={showInvalidRows}
          onClick={() => setShowInvalidRows((current) => !current)}
        >
          <strong>{formatCount(invalidRowCount)}</strong>
          <span>Dòng không hợp lệ</span>
          {invalidRows.length ? <small>{showInvalidRows ? "Ẩn chi tiết" : "Xem chi tiết"}</small> : null}
        </button>
      </div>
      <div className="taxpayer-import-message" role="status"><CheckCircle size={18} /> {preview?.message ?? `Đã đọc ${formatCount(candidates.length)} MST và nguồn dữ liệu.`}</div>
      {candidates.length ? <div className="taxpayer-import-candidate-list"><strong>MST sẽ được đối chiếu tên trước khi cập nhật dữ liệu</strong><div className="taxpayer-import-candidate-scroll">{candidates.slice(0, 30).map((candidate) => <div className="taxpayer-import-candidate-row" key={candidate.taxCode}><span><span className="mono-value">{candidate.taxCode}</span><small>{candidate.sources.find((source) => source.sourceVendorName)?.sourceVendorName ?? "Chưa có tên tham chiếu"}</small></span><span>{[...new Set(candidate.sources.map((source) => source.sourceYear))].join(", ")}</span></div>)}</div>{candidates.length > 30 ? <small>Đang hiển thị 30/{formatCount(candidates.length)} MST.</small> : null}</div> : null}
      {preview?.ignoredSheets?.length ? <div className="taxpayer-import-warning"><WarningCircle size={16} /><span>Sheet bị bỏ qua: {preview.ignoredSheets.join("; ")}</span></div> : null}
      {invalidRows.length ? <div className="taxpayer-import-warning"><WarningCircle size={16} /><span>Đã bỏ qua {formatCount(invalidRowCount)} dòng MST không hợp lệ. Bấm vào ô “Dòng không hợp lệ” để xem chi tiết.</span></div> : null}
      {showInvalidRows && invalidRows.length ? <div className="taxpayer-import-invalid-details">
        <div className="taxpayer-import-invalid-heading"><strong>Chi tiết dòng MST không hợp lệ</strong><span>Hiển thị tối đa 100 dòng đầu tiên</span></div>
        <div className="taxpayer-import-invalid-scroll">
          {invalidRows.map((invalidRow, index) => <div className="taxpayer-import-invalid-row" key={`${invalidRow.sourceSheet}-${invalidRow.sourceRow}-${index}`}>
            <span><strong>{invalidRow.sourceSheet}</strong> · dòng {invalidRow.sourceRow}</span>
            <span className="mono-value">{invalidRow.rawTaxCode || "(trống)"}</span>
            <span>{invalidRow.message}</span>
          </div>)}
        </div>
        {invalidRowCount > invalidRows.length ? <small>Đang hiển thị {formatCount(invalidRows.length)}/{formatCount(invalidRowCount)} dòng không hợp lệ.</small> : null}
      </div> : null}
      {error ? <div className="confirm-error"><WarningCircle size={16} /> {error}</div> : null}
    </>;
  }

  function renderProgressStep() {
    const label = phase === "adding"
      ? `Đang đồng bộ ${formatCount(progress.current)}/${formatCount(progress.total)} MST`
      : `Đang cập nhật ${formatCount(progress.current)}/${formatCount(progress.total)} MST từ endpoint...`;
    const percent = progress.total ? Math.round(progress.current / progress.total * 100) : 0;
    return <div className="taxpayer-import-progress" role="status" aria-live="polite">
      <ArrowsClockwise size={30} className="update-icon-spinning" />
      <strong>{label}</strong>
      <div className="taxpayer-import-progress-track"><span style={{ width: `${percent}%` }} /></div>
      <span>{phase === "adding" ? "Các MST mới sẽ được đưa vào hàng đợi cập nhật." : "Đang lấy dữ liệu từ endpoint và lưu vào cơ sở dữ liệu tổng hợp MST."}</span>
    </div>;
  }

  function renderCompleteStep() {
    if (!summary) return null;
    const message = `Đã hoàn tất nhập Excel. Đã thêm ${formatCount(summary.addedCount)} MST mới và xử lý ${formatCount(summary.updatedCount + summary.reviewCount)} MST qua đối chiếu endpoint.`;
    return <div className="taxpayer-import-complete" role="status"><CheckCircle size={36} weight="duotone" /><strong>{message}</strong>{summary.reviewCount ? <div className="taxpayer-import-warning"><WarningCircle size={16} /><span>{formatCount(summary.reviewCount)} MST lệch tên tham chiếu, đã giữ tên Excel và gắn cảnh báo vàng để đối chiếu thủ công.</span></div> : null}{summary.failedCount ? <div className="taxpayer-import-warning"><WarningCircle size={16} /><span>Còn {formatCount(summary.failedCount)} MST lỗi kỹ thuật cần thử lại.</span></div> : null}{refreshErrors.length ? <div className="taxpayer-import-warning"><WarningCircle size={16} /><span>{refreshErrors.slice(0, 3).join("; ")}</span></div> : null}</div>;
  }

  return <div className="confirm-backdrop">
    <section className="confirm-dialog taxpayer-import-dialog" role="dialog" aria-modal="true" aria-labelledby="taxpayer-import-title" aria-describedby="taxpayer-import-description">
      <div className="taxpayer-import-heading"><div className="confirm-dialog-icon taxpayer-import-icon"><DownloadSimple size={22} weight="duotone" /></div><button className="icon-button" type="button" aria-label="Đóng nhập Excel" disabled={isBusy || isReading} onClick={handleClose}><X size={17} /></button></div>
      <h2 id="taxpayer-import-title">Nhập danh mục MST từ Excel</h2>
      {phase === "select" ? renderSelectStep() : null}
      {phase === "preview" ? renderPreviewStep() : null}
      {isBusy ? renderProgressStep() : null}
      {phase === "complete" ? renderCompleteStep() : null}
      {phase === "error" ? <div className="taxpayer-import-error"><WarningCircle size={30} weight="duotone" /><strong>{error ?? "Nhập Excel chưa hoàn tất."}</strong><span>Các MST đã thêm vẫn được giữ trong cơ sở dữ liệu và có thể được cập nhật lại sau.</span></div> : null}
      <div className="confirm-actions">
        {isBusy || isReading ? null : <button className="outline-button" type="button" onClick={handleClose}>{phase === "complete" || phase === "error" || !file ? "Đóng" : "Hủy"}</button>}
        {phase === "select" ? <button className="export-button" type="button" disabled={!file || isReading || Boolean(file && file.size > TAXPAYER_IMPORT_STORAGE_MAX_BYTES)} onClick={() => void readAndFilterFile()}>{isReading ? "Đang upload file excel" : "Đọc và lọc MST"}</button> : null}
        {phase === "preview" && candidates.length ? <button className="export-button" type="button" onClick={() => void startImport()}>Xác nhận đồng bộ {formatCount(candidates.length)} MST</button> : null}
      </div>
    </section>
  </div>;
}

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

type ImportPhase = "select" | "preview" | "adding" | "refreshing" | "complete" | "error";

type PreviewResponse = {
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
  addedTaxCodes?: string[];
  addedCount?: number;
  skippedCount?: number;
  error?: string;
};

type RefreshResponse = {
  results?: Array<{ tax_code?: string; ok?: boolean; error?: string }>;
  error?: string;
};

type ImportSummary = {
  addedCount: number;
  updatedCount: number;
  failedCount: number;
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
  const [phase, setPhase] = useState<ImportPhase>("select");
  const [isReading, setIsReading] = useState(false);
  const [preview, setPreview] = useState<PreviewResponse | null>(null);
  const [progress, setProgress] = useState({ current: 0, total: 0, added: 0, updated: 0, failed: 0 });
  const [error, setError] = useState<string | null>(null);
  const [refreshErrors, setRefreshErrors] = useState<string[]>([]);
  const [summary, setSummary] = useState<ImportSummary | null>(null);

  const isBusy = phase === "adding" || phase === "refreshing";
  const candidates = preview?.candidates ?? [];
  const counts = preview?.counts;

  function chooseFile(nextFile: File | null) {
    setFile(nextFile);
    setPreview(null);
    setError(null);
    setRefreshErrors([]);
    setSummary(null);
    setPhase("select");
  }

  async function readAndFilterFile() {
    if (!file || phase === "select" && !file) return;
    setPhase("select");
    setIsReading(true);
    setError(null);
    const formData = new FormData();
    formData.append("file", file);
    try {
      const response = await fetch("/api/taxpayers/import/preview", {
        method: "POST",
        body: formData,
        cache: "no-store",
      });
      const payload = await response.json().catch(() => ({})) as PreviewResponse;
      if (!response.ok) throw new Error(payload.error ?? "Không thể đọc file Excel.");
      setPreview(payload);
      setPhase("preview");
    } catch (previewError) {
      setError(previewError instanceof Error ? previewError.message : "Không thể đọc file Excel.");
    } finally {
      setIsReading(false);
    }
  }

  async function startImport() {
    if (!candidates.length || isBusy) return;

    setError(null);
    setRefreshErrors([]);
    setSummary(null);
    setProgress({ current: 0, total: candidates.length, added: 0, updated: 0, failed: 0 });
    setPhase("adding");

    const addedTaxCodes: string[] = [];
    try {
      for (let index = 0; index < candidates.length; index += COMMIT_BATCH_SIZE) {
        const batch = candidates.slice(index, index + COMMIT_BATCH_SIZE);
        const response = await fetch("/api/taxpayers/import/commit", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ candidates: batch }),
          cache: "no-store",
        });
        const payload = await response.json().catch(() => ({})) as CommitResponse;
        if (!response.ok) throw new Error(payload.error ?? "Không thể thêm MST từ file Excel.");
        addedTaxCodes.push(...(payload.addedTaxCodes ?? []));
        setProgress((current) => ({
          ...current,
          current: Math.min(index + batch.length, candidates.length),
          added: addedTaxCodes.length,
        }));
      }

      if (!addedTaxCodes.length) {
        const completedSummary = { addedCount: 0, updatedCount: 0, failedCount: 0 };
        setSummary(completedSummary);
        setPhase("complete");
        onCompleted(completedSummary);
        return;
      }

      setProgress((current) => ({ ...current, current: 0, total: addedTaxCodes.length }));
      setPhase("refreshing");
      let updatedCount = 0;
      let failedCount = 0;
      const failures: string[] = [];

      for (let index = 0; index < addedTaxCodes.length; index += REFRESH_BATCH_SIZE) {
        const batch = addedTaxCodes.slice(index, index + REFRESH_BATCH_SIZE);
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
            const successfulCount = results.filter((result) => result.ok === true).length;
            updatedCount += successfulCount;
            failedCount += Math.max(0, batch.length - successfulCount);
            failures.push(...results.filter((result) => result.ok !== true && result.error).map((result) => (result.tax_code ?? "MST") + ": " + result.error));
          }
        } catch (refreshError) {
          failedCount += batch.length;
          failures.push(refreshError instanceof Error ? refreshError.message : `Không thể cập nhật ${batch.length} MST.`);
        }

        setProgress((current) => ({
          ...current,
          current: Math.min(index + batch.length, addedTaxCodes.length),
          added: addedTaxCodes.length,
          updated: updatedCount,
          failed: failedCount,
        }));
      }

      const completedSummary = { addedCount: addedTaxCodes.length, updatedCount, failedCount };
      setRefreshErrors(failures.slice(0, 20));
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
      <p className="taxpayer-import-description">Chọn file Excel có các worksheet đặt tên theo năm, ví dụ <strong>2023</strong>, <strong>2024</strong>, <strong>2025</strong>.</p>
      <div className="taxpayer-import-file-picker">
        <input ref={fileInputRef} type="file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" onChange={(event) => chooseFile(event.target.files?.[0] ?? null)} />
        <FileText size={22} weight="duotone" />
        <strong>{file ? file.name : "Chưa chọn file Excel"}</strong>
        <span>{file ? `${(file.size / 1024).toFixed(1)} KiB` : "Định dạng hỗ trợ: .xlsx"}</span>
        <button className="outline-button" type="button" onClick={() => fileInputRef.current?.click()}>Chọn file</button>
      </div>
      <p className="taxpayer-import-template-link"><DownloadSimple size={16} /><a href="/api/taxpayers/import/template">Tải file Excel mẫu</a><span>— dùng tên sheet là năm để phân loại dữ liệu</span></p>
      {error ? <div className="confirm-error"><WarningCircle size={16} /> {error}</div> : null}
    </>;
  }

  function renderPreviewStep() {
    return <>
      <div className="taxpayer-import-summary-grid">
        <div><strong>{formatCount(counts?.new ?? candidates.length)}</strong><span>MST chưa có trong CSDL</span></div>
        <div><strong>{formatCount(counts?.existing ?? 0)}</strong><span>MST đã tồn tại, bỏ qua</span></div>
        <div><strong>{formatCount(counts?.duplicateRows ?? 0)}</strong><span>Dòng trùng trong file</span></div>
        <div><strong>{formatCount(counts?.invalidRows ?? 0)}</strong><span>Dòng không hợp lệ</span></div>
      </div>
      <div className="taxpayer-import-message" role="status"><CheckCircle size={18} /> {preview?.message ?? `Phát hiện ${formatCount(candidates.length)} MST chưa có trong cơ sở dữ liệu.`}</div>
      {candidates.length ? <div className="taxpayer-import-candidate-list"><strong>Một số MST sẽ được thêm</strong><div className="taxpayer-import-candidate-scroll">{candidates.slice(0, 30).map((candidate) => <div className="taxpayer-import-candidate-row" key={candidate.taxCode}><span className="mono-value">{candidate.taxCode}</span><span>{candidate.name ?? "Chưa có tên"}</span><span>{[...new Set(candidate.sources.map((source) => source.sourceYear))].join(", ")}</span></div>)}</div>{candidates.length > 30 ? <small>Đang hiển thị 30/{formatCount(candidates.length)} MST.</small> : null}</div> : null}
      {preview?.ignoredSheets?.length ? <div className="taxpayer-import-warning"><WarningCircle size={16} /><span>Sheet bị bỏ qua: {preview.ignoredSheets.join("; ")}</span></div> : null}
      {preview?.invalidRows?.length ? <div className="taxpayer-import-warning"><WarningCircle size={16} /><span>Đã bỏ qua {formatCount(counts?.invalidRows ?? preview.invalidRows.length)} dòng MST không hợp lệ.</span></div> : null}
      {error ? <div className="confirm-error"><WarningCircle size={16} /> {error}</div> : null}
    </>;
  }

  function renderProgressStep() {
    const label = phase === "adding"
      ? `Đang thêm ${formatCount(progress.current)}/${formatCount(progress.total)} MST mới`
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
    const message = summary.failedCount
      ? `Đã hoàn tất nhập Excel. Đã thêm ${formatCount(summary.addedCount)} MST mới và cập nhật thành công ${formatCount(summary.updatedCount)}/${formatCount(summary.addedCount)} thông tin MST; còn ${formatCount(summary.failedCount)} MST cần thử lại.`
      : `Đã hoàn tất nhập Excel. Đã thêm ${formatCount(summary.addedCount)} MST mới và cập nhật thành công ${formatCount(summary.updatedCount)} thông tin MST từ endpoint.`;
    return <div className="taxpayer-import-complete" role="status"><CheckCircle size={36} weight="duotone" /><strong>{message}</strong>{refreshErrors.length ? <div className="taxpayer-import-warning"><WarningCircle size={16} /><span>{refreshErrors.slice(0, 3).join("; ")}</span></div> : null}</div>;
  }

  return <div className="confirm-backdrop">
    <section className="confirm-dialog taxpayer-import-dialog" role="dialog" aria-modal="true" aria-labelledby="taxpayer-import-title" aria-describedby="taxpayer-import-description">
      <div className="taxpayer-import-heading"><div className="confirm-dialog-icon taxpayer-import-icon"><DownloadSimple size={22} weight="duotone" /></div><button className="icon-button" type="button" aria-label="Đóng nhập Excel" disabled={isBusy} onClick={onClose}><X size={17} /></button></div>
      <h2 id="taxpayer-import-title">Nhập danh mục MST từ Excel</h2>
      {phase === "select" ? renderSelectStep() : null}
      {phase === "preview" ? renderPreviewStep() : null}
      {isBusy ? renderProgressStep() : null}
      {phase === "complete" ? renderCompleteStep() : null}
      {phase === "error" ? <div className="taxpayer-import-error"><WarningCircle size={30} weight="duotone" /><strong>{error ?? "Nhập Excel chưa hoàn tất."}</strong><span>Các MST đã thêm vẫn được giữ trong cơ sở dữ liệu và có thể được cập nhật lại sau.</span></div> : null}
      <div className="confirm-actions">
        {isBusy ? null : <button className="outline-button" type="button" onClick={onClose}>{phase === "complete" || phase === "error" || !file ? "Đóng" : "Hủy"}</button>}
        {phase === "select" ? <button className="export-button" type="button" disabled={!file || isReading} onClick={() => void readAndFilterFile()}>{isReading ? "Đang đọc..." : "Đọc và lọc MST"}</button> : null}
        {phase === "preview" && candidates.length ? <button className="export-button" type="button" onClick={() => void startImport()}>Xác nhận thêm {formatCount(candidates.length)} MST</button> : null}
      </div>
    </section>
  </div>;
}

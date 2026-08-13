"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";
import {
  ArrowsClockwise,
  Bell,
  CaretDown,
  CaretRight,
  ChartLineUp,
  CheckCircle,
  Database,
  DownloadSimple,
  FileText,
  Funnel,
  Gear,
  House,
  MagnifyingGlass,
  SignOut,
  SquaresFour,
  Table,
  UsersThree,
  WarningCircle,
} from "@phosphor-icons/react";
import { createClient } from "@/lib/supabase/client";
import type { Profile } from "@/lib/types";

const SHEETS = ["2023", "2024", "2025", "T2-26"] as const;
type SheetName = (typeof SHEETS)[number];
type ViewMode = "overview" | "sheets";

type TaxpayerDetail = {
  tax_code: string;
  name: string | null;
  org_type: string | null;
  address: string | null;
  tax_department: string | null;
  status: string | null;
  status_group: string | null;
  source_updated_at: string | null;
  last_checked_at: string | null;
  status_changed_at: string | null;
  last_error: string | null;
};

type TaxpayerRow = {
  id: number;
  tax_code: string;
  source_sheet: string;
  source_year: string | null;
  source_row: number | null;
  source_vendor_name: string | null;
  source_note: string | null;
  taxpayer: TaxpayerDetail | null;
};

type Summary = { total: number; active: number; refreshPending: number; errors: number };

type DashboardProps = { userEmail: string; profile: Profile | null };

function AttechLogo({ compact = false }: { compact?: boolean }) {
  return (
    <div className={`attech-logo ${compact ? "attech-logo-compact" : ""}`} aria-label="ATTECH">
      <span className="attech-a">A</span><span className="attech-tech">TTECH</span>
    </div>
  );
}

function formatDate(value: string | null) {
  if (!value) return "Chưa cập nhật";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("vi-VN", { dateStyle: "short", timeStyle: "short" }).format(date);
}

function statusLabel(taxpayer: TaxpayerDetail | null) {
  if (!taxpayer?.status) return "Chưa có dữ liệu";
  return taxpayer.status;
}

function statusClass(taxpayer: TaxpayerDetail | null) {
  if (taxpayer?.status_group === "active") return "status-badge status-success";
  if (taxpayer?.status_group === "inactive") return "status-badge status-danger";
  return "status-badge status-warning";
}

function escapeExportText(value: string | null | undefined) {
  return value?.trim() ?? "";
}

export default function Dashboard({ userEmail, profile }: DashboardProps) {
  const [viewMode, setViewMode] = useState<ViewMode>("overview");
  const [selectedSheet, setSelectedSheet] = useState<SheetName>("2025");
  const [rows, setRows] = useState<TaxpayerRow[]>([]);
  const [summary, setSummary] = useState<Summary>({ total: 0, active: 0, refreshPending: 0, errors: 0 });
  const [query, setQuery] = useState("");
  const [expandedRow, setExpandedRow] = useState<number | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isExporting, setIsExporting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isApproved = profile?.approval_status === "approved";
  const activeSheet = viewMode === "overview" ? "all" : selectedSheet;

  async function loadData() {
    if (!isApproved) return;
    setIsLoading(true);
    setError(null);
    try {
      const response = await fetch(`/api/taxpayers?sheet=${encodeURIComponent(activeSheet)}&limit=250`, { cache: "no-store" });
      const payload = await response.json() as { rows?: TaxpayerRow[]; summary?: Summary; error?: string };
      if (!response.ok) throw new Error(payload.error ?? "Không thể tải danh sách.");
      setRows(payload.rows ?? []);
      setSummary(payload.summary ?? { total: 0, active: 0, refreshPending: 0, errors: 0 });
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Không thể tải danh sách.");
      setRows([]);
    } finally {
      setIsLoading(false);
    }
  }

  useEffect(() => {
    void loadData();
    // The active sheet is the intended refresh boundary for this dashboard.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSheet, isApproved]);

  const filteredRows = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return rows;
    return rows.filter((row) => [row.tax_code, row.source_vendor_name, row.taxpayer?.name, row.taxpayer?.status]
      .some((value) => value?.toLowerCase().includes(needle)));
  }, [query, rows]);

  async function search(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const normalized = query.trim();
    if (!normalized) return;
    setViewMode("overview");
    setError(null);
    setIsLoading(true);
    try {
      const response = await fetch(`/api/taxpayer?taxCode=${encodeURIComponent(normalized)}`, { cache: "no-store" });
      const payload = await response.json() as { data?: TaxpayerDetail | null; error?: string };
      if (!response.ok) throw new Error(payload.error ?? "Tra cứu không thành công.");
      if (payload.data) {
        setRows([{
          id: -1,
          tax_code: payload.data.tax_code,
          source_sheet: "Kết quả nhập nhanh",
          source_year: null,
          source_row: null,
          source_vendor_name: payload.data.name,
          source_note: null,
          taxpayer: payload.data,
        }]);
      } else {
        setRows([]);
        setError("Không tìm thấy mã số thuế trong cơ sở dữ liệu.");
      }
    } catch (lookupError) {
      setError(lookupError instanceof Error ? lookupError.message : "Tra cứu không thành công.");
      setRows([]);
    } finally {
      setIsLoading(false);
    }
  }

  async function exportWorkbook() {
    if (!isApproved || isExporting) return;
    setIsExporting(true);
    setError(null);
    try {
      const XLSX = await import("xlsx");
      const workbook = XLSX.utils.book_new();
      const columns = [
        "STT",
        "Tên người bán",
        "Mã số thuế",
        "Tình trạng hoạt động của MST",
        "Thời điểm tra cứu lần trước",
        "Thời điểm tra cứu mới nhất",
        "Ghi chú",
      ];

      for (const sheetName of SHEETS) {
        const response = await fetch(`/api/taxpayers?sheet=${encodeURIComponent(sheetName)}&limit=2500`, { cache: "no-store" });
        const payload = await response.json() as { rows?: TaxpayerRow[]; error?: string };
        if (!response.ok) throw new Error(payload.error ?? `Không thể tải sheet ${sheetName}.`);
        const sheetRows = payload.rows ?? [];
        const values = sheetRows.map((row, index) => [
          index + 1,
          escapeExportText(row.source_vendor_name ?? row.taxpayer?.name),
          row.tax_code,
          escapeExportText(row.taxpayer?.status),
          "",
          escapeExportText(row.taxpayer?.last_checked_at ? formatDate(row.taxpayer.last_checked_at) : null),
          escapeExportText([row.source_note, row.taxpayer?.last_error].filter(Boolean).join(" | ")),
        ]);
        const worksheet = XLSX.utils.aoa_to_sheet([columns, ...values]);
        worksheet["!cols"] = [{ wch: 7 }, { wch: 42 }, { wch: 17 }, { wch: 34 }, { wch: 24 }, { wch: 24 }, { wch: 54 }];
        XLSX.utils.book_append_sheet(workbook, worksheet, sheetName);
      }

      XLSX.writeFile(workbook, `TAX-ID-Checker-${new Date().toISOString().slice(0, 10)}.xlsx`);
    } catch (exportError) {
      setError(exportError instanceof Error ? exportError.message : "Không thể xuất Excel.");
    } finally {
      setIsExporting(false);
    }
  }

  async function signOut() {
    const supabase = createClient();
    await supabase.auth.signOut();
    window.location.href = "/login";
  }

  const navItems = [
    { label: "Tổng hợp", icon: SquaresFour, mode: "overview" as ViewMode },
    { label: "Tra cứu nhanh", icon: MagnifyingGlass, mode: "overview" as ViewMode },
    { label: "Theo từng sheet", icon: Table, mode: "sheets" as ViewMode },
  ];

  return (
    <div className="dashboard-frame">
      <aside className="dashboard-sidebar">
        <div className="sidebar-brand">
          <AttechLogo />
          <div className="product-name">TAX ID Cheker <span>v1.0.0 beta</span></div>
        </div>
        <div className="sidebar-section-label">WORKSPACE</div>
        <nav className="sidebar-nav" aria-label="Điều hướng chính">
          {navItems.map(({ label, icon: Icon, mode }, index) => (
            <button
              className={`sidebar-link ${viewMode === mode && (index === 0 || mode === "sheets") ? "sidebar-link-active" : ""}`}
              key={label}
              type="button"
              onClick={() => {
                setViewMode(mode);
                setError(null);
              }}
            >
              <Icon size={18} weight="regular" />
              <span>{label}</span>
              {index === 0 ? <span className="nav-count">{summary.total || "-"}</span> : null}
            </button>
          ))}
        </nav>
        <div className="sidebar-section-label sidebar-section-spaced">QUẢN TRỊ</div>
        <nav className="sidebar-nav" aria-label="Quản trị">
          <button className="sidebar-link" type="button"><ChartLineUp size={18} /> <span>Báo cáo cập nhật</span></button>
          <button className="sidebar-link" type="button"><Gear size={18} /> <span>Cấu hình hệ thống</span></button>
        </nav>
        <div className="sidebar-status">
          <span className="status-signal" />
          <div><strong>Hệ thống hoạt động</strong><small>Supabase database online</small></div>
        </div>
      </aside>

      <div className="dashboard-main">
        <header className="dashboard-topbar">
          <div className="topbar-context"><House size={15} /><span>/</span><strong>{viewMode === "overview" ? "Tổng hợp" : "Theo từng sheet"}</strong></div>
          <div className="topbar-actions">
            <button className="icon-button" type="button" aria-label="Thông báo"><Bell size={18} /></button>
            <div className="user-chip"><span className="user-avatar">{(userEmail[0] ?? "U").toUpperCase()}</span><span>{userEmail}</span><CaretDown size={14} /></div>
            <button className="icon-button" type="button" aria-label="Đăng xuất" onClick={signOut}><SignOut size={18} /></button>
          </div>
        </header>

        <main className="dashboard-content">
          <div className="page-heading-row">
            <div>
              <p className="page-kicker">ATTECH · TAXPAYER OPERATIONS</p>
              <h1>{viewMode === "overview" ? "Bảng tổng hợp" : `Danh sách MST sheet ${selectedSheet}`}</h1>
              <p className="page-subtitle">Theo dõi tình trạng hoạt động và thời điểm cập nhật mới nhất từ XInvoice.</p>
            </div>
            <div className="heading-actions">
              <button className="outline-button" type="button" onClick={() => void loadData()} disabled={isLoading || !isApproved}><ArrowsClockwise size={17} /> Làm mới</button>
              <button className="export-button" type="button" onClick={() => void exportWorkbook()} disabled={isExporting || !isApproved}><DownloadSimple size={17} /> {isExporting ? "Đang xuất" : "Xuất Excel"}</button>
            </div>
          </div>

          {!isApproved ? (
            <div className="approval-panel"><WarningCircle size={22} /><div><strong>Tài khoản đang chờ phê duyệt</strong><span>Quản trị viên cần kích hoạt quyền trước khi bạn có thể xem dữ liệu.</span></div></div>
          ) : null}

          <section className="metrics-grid" aria-label="Tổng quan dữ liệu">
            <article className="metric-card"><div className="metric-icon metric-blue"><Database size={19} /></div><div><span>Tổng mã số thuế</span><strong>{summary.total.toLocaleString("vi-VN")}</strong><small>Trong danh mục quản lý</small></div></article>
            <article className="metric-card"><div className="metric-icon metric-green"><CheckCircle size={19} /></div><div><span>Đang hoạt động</span><strong>{summary.active.toLocaleString("vi-VN")}</strong><small>Trạng thái hợp lệ gần nhất</small></div></article>
            <article className="metric-card"><div className="metric-icon metric-orange"><ArrowsClockwise size={19} /></div><div><span>Đang chờ cập nhật</span><strong>{summary.refreshPending.toLocaleString("vi-VN")}</strong><small>Trong hàng đợi XInvoice</small></div></article>
            <article className="metric-card"><div className="metric-icon metric-red"><WarningCircle size={19} /></div><div><span>Cần kiểm tra</span><strong>{summary.errors.toLocaleString("vi-VN")}</strong><small>Lỗi cập nhật gần nhất</small></div></article>
          </section>

          <section className="table-section">
            <div className="table-toolbar">
              <div><h2>{viewMode === "overview" ? "Bản ghi gần đây" : `MST trong sheet ${selectedSheet}`}</h2><span>{filteredRows.length} dòng đang hiển thị</span></div>
              <div className="toolbar-tools">
                <form className="table-search" onSubmit={search}><MagnifyingGlass size={16} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Tìm MST hoặc tên..." aria-label="Tìm kiếm MST hoặc tên" /><button type="submit" aria-label="Tìm kiếm"><CaretRight size={15} /></button></form>
                <button className="filter-button" type="button"><Funnel size={16} /> Bộ lọc</button>
              </div>
            </div>

            {viewMode === "sheets" ? (
              <div className="sheet-tabs" role="tablist" aria-label="Chọn sheet">
                {SHEETS.map((sheet) => <button key={sheet} className={selectedSheet === sheet ? "sheet-tab sheet-tab-active" : "sheet-tab"} type="button" role="tab" aria-selected={selectedSheet === sheet} onClick={() => setSelectedSheet(sheet)}>{sheet}<span>{sheet === "T2-26" ? "Tháng 2" : `Năm ${sheet}`}</span></button>)}
              </div>
            ) : null}

            {error ? <div className="table-alert"><WarningCircle size={18} /> {error}</div> : null}
            <div className="table-scroll">
              <table className="data-table">
                <thead><tr><th className="col-expand" /><th>Mã số thuế</th><th>Tên người nộp thuế</th><th>Sheet nguồn</th><th>Tình trạng</th><th>Tra cứu gần nhất</th><th>Ghi chú</th></tr></thead>
                <tbody>
                  {isLoading ? <TableSkeleton /> : filteredRows.length === 0 ? <tr><td colSpan={7}><div className="table-empty"><FileText size={26} /><strong>{isApproved ? "Chưa có dữ liệu để hiển thị" : "Đăng nhập được phê duyệt để xem dữ liệu"}</strong><span>Dữ liệu sẽ xuất hiện sau khi migration và seed Supabase hoàn tất.</span></div></td></tr> : filteredRows.map((row) => {
                    const detail = row.taxpayer;
                    const isExpanded = expandedRow === row.id;
                    return <>
                      <tr key={row.id} className={`data-row ${isExpanded ? "data-row-expanded" : ""}`} onClick={() => setExpandedRow(isExpanded ? null : row.id)}>
                        <td className="col-expand"><CaretRight size={16} className={isExpanded ? "caret-open" : ""} /></td>
                        <td className="tax-code-cell">{row.tax_code}</td>
                        <td><strong>{row.source_vendor_name ?? detail?.name ?? "Chưa có tên"}</strong><small>{detail?.address ?? ""}</small></td>
                        <td><span className="sheet-label">{row.source_sheet}</span></td>
                        <td><span className={statusClass(detail)}>{statusLabel(detail)}</span></td>
                        <td className="date-cell">{formatDate(detail?.last_checked_at ?? null)}</td>
                        <td className="note-cell">{row.source_note ?? detail?.last_error ?? ""}</td>
                      </tr>
                      {isExpanded ? <tr key={`${row.id}-detail`} className="detail-row"><td colSpan={7}><DetailPanel row={row} /></td></tr> : null}
                    </>;
                  })}
                </tbody>
              </table>
            </div>
            <div className="table-footer"><span>Hiển thị tối đa 250 dòng trong trang này.</span><span><UsersThree size={15} /> Dữ liệu được phân quyền theo tài khoản</span></div>
          </section>
        </main>
      </div>
    </div>
  );
}

function DetailPanel({ row }: { row: TaxpayerRow }) {
  const detail = row.taxpayer;
  return <div className="detail-panel"><div className="detail-title"><div><span>CHI TIẾT MST</span><h3>{detail?.name ?? row.source_vendor_name ?? "Chưa có tên"}</h3></div><span className={statusClass(detail)}>{statusLabel(detail)}</span></div><div className="detail-grid"><DetailItem label="Mã số thuế" value={row.tax_code} mono /><DetailItem label="Loại tổ chức" value={detail?.org_type} /><DetailItem label="Cơ quan thuế" value={detail?.tax_department} /><DetailItem label="Địa chỉ" value={detail?.address} wide /><DetailItem label="Thời điểm nguồn cập nhật" value={formatDate(detail?.source_updated_at ?? null)} /><DetailItem label="Thay đổi trạng thái lúc" value={formatDate(detail?.status_changed_at ?? null)} /></div>{detail?.last_error ? <div className="detail-error"><WarningCircle size={16} /> {detail.last_error}</div> : null}</div>;
}

function DetailItem({ label, value, mono = false, wide = false }: { label: string; value: string | null | undefined; mono?: boolean; wide?: boolean }) {
  return <div className={wide ? "detail-item detail-item-wide" : "detail-item"}><span>{label}</span><strong className={mono ? "mono-value" : ""}>{value || "Chưa có"}</strong></div>;
}

function TableSkeleton() {
  return <>{[1, 2, 3, 4].map((row) => <tr className="skeleton-row" key={row}>{[1, 2, 3, 4, 5, 6, 7].map((cell) => <td key={cell}><span /></td>)}</tr>)}</>;
}

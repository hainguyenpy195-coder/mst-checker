"use client";

import { Fragment, FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {
  ArrowsClockwise,
  CaretRight,
  CheckCircle,
  ClockCounterClockwise,
  DownloadSimple,
  FileText,
  Gear,
  IdentificationCard,
  MagnifyingGlass,
  Plus,
  SignOut,
  SquaresFour,
  Table,
  Trash,
  WarningCircle,
  X,
} from "@phosphor-icons/react";
import { getDashboardHref, getDashboardViewFromPathname, type DashboardView } from "@/lib/dashboard-routes";
import { isValidTaxCode, normalizeTaxCode, TAX_CODE_FORMAT_HINT, TAX_CODE_INPUT_PATTERN } from "@/lib/tax-code";

const DEFAULT_YEARS = ["2023", "2024", "2025", "2026"];
const DEFAULT_YEAR = DEFAULT_YEARS[DEFAULT_YEARS.length - 1] ?? "2026";
const PAGE_SIZE = 100;
const MANUAL_REFRESH_INTERVAL_MS = 60_000;
const MAX_CAPTCHA_FAILURES_BEFORE_REFRESH = 5;
type ViewMode = DashboardView;

function getLatestYear(years: string[]) {
  return years.reduce((latest, year) => Number(year) > Number(latest) ? year : latest, DEFAULT_YEAR);
}

type TaxpayerDetail = {
  tax_code: string;
  name: string | null;
  org_type: string | null;
  address: string | null;
  tax_department: string | null;
  status: string | null;
  status_group: string | null;
  source_updated_at: string | null;
  previous_checked_at: string | null;
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

type DeleteTarget = { taxCode: string; name: string | null };
type ManualLookupState = {
  taxCode: string;
  challengeId: string;
  captchaDataUrl: string;
  captcha: string;
  error: string | null;
  captchaFailureCount: number;
  requiresCaptchaRefresh: boolean;
  captchaLimitReached: boolean;
  isSubmitting: boolean;
};
type ActivityRow = {
  id: number;
  action: "taxpayer_added" | "taxpayer_deleted";
  tax_code: string;
  taxpayer_name: string | null;
  source_year: string | null;
  actor_username: string;
  created_at: string;
};
type TaxCodeLookupState = "idle" | "checking" | "ready" | "duplicate" | "unavailable" | "invalid";
type TaxCodeLookupResult = "ready" | "duplicate" | "unavailable" | "invalid" | "stale";
type TaxCodePreviewResponse = {
  exists?: boolean;
  taxCode?: string;
  preview?: { name?: string | null };
  provider?: "xinvoice" | "vietqr";
  message?: string;
  error?: string;
};

type DashboardProps = { username: string };

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

function formatSourceDate(value: string | null) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat("vi-VN", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  }).format(date);
}

function getVietnamQuarter(value: string | Date) {
  const date = typeof value === "string" ? new Date(value) : value;
  if (Number.isNaN(date.getTime())) return null;

  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Ho_Chi_Minh",
    year: "numeric",
    month: "numeric",
  }).formatToParts(date);
  const year = Number(parts.find((part) => part.type === "year")?.value);
  const month = Number(parts.find((part) => part.type === "month")?.value);
  if (!Number.isInteger(year) || !Number.isInteger(month) || month < 1 || month > 12) return null;
  return year * 4 + Math.floor((month - 1) / 3);
}

function isSourceDataStale(value: string | null) {
  if (!value) return false;
  const sourceQuarter = getVietnamQuarter(value);
  const currentQuarter = getVietnamQuarter(new Date());
  return sourceQuarter !== null && currentQuarter !== null && sourceQuarter < currentQuarter;
}

function statusClass(taxpayer: TaxpayerDetail | null) {
  if (taxpayer?.status_group === "active") return "status-badge status-success";
  if (taxpayer?.status_group === "inactive") return "status-badge status-danger";
  return "status-badge status-warning";
}

function matchesTaxpayerQuery(row: TaxpayerRow, needle: string) {
  return !needle || [row.tax_code, row.source_vendor_name, row.taxpayer?.name, row.taxpayer?.status]
    .some((value) => value?.toLowerCase().includes(needle));
}

function activityLabel(action: ActivityRow["action"]) {
  return action === "taxpayer_added" ? "Đã thêm" : "Đã xóa";
}

export default function Dashboard({ username }: DashboardProps) {
  const pathname = usePathname();
  const router = useRouter();
  const searchParams = useSearchParams();
  const viewMode = getDashboardViewFromPathname(pathname);
  const requestedYear = searchParams.get("year");
  const routeYear = requestedYear && /^\d{4}$/.test(requestedYear) ? requestedYear : null;
  const [years, setYears] = useState<string[]>(DEFAULT_YEARS);
  const [selectedYear, setSelectedYear] = useState(routeYear ?? DEFAULT_YEAR);
  const [rows, setRows] = useState<TaxpayerRow[]>([]);
  const [activityRows, setActivityRows] = useState<ActivityRow[]>([]);
  const [isActivityLoading, setIsActivityLoading] = useState(false);
  const [activityError, setActivityError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [expandedRow, setExpandedRow] = useState<number | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isExporting, setIsExporting] = useState(false);
  const [isRefreshingAll, setIsRefreshingAll] = useState(false);
  const [refreshAllProgress, setRefreshAllProgress] = useState<{ processed: number; pending: number } | null>(null);
  const [isAdding, setIsAdding] = useState(false);
  const [updatingTaxCode, setUpdatingTaxCode] = useState<string | null>(null);
  const [isStartingManualLookup, setIsStartingManualLookup] = useState(false);
  const [manualLookup, setManualLookup] = useState<ManualLookupState | null>(null);
  const [showAddForm, setShowAddForm] = useState(false);
  const [statusFilter, setStatusFilter] = useState("all");
  const [newTaxCode, setNewTaxCode] = useState("");
  const [newName, setNewName] = useState("");
  const [newYear, setNewYear] = useState("2026");
  const [newNote, setNewNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<DeleteTarget | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);
  const [taxCodeLookupState, setTaxCodeLookupState] = useState<TaxCodeLookupState>("idle");
  const [taxCodeLookupMessage, setTaxCodeLookupMessage] = useState<string | null>(null);
  const [checkedTaxCode, setCheckedTaxCode] = useState<string | null>(null);
  const [currentPage, setCurrentPage] = useState(1);
  const taxCodeLookupSequence = useRef(0);
  const taxCodeLookupRequest = useRef<{ taxCode: string; promise: Promise<TaxCodeLookupResult> } | null>(null);
  const refreshAllLock = useRef(false);
  const searchInputRef = useRef<HTMLInputElement>(null);

  const activeYear = viewMode === "sheets" ? selectedYear : viewMode === "overview" ? "all" : null;
  const latestYear = getLatestYear(years);
  const isDataView = viewMode === "overview" || viewMode === "sheets";

  useEffect(() => {
    if (viewMode !== "sheets") return;

    const nextYear = routeYear ?? latestYear;
    setSelectedYear(nextYear);
    if (requestedYear !== nextYear) {
      router.replace(getDashboardHref("sheets", nextYear), { scroll: false });
    }
  }, [latestYear, requestedYear, routeYear, router, viewMode]);

  function navigateToView(nextView: ViewMode, year?: string) {
    setError(null);
    if (nextView === "activity" || nextView === "settings") closeAddForm();

    const href = getDashboardHref(nextView, nextView === "sheets" ? year ?? latestYear : undefined);
    const currentQuery = searchParams.toString();
    const currentHref = `${pathname}${currentQuery ? `?${currentQuery}` : ""}`;
    if (currentHref !== href) router.push(href, { scroll: false });
  }

  function selectYear(year: string) {
    setSelectedYear(year);
    navigateToView("sheets", year);
  }

  async function loadData() {
    if (!activeYear) return;
    setIsLoading(true);
    setError(null);
    try {
      const response = await fetch(`/api/taxpayers?year=${encodeURIComponent(activeYear)}&limit=5000`, { cache: "no-store" });
      const payload = await response.json() as { rows?: TaxpayerRow[]; years?: string[]; error?: string };
      if (!response.ok) throw new Error(payload.error ?? "Không thể tải danh sách.");
      setRows(payload.rows ?? []);
      if (payload.years?.length) {
        setYears(payload.years);
        if (viewMode === "sheets" && !payload.years.includes(selectedYear)) {
          const fallbackYear = getLatestYear(payload.years);
          setSelectedYear(fallbackYear);
          router.replace(getDashboardHref("sheets", fallbackYear), { scroll: false });
        }
      }
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Không thể tải danh sách.");
      setRows([]);
    } finally {
      setIsLoading(false);
    }
  }

  function patchTaxpayerDetail(taxCode: string, taxpayer: TaxpayerDetail | null | undefined) {
    if (!taxpayer) return;
    setRows((currentRows) => currentRows.map((row) => row.tax_code === taxCode ? { ...row, taxpayer } : row));
  }

  async function loadActivity() {
    setIsActivityLoading(true);
    setActivityError(null);
    try {
      const response = await fetch("/api/activity?limit=100", { cache: "no-store" });
      const payload = await response.json() as { rows?: ActivityRow[]; error?: string };
      if (!response.ok) throw new Error(payload.error ?? "Không thể tải lịch sử thao tác.");
      setActivityRows(payload.rows ?? []);
    } catch (loadError) {
      setActivityError(loadError instanceof Error ? loadError.message : "Không thể tải lịch sử thao tác.");
      setActivityRows([]);
    } finally {
      setIsActivityLoading(false);
    }
  }

  useEffect(() => {
    if (viewMode === "activity") void loadActivity();
    else if (viewMode !== "settings") void loadData();
    // The active year is the intended refresh boundary for this dashboard.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeYear, viewMode]);

  useEffect(() => {
    if (!notice) return;
    const timeout = window.setTimeout(() => setNotice(null), 4500);
    return () => window.clearTimeout(timeout);
  }, [notice]);

  const displayRows = useMemo(() => {
    if (viewMode !== "overview") return rows;

    const uniqueRows = new Map<string, TaxpayerRow>();
    for (const row of rows) {
      const existing = uniqueRows.get(row.tax_code);
      if (!existing) {
        uniqueRows.set(row.tax_code, { ...row, source_sheet: row.source_year ?? row.source_sheet });
        continue;
      }

      const sourceLabels = new Set(
        existing.source_sheet.split(", ").filter(Boolean),
      );
      sourceLabels.add(row.source_year ?? row.source_sheet);
      existing.source_sheet = [...sourceLabels].join(", ");
      if (!existing.source_vendor_name && row.source_vendor_name) existing.source_vendor_name = row.source_vendor_name;
      if (!existing.source_note && row.source_note) existing.source_note = row.source_note;
    }
    return [...uniqueRows.values()];
  }, [rows, viewMode]);

  const filteredRows = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return displayRows.filter((row) => {
      const matchesText = matchesTaxpayerQuery(row, needle);
      const matchesStatus = statusFilter === "all"
        || (statusFilter === "error" && Boolean(row.taxpayer?.last_error))
        || (row.taxpayer?.status_group ?? "unknown") === statusFilter;
      return matchesText && matchesStatus;
    });
  }, [displayRows, query, statusFilter]);

  const mobileLookupRows = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return [];
    return displayRows.filter((row) => matchesTaxpayerQuery(row, needle));
  }, [displayRows, query]);

  useEffect(() => {
    setCurrentPage(1);
    setExpandedRow(null);
  }, [activeYear, query, statusFilter]);

  const totalPages = Math.max(1, Math.ceil(filteredRows.length / PAGE_SIZE));
  const safePage = Math.min(currentPage, totalPages);
  const pagedRows = useMemo(() => {
    const start = (safePage - 1) * PAGE_SIZE;
    return filteredRows.slice(start, start + PAGE_SIZE);
  }, [filteredRows, safePage]);
  const pageStart = filteredRows.length ? (safePage - 1) * PAGE_SIZE + 1 : 0;
  const pageEnd = Math.min(safePage * PAGE_SIZE, filteredRows.length);

  async function search(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!query.trim()) return;
    navigateToView("overview");
  }

  function clearSearch(restoreFocus = true) {
    setQuery("");
    if (restoreFocus) requestAnimationFrame(() => searchInputRef.current?.focus());
  }

  async function exportWorkbook() {
    if (isExporting) return;
    setIsExporting(true);
    setError(null);
    try {
      const exportYear = viewMode === "overview" ? "all" : selectedYear;
      const response = await fetch(`/api/export?year=${encodeURIComponent(exportYear)}`, { cache: "no-store" });
      if (!response.ok) {
        const payload = await response.json() as { error?: string };
        throw new Error(payload.error ?? "Không thể xuất Excel.");
      }
      const blob = await response.blob();
      const downloadUrl = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = downloadUrl;
      anchor.download = `TAX-ID-Checker-${exportYear}-${new Date().toISOString().slice(0, 10)}.xlsx`;
      anchor.click();
      setTimeout(() => URL.revokeObjectURL(downloadUrl), 1000);
    } catch (exportError) {
      setError(exportError instanceof Error ? exportError.message : "Không thể xuất Excel.");
    } finally {
      setIsExporting(false);
    }
  }

  function waitForManualRefresh() {
    return new Promise<void>((resolve) => window.setTimeout(resolve, MANUAL_REFRESH_INTERVAL_MS));
  }

  async function refreshAllTaxpayers() {
    if (refreshAllLock.current) return;

    refreshAllLock.current = true;
    setIsRefreshingAll(true);
    setRefreshAllProgress({ processed: 0, pending: 0 });
    setError(null);
    setNotice(null);

    let mode: "start" | "continue" = "start";
    let processedTotal = 0;
    let skippedTotal = 0;
    try {
      while (true) {
        const response = await fetch("/api/taxpayers/refresh-all", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ mode }),
          cache: "no-store",
        });
        const payload = await response.json() as {
          error?: string;
          done?: boolean;
          processed?: number;
          pending?: number;
          skipped?: number;
          queue?: { dead_letter?: number };
        };
        if (!response.ok && response.status !== 202) throw new Error(payload.error ?? "Không thể bắt đầu cập nhật toàn bộ.");

        processedTotal += payload.processed ?? 0;
        skippedTotal += payload.skipped ?? 0;
        const pending = payload.pending ?? 0;
        setRefreshAllProgress({ processed: processedTotal, pending });
        if (payload.done || pending === 0) {
          await loadData();
          const deadLetterCount = payload.queue?.dead_letter ?? 0;
          const skippedMessage = skippedTotal ? ` Bỏ qua ${skippedTotal.toLocaleString("vi-VN")} MST vì dữ liệu endpoint cũ hơn DB.` : "";
          setNotice(deadLetterCount
            ? `Đã xử lý xong hàng đợi. Còn ${deadLetterCount.toLocaleString("vi-VN")} MST lỗi cần kiểm tra lại.${skippedMessage}`
            : `Đã cập nhật toàn bộ ${processedTotal.toLocaleString("vi-VN")} lượt MST.${skippedMessage}`);
          break;
        }

        mode = "continue";
        await waitForManualRefresh();
      }
    } catch (refreshAllError) {
      setError(refreshAllError instanceof Error ? refreshAllError.message : "Không thể cập nhật toàn bộ.");
    } finally {
      refreshAllLock.current = false;
      setIsRefreshingAll(false);
    }
  }

  async function signOut() {
    await fetch("/api/auth/logout", { method: "POST" });
    window.location.href = "/login";
  }

  async function startManualLookup(taxCode: string, replaceExisting = false) {
    if (isStartingManualLookup || (!replaceExisting && manualLookup)) return;

    const continuingAfterCaptchaLimit = replaceExisting && Boolean(manualLookup?.requiresCaptchaRefresh);
    setIsStartingManualLookup(true);
    setUpdatingTaxCode(taxCode);
    setError(null);
    setNotice(null);
    try {
      const response = await fetch("/api/taxpayer/manual-lookup", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "start", taxCode }),
        cache: "no-store",
      });
      const payload = await response.json().catch(() => ({})) as {
        error?: string;
        challengeId?: string;
        taxCode?: string;
        captchaDataUrl?: string;
      };
      if (!response.ok) throw new Error(payload.error ?? "Không thể mở phiên tra cứu Cục Thuế.");
      if (!payload.challengeId || !payload.captchaDataUrl) throw new Error("Cục Thuế chưa trả về mã CAPTCHA.");

      setManualLookup({
        taxCode: payload.taxCode ?? taxCode,
        challengeId: payload.challengeId,
        captchaDataUrl: payload.captchaDataUrl,
        captcha: "",
        error: null,
        captchaFailureCount: 0,
        requiresCaptchaRefresh: false,
        captchaLimitReached: continuingAfterCaptchaLimit,
        isSubmitting: false,
      });
    } catch (lookupError) {
      setError(lookupError instanceof Error ? lookupError.message : "Không thể mở phiên tra cứu Cục Thuế.");
    } finally {
      setIsStartingManualLookup(false);
      setUpdatingTaxCode((current) => current === taxCode ? null : current);
    }
  }

  async function submitManualLookup() {
    if (!manualLookup || manualLookup.isSubmitting) return;
    const currentLookup = manualLookup;
    if (!currentLookup.captcha.trim()) {
      setManualLookup((current) => current ? { ...current, error: "Vui lòng nhập mã CAPTCHA." } : current);
      return;
    }

    setManualLookup((current) => current ? { ...current, error: null, isSubmitting: true } : current);
    setError(null);
    try {
      const response = await fetch("/api/taxpayer/manual-lookup", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: "submit",
          taxCode: currentLookup.taxCode,
          challengeId: currentLookup.challengeId,
          captcha: currentLookup.captcha,
        }),
        cache: "no-store",
      });
      const payload = await response.json().catch(() => ({})) as {
        error?: string;
        message?: string;
        captchaDataUrl?: string;
        captchaInvalid?: boolean;
        retryRequired?: boolean;
        taxpayer?: TaxpayerDetail;
      };

      if (response.status === 422 && (payload.captchaInvalid || payload.retryRequired)) {
        if (payload.captchaInvalid && currentLookup.captchaLimitReached) {
          setManualLookup(null);
          setError("Cục Thuế đang bận, vui lòng thử lại sau ít phút.");
          return;
        }

        setManualLookup((current) => {
          if (!current) return current;
          const captchaFailureCount = current.captchaFailureCount
            + (payload.captchaInvalid ? 1 : 0);
          const requiresCaptchaRefresh = captchaFailureCount >= MAX_CAPTCHA_FAILURES_BEFORE_REFRESH;
          return {
            ...current,
            captchaDataUrl: payload.captchaDataUrl ?? current.captchaDataUrl,
            captcha: "",
            error: payload.captchaInvalid
              ? requiresCaptchaRefresh
                ? `Cục Thuế đã từ chối CAPTCHA ${MAX_CAPTCHA_FAILURES_BEFORE_REFRESH} lần. Vui lòng bấm \"Mã khác\" để đổi CAPTCHA trước khi tiếp tục.`
                : `Cục Thuế từ chối mã CAPTCHA. Vui lòng nhập lại theo ảnh mới (lần thử ${captchaFailureCount}/${MAX_CAPTCHA_FAILURES_BEFORE_REFRESH}).`
              : payload.error ?? "Cục Thuế trả về dữ liệu chưa hoàn chỉnh. Vui lòng thử lại.",
            captchaFailureCount,
            requiresCaptchaRefresh,
            captchaLimitReached: current.captchaLimitReached,
            isSubmitting: false,
          };
        });
        return;
      }
      if (response.status === 410) {
        setManualLookup(null);
        throw new Error(payload.error ?? "Phiên CAPTCHA đã hết hạn. Vui lòng thử lại.");
      }
      if (response.status === 404) {
        setManualLookup(null);
        setError(payload.error ?? "Cục Thuế không tìm thấy thông tin cho MST này.");
        return;
      }
      if (!response.ok) throw new Error(payload.error ?? "Không thể hoàn tất tra cứu Cục Thuế.");

      setManualLookup(null);
      patchTaxpayerDetail(currentLookup.taxCode, payload.taxpayer);
      setNotice(payload.message ?? "Đã hoàn tất tra cứu Cục Thuế.");
    } catch (lookupError) {
      setManualLookup((current) => current ? {
        ...current,
        error: lookupError instanceof Error ? lookupError.message : "Không thể hoàn tất tra cứu Cục Thuế.",
        isSubmitting: false,
      } : current);
    }
  }

  async function refreshTaxpayer(row: TaxpayerRow) {
    if (updatingTaxCode || isStartingManualLookup || manualLookup) return;
    await startManualLookup(row.tax_code);
  }

  function resetTaxCodeLookup(clearName = false) {
    taxCodeLookupSequence.current += 1;
    taxCodeLookupRequest.current = null;
    setTaxCodeLookupState("idle");
    setTaxCodeLookupMessage(null);
    setCheckedTaxCode(null);
    if (clearName) setNewName("");
  }

  function handleTaxCodeChange(value: string) {
    setNewTaxCode(value);
    resetTaxCodeLookup(true);
  }

  async function checkNewTaxCode(value: string): Promise<TaxCodeLookupResult> {
    const taxCode = normalizeTaxCode(value);
    if (!taxCode) {
      resetTaxCodeLookup();
      return "invalid";
    }
    if (!isValidTaxCode(taxCode)) {
      taxCodeLookupSequence.current += 1;
      taxCodeLookupRequest.current = null;
      setCheckedTaxCode(null);
      setTaxCodeLookupState("invalid");
      setTaxCodeLookupMessage("Mã số thuế chưa đúng định dạng. Vui lòng kiểm tra lại trước khi lưu.");
      return "invalid";
    }

    const pendingRequest = taxCodeLookupRequest.current;
    if (pendingRequest?.taxCode === taxCode) return pendingRequest.promise;
    if (checkedTaxCode === taxCode && taxCodeLookupState === "ready") return "ready";
    if (checkedTaxCode === taxCode && taxCodeLookupState === "duplicate") return "duplicate";

    const requestId = taxCodeLookupSequence.current + 1;
    taxCodeLookupSequence.current = requestId;
    setNewTaxCode(taxCode);
    setCheckedTaxCode(taxCode);
    setTaxCodeLookupState("checking");
    setTaxCodeLookupMessage("Đang kiểm tra MST và tra cứu tên doanh nghiệp...");
    setError(null);

    const requestPromise = (async (): Promise<TaxCodeLookupResult> => {
      try {
        const response = await fetch("/api/taxpayers/preview", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ taxCode }),
        });
        const payload = await response.json().catch(() => ({})) as TaxCodePreviewResponse;
        if (requestId !== taxCodeLookupSequence.current) return "stale";

        if (payload.exists) {
          setTaxCodeLookupState("duplicate");
          setTaxCodeLookupMessage(payload.message ?? `Mã số thuế ${taxCode} đã tồn tại trong danh mục, không thể thêm trùng.`);
          return "duplicate";
        }
        if (!response.ok) {
          setTaxCodeLookupState("unavailable");
          setTaxCodeLookupMessage(payload.error ?? "Chưa thể tra cứu dữ liệu tự động. Bạn có thể nhập tên thủ công rồi lưu MST.");
          return "unavailable";
        }

        const name = payload.preview?.name?.trim();
        if (!name) {
          setTaxCodeLookupState("unavailable");
          setTaxCodeLookupMessage("Không nhận được tên người nộp thuế từ endpoint. Bạn có thể nhập tên thủ công rồi lưu MST.");
          return "unavailable";
        }

        setNewName(name);
        setTaxCodeLookupState("ready");
        setTaxCodeLookupMessage(`Đã tra cứu ${payload.provider === "vietqr" ? "VietQR" : "XInvoice"} và tự điền tên người nộp thuế.`);
        return "ready";
      } catch {
        if (requestId !== taxCodeLookupSequence.current) return "stale";
        setTaxCodeLookupState("unavailable");
        setTaxCodeLookupMessage("Chưa thể tra cứu dữ liệu tự động. Bạn có thể nhập tên thủ công rồi lưu MST.");
        return "unavailable";
      }
    })();

    taxCodeLookupRequest.current = { taxCode, promise: requestPromise };
    void requestPromise.then(() => {
      if (taxCodeLookupRequest.current?.promise === requestPromise) taxCodeLookupRequest.current = null;
    });
    return requestPromise;
  }

  async function addTaxpayer(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const taxCode = normalizeTaxCode(newTaxCode);
    const pendingRequest = taxCodeLookupRequest.current;
    const lookupResult = pendingRequest?.taxCode === taxCode
      ? await pendingRequest.promise
      : await checkNewTaxCode(taxCode);
    if (["duplicate", "invalid", "stale"].includes(lookupResult)) return;

    setIsAdding(true);
    setError(null);
    try {
      const response = await fetch("/api/taxpayers", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ taxCode, name: newName, year: newYear, note: newNote }),
      });
      const payload = await response.json() as { error?: string; refreshWarning?: string; activityWarning?: string };
      if (!response.ok) throw new Error(payload.error ?? "Không thể thêm MST.");
      setShowAddForm(false);
      setNewTaxCode("");
      setNewName("");
      setNewNote("");
      resetTaxCodeLookup();
      setSelectedYear(newYear);
      navigateToView("sheets", newYear);
      setNotice(`Đã thêm MST ${taxCode} vào năm ${newYear}.`);
      await loadData();
      const warnings = [payload.refreshWarning, payload.activityWarning].filter(Boolean);
      if (warnings.length) setError(warnings.join(" "));
    } catch (addError) {
      setError(addError instanceof Error ? addError.message : "Không thể thêm MST.");
    } finally {
      setIsAdding(false);
    }
  }

  function toggleAddForm() {
    const nextVisible = !showAddForm;
    setShowAddForm(nextVisible);
    setError(null);
    if (!nextVisible) resetTaxCodeLookup();
  }

  function closeAddForm() {
    setShowAddForm(false);
    resetTaxCodeLookup();
  }

  function openDeleteDialog(row: TaxpayerRow) {
    setDeleteTarget({
      taxCode: row.tax_code,
      name: row.taxpayer?.name ?? row.source_vendor_name ?? null,
    });
    setDeleteError(null);
    setError(null);
    setNotice(null);
  }

  async function deleteTaxpayer() {
    if (!deleteTarget || isDeleting) return;

    setIsDeleting(true);
    setDeleteError(null);
    try {
      const response = await fetch("/api/taxpayers", {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ taxCode: deleteTarget.taxCode, confirmed: true }),
      });
      const payload = await response.json() as { error?: string; message?: string; activityWarning?: string };
      if (!response.ok) throw new Error(payload.error ?? "Không thể xóa MST.");

      const deletedTaxCode = deleteTarget.taxCode;
      setExpandedRow(null);
      setDeleteTarget(null);
      setNotice(payload.message ?? `Đã xóa MST ${deletedTaxCode} khỏi danh mục.`);
      await loadData();
      if (payload.activityWarning) setError(payload.activityWarning);
    } catch (deleteRequestError) {
      setDeleteError(deleteRequestError instanceof Error ? deleteRequestError.message : "Không thể xóa MST.");
    } finally {
      setIsDeleting(false);
    }
  }

  const navItems = [
    { label: "Tổng hợp", icon: SquaresFour, mode: "overview" as ViewMode },
    { label: "Theo năm", icon: Table, mode: "sheets" as ViewMode },
    { label: "Lịch sử", icon: ClockCounterClockwise, mode: "activity" as ViewMode },
  ];
  return (
    <div className="dashboard-frame">
      <aside className="dashboard-sidebar">
        <div className="sidebar-brand">
          <AttechLogo />
        </div>
        <div className="sidebar-section-label">WORKSPACE</div>
        <nav className="sidebar-nav" aria-label="Điều hướng chính">
          {navItems.map(({ label, icon: Icon, mode }) => (
            <button
              className={`sidebar-link ${viewMode === mode ? "sidebar-link-active" : ""}`}
              key={label}
              type="button"
              onClick={() => {
                navigateToView(mode);
              }}
            >
              <Icon size={18} weight="regular" />
              <span>{label}</span>
            </button>
          ))}
        </nav>
        <div className="sidebar-section-label sidebar-section-spaced">HỆ THỐNG</div>
        <nav className="sidebar-nav" aria-label="Hệ thống">
          <button className={`sidebar-link sidebar-link-settings ${viewMode === "settings" ? "sidebar-link-active" : ""}`} type="button" onClick={() => navigateToView("settings")}><Gear size={18} /> <span>Cấu hình</span></button>
        </nav>
      </aside>

      <div className="dashboard-main">
        <header className="dashboard-topbar">
          <div className="header-app-identity">
            <span className="header-app-icon" aria-hidden="true"><IdentificationCard size={20} weight="duotone" /></span>
            <div>
              <strong>TAX ID Checker</strong>
              <span>Kiểm tra tình trạng mã số thuế nhà cung ứng tiềm năng</span>
            </div>
          </div>
          <div className="topbar-actions">
            <div className="user-chip"><span className="user-avatar">{(username[0] ?? "U").toUpperCase()}</span><span>{username}</span></div>
            <button className="icon-button" type="button" aria-label="Đăng xuất" onClick={signOut}><SignOut size={18} /></button>
          </div>
        </header>

        <main className="dashboard-content">
          <div className={`page-heading-row ${isDataView ? "desktop-page-heading" : ""}`}>
            <div>
              <h1>{viewMode === "overview" ? "Bảng tổng hợp" : viewMode === "sheets" ? `Danh sách MST năm ${selectedYear}` : viewMode === "activity" ? "Lịch sử thao tác" : "Cấu hình"}</h1>
            </div>
            {viewMode === "overview" || viewMode === "sheets" ? <div className="heading-actions">
              <button className="outline-button" type="button" onClick={toggleAddForm} disabled={isRefreshingAll}><Plus size={17} /> Thêm MST</button>
              <button className="export-button" type="button" onClick={() => void exportWorkbook()} disabled={isExporting || isRefreshingAll}><DownloadSimple size={17} /> {isExporting ? "Đang xuất" : "Xuất Excel"}</button>
            </div> : null}
          </div>

          {showAddForm ? <form className="add-panel" onSubmit={addTaxpayer}><div className="add-panel-heading"><div><strong>Thêm mã số thuế vào danh mục</strong><span>MST mới sẽ được đưa vào hàng đợi cập nhật.</span></div><button className="icon-button" type="button" aria-label="Đóng form" onClick={closeAddForm}>×</button></div><div className="add-grid"><label>Mã số thuế<input value={newTaxCode} onChange={(event) => handleTaxCodeChange(event.target.value)} onBlur={() => { void checkNewTaxCode(newTaxCode); }} placeholder="0101248141 hoặc 0105029292-022" pattern={TAX_CODE_INPUT_PATTERN} maxLength={14} title={TAX_CODE_FORMAT_HINT} aria-invalid={taxCodeLookupState === "duplicate" || taxCodeLookupState === "invalid"} aria-describedby={taxCodeLookupMessage ? "tax-code-lookup-status" : undefined} required /></label><label>Tên người nộp thuế<input value={newName} onChange={(event) => setNewName(event.target.value)} placeholder="Tên doanh nghiệp" /></label><label>Năm theo dõi<input value={newYear} onChange={(event) => setNewYear(event.target.value)} inputMode="numeric" pattern="[0-9]{4}" maxLength={4} required /></label><label>Ghi chú<input value={newNote} onChange={(event) => setNewNote(event.target.value)} placeholder="Thông tin bổ sung (nếu có)" /></label></div>{taxCodeLookupMessage ? <div className={`add-lookup-status add-lookup-status-${taxCodeLookupState}`} id="tax-code-lookup-status" role={taxCodeLookupState === "duplicate" || taxCodeLookupState === "invalid" ? "alert" : "status"}>{taxCodeLookupState === "checking" ? <ArrowsClockwise size={16} className="update-icon-spinning" /> : taxCodeLookupState === "ready" ? <CheckCircle size={16} /> : <WarningCircle size={16} />}<span>{taxCodeLookupMessage}</span></div> : null}<div className="add-panel-actions"><button className="outline-button" type="button" onClick={closeAddForm}>Hủy</button><button className="export-button" type="submit" disabled={isAdding || taxCodeLookupState === "checking" || taxCodeLookupState === "duplicate"}>{isAdding ? "Đang thêm..." : "Lưu MST"}</button></div></form> : null}

          {notice ? <div className="page-notice page-notice-success" role="status"><CheckCircle size={18} /> {notice}</div> : null}

          {viewMode === "settings" ? <EndpointSettingsPanel onRefreshAll={() => void refreshAllTaxpayers()} isRefreshingAll={isRefreshingAll} refreshAllProgress={refreshAllProgress} /> : null}

          {viewMode === "activity" ? <ActivityPanel rows={activityRows} isLoading={isActivityLoading} error={activityError} /> : null}

          {isDataView ? <>
          <MobileLookupPanel
            viewMode={viewMode}
            selectedYear={selectedYear}
            lookupRows={mobileLookupRows}
            query={query}
            isLoading={isLoading}
            isRefreshingAll={isRefreshingAll}
            isStartingManualLookup={isStartingManualLookup}
            isManualLookupOpen={Boolean(manualLookup)}
            isDeleting={isDeleting}
            updatingTaxCode={updatingTaxCode}
            expandedRow={expandedRow}
            error={error}
            onQueryChange={(value) => setQuery(value)}
            onSearch={search}
            onClearSearch={() => clearSearch(false)}
            onToggleRow={(rowId) => setExpandedRow((current) => current === rowId ? null : rowId)}
            onRefresh={(row) => void refreshTaxpayer(row)}
            onDelete={openDeleteDialog}
          />
          <section className="table-section desktop-data-table">
            <div className="table-toolbar">
              <div><h2>{viewMode === "overview" ? "Bản ghi tổng hợp" : `MST trong năm ${selectedYear}`}</h2><span>{filteredRows.length ? `Hiển thị ${pageStart}-${pageEnd} / ${filteredRows.length} dòng` : "0 dòng đang hiển thị"}</span></div>
              <div className="toolbar-tools">
                <form className="table-search" onSubmit={search}><MagnifyingGlass size={16} /><input ref={searchInputRef} value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Tìm MST hoặc tên..." aria-label="Tìm kiếm MST hoặc tên" /><button type="button" title="Xóa nội dung tìm kiếm" aria-label="Xóa nội dung tìm kiếm" disabled={!query} onClick={() => clearSearch()}><X size={15} /></button></form>
                <select className="filter-select" value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)} aria-label="Lọc theo tình trạng"><option value="all">Tất cả</option><option value="active">Đang hoạt động</option><option value="inactive">Không hoạt động</option><option value="unknown">Chưa có dữ liệu</option><option value="error">Có lỗi</option></select>
              </div>
            </div>

            {viewMode === "sheets" ? (
              <div className="sheet-tabs" role="tablist" aria-label="Chọn năm">
                {years.map((year) => <button key={year} className={selectedYear === year ? "sheet-tab sheet-tab-active" : "sheet-tab"} type="button" role="tab" aria-selected={selectedYear === year} onClick={() => selectYear(year)}>{year}<span>Năm theo dõi</span></button>)}
              </div>
            ) : null}

            {error ? <div className="table-alert"><WarningCircle size={18} /> {error}</div> : null}
            <div className="table-scroll">
              <table className="data-table">
                <thead><tr><th className="col-expand" /><th>Mã số thuế</th><th>Tên người nộp thuế</th><th>Năm nguồn</th><th>Tình trạng</th><th title="Lần hệ thống tra cứu endpoint gần nhất">Tra cứu lúc</th><th>Nguồn dữ liệu</th></tr></thead>
                <tbody>
                  {isLoading ? <TableSkeleton /> : filteredRows.length === 0 ? <tr><td colSpan={7}><div className="table-empty"><FileText size={26} /><strong>Chưa có dữ liệu để hiển thị</strong><span>Dữ liệu sẽ xuất hiện sau khi migration và seed Supabase hoàn tất.</span></div></td></tr> : pagedRows.map((row) => {
                    const detail = row.taxpayer;
                    const isExpanded = expandedRow === row.id;
                    const sourceIsStale = isSourceDataStale(detail?.source_updated_at ?? null);
                    const refreshTitle = `Tra cứu thủ công tại Cục Thuế cho ${row.tax_code}`;
                    return <Fragment key={row.id}>
                      <tr key={row.id} className={`data-row ${isExpanded ? "data-row-expanded" : ""}`} onClick={() => setExpandedRow(isExpanded ? null : row.id)}>
                        <td className="col-expand"><CaretRight size={16} className={isExpanded ? "caret-open" : ""} /></td>
                        <td className="tax-code-cell"><div className="tax-code-with-action"><span>{row.tax_code}</span><button className="row-update-button" type="button" title={refreshTitle} aria-label={refreshTitle} disabled={Boolean(updatingTaxCode) || isStartingManualLookup || Boolean(manualLookup) || isRefreshingAll} onClick={(event) => { event.stopPropagation(); void refreshTaxpayer(row); }}><ArrowsClockwise size={13} className={updatingTaxCode === row.tax_code ? "update-icon-spinning" : ""} /></button><button className="row-delete-button" type="button" title={`Xóa toàn bộ MST ${row.tax_code}`} aria-label={`Xóa toàn bộ MST ${row.tax_code}`} disabled={isDeleting || isRefreshingAll || Boolean(manualLookup)} onClick={(event) => { event.stopPropagation(); openDeleteDialog(row); }}><Trash size={13} /></button></div></td>
                        <td><strong>{detail?.name ?? row.source_vendor_name ?? "Chưa có tên"}</strong>{sourceIsStale ? <small className="stale-source-label">Dữ liệu cũ</small> : null}<small>{detail?.address ?? ""}</small></td>
                        <td><span className="sheet-label">{row.source_sheet}</span></td>
                        <td><span className={statusClass(detail)}>{statusLabel(detail)}</span></td>
                        <td className="date-cell">{formatDate(detail?.last_checked_at ?? null)}</td>
                        <td className="note-cell">{formatSourceDate(detail?.source_updated_at ?? null)}</td>
                      </tr>
                      {isExpanded ? <tr key={`${row.id}-detail`} className="detail-row"><td colSpan={7}><DetailPanel row={row} /></td></tr> : null}
                    </Fragment>;
                  })}
                </tbody>
              </table>
            </div>
            <div className="table-footer"><span>100 dòng/trang</span><div className="pagination-controls" aria-label="Phân trang"><button className="pagination-button" type="button" onClick={() => setCurrentPage((page) => Math.max(1, page - 1))} disabled={safePage <= 1} aria-label="Trang trước">‹</button><span>Trang {safePage} / {totalPages}</span><button className="pagination-button" type="button" onClick={() => setCurrentPage((page) => Math.min(totalPages, page + 1))} disabled={safePage >= totalPages} aria-label="Trang sau">›</button></div></div>
          </section>
          </> : null}
        </main>
        <nav className="mobile-bottom-nav" aria-label="Điều hướng di động">
          {navItems.map(({ label, icon: Icon, mode }) => (
            <button
              className={viewMode === mode ? "mobile-nav-link mobile-nav-link-active" : "mobile-nav-link"}
              key={label}
              type="button"
              aria-current={viewMode === mode ? "page" : undefined}
              onClick={() => navigateToView(mode)}
            >
              <Icon size={19} weight="regular" />
              <span>{label}</span>
            </button>
          ))}
          <button
            className={viewMode === "settings" ? "mobile-nav-link mobile-nav-link-active" : "mobile-nav-link"}
            type="button"
            aria-current={viewMode === "settings" ? "page" : undefined}
            onClick={() => navigateToView("settings")}
          >
            <Gear size={19} weight="regular" />
            <span>Cấu hình</span>
          </button>
        </nav>
      </div>
      {manualLookup ? <div className="confirm-backdrop">
        <section className="confirm-dialog manual-lookup-dialog" role="dialog" aria-modal="true" aria-labelledby="manual-lookup-dialog-title" aria-describedby="manual-lookup-dialog-description">
          <div className="manual-lookup-heading"><div className="confirm-dialog-icon manual-lookup-icon"><MagnifyingGlass size={22} weight="duotone" /></div><button className="icon-button" type="button" aria-label="Đóng tra cứu thủ công" disabled={manualLookup.isSubmitting} onClick={() => setManualLookup(null)}><X size={17} /></button></div>
          <h2 id="manual-lookup-dialog-title">Tra cứu trực tiếp Cục Thuế</h2>
          <p id="manual-lookup-dialog-description">MST <strong>{manualLookup.taxCode}</strong>. Nhập mã CAPTCHA trong ảnh để đối chiếu với dữ liệu hiện tại.</p>
          <div className="manual-captcha-box"><img src={manualLookup.captchaDataUrl} alt="Mã CAPTCHA từ trang Cục Thuế" /><button className="outline-button" type="button" disabled={manualLookup.isSubmitting || isStartingManualLookup} onClick={() => void startManualLookup(manualLookup.taxCode, true)}><ArrowsClockwise size={15} className={isStartingManualLookup ? "update-icon-spinning" : ""} /> Mã khác</button></div>
          <label className="manual-captcha-input"><span>Mã xác nhận</span><input value={manualLookup.captcha} onChange={(event) => setManualLookup((current) => current ? { ...current, captcha: event.target.value, error: null } : current)} disabled={manualLookup.requiresCaptchaRefresh} autoComplete="off" autoFocus maxLength={16} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); void submitManualLookup(); } }} /></label>
          {manualLookup.error ? <div className="confirm-error"><WarningCircle size={16} /> {manualLookup.error}</div> : null}
          <div className="confirm-actions"><button className="outline-button" type="button" disabled={manualLookup.isSubmitting} onClick={() => setManualLookup(null)}>Hủy</button><button className="export-button" type="button" disabled={manualLookup.isSubmitting || isStartingManualLookup || manualLookup.requiresCaptchaRefresh} onClick={() => void submitManualLookup()}>{manualLookup.isSubmitting ? "Đang đối chiếu..." : "Tra cứu"}</button></div>
        </section>
      </div> : null}
      {deleteTarget ? <div className="confirm-backdrop">
        <section className="confirm-dialog" role="dialog" aria-modal="true" aria-labelledby="delete-dialog-title" aria-describedby="delete-dialog-description">
          <div className="confirm-dialog-icon"><WarningCircle size={23} weight="duotone" /></div>
          <h2 id="delete-dialog-title">Xóa mã số thuế?</h2>
          <p id="delete-dialog-description">MST <strong>{deleteTarget.taxCode}</strong>{deleteTarget.name ? ` — ${deleteTarget.name}` : ""} sẽ bị xóa khỏi tất cả năm theo dõi, hàng đợi cập nhật và lịch sử trạng thái. Thao tác này không thể hoàn tác.</p>
          {deleteError ? <div className="confirm-error"><WarningCircle size={16} /> {deleteError}</div> : null}
          <div className="confirm-actions"><button className="outline-button" type="button" disabled={isDeleting} onClick={() => { setDeleteTarget(null); setDeleteError(null); }}>Hủy</button><button className="danger-button" type="button" disabled={isDeleting} onClick={() => void deleteTaxpayer()}>{isDeleting ? "Đang xóa..." : "Xóa MST"}</button></div>
        </section>
      </div> : null}
    </div>
  );
}

type MobileLookupPanelProps = {
  viewMode: ViewMode;
  selectedYear: string;
  lookupRows: TaxpayerRow[];
  query: string;
  isLoading: boolean;
  isRefreshingAll: boolean;
  isStartingManualLookup: boolean;
  isManualLookupOpen: boolean;
  isDeleting: boolean;
  updatingTaxCode: string | null;
  expandedRow: number | null;
  error: string | null;
  onQueryChange: (value: string) => void;
  onSearch: (event: FormEvent<HTMLFormElement>) => void;
  onClearSearch: () => void;
  onToggleRow: (rowId: number) => void;
  onRefresh: (row: TaxpayerRow) => void;
  onDelete: (row: TaxpayerRow) => void;
};

function MobileLookupPanel({
  viewMode,
  selectedYear,
  lookupRows,
  query,
  isLoading,
  isRefreshingAll,
  isStartingManualLookup,
  isManualLookupOpen,
  isDeleting,
  updatingTaxCode,
  expandedRow,
  error,
  onQueryChange,
  onSearch,
  onClearSearch,
  onToggleRow,
  onRefresh,
  onDelete,
}: MobileLookupPanelProps) {
  const hasTextQuery = Boolean(query.trim());
  const mobileResults = lookupRows.slice(0, 20);

  return <section className="mobile-dashboard" aria-label="Tra cứu nhanh trên di động">
    <form className="mobile-lookup-card" onSubmit={onSearch}>
      <div>
        <span className="mobile-section-eyebrow">TRA CỨU NHANH</span>
        <h2>Tìm nhà cung ứng</h2>
        <p>Tra cứu theo mã số thuế hoặc tên nhà cung ứng.</p>
      </div>
      <div className="mobile-search-box">
        <MagnifyingGlass size={19} aria-hidden="true" />
        <input
          type="search"
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
          placeholder="Mã số thuế hoặc tên nhà cung ứng"
          aria-label="Tra cứu theo mã số thuế hoặc tên nhà cung ứng"
          aria-describedby="mobile-quick-lookup-hint"
          enterKeyHint="search"
        />
        <button type="button" className="mobile-search-clear" aria-label="Xóa nội dung tra cứu" disabled={!query} onClick={onClearSearch}><X size={17} /></button>
      </div>
      <div className="mobile-lookup-footer">
        <span id="mobile-quick-lookup-hint">Kết quả được lọc ngay khi bạn nhập.</span>
        <button className="mobile-search-submit" type="submit">Tra cứu</button>
      </div>
    </form>

    {error ? <div className="mobile-inline-alert" role="alert"><WarningCircle size={18} /> {error}</div> : null}

    <section className="mobile-lookup-results" aria-labelledby="mobile-lookup-results-title" aria-live="polite">
      <div className="mobile-results-heading">
        <div>
          <span className="mobile-section-eyebrow">{viewMode === "sheets" ? `NĂM ${selectedYear}` : "DANH MỤC"}</span>
          <h2 id="mobile-lookup-results-title">Kết quả tra cứu</h2>
        </div>
        {hasTextQuery && !isLoading ? <span className="mobile-results-count">{lookupRows.length.toLocaleString("vi-VN")} kết quả</span> : null}
      </div>

      {isLoading ? <div className="mobile-results-skeleton" aria-label="Đang tải dữ liệu">
        {[1, 2, 3].map((item) => <div key={item} />)}
      </div> : !hasTextQuery ? <div className="mobile-empty-state">
        <MagnifyingGlass size={25} weight="duotone" />
        <strong>Nhập thông tin để bắt đầu</strong>
        <span>Tìm theo MST hoặc tên nhà cung ứng để xem kết quả gọn trên điện thoại.</span>
      </div> : lookupRows.length === 0 ? <div className="mobile-empty-state">
        <FileText size={25} weight="duotone" />
        <strong>Chưa tìm thấy bản ghi phù hợp</strong>
        <span>Thử lại bằng MST, tên nhà cung ứng hoặc thay đổi bộ lọc tình trạng.</span>
      </div> : <div className="mobile-result-list">
        {mobileResults.map((row) => <MobileTaxpayerCard
          key={row.id}
          row={row}
          isExpanded={expandedRow === row.id}
          isUpdating={updatingTaxCode === row.tax_code}
          disableRefresh={Boolean(updatingTaxCode) || isStartingManualLookup || isManualLookupOpen || isRefreshingAll}
          disableDelete={isDeleting || isRefreshingAll || isManualLookupOpen}
          onToggle={() => onToggleRow(row.id)}
          onRefresh={() => onRefresh(row)}
          onDelete={() => onDelete(row)}
        />)}
        {lookupRows.length > mobileResults.length ? <p className="mobile-results-limit">Hiển thị 20 kết quả đầu tiên. Hãy nhập thêm ký tự để thu hẹp kết quả.</p> : null}
      </div>}
    </section>
  </section>;
}

type MobileTaxpayerCardProps = {
  row: TaxpayerRow;
  isExpanded: boolean;
  isUpdating: boolean;
  disableRefresh: boolean;
  disableDelete: boolean;
  onToggle: () => void;
  onRefresh: () => void;
  onDelete: () => void;
};

function MobileTaxpayerCard({ row, isExpanded, isUpdating, disableRefresh, disableDelete, onToggle, onRefresh, onDelete }: MobileTaxpayerCardProps) {
  const detail = row.taxpayer;
  const sourceIsStale = isSourceDataStale(detail?.source_updated_at ?? null);
  const name = detail?.name ?? row.source_vendor_name ?? "Chưa có tên";
  const refreshTitle = `Tra cứu thủ công tại Cục Thuế cho ${row.tax_code}`;

  return <article className={isExpanded ? "mobile-result-card mobile-result-card-expanded" : "mobile-result-card"}>
    <button className="mobile-result-summary" type="button" onClick={onToggle} aria-expanded={isExpanded}>
      <span className="mobile-result-topline"><span className="mobile-tax-code">{row.tax_code}</span><CaretRight size={18} className={isExpanded ? "caret-open" : ""} /></span>
      <strong>{name}</strong>
      <span className="mobile-result-status"><span className={statusClass(detail)}>{statusLabel(detail)}</span>{sourceIsStale ? <em>Dữ liệu nguồn cũ</em> : null}</span>
      <span className="mobile-result-meta">Năm nguồn: {row.source_sheet} · Tra cứu: {formatDate(detail?.last_checked_at ?? null)}</span>
    </button>
    {isExpanded ? <div className="mobile-result-detail">
      <dl className="mobile-detail-list">
        <div><dt>Mã số thuế</dt><dd className="mono-value">{row.tax_code}</dd></div>
        <div><dt>Năm nguồn</dt><dd>{row.source_sheet}</dd></div>
        <div className="mobile-detail-item-wide"><dt>Địa chỉ</dt><dd>{detail?.address ?? "Chưa có"}</dd></div>
        <div><dt>Tra cứu lúc</dt><dd>{formatDate(detail?.last_checked_at ?? null)}</dd></div>
        <div><dt>Nguồn dữ liệu</dt><dd>{formatSourceDate(detail?.source_updated_at ?? null)}</dd></div>
      </dl>
      {detail?.last_error ? <div className="mobile-detail-error"><WarningCircle size={16} /> {detail.last_error}</div> : null}
      <div className="mobile-result-actions">
        <button className="outline-button" type="button" title={refreshTitle} disabled={disableRefresh} onClick={onRefresh}><ArrowsClockwise size={16} className={isUpdating ? "update-icon-spinning" : ""} /> {isUpdating ? "Đang mở CAPTCHA" : "Đối chiếu Cục Thuế"}</button>
        <button className="mobile-delete-action" type="button" disabled={disableDelete} onClick={onDelete}><Trash size={16} /> Xóa</button>
      </div>
    </div> : null}
  </article>;
}

function ActivityPanel({ rows, isLoading, error }: { rows: ActivityRow[]; isLoading: boolean; error: string | null }) {
  return <section className="activity-section">
    <div className="activity-toolbar"><div><h2>Nhật ký danh mục</h2><span>100 thao tác thêm hoặc xóa MST gần nhất.</span></div></div>
    {error ? <div className="table-alert"><WarningCircle size={18} /> {error}</div> : null}
    <div className="table-scroll">
      <table className="activity-table">
        <thead><tr><th>Thời điểm</th><th>Thao tác</th><th>Mã số thuế</th><th>Tên người nộp thuế</th><th>Năm theo dõi</th><th>Người thực hiện</th></tr></thead>
        <tbody>
          {isLoading ? <ActivitySkeleton /> : rows.length === 0 ? <tr><td colSpan={6}><div className="table-empty"><ClockCounterClockwise size={26} /><strong>Chưa có thao tác nào được ghi nhận</strong><span>Các lần thêm hoặc xóa MST sẽ xuất hiện tại đây.</span></div></td></tr> : rows.map((row) => <tr key={row.id}><td className="date-cell">{formatDate(row.created_at)}</td><td><span className={`activity-action activity-action-${row.action === "taxpayer_added" ? "added" : "deleted"}`}>{activityLabel(row.action)}</span></td><td className="tax-code-cell">{row.tax_code}</td><td>{row.taxpayer_name ?? "Chưa có tên"}</td><td><span className="sheet-label">{row.source_year ?? "—"}</span></td><td>{row.actor_username}</td></tr>)}
        </tbody>
      </table>
    </div>
    <div className="mobile-activity-list" aria-live="polite">
      {isLoading ? <>{[1, 2, 3].map((item) => <div className="mobile-activity-skeleton" key={item}><span /><span /><span /></div>)}</> : rows.length === 0 ? <div className="mobile-empty-state"><ClockCounterClockwise size={25} weight="duotone" /><strong>Chưa có thao tác nào được ghi nhận</strong><span>Các lần thêm hoặc xóa MST sẽ xuất hiện tại đây.</span></div> : rows.map((row) => <article className="mobile-activity-card" key={row.id}>
        <div className="mobile-activity-card-topline"><span className={`activity-action activity-action-${row.action === "taxpayer_added" ? "added" : "deleted"}`}>{activityLabel(row.action)}</span><time>{formatDate(row.created_at)}</time></div>
        <strong className="mobile-tax-code">{row.tax_code}</strong>
        <span>{row.taxpayer_name ?? "Chưa có tên"}</span>
        <small>Năm {row.source_year ?? "chưa rõ"} · {row.actor_username}</small>
      </article>)}</div>
  </section>;
}

function ActivitySkeleton() {
  return <>{Array.from({ length: 5 }, (_, index) => <tr className="skeleton-row" key={`activity-skeleton-${index}`}>{Array.from({ length: 6 }, (_, cell) => <td key={cell}><span /></td>)}</tr>)}</>;
}

function DetailPanel({ row }: { row: TaxpayerRow }) {
  const detail = row.taxpayer;
  return <div className="detail-panel"><div className="detail-title"><div><span>CHI TIẾT MST</span><h3>{detail?.name ?? row.source_vendor_name ?? "Chưa có tên"}</h3></div><span className={statusClass(detail)}>{statusLabel(detail)}</span></div><div className="detail-grid"><DetailItem label="Mã số thuế" value={row.tax_code} mono /><DetailItem label="Năm theo dõi" value={row.source_year ?? row.source_sheet} /><DetailItem label="Loại tổ chức" value={detail?.org_type} /><DetailItem label="Cơ quan thuế" value={detail?.tax_department} /><DetailItem label="Địa chỉ" value={detail?.address} wide /><DetailItem label="Dữ liệu lấy từ cục thuế lúc" value={formatDate(detail?.source_updated_at ?? null)} /><DetailItem label="Tra cứu lần trước" value={formatDate(detail?.previous_checked_at ?? null)} /><DetailItem label="Tra cứu lúc" value={formatDate(detail?.last_checked_at ?? null)} /></div>{detail?.last_error ? <div className="detail-error"><WarningCircle size={16} /> {detail.last_error}</div> : null}</div>;
}

function DetailItem({ label, value, mono = false, wide = false }: { label: string; value: string | null | undefined; mono?: boolean; wide?: boolean }) {
  return <div className={wide ? "detail-item detail-item-wide" : "detail-item"}><span>{label}</span><strong className={mono ? "mono-value" : ""}>{value || "Chưa có"}</strong></div>;
}

type EndpointSettingsPanelProps = {
  onRefreshAll: () => void;
  isRefreshingAll: boolean;
  refreshAllProgress: { processed: number; pending: number } | null;
};

function EndpointSettingsPanel({ onRefreshAll, isRefreshingAll, refreshAllProgress }: EndpointSettingsPanelProps) {
  const [primaryEndpoint, setPrimaryEndpoint] = useState("");
  const [fallbackEndpoint, setFallbackEndpoint] = useState("");
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [settingsError, setSettingsError] = useState<string | null>(null);
  const [settingsMessage, setSettingsMessage] = useState<string | null>(null);

  useEffect(() => {
    let isCurrent = true;
    void fetch("/api/settings/endpoints", { cache: "no-store" })
      .then(async (response) => {
        const payload = await response.json() as { primaryEndpoint?: string; fallbackEndpoint?: string; error?: string };
        if (!response.ok) throw new Error(payload.error ?? "Không thể tải cấu hình endpoint.");
        if (!isCurrent) return;
        setPrimaryEndpoint(payload.primaryEndpoint ?? "");
        setFallbackEndpoint(payload.fallbackEndpoint ?? "");
      })
      .catch((loadError) => {
        if (isCurrent) setSettingsError(loadError instanceof Error ? loadError.message : "Không thể tải cấu hình endpoint.");
      })
      .finally(() => {
        if (isCurrent) setIsLoading(false);
      });
    return () => {
      isCurrent = false;
    };
  }, []);

  async function saveSettings(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setIsSaving(true);
    setSettingsError(null);
    setSettingsMessage(null);
    try {
      const response = await fetch("/api/settings/endpoints", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ primaryEndpoint, fallbackEndpoint }),
      });
      const payload = await response.json() as { error?: string };
      if (!response.ok) throw new Error(payload.error ?? "Không thể lưu cấu hình endpoint.");
      setSettingsMessage("Đã lưu cấu hình endpoint. Worker sẽ dùng cấu hình mới ở lượt chạy tiếp theo.");
    } catch (saveError) {
      setSettingsError(saveError instanceof Error ? saveError.message : "Không thể lưu cấu hình endpoint.");
    } finally {
      setIsSaving(false);
    }
  }

  return <section className="settings-panel" aria-labelledby="endpoint-settings-title"><div className="settings-heading"><h2 id="endpoint-settings-title">Endpoint</h2><button className="outline-button" type="button" onClick={onRefreshAll} disabled={isRefreshingAll}><ArrowsClockwise size={17} className={isRefreshingAll ? "update-icon-spinning" : ""} /> {isRefreshingAll ? `Đang cập nhật${refreshAllProgress ? ` (${refreshAllProgress.processed} / còn ${refreshAllProgress.pending})` : "..."}` : "Cập nhật toàn bộ"}</button></div>{isLoading ? <div className="settings-loading">Đang tải cấu hình...</div> : <form className="settings-form" onSubmit={saveSettings}><label><span>Endpoint chính</span><input value={primaryEndpoint} onChange={(event) => setPrimaryEndpoint(event.target.value)} placeholder="https://.../{taxCode}" required /></label><label><span>Endpoint dự phòng</span><input value={fallbackEndpoint} onChange={(event) => setFallbackEndpoint(event.target.value)} placeholder="https://.../{taxCode}" required /></label><div className="settings-actions"><button className="export-button" type="submit" disabled={isSaving}>{isSaving ? "Đang lưu..." : "Lưu cấu hình"}</button></div>{settingsError ? <p className="settings-error"><WarningCircle size={16} /> {settingsError}</p> : null}{settingsMessage ? <p className="settings-success"><CheckCircle size={16} /> {settingsMessage}</p> : null}</form>}</section>;
}

function TableSkeleton() {
  return <>{[1, 2, 3, 4].map((row) => <tr className="skeleton-row" key={row}>{[1, 2, 3, 4, 5, 6, 7].map((cell) => <td key={cell}><span /></td>)}</tr>)}</>;
}

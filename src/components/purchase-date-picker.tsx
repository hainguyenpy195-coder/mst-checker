"use client";

import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { createPortal } from "react-dom";
import { CalendarBlank, CaretLeft, CaretRight, X } from "@phosphor-icons/react";

type PurchaseDatePickerProps = {
  label: string;
  value: string;
  onChange: (value: string) => void;
  min?: string;
  max?: string;
};

const WEEKDAY_LABELS = [
  { short: "T2", long: "Thứ Hai" },
  { short: "T3", long: "Thứ Ba" },
  { short: "T4", long: "Thứ Tư" },
  { short: "T5", long: "Thứ Năm" },
  { short: "T6", long: "Thứ Sáu" },
  { short: "T7", long: "Thứ Bảy" },
  { short: "CN", long: "Chủ Nhật" },
];

function parseIsoDate(value?: string) {
  const match = value?.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;

  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  if (
    date.getFullYear() !== Number(match[1]) ||
    date.getMonth() !== Number(match[2]) - 1 ||
    date.getDate() !== Number(match[3])
  ) {
    return null;
  }

  return date;
}

function toIsoDate(date: Date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function vietnamToday() {
  const current = new Date();
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Ho_Chi_Minh",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(current);
  const year = Number(parts.find((part) => part.type === "year")?.value);
  const month = Number(parts.find((part) => part.type === "month")?.value);
  const day = Number(parts.find((part) => part.type === "day")?.value);

  return Number.isInteger(year) && Number.isInteger(month) && Number.isInteger(day)
    ? new Date(year, month - 1, day)
    : current;
}

function formatVietnameseDate(value: string) {
  const date = parseIsoDate(value);
  if (!date) return "dd/MM/yyyy";

  return `${String(date.getDate()).padStart(2, "0")}/${String(date.getMonth() + 1).padStart(2, "0")}/${date.getFullYear()}`;
}

function startOfMonth(date: Date) {
  return new Date(date.getFullYear(), date.getMonth(), 1);
}

function addDays(date: Date, days: number) {
  const next = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  next.setDate(next.getDate() + days);
  return next;
}

function addMonths(date: Date, months: number) {
  return new Date(date.getFullYear(), date.getMonth() + months, 1);
}

function isDateOutOfRange(date: Date, min?: string, max?: string) {
  const isoDate = toIsoDate(date);
  return Boolean((min && isoDate < min) || (max && isoDate > max));
}

function monthHasSelectableDate(month: Date, min?: string, max?: string) {
  const year = month.getFullYear();
  const monthIndex = month.getMonth();
  const numberOfDays = new Date(year, monthIndex + 1, 0).getDate();

  return Array.from({ length: numberOfDays }, (_, index) => new Date(year, monthIndex, index + 1))
    .some((date) => !isDateOutOfRange(date, min, max));
}

function clampDateToRange(date: Date, min?: string, max?: string) {
  const minimum = parseIsoDate(min);
  const maximum = parseIsoDate(max);
  if (minimum && toIsoDate(date) < toIsoDate(minimum)) return minimum;
  if (maximum && toIsoDate(date) > toIsoDate(maximum)) return maximum;
  return date;
}

function visibleCalendarDays(month: Date) {
  const firstDayOfMonth = new Date(month.getFullYear(), month.getMonth(), 1);
  const mondayOffset = (firstDayOfMonth.getDay() + 6) % 7;
  const calendarStart = addDays(firstDayOfMonth, -mondayOffset);

  return Array.from({ length: 42 }, (_, index) => addDays(calendarStart, index));
}

function VietnameseDatePicker({ label, value, onChange, min, max }: PurchaseDatePickerProps) {
  const dialogId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const [isOpen, setIsOpen] = useState(false);
  const [visibleMonth, setVisibleMonth] = useState(() => startOfMonth(clampDateToRange(parseIsoDate(value) ?? vietnamToday(), min, max)));
  const [popoverPosition, setPopoverPosition] = useState<{ top: number; left: number } | null>(null);

  const today = useMemo(() => vietnamToday(), []);
  const todayIso = toIsoDate(today);
  const selectedDate = parseIsoDate(value);
  const calendarDays = useMemo(() => visibleCalendarDays(visibleMonth), [visibleMonth]);
  const previousMonth = useMemo(() => addMonths(visibleMonth, -1), [visibleMonth]);
  const nextMonth = useMemo(() => addMonths(visibleMonth, 1), [visibleMonth]);
  const popoverStyle = popoverPosition
    ? ({ top: popoverPosition.top, left: popoverPosition.left } satisfies CSSProperties)
    : ({ visibility: "hidden" } satisfies CSSProperties);

  const closePicker = useCallback((restoreFocus = false) => {
    setIsOpen(false);
    setPopoverPosition(null);
    if (restoreFocus) window.requestAnimationFrame(() => triggerRef.current?.focus());
  }, []);

  const syncPopoverPosition = useCallback(() => {
    const trigger = rootRef.current;
    if (!trigger) return;

    const rect = trigger.getBoundingClientRect();
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    const popoverWidth = Math.min(324, viewportWidth - 24);
    const desiredTop = rect.bottom + 8;
    const bottomSpacing = 12;
    const estimatedPopoverHeight = 378;
    const top = desiredTop + estimatedPopoverHeight <= viewportHeight - bottomSpacing
      ? desiredTop
      : Math.max(bottomSpacing, rect.top - estimatedPopoverHeight - 8);
    const left = Math.min(
      Math.max(12, rect.right - popoverWidth),
      Math.max(12, viewportWidth - popoverWidth - 12),
    );

    setPopoverPosition({ top, left });
  }, []);

  function openPicker() {
    const initialDate = clampDateToRange(selectedDate ?? vietnamToday(), min, max);
    setVisibleMonth(startOfMonth(initialDate));
    setIsOpen(true);
  }

  function selectDate(date: Date) {
    if (isDateOutOfRange(date, min, max)) return;
    onChange(toIsoDate(date));
    closePicker(true);
  }

  function clearDate() {
    onChange("");
    closePicker(true);
  }

  function moveFocusToDate(date: Date) {
    setVisibleMonth(startOfMonth(date));
    window.requestAnimationFrame(() => {
      const dateButton = document.querySelector<HTMLButtonElement>(`[data-purchase-date="${toIsoDate(date)}"]`);
      dateButton?.focus();
    });
  }

  function nextSelectableDate(date: Date, direction: -1 | 1) {
    let candidate = addDays(date, direction);
    for (let attempts = 0; attempts < 3660; attempts += 1) {
      if (!isDateOutOfRange(candidate, min, max)) return candidate;
      candidate = addDays(candidate, direction);
    }
    return null;
  }

  function handleDateKeyDown(event: ReactKeyboardEvent<HTMLButtonElement>, date: Date) {
    const stepByKey: Record<string, -1 | 1 | -7 | 7> = {
      ArrowLeft: -1,
      ArrowRight: 1,
      ArrowUp: -7,
      ArrowDown: 7,
    };
    const step = stepByKey[event.key];
    if (step) {
      event.preventDefault();
      const direction = step < 0 ? -1 : 1;
      const distance = Math.abs(step);
      let target = date;
      for (let index = 0; index < distance; index += 1) {
        const next = nextSelectableDate(target, direction);
        if (!next) return;
        target = next;
      }
      moveFocusToDate(target);
      return;
    }

    if (event.key === "Escape") {
      event.preventDefault();
      closePicker(true);
    }
  }

  useEffect(() => {
    if (!isOpen) return;

    syncPopoverPosition();
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (rootRef.current?.contains(target) || popoverRef.current?.contains(target)) return;
      closePicker();
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        closePicker(true);
      }
    };
    const handleViewportChange = () => syncPopoverPosition();

    document.addEventListener("pointerdown", handlePointerDown);
    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("resize", handleViewportChange);
    window.addEventListener("scroll", handleViewportChange, true);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("resize", handleViewportChange);
      window.removeEventListener("scroll", handleViewportChange, true);
    };
  }, [closePicker, isOpen, syncPopoverPosition]);

  return <div className="purchase-date-picker" ref={rootRef}>
    <span className="purchase-date-picker-label">{label}</span>
    <div className="purchase-date-picker-control">
      <button
        ref={triggerRef}
        className="purchase-date-picker-trigger"
        type="button"
        aria-label={`${label}: ${value ? formatVietnameseDate(value) : "chưa chọn ngày"}`}
        aria-controls={isOpen ? dialogId : undefined}
        aria-expanded={isOpen}
        aria-haspopup="dialog"
        onClick={() => (isOpen ? closePicker() : openPicker())}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown") {
            event.preventDefault();
            if (!isOpen) openPicker();
          }
        }}
      >
        <CalendarBlank size={15} weight="bold" aria-hidden="true" />
        <span className={value ? undefined : "is-placeholder"}>{formatVietnameseDate(value)}</span>
      </button>
      {value ? <button className="purchase-date-picker-clear" type="button" onClick={clearDate} aria-label={`Xóa ngày ${label}`} title={`Xóa ngày ${label}`}><X size={13} weight="bold" /></button> : null}
    </div>

    {isOpen && typeof document !== "undefined" ? createPortal(
      <div
        ref={popoverRef}
        id={dialogId}
        className="purchase-date-picker-popover"
        role="dialog"
        aria-label={`Chọn ${label.toLocaleLowerCase("vi-VN")}`}
        style={popoverStyle}
      >
        <div className="purchase-date-picker-month-heading">
          <button
            className="purchase-date-picker-month-button"
            type="button"
            onClick={() => setVisibleMonth(previousMonth)}
            disabled={!monthHasSelectableDate(previousMonth, min, max)}
            aria-label="Tháng trước"
          >
            <CaretLeft size={16} weight="bold" />
          </button>
          <strong aria-live="polite">{visibleMonth.toLocaleDateString("vi-VN", { month: "long", year: "numeric" })}</strong>
          <button
            className="purchase-date-picker-month-button"
            type="button"
            onClick={() => setVisibleMonth(nextMonth)}
            disabled={!monthHasSelectableDate(nextMonth, min, max)}
            aria-label="Tháng sau"
          >
            <CaretRight size={16} weight="bold" />
          </button>
        </div>
        <div className="purchase-date-picker-weekdays" aria-hidden="true">
          {WEEKDAY_LABELS.map((day) => <span key={day.short} title={day.long}>{day.short}</span>)}
        </div>
        <div className="purchase-date-picker-days" aria-label={`Lịch ${label.toLocaleLowerCase("vi-VN")}`}>
          {calendarDays.map((date) => {
            const isoDate = toIsoDate(date);
            const isCurrentMonth = date.getMonth() === visibleMonth.getMonth();
            const isSelected = isoDate === value;
            const isToday = isoDate === todayIso;
            const disabled = isDateOutOfRange(date, min, max);
            const accessibleDate = date.toLocaleDateString("vi-VN", { weekday: "long", day: "numeric", month: "long", year: "numeric" });
            return <button
              key={isoDate}
              className={`purchase-date-picker-day${isCurrentMonth ? "" : " is-outside-month"}${isSelected ? " is-selected" : ""}${isToday ? " is-today" : ""}`}
              type="button"
              data-purchase-date={isoDate}
              disabled={disabled}
              aria-label={accessibleDate}
              aria-current={isToday ? "date" : undefined}
              aria-pressed={isSelected}
              onClick={() => selectDate(date)}
              onKeyDown={(event) => handleDateKeyDown(event, date)}
            >
              {date.getDate()}
            </button>;
          })}
        </div>
        <div className="purchase-date-picker-footer">
          <button className="purchase-date-picker-text-button" type="button" onClick={clearDate} disabled={!value}>Xóa</button>
          <button
            className="purchase-date-picker-text-button purchase-date-picker-today-button"
            type="button"
            onClick={() => selectDate(today)}
            disabled={isDateOutOfRange(today, min, max)}
          >
            Hôm nay
          </button>
        </div>
      </div>,
      document.body,
    ) : null}
  </div>;
}

export default VietnameseDatePicker;

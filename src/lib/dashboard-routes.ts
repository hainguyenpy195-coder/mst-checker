export const DASHBOARD_VIEWS = ["overview", "sheets", "activity", "settings"] as const;

export type DashboardView = (typeof DASHBOARD_VIEWS)[number];

export function isDashboardView(value: string): value is DashboardView {
  return (DASHBOARD_VIEWS as readonly string[]).includes(value);
}

export function getDashboardHref(view: DashboardView, year?: string) {
  if (view === "sheets" && year) return `/sheets?year=${encodeURIComponent(year)}`;
  return `/${view}`;
}

export function getDashboardViewFromPathname(pathname: string | null): DashboardView {
  const firstSegment = pathname?.split("/").filter(Boolean)[0];
  return firstSegment && isDashboardView(firstSegment) ? firstSegment : "overview";
}

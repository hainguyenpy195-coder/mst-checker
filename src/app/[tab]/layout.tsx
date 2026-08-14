import type { ReactNode } from "react";
import { cookies } from "next/headers";
import { notFound, redirect } from "next/navigation";
import Dashboard from "@/components/dashboard";
import { APP_SESSION_COOKIE, verifySessionToken } from "@/lib/app-auth";
import { isDashboardView } from "@/lib/dashboard-routes";

export const dynamic = "force-dynamic";

export default async function DashboardTabLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ tab: string }>;
}) {
  const { tab } = await params;
  if (!isDashboardView(tab)) notFound();

  const cookieStore = await cookies();
  const session = await verifySessionToken(cookieStore.get(APP_SESSION_COOKIE)?.value);
  if (!session) redirect("/login");
  if (tab === "settings" && session.role !== "admin") redirect("/overview");

  return <><Dashboard username={session.username} role={session.role} />{children}</>;
}

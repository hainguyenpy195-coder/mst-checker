import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import Dashboard from "@/components/dashboard";
import { APP_SESSION_COOKIE, verifySessionToken } from "@/lib/app-auth";

export const dynamic = "force-dynamic";

export default async function HomePage() {
  const cookieStore = await cookies();
  const session = await verifySessionToken(cookieStore.get(APP_SESSION_COOKIE)?.value);
  if (!session) redirect("/login");

  return (
    <Dashboard
      username={session.username}
    />
  );
}

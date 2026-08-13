import { redirect } from "next/navigation";
import Dashboard from "@/components/dashboard";
import { createClient } from "@/lib/supabase/server";
import type { Profile } from "@/lib/types";

export const dynamic = "force-dynamic";

export default async function HomePage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  const { data: profile } = await supabase
    .from("profiles")
    .select("id, email, display_name, role, approval_status")
    .eq("id", user.id)
    .maybeSingle<Profile>();

  return (
    <Dashboard
      userEmail={user.email ?? profile?.email ?? ""}
      profile={profile}
    />
  );
}

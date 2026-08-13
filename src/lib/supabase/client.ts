import { createBrowserClient } from "@supabase/ssr";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getSupabaseEnv } from "./env";

export function createClient(): SupabaseClient {
  const { url, anonKey } = getSupabaseEnv();
  return createBrowserClient(url, anonKey);
}

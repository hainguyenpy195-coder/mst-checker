import { LocalDatabaseClient } from "@/lib/db/client";

let adminClient: LocalDatabaseClient | null = null;

/**
 * Keep the historical module path so the API routes can migrate in small
 * steps. The self-hosted deployment uses one server-side PostgreSQL client;
 * browser requests never receive this object or the database credentials.
 */
export function createAdminClient() {
  if (!adminClient) adminClient = new LocalDatabaseClient();
  return adminClient;
}

export type SupabaseClient = LocalDatabaseClient;

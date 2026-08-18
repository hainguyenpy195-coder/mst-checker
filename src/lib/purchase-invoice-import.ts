import type { SupabaseClient } from "@/lib/supabase/admin";
import type { PurchaseInvoiceCandidate } from "@/lib/purchase-invoice-types";

export const PURCHASE_INVOICE_IMPORT_BUCKET = "purchase-invoice-imports";
export const PURCHASE_INVOICE_IMPORT_STORAGE_MAX_BYTES = 20 * 1024 * 1024;

const IMPORT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type PurchaseInvoiceImportStatus = "uploading" | "previewed" | "committing" | "completed" | "failed" | "cancelled";

export type PurchaseInvoiceImportSession = {
  id: string;
  storage_path: string;
  file_name: string;
  file_size: number;
  actor_username: string;
  status: PurchaseInvoiceImportStatus;
  candidates: unknown;
  preview_stats: Record<string, unknown>;
  commit_offset: number;
  added_count: number;
  skipped_count: number;
  invalid_count: number;
  error: string | null;
  file_deleted_at: string | null;
  created_at: string;
  previewed_at: string | null;
  completed_at: string | null;
};

export type StoredPurchaseInvoiceCandidate = PurchaseInvoiceCandidate;

export function isPurchaseInvoiceImportId(value: unknown): value is string {
  return typeof value === "string" && IMPORT_ID_PATTERN.test(value);
}

export function getPurchaseInvoiceImportStoragePath(importId: string) {
  return `imports/${importId}.xlsx`;
}

export async function getPurchaseInvoiceImportSession(
  supabase: SupabaseClient,
  importId: string,
  actorUsername: string,
) {
  return supabase
    .from("purchase_invoice_imports")
    .select("*")
    .eq("id", importId)
    .eq("actor_username", actorUsername)
    .maybeSingle<PurchaseInvoiceImportSession>();
}

export async function deletePurchaseInvoiceImportFile(supabase: SupabaseClient, storagePath: string) {
  const { error } = await supabase.storage.from(PURCHASE_INVOICE_IMPORT_BUCKET).remove([storagePath]);
  if (error) {
    console.error("purchase invoice Excel temporary file cleanup failed", error);
    return false;
  }
  return true;
}

export function readStoredPurchaseInvoiceCandidates(value: unknown): StoredPurchaseInvoiceCandidate[] {
  if (!Array.isArray(value)) return [];

  return value.filter((candidate): candidate is StoredPurchaseInvoiceCandidate => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return false;
    const record = candidate as Record<string, unknown>;
    const rowFingerprint = record.row_fingerprint;
    const sourceSheet = record.source_sheet;
    const sourceRow = record.source_row;
    return typeof rowFingerprint === "string"
      && rowFingerprint.trim().length >= 32
      && rowFingerprint.length <= 255
      && typeof sourceSheet === "string"
      && sourceSheet.trim().length > 0
      && Number.isInteger(sourceRow)
      && Number(sourceRow) > 0;
  });
}

import type { SupabaseClient } from "@supabase/supabase-js";
import type { TaxpayerExcelCandidate, TaxpayerExcelUnit } from "@/lib/taxpayer-excel";

export const TAXPAYER_IMPORT_BUCKET = "taxpayer-imports";
export const TAXPAYER_IMPORT_STORAGE_MAX_BYTES = 20 * 1024 * 1024;

const IMPORT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type TaxpayerImportSession = {
  id: string;
  storage_path: string;
  file_name: string;
  file_size: number;
  actor_username: string;
  status: "uploading" | "previewed" | "committing" | "completed" | "failed" | "cancelled";
  candidates: TaxpayerExcelCandidate[];
  source_units: TaxpayerExcelUnit[];
  preview_stats: Record<string, unknown>;
  source_years: string[];
  commit_offset: number;
  added_tax_codes: string[];
  added_count: number;
  updated_count: number;
  failed_count: number;
  error: string | null;
  file_deleted_at: string | null;
  created_at: string;
  previewed_at: string | null;
  completed_at: string | null;
};

export function isTaxpayerImportId(value: unknown): value is string {
  return typeof value === "string" && IMPORT_ID_PATTERN.test(value);
}

export function getTaxpayerImportStoragePath(importId: string) {
  return `imports/${importId}.xlsx`;
}

export async function getTaxpayerImportSession(
  supabase: SupabaseClient,
  importId: string,
  actorUsername: string,
) {
  return supabase
    .from("taxpayer_excel_imports")
    .select("*")
    .eq("id", importId)
    .eq("actor_username", actorUsername)
    .maybeSingle<TaxpayerImportSession>();
}

export async function deleteTaxpayerImportFile(supabase: SupabaseClient, storagePath: string) {
  const { error } = await supabase.storage.from(TAXPAYER_IMPORT_BUCKET).remove([storagePath]);
  if (error) {
    console.error("taxpayer Excel temporary file cleanup failed", error);
    return false;
  }
  return true;
}

export function readStoredCandidates(value: unknown): TaxpayerExcelCandidate[] {
  return Array.isArray(value) ? value as TaxpayerExcelCandidate[] : [];
}

export function readStoredSourceUnits(value: unknown): TaxpayerExcelUnit[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is TaxpayerExcelUnit => {
    if (!item || typeof item !== "object") return false;
    const record = item as Record<string, unknown>;
    return typeof record.sourceYear === "string"
      && /^\d{4}$/.test(record.sourceYear)
      && typeof record.unitKey === "string"
      && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(record.unitKey)
      && typeof record.unitLabel === "string"
      && record.unitLabel.trim().length > 0
      && typeof record.unitMarker === "string"
      && /^(?:I|II|III|IV|V|VI|VII|VIII|IX|X|XI|XII|XIII|XIV|XV|XVI|XVII|XVIII|XIX|XX)(?:\.\s*\d+)?\.?$/i.test(record.unitMarker.trim())
      && Number.isInteger(record.unitOrder)
      && Number(record.unitOrder) > 0;
  });
}

export function getImportSourceYears(candidates: TaxpayerExcelCandidate[]) {
  return [...new Set(candidates.flatMap((candidate) => candidate.sources.map((source) => source.sourceYear)))].sort();
}

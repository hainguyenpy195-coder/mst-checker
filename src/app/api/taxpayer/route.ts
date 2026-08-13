import { NextResponse } from "next/server";
import { authenticateRequest } from "@/lib/app-auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { isValidTaxCode, normalizeTaxCode, TAX_CODE_FORMAT_MESSAGE } from "@/lib/tax-code";
import type { Taxpayer } from "@/lib/types";

const FRESHNESS_MS = 24 * 60 * 60 * 1000;

function isStale(lastCheckedAt: string | null) {
  if (!lastCheckedAt) return true;
  return Date.now() - new Date(lastCheckedAt).getTime() > FRESHNESS_MS;
}

export async function GET(request: Request) {
  if (!(await authenticateRequest(request))) {
    return NextResponse.json({ error: "Bạn cần đăng nhập để tra cứu." }, { status: 401 });
  }

  const requestUrl = new URL(request.url);
  const taxCode = normalizeTaxCode(requestUrl.searchParams.get("taxCode") ?? "");
  if (!isValidTaxCode(taxCode)) {
    return NextResponse.json(
      { error: TAX_CODE_FORMAT_MESSAGE },
      { status: 400 },
    );
  }

  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from("taxpayers")
    .select("tax_code, name, org_type, address, tax_department, status, status_group, source_updated_at, previous_checked_at, last_checked_at, status_changed_at, last_error, next_check_at")
    .eq("tax_code", taxCode)
    .maybeSingle<Taxpayer>();

  if (error) {
    console.error("taxpayer lookup failed", error);
    return NextResponse.json({ error: "Không thể truy vấn dữ liệu lúc này." }, { status: 500 });
  }

  const stale = isStale(data?.last_checked_at ?? null);
  let refreshRequested = false;
  if (data && stale) {
    const { error: refreshError } = await supabase.rpc("request_taxpayer_refresh", { p_tax_code: taxCode });
    refreshRequested = !refreshError;
  }

  return NextResponse.json({ data, meta: { stale, refreshRequested } });
}

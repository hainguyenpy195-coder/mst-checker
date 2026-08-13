import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import type { Taxpayer } from "@/lib/types";

const TAX_CODE_PATTERN = /^\d{9,14}(?:-\d{3})?$/;
const FRESHNESS_MS = 24 * 60 * 60 * 1000;

function normalizeTaxCode(value: string) {
  return value.trim().replace(/\s+/g, "").replace(/[–—]/g, "-");
}

function isStale(lastCheckedAt: string | null) {
  if (!lastCheckedAt) return true;
  return Date.now() - new Date(lastCheckedAt).getTime() > FRESHNESS_MS;
}

export async function GET(request: Request) {
  const requestUrl = new URL(request.url);
  const rawTaxCode = requestUrl.searchParams.get("taxCode") ?? "";
  const taxCode = normalizeTaxCode(rawTaxCode);

  if (!TAX_CODE_PATTERN.test(taxCode)) {
    return NextResponse.json(
      { error: "Mã số thuế phải có 9–14 chữ số, có thể kèm hậu tố chi nhánh dạng -001." },
      { status: 400 },
    );
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Bạn cần đăng nhập để tra cứu." }, { status: 401 });
  }

  const { data: profile } = await supabase
    .from("profiles")
    .select("approval_status")
    .eq("id", user.id)
    .maybeSingle<{ approval_status: string }>();

  if (profile?.approval_status !== "approved") {
    return NextResponse.json(
      { error: "Tài khoản chưa được phê duyệt để sử dụng chức năng tra cứu." },
      { status: 403 },
    );
  }

  const { data, error } = await supabase
    .from("taxpayers")
    .select(
      "tax_code, name, org_type, address, tax_department, status, status_group, source_updated_at, last_checked_at, status_changed_at, last_error, next_check_at",
    )
    .eq("tax_code", taxCode)
    .maybeSingle<Taxpayer>();

  if (error) {
    console.error("taxpayer lookup failed", error);
    return NextResponse.json({ error: "Không thể truy vấn dữ liệu lúc này." }, { status: 500 });
  }

  await supabase.from("lookup_audit_logs").insert({
    user_id: user.id,
    tax_code: taxCode,
    result: data ? "found" : "not_found",
  });

  const stale = isStale(data?.last_checked_at ?? null);
  let refreshRequested = false;

  if (data && stale) {
    const { error: refreshError } = await supabase.rpc("request_taxpayer_refresh", {
      p_tax_code: taxCode,
    });
    refreshRequested = !refreshError;
  }

  return NextResponse.json({
    data,
    meta: { stale, refreshRequested },
  });
}

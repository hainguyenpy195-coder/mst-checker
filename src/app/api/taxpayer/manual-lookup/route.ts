import { NextResponse } from "next/server";
import { authenticateRequest, isAdminSession, READ_ONLY_FORBIDDEN_MESSAGE } from "@/lib/app-auth";
import { createGdtLookupSession, GdtLookupError, refreshGdtCaptcha, submitGdtLookup, type GdtLookupRecord } from "@/lib/gdt-manual-lookup";
import { createAdminClient } from "@/lib/supabase/admin";
import { isValidTaxCode, normalizeTaxCode, TAX_CODE_FORMAT_MESSAGE } from "@/lib/tax-code";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SESSION_TTL_MS = 10 * 60 * 1000;

type ManualLookupSession = {
  id: string;
  username: string;
  tax_code: string;
  upstream_cookie: string;
  expires_at: string;
  candidate_records: GdtLookupRecord[];
};

type CurrentTaxpayer = {
  tax_code: string;
  name: string | null;
  org_type: string | null;
  address: string | null;
  tax_department: string | null;
  status: string | null;
  status_group: string | null;
  source_updated_at: string | null;
  previous_checked_at: string | null;
  last_checked_at: string | null;
  status_changed_at: string | null;
  last_error: string | null;
  consecutive_failures: number;
  needs_manual_review: boolean;
  manual_review_reason: string | null;
  name_source: string;
};

type ManualLookupBody = {
  action?: "start" | "submit" | "apply";
  taxCode?: string;
  challengeId?: string;
  captcha?: string;
  candidateIndex?: number;
};

function statusGroup(status: string | null) {
  const value = (status ?? "").toLocaleLowerCase("vi-VN");
  if (value.includes("đang hoạt động")) return "active";
  if (value.includes("ngừng") || value.includes("không hoạt động") || value.includes("chấm dứt")) return "inactive";
  return "unknown";
}

function comparable(value: string | null | undefined) {
  return (value ?? "").normalize("NFC").replace(/\s+/g, " ").trim().toLocaleLowerCase("vi-VN");
}

function isExpired(expiresAt: string) {
  return new Date(expiresAt).getTime() <= Date.now();
}

async function readBody(request: Request) {
  try {
    return await request.json() as ManualLookupBody;
  } catch {
    return null;
  }
}

async function startLookup(username: string, taxCode: string) {
  const supabase = createAdminClient();
  const { data: taxpayer, error: taxpayerError } = await supabase
    .from("taxpayers")
    .select("tax_code")
    .eq("tax_code", taxCode)
    .maybeSingle<{ tax_code: string }>();

  if (taxpayerError) throw new Error("Không thể kiểm tra MST cần tra cứu.");
  if (!taxpayer) return NextResponse.json({ error: "MST chưa có trong danh mục quản lý." }, { status: 404 });

  const gdtSession = await createGdtLookupSession();
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString();

  await supabase.from("manual_lookup_sessions").delete().eq("username", username);
  const { data: session, error: sessionError } = await supabase
    .from("manual_lookup_sessions")
    .insert({ username, tax_code: taxCode, upstream_cookie: gdtSession.cookieHeader, expires_at: expiresAt, candidate_records: [] })
    .select("id")
    .single<{ id: string }>();

  if (sessionError || !session) {
    console.error("manual lookup session insert failed", sessionError);
    throw new Error("Không thể tạo phiên CAPTCHA. Kiểm tra migration manual_lookup_sessions trên Supabase.");
  }

  return NextResponse.json({
    ok: true,
    challengeId: session.id,
    taxCode,
    captchaDataUrl: gdtSession.captchaDataUrl,
    expiresAt,
  });
}

async function refreshCaptchaForSession(session: ManualLookupSession) {
  const supabase = createAdminClient();
  const refreshed = await refreshGdtCaptcha(session.upstream_cookie);
  const { error } = await supabase
    .from("manual_lookup_sessions")
    .update({ upstream_cookie: refreshed.cookieHeader, expires_at: new Date(Date.now() + SESSION_TTL_MS).toISOString() })
    .eq("id", session.id);
  if (error) throw error;
  return refreshed;
}

async function readReferenceNames(taxCode: string) {
  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from("taxpayer_sources")
    .select("source_vendor_name, source_imported_at")
    .eq("tax_code", taxCode)
    .not("source_vendor_name", "is", null);
  if (error) throw new Error("Không thể đọc tên tham chiếu của MST.");
  const rows = data ?? [];
  const latestSourceImportedAt = rows.reduce<string | null>((latest, source) => {
    if (!source.source_imported_at) return latest;
    return !latest || source.source_imported_at > latest ? source.source_imported_at : latest;
  }, null);
  return [...new Set(rows
    .filter((source) => !latestSourceImportedAt || source.source_imported_at === latestSourceImportedAt)
    .map((source) => source.source_vendor_name)
    .filter((name): name is string => typeof name === "string" && Boolean(name.trim())))];
}

async function applyManualLookup(username: string, record: { taxCode: string; name: string | null; address: string | null; taxDepartment: string | null; status: string | null }) {
  const supabase = createAdminClient();
  const { data: current, error: currentError } = await supabase
    .from("taxpayers")
    .select("tax_code, name, org_type, address, tax_department, status, status_group, source_updated_at, previous_checked_at, last_checked_at, status_changed_at, last_error, consecutive_failures, needs_manual_review, manual_review_reason, name_source")
    .eq("tax_code", record.taxCode)
    .maybeSingle<CurrentTaxpayer>();

  if (currentError) throw new Error("Không thể đọc dữ liệu hiện tại của MST.");
  if (!current) return NextResponse.json({ error: "MST không còn tồn tại trong danh mục." }, { status: 404 });

  const nextName = record.name ?? current.name;
  const nextAddress = record.address ?? current.address;
  const nextTaxDepartment = record.taxDepartment ?? current.tax_department;
  const nextStatus = record.status ?? current.status;
  const nextStatusGroup = statusGroup(nextStatus);
  const changed = comparable(current.name) !== comparable(nextName)
    || comparable(current.address) !== comparable(nextAddress)
    || comparable(current.tax_department) !== comparable(nextTaxDepartment)
    || comparable(current.status) !== comparable(nextStatus)
    || current.status_group !== nextStatusGroup;
  const statusChanged = current.status_group !== nextStatusGroup || comparable(current.status) !== comparable(nextStatus);
  const now = new Date().toISOString();
  const previousCheckedAt = current.last_checked_at ?? null;
  // A successful manual lookup is a fresh source confirmation even when the
  // normalized business fields are identical to the current DB snapshot.
  const nextSourceUpdatedAt = now;
  const nextStatusChangedAt = statusChanged ? now : current.status_changed_at;
  const nextCheckAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
  const rawManualResponse = { provider: "gdt_manual", payload: record, checked_by: username };

  if (statusChanged) {
    const { error: historyError } = await supabase.from("taxpayer_status_history").insert({
      tax_code: record.taxCode,
      old_status: current.status,
      new_status: nextStatus,
      old_status_group: current.status_group,
      new_status_group: nextStatusGroup,
      detected_at: now,
      source_updated_at: now,
      note: `Status change detected by manual Cục Thuế lookup by ${username}`,
    });
    if (historyError) throw new Error("Không thể ghi lịch sử thay đổi MST.");
  }

  const updatePayload = changed
    ? {
        previous_checked_at: previousCheckedAt,
        last_checked_at: now,
        name: nextName,
        address: nextAddress,
        tax_department: nextTaxDepartment,
        status: nextStatus,
        status_group: nextStatusGroup,
        source_updated_at: nextSourceUpdatedAt,
        status_changed_at: nextStatusChangedAt,
        last_error: null,
        consecutive_failures: 0,
        needs_manual_review: false,
        manual_review_reason: null,
        name_source: "gdt_manual",
        next_check_at: nextCheckAt,
        raw_current_response: rawManualResponse,
      }
    : {
        previous_checked_at: previousCheckedAt,
        last_checked_at: now,
        source_updated_at: nextSourceUpdatedAt,
        last_error: null,
        consecutive_failures: 0,
        needs_manual_review: false,
        manual_review_reason: null,
        name_source: "gdt_manual",
        next_check_at: nextCheckAt,
        raw_current_response: rawManualResponse,
      };

  const { error: updateError } = await supabase.from("taxpayers").update(updatePayload).eq("tax_code", record.taxCode);
  if (updateError) throw new Error("Không thể cập nhật dữ liệu MST.");

  await supabase
    .from("refresh_queue")
    .update({ state: "success", attempts: 0, locked_at: null, last_error: null })
    .eq("tax_code", record.taxCode);

  return NextResponse.json({
    ok: true,
    taxCode: record.taxCode,
    changed,
    message: changed ? "Đã cập nhật dữ liệu từ Cục Thuế." : "Không có thay đổi so với dữ liệu hiện tại.",
    checkedAt: now,
    taxpayer: {
      tax_code: current.tax_code,
      name: nextName,
      org_type: current.org_type,
      address: nextAddress,
      tax_department: nextTaxDepartment,
      status: nextStatus,
      status_group: nextStatusGroup,
      source_updated_at: nextSourceUpdatedAt,
      previous_checked_at: previousCheckedAt,
      last_checked_at: now,
      status_changed_at: nextStatusChangedAt,
      last_error: null,
      needs_manual_review: false,
      manual_review_reason: null,
      name_source: "gdt_manual",
    },
  });
}

export async function POST(request: Request) {
  const session = await authenticateRequest(request);
  if (!session) return NextResponse.json({ error: "Bạn cần đăng nhập." }, { status: 401 });
  if (!isAdminSession(session)) {
    return NextResponse.json({ error: READ_ONLY_FORBIDDEN_MESSAGE }, { status: 403 });
  }

  const body = await readBody(request);
  if (!body || (body.action !== "start" && body.action !== "submit" && body.action !== "apply")) {
    return NextResponse.json({ error: "Yêu cầu tra cứu Cục Thuế không hợp lệ." }, { status: 400 });
  }

  const taxCode = normalizeTaxCode(body.taxCode ?? "");
  if (!isValidTaxCode(taxCode)) return NextResponse.json({ error: TAX_CODE_FORMAT_MESSAGE }, { status: 400 });

  try {
    if (body.action === "start") return await startLookup(session.username, taxCode);

    const captcha = body.captcha?.trim() ?? "";
    if (!body.challengeId) return NextResponse.json({ error: "Không xác định được phiên tra cứu." }, { status: 400 });
    if (body.action === "submit" && !captcha) return NextResponse.json({ error: "Vui lòng nhập mã CAPTCHA." }, { status: 400 });
    if (body.action === "apply" && (!Number.isInteger(body.candidateIndex) || (body.candidateIndex ?? -1) < 0)) {
      return NextResponse.json({ error: "Dòng dữ liệu Cục Thuế được chọn không hợp lệ." }, { status: 400 });
    }

    const supabase = createAdminClient();
    const { data: lookupSession, error: lookupSessionError } = await supabase
      .from("manual_lookup_sessions")
      .select("id, username, tax_code, upstream_cookie, expires_at, candidate_records")
      .eq("id", body.challengeId)
      .eq("username", session.username)
      .maybeSingle<ManualLookupSession>();

    if (lookupSessionError || !lookupSession || isExpired(lookupSession.expires_at)) {
      if (lookupSession) await supabase.from("manual_lookup_sessions").delete().eq("id", lookupSession.id);
      return NextResponse.json({ error: "Phiên CAPTCHA đã hết hạn. Vui lòng tạo phiên mới." }, { status: 410 });
    }
    if (lookupSession.tax_code !== taxCode) return NextResponse.json({ error: "MST không khớp với phiên CAPTCHA." }, { status: 400 });

    if (body.action === "apply") {
      const candidate = lookupSession.candidate_records?.[body.candidateIndex ?? -1];
      if (!candidate || candidate.taxCode !== taxCode) {
        return NextResponse.json({ error: "Dòng dữ liệu Cục Thuế đã hết hiệu lực. Vui lòng tra cứu lại." }, { status: 409 });
      }
      await supabase.from("manual_lookup_sessions").delete().eq("id", lookupSession.id);
      return await applyManualLookup(session.username, candidate);
    }

    try {
      const referenceNames = await readReferenceNames(taxCode);
      const result = await submitGdtLookup(taxCode, captcha, lookupSession.upstream_cookie, referenceNames);
      await supabase.from("manual_lookup_sessions").delete().eq("id", lookupSession.id);
      return await applyManualLookup(session.username, result.record);
    } catch (lookupError) {
      if (lookupError instanceof GdtLookupError && lookupError.kind === "captcha") {
        const refreshed = await refreshCaptchaForSession(lookupSession);
        return NextResponse.json({
          error: "Cục Thuế yêu cầu đổi mã CAPTCHA. Vui lòng nhập mã mới theo ảnh vừa cập nhật.",
          captchaDataUrl: refreshed.captchaDataUrl,
          captchaInvalid: true,
        }, { status: 422 });
      }
      if (lookupError instanceof GdtLookupError && lookupError.kind === "empty") {
        const refreshed = await refreshCaptchaForSession(lookupSession);
        return NextResponse.json({
          error: "Cục Thuế trả về dữ liệu rỗng sau nhiều lần thử. Vui lòng nhập lại CAPTCHA.",
          captchaDataUrl: refreshed.captchaDataUrl,
          retryRequired: true,
        }, { status: 422 });
      }
      if (lookupError instanceof GdtLookupError && lookupError.kind === "not_found") {
        await supabase.from("manual_lookup_sessions").delete().eq("id", lookupSession.id);
        return NextResponse.json({ error: lookupError.message }, { status: 404 });
      }
      if (lookupError instanceof GdtLookupError && lookupError.kind === "ambiguous") {
        const { error: candidateError } = await supabase
          .from("manual_lookup_sessions")
          .update({ candidate_records: lookupError.candidates })
          .eq("id", lookupSession.id);
        if (candidateError) throw candidateError;
        return NextResponse.json({ error: lookupError.message, ambiguous: true, candidates: lookupError.candidates }, { status: 409 });
      }
      await supabase.from("manual_lookup_sessions").delete().eq("id", lookupSession.id);
      throw lookupError;
    }
  } catch (error) {
    console.error("manual Cục Thuế lookup failed", error);
    return NextResponse.json({
      error: error instanceof Error ? error.message : "Không thể tra cứu trực tiếp Cục Thuế.",
    }, { status: 502 });
  }
}

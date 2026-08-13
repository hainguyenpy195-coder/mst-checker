import { NextResponse } from "next/server";
import { authenticateRequest } from "@/lib/app-auth";
import { createAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PRIMARY_KEY = "primary_tax_lookup_endpoint";
const FALLBACK_KEY = "fallback_tax_lookup_endpoint";
const DEFAULT_PRIMARY_ENDPOINT = "https://api.xinvoice.vn/gdt-api/tax-payer/{taxCode}";
const DEFAULT_FALLBACK_ENDPOINT = "https://api.vietqr.io/v2/business/{taxCode}";

function validateEndpoint(value: unknown, label: string) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} không được để trống.`);
  const endpoint = value.trim();
  if (endpoint.length > 500) throw new Error(`${label} không được dài quá 500 ký tự.`);
  if (!endpoint.includes("{taxCode}")) throw new Error(`${label} phải chứa biến {taxCode}.`);

  try {
    const sampleUrl = new URL(endpoint.replaceAll("{taxCode}", "0101167823"));
    if (sampleUrl.protocol !== "https:") throw new Error("chỉ hỗ trợ HTTPS");
    if (sampleUrl.username || sampleUrl.password) throw new Error("không được chứa username/password");
  } catch (error) {
    throw new Error(`${label} không hợp lệ: ${error instanceof Error ? error.message : "URL không hợp lệ"}.`);
  }

  return endpoint;
}

function responseFromSettings(rows: Array<{ setting_key: string; setting_value: string }> | null) {
  const values = new Map((rows ?? []).map((row) => [row.setting_key, row.setting_value]));
  return {
    primaryEndpoint: values.get(PRIMARY_KEY) ?? DEFAULT_PRIMARY_ENDPOINT,
    fallbackEndpoint: values.get(FALLBACK_KEY) ?? DEFAULT_FALLBACK_ENDPOINT,
  };
}

export async function GET(request: Request) {
  if (!(await authenticateRequest(request))) {
    return NextResponse.json({ error: "Bạn cần đăng nhập." }, { status: 401 });
  }

  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from("app_settings")
    .select("setting_key, setting_value")
    .in("setting_key", [PRIMARY_KEY, FALLBACK_KEY]);

  if (error) {
    console.error("endpoint settings read failed", error);
    return NextResponse.json({ error: "Không thể tải cấu hình endpoint." }, { status: 500 });
  }

  return NextResponse.json(responseFromSettings(data));
}

export async function PUT(request: Request) {
  const session = await authenticateRequest(request);
  if (!session) return NextResponse.json({ error: "Bạn cần đăng nhập." }, { status: 401 });

  let body: { primaryEndpoint?: unknown; fallbackEndpoint?: unknown };
  try {
    body = await request.json() as { primaryEndpoint?: unknown; fallbackEndpoint?: unknown };
  } catch {
    return NextResponse.json({ error: "Dữ liệu cấu hình không hợp lệ." }, { status: 400 });
  }

  let primaryEndpoint: string;
  let fallbackEndpoint: string;
  try {
    primaryEndpoint = validateEndpoint(body.primaryEndpoint, "Endpoint chính");
    fallbackEndpoint = validateEndpoint(body.fallbackEndpoint, "Endpoint dự phòng");
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Endpoint không hợp lệ." }, { status: 400 });
  }

  const supabase = createAdminClient();
  const { error } = await supabase.from("app_settings").upsert([
    { setting_key: PRIMARY_KEY, setting_value: primaryEndpoint, description: "Endpoint tra cứu MST chính", updated_by: session.username },
    { setting_key: FALLBACK_KEY, setting_value: fallbackEndpoint, description: "Endpoint tra cứu MST dự phòng", updated_by: session.username },
  ], { onConflict: "setting_key" });

  if (error) {
    console.error("endpoint settings write failed", error);
    return NextResponse.json({ error: "Không thể lưu cấu hình endpoint." }, { status: 500 });
  }

  return NextResponse.json({ ok: true, primaryEndpoint, fallbackEndpoint });
}

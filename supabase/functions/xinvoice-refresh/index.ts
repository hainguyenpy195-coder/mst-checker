import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

type RefreshJob = {
  tax_code: string;
  attempts: number;
};

type RefreshRequest = {
  taxCode?: string;
  taxCodes?: string[];
  preview?: boolean;
};

type XInvoicePayload = {
  orgType?: string;
  taxID?: string;
  name?: string;
  address?: string;
  taxDepartment?: string;
  status?: string;
  updatedAt?: string;
};

type VietQrPayload = {
  id?: string;
  name?: string;
  address?: string;
  status?: string;
  updatedAt?: string;
  metadata?: {
    updatedAt?: string;
  };
};

type LookupResult = {
  payload: XInvoicePayload;
  provider: "xinvoice" | "vietqr";
};

type TaxpayerPreview = {
  tax_code: string;
  name: string | null;
  org_type: string | null;
  address: string | null;
  tax_department: string | null;
  status: string | null;
  status_group: string;
  source_updated_at: string | null;
};

type EndpointSettings = {
  primaryEndpoint: string;
  fallbackEndpoint: string;
};

class RefreshWorkerError extends Error {
  retryAfterSeconds?: number;

  constructor(message: string, retryAfterSeconds?: number) {
    super(message);
    this.name = "RefreshWorkerError";
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

type CurrentTaxpayer = {
  name: string | null;
  org_type: string | null;
  address: string | null;
  tax_department: string | null;
  status: string | null;
  status_group: string | null;
  source_updated_at: string | null;
  last_checked_at: string | null;
  last_error: string | null;
  consecutive_failures: number;
};

const supabaseUrl = Deno.env.get("SUPABASE_URL");
const secretKeysJson = Deno.env.get("SUPABASE_SECRET_KEYS");
const singleSecretKey = Deno.env.get("SUPABASE_SECRET_KEY");
const workerSecret = Deno.env.get("REFRESH_WORKER_SECRET");
const DEFAULT_PRIMARY_ENDPOINT = "https://api.xinvoice.vn/gdt-api/tax-payer/{taxCode}";
const DEFAULT_FALLBACK_ENDPOINT = "https://api.vietqr.io/v2/business/{taxCode}";
const PRIMARY_ENDPOINT_KEY = "primary_tax_lookup_endpoint";
const FALLBACK_ENDPOINT_KEY = "fallback_tax_lookup_endpoint";

let secretKey: string | undefined;
if (secretKeysJson) {
  try {
    const secretKeys = JSON.parse(secretKeysJson) as Record<string, unknown>;
    if (typeof secretKeys.default === "string") secretKey = secretKeys.default;
  } catch {
    throw new Error("SUPABASE_SECRET_KEYS must be valid JSON");
  }
}

// Legacy fallback keeps already-configured projects working during migration.
secretKey ??= singleSecretKey ?? Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? undefined;

if (!supabaseUrl || !secretKey) {
  throw new Error("SUPABASE_URL and a Supabase secret key are required");
}

const supabase = createClient(supabaseUrl, secretKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

function statusGroup(status: string | null | undefined) {
  const value = (status ?? "").toLowerCase();
  if (value.includes("đang hoạt động")) return "active";
  if (value.includes("ngừng") || value.includes("không hoạt động") || value.includes("chấm dứt")) return "inactive";
  return "unknown";
}

function materialStatusChanged(oldStatus: string | null, oldGroup: string | null, newStatus: string | null, newGroup: string) {
  return oldGroup !== newGroup || (oldStatus ?? "") !== (newStatus ?? "");
}

function normalizedDate(value: string | null | undefined) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function isIncomingSourceOlder(currentSourceUpdatedAt: string | null, incomingSourceUpdatedAt: string | null) {
  if (!currentSourceUpdatedAt || !incomingSourceUpdatedAt) return false;
  return new Date(incomingSourceUpdatedAt).getTime() < new Date(currentSourceUpdatedAt).getTime();
}

function preferVietQrValue(currentValue: string | null, incomingValue: string | undefined, currentUpdatedAt: string | null, incomingUpdatedAt: string | null) {
  if (!incomingValue) return currentValue;
  if (!currentValue) return incomingValue;

  const currentDate = normalizedDate(currentUpdatedAt);
  const incomingDate = normalizedDate(incomingUpdatedAt);
  // An undated fallback must not replace an existing XInvoice value. A dated
  // VietQR result may replace it only when it is at least as new.
  if (!incomingDate || (currentDate && incomingDate < currentDate)) return currentValue;
  return incomingValue;
}

function nextMonthlyRefreshAt(now: Date) {
  // Supabase Cron is configured in UTC. 12:00 in Vietnam is 05:00 UTC.
  const vietnamNow = new Date(now.getTime() + 7 * 60 * 60 * 1000);
  return new Date(Date.UTC(vietnamNow.getUTCFullYear(), vietnamNow.getUTCMonth() + 1, 1, 5, 0, 0)).toISOString();
}

function normalizeTaxCode(value: string) {
  return value.trim().replace(/\s+/g, "").replace(/[–—]/g, "-");
}

function isValidTaxCode(value: string) {
  return /^(?:\d{10}|\d{10}-\d{3}|\d{12})$/.test(value);
}

function retryAfterHeader(response: Response, fallbackSeconds: number) {
  const retryAfter = Number(response.headers.get("retry-after") ?? "");
  return Number.isFinite(retryAfter)
    ? Math.max(30, Math.min(retryAfter, 3600))
    : fallbackSeconds;
}

function isUsableEndpoint(value: unknown): value is string {
  if (typeof value !== "string" || !value.trim() || !value.includes("{taxCode}")) return false;
  try {
    const url = new URL(value.replaceAll("{taxCode}", "0101167823"));
    return url.protocol === "https:" && !url.username && !url.password;
  } catch {
    return false;
  }
}

async function loadEndpointSettings(): Promise<EndpointSettings> {
  const { data, error } = await supabase
    .from("app_settings")
    .select("setting_key, setting_value")
    .in("setting_key", [PRIMARY_ENDPOINT_KEY, FALLBACK_ENDPOINT_KEY]);

  if (error) {
    console.warn("Endpoint settings unavailable; using defaults", error.message);
    return { primaryEndpoint: DEFAULT_PRIMARY_ENDPOINT, fallbackEndpoint: DEFAULT_FALLBACK_ENDPOINT };
  }

  const values = new Map((data ?? []).map((row) => [row.setting_key, row.setting_value]));
  const primaryEndpoint = isUsableEndpoint(values.get(PRIMARY_ENDPOINT_KEY))
    ? values.get(PRIMARY_ENDPOINT_KEY) as string
    : DEFAULT_PRIMARY_ENDPOINT;
  const fallbackEndpoint = isUsableEndpoint(values.get(FALLBACK_ENDPOINT_KEY))
    ? values.get(FALLBACK_ENDPOINT_KEY) as string
    : DEFAULT_FALLBACK_ENDPOINT;

  return { primaryEndpoint, fallbackEndpoint };
}

function resolveEndpoint(template: string, taxCode: string) {
  return template.replaceAll("{taxCode}", encodeURIComponent(taxCode));
}

async function fetchXInvoice(taxCode: string, endpoints: EndpointSettings): Promise<LookupResult> {
  const response = await fetch(resolveEndpoint(endpoints.primaryEndpoint, taxCode), {
    headers: {
      Accept: "application/json",
    },
  });

  if (response.status === 429) {
    const delaySeconds = retryAfterHeader(response, 60);
    throw new RefreshWorkerError(`RATE_LIMIT:${delaySeconds}`, delaySeconds);
  }

  if (!response.ok) {
    throw new RefreshWorkerError(`XINVOICE_HTTP_${response.status}`);
  }

  const raw = (await response.json()) as XInvoicePayload | { data?: XInvoicePayload };
  const payload = "data" in raw && raw.data ? raw.data : raw as XInvoicePayload;
  return { payload, provider: "xinvoice" };
}

async function fetchVietQr(taxCode: string, endpoints: EndpointSettings): Promise<LookupResult> {
  const response = await fetch(resolveEndpoint(endpoints.fallbackEndpoint, taxCode), {
    headers: {
      Accept: "application/json",
    },
  });

  if (response.status === 429) {
    const delaySeconds = retryAfterHeader(response, 60);
    throw new RefreshWorkerError(`VIETQR_RATE_LIMIT:${delaySeconds}`, delaySeconds);
  }

  if (!response.ok) {
    throw new RefreshWorkerError(`VIETQR_HTTP_${response.status}`);
  }

  const raw = await response.json() as { code?: string; desc?: string; data?: VietQrPayload | null };
  if (!raw.data || (raw.code && raw.code !== "00")) {
    throw new RefreshWorkerError(`VIETQR_NO_DATA${raw.desc ? `:${raw.desc}` : ""}`);
  }

  return {
    provider: "vietqr",
    payload: {
      // VietQR is intentionally a partial fallback. Fields that it does not
      // publish are kept from the current XInvoice record below.
      taxID: raw.data.id,
      name: raw.data.name,
      address: raw.data.address,
      status: raw.data.status,
      updatedAt: raw.data.metadata?.updatedAt ?? raw.data.updatedAt,
    },
  };
}

async function fetchWithFallback(taxCode: string, endpoints: EndpointSettings): Promise<LookupResult> {
  try {
    return await fetchXInvoice(taxCode, endpoints);
  } catch (primaryError) {
    try {
      return await fetchVietQr(taxCode, endpoints);
    } catch (fallbackError) {
      const primaryMessage = primaryError instanceof Error ? primaryError.message : "XINVOICE_LOOKUP_FAILED";
      const fallbackMessage = fallbackError instanceof Error ? fallbackError.message : "VIETQR_LOOKUP_FAILED";
      const retryAfterSeconds = Math.max(
        primaryError instanceof RefreshWorkerError ? primaryError.retryAfterSeconds ?? 0 : 0,
        fallbackError instanceof RefreshWorkerError ? fallbackError.retryAfterSeconds ?? 0 : 0,
      );
      throw new RefreshWorkerError(`${primaryMessage}; ${fallbackMessage}`, retryAfterSeconds || undefined);
    }
  }
}

async function markJobSuccess(taxCode: string) {
  const { error } = await supabase
    .from("refresh_queue")
    .update({ state: "success", attempts: 0, locked_at: null, last_error: null })
    .eq("tax_code", taxCode);

  if (error) throw error;
}

async function handleJob(job: RefreshJob, endpoints: EndpointSettings) {
  const { data: current, error: currentError } = await supabase
    .from("taxpayers")
    .select("name, org_type, address, tax_department, status, status_group, source_updated_at, last_checked_at, last_error, consecutive_failures")
    .eq("tax_code", job.tax_code)
    .single<CurrentTaxpayer>();

  if (currentError) throw currentError;

  const { payload, provider } = await fetchWithFallback(job.tax_code, endpoints);
  const now = new Date().toISOString();
  const incomingSourceUpdatedAt = normalizedDate(payload.updatedAt);
  const timestampUpdate = {
    previous_checked_at: current.last_checked_at ?? null,
    last_checked_at: now,
  };

  if (isIncomingSourceOlder(normalizedDate(current.source_updated_at), incomingSourceUpdatedAt)) {
    // The lookup succeeded, but the provider returned an older snapshot. Keep
    // the current taxpayer data and only record that the lookup was performed.
    const { error: timestampError } = await supabase
      .from("taxpayers")
      .update({
        ...timestampUpdate,
        last_error: null,
        consecutive_failures: 0,
        next_check_at: nextMonthlyRefreshAt(new Date(now)),
      })
      .eq("tax_code", job.tax_code);

    if (timestampError) throw timestampError;
    await markJobSuccess(job.tax_code);
    return { skipped: true };
  }

  const nextName = provider === "vietqr"
    ? preferVietQrValue(current.name, payload.name, current.source_updated_at, incomingSourceUpdatedAt)
    : payload.name ?? null;
  const nextOrgType = provider === "vietqr" ? current.org_type : payload.orgType ?? null;
  const nextAddress = provider === "vietqr"
    ? preferVietQrValue(current.address, payload.address, current.source_updated_at, incomingSourceUpdatedAt)
    : payload.address ?? null;
  const nextTaxDepartment = provider === "vietqr" ? current.tax_department : payload.taxDepartment ?? null;
  const newStatus = provider === "vietqr"
    ? preferVietQrValue(current.status, payload.status, current.source_updated_at, incomingSourceUpdatedAt)
    : payload.status ?? null;
  const newGroup = statusGroup(newStatus);
  const nextSourceUpdatedAt = provider === "vietqr"
    ? (incomingSourceUpdatedAt && (!current.source_updated_at || incomingSourceUpdatedAt >= current.source_updated_at)
      ? incomingSourceUpdatedAt
      : current.source_updated_at)
    : incomingSourceUpdatedAt;

  const changed = materialStatusChanged(current.status, current.status_group, newStatus, newGroup);
  const payloadChanged = current.name !== nextName
    || current.org_type !== nextOrgType
    || current.address !== nextAddress
    || current.tax_department !== nextTaxDepartment
    || current.status !== newStatus
    || current.status_group !== newGroup
    || normalizedDate(current.source_updated_at) !== nextSourceUpdatedAt;
  if (changed) {
    const { error: historyError } = await supabase.from("taxpayer_status_history").insert({
      tax_code: job.tax_code,
      old_status: current.status,
      new_status: newStatus,
      old_status_group: current.status_group,
      new_status_group: newGroup,
      detected_at: now,
      source_updated_at: payload.updatedAt ?? null,
      note: `Status change detected by ${provider} refresh`,
    });
    if (historyError) throw historyError;
  }

  const taxpayerUpdate = payloadChanged
    ? {
        ...timestampUpdate,
        name: nextName,
        org_type: nextOrgType,
        address: nextAddress,
        tax_department: nextTaxDepartment,
        status: newStatus,
        status_group: newGroup,
        source_updated_at: nextSourceUpdatedAt,
        status_changed_at: changed ? now : undefined,
        last_error: null,
        consecutive_failures: 0,
        next_check_at: nextMonthlyRefreshAt(new Date(now)),
        raw_current_response: { provider, payload },
      }
    : current.last_error || current.consecutive_failures > 0
      ? { ...timestampUpdate, last_error: null, consecutive_failures: 0 }
      : timestampUpdate;

  const { error: updateError } = await supabase
    .from("taxpayers")
    .update(taxpayerUpdate)
    .eq("tax_code", job.tax_code);

  if (updateError) throw updateError;

  await markJobSuccess(job.tax_code);
  return { skipped: false };
}

function retryDelay(attempts: number) {
  return Math.min(60 * 2 ** Math.max(0, attempts - 1), 3600);
}

Deno.serve(async (request) => {
  if (!workerSecret) {
    return new Response(JSON.stringify({ error: "worker secret is not configured" }), { status: 503, headers: { "content-type": "application/json" } });
  }
  if (request.headers.get("x-refresh-secret") !== workerSecret) {
   return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401, headers: { "content-type": "application/json" } });
 }

  let body: RefreshRequest = {};
  try {
    body = await request.json() as RefreshRequest;
  } catch {
    // An empty request body is valid for the batch drain cron.
  }

  const requestedTaxCode = normalizeTaxCode(body.taxCode ?? "");
  if (body.taxCode && !isValidTaxCode(requestedTaxCode)) {
    return new Response(JSON.stringify({ error: "Invalid tax code format" }), { status: 400, headers: { "content-type": "application/json" } });
  }

  const requestedTaxCodes = Array.isArray(body.taxCodes)
    ? [...new Set(body.taxCodes
      .filter((taxCode): taxCode is string => typeof taxCode === "string")
      .map((taxCode) => normalizeTaxCode(taxCode)))]
    : [];
  if (Array.isArray(body.taxCodes) && (body.taxCodes.length !== requestedTaxCodes.length || !requestedTaxCodes.length || requestedTaxCodes.some((taxCode) => !isValidTaxCode(taxCode)))) {
    return new Response(JSON.stringify({ error: "Invalid tax code list" }), { status: 400, headers: { "content-type": "application/json" } });
  }

  // Preview is used while adding a new MST. It intentionally does not claim
  // a queue job or write anything to Supabase; it only reads the configured
  // endpoints and returns the latest available lookup data.
  if (body.preview) {
    if (!requestedTaxCode) {
      return new Response(JSON.stringify({ error: "Tax code is required for preview" }), { status: 400, headers: { "content-type": "application/json" } });
    }

    try {
      const endpoints = await loadEndpointSettings();
      const { payload, provider } = await fetchWithFallback(requestedTaxCode, endpoints);
      const preview: TaxpayerPreview = {
        tax_code: requestedTaxCode,
        name: payload.name ?? null,
        org_type: payload.orgType ?? null,
        address: payload.address ?? null,
        tax_department: payload.taxDepartment ?? null,
        status: payload.status ?? null,
        status_group: statusGroup(payload.status),
        source_updated_at: normalizedDate(payload.updatedAt),
      };

      return new Response(JSON.stringify({ ok: true, preview, provider }), {
        headers: { "content-type": "application/json" },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Preview lookup failed";
      const retryAfterSeconds = error instanceof RefreshWorkerError ? error.retryAfterSeconds : undefined;
      return new Response(JSON.stringify({ error: message }), {
        status: retryAfterSeconds ? 429 : 502,
        headers: retryAfterSeconds
          ? { "content-type": "application/json", "retry-after": String(retryAfterSeconds) }
          : { "content-type": "application/json" },
      });
    }
  }

  const { data: jobs, error: claimError } = requestedTaxCode
    ? await supabase.rpc("claim_refresh_job", { p_tax_code: requestedTaxCode })
    : requestedTaxCodes.length
      ? await supabase.rpc("claim_refresh_jobs", { p_tax_codes: requestedTaxCodes, p_limit: 10 })
      : await supabase.rpc("claim_refresh_batch", { p_limit: 10 });
  if (claimError) {
    return new Response(JSON.stringify({ error: claimError.message }), { status: 500, headers: { "content-type": "application/json" } });
  }

  const results: Array<{ tax_code: string; ok: boolean; error?: string; skipped?: boolean; skipReason?: string }> = [];
  const endpointSettings = await loadEndpointSettings();

  for (const job of (jobs ?? []) as RefreshJob[]) {
    try {
      const result = await handleJob(job, endpointSettings);
      results.push({
        tax_code: job.tax_code,
        ok: true,
        ...(result.skipped ? { skipped: true, skipReason: "endpoint_older_than_db" } : {}),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown worker error";
      const rateLimitMatch = message.match(/^RATE_LIMIT:(\d+)$/);
      const delay = rateLimitMatch
        ? Number(rateLimitMatch[1])
        : error instanceof RefreshWorkerError && error.retryAfterSeconds
          ? error.retryAfterSeconds
          : retryDelay(job.attempts + 1);
      const nextState = job.attempts + 1 >= 8 ? "dead_letter" : "retry";
      await supabase.from("refresh_queue").update({
        state: nextState,
        attempts: job.attempts + 1,
        run_after: new Date(Date.now() + delay * 1000).toISOString(),
        locked_at: null,
        last_error: message.slice(0, 500),
      }).eq("tax_code", job.tax_code);
      await supabase.from("taxpayers").update({
        last_error: message.slice(0, 500),
        consecutive_failures: job.attempts + 1,
      }).eq("tax_code", job.tax_code);
      results.push({ tax_code: job.tax_code, ok: false, error: message });
    }
  }

  return new Response(JSON.stringify({ processed: results.length, results }), {
    headers: { "content-type": "application/json" },
  });
});

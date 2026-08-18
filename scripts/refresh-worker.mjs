import http from "node:http";
import { timingSafeEqual } from "node:crypto";
import pg from "pg";

const { Pool, types } = pg;
types.setTypeParser(20, (value) => Number(value));
types.setTypeParser(1082, (value) => value);
types.setTypeParser(1114, (value) => value);
types.setTypeParser(1184, (value) => value);

const DEFAULT_PRIMARY_ENDPOINT = "https://api.xinvoice.vn/gdt-api/tax-payer/{taxCode}";
const DEFAULT_FALLBACK_ENDPOINT = "https://api.vietqr.io/v2/business/{taxCode}";
const PRIMARY_ENDPOINT_KEY = "primary_tax_lookup_endpoint";
const FALLBACK_ENDPOINT_KEY = "fallback_tax_lookup_endpoint";
const TAXPAYER_NOT_FOUND_MESSAGE = "Không tìm thấy mã số thuế hoặc chưa chính xác.";
const STATUS_BATCH_SIZE = 40;
const STATUS_PRIMARY_BATCH_SIZE = 20;

function getConnectionString() {
  if (process.env.DATABASE_URL?.trim()) return process.env.DATABASE_URL.trim();
  const host = process.env.DATABASE_HOST?.trim();
  const user = process.env.DATABASE_USER?.trim();
  const password = process.env.DATABASE_PASSWORD ?? "";
  const database = process.env.DATABASE_NAME?.trim();
  const port = process.env.DATABASE_PORT?.trim() || "5432";
  if (!host || !user || !database) throw new Error("Database worker configuration is incomplete.");
  return `postgresql://${encodeURIComponent(user)}:${encodeURIComponent(password)}@${host}:${port}/${encodeURIComponent(database)}`;
}

const pool = new Pool({
  connectionString: getConnectionString(),
  max: Math.max(2, Number(process.env.DATABASE_POOL_MAX ?? 10)),
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
  ssl: process.env.DATABASE_SSL === "true" ? { rejectUnauthorized: false } : undefined,
});

pool.on("error", (error) => console.error("refresh worker PostgreSQL pool error", error));

function normalizeTaxCode(value) {
  return String(value ?? "").trim().replace(/\s+/g, "").replace(/[–—]/g, "-");
}

function isValidTaxCode(value) {
  return /^(?:\d{10}|\d{11}|\d{10}-\d{3}|\d{12})$/.test(value);
}

function statusGroup(status) {
  const value = String(status ?? "").toLowerCase();
  if (value.includes("đang hoạt động")) return "active";
  if (value.includes("ngừng") || value.includes("không hoạt động") || value.includes("chấm dứt")) return "inactive";
  return "unknown";
}

function normalizedDate(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function normalizeTaxpayerName(value) {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[đĐ]/g, "d")
    .toLocaleLowerCase("vi-VN")
    .replace(/\s+/g, " ")
    .trim();
}

function hasMatchingReferenceName(referenceNames, endpointName) {
  const normalizedEndpointName = normalizeTaxpayerName(endpointName);
  const uniqueReferenceNames = [...new Set(referenceNames.map(normalizeTaxpayerName).filter(Boolean))];
  return !uniqueReferenceNames.length || (uniqueReferenceNames.length === 1 && Boolean(normalizedEndpointName && uniqueReferenceNames[0] === normalizedEndpointName));
}

function shouldKeepCurrentSource(currentSourceUpdatedAt, incomingSourceUpdatedAt) {
  if (!currentSourceUpdatedAt) return false;
  if (!incomingSourceUpdatedAt) return true;
  return new Date(incomingSourceUpdatedAt).getTime() < new Date(currentSourceUpdatedAt).getTime();
}

function preferVietQrValue(currentValue, incomingValue, currentUpdatedAt, incomingUpdatedAt) {
  if (!incomingValue) return currentValue;
  if (!currentValue) return incomingValue;
  const currentDate = normalizedDate(currentUpdatedAt);
  const incomingDate = normalizedDate(incomingUpdatedAt);
  if (!incomingDate || (currentDate && incomingDate < currentDate)) return currentValue;
  return incomingValue;
}

function nextMonthlyRefreshAt(now) {
  const vietnamNow = new Date(now.getTime() + 7 * 60 * 60 * 1000);
  return new Date(Date.UTC(vietnamNow.getUTCFullYear(), vietnamNow.getUTCMonth() + 1, 1, 5, 0, 0)).toISOString();
}

function retryAfterHeader(response, fallbackSeconds) {
  const retryAfter = Number(response.headers.get("retry-after") ?? "");
  return Number.isFinite(retryAfter) ? Math.max(30, Math.min(retryAfter, 3600)) : fallbackSeconds;
}

class RefreshWorkerError extends Error {
  constructor(message, retryAfterSeconds) {
    super(message);
    this.name = "RefreshWorkerError";
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

function isUsableEndpoint(value) {
  if (typeof value !== "string" || !value.trim() || !value.includes("{taxCode}")) return false;
  try {
    const url = new URL(value.replaceAll("{taxCode}", "0101167823"));
    return url.protocol === "https:" && !url.username && !url.password;
  } catch {
    return false;
  }
}

async function loadEndpointSettings() {
  try {
    const result = await pool.query(
      `select setting_key, setting_value from public.app_settings where setting_key = any($1::text[])`,
      [[PRIMARY_ENDPOINT_KEY, FALLBACK_ENDPOINT_KEY]],
    );
    const values = new Map(result.rows.map((row) => [row.setting_key, row.setting_value]));
    return {
      primaryEndpoint: isUsableEndpoint(values.get(PRIMARY_ENDPOINT_KEY)) ? values.get(PRIMARY_ENDPOINT_KEY) : DEFAULT_PRIMARY_ENDPOINT,
      fallbackEndpoint: isUsableEndpoint(values.get(FALLBACK_ENDPOINT_KEY)) ? values.get(FALLBACK_ENDPOINT_KEY) : DEFAULT_FALLBACK_ENDPOINT,
    };
  } catch (error) {
    console.warn("Endpoint settings unavailable; using defaults", error instanceof Error ? error.message : error);
    return { primaryEndpoint: DEFAULT_PRIMARY_ENDPOINT, fallbackEndpoint: DEFAULT_FALLBACK_ENDPOINT };
  }
}

function resolveEndpoint(template, taxCode) {
  return template.replaceAll("{taxCode}", encodeURIComponent(taxCode));
}

async function fetchJson(url) {
  return fetch(url, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(20_000) });
}

async function fetchXInvoice(taxCode, endpoints) {
  const response = await fetchJson(resolveEndpoint(endpoints.primaryEndpoint, taxCode));
  if (response.status === 429) throw new RefreshWorkerError(`RATE_LIMIT:${retryAfterHeader(response, 60)}`, retryAfterHeader(response, 60));
  if (!response.ok) throw new RefreshWorkerError(`XINVOICE_HTTP_${response.status}`);
  const raw = await response.json();
  const payload = raw && typeof raw === "object" && raw.data ? raw.data : raw;
  return { payload: payload ?? {}, provider: "xinvoice" };
}

async function fetchVietQr(taxCode, endpoints) {
  const response = await fetchJson(resolveEndpoint(endpoints.fallbackEndpoint, taxCode));
  if (response.status === 429) throw new RefreshWorkerError(`VIETQR_RATE_LIMIT:${retryAfterHeader(response, 60)}`, retryAfterHeader(response, 60));
  if (!response.ok) throw new RefreshWorkerError(`VIETQR_HTTP_${response.status}`);
  const raw = await response.json();
  if (!raw?.data || (raw.code && raw.code !== "00")) throw new RefreshWorkerError(`VIETQR_NO_DATA${raw?.desc ? `:${raw.desc}` : ""}`);
  return {
    provider: "vietqr",
    payload: {
      taxID: raw.data.id,
      name: raw.data.name,
      address: raw.data.address,
      status: raw.data.status,
      updatedAt: raw.data.metadata?.updatedAt ?? raw.data.updatedAt,
    },
  };
}

async function fetchWithFallback(taxCode, endpoints) {
  try {
    return await fetchXInvoice(taxCode, endpoints);
  } catch (primaryError) {
    try {
      return await fetchVietQr(taxCode, endpoints);
    } catch (fallbackError) {
      const primaryMessage = primaryError instanceof Error ? primaryError.message : "XINVOICE_LOOKUP_FAILED";
      const fallbackMessage = fallbackError instanceof Error ? fallbackError.message : "VIETQR_LOOKUP_FAILED";
      const retryAfterSeconds = Math.max(primaryError.retryAfterSeconds ?? 0, fallbackError.retryAfterSeconds ?? 0);
      if (primaryMessage === "XINVOICE_HTTP_404" && fallbackMessage.startsWith("VIETQR_NO_DATA")) throw new RefreshWorkerError(TAXPAYER_NOT_FOUND_MESSAGE);
      throw new RefreshWorkerError(`${primaryMessage}; ${fallbackMessage}`, retryAfterSeconds || undefined);
    }
  }
}

async function fetchWithPreferredEndpoint(taxCode, endpoints, preferred) {
  const first = preferred === "xinvoice" ? () => fetchXInvoice(taxCode, endpoints) : () => fetchVietQr(taxCode, endpoints);
  const second = preferred === "xinvoice" ? () => fetchVietQr(taxCode, endpoints) : () => fetchXInvoice(taxCode, endpoints);
  try {
    return await first();
  } catch (firstError) {
    try {
      return await second();
    } catch (secondError) {
      const firstMessage = firstError instanceof Error ? firstError.message : "PRIMARY_LOOKUP_FAILED";
      const secondMessage = secondError instanceof Error ? secondError.message : "FALLBACK_LOOKUP_FAILED";
      const retryAfterSeconds = Math.max(firstError.retryAfterSeconds ?? 0, secondError.retryAfterSeconds ?? 0);
      const isNotFound = (firstMessage === "XINVOICE_HTTP_404" && secondMessage.startsWith("VIETQR_NO_DATA"))
        || (secondMessage === "XINVOICE_HTTP_404" && firstMessage.startsWith("VIETQR_NO_DATA"));
      if (isNotFound) throw new RefreshWorkerError(TAXPAYER_NOT_FOUND_MESSAGE);
      throw new RefreshWorkerError(`${firstMessage}; ${secondMessage}`, retryAfterSeconds || undefined);
    }
  }
}

function quoteColumn(column) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(column)) throw new Error("Invalid worker column.");
  return `"${column}"`;
}

async function updateTaxpayer(taxCode, values) {
  const entries = Object.entries(values).filter(([, value]) => value !== undefined);
  if (!entries.length) return;
  const parameters = [taxCode];
  const assignments = entries.map(([column, value]) => {
    parameters.push(value ?? null);
    return `${quoteColumn(column)} = $${parameters.length}`;
  });
  await pool.query(`update public.taxpayers set ${assignments.join(", ")} where tax_code = $1`, parameters);
}

async function markJobSuccess(taxCode) {
  await pool.query(
    `update public.refresh_queue set state = 'success', attempts = 0, locked_at = null, last_error = null, updated_at = now() where tax_code = $1`,
    [taxCode],
  );
}

async function handleJob(job, endpoints) {
  const [currentResult, sourceResult] = await Promise.all([
    pool.query(`select name, org_type, address, tax_department, status, status_group, source_updated_at, last_checked_at, last_error, consecutive_failures, needs_manual_review, manual_review_reason, name_source from public.taxpayers where tax_code = $1`, [job.tax_code]),
    pool.query(`select source_vendor_name, source_imported_at from public.taxpayer_sources where tax_code = $1 and source_vendor_name is not null`, [job.tax_code]),
  ]);
  const current = currentResult.rows[0];
  if (!current) throw new Error("taxpayer not found");
  const sourceRows = sourceResult.rows;
  const latestSourceImportedAt = sourceRows.reduce((latest, source) => {
    if (!source.source_imported_at) return latest;
    return !latest || source.source_imported_at > latest ? source.source_imported_at : latest;
  }, null);
  const referenceNames = sourceRows
    .filter((source) => !latestSourceImportedAt || source.source_imported_at === latestSourceImportedAt)
    .map((source) => source.source_vendor_name)
    .filter((name) => typeof name === "string" && Boolean(name.trim()));

  const { payload, provider } = await fetchWithFallback(job.tax_code, endpoints);
  const now = new Date().toISOString();
  const incomingSourceUpdatedAt = normalizedDate(payload.updatedAt);
  const timestampUpdate = { previous_checked_at: current.last_checked_at ?? null, last_checked_at: now };
  const shouldCompareReference = current.needs_manual_review || current.name_source === "excel_reference";

  if (shouldCompareReference && !hasMatchingReferenceName(referenceNames, payload.name)) {
    await updateTaxpayer(job.tax_code, {
      ...timestampUpdate,
      name: referenceNames[0] ?? current.name,
      org_type: null,
      address: null,
      tax_department: null,
      status: null,
      status_group: "unknown",
      source_updated_at: null,
      needs_manual_review: true,
      manual_review_reason: new Set(referenceNames.map(normalizeTaxpayerName).filter(Boolean)).size > 1
        ? "File Excel có nhiều tên tham chiếu khác nhau cho cùng MST."
        : payload.name
          ? `Tên Excel không khớp tên endpoint: ${payload.name}`
          : "Endpoint không trả về tên để đối chiếu với tên Excel.",
      name_source: "excel_reference",
      last_error: null,
      consecutive_failures: 0,
      next_check_at: nextMonthlyRefreshAt(new Date(now)),
    });
    await markJobSuccess(job.tax_code);
    return { skipped: true, needsManualReview: true, skipReason: "name_mismatch" };
  }

  if (shouldKeepCurrentSource(normalizedDate(current.source_updated_at), incomingSourceUpdatedAt)) {
    await updateTaxpayer(job.tax_code, {
      ...timestampUpdate,
      name: payload.name ?? current.name,
      last_error: null,
      consecutive_failures: 0,
      needs_manual_review: false,
      manual_review_reason: null,
      name_source: provider === "xinvoice" ? "endpoint" : current.name_source,
      next_check_at: nextMonthlyRefreshAt(new Date(now)),
    });
    await markJobSuccess(job.tax_code);
    return { skipped: true };
  }

  const nextName = provider === "vietqr" ? preferVietQrValue(current.name, payload.name, current.source_updated_at, incomingSourceUpdatedAt) : payload.name ?? null;
  const nextOrgType = provider === "vietqr" ? current.org_type : payload.orgType ?? null;
  const nextAddress = provider === "vietqr" ? preferVietQrValue(current.address, payload.address, current.source_updated_at, incomingSourceUpdatedAt) : payload.address ?? null;
  const nextTaxDepartment = provider === "vietqr" ? current.tax_department : payload.taxDepartment ?? null;
  const newStatus = provider === "vietqr" ? preferVietQrValue(current.status, payload.status, current.source_updated_at, incomingSourceUpdatedAt) : payload.status ?? null;
  const newGroup = statusGroup(newStatus);
  const nextSourceUpdatedAt = provider === "vietqr"
    ? incomingSourceUpdatedAt && (!current.source_updated_at || incomingSourceUpdatedAt >= current.source_updated_at) ? incomingSourceUpdatedAt : current.source_updated_at
    : incomingSourceUpdatedAt;
  const changed = current.status !== newStatus || current.status_group !== newGroup;
  const payloadChanged = current.name !== nextName || current.org_type !== nextOrgType || current.address !== nextAddress
    || current.tax_department !== nextTaxDepartment || current.status !== newStatus || current.status_group !== newGroup
    || normalizedDate(current.source_updated_at) !== nextSourceUpdatedAt;

  if (changed) {
    await pool.query(
      `insert into public.taxpayer_status_history (tax_code, old_status, new_status, old_status_group, new_status_group, detected_at, source_updated_at, note)
       values ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [job.tax_code, current.status, newStatus, current.status_group, newGroup, now, payload.updatedAt ?? null, `Status change detected by ${provider} refresh`],
    );
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
        needs_manual_review: false,
        manual_review_reason: null,
        name_source: provider === "xinvoice" ? "endpoint" : current.name_source,
      }
    : current.last_error || current.consecutive_failures > 0 || current.needs_manual_review
      ? { ...timestampUpdate, last_error: null, consecutive_failures: 0, needs_manual_review: false, manual_review_reason: null, name_source: provider === "xinvoice" ? "endpoint" : current.name_source }
      : timestampUpdate;

  await updateTaxpayer(job.tax_code, taxpayerUpdate);
  await markJobSuccess(job.tax_code);
  return { skipped: false };
}

async function handleStatusJob(job, endpoints, preferred) {
  const currentResult = await pool.query(`select name, org_type, address, tax_department, status, status_group, source_updated_at, last_checked_at, last_error, consecutive_failures, needs_manual_review, manual_review_reason, name_source from public.taxpayers where tax_code = $1`, [job.tax_code]);
  const current = currentResult.rows[0];
  if (!current) throw new Error("taxpayer not found");
  const { payload, provider } = await fetchWithPreferredEndpoint(job.tax_code, endpoints, preferred);
  const now = new Date().toISOString();
  const incomingSourceUpdatedAt = normalizedDate(payload.updatedAt);

  if (current.needs_manual_review || current.name_source === "excel_reference") {
    await updateTaxpayer(job.tax_code, { previous_checked_at: current.last_checked_at ?? null, last_checked_at: now, last_error: null, consecutive_failures: 0, next_check_at: nextMonthlyRefreshAt(new Date(now)) });
    await markJobSuccess(job.tax_code);
    return { skipped: true, needsManualReview: true, skipReason: "name_mismatch" };
  }
  if (shouldKeepCurrentSource(normalizedDate(current.source_updated_at), incomingSourceUpdatedAt)) {
    await updateTaxpayer(job.tax_code, { previous_checked_at: current.last_checked_at ?? null, last_checked_at: now, last_error: null, consecutive_failures: 0, needs_manual_review: false, manual_review_reason: null, next_check_at: nextMonthlyRefreshAt(new Date(now)) });
    await markJobSuccess(job.tax_code);
    return { skipped: true };
  }

  const nextStatus = payload.status ?? current.status;
  const nextStatusGroup = statusGroup(nextStatus);
  const statusChanged = current.status !== nextStatus || current.status_group !== nextStatusGroup;
  if (statusChanged) {
    await pool.query(
      `insert into public.taxpayer_status_history (tax_code, old_status, new_status, old_status_group, new_status_group, detected_at, source_updated_at, note)
       values ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [job.tax_code, current.status, nextStatus, current.status_group, nextStatusGroup, now, current.source_updated_at, `Status change detected by status-only ${provider} refresh`],
    );
  }
  await updateTaxpayer(job.tax_code, {
    previous_checked_at: current.last_checked_at ?? null,
    last_checked_at: now,
    status: nextStatus,
    status_group: nextStatusGroup,
    status_changed_at: statusChanged ? now : undefined,
    last_error: null,
    consecutive_failures: 0,
    next_check_at: nextMonthlyRefreshAt(new Date(now)),
    raw_current_response: { provider, payload, refresh_mode: "status" },
  });
  await markJobSuccess(job.tax_code);
  return { skipped: false };
}

function retryDelay(attempts) {
  return Math.min(60 * 2 ** Math.max(0, attempts - 1), 3600);
}

async function getPaused() {
  const result = await pool.query(`select setting_value from public.app_settings where setting_key = 'refresh_worker_paused'`);
  return String(result.rows[0]?.setting_value ?? "false").toLowerCase() === "true";
}

async function claimJobs({ codes = null, limit = 10, statusOnly = false, bypassPause = false } = {}) {
  const client = await pool.connect();
  try {
    await client.query("begin");
    if (!bypassPause && (await client.query(`select setting_value from public.app_settings where setting_key = 'refresh_worker_paused'`)).rows[0]?.setting_value === "true") {
      await client.query("commit");
      return [];
    }
    if (!codes) {
      const advisory = await client.query(`select pg_try_advisory_xact_lock(438190042) as locked`);
      if (!advisory.rows[0]?.locked) {
        await client.query("commit");
        return [];
      }
      await client.query(
        `update public.refresh_queue set state = 'retry', locked_at = null, run_after = now(), last_error = coalesce(last_error, 'Worker bị gián đoạn; hàng đợi đã tự đưa về trạng thái thử lại.'), updated_at = now()
         where state = 'running' and locked_at is not null and locked_at < now() - interval '10 minutes'`,
      );
      if ((await client.query(`select 1 from public.refresh_queue where state = 'running' limit 1`)).rows[0]) {
        await client.query("commit");
        return [];
      }
    }

    const parameters = [Math.max(1, Math.min(Number(limit) || 10, 100))];
    const codeClause = codes ? `and q.tax_code = any($2::text[])` : "";
    if (codes) parameters.push(codes);
    const candidates = await client.query(
      `select q.* from public.refresh_queue q where q.state in ('queued','retry') and q.run_after <= now() ${codeClause}
       order by q.priority desc, q.run_after asc for update skip locked limit $1`,
      parameters,
    );
    if (!candidates.rows.length) {
      await client.query("commit");
      return [];
    }
    const taxCodes = candidates.rows.map((row) => row.tax_code);
    const updated = await client.query(
      `update public.refresh_queue q set state = 'running', locked_at = now(), updated_at = now() where q.tax_code = any($1::text[]) returning q.*`,
      [taxCodes],
    );
    await client.query("commit");
    return updated.rows;
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function processJob(job, endpoints, statusOnly, index) {
  try {
    const result = statusOnly
      ? await handleStatusJob(job, endpoints, index < STATUS_PRIMARY_BATCH_SIZE ? "xinvoice" : "vietqr")
      : await handleJob(job, endpoints);
    return { tax_code: job.tax_code, ok: true, ...(result.skipped ? { skipped: true, skipReason: result.skipReason ?? "endpoint_not_newer_than_db", ...(result.needsManualReview ? { needsManualReview: true } : {}) } : {}) };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown worker error";
    const rateLimitMatch = message.match(/^RATE_LIMIT:(\d+)$/);
    const delay = rateLimitMatch ? Number(rateLimitMatch[1]) : error?.retryAfterSeconds ?? retryDelay(job.attempts + 1);
    const nextState = job.attempts + 1 >= Math.max(1, Number(process.env.WORKER_MAX_ATTEMPTS ?? 8)) ? "dead_letter" : "retry";
    await pool.query(
      `update public.refresh_queue set state = $2, attempts = $3, run_after = $4, locked_at = null, last_error = $5, updated_at = now() where tax_code = $1`,
      [job.tax_code, nextState, job.attempts + 1, new Date(Date.now() + delay * 1000).toISOString(), message.slice(0, 500)],
    );
    await updateTaxpayer(job.tax_code, { last_error: message.slice(0, 500), consecutive_failures: job.attempts + 1 });
    return { tax_code: job.tax_code, ok: false, error: message };
  }
}

async function processRequest(body) {
  const requestedTaxCode = normalizeTaxCode(body.taxCode ?? "");
  if (body.taxCode && !isValidTaxCode(requestedTaxCode)) return { status: 400, payload: { error: "Invalid tax code format" } };
  const requestedTaxCodes = Array.isArray(body.taxCodes)
    ? [...new Set(body.taxCodes.filter((value) => typeof value === "string").map(normalizeTaxCode))]
    : [];
  if (Array.isArray(body.taxCodes) && (body.taxCodes.length !== requestedTaxCodes.length || !requestedTaxCodes.length || requestedTaxCodes.some((taxCode) => !isValidTaxCode(taxCode)))) {
    return { status: 400, payload: { error: "Invalid tax code list" } };
  }
  if (body.refreshMode && body.refreshMode !== "data" && body.refreshMode !== "status") return { status: 400, payload: { error: "Invalid refresh mode" } };

  const endpoints = await loadEndpointSettings();
  if (body.preview) {
    if (!requestedTaxCode) return { status: 400, payload: { error: "Tax code is required for preview" } };
    try {
      const { payload, provider } = await fetchWithFallback(requestedTaxCode, endpoints);
      return { status: 200, payload: { ok: true, preview: { tax_code: requestedTaxCode, name: payload.name ?? null, org_type: payload.orgType ?? null, address: payload.address ?? null, tax_department: payload.taxDepartment ?? null, status: payload.status ?? null, status_group: statusGroup(payload.status), source_updated_at: normalizedDate(payload.updatedAt) }, provider } };
    } catch (error) {
      const retryAfterSeconds = error?.retryAfterSeconds;
      return { status: retryAfterSeconds ? 429 : 502, payload: { error: error instanceof Error ? error.message : "Preview lookup failed" }, retryAfterSeconds };
    }
  }

  const statusOnly = body.refreshMode === "status" && !requestedTaxCode && !requestedTaxCodes.length;
  const jobs = await claimJobs({
    codes: requestedTaxCode ? [requestedTaxCode] : requestedTaxCodes.length ? requestedTaxCodes : null,
    limit: statusOnly ? STATUS_BATCH_SIZE : Number(process.env.WORKER_BATCH_SIZE ?? 10),
    statusOnly,
    bypassPause: Boolean(requestedTaxCode || requestedTaxCodes.length),
  });
  const results = [];
  for (let index = 0; index < jobs.length; index += 1) results.push(await processJob(jobs[index], endpoints, statusOnly, index));
  return { status: 200, payload: { processed: results.length, results } };
}

function constantTimeSecretMatches(value) {
  const expected = process.env.REFRESH_WORKER_SECRET ?? "";
  if (!expected || !value) return false;
  const actualBuffer = Buffer.from(value);
  const expectedBuffer = Buffer.from(expected);
  return actualBuffer.length === expectedBuffer.length && timingSafeEqual(actualBuffer, expectedBuffer);
}

function jsonResponse(response, status, payload, extraHeaders = {}) {
  const body = JSON.stringify(payload);
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(body), ...extraHeaders });
  response.end(body);
}

function readRequestBody(request) {
  return new Promise((resolve, reject) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      body += chunk;
      if (body.length > 1_000_000) {
        request.destroy();
        reject(new Error("request body too large"));
      }
    });
    request.on("end", () => {
      if (!body.trim()) return resolve({});
      try { resolve(JSON.parse(body)); } catch { reject(new Error("invalid JSON")); }
    });
    request.on("error", reject);
  });
}

const workerSecretConfigured = Boolean(process.env.REFRESH_WORKER_SECRET && !process.env.REFRESH_WORKER_SECRET.startsWith("replace_with_"));
if (!workerSecretConfigured) throw new Error("REFRESH_WORKER_SECRET is not configured.");

let draining = false;
async function drainQueue() {
  if (draining || await getPaused()) return;
  draining = true;
  try {
    const jobs = await claimJobs({ limit: Number(process.env.WORKER_BATCH_SIZE ?? 10) });
    if (!jobs.length) return;
    const endpoints = await loadEndpointSettings();
    for (let index = 0; index < jobs.length; index += 1) await processJob(jobs[index], endpoints, false, index);
  } catch (error) {
    console.error("refresh worker drain failed", error);
  } finally {
    draining = false;
  }
}

const server = http.createServer(async (request, response) => {
  if (request.method === "GET" && request.url === "/health") {
    return jsonResponse(response, 200, { ok: true, worker: "mst-checker-refresh" });
  }
  if (request.method !== "POST" || request.url !== "/refresh") return jsonResponse(response, 404, { error: "not found" });
  if (!constantTimeSecretMatches(request.headers["x-refresh-secret"])) return jsonResponse(response, 401, { error: "unauthorized" });
  try {
    const result = await processRequest(await readRequestBody(request));
    return jsonResponse(response, result.status, result.payload, result.retryAfterSeconds ? { "retry-after": String(result.retryAfterSeconds) } : {});
  } catch (error) {
    console.error("refresh worker request failed", error);
    return jsonResponse(response, 500, { error: error instanceof Error ? error.message : "worker request failed" });
  }
});

const port = Math.max(1, Number(process.env.WORKER_PORT ?? 3001));
const pollInterval = Math.max(1000, Number(process.env.WORKER_POLL_INTERVAL_MS ?? 5000));
server.listen(port, "0.0.0.0", () => console.log(`MST refresh worker listening on ${port}`));
const timer = setInterval(() => { void drainQueue(); }, pollInterval);
void drainQueue();

async function shutdown(signal) {
  console.log(`MST refresh worker received ${signal}; shutting down.`);
  clearInterval(timer);
  server.close(async () => {
    await pool.end();
    process.exit(0);
  });
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

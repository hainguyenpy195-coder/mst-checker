import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

type RefreshJob = {
  tax_code: string;
  attempts: number;
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

const supabaseUrl = Deno.env.get("SUPABASE_URL");
const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
const clientId = Deno.env.get("XINVOICE_CLIENT_ID");
const apiKey = Deno.env.get("XINVOICE_API_KEY");
const workerSecret = Deno.env.get("REFRESH_WORKER_SECRET");

if (!supabaseUrl || !serviceRoleKey) {
  throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required");
}

const supabase = createClient(supabaseUrl, serviceRoleKey, {
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

async function handleJob(job: RefreshJob) {
  if (!clientId || !apiKey) {
    throw new Error("XInvoice credentials are not configured");
  }

  const response = await fetch(`https://api.xinvoice.vn/gdt-api/tax-payer/${encodeURIComponent(job.tax_code)}`, {
    headers: {
      Accept: "application/json",
      "client-id": clientId,
      "api-key": apiKey,
    },
  });

  if (response.status === 429) {
    const retryAfter = Number(response.headers.get("retry-after") ?? "60");
    const delaySeconds = Number.isFinite(retryAfter) ? Math.max(30, Math.min(retryAfter, 3600)) : 60;
    throw new Error(`RATE_LIMIT:${delaySeconds}`);
  }

  if (!response.ok) {
    throw new Error(`XINVOICE_HTTP_${response.status}`);
  }

  const raw = (await response.json()) as XInvoicePayload | { data?: XInvoicePayload };
  const payload = "data" in raw && raw.data ? raw.data : raw as XInvoicePayload;
  const newStatus = payload.status ?? null;
  const newGroup = statusGroup(newStatus);

  const { data: current, error: currentError } = await supabase
    .from("taxpayers")
    .select("status, status_group")
    .eq("tax_code", job.tax_code)
    .single();

  if (currentError) throw currentError;

  const changed = materialStatusChanged(current.status, current.status_group, newStatus, newGroup);
  const now = new Date().toISOString();

  if (changed) {
    const { error: historyError } = await supabase.from("taxpayer_status_history").insert({
      tax_code: job.tax_code,
      old_status: current.status,
      new_status: newStatus,
      old_status_group: current.status_group,
      new_status_group: newGroup,
      detected_at: now,
      source_updated_at: payload.updatedAt ?? null,
      note: "Status change detected by scheduled XInvoice refresh",
    });
    if (historyError) throw historyError;
  }

  const { error: updateError } = await supabase
    .from("taxpayers")
    .update({
      name: payload.name ?? null,
      org_type: payload.orgType ?? null,
      address: payload.address ?? null,
      tax_department: payload.taxDepartment ?? null,
      status: newStatus,
      status_group: newGroup,
      source_updated_at: payload.updatedAt ?? null,
      last_checked_at: now,
      status_changed_at: changed ? now : undefined,
      last_error: null,
      consecutive_failures: 0,
      next_check_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      raw_current_response: payload,
    })
    .eq("tax_code", job.tax_code);

  if (updateError) throw updateError;

  const { error: queueError } = await supabase
    .from("refresh_queue")
    .update({ state: "success", attempts: 0, locked_at: null, last_error: null })
    .eq("tax_code", job.tax_code);

  if (queueError) throw queueError;
}

function retryDelay(attempts: number) {
  return Math.min(60 * 2 ** Math.max(0, attempts - 1), 3600);
}

Deno.serve(async (request) => {
  if (workerSecret && request.headers.get("x-refresh-secret") !== workerSecret) {
    return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401, headers: { "content-type": "application/json" } });
  }

  const { data: jobs, error: claimError } = await supabase.rpc("claim_refresh_batch", { p_limit: 10 });
  if (claimError) {
    return new Response(JSON.stringify({ error: claimError.message }), { status: 500, headers: { "content-type": "application/json" } });
  }

  const results: Array<{ tax_code: string; ok: boolean; error?: string }> = [];

  for (const job of (jobs ?? []) as RefreshJob[]) {
    try {
      await handleJob(job);
      results.push({ tax_code: job.tax_code, ok: true });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown worker error";
      const rateLimitMatch = message.match(/^RATE_LIMIT:(\d+)$/);
      const delay = rateLimitMatch ? Number(rateLimitMatch[1]) : retryDelay(job.attempts + 1);
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

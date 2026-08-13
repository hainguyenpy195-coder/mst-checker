type WorkerResult = {
  tax_code?: string;
  ok?: boolean;
  error?: string;
  skipped?: boolean;
  skipReason?: string;
};

type WorkerRequest = {
  taxCode?: string;
  preview?: boolean;
};

export type TaxpayerPreview = {
  tax_code: string;
  name: string | null;
  org_type: string | null;
  address: string | null;
  tax_department: string | null;
  status: string | null;
  status_group: string;
  source_updated_at: string | null;
};

export type WorkerResponse = {
  processed?: number;
  results?: WorkerResult[];
  preview?: TaxpayerPreview;
  provider?: "xinvoice" | "vietqr";
  error?: string;
};

function getWorkerConfig() {
  const baseUrl = (process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL ?? "").replace(/\/$/, "");
  const workerSecret = process.env.REFRESH_WORKER_SECRET ?? "";

  if (!baseUrl || !workerSecret || workerSecret.startsWith("replace_with_")) {
    throw new Error("Worker cập nhật chưa được cấu hình trên server.");
  }

  return { url: `${baseUrl}/functions/v1/xinvoice-refresh`, workerSecret };
}

async function invokeWorker(body: WorkerRequest): Promise<WorkerResponse> {
  const { url, workerSecret } = getWorkerConfig();
  const response = await fetch(url, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      "x-refresh-secret": workerSecret,
    },
    body: JSON.stringify(body),
    cache: "no-store",
  });

  const payload = await response.json().catch(() => ({})) as WorkerResponse;
  if (!response.ok) {
    throw new Error(payload.error ?? `Worker trả về HTTP ${response.status}.`);
  }

  return payload;
}

export function invokeTaxpayerRefresh(taxCode: string) {
  return invokeWorker({ taxCode });
}

export function invokeTaxpayerBatchRefresh() {
  return invokeWorker({});
}

export function invokeTaxpayerPreview(taxCode: string) {
  return invokeWorker({ taxCode, preview: true });
}

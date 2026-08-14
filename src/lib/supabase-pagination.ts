export type SupabaseReadResult<T> = {
  data: T[] | null;
  error: unknown | null;
};

const PAGE_SIZE = 1000;
const CODE_BATCH_SIZE = 500;

export async function readAllPages<T>(
  fetchPage: (from: number, to: number) => PromiseLike<SupabaseReadResult<T>>,
  maxRows = 10000,
) {
  const rows: T[] = [];

  while (rows.length < maxRows) {
    const pageSize = Math.min(PAGE_SIZE, maxRows - rows.length);
    const result = await fetchPage(rows.length, rows.length + pageSize - 1);
    if (result.error) return { data: rows, error: result.error };

    const page = result.data ?? [];
    rows.push(...page);
    if (page.length < pageSize) break;
  }

  return { data: rows, error: null };
}

export async function readInCodeBatches<T>(
  taxCodes: string[],
  fetchBatch: (batch: string[]) => PromiseLike<SupabaseReadResult<T>>,
  batchSize = CODE_BATCH_SIZE,
) {
  const safeBatchSize = Number.isSafeInteger(batchSize) && batchSize > 0
    ? batchSize
    : CODE_BATCH_SIZE;
  const batches: string[][] = [];
  for (let index = 0; index < taxCodes.length; index += safeBatchSize) {
    batches.push(taxCodes.slice(index, index + safeBatchSize));
  }

  const results = await Promise.all(batches.map((batch) => fetchBatch(batch)));
  const rows: T[] = [];
  for (const result of results) {
    if (result.error) return { data: rows, error: result.error };
    rows.push(...(result.data ?? []));
  }

  return { data: rows, error: null };
}

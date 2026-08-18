import { Pool, types, type PoolClient } from "pg";
import { createLocalStorageClient } from "@/lib/storage/local";

types.setTypeParser(20, (value) => Number(value));
types.setTypeParser(1082, (value) => value);
types.setTypeParser(1114, (value) => value);
types.setTypeParser(1184, (value) => value);
types.setTypeParser(1700, (value) => value);

export class LocalDatabaseError extends Error {
  code?: string;
}

export type LocalListResult<T> = {
  data: T[] | null;
  error: LocalDatabaseError | null;
  count: number | null;
};

export type LocalSingleResult<T> = {
  data: T | null;
  error: LocalDatabaseError | null;
  count: number | null;
};

export type LocalRpcResult<T = unknown> = {
  data: T | null;
  error: LocalDatabaseError | null;
};

type Filter =
  | { kind: "eq" | "gte" | "lte" | "gt" | "lt"; column: string; value: unknown }
  | { kind: "in"; column: string; values: unknown[] }
  | { kind: "not"; column: string; operator: string; value: unknown }
  | { kind: "or"; expression: string };

type Order = { column: string; ascending: boolean; nullsFirst?: boolean };
type Operation = "select" | "insert" | "update" | "upsert" | "delete";

let pool: Pool | null = null;

function getConnectionString() {
  const configured = process.env.DATABASE_URL?.trim();
  if (configured) return configured;

  const host = process.env.DATABASE_HOST?.trim();
  const user = process.env.DATABASE_USER?.trim();
  const password = process.env.DATABASE_PASSWORD ?? "";
  const database = process.env.DATABASE_NAME?.trim();
  const port = process.env.DATABASE_PORT?.trim() || "5432";
  if (!host || !user || !database) {
    throw new Error("DATABASE_URL hoặc bộ DATABASE_HOST/DATABASE_USER/DATABASE_NAME chưa được cấu hình.");
  }
  return `postgresql://${encodeURIComponent(user)}:${encodeURIComponent(password)}@${host}:${port}/${encodeURIComponent(database)}`;
}

export function getDatabasePool() {
  if (!pool) {
    pool = new Pool({
      connectionString: getConnectionString(),
      max: Math.max(1, Number(process.env.DATABASE_POOL_MAX ?? 10)),
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
      ssl: process.env.DATABASE_SSL === "true" ? { rejectUnauthorized: false } : undefined,
    });
    pool.on("error", (error) => console.error("PostgreSQL pool error", error));
  }
  return pool;
}

export async function closeDatabasePool() {
  if (!pool) return;
  const currentPool = pool;
  pool = null;
  await currentPool.end();
}

function databaseError(error: unknown) {
  if (error instanceof LocalDatabaseError) return error;
  const result = new LocalDatabaseError(error instanceof Error ? error.message : String(error));
  if (error instanceof Error) result.stack = error.stack;
  return result;
}

function quoteIdentifier(value: string) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) {
    throw new Error(`Tên cột/bảng không hợp lệ: ${value}`);
  }
  return `"${value}"`;
}

function quoteTable(value: string) {
  const parts = value.split(".");
  if (parts.length === 1) return quoteIdentifier(parts[0]);
  if (parts.length === 2) return `${quoteIdentifier(parts[0])}.${quoteIdentifier(parts[1])}`;
  throw new Error(`Tên bảng không hợp lệ: ${value}`);
}

function projection(columns: string) {
  const trimmed = columns.trim();
  if (!trimmed || trimmed === "*") return "*";
  return trimmed.split(",").map((part) => {
    const value = part.trim();
    if (value === "*") return "*";
    const aliasMatch = value.match(/^([A-Za-z_][A-Za-z0-9_]*)\s+as\s+([A-Za-z_][A-Za-z0-9_]*)$/i);
    if (aliasMatch) return `${quoteIdentifier(aliasMatch[1])} as ${quoteIdentifier(aliasMatch[2])}`;
    return quoteIdentifier(value);
  }).join(", ");
}

function normalizeTaxCode(value: unknown) {
  return String(value ?? "").trim().replace(/\s+/g, "");
}

function normalizeErrorWithCode(error: unknown) {
  const result = databaseError(error);
  if (error && typeof error === "object" && "code" in error && typeof error.code === "string") {
    result.code = error.code;
  }
  return result;
}

class TableQuery<T = any> implements PromiseLike<LocalListResult<T>> {
  private operation: Operation = "select";
  private selectedColumns = "*";
  private selectOptions: { count?: "exact"; head?: boolean } = {};
  private mutationValues: Record<string, unknown> | Record<string, unknown>[] | null = null;
  private upsertOptions: { onConflict?: string; ignoreDuplicates?: boolean } = {};
  private filters: Filter[] = [];
  private orders: Order[] = [];
  private offset: number | null = null;
  private limitValue: number | null = null;
  private returnRows = false;

  constructor(private readonly tableName: string, private readonly database: LocalDatabaseClient) {}

  select<TSelected = T>(columns = "*", options: { count?: "exact"; head?: boolean } = {}) {
    this.selectedColumns = columns;
    this.selectOptions = options;
    this.returnRows = this.operation !== "select";
    return this as unknown as TableQuery<TSelected>;
  }

  insert(values: Record<string, unknown> | Record<string, unknown>[]) {
    this.operation = "insert";
    this.mutationValues = values;
    return this;
  }

  update(values: Record<string, unknown>) {
    this.operation = "update";
    this.mutationValues = values;
    return this;
  }

  upsert(values: Record<string, unknown> | Record<string, unknown>[], options: { onConflict?: string; ignoreDuplicates?: boolean } = {}) {
    this.operation = "upsert";
    this.mutationValues = values;
    this.upsertOptions = options;
    return this;
  }

  delete() {
    this.operation = "delete";
    return this;
  }

  eq(column: string, value: unknown) {
    this.filters.push({ kind: "eq", column, value });
    return this;
  }

  gte(column: string, value: unknown) {
    this.filters.push({ kind: "gte", column, value });
    return this;
  }

  lte(column: string, value: unknown) {
    this.filters.push({ kind: "lte", column, value });
    return this;
  }

  gt(column: string, value: unknown) {
    this.filters.push({ kind: "gt", column, value });
    return this;
  }

  lt(column: string, value: unknown) {
    this.filters.push({ kind: "lt", column, value });
    return this;
  }

  in(column: string, values: unknown[]) {
    this.filters.push({ kind: "in", column, values });
    return this;
  }

  not(column: string, operator: string, value: unknown) {
    this.filters.push({ kind: "not", column, operator, value });
    return this;
  }

  or(expression: string) {
    this.filters.push({ kind: "or", expression });
    return this;
  }

  order(column: string, options: { ascending?: boolean; nullsFirst?: boolean } = {}) {
    this.orders.push({
      column,
      ascending: options.ascending !== false,
      nullsFirst: options.nullsFirst,
    });
    return this;
  }

  range(from: number, to: number) {
    this.offset = Math.max(0, Math.trunc(from));
    this.limitValue = Math.max(0, Math.trunc(to) - this.offset + 1);
    return this;
  }

  limit(value: number) {
    this.limitValue = Math.max(0, Math.trunc(value));
    return this;
  }

  single<TSingle = T>(): PromiseLike<LocalSingleResult<TSingle>> {
    return new SingleQuery<TSingle>(this as unknown as TableQuery<TSingle>, true);
  }

  maybeSingle<TSingle = T>(): PromiseLike<LocalSingleResult<TSingle>> {
    return new SingleQuery<TSingle>(this as unknown as TableQuery<TSingle>, false);
  }

  private buildWhere(parameters: unknown[]) {
    const clauses: string[] = [];
    const bind = (value: unknown) => {
      parameters.push(value === undefined ? null : value);
      return `$${parameters.length}`;
    };

    for (const filter of this.filters) {
      if (filter.kind === "eq" || filter.kind === "gte" || filter.kind === "lte" || filter.kind === "gt" || filter.kind === "lt") {
        const operator = filter.kind === "eq" ? "=" : filter.kind === "gte" ? ">=" : filter.kind === "lte" ? "<=" : filter.kind === "gt" ? ">" : "<";
        clauses.push(`${quoteIdentifier(filter.column)} ${operator} ${bind(filter.value)}`);
        continue;
      }

      if (filter.kind === "in") {
        if (!filter.values.length) {
          clauses.push("false");
        } else {
          clauses.push(`${quoteIdentifier(filter.column)} in (${filter.values.map(bind).join(", ")})`);
        }
        continue;
      }

      if (filter.kind === "not") {
        const column = quoteIdentifier(filter.column);
        if (filter.operator === "is" && filter.value === null) clauses.push(`${column} is not null`);
        else if (filter.operator === "eq") clauses.push(`${column} <> ${bind(filter.value)}`);
        else throw new Error(`Toán tử not chưa được hỗ trợ: ${filter.operator}`);
        continue;
      }

      if (filter.kind !== "or") continue;

      const alternatives = filter.expression.split(",").map((part: string) => {
        const match = part.match(/^([A-Za-z_][A-Za-z0-9_]*)\.(eq|ilike|like|gte|lte|gt|lt)\.(.*)$/i);
        if (!match) throw new Error("Biểu thức OR không hợp lệ.");
        const operator = match[2].toLowerCase() === "eq" ? "=" : match[2].toUpperCase();
        return `${quoteIdentifier(match[1])} ${operator} ${bind(match[3])}`;
      });
      clauses.push(`(${alternatives.join(" or ")})`);
    }
    return clauses.length ? ` where ${clauses.join(" and ")}` : "";
  }

  private buildSelect(parameters: unknown[]) {
    const table = quoteTable(this.tableName);
    const where = this.buildWhere(parameters);
    let sql = `select ${projection(this.selectedColumns)} from ${table}${where}`;
    if (this.orders.length) {
      sql += ` order by ${this.orders.map((order) => `${quoteIdentifier(order.column)} ${order.ascending ? "asc" : "desc"}${order.nullsFirst === undefined ? "" : order.nullsFirst ? " nulls first" : " nulls last"}`).join(", ")}`;
    }
    if (this.limitValue !== null) sql += ` limit ${this.limitValue}`;
    if (this.offset !== null) sql += ` offset ${this.offset}`;
    return sql;
  }

  private buildMutation(parameters: unknown[]) {
    const table = quoteTable(this.tableName);
    const values = Array.isArray(this.mutationValues) ? this.mutationValues : this.mutationValues ? [this.mutationValues] : [];
    if (!values.length) throw new Error("Dữ liệu ghi database đang rỗng.");

    if (this.operation === "update") {
      const first = values[0];
      const columns = Object.keys(first);
      if (!columns.length) throw new Error("Payload update đang rỗng.");
      const assignments = columns.map((column) => `${quoteIdentifier(column)} = ${(() => { parameters.push(first[column] ?? null); return `$${parameters.length}`; })()}`);
      const sql = `update ${table} set ${assignments.join(", ")}${this.buildWhere(parameters)}`;
      return `${sql}${this.returnRows ? ` returning ${projection(this.selectedColumns)}` : ""}`;
    }

    if (this.operation === "delete") {
      const sql = `delete from ${table}${this.buildWhere(parameters)}`;
      return `${sql}${this.returnRows ? ` returning ${projection(this.selectedColumns)}` : ""}`;
    }

    const columns = [...new Set(values.flatMap((value) => Object.keys(value)))];
    if (!columns.length) throw new Error("Payload insert đang rỗng.");
    const rows = values.map((value) => `(${columns.map((column) => { parameters.push(value[column] ?? null); return `$${parameters.length}`; }).join(", ")})`);
    let sql = `insert into ${table} (${columns.map(quoteIdentifier).join(", ")}) values ${rows.join(", ")}`;
    if (this.operation === "upsert") {
      const conflictColumns = (this.upsertOptions.onConflict ?? "").split(",").map((column) => column.trim()).filter(Boolean);
      if (!conflictColumns.length) throw new Error("Upsert cần onConflict.");
      if (this.upsertOptions.ignoreDuplicates) {
        sql += ` on conflict (${conflictColumns.map(quoteIdentifier).join(", ")}) do nothing`;
      } else {
        const updates = columns.filter((column) => !conflictColumns.includes(column));
        sql += updates.length
          ? ` on conflict (${conflictColumns.map(quoteIdentifier).join(", ")}) do update set ${updates.map((column) => `${quoteIdentifier(column)} = excluded.${quoteIdentifier(column)}`).join(", ")}`
          : ` on conflict (${conflictColumns.map(quoteIdentifier).join(", ")}) do nothing`;
      }
    }
    return `${sql}${this.returnRows ? ` returning ${projection(this.selectedColumns)}` : ""}`;
  }

  async execute(): Promise<LocalListResult<T>> {
    const client = await getDatabasePool().connect();
    try {
      const parameters: unknown[] = [];
      let sql: string;
      if (this.operation === "select") sql = this.buildSelect(parameters);
      else sql = this.buildMutation(parameters);

      if (this.selectOptions.head && this.selectOptions.count === "exact" && this.operation === "select") {
        const countParameters: unknown[] = [];
        const countSql = `select count(*)::int as "__count" from ${quoteTable(this.tableName)}${this.buildWhere(countParameters)}`;
        const countResult = await client.query(countSql, countParameters);
        return { data: null, error: null, count: Number(countResult.rows[0]?.__count ?? 0) };
      }

      const result = await client.query(sql, parameters);
      let count: number | null = null;
      if (this.selectOptions.count === "exact" && this.operation === "select") {
        const countParameters: unknown[] = [];
        const countSql = `select count(*)::int as "__count" from ${quoteTable(this.tableName)}${this.buildWhere(countParameters)}`;
        const countResult = await client.query(countSql, countParameters);
        count = Number(countResult.rows[0]?.__count ?? 0);
      }

      const rows = this.selectOptions.head ? null : result.rows as T[];
      return { data: rows, error: null, count };
    } catch (error) {
      return { data: null, error: normalizeErrorWithCode(error), count: null };
    } finally {
      client.release();
    }
  }

  then<TResult1 = LocalListResult<T>, TResult2 = never>(
    onfulfilled?: ((value: LocalListResult<T>) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): PromiseLike<TResult1 | TResult2> {
    return this.execute().then(onfulfilled as never, onrejected as never);
  }
}

class SingleQuery<T> implements PromiseLike<LocalSingleResult<T>> {
  constructor(private readonly query: TableQuery<T>, private readonly required: boolean) {}

  then<TResult1 = LocalSingleResult<T>, TResult2 = never>(
    onfulfilled?: ((value: LocalSingleResult<T>) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): PromiseLike<TResult1 | TResult2> {
    const promise = this.query.execute().then((result) => {
      const rows = result.data ?? [];
      if (rows.length > 1) return { data: null, error: new LocalDatabaseError("Expected a single row, but multiple rows were returned."), count: result.count };
      if (this.required && rows.length === 0) return { data: null, error: new LocalDatabaseError("Expected a single row, but no rows were returned."), count: result.count };
      return { data: rows[0] ?? null, error: result.error, count: result.count };
    });
    return promise.then(onfulfilled as never, onrejected as never);
  }
}

async function withTransaction<T>(callback: (client: PoolClient) => Promise<T>) {
  const client = await getDatabasePool().connect();
  try {
    await client.query("begin");
    const result = await callback(client);
    await client.query("commit");
    return result;
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function requestTaxpayerRefresh(params: Record<string, unknown>) {
  const taxCode = normalizeTaxCode(params.p_tax_code);
  await getDatabasePool().query(
    `insert into public.refresh_queue (tax_code, priority, state, run_after)
     select tax_code, 10, 'queued', now() from public.taxpayers where tax_code = $1
     on conflict (tax_code) do update set
       priority = greatest(public.refresh_queue.priority, excluded.priority),
       state = case when public.refresh_queue.state in ('success', 'dead_letter', 'cancelled') then 'queued' else public.refresh_queue.state end,
       run_after = least(public.refresh_queue.run_after, excluded.run_after),
       last_error = null,
       updated_at = now()`,
    [taxCode],
  );
  return null;
}

async function setRefreshPaused(params: Record<string, unknown>) {
  const paused = Boolean(params.p_paused);
  await getDatabasePool().query(
    `insert into public.app_settings (setting_key, setting_value, description)
     values ('refresh_worker_paused', $1, 'Tạm dừng hàng đợi cập nhật MST')
     on conflict (setting_key) do update set setting_value = excluded.setting_value, updated_at = now()`,
    [paused ? "true" : "false"],
  );
  return paused;
}

async function enqueueAllTaxpayerRefreshes() {
  const result = await getDatabasePool().query(
    `insert into public.refresh_queue (tax_code, priority, state, attempts, run_after, locked_at, last_error)
     select tax_code, 0, 'queued', 0, now(), null, null from public.taxpayers
     on conflict (tax_code) do update set
       priority = greatest(public.refresh_queue.priority, excluded.priority),
       state = case when public.refresh_queue.state = 'running' then public.refresh_queue.state else 'queued' end,
       attempts = case when public.refresh_queue.state = 'running' then public.refresh_queue.attempts else 0 end,
       run_after = case when public.refresh_queue.state = 'running' then public.refresh_queue.run_after else excluded.run_after end,
       locked_at = case when public.refresh_queue.state = 'running' then public.refresh_queue.locked_at else null end,
       last_error = null,
       updated_at = now()`,
  );
  return result.rowCount ?? 0;
}

async function consumeInvoiceScanQuota(params: Record<string, unknown>) {
  const limit = Math.max(1, Math.min(Number(params.p_limit ?? 200), 100000));
  const result = await getDatabasePool().query(
    `insert into public.invoice_scan_usage (month_start, scan_count, monthly_limit)
     values ((timezone('Asia/Ho_Chi_Minh', now()))::date - (extract(day from timezone('Asia/Ho_Chi_Minh', now()))::int - 1), 1, $1)
     on conflict (month_start) do update set
       scan_count = public.invoice_scan_usage.scan_count + 1,
       monthly_limit = excluded.monthly_limit,
       updated_at = now()
     where public.invoice_scan_usage.scan_count < $1
     returning scan_count, monthly_limit`,
    [limit],
  );
  if (result.rows[0]) return [{ allowed: true, used_count: result.rows[0].scan_count, monthly_limit: result.rows[0].monthly_limit }];

  const current = await getDatabasePool().query(
    `select scan_count, monthly_limit
       from public.invoice_scan_usage
      where month_start = (timezone('Asia/Ho_Chi_Minh', now()))::date - (extract(day from timezone('Asia/Ho_Chi_Minh', now()))::int - 1)`,
  );
  return [{ allowed: false, used_count: current.rows[0]?.scan_count ?? 0, monthly_limit: current.rows[0]?.monthly_limit ?? limit }];
}

async function importTaxpayerBatch(params: Record<string, unknown>) {
  const rows = params.p_rows;
  if (!Array.isArray(rows) || rows.length === 0 || rows.length > 200) throw new Error("taxpayer import batch size is invalid");
  const added: { tax_code: string }[] = [];

  await withTransaction(async (client) => {
    for (const rawItem of rows) {
      if (!rawItem || typeof rawItem !== "object") throw new Error("taxpayer import row is invalid");
      const item = rawItem as Record<string, unknown>;
      const taxCode = normalizeTaxCode(item.tax_code);
      const sources = Array.isArray(item.sources) ? item.sources : [];
      if (!taxCode || !sources.length) throw new Error("taxpayer import source rows are required");
      const firstSource = sources.find((source) => source && typeof source === "object") as Record<string, unknown> | undefined;
      const taxpayerName = String(firstSource?.source_vendor_name ?? "").trim() || null;
      const inserted = await client.query(
        `insert into public.taxpayers (tax_code, name, status_group, next_check_at, needs_manual_review, manual_review_reason, name_source)
         values ($1, $2, 'unknown', now(), $3, $4, $5)
         on conflict (tax_code) do nothing returning tax_code`,
        [taxCode, taxpayerName, Boolean(taxpayerName), taxpayerName ? "Tên Excel đang chờ đối chiếu với endpoint hoặc Cục Thuế." : null, taxpayerName ? "excel_reference" : "unknown"],
      );
      if (!inserted.rows.length && taxpayerName) {
        await client.query(
          `update public.taxpayers set name = $2, needs_manual_review = true,
             manual_review_reason = 'Tên Excel đang chờ đối chiếu với endpoint hoặc Cục Thuế.', name_source = 'excel_reference'
           where tax_code = $1 and (name is null or name = '')`,
          [taxCode, taxpayerName],
        );
      }

      const sourceYears = new Set<string>();
      for (const rawSource of sources) {
        if (!rawSource || typeof rawSource !== "object") throw new Error("taxpayer import source row is invalid");
        const source = rawSource as Record<string, unknown>;
        const sourceSheet = String(source.source_sheet ?? "").trim();
        const sourceYear = String(source.source_year ?? "").trim();
        const sourceRow = Number(source.source_row);
        if (!sourceSheet || !/^\d{4}$/.test(sourceYear) || sourceSheet !== sourceYear || !Number.isInteger(sourceRow) || sourceRow < 1) {
          throw new Error("invalid taxpayer import source row");
        }
        sourceYears.add(sourceYear);
        await client.query(
          `insert into public.taxpayer_sources (
             tax_code, source_sheet, source_year, source_row, source_unit_key, source_unit_label,
             source_unit_marker, source_unit_order, source_vendor_name, source_note, source_imported_at
           ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,now())
           on conflict (tax_code, source_sheet, source_row) do update set
             source_unit_key = coalesce(excluded.source_unit_key, public.taxpayer_sources.source_unit_key),
             source_unit_label = coalesce(excluded.source_unit_label, public.taxpayer_sources.source_unit_label),
             source_unit_marker = coalesce(excluded.source_unit_marker, public.taxpayer_sources.source_unit_marker),
             source_unit_order = coalesce(excluded.source_unit_order, public.taxpayer_sources.source_unit_order),
             source_vendor_name = coalesce(excluded.source_vendor_name, public.taxpayer_sources.source_vendor_name),
             source_note = coalesce(excluded.source_note, public.taxpayer_sources.source_note),
             source_imported_at = now()`,
          [taxCode, sourceSheet, sourceYear, sourceRow, source.source_unit_key ?? null, source.source_unit_label ?? null, source.source_unit_marker ?? null, source.source_unit_order ?? null, source.source_vendor_name ?? null, source.source_note ?? null],
        );
      }

      await client.query(
        `insert into public.refresh_queue (tax_code, priority, state, run_after)
         values ($1, 10, 'queued', now())
         on conflict (tax_code) do update set
           priority = greatest(public.refresh_queue.priority, excluded.priority),
           state = case when public.refresh_queue.state in ('success', 'dead_letter') then 'queued' else public.refresh_queue.state end,
           run_after = least(public.refresh_queue.run_after, excluded.run_after), last_error = null, updated_at = now()`,
        [taxCode],
      );

      if (inserted.rows.length) {
        await client.query(
          `insert into public.taxpayer_activity_logs (action, tax_code, taxpayer_name, source_year, actor_username, details)
           values ('taxpayer_added', $1, $2, $3, $4, $5::jsonb)`,
          [taxCode, taxpayerName, [...sourceYears].sort().join(", ") || null, String(params.p_actor_username ?? "").trim() || "unknown", JSON.stringify({ source: "excel_import", source_years: [...sourceYears] })],
        );
        added.push({ tax_code: taxCode });
      }
    }
  });
  return added;
}

async function replaceTaxpayerSourceUnits(params: Record<string, unknown>) {
  const years = Array.isArray(params.p_source_years) ? params.p_source_years.map(String) : [];
  const units = Array.isArray(params.p_units) ? params.p_units : [];
  await withTransaction(async (client) => {
    if (years.length) await client.query(`delete from public.taxpayer_source_units where source_year = any($1::text[])`, [years]);
    for (const rawUnit of units) {
      if (!rawUnit || typeof rawUnit !== "object") throw new Error("taxpayer source unit is invalid");
      const unit = rawUnit as Record<string, unknown>;
      await client.query(
        `insert into public.taxpayer_source_units (source_year, source_unit_key, source_unit_label, source_unit_marker, source_unit_order)
         values ($1,$2,$3,$4,$5)
         on conflict (source_year, source_unit_key, source_unit_marker) do update set source_unit_label = excluded.source_unit_label, source_unit_order = excluded.source_unit_order, updated_at = now()`,
        [unit.source_year, unit.source_unit_key, unit.source_unit_label, unit.source_unit_marker, unit.source_unit_order],
      );
    }
  });
  return null;
}

async function renameTaxpayerCode(params: Record<string, unknown>) {
  const oldCode = normalizeTaxCode(params.p_old_tax_code);
  const newCode = normalizeTaxCode(params.p_new_tax_code);
  if (oldCode === newCode) return null;

  await withTransaction(async (client) => {
    const current = await client.query(`select * from public.taxpayers where tax_code = $1 for update`, [oldCode]);
    if (!current.rows[0]) throw new Error("taxpayer not found");
    if ((await client.query(`select 1 from public.taxpayers where tax_code = $1`, [newCode])).rows[0]) throw new Error("taxpayer code already exists");
    const taxpayer = current.rows[0];
    await client.query(
      `insert into public.taxpayers (
         tax_code,name,org_type,address,tax_department,status,status_group,source_updated_at,previous_checked_at,
         last_checked_at,status_changed_at,last_error,consecutive_failures,next_check_at,raw_current_response,
         needs_manual_review,manual_review_reason,name_source,created_at
       ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)`,
      [newCode, taxpayer.name, taxpayer.org_type, taxpayer.address, taxpayer.tax_department, taxpayer.status, taxpayer.status_group, taxpayer.source_updated_at, taxpayer.previous_checked_at, taxpayer.last_checked_at, taxpayer.status_changed_at, taxpayer.last_error, taxpayer.consecutive_failures, taxpayer.next_check_at, taxpayer.raw_current_response, taxpayer.needs_manual_review, taxpayer.manual_review_reason, taxpayer.name_source, taxpayer.created_at],
    );
    await client.query(`update public.taxpayer_sources set tax_code = $2 where tax_code = $1`, [oldCode, newCode]);
    await client.query(`update public.taxpayer_status_history set tax_code = $2 where tax_code = $1`, [oldCode, newCode]);
    await client.query(`update public.manual_lookup_sessions set tax_code = $2 where tax_code = $1`, [oldCode, newCode]);
    await client.query(`update public.taxpayer_evidence set tax_code = $2 where tax_code = $1`, [oldCode, newCode]);
    await client.query(
      `update public.refresh_queue set tax_code = $2, priority = greatest(priority,20), state = 'queued', run_after = now(), locked_at = null, last_error = null, updated_at = now() where tax_code = $1`,
      [oldCode, newCode],
    );
    await client.query(
      `insert into public.refresh_queue (tax_code, priority, state, run_after) values ($1,20,'queued',now())
       on conflict (tax_code) do update set priority = greatest(public.refresh_queue.priority, excluded.priority), state = 'queued', run_after = now(), locked_at = null, last_error = null, updated_at = now()`,
      [newCode],
    );
    await client.query(`delete from public.taxpayers where tax_code = $1`, [oldCode]);
    const sourceYears = await client.query(`select string_agg(distinct source_year, ', ' order by source_year) as years from public.taxpayer_sources where tax_code = $1`, [newCode]);
    await client.query(
      `insert into public.taxpayer_activity_logs (action,tax_code,taxpayer_name,source_year,actor_username,details)
       values ('taxpayer_code_updated',$1,$2,$3,$4,$5::jsonb)`,
      [newCode, taxpayer.name, sourceYears.rows[0]?.years ?? null, String(params.p_actor_username ?? "").trim() || "unknown", JSON.stringify({ old_tax_code: oldCode, new_tax_code: newCode })],
    );
  });
  return null;
}

export class LocalDatabaseClient {
  readonly storage = createLocalStorageClient();

  from<T = any>(tableName: string) {
    return new TableQuery<T>(tableName, this);
  }

  async rpc<T = unknown>(functionName: string, params: Record<string, unknown> = {}): Promise<LocalRpcResult<T>> {
    try {
      let data: unknown;
      switch (functionName) {
        case "request_taxpayer_refresh": data = await requestTaxpayerRefresh(params); break;
        case "set_refresh_worker_paused": data = await setRefreshPaused(params); break;
        case "enqueue_all_taxpayer_refreshes": data = await enqueueAllTaxpayerRefreshes(); break;
        case "consume_invoice_scan_quota": data = await consumeInvoiceScanQuota(params); break;
        case "import_taxpayer_batch": data = await importTaxpayerBatch(params); break;
        case "replace_taxpayer_source_units": data = await replaceTaxpayerSourceUnits(params); break;
        case "rename_taxpayer_code": data = await renameTaxpayerCode(params); break;
        default: throw new Error(`RPC local chưa được triển khai: ${functionName}`);
      }
      return { data: data as T, error: null };
    } catch (error) {
      return { data: null, error: normalizeErrorWithCode(error) };
    }
  }
}

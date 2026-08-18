import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import pg from "pg";

const { Pool } = pg;

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

const schemaPath = fileURLToPath(new URL("../db/schema.sql", import.meta.url));
const schemaSql = await fs.readFile(schemaPath, "utf8");
const pool = new Pool({
  connectionString: getConnectionString(),
  max: 1,
  ssl: process.env.DATABASE_SSL === "true" ? { rejectUnauthorized: false } : undefined,
});

const client = await pool.connect();
try {
  await client.query("select pg_advisory_lock(hashtext('mst-checker-local-schema'))");
  await client.query(schemaSql);
  await client.query("select pg_advisory_unlock(hashtext('mst-checker-local-schema'))");
  console.log("Local PostgreSQL schema is ready.");
} finally {
  client.release();
  await pool.end();
}

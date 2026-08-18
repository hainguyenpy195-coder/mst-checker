# Oracle VM / Dokploy deployment

This repository can run as two Dokploy applications in the `mst-checker`
project, backed by the private PostgreSQL service `mst-checker-postgres`.

## Runtime layout

- `mst-checker-web`: Next.js standalone server, container port `3000`.
- `mst-checker-worker`: refresh worker, container port `3001`, private only.
- `mst-checker-postgres`: PostgreSQL 16, container port `5432`, private only.
- VM persistent evidence/import storage: `/data/mst-checker-storage` mounted to
  `/app/storage` in the web application.
- VM PostgreSQL data: `/data/mst-checker-postgres` mounted to
  `/var/lib/postgresql/data` in the PostgreSQL container.

Do not publish PostgreSQL or the worker on an Internet-facing host port. The
web application should be exposed through a Dokploy/Traefik domain, normally
HTTPS on ports 80/443 at the proxy layer.

## Required application variables

Copy the names from `.env.example` into both application services as needed.
Set the actual password and secrets only in Dokploy Environment Variables.

Web application:

- `DATABASE_HOST`, `DATABASE_PORT`, `DATABASE_NAME`, `DATABASE_USER`,
  `DATABASE_PASSWORD`
- `DATABASE_SSL=false`
- `APP_STORAGE_ROOT=/app/storage`
- `WORKER_INTERNAL_URL=http://<worker-internal-host>:3001`
- `REFRESH_WORKER_SECRET` (the same value as the worker)
- `APP_LOGIN_USERNAME`, `APP_LOGIN_PASSWORD`, `APP_SESSION_SECRET`
- `AI_GATEWAY_API_KEY` when invoice AI extraction is enabled

Worker application:

- The database variables above, except `APP_STORAGE_ROOT`.
- `REFRESH_WORKER_SECRET` with exactly the same value as the web application.
- `WORKER_PORT=3001`, `WORKER_POLL_INTERVAL_MS`, `WORKER_BATCH_SIZE`,
  `WORKER_MAX_ATTEMPTS`.

## First deployment sequence

1. Create or select the PostgreSQL service and verify its bind mount under
   `/data/mst-checker-postgres`.
2. Link both applications to the `main` branch and use the repository
   `nhhaituhpy-hue/mst-checker`.
3. Select `Dockerfile` as the build type.
4. Set the web internal port to `3000`; set the worker internal port to `3001`.
5. Bind `/data/mst-checker-storage` to `/app/storage` for the web service.
6. Deploy the web service. Its startup command runs `db/schema.sql` through
   `scripts/migrate-local.mjs` once before starting Next.js.
7. Deploy the worker service with command
   `node scripts/refresh-worker.mjs` after its database variables are present.
8. Add the web domain in Dokploy and test `/api/health`, login, evidence upload,
   Excel import/preview, and one targeted taxpayer refresh.

The schema migration uses a PostgreSQL advisory lock, so simultaneous web and
worker starts do not run the schema concurrently. It is intentionally separate
from the historical Supabase migrations because Supabase Auth, Storage, RLS,
cron, net, and Vault are not part of this self-hosted runtime.

## Backup and recovery

- Back up PostgreSQL from the Dokploy database service or with `pg_dump`.
- Back up `/data/mst-checker-storage` together with the database because the
  database stores evidence metadata and the filesystem stores the private file.
- Test a restore into a non-production database before removing any old data.

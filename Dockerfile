# Next.js standalone image for Dokploy on the ARM64 Oracle VM.
FROM node:22-bookworm-slim AS base

ENV NEXT_TELEMETRY_DISABLED=1 \
    NODE_ENV=production \
    NODE_USE_SYSTEM_CA=1

WORKDIR /app

FROM base AS deps
COPY package.json package-lock.json ./
RUN npm ci

FROM base AS builder
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

FROM base AS runner

ENV HOSTNAME=0.0.0.0 \
    PORT=3000

COPY --from=builder --chown=node:nodejs /app/.next/standalone ./
COPY --from=builder --chown=node:nodejs /app/.next/static ./.next/static
COPY --from=builder --chown=node:nodejs /app/public ./public
COPY --from=builder --chown=node:nodejs /app/scripts/migrate-local.mjs ./scripts/migrate-local.mjs
COPY --from=builder --chown=node:nodejs /app/scripts/refresh-worker.mjs ./scripts/refresh-worker.mjs
COPY --from=builder --chown=node:nodejs /app/db ./db

RUN mkdir -p /app/storage && chown node:node /app/storage

USER node

EXPOSE 3000 3001

CMD ["sh", "-c", "node scripts/migrate-local.mjs && exec node server.js"]

# LEGACY / ALTERNATIVE deployment path (VPS, Fly, Railway). The primary path is Vercel + Supabase - see DEPLOY.md.
# The image is a long-running Node server; it needs a Postgres via DATABASE_URL (docker-compose.yml bundles one).
# syntax=docker/dockerfile:1.7
# ---------- 1. build: install deps + compile TypeScript ----------
FROM node:20-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
COPY scripts ./scripts
COPY api ./api
RUN npm run build \
    && npm prune --omit=dev

# ---------- 2. runtime: small, non-root, no writable state (everything lives in Postgres) ----------
FROM node:20-bookworm-slim AS runtime
ENV NODE_ENV=production \
    PORT=8080 \
    LOG_LEVEL=info
WORKDIR /app
COPY --from=build --chown=root:root /app/node_modules ./node_modules
COPY --from=build --chown=root:root /app/dist ./dist
COPY --chown=root:root public ./public
COPY --chown=root:root migrations ./migrations
COPY --chown=root:root package.json ./
EXPOSE 8080
USER node
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
# Migrations are applied at boot when AUTO_MIGRATE=true (compose sets it); otherwise run `node dist/scripts/migrate.js` as a one-off.
CMD ["node", "dist/src/index.js"]

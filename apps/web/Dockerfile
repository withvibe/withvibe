# syntax=docker/dockerfile:1.7

# ---------- builder ---------------------------------------------------------
FROM node:20-slim AS builder

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable && corepack prepare pnpm@9 --activate

RUN apt-get update \
    && apt-get install --no-install-recommends -y \
        ca-certificates openssl python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /repo

# Manifest-only install for cache.
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY packages/db/package.json packages/db/
COPY packages/cli/package.json packages/cli/

RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile

# Source. db is a workspace dep of web (Prisma types are imported in pages).
COPY packages/db packages/db
COPY apps/web apps/web

# next.config.ts reads API_BASE_URL at config-load time to build the
# /api/auth/* rewrite. With output:"standalone" Next snapshots the rewrite
# target into the bundle, so this MUST be set at build time. Default to the
# compose service name; override with `--build-arg API_BASE_URL=…` if the
# api lives somewhere else.
ARG API_BASE_URL=http://api:4000
ENV API_BASE_URL=${API_BASE_URL}

# Generate the Prisma client (db's prebuild hook) so web's typecheck/build
# can resolve `@withvibe/db`. Then build the web app.
RUN pnpm --filter @withvibe/db build \
    && pnpm --filter @withvibe/web build

# ---------- runtime ---------------------------------------------------------
FROM node:20-slim AS runtime

RUN apt-get update \
    && apt-get install --no-install-recommends -y ca-certificates tini \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

# Next standalone layout: .next/standalone is the self-contained server,
# .next/static and public must be copied alongside it. With monorepo tracing
# the standalone tree mirrors the repo structure under /apps/web.
COPY --from=builder /repo/apps/web/.next/standalone ./
COPY --from=builder /repo/apps/web/.next/static ./apps/web/.next/static
COPY --from=builder /repo/apps/web/public ./apps/web/public

EXPOSE 3000

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "apps/web/server.js"]

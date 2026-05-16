#!/bin/sh
set -e

# The claude child process is dropped to uid 1500 (see the wrapper in the
# Dockerfile), but env clones live under /root/.withvibe/repos. /root must be
# traversable (711) by that user or claude hangs ~30s and exits silently.
# The image already bakes this, but a remounted/recreated /root would lose it
# — re-apply on every start so the fix can't regress. Best-effort: skip if
# not root (compose can run the api as non-root).
[ "$(id -u)" = "0" ] && chmod 711 /root 2>/dev/null || true

# Sync the schema to the database before the app accepts traffic.
#
# We use `prisma db push` to match the project's dev workflow (no migrations/
# folder is checked in — see packages/db/package.json scripts). It's
# idempotent and creates missing tables on a fresh DB. For destructive
# schema changes you'll be prompted; this entrypoint refuses them by default
# (--accept-data-loss is NOT passed). Set SKIP_MIGRATE=1 to bypass.
if [ "${SKIP_MIGRATE:-}" != "1" ]; then
  echo "[entrypoint] running prisma db push…"
  npx --yes prisma db push --schema /app/prisma/schema.prisma
fi

exec "$@"

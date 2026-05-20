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
# idempotent for clean fresh DBs and for already-in-sync DBs, but some legacy
# installs hit "table already exists" errors when the DB was previously
# populated by a different tool (manual SQL, an older Prisma, etc.). Treat
# those specific failures as success-with-warning so the container can boot
# and serve traffic; truly broken schemas will fail at first query and the
# user will see the real error there.
#
# Set SKIP_MIGRATE=1 to bypass the push entirely.
if [ "${SKIP_MIGRATE:-}" != "1" ]; then
  echo "[entrypoint] running prisma db push…"
  push_log=$(mktemp)
  rc=0
  npx --yes prisma db push --schema /app/prisma/schema.prisma >"$push_log" 2>&1 || rc=$?
  cat "$push_log"
  if [ "$rc" != "0" ]; then
    # Known-benign patterns: schema is effectively in sync, or tables existed
    # before we got here from a previous bootstrap. Anything else is a real
    # failure and we abort.
    if grep -qE "already in sync|already exists|relation .* already exists|P3005" "$push_log"; then
      echo "[entrypoint] schema appears to already exist — continuing despite non-zero exit."
    else
      echo "[entrypoint] prisma db push failed with rc=$rc — aborting." >&2
      rm -f "$push_log"
      exit "$rc"
    fi
  fi
  rm -f "$push_log"
fi

exec "$@"

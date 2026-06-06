#!/bin/sh
set -e

# The claude child process is dropped to uid 1500 (see the wrapper in the
# Dockerfile), but env clones live under /root/.withvibe/repos. /root must be
# traversable (711) by that user or claude hangs ~30s and exits silently.
# The image already bakes this, but a remounted/recreated /root would lose it
# — re-apply on every start so the fix can't regress. Best-effort: skip if
# not root (compose can run the api as non-root).
[ "$(id -u)" = "0" ] && chmod 711 /root 2>/dev/null || true

# Optional: install extra apt packages needed by tunnel'd VS Code extensions
# (e.g. openjdk-21-jdk-headless for the Java pack, python3 for the Python pack,
# golang-go for Go). Comma- or whitespace-separated. Skipped if not root or
# the list is empty. Failure is non-fatal so a bad package name can't brick
# the api — check the boot log if an extension still says "not found".
if [ -n "${CODE_TUNNEL_APT_PACKAGES:-}" ] && [ "$(id -u)" = "0" ]; then
  pkgs=$(echo "${CODE_TUNNEL_APT_PACKAGES}" | tr ',' ' ')
  echo "[entrypoint] installing CODE_TUNNEL_APT_PACKAGES: ${pkgs}"
  if apt-get update && apt-get install --no-install-recommends -y $pkgs; then
    echo "[entrypoint] installed: ${pkgs}"
  else
    echo "[entrypoint] WARN: apt install failed for: ${pkgs} — continuing" >&2
  fi
  rm -rf /var/lib/apt/lists/*
fi

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
#
# Transient connectivity/auth errors are retried with backoff rather than
# aborted: on a fresh install Postgres' first-boot window briefly refuses TCP
# password auth (P1000) or isn't reachable yet (P1001), and a hard abort here
# would crash-loop the container instead of simply waiting it out. Real schema
# errors (and the already-in-sync / already-exists states) are NOT retried.
# This mirrors the app's PrismaService connect-with-retry guard so the two
# DB-touching boot paths behave consistently.
if [ "${SKIP_MIGRATE:-}" != "1" ]; then
  max_attempts="${MIGRATE_MAX_ATTEMPTS:-30}"
  delay="${MIGRATE_RETRY_DELAY:-2}"
  attempt=1
  while :; do
    echo "[entrypoint] running prisma db push… (attempt ${attempt}/${max_attempts})"
    push_log=$(mktemp)
    rc=0
    npx --yes prisma db push --schema /app/prisma/schema.prisma >"$push_log" 2>&1 || rc=$?
    cat "$push_log"
    if [ "$rc" = "0" ]; then
      rm -f "$push_log"
      break
    fi
    # Known-benign: schema is effectively in sync, or tables existed before we
    # got here from a previous bootstrap. Treat as success.
    if grep -qE "already in sync|already exists|relation .* already exists|P3005" "$push_log"; then
      echo "[entrypoint] schema appears to already exist — continuing despite non-zero exit."
      rm -f "$push_log"
      break
    fi
    # Transient: DB not ready, auth not yet applied, or briefly unreachable —
    # wait and retry rather than crash-looping the container.
    if grep -qE "P1000|P1001|P1002|Authentication failed|Can't reach database server|Connection refused|the database system is starting up|server closed the connection" "$push_log"; then
      rm -f "$push_log"
      if [ "$attempt" -ge "$max_attempts" ]; then
        echo "[entrypoint] database still not ready after ${max_attempts} attempts — aborting." >&2
        exit "$rc"
      fi
      echo "[entrypoint] database not ready yet (transient) — retrying in ${delay}s…" >&2
      attempt=$((attempt + 1))
      sleep "$delay"
      continue
    fi
    # Anything else is a real schema failure — abort immediately.
    echo "[entrypoint] prisma db push failed with rc=$rc — aborting." >&2
    rm -f "$push_log"
    exit "$rc"
  done
fi

exec "$@"

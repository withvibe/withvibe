#!/usr/bin/env bash
#
# Reclaim docker volumes and clone directories left behind by deleted envs.
#
# Env deletion used to run `docker compose down` without `-v` and never
# removed the env's clone directory, so every deleted env leaked its named
# volumes (db data, caches, node_modules) and its env dir. The code is fixed
# going forward; this script cleans up what already accumulated.
#
# Run it ON THE HOST running the withvibe stack.
#
#   ./gc-orphan-env-resources.sh            # report only — touches nothing
#   ./gc-orphan-env-resources.sh --apply    # actually delete
#
# "Orphan" means: the env id encoded in the resource name has no row in the
# Env table with deletedAt IS NULL. Anything belonging to a live env, and
# anything whose owning env id can't be determined, is left alone.
set -euo pipefail

APPLY=false
[[ "${1:-}" == "--apply" ]] && APPLY=true

DOCKER="docker"
SUDO=""
if ! docker info >/dev/null 2>&1; then
  DOCKER="sudo docker"
  SUDO="sudo"
fi

PG_CONTAINER="${PG_CONTAINER:-withvibe-postgres-1}"
API_CONTAINER="${API_CONTAINER:-withvibe-api-1}"
PG_USER="${PG_USER:-withvibe}"
PG_DB="${PG_DB:-withvibe}"

say() { printf '%s\n' "$*"; }
rule() { printf '%s\n' "------------------------------------------------------------"; }

# ── live env ids ────────────────────────────────────────────────────────────
ALIVE=$(mktemp); trap 'rm -f "$ALIVE"' EXIT
$DOCKER exec "$PG_CONTAINER" psql -U "$PG_USER" -d "$PG_DB" -t -A \
  -c 'select id from "Env" where "deletedAt" is null;' \
  | sed '/^$/d' > "$ALIVE"

if [[ ! -s "$ALIVE" ]]; then
  say "Refusing to continue: got zero live envs from $PG_CONTAINER."
  say "That would classify every resource as an orphan. Check the container name / credentials."
  exit 1
fi
say "Live envs: $(wc -l < "$ALIVE" | tr -d ' ')"

# ── volumes ─────────────────────────────────────────────────────────────────
# Env volumes are named "<project>_<volume>" where project is "withvibe-<envId>".
rule; say "VOLUMES"; rule
orphan_vols=()
kept=0
while read -r vol; do
  [[ -z "$vol" ]] && continue
  env_id="${vol#withvibe-}"; env_id="${env_id%%_*}"
  [[ -z "$env_id" || "$env_id" == "$vol" ]] && continue
  if grep -qxF "$env_id" "$ALIVE"; then
    kept=$((kept + 1))
  else
    orphan_vols+=("$vol")
  fi
done < <($DOCKER volume ls -q | grep '^withvibe-' || true)

say "in use by live envs: $kept"
say "orphaned:            ${#orphan_vols[@]}"
if ((${#orphan_vols[@]})); then
  say ""
  say "Sizes (largest first):"
  for v in "${orphan_vols[@]}"; do
    mp=$($DOCKER volume inspect "$v" --format '{{.Mountpoint}}' 2>/dev/null || true)
    sz=""
    # Volume mountpoints live under /var/lib/docker/volumes — root-only.
    [[ -n "$mp" ]] && sz=$($SUDO du -sh "$mp" 2>/dev/null | cut -f1 || true)
    [[ -z "$sz" ]] && sz="?"
    printf '%10s  %s\n' "$sz" "$v"
  done | sort -rh || true
fi

# ── clone directories ───────────────────────────────────────────────────────
rule; say "CLONE DIRECTORIES"; rule
BASE=$($DOCKER exec "$API_CONTAINER" printenv REPO_BASE_DIR 2>/dev/null || true)
BASE="${BASE:-/home/withvibe/.withvibe/repos}"
say "base: $BASE (inside $API_CONTAINER)"

orphan_dirs=()
while read -r dir; do
  [[ -z "$dir" ]] && continue
  env_id=$(basename "$dir")
  grep -qxF "$env_id" "$ALIVE" || orphan_dirs+=("$dir")
done < <($DOCKER exec "$API_CONTAINER" sh -c \
          "ls -d $BASE/*/clones/*/ 2>/dev/null | sed 's:/$::'" || true)

say "orphaned: ${#orphan_dirs[@]}"
for d in "${orphan_dirs[@]}"; do
  sz=$($DOCKER exec "$API_CONTAINER" du -sh "$d" 2>/dev/null | cut -f1 || echo "?")
  printf '%10s  %s\n' "$sz" "$d"
done

# ── act ─────────────────────────────────────────────────────────────────────
rule
if [[ "$APPLY" != true ]]; then
  say "Report only — nothing was deleted."
  say "Re-run with --apply to remove the ${#orphan_vols[@]} volume(s) and ${#orphan_dirs[@]} director(ies) listed above."
  exit 0
fi

say "Deleting."
if ((${#orphan_vols[@]})); then
  # One at a time: a single rm with N names aborts the whole batch if any one
  # volume is still attached somewhere.
  for v in "${orphan_vols[@]}"; do
    if $DOCKER volume rm "$v" >/dev/null 2>&1; then
      say "  removed volume $v"
    else
      say "  SKIPPED volume $v (still in use?)"
    fi
  done
fi
for d in "${orphan_dirs[@]}"; do
  if $DOCKER exec "$API_CONTAINER" rm -rf "$d" >/dev/null 2>&1; then
    say "  removed dir $d"
  else
    say "  SKIPPED dir $d"
  fi
done
rule
say "Done. Remaining volume usage:"
$DOCKER system df 2>/dev/null | sed -n '1p;/VOLUME/p' || true

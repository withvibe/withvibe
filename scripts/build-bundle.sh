#!/usr/bin/env bash
# Build a self-contained deploy bundle for offline transfer.
#
#   ./scripts/build-bundle.sh
#
# Output: dist/withvibe-deploy-<version>.tar.gz containing:
#   - images.tar          docker images: api, web, postgres, traefik,
#                                        claude-runner, code-server,
#                                        code-tunnel, qa-browser
#                         (matches `withvibe init` default preset)
#   - docker-compose.yml  copied from repo root
#   - .env.example        copied from repo root
#   - INSTALL.md          short instructions for the remote operator
#
# Override the version tag with VERSION=0.1.0 ./scripts/build-bundle.sh
# Skip the (heavy) sidecar images with SKIP_SIDECARS=1.
# Skip the Traefik image with SKIP_TRAEFIK=1 (only safe if the install will
# disable Traefik via custom mode).
# Cross-build for a different host arch with PLATFORM=linux/amd64 (or
# linux/arm64). Defaults to whatever DOCKER_DEFAULT_PLATFORM is set to, or
# the daemon's native platform if neither is set. Always pass this when the
# target host's arch differs from the build machine's.
set -euo pipefail

cd "$(dirname "$0")/.."

VERSION="${VERSION:-latest}"
SKIP_SIDECARS="${SKIP_SIDECARS:-0}"
SKIP_TRAEFIK="${SKIP_TRAEFIK:-0}"
# Target platform for every build/pull in this bundle. Defaults to the host's
# platform (DOCKER_DEFAULT_PLATFORM if set, otherwise the daemon picks). The
# important thing is that we pass it explicitly to `docker build` AND
# `docker pull`: without --platform, `docker pull` happily resolves to
# whatever manifest was cached locally, so a Mac that previously pulled the
# arm64 postgres will keep handing back arm64 even when
# DOCKER_DEFAULT_PLATFORM=linux/amd64 is set. Explicit beats implicit.
PLATFORM="${PLATFORM:-${DOCKER_DEFAULT_PLATFORM:-}}"
PLATFORM_FLAG=()
if [ -n "$PLATFORM" ]; then
  PLATFORM_FLAG=(--platform "$PLATFORM")
  echo "==> Target platform: $PLATFORM"
fi
PG_IMAGE="postgres:17-alpine"
TRAEFIK_IMAGE="traefik:v3.1"
API_IMAGE="withvibe/api:${VERSION}"
WEB_IMAGE="withvibe/web:${VERSION}"
RUNNER_IMAGE="withvibe-claude-runner:${VERSION}"
CODE_SERVER_IMAGE="withvibe-code-server:${VERSION}"
CODE_TUNNEL_IMAGE="withvibe-code-tunnel:${VERSION}"
QA_BROWSER_IMAGE="withvibe-qa-browser:${VERSION}"

# Operator-supplied tunnel customization is baked into the code-tunnel image
# at build time (extensions + apt packages). Read from the host env so the
# same vars that drive `withvibe configure` drive the bundle build.
CODE_TUNNEL_APT_PACKAGES="${CODE_TUNNEL_APT_PACKAGES:-}"
CODE_TUNNEL_EXTENSIONS="${CODE_TUNNEL_EXTENSIONS:-}"
CODE_TUNNEL_BUILD_ARGS=()
[ -n "$CODE_TUNNEL_APT_PACKAGES" ] && \
  CODE_TUNNEL_BUILD_ARGS+=(--build-arg "CODE_TUNNEL_APT_PACKAGES=$CODE_TUNNEL_APT_PACKAGES")
[ -n "$CODE_TUNNEL_EXTENSIONS" ] && \
  CODE_TUNNEL_BUILD_ARGS+=(--build-arg "CODE_TUNNEL_EXTENSIONS=$CODE_TUNNEL_EXTENSIONS")

OUT_DIR="dist/withvibe-deploy-${VERSION}"
TARBALL="dist/withvibe-deploy-${VERSION}.tar.gz"

mkdir -p "$OUT_DIR"
rm -f "$OUT_DIR"/* "$TARBALL"

# Pull a third-party image for the target platform, even if a different
# arch is already cached locally under the same tag. `docker pull` resolves
# tag→digest via the cached manifest first, so without this dance a Mac that
# previously pulled :arm64 keeps handing it back. Pulling by digest forces
# the registry to hand us the platform-specific manifest.
pull_for_platform() {
  local image="$1"
  if [ -z "$PLATFORM" ]; then
    docker pull "$image"
    return
  fi
  local repo="${image%:*}"
  # Resolve the platform-specific digest from the manifest list.
  local digest
  digest="$(docker buildx imagetools inspect "$image" --format '{{json .Manifest}}' \
    | python3 -c 'import json,sys,os
plat=os.environ["PLATFORM"].split("/")
arch=plat[1] if len(plat)>1 else ""
m=json.load(sys.stdin)
manifests=m.get("manifests") or []
for x in manifests:
    p=x.get("platform",{})
    if p.get("os")==plat[0] and p.get("architecture")==arch:
        print(x["digest"]); break' 2>/dev/null || true)"
  if [ -z "$digest" ]; then
    # Single-arch image (no manifest list) — just pull with --platform.
    docker pull ${PLATFORM_FLAG[@]+"${PLATFORM_FLAG[@]}"} "$image"
    return
  fi
  # Drop any stale tag pointing at the wrong arch, then re-tag from the
  # digest pull. This avoids `docker save` failing with "content digest …
  # not found" when the local content store has a half-deleted manifest.
  docker rmi -f "$image" >/dev/null 2>&1 || true
  docker pull "${repo}@${digest}"
  docker tag "${repo}@${digest}" "$image"
}

echo "==> Building $API_IMAGE"
docker build ${PLATFORM_FLAG[@]+"${PLATFORM_FLAG[@]}"} -f apps/api/Dockerfile -t "$API_IMAGE" .

echo "==> Building $WEB_IMAGE"
docker build ${PLATFORM_FLAG[@]+"${PLATFORM_FLAG[@]}"} -f apps/web/Dockerfile -t "$WEB_IMAGE" .

# Sidecar images are spawned by the api at runtime. The api resolves their
# tag from $WITHVIBE_VERSION (passed in via compose), so a single versioned
# tag is enough — no :latest fallback is shipped.
SIDECAR_TAGS=()
if [ "$SKIP_SIDECARS" != "1" ]; then
  echo "==> Building $RUNNER_IMAGE"
  docker build ${PLATFORM_FLAG[@]+"${PLATFORM_FLAG[@]}"} -t "$RUNNER_IMAGE" apps/api/runner

  echo "==> Building $CODE_SERVER_IMAGE"
  docker build ${PLATFORM_FLAG[@]+"${PLATFORM_FLAG[@]}"} -t "$CODE_SERVER_IMAGE" apps/api/code-server-image

  echo "==> Building $CODE_TUNNEL_IMAGE"
  docker build ${PLATFORM_FLAG[@]+"${PLATFORM_FLAG[@]}"} \
    ${CODE_TUNNEL_BUILD_ARGS[@]+"${CODE_TUNNEL_BUILD_ARGS[@]}"} \
    -t "$CODE_TUNNEL_IMAGE" apps/api/code-tunnel-image

  echo "==> Building $QA_BROWSER_IMAGE"
  docker build ${PLATFORM_FLAG[@]+"${PLATFORM_FLAG[@]}"} -t "$QA_BROWSER_IMAGE" apps/api/qa-browser-image

  SIDECAR_TAGS=("$RUNNER_IMAGE" "$CODE_SERVER_IMAGE" "$CODE_TUNNEL_IMAGE" "$QA_BROWSER_IMAGE")
fi

echo "==> Pulling $PG_IMAGE (so the bundle is self-contained)"
PLATFORM="$PLATFORM" pull_for_platform "$PG_IMAGE"

EXTRA_TAGS=()
if [ "$SKIP_TRAEFIK" != "1" ]; then
  echo "==> Pulling $TRAEFIK_IMAGE (default install enables Traefik)"
  PLATFORM="$PLATFORM" pull_for_platform "$TRAEFIK_IMAGE"
  EXTRA_TAGS+=("$TRAEFIK_IMAGE")
fi

# Belt-and-braces: verify every image we're about to bundle reports the
# expected arch. Catches the next time Docker invents a new way to cache
# cross-arch manifests behind our backs.
if [ -n "$PLATFORM" ]; then
  WANT_ARCH="${PLATFORM##*/}"
  for img in "$API_IMAGE" "$WEB_IMAGE" "$PG_IMAGE" "${EXTRA_TAGS[@]}" "${SIDECAR_TAGS[@]}"; do
    GOT_ARCH="$(docker inspect "$img" --format '{{.Architecture}}')"
    if [ "$GOT_ARCH" != "$WANT_ARCH" ]; then
      echo "  ✗ $img is $GOT_ARCH, expected $WANT_ARCH" >&2
      exit 1
    fi
  done
  echo "==> Verified every image is $PLATFORM"
fi

echo "==> Saving images to $OUT_DIR/images.tar"
docker save -o "$OUT_DIR/images.tar" \
  "$API_IMAGE" "$WEB_IMAGE" \
  "$PG_IMAGE" "${EXTRA_TAGS[@]}" "${SIDECAR_TAGS[@]}"

echo "==> Writing bundle.json"
cat > "$OUT_DIR/bundle.json" <<JSON
{
  "version": "${VERSION}"
}
JSON

cp docker-compose.yml "$OUT_DIR/docker-compose.yml"
cp .env.example       "$OUT_DIR/.env.example"

cat > "$OUT_DIR/INSTALL.md" <<EOF
# withvibe — install on this host

Prereqs: Docker 24+ with the compose plugin. The bundle ships api/web/postgres,
Traefik, and the four sidecar images the api spawns dynamically
(claude-runner, code-server, code-tunnel, qa-browser) — matching the
\`withvibe init\` default preset.

## Recommended: guided install
Use the CLI (Node 20+ required):

\`\`\`
npm i -g withvibe
withvibe init --mode from-bundle --install-dir ~/.withvibe
# Pass this bundle's path when prompted, or use the --bundle-path flag.
\`\`\`

## Manual
\`\`\`
docker load -i images.tar
cp .env.example .env       # edit INTERNAL_JWT_SECRET, ANTHROPIC_API_KEY, etc.
docker compose up -d
\`\`\`

Then point a browser at \`http://<this-host>:3000\`.

To stop:    \`docker compose down\`
To upgrade: replace this directory with a newer bundle and run \`docker compose up -d\`.
EOF

echo "==> Compressing bundle"
tar -czf "$TARBALL" -C dist "withvibe-deploy-${VERSION}"
rm -rf "$OUT_DIR"

echo
echo "Bundle ready: $TARBALL"
ls -lh "$TARBALL"

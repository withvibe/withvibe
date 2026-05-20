#!/usr/bin/env bash
# Build + push the 5 stack images to a container registry, multi-arch.
# This is the channel `withvibe init --mode from-registry` (and the hosted
# `curl | bash` installer) pulls from.
#
#   docker login ghcr.io -u <gh-user>            # do this FIRST (not in here)
#   ./scripts/publish-ghcr.sh                     # version = packages/cli/package.json
#   VERSION=0.1.9 ./scripts/publish-ghcr.sh       # explicit version
#   REGISTRY=ghcr.io/withvibe PLATFORMS=linux/amd64,linux/arm64 ./scripts/publish-ghcr.sh
#
# Env overrides:
#   VERSION         image tag (default: packages/cli/package.json version)
#   REGISTRY        namespace (default: ghcr.io/withvibe)
#   PLATFORMS       buildx platforms (default: linux/amd64,linux/arm64)
#   PUSH_LATEST     also tag/push :latest (default: 1)
#   INSTALL_BINFMT  run tonistiigi/binfmt for cross-arch emulation (default: 0;
#                   set 1 on a machine that can't yet build the other arch,
#                   e.g. an Apple-Silicon Mac building linux/amd64)
#
# Image names mirror packages/cli/src/install/images.ts (registryName()):
# the api pulls exactly these on a from-registry install — keep in sync.
set -euo pipefail

cd "$(dirname "$0")/.."

VERSION="${VERSION:-$(node -e "console.log(require('./packages/cli/package.json').version)")}"
REGISTRY="${REGISTRY:-ghcr.io/withvibe}"
PLATFORMS="${PLATFORMS:-linux/amd64,linux/arm64}"
PUSH_LATEST="${PUSH_LATEST:-1}"
INSTALL_BINFMT="${INSTALL_BINFMT:-0}"
BUILDER="withvibe-builder"

echo "==> Publishing ${REGISTRY}/* :${VERSION} (+latest=${PUSH_LATEST}) for ${PLATFORMS}"

# Keep apps/api/package.json and apps/web/package.json's "version" field in
# sync with the release tag. The api falls back to reading its own
# package.json for the UI version label when WITHVIBE_VERSION isn't set or
# is "latest", so an out-of-sync value would show the wrong number.
sync_pkg_version() {
  local pkg="$1"
  node -e "
    const fs = require('fs');
    const p = '$pkg';
    const j = JSON.parse(fs.readFileSync(p, 'utf-8'));
    if (j.version !== '$VERSION') {
      j.version = '$VERSION';
      fs.writeFileSync(p, JSON.stringify(j, null, 2) + '\n');
      console.log('   synced ' + p + ' -> $VERSION');
    }
  "
}
sync_pkg_version apps/api/package.json
sync_pkg_version apps/web/package.json

# Fail early with a clear message if the registry push would 401.
if ! docker buildx imagetools inspect "${REGISTRY}/api:latest" >/dev/null 2>&1; then
  echo "    (note: can't read ${REGISTRY}/api:latest — first publish, or not logged in)"
  echo "    If pushes 401: run  docker login ${REGISTRY%%/*} -u <gh-user>  first."
fi

if [ "$INSTALL_BINFMT" = "1" ]; then
  echo "==> Installing cross-arch emulation (binfmt)"
  docker run --privileged --rm tonistiigi/binfmt --install all
fi

# A docker-container builder is required for multi-arch + push (the default
# docker driver can't emit a manifest list).
if ! docker buildx inspect "$BUILDER" >/dev/null 2>&1; then
  docker buildx create --name "$BUILDER" --driver docker-container >/dev/null
fi
docker buildx use "$BUILDER"
docker buildx inspect --bootstrap >/dev/null

# image | context | dockerfile(optional)
IMAGES=(
  "api|.|apps/api/Dockerfile"
  "web|.|apps/web/Dockerfile"
  "claude-runner|apps/api/runner|"
  "code-server|apps/api/code-server-image|"
  "qa-browser|apps/api/qa-browser-image|"
)

for spec in "${IMAGES[@]}"; do
  IFS='|' read -r name ctx dockerfile <<<"$spec"
  tags=(-t "${REGISTRY}/${name}:${VERSION}")
  [ "$PUSH_LATEST" = "1" ] && tags+=(-t "${REGISTRY}/${name}:latest")
  df=()
  [ -n "$dockerfile" ] && df=(-f "$dockerfile")
  echo "==> ${REGISTRY}/${name}:${VERSION}  (ctx ${ctx})"
  # ${df[@]+...} guard: bash 3.2 (macOS default) errors on an empty array
  # under `set -u` ("unbound variable") — the 3 sidecars have no -f.
  docker buildx build --platform "$PLATFORMS" "${df[@]+"${df[@]}"}" "${tags[@]}" --push "$ctx"
done

echo
echo "==> Verify (each should list both arches):"
for spec in "${IMAGES[@]}"; do
  name="${spec%%|*}"
  echo "-- ${REGISTRY}/${name}:${VERSION}"
  docker buildx imagetools inspect "${REGISTRY}/${name}:${VERSION}" \
    | grep -E "Platform:" || true
done

echo
echo "Published ${REGISTRY}/* :${VERSION}"
echo "Next: flip the ghcr packages to Public (GitHub UI), then republish the"
echo "npm CLI at ${VERSION} so 'curl | bash' delivers the matching CLI."

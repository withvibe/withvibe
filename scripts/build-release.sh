#!/usr/bin/env bash
# Build a withvibe release: CLI npm tarball + Docker image bundle, packaged
# together so a target machine can install everything with one script.
#
#   ./scripts/build-release.sh
#   VERSION=0.1.0 ./scripts/build-release.sh
#   SKIP_SIDECARS=1 SKIP_TRAEFIK=1 ./scripts/build-release.sh
#
# Output: dist/withvibe-release-<version>/
#   - withvibe-<version>.tgz             # the CLI (npm pack output)
#   - withvibe-deploy-<version>.tar.gz   # the Docker image bundle
#   - install-release.sh                 # target-side installer (copy from scripts/)
#   - README.txt                         # one-liner pointing at install-release.sh
#
# Plus dist/withvibe-release-<version>.tar.gz — the same directory tarballed
# for easy transfer (scp, USB, S3, etc.).
set -euo pipefail

cd "$(dirname "$0")/.."
ROOT="$PWD"

VERSION="${VERSION:-0.1.0}"
RELEASE_DIR="dist/withvibe-release-${VERSION}"
RELEASE_TAR="dist/withvibe-release-${VERSION}.tar.gz"

echo "==> Cleaning $RELEASE_DIR"
rm -rf "$RELEASE_DIR" "$RELEASE_TAR"
mkdir -p "$RELEASE_DIR"

echo "==> Setting CLI package version to $VERSION"
# Keep package.json version in sync with the release version so the npm
# tarball lands as withvibe-<version>.tgz.
node -e "
  const fs = require('fs');
  const p = 'packages/cli/package.json';
  const json = JSON.parse(fs.readFileSync(p, 'utf8'));
  if (json.version !== '$VERSION') {
    json.version = '$VERSION';
    fs.writeFileSync(p, JSON.stringify(json, null, 2) + '\n');
    console.log('  updated package.json version → $VERSION');
  } else {
    console.log('  version already $VERSION');
  }
"

echo "==> Building CLI (tsc)"
pnpm --filter withvibe build

echo "==> Packing CLI npm tarball"
(
  cd packages/cli
  rm -f withvibe-*.tgz
  npm pack --silent
)
cp "packages/cli/withvibe-${VERSION}.tgz" "$RELEASE_DIR/"

echo "==> Building image bundle (delegating to build-bundle.sh)"
VERSION="$VERSION" \
  SKIP_SIDECARS="${SKIP_SIDECARS:-0}" \
  SKIP_TRAEFIK="${SKIP_TRAEFIK:-0}" \
  ./scripts/build-bundle.sh
cp "dist/withvibe-deploy-${VERSION}.tar.gz" "$RELEASE_DIR/"

echo "==> Copying target-side installer"
cp scripts/install-release.sh "$RELEASE_DIR/"
chmod +x "$RELEASE_DIR/install-release.sh"

cat > "$RELEASE_DIR/README.txt" <<EOF
withvibe release ${VERSION}

Files:
  withvibe-${VERSION}.tgz             — CLI (installable via npm i -g)
  withvibe-deploy-${VERSION}.tar.gz   — Docker image bundle (api, web, postgres,
                                        traefik, claude-runner, code-server,
                                        qa-browser)
  install-release.sh                  — runs both (CLI install + withvibe init)

To install on a target machine (Node 20+, Docker 24+ required):
  ./install-release.sh
EOF

echo "==> Tarball: $RELEASE_TAR"
tar -czf "$RELEASE_TAR" -C dist "withvibe-release-${VERSION}"

echo
echo "Release ready:"
ls -lh "$RELEASE_DIR/"
echo
echo "Combined tarball: $RELEASE_TAR"
ls -lh "$RELEASE_TAR"

#!/usr/bin/env bash
# Install a withvibe release on this machine.
#
# Run from inside an extracted release directory (the one that contains
# withvibe-<ver>.tgz and withvibe-deploy-<ver>.tar.gz):
#
#   ./install-release.sh
#   ./install-release.sh --install-dir ~/.withvibe
#   ./install-release.sh --yes                      # one-click, no prompts
#
# Flags:
#   --install-dir <path>   where .env / docker-compose.yml / state live
#                          (default: ~/.withvibe)
#   --yes                  pass --yes to `withvibe init` (default preset, no prompts)
#   --no-init              install the CLI only; skip `withvibe init`
#   --keep-bundle          don't delete the extracted bundle dir on success
#
# What it does:
#   1. Verifies Node 20+ and Docker are installed.
#   2. npm-installs the CLI tarball globally.
#   3. Extracts the image bundle next to this script.
#   4. Runs `withvibe init --mode from-bundle --bundle-path <extracted>`
set -euo pipefail

INSTALL_DIR="$HOME/.withvibe"
YES_FLAG=""
DO_INIT=1
KEEP_BUNDLE=0

while [ $# -gt 0 ]; do
  case "$1" in
    --install-dir)
      INSTALL_DIR="$2"
      shift 2
      ;;
    --install-dir=*)
      INSTALL_DIR="${1#*=}"
      shift
      ;;
    --yes|-y)
      YES_FLAG="--yes"
      shift
      ;;
    --no-init)
      DO_INIT=0
      shift
      ;;
    --keep-bundle)
      KEEP_BUNDLE=1
      shift
      ;;
    -h|--help)
      sed -n '2,18p' "$0"
      exit 0
      ;;
    *)
      echo "Unknown flag: $1" >&2
      exit 2
      ;;
  esac
done

cd "$(dirname "$0")"
HERE="$PWD"

echo "==> Preflight"

if ! command -v node >/dev/null 2>&1; then
  echo "  ✗ node not found. Install Node.js 20+: https://nodejs.org" >&2
  exit 1
fi
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$NODE_MAJOR" -lt 20 ]; then
  echo "  ✗ node version is $(node -v); need >= 20" >&2
  exit 1
fi
echo "  ✓ node $(node -v)"

if ! command -v npm >/dev/null 2>&1; then
  echo "  ✗ npm not found (should ship with Node)." >&2
  exit 1
fi
echo "  ✓ npm $(npm -v)"

if ! command -v docker >/dev/null 2>&1; then
  echo "  ✗ docker not found. Install Docker Desktop or the docker engine." >&2
  exit 1
fi
if ! docker info >/dev/null 2>&1; then
  echo "  ✗ docker daemon not running. Start Docker and re-run." >&2
  exit 1
fi
echo "  ✓ docker $(docker --version)"

CLI_TGZ="$(ls -1 "$HERE"/withvibe-*.tgz 2>/dev/null | head -n1 || true)"
if [ -z "$CLI_TGZ" ]; then
  echo "  ✗ No withvibe-*.tgz in $HERE. Are you running this from the release dir?" >&2
  exit 1
fi
echo "  ✓ CLI tarball: $(basename "$CLI_TGZ")"

BUNDLE_TGZ="$(ls -1 "$HERE"/withvibe-deploy-*.tar.gz 2>/dev/null | head -n1 || true)"
if [ -z "$BUNDLE_TGZ" ]; then
  echo "  ✗ No withvibe-deploy-*.tar.gz in $HERE." >&2
  exit 1
fi
echo "  ✓ Image bundle: $(basename "$BUNDLE_TGZ")"

echo
echo "==> Installing CLI globally"
NPM_PREFIX="$(npm prefix -g)"
NPM_PREFIX_OWNER="$(stat -f '%Su' "$NPM_PREFIX" 2>/dev/null || stat -c '%U' "$NPM_PREFIX" 2>/dev/null || echo "")"
if [ "$NPM_PREFIX_OWNER" = "root" ] && [ "$(id -u)" -ne 0 ]; then
  echo "  npm global prefix ($NPM_PREFIX) is root-owned — using sudo."
  sudo npm install -g "$CLI_TGZ"
else
  npm install -g "$CLI_TGZ"
fi

WITHVIBE_BIN="$(command -v withvibe || true)"
if [ -z "$WITHVIBE_BIN" ]; then
  echo "  ✗ \`withvibe\` not on PATH after install. Check npm global prefix is on PATH." >&2
  exit 1
fi
echo "  ✓ withvibe → $WITHVIBE_BIN"

echo
echo "==> Extracting image bundle"
EXTRACT_PARENT="$HOME/.cache/withvibe"
mkdir -p "$EXTRACT_PARENT"
BUNDLE_BASENAME="$(basename "$BUNDLE_TGZ" .tar.gz)"
EXTRACTED_DIR="$EXTRACT_PARENT/$BUNDLE_BASENAME"
rm -rf "$EXTRACTED_DIR"
tar -xzf "$BUNDLE_TGZ" -C "$EXTRACT_PARENT"
if [ ! -d "$EXTRACTED_DIR" ]; then
  echo "  ✗ Extracted dir not found at $EXTRACTED_DIR" >&2
  exit 1
fi
echo "  ✓ Bundle extracted to $EXTRACTED_DIR"

if [ "$DO_INIT" -eq 0 ]; then
  echo
  echo "CLI installed. Skipping init (--no-init). Run when ready:"
  echo "  withvibe init --mode from-bundle --install-dir $INSTALL_DIR --bundle-path $EXTRACTED_DIR"
  exit 0
fi

echo
echo "==> Running withvibe init (mode=from-bundle)"
echo "    install-dir: $INSTALL_DIR"
echo "    bundle:      $EXTRACTED_DIR"
echo
withvibe init \
  --mode from-bundle \
  --install-dir "$INSTALL_DIR" \
  --bundle-path "$EXTRACTED_DIR" \
  $YES_FLAG

if [ "$KEEP_BUNDLE" -eq 0 ]; then
  echo
  echo "==> Cleaning up extracted bundle ($EXTRACTED_DIR)"
  rm -rf "$EXTRACTED_DIR"
fi

echo
echo "Done. \`withvibe status\` to check the stack, \`withvibe configure\` to add secrets."

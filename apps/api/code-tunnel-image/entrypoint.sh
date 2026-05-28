#!/bin/sh
# Per-user `code tunnel` entrypoint. CodeTunnelSidecarService sets:
#   TUNNEL_NAME    Microsoft tunnel name (per-user, stable)
# Optional:
#   RECONNECTION_GRACE_SECONDS   seconds the VS Code Server is kept warm
#                                after the client disconnects. Default 600
#                                (10 min) — much lower than upstream's 10800
#                                (3 hours) so per-user RAM frees quickly
#                                after the window is closed. Cost: a stale
#                                reconnect reloads the extension host.
#   CODE_TUNNEL_EXTRA_ARGS       appended to the `code tunnel` argv
set -e

if [ -z "${TUNNEL_NAME:-}" ]; then
  echo "FATAL: TUNNEL_NAME env var is required (set by CodeTunnelSidecarService)" >&2
  exit 2
fi

exec code tunnel \
  --accept-server-license-terms \
  --name "$TUNNEL_NAME" \
  --cli-data-dir /home/coder/.vscode-cli \
  --reconnection-grace-time "${RECONNECTION_GRACE_SECONDS:-600}" \
  ${CODE_TUNNEL_EXTRA_ARGS:-}

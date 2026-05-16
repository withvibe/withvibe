#!/usr/bin/env bash
# Bring up the stack in dependency order with real readiness gates so a
# slow Xvfb / x11vnc start can't race chromium into a crash.
#
# Notes on CDP exposure:
# Recent chromium (114+) silently ignores `--remote-debugging-address=0.0.0.0`
# and always binds CDP to 127.0.0.1 inside the container. The host port-forward
# then has nothing to talk to ("connection reset"). Standard workaround: run
# chromium on an INTERNAL loopback port (9223) and use a tiny socat forwarder
# to expose it on 0.0.0.0:9222. Playwright's connectOverCDP rewrites the host
# of webSocketDebuggerUrl to match the endpoint URL it was given, so the
# rewrite is transparent.

set -euo pipefail

export DISPLAY=:99
export HOME=/root
mkdir -p /tmp/chromium-data

echo "[qa-browser] starting Xvfb…"
Xvfb :99 -screen 0 1366x768x24 -nolisten tcp +extension RANDR &
for _ in $(seq 1 40); do
  if xdpyinfo -display :99 >/dev/null 2>&1; then break; fi
  sleep 0.25
done
xdpyinfo -display :99 >/dev/null || { echo "[qa-browser] Xvfb never came up"; exit 1; }
echo "[qa-browser] Xvfb ready"

echo "[qa-browser] starting x11vnc…"
x11vnc -display :99 -forever -nopw -shared -rfbport 5900 -bg -quiet
for _ in $(seq 1 20); do
  if (echo > /dev/tcp/127.0.0.1/5900) 2>/dev/null; then break; fi
  sleep 0.25
done
echo "[qa-browser] x11vnc ready on :5900"

echo "[qa-browser] starting noVNC websockify…"
websockify -D --web=/usr/share/novnc 7900 127.0.0.1:5900
for _ in $(seq 1 20); do
  if (echo > /dev/tcp/127.0.0.1/7900) 2>/dev/null; then break; fi
  sleep 0.25
done
echo "[qa-browser] noVNC ready on :7900"

echo "[qa-browser] launching chromium with internal CDP on 127.0.0.1:9223…"
# host-resolver-rules: rewrite `localhost` → `host.docker.internal` so React
# bundles built with PUBLIC_HOST=localhost still reach the env's published
# ports on the host. IP literals (127.0.0.1) bypass the resolver and are
# unaffected, so chromium's own loopback machinery is untouched.
chromium \
  --no-sandbox \
  --disable-setuid-sandbox \
  --disable-gpu \
  --disable-dev-shm-usage \
  --user-data-dir=/tmp/chromium-data \
  --remote-debugging-port=9223 \
  --remote-allow-origins=* \
  --host-resolver-rules="MAP localhost host.docker.internal" \
  --window-size=1366,768 \
  --start-maximized \
  --no-first-run \
  --no-default-browser-check \
  --disable-features=Translate,MediaRouter \
  about:blank &

# Wait for chromium's internal CDP to come up. Cold start can take ~5s.
for _ in $(seq 1 60); do
  if (echo > /dev/tcp/127.0.0.1/9223) 2>/dev/null; then break; fi
  sleep 0.5
done
(echo > /dev/tcp/127.0.0.1/9223) 2>/dev/null || {
  echo "[qa-browser] chromium CDP never opened on :9223"; exit 1;
}
echo "[qa-browser] chromium CDP ready on 127.0.0.1:9223"

echo "[qa-browser] forwarding 0.0.0.0:9222 → 127.0.0.1:9223 (foreground)"
exec socat -d TCP-LISTEN:9222,reuseaddr,fork TCP:127.0.0.1:9223

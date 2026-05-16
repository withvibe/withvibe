# Headed Chromium for the QA agent.
# - Xvfb :99 — virtual display
# - x11vnc — exposes the display via VNC
# - websockify+noVNC — serves the live view as plain HTTP on :7900
# - chromium — runs against :99 with CDP exposed on :9222
#
# Ports are intentionally NOT password-protected. The API only ever publishes
# them to 127.0.0.1, so only same-machine processes can reach them.

FROM debian:bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
      chromium \
      xvfb \
      x11vnc \
      x11-utils \
      novnc \
      websockify \
      socat \
      tini \
      bash \
      ca-certificates \
      dbus-x11 \
      fonts-liberation \
      fonts-noto-core \
      fonts-noto-cjk \
      fonts-noto-color-emoji \
      procps \
    && rm -rf /var/lib/apt/lists/*

COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

# 7900: noVNC HTTP UI — what the user iframes
# 9222: Chrome DevTools Protocol — what Playwright connects to
EXPOSE 7900 9222

ENTRYPOINT ["/usr/bin/tini", "--", "/entrypoint.sh"]

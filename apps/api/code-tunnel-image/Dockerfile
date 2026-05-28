# Per-user `code tunnel` sidecar for the desktop VS Code path. Spawned by
# CodeTunnelSidecarService — one container per user (not per env), reused
# across every env that user opens. Env clones are bind-mounted in lazily as
# the user opens each env.
#
# Built to: withvibe-code-tunnel:<version>
# Manual:   docker build -t withvibe-code-tunnel apps/api/code-tunnel-image
#
# Build args (rebuild + redeploy required when changed):
#   CODE_TUNNEL_APT_PACKAGES   comma- or space-separated extra apt packages
#                              (e.g. "openjdk-21-jdk-headless,python3,golang-go")
#   CODE_TUNNEL_EXTENSIONS     comma-separated extra VS Code extension IDs
#                              (anthropic.claude-code is always installed)

FROM debian:12-slim

ARG CODE_TUNNEL_APT_PACKAGES=""
ARG CODE_TUNNEL_EXTENSIONS=""

# Base tooling. libsecret/libnss/libgtk are pulled in because some extensions
# (incl. the Claude Code extension's authentication path) link against them
# the moment they load, even in a headless tunnel server.
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl git gnupg jq tini ripgrep sudo \
      libsecret-1-0 libnss3 libatk1.0-0 libatk-bridge2.0-0 \
      libgbm1 libgtk-3-0 libasound2 libx11-xcb1 libxshmfence1 \
    && rm -rf /var/lib/apt/lists/*

# Operator-supplied extras (baked in at build time, not entrypoint, so first
# tunnel start is fast).
RUN if [ -n "$CODE_TUNNEL_APT_PACKAGES" ]; then \
      pkgs=$(echo "$CODE_TUNNEL_APT_PACKAGES" | tr ',' ' '); \
      echo "Installing CODE_TUNNEL_APT_PACKAGES: $pkgs"; \
      apt-get update && apt-get install -y --no-install-recommends $pkgs \
      && rm -rf /var/lib/apt/lists/*; \
    fi

# VS Code CLI — standalone tarball is much smaller than the full `code` apt
# package and is the only thing we need for `code tunnel`. Multi-arch.
# Use the `update.code.visualstudio.com` endpoint (302s to the actual asset);
# the marketing-site `sha/download?...` endpoint returns 404 for `cli-*`
# targets.
RUN set -eux; \
    ARCH=$(dpkg --print-architecture); \
    case "$ARCH" in \
      amd64) TARGET=cli-linux-x64 ;; \
      arm64) TARGET=cli-linux-arm64 ;; \
      *) echo "Unsupported arch: $ARCH" >&2; exit 1 ;; \
    esac; \
    curl -fsSL "https://update.code.visualstudio.com/latest/${TARGET}/stable" \
      -o /tmp/code.tgz; \
    tar -xzf /tmp/code.tgz -C /usr/local/bin; \
    rm /tmp/code.tgz; \
    code --version

# Node + Claude Code CLI so the Claude Code extension can shell out. The
# extension auto-discovers `claude` on PATH; ANTHROPIC_API_KEY is injected at
# container start by CodeTunnelSidecarService from the workspace's stored key.
RUN curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/* \
    && npm install -g @anthropic-ai/claude-code

# Non-root user. gid 1500 matches CLAUDE_GID (see
# apps/api/src/common/repo-base-dir.ts) so the bind-mounted env clones —
# group-owned by 1500 with the setgid bit — stay readable/writable from the
# tunnel terminal.
RUN groupadd -g 1500 coder \
    && useradd -m -u 1500 -g 1500 -s /bin/bash coder

USER coder
ENV HOME=/home/coder

# Pre-install extensions into the CLI data dir. anthropic.claude-code is
# always installed; CODE_TUNNEL_EXTENSIONS appends more. Idempotent: failures
# are warned-only so an offline build still produces a working image (the
# user can install via the recommendations prompt on first connect).
#
# The per-user data volume is mounted at /home/coder at runtime. Docker
# initializes a fresh volume from the image's directory contents on first
# attach, so these baked extensions become the user's defaults until they
# (or a later image) update them. Existing per-user volumes are NOT
# overwritten on image upgrade — installed extensions persist across upgrades.
RUN mkdir -p /home/coder/.vscode-cli /home/coder/.claude
RUN EXTS="anthropic.claude-code"; \
    if [ -n "$CODE_TUNNEL_EXTENSIONS" ]; then \
      EXTRA=$(echo "$CODE_TUNNEL_EXTENSIONS" | tr ',' ' '); \
      EXTS="$EXTS $EXTRA"; \
    fi; \
    for ext in $EXTS; do \
      echo "Pre-installing $ext"; \
      code --install-extension "$ext" --cli-data-dir /home/coder/.vscode-cli --force \
        || echo "WARN: pre-install of $ext failed (will retry from recommendations prompt)" >&2; \
    done

# Entrypoint reads TUNNEL_NAME from the env (set by the spawner) and execs
# `code tunnel`. tini reaps zombies.
COPY --chown=coder:coder entrypoint.sh /usr/local/bin/withvibe-tunnel-entrypoint.sh
RUN chmod +x /usr/local/bin/withvibe-tunnel-entrypoint.sh

WORKDIR /home/coder
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/withvibe-tunnel-entrypoint.sh"]

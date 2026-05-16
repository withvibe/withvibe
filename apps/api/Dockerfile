# syntax=docker/dockerfile:1.7

# ---------- builder ---------------------------------------------------------
FROM node:20-slim AS builder

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable && corepack prepare pnpm@9 --activate

# OS deps prisma's engine download + node-gyp need.
RUN apt-get update \
    && apt-get install --no-install-recommends -y \
        ca-certificates \
        openssl \
        python3 \
        make \
        g++ \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /repo

# Install with manifests only first so the layer caches across source edits.
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY packages/db/package.json packages/db/
COPY packages/cli/package.json packages/cli/

RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile

# Source after install so edits don't bust the dep cache.
COPY packages/db packages/db
COPY apps/api apps/api

# Build db (runs `prisma generate` via its prebuild hook), then api.
RUN pnpm --filter @withvibe/db build \
    && pnpm --filter @withvibe/api build

# `pnpm deploy` flattens workspace deps into real folders — no symlinks back
# to /repo — and prunes dev deps. Result is a self-contained dir we can copy
# straight into the runtime image.
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm --filter @withvibe/api --prod deploy /out/api

# ---------- runtime ---------------------------------------------------------
FROM node:20-slim AS runtime

# tini: PID 1 so SIGTERM reaches Node.
# git: worktree.service.ts shells out to git.
# docker CLI + compose plugin: api drives compose via DooD.
# openssl, ca-certificates: prisma + outbound HTTPS.
RUN apt-get update \
    && apt-get install --no-install-recommends -y \
        ca-certificates curl gnupg openssl git tini \
    && install -m 0755 -d /etc/apt/keyrings \
    && curl -fsSL https://download.docker.com/linux/debian/gpg \
        | gpg --dearmor -o /etc/apt/keyrings/docker.gpg \
    && chmod a+r /etc/apt/keyrings/docker.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/debian $(. /etc/os-release && echo $VERSION_CODENAME) stable" \
        > /etc/apt/sources.list.d/docker.list \
    && apt-get update \
    && apt-get install --no-install-recommends -y \
        docker-ce-cli \
        docker-compose-plugin \
    && rm -rf /var/lib/apt/lists/*

# VS Code CLI (standalone `code` binary) so CodeTunnelService can run
# `code tunnel` from inside the container. Microsoft ships a single-binary
# tarball (~30MB) separate from full VS Code. Resolve arch at build time so
# the same Dockerfile works for linux/amd64 and linux/arm64.
RUN set -e; \
    case "$(dpkg --print-architecture)" in \
        amd64) vscArch=cli-linux-x64 ;; \
        arm64) vscArch=cli-linux-arm64 ;; \
        *) echo "Unsupported arch for VS Code CLI: $(dpkg --print-architecture)" >&2; exit 1 ;; \
    esac; \
    curl -fsSL "https://update.code.visualstudio.com/latest/${vscArch}/stable" \
        -o /tmp/vscode-cli.tar.gz; \
    tar -xzf /tmp/vscode-cli.tar.gz -C /usr/local/bin; \
    rm /tmp/vscode-cli.tar.gz; \
    chmod +x /usr/local/bin/code; \
    /usr/local/bin/code --version

# The Agent SDK invokes a `claude` binary at runtime by require-resolving
# `@anthropic-ai/claude-agent-sdk-linux-${arch}[-musl]/claude`. Those native
# packages get installed by pnpm but their bundled binary is missing on
# arm64+glibc, so we install the npm `claude-code` CLI globally and below
# (a) symlink that binary into the dirs the SDK probes, and (b) wrap it so
# we drop privileges before exec — Claude Code refuses to run as root with
# `--dangerously-skip-permissions`, but the api container has to run as
# root for the docker.sock bind-mount.
RUN npm install -g @anthropic-ai/claude-code \
    && apt-get update \
    && apt-get install --no-install-recommends -y util-linux \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd -g 1500 claude \
    && useradd -m -u 1500 -g 1500 -s /bin/sh claude \
    && cp -L "$(readlink -f /usr/local/bin/claude)" /usr/local/bin/claude.real \
    && chmod +x /usr/local/bin/claude.real \
    && printf '%s\n' \
        '#!/bin/sh' \
        '# Claude Code refuses --dangerously-skip-permissions when running as' \
        '# root. The api container is root (needs docker.sock), so drop privs' \
        '# just for the claude child process.' \
        'if [ "$(id -u)" = "0" ]; then' \
        '  exec runuser -u claude -- /usr/local/bin/claude.real "$@"' \
        'else' \
        '  exec /usr/local/bin/claude.real "$@"' \
        'fi' \
        > /usr/local/bin/claude.wrapper \
    && chmod +x /usr/local/bin/claude.wrapper \
    && ln -sf /usr/local/bin/claude.wrapper /usr/local/bin/claude \
    # Env clones live under the api's HOME (/root/.withvibe/repos) because the
    # container runs as root. But the claude child is dropped to uid 1500 by
    # the wrapper above, and /root is mode 700 — so claude can't even traverse
    # into its own working dir. It then hangs ~30s and exits with no output
    # and no error (run shows "done" with an empty reply). 711 lets the claude
    # user *traverse* /root without being able to read/list it.
    && chmod 711 /root

WORKDIR /app

# /out/api contains: package.json, dist/, node_modules/ (with @withvibe/db
# materialized including its built dist/ and prisma generated/ output).
COPY --from=builder /out/api ./

# Symlink the wrapper into every claude-agent-sdk native package dir under
# .pnpm so the SDK finds it regardless of which platform variant it tries
# first. Runs after the COPY because /app/node_modules is only present then.
RUN set -e; \
    found=0; \
    for d in /app/node_modules/.pnpm/@anthropic-ai+claude-agent-sdk-*; do \
        [ -d "$d" ] || continue; \
        for inner in "$d"/node_modules/@anthropic-ai/claude-agent-sdk-*; do \
            [ -d "$inner" ] || continue; \
            ln -sf /usr/local/bin/claude.wrapper "$inner/claude"; \
            found=1; \
        done; \
    done; \
    if [ "$found" = "0" ]; then \
        echo "WARN: no claude-agent-sdk native package dirs found to symlink" >&2; \
    fi

# Schema for `prisma migrate deploy` at container start.
COPY --from=builder /repo/packages/db/prisma ./prisma

# Runtime prisma config: reads DATABASE_URL from process env.
COPY apps/api/prisma.config.runtime.mjs ./prisma.config.mjs

COPY apps/api/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

ENV NODE_ENV=production
ENV PORT=4000
EXPOSE 4000

ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/docker-entrypoint.sh"]
CMD ["node", "dist/main.js"]

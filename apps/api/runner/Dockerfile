# Claude Code runner — one sidecar container per env. Bind-mounts the env
# clone at /workspace and joins the env's compose network so `claude` can
# reach the user's services by service name. Phase 4 invokes the CLI here
# via `docker exec -i <container> claude -p ... --output-format stream-json`.
#
# Built locally by ClaudeRunnerService on first use (see
# apps/api/src/runner/claude-runner.service.ts). Not pushed to any registry
# yet — in Phase 5 we'll switch to a registry-based workflow for multi-host.

FROM node:20-slim

# git: needed for the claude CLI's built-in repo awareness.
# tini: PID 1 so Ctrl-C / docker stop propagates cleanly to children.
# ca-certificates: outbound HTTPS to api.anthropic.com and the MCP bridge.
# curl: debugging + health probes.
RUN apt-get update \
    && apt-get install --no-install-recommends -y \
        git \
        tini \
        ca-certificates \
        curl \
    && rm -rf /var/lib/apt/lists/*

# Latest published CLI. We pin on the runner image, not on the npm dep tree —
# rebuild the image to bump.
RUN npm install -g @anthropic-ai/claude-code

WORKDIR /workspace

# Long-lived idle process — Phase 4 uses `docker exec` to drive the CLI
# per-turn. tini reaps zombies so repeated execs don't leak.
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["sleep", "infinity"]

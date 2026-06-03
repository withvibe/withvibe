# withvibe-code-tunnel

Per-user `code tunnel` sidecar for the "Open in VS Code (Desktop)" action.

## Why this image exists

The original implementation ran `code tunnel` as a child process **inside the
api container**, which had three problems:

1. The api container bind-mounts every workspace's env clones → the terminal
   inside the user's VS Code window saw every other env.
2. The api container mounts `/var/run/docker.sock` → the terminal could
   `docker exec` into anything on the host, effectively root on the host.
3. The api runs as root.

This image hosts `code tunnel` in a dedicated, non-root sandbox: only the
user's authorized env dirs are bind-mounted, no docker socket, no host
access, attached only to the env compose networks the user has open.

## One container per user (not per env)

A single sidecar is started per user (name `withvibe-tunnel-<userIdSuffix>`)
and reused across every env that user opens. The user's IDE state — installed
extensions, settings, Claude Code config, Microsoft tunnel auth — lives in
a per-user named volume (`code-tunnel-user-<userId>`) mounted at
`/home/coder`. That state survives container restarts, image upgrades, and
opening new envs.

This is the deliberate trade-off: the user can already reach all their envs
through the api today (no per-user-per-env permission model yet), so sharing
a sidecar across envs doesn't add new access. When per-env permissions ship,
the spawner just narrows which env dirs it bind-mounts — image unchanged.

## Build args (rebuild + redeploy when changed)

- `CODE_TUNNEL_APT_PACKAGES` — comma- or space-separated apt packages to
  bake in (e.g. `openjdk-21-jdk-headless,python3,golang-go`). Needed when
  pre-installed extensions require runtime tooling on PATH.
- `CODE_TUNNEL_EXTENSIONS` — comma-separated VS Code extension IDs to
  pre-install in addition to the always-on `anthropic.claude-code`.

Both are also accepted as env vars on the api container so the same install
config drives both `withvibe-code-server` and `withvibe-code-tunnel` builds.

## Build

```
docker build -t withvibe-code-tunnel apps/api/code-tunnel-image
```

Or via the bundle / install pipeline — this image is enumerated by the
[`withvibe` CLI](https://github.com/withvibe/withvibe-cli) (`src/install/images.ts`)
and built by `scripts/build-bundle.sh`.

## Runtime contract

Spawner must set:

- `TUNNEL_NAME` env var — the Microsoft tunnel name to register (`wv-u-<suffix>`).
- Bind mounts:
  - Each env dir the user is authorized for, at `/workspace/<workspaceId>/<envId>`.
  - The per-user volume at `/home/coder` (extension + auth state).
- Optional: `ANTHROPIC_API_KEY` env var if the workspace has a stored key.
- Network: attached to each env's compose network as the user opens envs
  (lazy `docker network connect` from the spawner).

No `--privileged`, no `docker.sock`, no extra mounts.

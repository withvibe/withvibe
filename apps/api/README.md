# @withvibe/api

NestJS backend for withvibe. Owns Docker orchestration of
environments, agent runs, terminal WebSockets, and the REST API consumed by
the web app via an internal JWT bridge.

## Run

```bash
cp .env.example .env
# edit .env

pnpm --filter @withvibe/api start:dev   # or `pnpm dev:api` from the repo root
```

The server listens on `http://localhost:${API_PORT}/api` (default `4000`) and
upgrades WebSocket connections at `/api/terminal/:envId/:container`.

## Modules

| Module | Responsibility |
| --- | --- |
| `auth` | JWT bridge auth between the web app and this API |
| `workspaces` | Workspace CRUD, secrets, members |
| `templates` | Env templates, repos, routing config |
| `envs` | Environment lifecycle (create, share, archive) |
| `agents` | Agent definitions, runs, orchestration |
| `chat` | AI chat sessions and message segments |
| `runner` | Out-of-process worker runners (Claude Agent SDK, etc.) |
| `docker` | Docker / Docker Compose orchestration |
| `terminal` | xterm WebSocket bridge to container shells |
| `ports` | Per-env host port allocation |
| `git`, `repos`, `worktrees` | Repo clone / branch / worktree management |
| `mcp-bridge` | Model Context Protocol bridge |
| `members`, `invitations`, `account` | User and membership management |

## Environment

See the [root README](../../README.md#environment-variables) for the full env
var reference.

## Links

- Website / docs: <https://withvibe.dev>

## License

Elastic License 2.0 — see the [root LICENSE](../../LICENSE).

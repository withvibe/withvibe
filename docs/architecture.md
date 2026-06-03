# Architecture

A high-level map of the WithVibe monorepo for contributors. For product
context and setup, start with the root [README](../README.md).

## Monorepo layout

| Package | Name | Stack | Role |
| --- | --- | --- | --- |
| `apps/web` | `@withvibe/web` | Next.js | Browser UI + API route proxies |
| `apps/api` | `@withvibe/api` | NestJS | Core backend, orchestration, agent runtime |
| `packages/db` | `@withvibe/db` | Prisma / Postgres | Schema + generated client |
| `apps/qa-browser-extension` | `@withvibe/qa-browser-extension` | Chrome MV3 | QA agent drives a real browser |

The `withvibe` CLI (Apache 2.0) installs and runs the stack locally and is
maintained in a separate repository:
[withvibe/withvibe-cli](https://github.com/withvibe/withvibe-cli).

## Request flow

```
Browser ──▶ Next.js (apps/web)
              │  Route Handlers under src/app/api/** call proxyToApi(),
              │  forwarding the session cookie / Bearer token verbatim
              ▼
           NestJS API (apps/api) ──▶ Postgres (via @withvibe/db / Prisma)
              │
              ├─▶ Git: per-env repo clones on disk (REPO_BASE_DIR)
              ├─▶ Containers: per-env runner + the user's compose stack
              └─▶ Claude: Claude Code engine (docker exec into the runner)
                          or the Agent SDK in-process
```

Every new Nest endpoint needs a matching Next.js Route Handler under
`apps/web/src/app/api/...` that proxies to it; run `next typegen` after
adding one so the `RouteContext` types regenerate.

## Core concepts

- **Workspace → Environment → Repos.** A workspace holds team + settings. An
  *environment* is an isolated, code-seeded sandbox; each attached repo is a
  full git clone under `REPO_BASE_DIR/<workspaceId>/clones/<envId>/<repo>`.
- **Chat & agents.** A `ChatSession` may be bound to an `Agent`. Built-in
  agents (DevOps, QA, Security) are seeded per workspace; an unbound session
  runs in orchestrator mode and can delegate to sub-agents. Posting a
  message enqueues a *turn* (`ActiveRunsService`); `ChatStreamService` runs
  it through the Claude Code engine or the Agent SDK and streams events to
  the browser over SSE. Turns are reattachable via the active-run endpoints.
- **Security scan.** A one-click flow that posts a structured kickoff prompt
  into the Security agent's session; the agent reviews changes vs. the base
  branch across all repos and emits phase markers + a machine-readable
  result that the UI renders as a diagnostic.
- **Container orchestration.** Each env gets a runner container plus the
  user's `docker-compose` stack; preview, logs, terminal, and the database
  viewer attach to it. Subdomain routing uses
  `WITHVIBE_ROUTING_BASE_DOMAIN`.

## Local development

See the root [README](../README.md) and [CONTRIBUTING](../CONTRIBUTING.md)
for prerequisites and the quick-start. Per-app notes live in each package's
own `README.md`.

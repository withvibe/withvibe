# WithVibe

**A self-hosted, shared AI environment for R&D teams.**
A teammate spins up an isolated env with one click, vibe-codes with AI,
shares it with the team, and ships once automated agent checks and human
review pass.

🌐 **[withvibe.dev](https://withvibe.dev)** &nbsp;·&nbsp;
📦 **[CLI on npm](https://www.npmjs.com/package/withvibe)** &nbsp;·&nbsp;
📖 **[Docs](https://withvibe.dev/docs)** &nbsp;·&nbsp;
✉️ **[Contact](https://withvibe.dev/contact)**

[![License: ELv2](https://img.shields.io/badge/license-Elastic%202.0-005571.svg)](LICENSE)
[![CLI: Apache 2.0](https://img.shields.io/badge/CLI-Apache%202.0-blue.svg)](https://github.com/withvibe/withvibe-cli)
[![Node](https://img.shields.io/badge/node-%E2%89%A520-brightgreen.svg)](https://nodejs.org)
[![pnpm](https://img.shields.io/badge/pnpm-%E2%89%A59-orange.svg)](https://pnpm.io)
[![Website](https://img.shields.io/badge/website-withvibe.dev-7c3aed.svg)](https://withvibe.dev)


## Try it in 30 seconds

```bash
npm install -g withvibe       # Node 20+, Docker 24+ required
withvibe doctor               # sanity-check your machine
withvibe init -y              # one-click install + start
```

When `init` finishes, it prints the URL — open it, sign in, you're running.
For options and details, see the [CLI README](https://github.com/withvibe/withvibe-cli).

## Flow

```mermaid
flowchart TD
    A([💡 Team member has an idea]) --> B[🖱️ One click — spin up an isolated env]
    B --> C[🤖 Vibe-code with AI]
    C --> D[👥 Share the env with the team]
    D --> E[Teammates join the same AI session & review]
    E --> F{Human approval?}
    F -->|Needs work| C
    F -->|Approved| G[Pre-production agent gate]

    subgraph GATE [🛡️ Automated agent gate]
        direction LR
        H[🔒 Security review]
        I[🔍 Code review]
        J[🧪 Test & quality]
        K[📋 Policy / compliance]
    end

    G --> H & I & J & K
    H & I & J & K --> L{All checks pass?}

    L -->|Flagged| C
    L -->|Clean pass| M([🚀 Deploy to production])

    classDef start fill:#1e90ff,stroke:#0a0a0a,color:#ffffff;
    classDef ship fill:#22c55e,stroke:#0a0a0a,color:#ffffff;
    classDef decision fill:#f59e0b,stroke:#0a0a0a,color:#0a0a0a;
    class A start;
    class M ship;
    class F,L decision;
```


## The idea

- **One click to start.** No infra setup — the team member gets an isolated env seeded with the existing code.
- **Vibecode with AI.** The AI is the primary collaborator inside the env.
- **Share, don't fork.** The env is shared with the team; anyone can jump in and interact with the same AI session.
- **Automated gate before prod.** Once humans approve, specialist agents (security, code review, tests, policy) run as a final gate. Anything flagged loops back to the env.
- **Ship.** Clean pass → merge to main → production.

<!-- WORKSPACE screenshot — one screen: AI chat + live code diff + live preview ("one environment, every tool"). -->
![The WithVibe environment: AI chat, a live code diff and the running app preview in one screen](assets/workspace.png)

## Repository layout

This is the **server-stack monorepo** (pnpm). The CLI that installs and runs
the stack lives in a [separate, Apache-2.0 repo](https://github.com/withvibe/withvibe-cli).

```
.
├── apps/
│   ├── web/        # Next.js 16 frontend + auth + REST proxy (@withvibe/web)
│   ├── api/        # NestJS backend, Docker orchestration, terminal WS (@withvibe/api)
│   └── qa-browser-extension/  # Chrome MV3 ext for the QA agent (@withvibe/qa-browser-extension)
├── packages/
│   └── db/         # Prisma schema + generated client (@withvibe/db)
├── docs/           # architecture and operator notes
├── scripts/        # release + GHCR publishing
└── LICENSE         # Elastic License 2.0
```

## Develop the codebase

> Just want to **run** WithVibe? Use the
> [withvibe CLI](https://github.com/withvibe/withvibe-cli) — see the
> [Try it in 30 seconds](#try-it-in-30-seconds) section above. This section
> is for contributors working on the server stack itself.

### Prerequisites

- **Node.js** ≥ 20
- **pnpm** ≥ 9
- **PostgreSQL** ≥ 14 (local or remote)
- **Docker** + **Docker Compose** (for environment containers)
- **`gh` CLI** (recommended; used by `withvibe env` for repo cloning)

### Local dev setup

```bash
# 1. Install
pnpm install

# 2. Configure environment
cp apps/web/.env.example apps/web/.env
cp apps/api/.env.example apps/api/.env
# Then edit both files — see the env reference below.

# 3. Generate Prisma client and apply schema
pnpm --filter @withvibe/db generate
pnpm --filter @withvibe/db db:push

# 4. (optional) Seed initial data
pnpm --filter @withvibe/db db:seed

# 5. Run web + API in parallel
pnpm dev
```

The web app boots at <http://localhost:3000>, the API at <http://localhost:4000/api>.

### Run individual apps

```bash
pnpm dev:web     # Next.js dev server
pnpm dev:api     # NestJS in watch mode
```

### Build / verify

```bash
pnpm build       # build every workspace package
pnpm typecheck   # tsc --noEmit across the workspace
pnpm lint        # eslint (web app)
```

## Environment variables

The web app is the **frontend only** — it never touches the database. All
DB access, auth, and third-party credentials live in the NestJS API. The web
server forwards the user's session cookie to NestJS over a same-origin path.

### `apps/web/.env`

| Var | Purpose |
| --- | --- |
| `API_BASE_URL` | URL the web server uses to reach NestJS (dev only — same-origin in prod) |

### `apps/api/.env`

| Var | Purpose |
| --- | --- |
| `API_PORT` | Port the NestJS server listens on (default `4000`) |
| `DATABASE_URL` | Postgres connection string |
| `INTERNAL_JWT_SECRET` | Signs user-session JWTs (cookie) and the legacy bridge JWT |
| `REPO_BASE_DIR` | Absolute path on disk where cloned repos live |
| `API_PUBLIC_URL` | Public URL of the API — used to build the Google OAuth callback |
| `WEB_PUBLIC_URL` | Public URL of the web app — where Google OAuth lands after login |
| `ANTHROPIC_API_KEY` | Workspace-level Anthropic fallback when no per-workspace key is set |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | OAuth (leave empty to disable Google login) |
| `COOKIE_SECURE` | `true` to mark the session cookie `Secure` (auto in production) |
| `COOKIE_DOMAIN` | Set when API + Web are on different subdomains |

## Related repositories

| Repo | License | What it is |
| --- | --- | --- |
| **[withvibe/withvibe](https://github.com/withvibe/withvibe)** (this repo) | Elastic 2.0 | The server stack — api, web, db, QA-browser extension |
| **[withvibe/withvibe-cli](https://github.com/withvibe/withvibe-cli)** | Apache 2.0 | The `withvibe` CLI — installs and manages the stack, runs envs locally |
| **[withvibe/withvibe-skills](https://github.com/withvibe/withvibe-skills)** | Apache 2.0 | Claude Code skills — first-time installer guide + plugin scaffolder |
| **[withvibe/withvibe-roadmap](https://github.com/withvibe/withvibe-roadmap)** | Apache 2.0 | Roadmap plugin — a per-env implementation board (Postgres-backed) with an MCP server the AI orchestrator drives |
| **[withvibe/withvibe-voter](https://github.com/withvibe/withvibe-voter)** | Apache 2.0 | Example plugin — turns any env into a team-voted workspace: the AI opens proposals the team votes on before they're built |
| **[withvibe/vibe-aquarium](https://github.com/withvibe/vibe-aquarium)** | Apache 2.0 | Demo app — a minimal 3D aquarium you reshape live by chatting with the running app |

## Links

- 🌐 **Website / product:** <https://withvibe.dev>
- 📖 **Documentation:** <https://withvibe.dev/docs>
- 🏛️ **Architecture overview:** [docs/architecture.md](docs/architecture.md)
- ✉️ **Contact / commercial licensing:** <https://withvibe.dev/contact>

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). For security issues, see
[SECURITY.md](SECURITY.md).

## License

Source code in this repository is licensed under the **Elastic License 2.0**
(ELv2). See [LICENSE](LICENSE) for the full text.

### Plain-language summary

> This summary is **not** a substitute for the [LICENSE](LICENSE) — it's just
> meant to make the common cases easy to understand.

✅ **Free to use, modify, and self-host** — including for **internal use inside
your organization** (running it for your own team, customizing it, fixing
bugs, contributing patches back).

✅ **Free to fork** and build on, as long as you keep the license notices
intact.

❌ **Not free** to offer the software (or a substantial set of its features)
to third parties as a **hosted, managed, or commercial service**.

❌ **Not free** to remove or work around any license-key functionality or
licensor notices.

### Need a different license?

If you want to use WithVibe for purposes ELv2 doesn't permit — offering it as
a SaaS product, embedding it in a commercial offering, or any other
public/commercial distribution beyond internal organizational use — reach out
and we'll work out a **commercial license agreement**:
[withvibe.dev/contact](https://withvibe.dev/contact).

---

Copyright © 2026 WithVibe · [withvibe.dev](https://withvibe.dev)

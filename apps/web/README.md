# @withvibe/web

Next.js 16 frontend for withvibe.

> **Heads-up:** This project pins Next.js 16, which has breaking changes
> compared to earlier versions. Reach for the in-tree docs at
> `node_modules/next/dist/docs/` before assuming patterns from older Next
> tutorials apply.

## Run

```bash
cp .env.example .env
# edit .env

pnpm --filter @withvibe/web dev   # or `pnpm dev:web` from the repo root
```

App boots at <http://localhost:3000>.

## Routes

```
src/app/
├── (auth)            login / register / cli-auth / invite
├── account           account settings
├── workspaces/[id]/
│   ├── environments/ env list + per-env page (chat, terminal, files)
│   ├── settings/     repos, templates, agents, secrets, members
│   └── team/         team page
└── api/              Next route handlers — proxy to the NestJS API
```

The web app does **not** talk to the database directly. All state changes go
through the NestJS API at `${API_BASE_URL}` via a server-signed JWT bridge.

## Auth

NextAuth (credentials + Google OAuth + Prisma adapter). Sessions are issued
per-user and rotated when the user invalidates their CLI tokens.

## Styling

Tailwind v4 + `tw-animate-css`. UI primitives use [`shadcn`](https://ui.shadcn.com)
components (configured in [components.json](components.json)).

## Environment

See the [root README](../../README.md#environment-variables) for the full env
var reference.

## Links

- Website / docs: <https://withvibe.dev>

## License

Elastic License 2.0 — see the [root LICENSE](../../LICENSE).

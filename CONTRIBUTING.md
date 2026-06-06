# Contributing to withvibe

Thanks for considering a contribution! This project is licensed under the
[Elastic License 2.0](LICENSE) — by submitting a contribution you agree your
work is licensed under the same terms.

## Ground rules

- Be excellent to each other. Disrespectful behavior is not tolerated.
- Open an issue before sending a non-trivial PR. It saves everyone time.
- Keep PRs focused — one feature or fix per PR.
- Don't commit secrets, API keys, `.env` files, or local-machine paths.

## Development setup

See [Local dev setup](README.md#local-dev-setup) in the root README.

```bash
pnpm install
pnpm typecheck
pnpm lint
```

## Project structure

| Path | What lives there |
| --- | --- |
| [apps/web](apps/web) | Next.js 16 frontend, session-cookie auth, REST proxy to the API |
| [apps/api](apps/api) | NestJS backend, Docker orchestration, terminal WebSocket |
| [packages/db](packages/db) | Prisma schema + generated client (shared) |

The `withvibe` CLI lives in its own repo:
[withvibe/withvibe-cli](https://github.com/withvibe/withvibe-cli) (Apache 2.0).

## Coding standards

- **TypeScript** everywhere.
- **No `any` without a comment justifying it.**
- **No commented-out code.** Delete it; git remembers.
- **Comments explain *why*, not *what*.** Identifier names should already explain the *what*.
- **Don't add backwards-compatibility shims** unless explicitly needed.
- **No new logic in `useEffect`** — prefer event handlers, derived state, or render-time computation. The codebase has open lint warnings for legacy `react-hooks/set-state-in-effect` patterns; new code should avoid them.

## Commit messages

Follow the existing convention:

```
<type>: <imperative summary>

<body — optional, explains why>
```

`<type>` is one of `feat`, `fix`, `refactor`, `docs`, `chore`, `test`.

## Before opening a PR

1. `pnpm typecheck` passes.
2. `pnpm lint` doesn't introduce new errors.
3. Manual smoke test of the area you changed.
4. PR description explains the *why*.

## Reporting security issues

**Don't open a public issue for security vulnerabilities.** Follow the process
in [SECURITY.md](SECURITY.md).

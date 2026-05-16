# @withvibe/db

Prisma schema and generated client shared between [`apps/web`](../../apps/web)
and [`apps/api`](../../apps/api).

## Layout

```
packages/db/
├── prisma/
│   ├── schema.prisma   # data model
│   └── seed.ts         # initial data
├── src/                # re-exports + helper utilities
└── generated/          # generated Prisma client (gitignored)
```

## Scripts

```bash
pnpm --filter @withvibe/db generate   # prisma generate
pnpm --filter @withvibe/db build      # tsc compile of src/
pnpm --filter @withvibe/db db:push    # apply schema to DATABASE_URL
pnpm --filter @withvibe/db db:seed    # run prisma/seed.ts
pnpm --filter @withvibe/db studio     # open Prisma Studio
```

`generate` runs automatically before `build` (via `prebuild`).

## Environment

Reads `DATABASE_URL` from the environment. The web and API apps share a
single Postgres instance.

## Public exports

| Module | Contents |
| --- | --- |
| `@withvibe/db` | Prisma client + commonly used types |
| `@withvibe/db/profile-constants` | Profile enum/lookup constants |
| `@withvibe/db/user-display` | User display-name helpers |

## Links

- Website / docs: <https://withvibe.dev>

## License

Elastic License 2.0 — see the [root LICENSE](../../LICENSE).

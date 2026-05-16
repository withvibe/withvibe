// Runtime-only Prisma config for the docker image. Read DATABASE_URL from
// the container env (compose injects it). Mirrors packages/db/prisma.config.ts
// but without the dev-only dotenv load from apps/api/.env.
//
// Copied into /app/prisma.config.mjs by apps/api/Dockerfile.

export default {
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
  },
  datasource: {
    url: process.env.DATABASE_URL,
  },
};

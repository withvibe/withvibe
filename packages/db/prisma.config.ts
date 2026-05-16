import { config as loadEnv } from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import { defineConfig } from "prisma/config";

// DATABASE_URL lives in apps/api/.env (single source of truth for the API's
// connection); load it explicitly so `prisma` commands work from any cwd.
const here = path.dirname(fileURLToPath(import.meta.url));
loadEnv({ path: path.resolve(here, "../../apps/api/.env") });

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
    seed: "npx tsx prisma/seed.ts",
  },
  datasource: {
    url: process.env["DATABASE_URL"],
  },
});

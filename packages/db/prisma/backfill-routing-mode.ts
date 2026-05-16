import pg from "pg";
import { config as loadEnv } from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

// One-shot migration + backfill for routing mode moving from Workspace to
// EnvTemplate / Env. Runs as a single transaction:
//   1. Add routingMode/routingBaseDomain columns to EnvTemplate and Env
//      (default 'port', NULL base domain).
//   2. Copy each workspace's routing values down to its templates and envs.
//   3. Drop the old columns from Workspace.
//
// Run once BEFORE `pnpm --filter @withvibe/db db:push`:
//   pnpm --filter @withvibe/db exec tsx prisma/backfill-routing-mode.ts
//
// After this runs, db:push should report no schema diff.
// Idempotent: safe to re-run.

// Pick up DATABASE_URL the same way the rest of the repo does — apps/api/.env
// is the source of truth for the API's DB connection.
const here = path.dirname(fileURLToPath(import.meta.url));
loadEnv({ path: path.resolve(here, "../../../apps/api/.env") });

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      "DATABASE_URL is not set (looked in apps/api/.env and process env)"
    );
  }
  const pool = new pg.Pool({ connectionString: url });
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const enumExists = await client.query(
      `SELECT 1 FROM pg_type WHERE typname = 'RoutingMode'`
    );
    if (enumExists.rowCount === 0) {
      await client.query(`CREATE TYPE "RoutingMode" AS ENUM ('port', 'subdomain')`);
    }

    await client.query(
      `ALTER TABLE "EnvTemplate"
         ADD COLUMN IF NOT EXISTS "routingMode" "RoutingMode" NOT NULL DEFAULT 'port',
         ADD COLUMN IF NOT EXISTS "routingBaseDomain" TEXT`
    );
    await client.query(
      `ALTER TABLE "Env"
         ADD COLUMN IF NOT EXISTS "routingMode" "RoutingMode" NOT NULL DEFAULT 'port',
         ADD COLUMN IF NOT EXISTS "routingBaseDomain" TEXT`
    );

    const wsCols = await client.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
       WHERE table_name = 'Workspace' AND column_name IN ('routingMode', 'routingBaseDomain')`
    );

    if (wsCols.rowCount === 2) {
      const tplRes = await client.query(
        `UPDATE "EnvTemplate" t SET
           "routingMode"       = w."routingMode",
           "routingBaseDomain" = w."routingBaseDomain"
         FROM "Workspace" w WHERE t."workspaceId" = w.id`
      );
      const envRes = await client.query(
        `UPDATE "Env" e SET
           "routingMode"       = w."routingMode",
           "routingBaseDomain" = w."routingBaseDomain"
         FROM "Workspace" w WHERE e."workspaceId" = w.id`
      );
      console.log(
        `Backfilled ${tplRes.rowCount} EnvTemplate rows and ${envRes.rowCount} Env rows.`
      );

      await client.query(
        `ALTER TABLE "Workspace"
           DROP COLUMN "routingMode",
           DROP COLUMN "routingBaseDomain"`
      );
      console.log("Dropped Workspace.routingMode and Workspace.routingBaseDomain.");
    } else {
      console.log("Workspace columns already removed — backfill skipped.");
    }

    await client.query("COMMIT");
    console.log("Done. `pnpm db:push` should now report no diff.");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

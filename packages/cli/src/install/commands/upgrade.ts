import path from "node:path";
import { promises as fs } from "node:fs";
import ora from "ora";
import prompts from "prompts";
import { run } from "../../exec.js";
import { compose, readPublicUrls, waitForUrl } from "../compose.js";
import { composePath, envPath } from "../paths.js";
import {
  buildAllImages,
  pullAllImages,
  readBuildArgContext,
} from "../build-images.js";
import { log } from "../log.js";
import { DEFAULT_INSTALL_DIR, expandHome } from "../paths.js";
import { readState } from "../state.js";

export type UpgradeArgs = {
  installDir?: string;
  // Override the install mode just for this upgrade (e.g. switch from
  // from-source to from-registry on a specific deploy).
  mode?: "from-source" | "from-bundle" | "from-registry";
  bundlePath?: string;
  repoPath?: string;
  registryNamespace?: string;
  registryTag?: string;
  // Skip the postgres dump (faster, but no rollback safety net).
  skipBackup?: boolean;
  yes?: boolean;
};

export async function runUpgrade(args: UpgradeArgs): Promise<void> {
  const installDir = args.installDir
    ? path.resolve(expandHome(args.installDir))
    : DEFAULT_INSTALL_DIR;
  const state = await readState(installDir);
  if (!state) {
    log.fail(`No install at ${installDir}.`);
    process.exit(1);
  }

  const mode = args.mode ?? state.mode;

  // 1. Snapshot postgres before touching anything. A failed upgrade with no
  //    snapshot is the most painful thing a user can hit.
  const backupPath = await maybeBackup(installDir, args.skipBackup === true);

  // 2. Bring in fresh images.
  log.header("Refreshing images");
  try {
    if (mode === "from-source") {
      const repoPath =
        args.repoPath ?? state.source?.repoPath;
      if (!repoPath) {
        log.fail("from-source upgrade needs --repo-path or a saved source path.");
        process.exit(1);
      }
      const buildArgContext = await readBuildArgContext(installDir);
      await buildAllImages({
        repoPath,
        features: state.features,
        buildArgContext,
      });
    } else if (mode === "from-bundle") {
      const bundlePath = args.bundlePath ?? state.bundle?.bundlePath;
      if (!bundlePath) {
        log.fail("from-bundle upgrade needs --bundle-path.");
        process.exit(1);
      }
      // Re-load the new bundle's images.tar.
      const tar = bundlePath.endsWith(".tar")
        ? bundlePath
        : path.join(bundlePath, "images.tar");
      const r = await run("docker", ["load", "-i", tar], { streamTo: "inherit" });
      if (r.code !== 0) throw new Error(`docker load exited ${r.code}`);
    } else {
      const namespace = args.registryNamespace ?? state.registry?.namespace;
      const tag = args.registryTag ?? state.registry?.tag;
      if (!namespace || !tag) {
        log.fail("from-registry upgrade needs --registry-namespace and --registry-tag (or saved state).");
        process.exit(1);
      }
      await pullAllImages({ namespace, tag, features: state.features });
    }
  } catch (e) {
    log.fail(`Image refresh failed: ${(e as Error).message}`);
    if (backupPath) log.dim(`Postgres dump preserved at ${backupPath}`);
    process.exit(1);
  }

  // 3. Restart with new images.
  log.header("Restarting services");
  const up = await compose(installDir, ["up", "-d"]);
  if (up.code !== 0) {
    log.fail("compose up failed during upgrade.");
    if (backupPath) await offerRollback(installDir, backupPath);
    process.exit(up.code);
  }

  // 4. Health gate. If health doesn't come back, offer rollback.
  const urls = await readPublicUrls(installDir);
  const healthOk = await healthCheck(urls);
  if (!healthOk) {
    log.fail("Health checks failed after upgrade.");
    if (backupPath) await offerRollback(installDir, backupPath);
    process.exit(1);
  }

  log.ok("Upgrade complete.");
  if (backupPath) log.dim(`Backup retained: ${backupPath}`);
}

async function maybeBackup(
  installDir: string,
  skip: boolean
): Promise<string | null> {
  if (skip) {
    log.warn("Skipping postgres backup (--skip-backup). No rollback safety net.");
    return null;
  }
  const backupsDir = path.join(installDir, "backups");
  await fs.mkdir(backupsDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const file = path.join(backupsDir, `postgres-${stamp}.sql`);

  const spinner = ora(`Snapshotting postgres → ${file}`).start();
  // pg_dump runs INSIDE the postgres container so we don't need the client
  // installed on the host. Pull POSTGRES_USER/DB from the env file via the
  // compose service environment — easiest by exec'ing the container.
  //
  // --clean --if-exists: emit `DROP ... IF EXISTS` before each `CREATE` so the
  //   dump restores idempotently OVER an existing database. Without these, a
  //   rollback (offerRollback pipes this into psql while the schema/data are
  //   still present) prints a flood of cosmetic `ERROR: relation "…" already
  //   exists` lines that look alarming but are harmless — confusing users.
  // --no-owner --no-privileges: skip ALTER OWNER / GRANT lines that otherwise
  //   error with `role "…" does not exist` when restored into a fresh volume.
  const dump = await compose(
    installDir,
    [
      "exec",
      "-T",
      "postgres",
      "sh",
      "-c",
      'pg_dump --clean --if-exists --no-owner --no-privileges -U "$POSTGRES_USER" "$POSTGRES_DB"',
    ],
    { stream: false }
  );
  if (dump.code !== 0) {
    spinner.fail(
      `pg_dump failed (exit ${dump.code}). The stack may not be running yet — bringing it up first is fine.`
    );
    return null;
  }
  await fs.writeFile(file, dump.stdout);
  spinner.succeed(`Postgres dump saved (${formatBytes(dump.stdout.length)})`);
  return file;
}

async function healthCheck(urls: { web?: string; api?: string }): Promise<boolean> {
  let ok = true;
  if (urls.api) {
    const r = await waitForUrl(`${urls.api.replace(/\/+$/, "")}/api/health`, 60_000);
    if (!r.ok) ok = false;
  }
  if (urls.web) {
    const r = await waitForUrl(urls.web, 60_000);
    if (!r.ok) ok = false;
  }
  return ok;
}

async function offerRollback(
  installDir: string,
  backupPath: string
): Promise<void> {
  const ans = await prompts(
    {
      type: "confirm",
      name: "v",
      message: `Restore postgres from ${backupPath}? (re-runs the dump)`,
      initial: true,
    },
    { onCancel: () => process.exit(2) }
  );
  if (!ans.v) {
    log.warn("Skipping restore. Backup remains on disk.");
    return;
  }
  // Pipe the dump file into psql inside the container. We have to shell out
  // to `sh -c '... | docker compose exec -T ...'` because Node's run() helper
  // doesn't support piping a file into stdin of a child process.
  const compFile = composePath(installDir);
  const compEnv = envPath(installDir);
  const cmd =
    `cat ${JSON.stringify(backupPath)} | ` +
    `docker compose -f ${JSON.stringify(compFile)} --env-file ${JSON.stringify(compEnv)} ` +
    `exec -T postgres sh -c 'psql -U "$POSTGRES_USER" "$POSTGRES_DB"'`;
  const restore = await run("sh", ["-c", cmd], { streamTo: "inherit" });
  if (restore.code !== 0) {
    log.fail("Automatic restore failed. Restore manually using the dump file.");
    return;
  }
  log.ok("Postgres restored.");
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

import path from "node:path";
import { promises as fs } from "node:fs";
import prompts from "prompts";
import { compose } from "../compose.js";
import { run } from "../../exec.js";
import { log } from "../log.js";
import { DEFAULT_INSTALL_DIR, expandHome } from "../paths.js";
import { imagesForFeatures, EXTERNAL_IMAGES } from "../images.js";
import { readState } from "../state.js";

export type UninstallArgs = {
  installDir?: string;
  // Keep the postgres volume even when uninstalling. Default: false.
  keepData?: boolean;
  // Also remove the local images we built/pulled.
  removeImages?: boolean;
  // Skip confirmation prompts (CI/scripted use). Combined with --keep-data
  // this is the only safe non-interactive uninstall.
  yes?: boolean;
};

export async function runUninstall(args: UninstallArgs): Promise<void> {
  const installDir = args.installDir
    ? path.resolve(expandHome(args.installDir))
    : DEFAULT_INSTALL_DIR;
  const state = await readState(installDir);
  if (!state) {
    log.fail(`No install at ${installDir}.`);
    process.exit(1);
  }

  log.header("withvibe — uninstall");
  log.info(`Install dir: ${installDir}`);
  log.info(`Data:        ${args.keepData ? "PRESERVED (volume kept)" : "WILL BE DELETED"}`);
  log.info(`Images:      ${args.removeImages ? "WILL BE REMOVED" : "kept"}`);

  if (!args.yes) {
    if (!args.keepData) {
      // Two-step gate for destructive deletes.
      const c1 = await prompts(
        {
          type: "confirm",
          name: "v",
          message: "This will DELETE the postgres volume (every workspace, env, message). Continue?",
          initial: false,
        },
        { onCancel: () => process.exit(0) }
      );
      if (!c1.v) {
        log.info("Cancelled.");
        return;
      }
      const phrase = await prompts(
        {
          type: "text",
          name: "v",
          message: 'Type "delete" to confirm:',
        },
        { onCancel: () => process.exit(0) }
      );
      if (phrase.v !== "delete") {
        log.info("Cancelled.");
        return;
      }
    } else {
      const c = await prompts(
        {
          type: "confirm",
          name: "v",
          message: "Stop the stack and remove containers (data preserved)?",
          initial: true,
        },
        { onCancel: () => process.exit(0) }
      );
      if (!c.v) return;
    }
  }

  // 1. Tear down compose. -v = also remove named volumes (only when not keeping data).
  const downArgs = ["down"];
  if (!args.keepData) downArgs.push("-v");
  log.step(`docker compose ${downArgs.join(" ")}`);
  await compose(installDir, downArgs);

  // 2. Remove images.
  if (args.removeImages) {
    const all = imagesForFeatures(state.features).map((i) => i.localName);
    all.push(EXTERNAL_IMAGES.postgres);
    if (state.features.traefik) all.push(EXTERNAL_IMAGES.traefik);
    for (const name of all) {
      log.step(`docker image rm ${name}`);
      await run("docker", ["image", "rm", "-f", name]);
    }
  }

  // 3. Remove install dir state. Preserve backups/ subdir if present.
  const backupsDir = path.join(installDir, "backups");
  const hasBackups = await fs.stat(backupsDir).catch(() => null);
  if (hasBackups?.isDirectory()) {
    log.warn(`Preserving ${backupsDir}.`);
    // Move backups out so we can blow away install dir cleanly. Place under
    // sibling of installDir.
    const sibling = path.join(
      path.dirname(installDir),
      `withvibe-backups-${Date.now()}`
    );
    await fs.rename(backupsDir, sibling);
    log.info(`Backups moved to ${sibling}`);
  }

  await fs.rm(installDir, { recursive: true, force: true });
  log.ok("Uninstall complete.");
}

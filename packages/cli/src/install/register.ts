// Wires every installer subcommand onto a parent commander program.
// The host CLI (packages/cli) calls this with a `Command` named "install"
// so users invoke them as `withvibe install <subcmd>`. Keeping the wiring
// here means the subcommand names + descriptions stay co-located with the
// rest of the installer code.

import type { Command } from "commander";
import { runDoctor, printReport } from "./doctor.js";
import { runInit } from "./init.js";
import { runBuildImages } from "./commands/build-images-cmd.js";
import {
  runStart,
  runStop,
  runRestart,
  runStatus,
  runLogs,
} from "./commands/lifecycle.js";
import { runConfigure } from "./commands/configure.js";
import { runUpgrade } from "./commands/upgrade.js";
import { runUninstall } from "./commands/uninstall.js";
import { log } from "./log.js";
import type { InstallMode } from "./state.js";

export function registerInstallCommands(program: Command): void {
  program
    .command("doctor")
    .description("Run host preflight checks (read-only)")
    .action(async () => {
      const report = await runDoctor();
      printReport(report);
      if (!report.ok) {
        log.fail("\nSome checks failed. Fix the items above before running `init`.");
        process.exit(1);
      }
      log.ok("\nAll checks passed.");
    });

  program
    .command("init")
    .description(
      "Guided first-time install: collect secrets, write config, prepare images"
    )
    .option(
      "-m, --mode <mode>",
      "Install mode: from-source | from-bundle | from-registry"
    )
    .option(
      "-d, --install-dir <path>",
      "Where .env, docker-compose.yml, and state live"
    )
    .option(
      "--bundle-path <path>",
      "Bundle path for from-bundle mode (skips the prompt and allows Default preset)"
    )
    .option(
      "--skip-key-check",
      "Don't validate the Anthropic key against the live API",
      false
    )
    .option(
      "-y, --yes",
      "Pick the Default preset and skip every prompt (one-click install)",
      false
    )
    .option(
      "-f, --force",
      "Re-init even if an install already exists (DESTROYS its database)",
      false
    )
    .option("--no-build", "Don't run `build-images` after writing config")
    .option("--no-start", "Don't run `start` after building")
    .action(
      async (opts: {
        mode?: string;
        installDir?: string;
        bundlePath?: string;
        skipKeyCheck: boolean;
        yes: boolean;
        force: boolean;
        // commander's --no-X flags expose the field with the positive name.
        // Default true; --no-build / --no-start sets it false.
        build: boolean;
        start: boolean;
      }) => {
        const mode = opts.mode as InstallMode | undefined;
        if (mode && !["from-source", "from-bundle", "from-registry"].includes(mode)) {
          log.fail(`Unknown mode: ${mode}`);
          process.exit(1);
        }
        await runInit({
          mode,
          installDir: opts.installDir,
          bundlePath: opts.bundlePath,
          skipKeyCheck: opts.skipKeyCheck,
          yes: opts.yes,
          force: opts.force,
          noBuild: !opts.build,
          noStart: !opts.start,
        });
      }
    );

  program
    .command("build-images")
    .description("Build / load / pull the images this install needs")
    .option("-d, --install-dir <path>", "Install directory")
    .option("--repo-path <path>", "Source tree (overrides state, for from-source)")
    .option("--bundle-path <path>", "Bundle path (overrides state, for from-bundle)")
    .action(
      async (opts: {
        installDir?: string;
        repoPath?: string;
        bundlePath?: string;
      }) => {
        await runBuildImages({
          installDir: opts.installDir,
          repoPath: opts.repoPath,
          bundlePath: opts.bundlePath,
        });
      }
    );

  program
    .command("configure")
    .description("Edit/add/remove features (Traefik, QA browser, OAuth, secrets…)")
    .option("-d, --install-dir <path>", "Install directory")
    .action(async (opts: { installDir?: string }) => {
      await runConfigure({ installDir: opts.installDir });
    });

  program
    .command("start")
    .description("docker compose up -d, with health gating")
    .option("-d, --install-dir <path>", "Install directory")
    .action(async (opts: { installDir?: string }) => {
      await runStart({ installDir: opts.installDir });
    });

  program
    .command("stop")
    .description("docker compose down (data preserved)")
    .option("-d, --install-dir <path>", "Install directory")
    .action(async (opts: { installDir?: string }) => {
      await runStop({ installDir: opts.installDir });
    });

  program
    .command("restart")
    .description("docker compose restart")
    .option("-d, --install-dir <path>", "Install directory")
    .action(async (opts: { installDir?: string }) => {
      await runRestart({ installDir: opts.installDir });
    });

  program
    .command("status")
    .description("Service state + sidecar image presence + URLs")
    .option("-d, --install-dir <path>", "Install directory")
    .action(async (opts: { installDir?: string }) => {
      await runStatus({ installDir: opts.installDir });
    });

  program
    .command("logs [service]")
    .description(
      "Tail logs (optionally for a single service: postgres, api, web, traefik)"
    )
    .option("-d, --install-dir <path>", "Install directory")
    .option("-f, --follow", "Follow logs", true)
    .action(
      async (
        service: string | undefined,
        opts: { installDir?: string; follow: boolean }
      ) => {
        await runLogs({
          installDir: opts.installDir,
          service,
          follow: opts.follow,
        });
      }
    );

  program
    .command("upgrade")
    .description(
      "Snapshot postgres, refresh images, restart, rollback on health failure"
    )
    .option("-d, --install-dir <path>", "Install directory")
    .option("-m, --mode <mode>", "Override mode for this upgrade")
    .option("--bundle-path <path>", "New bundle path (for from-bundle)")
    .option("--repo-path <path>", "Source tree (for from-source)")
    .option(
      "--registry-namespace <ns>",
      "Override registry namespace (for from-registry)"
    )
    .option("--registry-tag <tag>", "Override registry tag (for from-registry)")
    .option("--skip-backup", "Skip the postgres dump (no rollback safety net)", false)
    .action(
      async (opts: {
        installDir?: string;
        mode?: string;
        bundlePath?: string;
        repoPath?: string;
        registryNamespace?: string;
        registryTag?: string;
        skipBackup: boolean;
      }) => {
        const mode = opts.mode as InstallMode | undefined;
        if (mode && !["from-source", "from-bundle", "from-registry"].includes(mode)) {
          log.fail(`Unknown mode: ${mode}`);
          process.exit(1);
        }
        await runUpgrade({
          installDir: opts.installDir,
          mode,
          bundlePath: opts.bundlePath,
          repoPath: opts.repoPath,
          registryNamespace: opts.registryNamespace,
          registryTag: opts.registryTag,
          skipBackup: opts.skipBackup,
        });
      }
    );

  program
    .command("uninstall")
    .description("Remove the stack (with data-loss confirmation)")
    .option("-d, --install-dir <path>", "Install directory")
    .option("--keep-data", "Keep the postgres volume", false)
    .option("--remove-images", "Also remove local images", false)
    .option("-y, --yes", "Skip confirmation prompts", false)
    .action(
      async (opts: {
        installDir?: string;
        keepData: boolean;
        removeImages: boolean;
        yes: boolean;
      }) => {
        await runUninstall({
          installDir: opts.installDir,
          keepData: opts.keepData,
          removeImages: opts.removeImages,
          yes: opts.yes,
        });
      }
    );
}

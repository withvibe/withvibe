import { promises as fs } from "node:fs";
import chalk from "chalk";
import prompts from "prompts";
import { run, which } from "./exec.js";

// On macOS the `code` shell command is NOT installed by default — the user
// has to run "Shell Command: Install 'code' command in PATH" from VSCode's
// command palette. So PATH absence ≠ VSCode absence. Same story for Cursor.
// We check the standard app bundle locations before triggering an install.
const MAC_EDITOR_APPS = [
  "/Applications/Visual Studio Code.app",
  "/Applications/Cursor.app",
  "/Applications/VSCodium.app",
];

async function macEditorAppExists(): Promise<string | null> {
  if (process.platform !== "darwin") return null;
  for (const p of MAC_EDITOR_APPS) {
    try {
      await fs.access(p);
      return p;
    } catch {
      // keep looking
    }
  }
  return null;
}

// Tools the CLI absolutely requires before it can do anything useful.
// Docker + git are non-negotiable; `code` (VSCode) is strongly preferred
// because it's the whole point of this flow, but we allow skipping it.
type ToolSpec = {
  cmd: string;
  label: string;
  optional?: boolean;
  installers: Partial<Record<NodeJS.Platform, { cmd: string; args: string[]; note?: string }[]>>;
  manualUrl: string;
};

const TOOLS: ToolSpec[] = [
  {
    cmd: "git",
    label: "Git",
    installers: {
      darwin: [{ cmd: "brew", args: ["install", "git"] }],
      linux: [
        { cmd: "apt-get", args: ["install", "-y", "git"], note: "requires sudo" },
        { cmd: "dnf", args: ["install", "-y", "git"], note: "requires sudo" },
      ],
      win32: [{ cmd: "winget", args: ["install", "--id", "Git.Git", "-e"] }],
    },
    manualUrl: "https://git-scm.com/downloads",
  },
  {
    cmd: "docker",
    label: "Docker",
    installers: {
      darwin: [{ cmd: "brew", args: ["install", "--cask", "docker"] }],
      linux: [
        {
          cmd: "sh",
          args: ["-c", "curl -fsSL https://get.docker.com | sh"],
          note: "requires sudo and adds your user to the docker group",
        },
      ],
      win32: [{ cmd: "winget", args: ["install", "--id", "Docker.DockerDesktop", "-e"] }],
    },
    manualUrl: "https://docs.docker.com/get-docker/",
  },
  {
    cmd: "code",
    label: "VSCode",
    optional: true,
    installers: {
      darwin: [{ cmd: "brew", args: ["install", "--cask", "visual-studio-code"] }],
      linux: [
        {
          cmd: "sh",
          args: ["-c", "echo 'See manual install link'; exit 1"],
          note: "apt/yum repos vary — use the manual link",
        },
      ],
      win32: [
        { cmd: "winget", args: ["install", "--id", "Microsoft.VisualStudioCode", "-e"] },
      ],
    },
    manualUrl: "https://code.visualstudio.com/download",
  },
];

export async function runPreflight({
  autoInstall,
}: { autoInstall: boolean }): Promise<{ haveCode: boolean; macAppPath: string | null }> {
  let haveCode = true;
  let macAppPath: string | null = null;
  for (const tool of TOOLS) {
    const ok = await which(tool.cmd);
    if (ok) {
      console.log(chalk.green("✓"), `${tool.label} found`);
      continue;
    }

    // VSCode special case: before offering to install, check if the app
    // bundle is already there and the user just hasn't installed the
    // `code` shell command.
    if (tool.cmd === "code") {
      const appPath = await macEditorAppExists();
      if (appPath) {
        macAppPath = appPath;
        console.log(
          chalk.green("✓"),
          `${tool.label} app installed at ${appPath}`
        );
        console.log(
          chalk.dim(
            "  (The `code` shell command isn't on PATH. We'll launch via `open -a` instead. To enable `code`: open VSCode → Command Palette → \"Shell Command: Install 'code' command in PATH\".)"
          )
        );
        // We have a way to launch the editor, so haveCode stays true.
        continue;
      }
    }

    console.log(chalk.yellow("!"), `${tool.label} not found on PATH`);
    const installed = await offerInstall(tool, autoInstall);
    if (!installed && tool.optional && tool.cmd === "code") {
      haveCode = false;
      continue;
    }
    if (!installed) {
      console.error(
        chalk.red(
          `\n${tool.label} is required. Install it and re-run the command.`
        )
      );
      console.error(`  Manual install: ${tool.manualUrl}`);
      process.exit(1);
    }
  }
  return { haveCode, macAppPath };
}

async function offerInstall(
  tool: ToolSpec,
  autoInstall: boolean
): Promise<boolean> {
  const platform = process.platform;
  const candidates = tool.installers[platform] || [];

  // Pick the first candidate whose command is actually available on the
  // system. On Linux this is how we choose between apt-get and dnf.
  let chosen: (typeof candidates)[number] | null = null;
  for (const c of candidates) {
    if (c.cmd === "sh" || (await which(c.cmd))) {
      chosen = c;
      break;
    }
  }
  if (!chosen) {
    console.log(
      `  No automatic installer available on ${platform}. Install manually: ${tool.manualUrl}`
    );
    return false;
  }

  const noteSuffix = chosen.note ? ` (${chosen.note})` : "";
  const confirmInstall = autoInstall
    ? { install: true }
    : await prompts({
        type: "confirm",
        name: "install",
        message: `Install ${tool.label} via \`${chosen.cmd} ${chosen.args.join(" ")}\`${noteSuffix}?`,
        initial: true,
      });
  if (!confirmInstall.install) return false;

  const result = await run(chosen.cmd, chosen.args, { streamTo: "inherit" });
  if (result.code !== 0) {
    console.error(chalk.red(`Install command exited with code ${result.code}`));
    return false;
  }
  // Re-check PATH — some installers need a shell reload but the binary is
  // usually on PATH for the next spawn already.
  return await which(tool.cmd);
}

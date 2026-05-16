import chalk from "chalk";
import prompts from "prompts";
import { run, which } from "./exec.js";

// Extract the active GitHub username from `gh auth status` output. The
// command prints a human-readable block; the line we care about looks like:
//   ✓ Logged in to github.com account <username> (keyring)
// or
//   - Active account: true
//     Logged in to github.com as <username> (keyring)
// We'll match the first "Logged in ... as|account <name>" we see.
function parseGhAuthStatus(text: string): string | null {
  const line = text.match(
    /Logged in to [^\s]+ (?:as|account) ([A-Za-z0-9][A-Za-z0-9-]*)/
  );
  return line ? line[1] : null;
}

/**
 * If `gh` is installed, show the user which GitHub account git will use and
 * offer to switch. This runs BEFORE any `git clone` so a wrong-account
 * mistake surfaces once rather than per-repo.
 *
 * No-op (with a friendly note) when `gh` isn't installed — the user's native
 * git credential helper will handle auth and we can't do much.
 */
export async function confirmGitHubAccount(): Promise<void> {
  if (!(await which("gh"))) {
    console.log(
      chalk.dim(
        "  (gh CLI not installed — `git clone` will use whichever credentials git finds. If a clone says \"Repository not found\", install gh and run `gh auth login`.)"
      )
    );
    return;
  }

  const status = await run("gh", ["auth", "status"]);
  // gh writes both success and failure to stderr (annoyingly).
  const combined = `${status.stdout}\n${status.stderr}`;
  const activeUser = parseGhAuthStatus(combined);

  if (!activeUser) {
    console.log(
      chalk.yellow("  gh is installed but not logged in.")
    );
    const go = await prompts({
      type: "confirm",
      name: "go",
      message: "Run `gh auth login` now?",
      initial: true,
    });
    if (go.go) {
      await run("gh", ["auth", "login"], { streamTo: "inherit" });
    }
    return;
  }

  console.log(`  GitHub account in use: ${chalk.bold(activeUser)}`);
  const choice = await prompts({
    type: "select",
    name: "v",
    message: "Continue with this account?",
    choices: [
      { title: `Yes, continue as ${activeUser}`, value: "keep" },
      { title: "Switch account (gh auth switch)", value: "switch" },
      { title: "Log in with a different account (gh auth login)", value: "login" },
    ],
    initial: 0,
  });

  if (choice.v === "switch") {
    await run("gh", ["auth", "switch"], { streamTo: "inherit" });
  } else if (choice.v === "login") {
    await run("gh", ["auth", "login"], { streamTo: "inherit" });
  }
}

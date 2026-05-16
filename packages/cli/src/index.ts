#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { Command } from "commander";
import { registerInstallCommands } from "./install/register.js";
import { loginCommand } from "./login.js";
import { envCommand } from "./env-command.js";

const DEFAULT_SERVER =
  process.env.WITHVIBE_SERVER || "http://localhost:3000";

const pkgPath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "package.json"
);
const pkgVersion =
  (JSON.parse(readFileSync(pkgPath, "utf-8")) as { version: string }).version;

const program = new Command();
program
  .name("withvibe")
  .description(
    "withvibe — install/manage the server stack and run shared environments locally."
  )
  .version(pkgVersion, "-v, --version", "output the version")
  .option(
    "-s, --server <url>",
    "Withvibe web server URL (env: WITHVIBE_SERVER)",
    DEFAULT_SERVER
  )
  // On any parse error (e.g. `-s` with no value), print usage instead of a
  // bare one-line error, and suggest the closest command on a typo.
  .showHelpAfterError("(run `withvibe --help` for usage)")
  .showSuggestionAfterError();

program
  .command("login")
  .description("Authorize this machine against a withvibe server")
  .option("-f, --force", "Force re-auth even if already logged in", false)
  .action(async (opts: { force: boolean }) => {
    const { server } = program.opts<{ server: string }>();
    await loginCommand({ server, force: opts.force });
  });

program
  .command("env <envId>")
  .description("Set up the given env on this machine and open it in VSCode")
  .option("--no-open", "Don't launch VSCode at the end")
  .option(
    "-f, --force",
    "Skip the uncommitted/unpushed work warning prompt",
    false
  )
  .action(async (envId: string, opts: { open: boolean; force: boolean }) => {
    await envCommand(envId, { open: opts.open, force: opts.force });
  });

// Server-side install/manage commands — flattened onto the root program so
// users invoke them as `withvibe init`, `withvibe start`, etc. No name
// collisions with the existing `login` / `env` commands.
registerInstallCommands(program);

// Bare `withvibe` (no command) → show help instead of doing nothing.
if (process.argv.slice(2).length === 0) {
  program.help();
}

program.parseAsync().catch((err) => {
  console.error(err);
  process.exit(1);
});

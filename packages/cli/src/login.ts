import os from "node:os";
import chalk from "chalk";
import open from "open";
import ora from "ora";
import { initiateLogin, pollLogin } from "./api.js";
import { loadConfig, saveConfig, type CliConfig } from "./config.js";

const POLL_INTERVAL_MS = 2000;

export async function loginCommand(opts: {
  server: string;
  force: boolean;
}): Promise<CliConfig> {
  if (!opts.force) {
    const existing = await loadConfig();
    if (existing && existing.server === opts.server) {
      console.log(
        chalk.green("✓"),
        `Already logged in to ${opts.server}. Pass --force to re-auth.`
      );
      return existing;
    }
  }

  const label = `${os.hostname() || "device"} (${os.userInfo().username})`;
  const init = await initiateLogin(opts.server, label);
  const authUrl = `${opts.server.replace(/\/$/, "")}/cli-auth/${encodeURIComponent(init.code)}`;

  console.log();
  console.log(
    chalk.bold("Opening browser to authorize this device:"),
    authUrl
  );
  console.log(
    chalk.dim(
      "If the browser doesn't open, copy the URL above and paste it into a browser signed in as you."
    )
  );
  console.log();

  open(authUrl).catch(() => {
    // open() can fail silently on some linux desktops without throwing —
    // the user will see the URL printed above either way.
  });

  const spinner = ora("Waiting for approval…").start();

  const deadline = new Date(init.expiresAt).getTime();
  let token: string | null = null;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    const poll = await pollLogin(opts.server, init.code);
    if (poll.status === "confirmed") {
      token = poll.token;
      break;
    }
    if (poll.status === "expired") {
      spinner.fail("Login code expired. Re-run `withvibe login`.");
      process.exit(1);
    }
  }

  if (!token) {
    spinner.fail("Timed out waiting for approval.");
    process.exit(1);
  }

  spinner.succeed("Device approved");

  const cfg: CliConfig = {
    server: opts.server,
    token,
    savedAt: new Date().toISOString(),
  };
  await saveConfig(cfg);
  console.log(chalk.green("✓"), "Saved to ~/.withvibe/config.json");
  return cfg;
}

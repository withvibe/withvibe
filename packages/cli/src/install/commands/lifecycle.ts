import path from "node:path";
import ora from "ora";
import { compose, composePs, readPublicUrls, waitForUrl } from "../compose.js";
import { imagePresence } from "../build-images.js";
import { log } from "../log.js";
import { DEFAULT_INSTALL_DIR, expandHome } from "../paths.js";
import { readState } from "../state.js";

export type LifecycleArgs = { installDir?: string };

function resolveInstallDir(args: LifecycleArgs): string {
  return args.installDir
    ? path.resolve(expandHome(args.installDir))
    : DEFAULT_INSTALL_DIR;
}

export async function runStart(args: LifecycleArgs): Promise<void> {
  const installDir = resolveInstallDir(args);
  const state = await readState(installDir);
  if (!state) {
    log.fail(`No install state at ${installDir}. Run \`withvibe init\` first.`);
    process.exit(1);
  }

  // Pre-check: warn if any expected images are missing. Don't block — `compose
  // up` will fail with its own error, but the operator should know to run
  // `build-images` first if they skipped that step.
  const presence = await imagePresence(state.features, state.bundle?.version);
  const missing = presence.filter((p) => !p.present);
  if (missing.length > 0) {
    log.warn(
      `Missing images (compose may fail): ${missing.map((m) => m.image).join(", ")}`
    );
    log.dim(`  Run \`withvibe build-images\` first.`);
  }

  log.header("Starting stack");
  const up = await compose(installDir, ["up", "-d"]);
  if (up.code !== 0) {
    log.fail(`compose up failed (exit ${up.code})`);
    process.exit(up.code);
  }

  // Health gate: poll the web app first (its readiness implies the api is
  // reachable inside the network), then the api directly.
  const urls = await readPublicUrls(installDir);
  if (urls.api) {
    await waitFor("api", `${urls.api.replace(/\/+$/, "")}/api/health`);
  }
  if (urls.web) {
    await waitFor("web", urls.web);
  }

  log.ok("Stack started.");
  if (urls.web) log.info(`  Web: ${urls.web}`);
  if (urls.api) log.info(`  API: ${urls.api}`);
}

async function waitFor(label: string, url: string): Promise<void> {
  const spinner = ora(`Waiting for ${label} (${url})…`).start();
  const r = await waitForUrl(url);
  if (r.ok) spinner.succeed(`${label} reachable (HTTP ${r.lastStatus})`);
  else
    spinner.fail(
      `${label} did not become reachable: ${r.lastError ?? `HTTP ${r.lastStatus}`}`
    );
}

export async function runStop(args: LifecycleArgs): Promise<void> {
  const installDir = resolveInstallDir(args);
  log.header("Stopping stack");
  const res = await compose(installDir, ["down"]);
  if (res.code !== 0) {
    log.fail(`compose down failed (exit ${res.code})`);
    process.exit(res.code);
  }
  log.ok("Stack stopped.");
}

export async function runRestart(args: LifecycleArgs): Promise<void> {
  const installDir = resolveInstallDir(args);
  log.header("Restarting stack");
  // Use `up -d` rather than `restart` so containers get recreated when the
  // image they were built from has changed (which is the whole reason a
  // user runs `withvibe restart` after `build-images`). `restart` alone
  // reuses the old container layer and silently keeps stale code running.
  const res = await compose(installDir, ["up", "-d"]);
  if (res.code !== 0) {
    log.fail(`compose up failed (exit ${res.code})`);
    process.exit(res.code);
  }
  log.ok("Stack restarted.");
}

export async function runStatus(args: LifecycleArgs): Promise<void> {
  const installDir = resolveInstallDir(args);
  const state = await readState(installDir);
  if (!state) {
    log.fail(`No install state at ${installDir}.`);
    process.exit(1);
  }

  log.header("Install");
  log.info(`Mode:        ${state.mode}`);
  log.info(`Install dir: ${installDir}`);
  log.info(
    `Features:    traefik=${state.features.traefik} qaBrowser=${state.features.qaBrowser} codeServer=${state.features.codeServer} googleOAuth=${state.features.googleOAuth}`
  );

  log.header("Services");
  const services = await composePs(installDir);
  if (services.length === 0) {
    log.warn("No services running (or compose ps failed).");
  } else {
    for (const s of services) {
      const health = s.health ? ` (${s.health})` : "";
      const dot = s.state === "running" ? "●" : "○";
      log.info(`  ${dot} ${s.name}: ${s.state}${health}`);
    }
  }

  log.header("Images");
  const presence = await imagePresence(state.features, state.bundle?.version);
  for (const p of presence) {
    if (p.present) log.ok(`  ${p.image}`);
    else log.fail(`  ${p.image} — not present`);
  }

  const urls = await readPublicUrls(installDir);
  log.header("URLs");
  if (urls.web) log.info(`  Web: ${urls.web}`);
  if (urls.api) log.info(`  API: ${urls.api}`);
}

export type LogsArgs = LifecycleArgs & { service?: string; follow: boolean };

export async function runLogs(args: LogsArgs): Promise<void> {
  const installDir = resolveInstallDir(args);
  const composeArgs = ["logs"];
  if (args.follow) composeArgs.push("-f");
  if (args.service) composeArgs.push(args.service);
  await compose(installDir, composeArgs);
}

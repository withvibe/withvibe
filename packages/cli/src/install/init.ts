import { promises as fs } from "node:fs";
import path from "node:path";
import prompts from "prompts";
import { runDoctor, printReport } from "./doctor.js";
import { log } from "./log.js";
import { randomPassword, randomSecret } from "./secrets.js";
import { serializeEnv, writeEnvFile, type EnvMap } from "./env-file.js";
import {
  composePath,
  DEFAULT_INSTALL_DIR,
  DEFAULT_REPO_BASE_DIR,
  ensureDir,
  envPath,
  expandHome,
} from "./paths.js";
import {
  defaultFeatures,
  readState,
  writeState,
  type InstallMode,
  type InstallState,
} from "./state.js";
import { setNoPull, setTraefik, stripBuildBlocks } from "./compose-rewriter.js";
import { findFreePort } from "./ports.js";
import { runBuildImages } from "./commands/build-images-cmd.js";
import { runStart } from "./commands/lifecycle.js";

export type InitOptions = {
  mode?: InstallMode;
  installDir?: string;
  // Pre-resolve the bundle path for from-bundle installs so the prompt is
  // skipped and a Default preset is allowed (one-shot non-interactive install).
  bundlePath?: string;
  // Skip the live Anthropic-key validation. Currently unused — secrets like
  // ANTHROPIC_API_KEY are no longer collected at init time (configured later
  // from the UI). Kept on the type to preserve the CLI flag surface.
  skipKeyCheck?: boolean;
  // Non-interactive: pick "default" preset, no prompts at all (apart from the
  // implicit choice of "default" when -y is passed).
  yes?: boolean;
  // Deliberately re-init over an existing install (destroys its database).
  // Without it, init refuses to clobber an existing install.
  force?: boolean;
  // Skip the auto build+start tail. Useful when the operator wants to review
  // .env or compose before triggering the heavy docker work.
  noBuild?: boolean;
  noStart?: boolean;
};

const ENV_KEY_ORDER = [
  "POSTGRES_USER",
  "POSTGRES_PASSWORD",
  "POSTGRES_DB",
  "INTERNAL_JWT_SECRET",
  "ANTHROPIC_API_KEY",
  "GOOGLE_CLIENT_ID",
  "GOOGLE_CLIENT_SECRET",
  "GITHUB_TOKEN",
  "WEB_PUBLIC_URL",
  "API_PUBLIC_URL",
  "PUBLIC_HOST",
  "WEB_HOST_PORT",
  "API_HOST_PORT",
  "REPO_BASE_DIR",
  "LOG_LEVEL",
  "WITHVIBE_VERSION",
  "WITHVIBE_ROUTING_BASE_DOMAIN",
  "TRAEFIK_BASE_DOMAIN",
  "TRAEFIK_ACME_EMAIL",
  "TRAEFIK_HTTP_HOST_PORT",
  "TRAEFIK_HTTPS_HOST_PORT",
];

const ENV_COMMENTS: Record<string, string> = {
  POSTGRES_USER: "Postgres credentials — used by both the postgres service and the api DATABASE_URL.",
  INTERNAL_JWT_SECRET: "Signs session JWTs. Generated automatically. Rotating invalidates active sessions.",
  ANTHROPIC_API_KEY:
    "Set later from the workspace UI (Settings → Anthropic). Leaving blank keeps agent runs disabled until you configure it.",
  WEB_PUBLIC_URL: "Public-facing URLs — set to whatever the browser uses to reach the stack.",
  WEB_HOST_PORT:
    "Host-side ports for the api/web containers. Default 3000/4000; auto-bumped by `init` when those are taken.",
  REPO_BASE_DIR:
    "Where the api stores per-env clones. Bind-mounted into the api container at the SAME path (DooD path-parity).",
  TRAEFIK_BASE_DOMAIN: "Traefik base domain (only used when Traefik is enabled).",
  WITHVIBE_ROUTING_BASE_DOMAIN:
    "Wildcard base domain for env-service subdomains + demo templates. Defaults to the Traefik base domain.",
  TRAEFIK_HTTP_HOST_PORT:
    "Host-side ports Traefik listens on. Default 80/443; auto-bumped on macOS where 80 is often taken by AirPlay.",
};

// "Default" preset — used by the one-click flow and when -y is passed. Every
// answer here can still be tweaked later via `withvibe configure`.
type Defaults = {
  installDir: string;
  publicHost: string;
  webHostPort: number;
  apiHostPort: number;
  webPublicUrl: string;
  apiPublicUrl: string;
  repoBaseDir: string;
  enableQaBrowser: boolean;
  enableCodeServer: boolean;
  // Default preset enables Traefik with a localhost base domain. The
  // compose-rewriter detects the localhost shape and emits an HTTP-only
  // Traefik config (no ACME), so the install works locally with zero extra
  // prompts. Real-domain installs (custom mode) get full HTTPS.
  traefik: {
    baseDomain: string;
    acmeEmail: string;
    httpPort: number;
    httpsPort: number;
  };
};

// Pick free host ports for api/web/Traefik. Scans upward from the standard
// values so installs on a host with :3000 already in use silently land on
// :3001 (etc.) instead of failing preflight.
async function pickPorts(): Promise<{
  webHostPort: number;
  apiHostPort: number;
  traefikHttp: number;
  traefikHttps: number;
}> {
  const webHostPort = (await findFreePort(3000)) ?? 3000;
  // Skip the just-picked web port when scanning for the api port.
  const apiStart = webHostPort >= 4000 ? webHostPort + 1 : 4000;
  const apiHostPort = (await findFreePort(apiStart)) ?? 4000;
  const traefikHttp = (await findFreePort(80)) ?? 80;
  const traefikHttps = (await findFreePort(443)) ?? 443;
  return { webHostPort, apiHostPort, traefikHttp, traefikHttps };
}

async function buildDefaults(installDir: string): Promise<Defaults> {
  const ports = await pickPorts();
  return {
    installDir,
    publicHost: "localhost",
    webHostPort: ports.webHostPort,
    apiHostPort: ports.apiHostPort,
    webPublicUrl: `http://localhost:${ports.webHostPort}`,
    apiPublicUrl: `http://localhost:${ports.apiHostPort}`,
    repoBaseDir: path.join(installDir, "repos"),
    enableQaBrowser: true,
    enableCodeServer: true,
    traefik: {
      baseDomain: "localhost",
      acmeEmail: "admin@localhost",
      httpPort: ports.traefikHttp,
      httpsPort: ports.traefikHttps,
    },
  };
}

type Answers = Omit<Defaults, "traefik"> & {
  // Custom mode lets the user opt out of Traefik entirely.
  traefik: {
    baseDomain: string;
    acmeEmail: string;
    httpPort: number;
    httpsPort: number;
  } | null;
};

export async function runInit(opts: InitOptions): Promise<void> {
  log.header("withvibe install");

  // 1. Preflight (always runs — there's no scenario where we want to skip this).
  log.step("Running host preflight…");
  const preflight = await runDoctor({
    repoBaseDir: opts.installDir
      ? path.join(opts.installDir, "repos")
      : DEFAULT_REPO_BASE_DIR,
  });
  printReport(preflight);
  if (!preflight.ok) {
    log.fail("Preflight failed. Fix the items above and re-run `withvibe init`.");
    process.exit(1);
  }

  // 2. Default vs custom — the only top-level question.
  const preset = opts.yes ? "default" : await pickPreset();

  // 3. Install dir — asked only in custom mode (default uses ~/.withvibe).
  const installDir = opts.installDir
    ? path.resolve(expandHome(opts.installDir))
    : preset === "default"
      ? DEFAULT_INSTALL_DIR
      : await ask({
          type: "text",
          name: "v",
          message: "Install directory (where .env, docker-compose.yml, and state live):",
          initial: DEFAULT_INSTALL_DIR,
        });
  await ensureDir(installDir);

  // 3b. Guard: never silently clobber an existing install. Re-running init
  //     regenerates POSTGRES_PASSWORD + INTERNAL_JWT_SECRET and clears the
  //     configured API keys, which makes the existing Postgres volume
  //     unreadable. `withvibe upgrade` is the safe path between releases.
  const priorState = await readState(installDir);
  let hasEnvFile = false;
  try {
    await fs.access(envPath(installDir));
    hasEnvFile = true;
  } catch {
    // no .env — nothing here yet
  }
  if (priorState || hasEnvFile) {
    log.warn(`An existing withvibe install was found at ${installDir}.`);
    log.warn(
      "Re-running `init` regenerates the Postgres password and session " +
        "secret and clears configured API keys — the existing database will " +
        "become unreadable and workspace API keys will be lost."
    );
    log.warn(
      "To move to a new version WITHOUT data loss, run `withvibe upgrade` instead."
    );
    if (opts.force) {
      log.warn("--force passed: proceeding with a destructive re-init.");
    } else if (opts.yes) {
      log.fail(
        "Refusing to re-init non-interactively. Run `withvibe upgrade`, or " +
          "pass `--force` to deliberately wipe and reinstall."
      );
      process.exit(1);
    } else {
      const proceed = await confirm(
        "Wipe the existing install and reinitialize? This destroys its database.",
        false
      );
      if (!proceed) {
        log.ok("Left the existing install untouched. Nothing changed.");
        process.exit(0);
      }
    }
  }

  // 4. Mode — only the install source picker. Default = from-source if a
  //    repo root is detectable; otherwise we error out and ask the user to
  //    rerun in custom mode.
  const mode = (opts.mode ?? (await pickMode(preset))) as InstallMode;

  // 5. Mode-specific paths.
  let registry: InstallState["registry"];
  let source: InstallState["source"];
  let bundle: InstallState["bundle"];
  if (mode === "from-registry") {
    if (preset === "default") {
      registry = { namespace: "ghcr.io/withvibe", tag: "latest" };
    } else {
      const namespace = await ask({
        type: "text",
        name: "v",
        message: "Registry namespace for prebuilt images:",
        initial: "ghcr.io/withvibe",
      });
      const tag = await ask({
        type: "text",
        name: "v",
        message: "Image tag:",
        initial: "latest",
      });
      registry = { namespace, tag };
    }
  } else if (mode === "from-source") {
    const guess = await guessRepoRoot();
    if (preset === "default") {
      if (!guess) {
        log.fail(
          "Default install picked from-source mode but couldn't auto-detect the repo root. " +
            "Re-run with `withvibe init` and choose Custom, or pass --install-dir / clone the repo first."
        );
        process.exit(1);
      }
      source = { repoPath: guess };
    } else {
      const repoPath = await ask({
        type: "text",
        name: "v",
        message:
          "Path to the withvibe source tree (will run pnpm install + build images):",
        initial: guess ?? "",
        validate: async (v: string) => {
          const abs = path.resolve(expandHome(v.trim()));
          try {
            await fs.access(path.join(abs, "apps", "api", "Dockerfile"));
            await fs.access(path.join(abs, "apps", "web", "Dockerfile"));
            return true;
          } catch {
            return `No apps/api/Dockerfile or apps/web/Dockerfile under ${abs}. Pick the repo root.`;
          }
        },
      });
      source = { repoPath: path.resolve(expandHome(repoPath)) };
    }
  } else {
    let bundlePath: string;
    if (opts.bundlePath) {
      bundlePath = opts.bundlePath;
    } else if (preset === "default") {
      log.fail(
        "Default install can't pick from-bundle without --bundle-path. Pass it, or re-run in Custom mode."
      );
      process.exit(1);
    } else {
      bundlePath = await ask({
        type: "text",
        name: "v",
        message: "Path to the deploy bundle (.tar.gz or extracted directory):",
        initial: "",
        validate: (v: string) =>
          v.trim().length === 0 ? "Path is required" : true,
      });
    }
    const resolvedBundle = path.resolve(expandHome(bundlePath));
    const bundleVersion = await readBundleVersion(resolvedBundle);
    bundle = { bundlePath: resolvedBundle, version: bundleVersion };
  }

  // 6. Collect remaining answers (default preset uses computed defaults; custom prompts).
  const answers = await collectAnswers(preset, installDir);

  // 7. Generate secrets.
  const internalJwtSecret = randomSecret(32);
  const postgresPassword = randomPassword(24);

  // 8. Build .env. Note: ANTHROPIC_API_KEY / GOOGLE_* / GITHUB_TOKEN are
  //    intentionally blank — the user configures those later from the UI.
  const envValues: EnvMap = {
    POSTGRES_USER: "withvibe",
    POSTGRES_PASSWORD: postgresPassword,
    POSTGRES_DB: "withvibe",
    INTERNAL_JWT_SECRET: internalJwtSecret,
    ANTHROPIC_API_KEY: "",
    GOOGLE_CLIENT_ID: "",
    GOOGLE_CLIENT_SECRET: "",
    GITHUB_TOKEN: "",
    WEB_PUBLIC_URL: answers.webPublicUrl,
    API_PUBLIC_URL: answers.apiPublicUrl,
    PUBLIC_HOST: answers.publicHost,
    WEB_HOST_PORT: String(answers.webHostPort),
    API_HOST_PORT: String(answers.apiHostPort),
    REPO_BASE_DIR: expandHome(answers.repoBaseDir),
    LOG_LEVEL: "info",
  };
  if (bundle?.version) {
    envValues.WITHVIBE_VERSION = bundle.version;
  }
  if (answers.traefik) {
    envValues.TRAEFIK_BASE_DOMAIN = answers.traefik.baseDomain;
    // Demo templates + env-service subdomains route under this. It's the
    // same domain Traefik serves, so derive it (skip the localhost preset —
    // there the api's built-in default is fine and a localhost value is
    // meaningless for subdomain routing).
    if (
      answers.traefik.baseDomain &&
      answers.traefik.baseDomain !== "localhost"
    ) {
      envValues.WITHVIBE_ROUTING_BASE_DOMAIN = answers.traefik.baseDomain;
    }
    envValues.TRAEFIK_ACME_EMAIL = answers.traefik.acmeEmail;
    envValues.TRAEFIK_HTTP_HOST_PORT = String(answers.traefik.httpPort);
    envValues.TRAEFIK_HTTPS_HOST_PORT = String(answers.traefik.httpsPort);
  }

  await ensureDir(expandHome(answers.repoBaseDir));
  const envText = serializeEnv(envValues, ENV_KEY_ORDER, ENV_COMMENTS);
  await writeEnvFile(envPath(installDir), envText);
  log.ok(`Wrote ${envPath(installDir)} (chmod 600)`);

  // 9. Materialize compose. Pass the Traefik base domain so the rewriter
  //    picks the right variant (TLS for real domains, HTTP-only for localhost).
  await materializeCompose(installDir, mode, source, bundle, answers.traefik);

  // 10. Persist install state. googleOAuth always starts off; user enables
  //     it later via `withvibe configure` (which collects + saves the creds).
  const state: InstallState = {
    version: 1,
    mode,
    installDir,
    installedAt: new Date().toISOString(),
    features: {
      ...defaultFeatures(),
      traefik: !!answers.traefik,
      qaBrowser: answers.enableQaBrowser,
      codeServer: answers.enableCodeServer,
      googleOAuth: false,
    },
    registry,
    source,
    bundle,
    traefik: answers.traefik ?? undefined,
  };
  await writeState(installDir, state);
  log.ok(`Saved install state to ${path.join(installDir, "install.json")}`);

  // 11. Final summary.
  log.header("Install initialized");
  log.info(`Mode:           ${mode}`);
  log.info(`Install dir:    ${installDir}`);
  log.info(`REPO_BASE_DIR:  ${envValues.REPO_BASE_DIR}`);
  log.info(`Web URL:        ${answers.webPublicUrl} (host port ${answers.webHostPort})`);
  log.info(`API URL:        ${answers.apiPublicUrl} (host port ${answers.apiHostPort})`);
  log.info(
    `Traefik:        ${
      answers.traefik
        ? `enabled (${answers.traefik.baseDomain}, ports ${answers.traefik.httpPort}/${answers.traefik.httpsPort})`
        : "disabled"
    }`
  );
  log.info(`QA browser:     ${answers.enableQaBrowser ? "enabled" : "disabled"}`);
  log.info(`code-server:    ${answers.enableCodeServer ? "enabled" : "disabled"}`);
  // 12. Decide whether to continue into build-images + start.
  //     Default preset auto-continues (one-click is the whole point).
  //     Custom preset asks. Both honor --no-build / --no-start.
  const wantBuild =
    !opts.noBuild &&
    (preset === "default" ||
      (await confirm("Build images now? (~5–10 min the first time)", true)));
  const wantStart =
    !opts.noStart &&
    (preset === "default" ||
      (await confirm("Start the stack now (docker compose up -d)?", true)));

  if (wantBuild) {
    console.log("");
    log.header("Building images");
    try {
      await runBuildImages({ installDir });
    } catch (e) {
      log.fail(`build-images failed: ${(e as Error).message}`);
      log.dim("Re-run with `withvibe build-images` once you've fixed it.");
      process.exit(1);
    }
  }

  if (wantStart) {
    console.log("");
    await runStart({ installDir });
  }

  console.log("");
  if (!wantBuild || !wantStart) {
    log.info("Remaining steps:");
    if (!wantBuild)
      log.dim(`  withvibe build-images   # ${imageStepHint(mode)}`);
    if (!wantStart)
      log.dim(`  withvibe start          # docker compose up -d + health gate`);
    log.dim(`  withvibe status         # confirm services + URLs`);
    console.log("");
  }
  log.info(
    "Configure Anthropic / Google OAuth / GitHub credentials later from the UI (Workspace Settings)."
  );
}

// Bundles include a `bundle.json` next to images.tar with the image tag
// they were saved under. Returns undefined for legacy bundles without it
// (callers will fall back to :latest via compose's WITHVIBE_VERSION default).
async function readBundleVersion(bundlePath: string): Promise<string | undefined> {
  const candidate = bundlePath.endsWith(".tar.gz")
    ? path.join(path.dirname(bundlePath), "bundle.json")
    : path.join(bundlePath, "bundle.json");
  try {
    const text = await fs.readFile(candidate, "utf8");
    const parsed = JSON.parse(text) as { version?: unknown };
    if (typeof parsed.version === "string" && parsed.version.length > 0) {
      return parsed.version;
    }
  } catch {
    // No bundle.json — older bundle format. Compose default kicks in.
  }
  return undefined;
}

function imageStepHint(mode: InstallMode): string {
  switch (mode) {
    case "from-source":
      return "build api/web/sidecars from source";
    case "from-bundle":
      return "load images from the bundle's images.tar";
    case "from-registry":
      return "pull api/web/sidecars from the registry";
  }
}

type Preset = "default" | "custom";

async function pickPreset(): Promise<Preset> {
  const res = await prompts(
    {
      type: "select",
      name: "v",
      message: "How do you want to install?",
      choices: [
        {
          title: "Default (recommended) — one-click install with sane defaults",
          description:
            "localhost URLs, all sidecars + Traefik on. Anthropic/Google/GitHub keys configured later from the UI.",
          value: "default",
        },
        {
          title: "Custom",
          description: "Pick public URLs, ports, sidecars, Traefik, install dir, etc.",
          value: "custom",
        },
      ],
      initial: 0,
    },
    {
      onCancel: () => {
        log.fail("Cancelled.");
        process.exit(1);
      },
    }
  );
  return res.v as Preset;
}

async function pickMode(preset: Preset): Promise<InstallMode> {
  // Default install: try from-source first (if we can detect the repo root),
  // otherwise from-registry. This keeps the one-click flow functional whether
  // the user is running from a clone or from a fresh `npm i -g withvibe`.
  if (preset === "default") {
    const guess = await guessRepoRoot();
    return guess ? "from-source" : "from-registry";
  }

  const res = await prompts({
    type: "select",
    name: "v",
    message: "How do you want to obtain the images?",
    choices: [
      {
        title: "From source (build images locally)",
        description: "Use an existing source tree and run docker build.",
        value: "from-source",
      },
      {
        title: "From registry (pull prebuilt images)",
        description: "Default: ghcr.io/withvibe.",
        value: "from-registry",
      },
      {
        title: "From bundle (offline tarball)",
        description: "Use scripts/build-bundle.sh output. No network registry needed.",
        value: "from-bundle",
      },
    ],
    initial: 0,
  });
  if (!res.v) {
    log.fail("Cancelled.");
    process.exit(1);
  }
  return res.v as InstallMode;
}

async function collectAnswers(
  preset: Preset,
  installDir: string
): Promise<Answers> {
  const d = await buildDefaults(installDir);
  if (preset === "default") {
    // Tell the user when we had to bump a port off its standard value so
    // they're not surprised when status shows :3001 instead of :3000.
    if (d.webHostPort !== 3000)
      log.warn(`Port 3000 in use — web bound to :${d.webHostPort}.`);
    if (d.apiHostPort !== 4000)
      log.warn(`Port 4000 in use — api bound to :${d.apiHostPort}.`);
    if (d.traefik.httpPort !== 80)
      log.warn(
        `Port 80 in use — Traefik HTTP bound to :${d.traefik.httpPort}.`
      );
    return { ...d, traefik: d.traefik };
  }

  const publicHost = await ask({
    type: "text",
    name: "v",
    message: "Public host (the hostname/IP browsers use to reach this VM):",
    initial: d.publicHost,
  });
  const webHostPort = await askPort(
    "Host port for the web app:",
    d.webHostPort
  );
  const apiHostPort = await askPort("Host port for the api:", d.apiHostPort);
  const webPublicUrl = await ask({
    type: "text",
    name: "v",
    message: "Public URL of the web app:",
    initial: `http://${publicHost}:${webHostPort}`,
  });
  const apiPublicUrl = await ask({
    type: "text",
    name: "v",
    message: "Public URL of the api:",
    initial: `http://${publicHost}:${apiHostPort}`,
  });

  // Traefik defaults to ON. With a localhost base domain we emit an HTTP-only
  // Traefik (no ACME); with a real domain we emit the full HTTPS config.
  const useTraefik = await confirm(
    "Enable Traefik (reverse proxy + subdomain routing)?",
    true
  );
  let traefik: Answers["traefik"] = null;
  if (useTraefik) {
    const baseDomain = await ask({
      type: "text",
      name: "v",
      message:
        "Traefik base domain (use `localhost` for local dev, or e.g. withvibe.example.com for production):",
      initial: d.traefik.baseDomain,
      validate: (v: string) =>
        /^[a-z0-9.-]+(\.[a-z]{2,}|^localhost)$/i.test(v.trim()) ||
        v.trim().toLowerCase() === "localhost"
          ? true
          : "Enter `localhost` or a real domain like withvibe.example.com",
    });
    const acmeEmail = await ask({
      type: "text",
      name: "v",
      message:
        "ACME email (Let's Encrypt — only used when the base domain is a real public domain):",
      initial: d.traefik.acmeEmail,
      validate: (v: string) =>
        /.+@.+/.test(v.trim()) ? true : "Enter a valid email",
    });
    const httpPort = await askPort(
      "Traefik HTTP host port:",
      d.traefik.httpPort
    );
    const httpsPort = await askPort(
      "Traefik HTTPS host port:",
      d.traefik.httpsPort
    );
    traefik = {
      baseDomain: baseDomain.trim(),
      acmeEmail: acmeEmail.trim(),
      httpPort,
      httpsPort,
    };
  }

  const enableQaBrowser = await confirm(
    "Enable the QA browser sidecar image (used by QA agent for browser automation)?",
    d.enableQaBrowser
  );
  const enableCodeServer = await confirm(
    "Enable the code-server sidecar image (browser-based VSCode per env)?",
    d.enableCodeServer
  );
  const repoBaseDir = await ask({
    type: "text",
    name: "v",
    message: "REPO_BASE_DIR (host path for per-env clones, bind-mounted to api):",
    initial: d.repoBaseDir,
  });

  return {
    installDir: d.installDir,
    publicHost,
    webHostPort,
    apiHostPort,
    webPublicUrl,
    apiPublicUrl,
    repoBaseDir,
    enableQaBrowser,
    enableCodeServer,
    traefik,
  };
}

async function askPort(message: string, initial: number): Promise<number> {
  const v = await ask({
    type: "text",
    name: "v",
    message,
    initial: String(initial),
    validate: (raw: string) => {
      const n = Number(raw.trim());
      if (!Number.isInteger(n) || n < 1 || n > 65535)
        return "Enter a port between 1 and 65535";
      return true;
    },
  });
  return Number(v.trim());
}

// Best-effort guess of the source tree root. Tries cwd → walk up from cwd
// → walk up from the running script's location (catches `pnpm link --global`
// installs where the binary lives inside the source tree). Returns null
// when nothing convincing is found.
async function guessRepoRoot(): Promise<string | null> {
  const candidates: string[] = [process.cwd()];
  const scriptDir = path.dirname(new URL(import.meta.url).pathname);
  candidates.push(scriptDir);
  for (const start of candidates) {
    let cur = start;
    for (let i = 0; i < 8; i++) {
      const ok = await isRepoRoot(cur);
      if (ok) return cur;
      const parent = path.dirname(cur);
      if (parent === cur) break;
      cur = parent;
    }
  }
  return null;
}

async function isRepoRoot(p: string): Promise<boolean> {
  try {
    await fs.access(path.join(p, "apps", "api", "Dockerfile"));
    await fs.access(path.join(p, "apps", "web", "Dockerfile"));
    await fs.access(path.join(p, "pnpm-workspace.yaml"));
    return true;
  } catch {
    return false;
  }
}

async function materializeCompose(
  installDir: string,
  mode: InstallMode,
  source: InstallState["source"],
  bundle: InstallState["bundle"],
  traefik: { baseDomain: string; acmeEmail: string } | null | undefined
): Promise<void> {
  const dst = composePath(installDir);

  // Locate an existing docker-compose.yml and copy it. We don't generate a
  // brand-new one — we reuse the project's tested manifest so `init` never
  // drifts from what `docker compose up` will run.
  const candidates: string[] = [];
  if (mode === "from-source" && source?.repoPath) {
    candidates.push(path.join(source.repoPath, "docker-compose.yml"));
  } else if (mode === "from-bundle" && bundle?.bundlePath) {
    candidates.push(path.join(bundle.bundlePath, "docker-compose.yml"));
  }
  // Fallbacks: the package's own assets dir (shipped with the npm package),
  // and the repo we're currently running from (dev install).
  const here = path.dirname(new URL(import.meta.url).pathname);
  candidates.push(path.join(here, "..", "assets", "docker-compose.yml"));
  candidates.push(path.join(here, "..", "..", "..", "..", "docker-compose.yml"));

  for (const c of candidates) {
    try {
      const raw = await fs.readFile(c, "utf8");
      // The repo's compose has `build:` blocks for the dev/from-source path.
      // The materialized copy lives in the install dir with no source tree
      // beside it, so strip the build blocks and pin pull_policy:never on
      // our images — `withvibe build-images` is the only legitimate way to
      // get the api/web images locally. Then layer in Traefik if requested.
      let text = setNoPull(stripBuildBlocks(raw));
      text = setTraefik(text, !!traefik, traefik?.baseDomain);
      await fs.writeFile(dst, text);
      log.ok(`Copied compose file from ${c}`);
      return;
    } catch {
      // try next
    }
  }

  log.warn(
    `No docker-compose.yml found yet. You'll need to drop one at ${dst} before \`compose up\`.`
  );
}

// Wrappers around prompts() that exit the process on Ctrl+C instead of
// returning undefined and letting the caller proceed with garbage.
async function ask(q: prompts.PromptObject): Promise<string> {
  const res = await prompts(q, {
    onCancel: () => {
      log.fail("Cancelled.");
      process.exit(1);
    },
  });
  const v = res.v;
  if (typeof v !== "string") {
    log.fail("Cancelled.");
    process.exit(1);
  }
  return v;
}

async function confirm(message: string, initial: boolean): Promise<boolean> {
  const res = await prompts(
    { type: "confirm", name: "v", message, initial },
    {
      onCancel: () => {
        log.fail("Cancelled.");
        process.exit(1);
      },
    }
  );
  return !!res.v;
}

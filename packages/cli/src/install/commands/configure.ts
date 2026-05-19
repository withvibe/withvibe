import path from "node:path";
import { promises as fs } from "node:fs";
import prompts from "prompts";
import ora from "ora";
import { log } from "../log.js";
import {
  composePath,
  DEFAULT_INSTALL_DIR,
  ensureDir,
  envPath,
  expandHome,
} from "../paths.js";
import { readEnvFile, serializeEnv, writeEnvFile } from "../env-file.js";
import { setTraefik, TRAEFIK_BYOCERT_DYNAMIC } from "../compose-rewriter.js";
import { readState, writeState, type InstallState } from "../state.js";
import { validateAnthropicKey } from "../anthropic-validate.js";
import { randomSecret } from "../secrets.js";
import { buildAllImages, pullAllImages } from "../build-images.js";

export type ConfigureArgs = { installDir?: string };

export async function runConfigure(args: ConfigureArgs): Promise<void> {
  const installDir = args.installDir
    ? path.resolve(expandHome(args.installDir))
    : DEFAULT_INSTALL_DIR;
  const state = await readState(installDir);
  if (!state) {
    log.fail(`No install at ${installDir}. Run \`withvibe init\` first.`);
    process.exit(1);
  }

  log.header("withvibe — configure");
  log.info(`Editing install at ${installDir}`);

  for (;;) {
    const choice = await prompts(
      {
        type: "select",
        name: "v",
        message: "What do you want to change?",
        choices: [
          {
            title: `Traefik (TLS + domain): ${
              state.features.traefik
                ? (state.traefik?.baseDomain ?? "ON")
                : "off"
            }`,
            value: "traefik",
          },
          { title: `QA browser sidecar: ${onOff(state.features.qaBrowser)}`, value: "qaBrowser" },
          { title: `code-server sidecar: ${onOff(state.features.codeServer)}`, value: "codeServer" },
          { title: `Google OAuth: ${onOff(state.features.googleOAuth)}`, value: "google" },
          { title: "GitHub token", value: "github" },
          { title: "Public URLs (PUBLIC_HOST / WEB_PUBLIC_URL / API_PUBLIC_URL)", value: "urls" },
          { title: "Rotate secrets (INTERNAL_JWT_SECRET / POSTGRES_PASSWORD)", value: "rotate" },
          { title: "Update Anthropic key", value: "anthropic" },
          {
            title: "Shared infra / external DB access (advanced)",
            value: "advanced",
          },
          { title: "Save & exit", value: "exit" },
        ],
        initial: 0,
      },
      { onCancel: () => process.exit(0) }
    );
    if (!choice.v || choice.v === "exit") break;

    if (choice.v === "traefik") await configureTraefik(state, installDir);
    else if (choice.v === "qaBrowser") await toggleSidecar(state, installDir, "qaBrowser");
    else if (choice.v === "codeServer") await toggleSidecar(state, installDir, "codeServer");
    else if (choice.v === "google") await toggleGoogle(state, installDir);
    else if (choice.v === "github") await editGithubToken(installDir);
    else if (choice.v === "urls") await editUrls(installDir);
    else if (choice.v === "rotate") await rotateSecrets(installDir);
    else if (choice.v === "anthropic") await updateAnthropicKey(installDir);
    else if (choice.v === "advanced") await configureAdvanced(installDir);

    await writeState(installDir, state);
  }

  log.ok("Saved.");
  log.dim("Restart affected services with `withvibe restart`.");
}

function onOff(b: boolean): string {
  return b ? "ON" : "off";
}

// Enable Traefik, change its domain/email, or disable it. The default
// `--yes` install enables Traefik on `localhost` (plain HTTP), so the
// common follow-up is "I installed on localhost, now point it at my
// real domain with HTTPS" — that must be a first-class path, not a
// disable-then-re-enable dance.
async function configureTraefik(
  state: InstallState,
  installDir: string
): Promise<void> {
  if (state.features.traefik) {
    const { v: action } = await prompts(
      {
        type: "select",
        name: "v",
        message: `Traefik is on (domain: ${state.traefik?.baseDomain ?? "?"}). What do you want to do?`,
        choices: [
          { title: "Change base domain / ACME email", value: "change" },
          { title: "Disable Traefik", value: "disable" },
          { title: "Cancel", value: "cancel" },
        ],
        initial: 0,
      },
      { onCancel: () => process.exit(0) }
    );
    if (!action || action === "cancel") return;
    if (action === "disable") {
      state.features.traefik = false;
      state.traefik = undefined;
      await rewriteCompose(installDir, (yaml) =>
        setTraefik(yaml, false, undefined)
      );
      log.ok("Traefik disabled.");
      return;
    }
    // action === "change" → fall through to the prompts below.
  }

  const baseDomain = await ask({
    type: "text",
    name: "v",
    message: "Traefik base domain (e.g. withvibe.example.com):",
    initial: state.traefik?.baseDomain ?? "",
    validate: (v: string) =>
      /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(v.trim())
        ? true
        : "Enter a valid domain",
  });
  const domain = baseDomain.trim();
  state.features.traefik = true;

  // Env-service subdomains + demo templates route under this. Decoupled from
  // the Traefik base domain on purpose: env services are reached at the
  // single-label host `<svc>-<short>.<routingBase>`, so the TLS cert must
  // cover `*.<routingBase>`. When the operator's wildcard sits at a different
  // level than the platform UI host (e.g. UI at dev.example.com but the cert
  // is *.example.com), point env routing at the level the cert covers.
  const routingBaseInput = await ask({
    type: "text",
    name: "v",
    message: "Env subdomain base domain (services at <svc>-<id>.<this>):",
    initial: state.traefik?.envRoutingBase ?? domain,
    validate: (v: string) =>
      /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(v.trim())
        ? true
        : "Enter a valid domain",
  });
  const routingBase = routingBaseInput.trim();
  if (routingBase !== domain) {
    log.dim(
      `Env services will use *.${routingBase} — make sure your TLS cert covers that wildcard.`
    );
  }

  const { v: certMethod } = await prompts(
    {
      type: "select",
      name: "v",
      message: "TLS certificate:",
      choices: [
        {
          title: "Let's Encrypt — automatic (needs ports 80/443 + public DNS)",
          value: "acme",
        },
        {
          title: "Bring your own certificate (PEM cert + key)",
          value: "byocert",
        },
      ],
      initial: state.traefik?.tls === "byocert" ? 1 : 0,
    },
    { onCancel: () => process.exit(0) }
  );
  if (!certMethod) return;

  if (certMethod === "byocert") {
    const certSrc = await resolveFile(
      "Path to TLS certificate (PEM, full chain):",
      state.traefik?.certPath
    );
    const keySrc = await resolveFile(
      "Path to TLS private key (PEM):",
      state.traefik?.keyPath
    );
    const certsDir = path.join(installDir, "certs");
    const dynDir = path.join(installDir, "traefik-dynamic");
    await ensureDir(certsDir);
    await ensureDir(dynDir);
    await fs.copyFile(certSrc, path.join(certsDir, "tls.crt"));
    await fs.copyFile(keySrc, path.join(certsDir, "tls.key"));
    await fs.chmod(path.join(certsDir, "tls.key"), 0o600).catch(() => {});
    await fs.writeFile(path.join(dynDir, "tls.yml"), TRAEFIK_BYOCERT_DYNAMIC);
    state.traefik = {
      baseDomain: domain,
      tls: "byocert",
      certPath: certSrc,
      keyPath: keySrc,
      envRoutingBase: routingBase,
    };
    await mergeEnv(installDir, {
      TRAEFIK_BASE_DOMAIN: domain,
      // Per-env subdomain routers must not attempt ACME — they reuse
      // Traefik's default (operator-supplied) cert. That cert needs to
      // cover the env subdomains (e.g. a wildcard) to be valid for them.
      TRAEFIK_CERT_RESOLVER: "",
    });
    await rewriteCompose(installDir, (yaml) =>
      setTraefik(yaml, true, domain, "byocert")
    );
    log.ok(`Traefik using your certificate for ${domain}.`);
    log.dim(
      `Cert copied into ${path.join(installDir, "certs")}. Re-run this to rotate it.`
    );
  } else {
    const acmeEmail = await ask({
      type: "text",
      name: "v",
      message: "ACME email (Let's Encrypt):",
      initial: state.traefik?.acmeEmail ?? "",
      validate: (v: string) =>
        /.+@.+\..+/.test(v.trim()) ? true : "Enter a valid email",
    });
    state.traefik = {
      baseDomain: domain,
      tls: "acme",
      acmeEmail: acmeEmail.trim(),
      envRoutingBase: routingBase,
    };
    await mergeEnv(installDir, {
      TRAEFIK_BASE_DOMAIN: domain,
      TRAEFIK_ACME_EMAIL: acmeEmail.trim(),
    });
    await rewriteCompose(installDir, (yaml) =>
      setTraefik(yaml, true, domain, "acme")
    );
    log.ok(`Traefik configured for ${domain} (Let's Encrypt).`);
  }

  // Demo templates + env-service subdomains route under the chosen env
  // routing base (defaults to the Traefik domain; both branches above set it).
  // Always a real validated domain here, never localhost.
  await mergeEnv(installDir, { WITHVIBE_ROUTING_BASE_DOMAIN: routingBase });

  // The localhost→domain switch is incomplete unless the public URLs move
  // too, so offer it right here instead of making the user also visit the
  // "Public URLs" menu.
  const sync = await prompts(
    {
      type: "confirm",
      name: "v",
      message: `Also set PUBLIC_HOST / WEB_PUBLIC_URL / API_PUBLIC_URL to https://${domain}?`,
      initial: true,
    },
    { onCancel: () => process.exit(0) }
  );
  if (sync.v) {
    await mergeEnv(installDir, {
      PUBLIC_HOST: domain,
      WEB_PUBLIC_URL: `https://${domain}`,
      API_PUBLIC_URL: `https://${domain}`,
    });
    log.ok(`Public URLs set to https://${domain}.`);
  }
}

async function toggleSidecar(
  state: InstallState,
  installDir: string,
  feature: "qaBrowser" | "codeServer"
): Promise<void> {
  const next = !state.features[feature];
  state.features[feature] = next;
  if (!next) {
    log.ok(
      `${feature} disabled in state. Existing local image (if any) is left in place; remove with \`docker image rm\` if you want to free space.`
    );
    return;
  }
  // Re-enabling: make sure the image is present.
  const featureFlags = state.features;
  if (state.mode === "from-source" && state.source) {
    await buildAllImages({ repoPath: state.source.repoPath, features: featureFlags });
  } else if (state.mode === "from-registry" && state.registry) {
    await pullAllImages({
      namespace: state.registry.namespace,
      tag: state.registry.tag,
      features: featureFlags,
    });
  } else {
    log.warn(
      `${feature} re-enabled but image must be (re)loaded manually for from-bundle installs.`
    );
  }
}

async function toggleGoogle(
  state: InstallState,
  installDir: string
): Promise<void> {
  const next = !state.features.googleOAuth;
  if (next) {
    const id = await ask({
      type: "text",
      name: "v",
      message: "GOOGLE_CLIENT_ID:",
      validate: (v: string) => (v.trim() ? true : "Required"),
    });
    const secret = await ask({
      type: "password",
      name: "v",
      message: "GOOGLE_CLIENT_SECRET:",
      validate: (v: string) => (v.trim() ? true : "Required"),
    });
    await mergeEnv(installDir, {
      GOOGLE_CLIENT_ID: id.trim(),
      GOOGLE_CLIENT_SECRET: secret,
    });
  } else {
    await mergeEnv(installDir, {
      GOOGLE_CLIENT_ID: "",
      GOOGLE_CLIENT_SECRET: "",
    });
  }
  state.features.googleOAuth = next;
  log.ok(`Google OAuth ${next ? "enabled" : "disabled"}.`);
}

async function editGithubToken(installDir: string): Promise<void> {
  const token = await ask({
    type: "password",
    name: "v",
    message: "GITHUB_TOKEN (blank to clear):",
    initial: "",
  });
  await mergeEnv(installDir, { GITHUB_TOKEN: token });
  log.ok(`GITHUB_TOKEN ${token ? "updated" : "cleared"}.`);
}

async function editUrls(installDir: string): Promise<void> {
  const env = await readEnvFile(envPath(installDir));
  const publicHost = await ask({
    type: "text",
    name: "v",
    message: "PUBLIC_HOST:",
    initial: env.PUBLIC_HOST ?? "localhost",
  });
  const web = await ask({
    type: "text",
    name: "v",
    message: "WEB_PUBLIC_URL:",
    initial: env.WEB_PUBLIC_URL ?? `http://${publicHost}:3000`,
  });
  const api = await ask({
    type: "text",
    name: "v",
    message: "API_PUBLIC_URL:",
    initial: env.API_PUBLIC_URL ?? `http://${publicHost}:4000`,
  });
  await mergeEnv(installDir, {
    PUBLIC_HOST: publicHost.trim(),
    WEB_PUBLIC_URL: web.trim(),
    API_PUBLIC_URL: api.trim(),
  });
  log.ok("URLs updated.");
}

async function rotateSecrets(installDir: string): Promise<void> {
  const which = await prompts(
    {
      type: "multiselect",
      name: "v",
      message: "Which secrets to rotate?",
      choices: [
        {
          title: "INTERNAL_JWT_SECRET (invalidates every active session)",
          value: "jwt",
        },
        {
          title: "POSTGRES_PASSWORD (requires DB password change inside postgres too)",
          value: "pg",
        },
      ],
      hint: "space to select, enter to confirm",
    },
    { onCancel: () => process.exit(0) }
  );
  const picks = (which.v ?? []) as string[];
  if (picks.length === 0) return;
  const update: Record<string, string> = {};
  if (picks.includes("jwt")) update.INTERNAL_JWT_SECRET = randomSecret(32);
  if (picks.includes("pg")) {
    log.warn(
      "Rotating POSTGRES_PASSWORD only updates .env. You must ALSO ALTER USER inside postgres before restarting."
    );
    update.POSTGRES_PASSWORD = randomSecret(24);
  }
  await mergeEnv(installDir, update);
  log.ok("Secrets rotated.");
}

async function updateAnthropicKey(installDir: string): Promise<void> {
  const key = await ask({
    type: "password",
    name: "v",
    message: "ANTHROPIC_API_KEY:",
    validate: (v: string) => {
      const trimmed = v.trim();
      if (!trimmed) return "Required";
      if (!/^sk-ant-(api|oat)/.test(trimmed))
        return "Must start with `sk-ant-api` (API key) or `sk-ant-oat` (Claude Max/Pro OAuth token).";
      if (trimmed.length < 40)
        return "Key looks too short to be valid. Re-paste the full key.";
      return true;
    },
  });
  const spinner = ora("Validating key…").start();
  const r = await validateAnthropicKey(key);
  if (r.ok) {
    spinner.succeed(
      r.kind === "oauth-token"
        ? "Claude Max/Pro OAuth token accepted (live-check skipped — only API keys can be live-validated)"
        : "API key is valid"
    );
  } else {
    spinner.fail(r.error);
    const proceed = await prompts(
      { type: "confirm", name: "v", message: "Save anyway?", initial: false },
      { onCancel: () => process.exit(0) }
    );
    if (!proceed.v) return;
  }
  // Both API keys and OAuth tokens live in the same .env slot; the api code
  // (chat-stream.service.ts) detects the prefix and routes at spawn time.
  await mergeEnv(installDir, { ANTHROPIC_API_KEY: key });
  log.ok("ANTHROPIC_API_KEY updated.");
}

// Operator gates for the multi-tenant network-isolation model. These are
// platform-side .env keys the first-run installer intentionally does NOT
// prompt for: the env/template IDs they reference don't exist until the
// system is running, and the right bind interface is deployment-specific.
// Entering this menu IS the explicit, knowing opt-in. All OFF by default.
async function configureAdvanced(installDir: string): Promise<void> {
  for (;;) {
    const env = await readEnvFile(envPath(installDir));
    const tcpOn = !!(env.WITHVIBE_TCP_EXPOSE || "").trim();
    const sharedOn = !!(env.WITHVIBE_SHARED_NET || "").trim();
    const { v } = await prompts(
      {
        type: "select",
        name: "v",
        message: "Advanced — network isolation gates:",
        choices: [
          {
            title: `External/remote DB (TCP) access: ${onOff(tcpOn)}`,
            value: "tcp",
          },
          {
            title: `Cross-env shared infrastructure: ${onOff(sharedOn)}`,
            value: "shared",
          },
          {
            title: `Traefik container name: ${
              env.WITHVIBE_TRAEFIK_CONTAINER || "withvibe-traefik (default)"
            }`,
            value: "traefik-name",
          },
          { title: "Back", value: "back" },
        ],
        initial: 0,
      },
      { onCancel: () => process.exit(0) }
    );
    if (!v || v === "back") return;
    if (v === "tcp") await configureTcpExpose(installDir);
    else if (v === "shared") await configureSharedInfra(installDir);
    else if (v === "traefik-name") await configureTraefikContainer(installDir);
    log.dim(
      "Applies after `withvibe restart`. Phase-gated at env materialize/up — " +
        "existing envs pick it up only when recreated/restarted."
    );
  }
}

async function configureTcpExpose(installDir: string): Promise<void> {
  const env = await readEnvFile(envPath(installDir));
  const enabled = !!(env.WITHVIBE_TCP_EXPOSE || "").trim();
  const { v: on } = await prompts(
    {
      type: "confirm",
      name: "v",
      message: enabled
        ? "External TCP access is ON. Keep it enabled?"
        : "Enable external/remote TCP access (e.g. reach a DB from another machine)?",
      initial: enabled,
    },
    { onCancel: () => process.exit(0) }
  );
  if (!on) {
    await mergeEnv(installDir, { WITHVIBE_TCP_EXPOSE: "" });
    log.ok("External TCP access disabled (services stay private).");
    return;
  }
  log.warn(
    "This publishes a raw TCP port with NO platform auth — only the service's " +
      "own credentials protect it. Strongly prefer a private/VPN bind IP " +
      "below, and use strong DB credentials."
  );
  const envs = await ask({
    type: "text",
    name: "v",
    message: "Authorized env IDs (comma-separated, blank = none):",
    initial: env.WITHVIBE_TCP_EXPOSE_ENVS ?? "",
  });
  const tpls = await ask({
    type: "text",
    name: "v",
    message:
      "Authorized template IDs or slugs (comma-separated, blank = none):",
    initial: env.WITHVIBE_TCP_EXPOSE_TEMPLATES ?? "",
  });
  const bind = await ask({
    type: "text",
    name: "v",
    message:
      "Bind interface IP (e.g. your VPN IP; blank = ALL interfaces / 0.0.0.0):",
    initial: env.WITHVIBE_TCP_BIND ?? "",
  });
  const eCsv = csvNorm(envs);
  const tCsv = csvNorm(tpls);
  await mergeEnv(installDir, {
    WITHVIBE_TCP_EXPOSE: "1",
    WITHVIBE_TCP_EXPOSE_ENVS: eCsv,
    WITHVIBE_TCP_EXPOSE_TEMPLATES: tCsv,
    WITHVIBE_TCP_BIND: bind.trim(),
  });
  if (!eCsv && !tCsv)
    log.warn(
      "Nothing allowlisted — feature enabled but no env/template authorized, " +
        "so no port is published yet."
    );
  if (!bind.trim())
    log.warn(
      "WITHVIBE_TCP_BIND blank → ports bind to ALL interfaces. Set a " +
        "private/VPN IP unless you intend public exposure."
    );
  log.ok("External TCP access configured.");
}

async function configureSharedInfra(installDir: string): Promise<void> {
  const env = await readEnvFile(envPath(installDir));
  log.dim(
    "Connects authorized envs to a Docker network YOU created (with your " +
      "shared DB attached under a stable name). The platform never creates " +
      "or owns that network."
  );
  const net = await ask({
    type: "text",
    name: "v",
    message: "Shared Docker network name (blank = disable shared infra):",
    initial: env.WITHVIBE_SHARED_NET ?? "",
  });
  if (!net.trim()) {
    await mergeEnv(installDir, { WITHVIBE_SHARED_NET: "" });
    log.ok("Cross-env shared infrastructure disabled.");
    return;
  }
  const envs = await ask({
    type: "text",
    name: "v",
    message: "Authorized env IDs (comma-separated, blank = none):",
    initial: env.WITHVIBE_SHARED_ENVS ?? "",
  });
  const tpls = await ask({
    type: "text",
    name: "v",
    message:
      "Authorized template IDs or slugs (comma-separated, blank = none):",
    initial: env.WITHVIBE_SHARED_TEMPLATES ?? "",
  });
  const eCsv = csvNorm(envs);
  const tCsv = csvNorm(tpls);
  await mergeEnv(installDir, {
    WITHVIBE_SHARED_NET: net.trim(),
    WITHVIBE_SHARED_ENVS: eCsv,
    WITHVIBE_SHARED_TEMPLATES: tCsv,
  });
  if (!eCsv && !tCsv)
    log.warn(
      "Nothing allowlisted yet — shared infra is set but no env/template is " +
        "authorized to use it."
    );
  log.ok(`Shared infrastructure network set to "${net.trim()}".`);
}

async function configureTraefikContainer(installDir: string): Promise<void> {
  const env = await readEnvFile(envPath(installDir));
  const name = await ask({
    type: "text",
    name: "v",
    message:
      "Traefik container name (platform connects it to each env's edge net):",
    initial: env.WITHVIBE_TRAEFIK_CONTAINER ?? "withvibe-traefik",
  });
  const final = name.trim() || "withvibe-traefik";
  await mergeEnv(installDir, { WITHVIBE_TRAEFIK_CONTAINER: final });
  log.ok(`Traefik container name set to "${final}".`);
}

// Normalise a comma list the same way the api parses these allowlists:
// trim each entry, drop empties. Keeps .env tidy and round-trips cleanly.
function csvNorm(s: string): string {
  return s
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean)
    .join(",");
}

async function mergeEnv(
  installDir: string,
  patch: Record<string, string>
): Promise<void> {
  const existing = await readEnvFile(envPath(installDir));
  const merged = { ...existing, ...patch };
  // Preserve existing key order; new keys are appended.
  const order = Array.from(
    new Set([...Object.keys(existing), ...Object.keys(patch)])
  );
  await writeEnvFile(envPath(installDir), serializeEnv(merged, order));
}

async function rewriteCompose(
  installDir: string,
  fn: (yaml: string) => string
): Promise<void> {
  const file = composePath(installDir);
  const original = await fs.readFile(file, "utf8");
  const next = fn(original);
  if (next === original) return;
  // Atomic write: never leave compose half-written.
  const tmp = file + ".tmp";
  await fs.writeFile(tmp, next);
  await fs.rename(tmp, file);
}

async function ask(q: prompts.PromptObject): Promise<string> {
  const r = await prompts(q, { onCancel: () => process.exit(0) });
  return typeof r.v === "string" ? r.v : "";
}

// Prompt for a path to an existing readable file; re-prompts until valid.
// Returns the resolved absolute path.
async function resolveFile(
  message: string,
  initial?: string
): Promise<string> {
  const v = await ask({
    type: "text",
    name: "v",
    message,
    initial: initial ?? "",
    validate: async (input: string) => {
      const p = path.resolve(expandHome(String(input).trim()));
      try {
        await fs.access(p);
        return true;
      } catch {
        return "File not found or not readable";
      }
    },
  });
  return path.resolve(expandHome(v.trim()));
}


/**
 * Compose security gate.
 *
 * The platform runs user- and AI-authored `docker-compose.yml` files via
 * `docker compose up` AS ROOT against the host Docker daemon (the api
 * container bind-mounts /var/run/docker.sock). An unrestricted compose file
 * is therefore a direct host-root primitive: `privileged: true`, host
 * namespaces, `network_mode: host`, device passthrough, or a bind mount of
 * `/`, `/etc`, `/root`, or the docker socket all escape the env sandbox.
 *
 * This module rejects any compose that requests escape-equivalent
 * capabilities. It is the authoritative control: it must run at the
 * start/rebuild chokepoint (`DockerService`) BEFORE `docker compose up`,
 * for EVERY compose source — custom, workspace asset, env-root (which the
 * autonomous agent writes itself), repo-derived, and post-rewrite template.
 *
 * Resolution: a naive YAML walk is bypassable via YAML anchors/merge keys,
 * `${VAR}` interpolation, and `extends`/`include`. The runtime gate first
 * runs `docker compose config`, which emits the fully-resolved canonical
 * model that `up` actually uses, then validates THAT — so what we check is
 * byte-for-byte what runs. `config` only parses; it never starts containers.
 * Its stdout contains interpolated `${VAR}`/`.env` secret VALUES, so it is
 * parsed in memory and MUST NEVER be logged.
 *
 * Policy decisions (locked with the maintainer):
 *  - resolver: `docker compose config` (not in-process YAML).
 *  - on violation: hard reject with a precise, non-secret error.
 *  - bind mounts: allowed only if the real (realpath) host path resolves
 *    inside that env's own directory; absolute/`..`/symlink-escape denied.
 */
import { execFile } from "child_process";
import { promisify } from "util";
import { realpath } from "fs/promises";
import path from "path";
import { parse as parseYaml } from "yaml";

const exec = promisify(execFile);

/** Thrown when a compose file requests an escape-equivalent capability. */
export class ComposeSecurityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ComposeSecurityError";
  }
}

/**
 * Well-known sensitive host paths, used only to phrase a clearer prewrite
 * message. The decisive prewrite rule is "no absolute host bind"; the
 * decisive runtime rule is realpath-containment in the env dir (which also
 * defeats symlink escape and the docker socket, since neither resolves
 * inside the env directory). This list is NOT a runtime allow/deny gate —
 * the env dir itself lives under /root/.withvibe by default, so a prefix
 * denylist here would false-positive on every legitimate env.
 */
const SENSITIVE_HINTS: ReadonlyArray<[string, string]> = [
  ["/var/run/docker.sock", "the Docker socket"],
  ["/run/docker.sock", "the Docker socket"],
  ["/proc", "a host /proc path"],
  ["/sys", "a host /sys path"],
  ["/dev", "a host device path"],
  ["/etc", "a host /etc path"],
  ["/root", "a host /root path"],
  ["/var/lib/docker", "the Docker data root"],
];

/**
 * `security_opt` entries that weaken the container sandbox. Compared after
 * lowercasing and stripping whitespace. `seccomp=<profile>` /
 * `apparmor=<profile>` (a real profile, not "unconfined") are allowed.
 */
const WEAKENING_SECURITY_OPT = new Set([
  "seccomp=unconfined",
  "apparmor=unconfined",
  "apparmor:unconfined",
  "label=disable",
  "label:disable",
  "systempaths=unconfined",
  "no-new-privileges=false",
  "no-new-privileges:false",
]);

type Rec = Record<string, unknown>;

const isRec = (v: unknown): v is Rec =>
  typeof v === "object" && v !== null && !Array.isArray(v);

function asArray(v: unknown): unknown[] {
  if (v == null) return [];
  return Array.isArray(v) ? v : [v];
}

function strOf(v: unknown): string {
  return typeof v === "string"
    ? v
    : typeof v === "number" || typeof v === "boolean"
      ? String(v)
      : "";
}

/** `host` or `container:<id>` namespace sharing is an escape; `service:<x>`
 * (a sibling in the same project — and siblings can't be privileged because
 * we reject that) and the in-container modes are fine. */
function isHostOrContainerNs(v: unknown): boolean {
  const s = strOf(v).trim().toLowerCase();
  return s === "host" || s.startsWith("container:");
}

type Mode = "prewrite" | "runtime";

/**
 * Effective Docker network name for a top-level `networks:` entry IF it is
 * external, else null. Handles `external: true` (name = `name:` or the key)
 * and the deprecated `external: { name: <n> }` long form. `docker compose
 * config` normalises to `{ name, external: true }`; raw YAML may be just the
 * key with `external: true`.
 */
function externalNetworkName(key: string, def: unknown): string | null {
  if (!isRec(def)) return null;
  const ext = def.external;
  const isExternal = ext === true || (isRec(ext) && ext.name != null) || ext === "true";
  if (!isExternal) return null;
  if (typeof def.name === "string" && def.name) return def.name;
  if (isRec(ext) && typeof ext.name === "string" && ext.name) return ext.name;
  return key;
}

/** Top-level network keys a service references, across the list
 * (`networks: [a, b]`) and map (`networks: {a: null}`) syntaxes. `docker
 * compose config` normalises to the map form; raw YAML may use either. */
function serviceNetworkNames(svc: Rec): string[] {
  const n = svc.networks;
  if (Array.isArray(n)) return n.filter((x): x is string => typeof x === "string");
  if (isRec(n)) return Object.keys(n);
  return [];
}

/** True if the service carries `traefik.enable=true` — list form
 * (`["traefik.enable=true"]`) or map form (`{traefik.enable: true}`).
 * `docker compose config` normalises labels to a map. */
function serviceHasTraefikEnable(svc: Rec): boolean {
  const labels = svc.labels;
  if (Array.isArray(labels))
    return labels.some((l) => strOf(l).replace(/\s+/g, "") === "traefik.enable=true");
  if (isRec(labels)) {
    const v = labels["traefik.enable"];
    return v === true || strOf(v).trim().toLowerCase() === "true";
  }
  return false;
}

/**
 * Static, synchronous checks that don't need the filesystem or Docker.
 * Returns a list of human-readable violation strings (empty = clean).
 * Shared by the save-time fail-fast path and the authoritative runtime gate.
 *
 * `allowedExternalNets` is the set of external Docker networks that ARE
 * legitimate — in practice the single operator-configured Traefik proxy
 * network (`PROXY_NETWORK`, default "proxy"), which the platform's own
 * compose-rewriter attaches subdomain-routed env services to. Any OTHER
 * external network is still rejected (that's the real attack surface — an
 * env joining an arbitrary/sensitive external network).
 */
function collectStaticViolations(
  model: unknown,
  mode: Mode,
  allowedExternalNets: ReadonlySet<string>
): string[] {
  const out: string[] = [];
  if (!isRec(model)) {
    // `docker compose config` always emits a mapping; a non-mapping here
    // (or a non-object top-level in raw YAML) is malformed → fail closed.
    return ["compose file is not a valid mapping"];
  }

  const services = isRec(model.services) ? model.services : {};
  for (const [name, raw] of Object.entries(services)) {
    if (!isRec(raw)) continue;
    const svc = raw;
    const at = `service "${name}"`;

    if (svc.privileged === true) out.push(`${at}: privileged: true is not allowed`);
    if (asArray(svc.cap_add).length > 0)
      out.push(`${at}: cap_add is not allowed (drops container isolation)`);
    if (asArray(svc.devices).length > 0)
      out.push(`${at}: devices (host device passthrough) is not allowed`);
    if (asArray(svc.device_cgroup_rules).length > 0)
      out.push(`${at}: device_cgroup_rules is not allowed`);
    if (asArray(svc.volumes_from).length > 0)
      out.push(`${at}: volumes_from is not allowed`);
    if (svc.cgroup_parent != null && svc.cgroup_parent !== "")
      out.push(`${at}: cgroup_parent is not allowed`);
    if (strOf(svc.userns_mode).trim().toLowerCase() === "host")
      out.push(`${at}: userns_mode: host is not allowed`);

    for (const ns of ["pid", "ipc", "uts", "cgroup"] as const) {
      if (svc[ns] != null && isHostOrContainerNs(svc[ns]))
        out.push(`${at}: ${ns}: ${strOf(svc[ns])} (host/container namespace) is not allowed`);
    }

    if (svc.network_mode != null && isHostOrContainerNs(svc.network_mode))
      out.push(`${at}: network_mode: ${strOf(svc.network_mode)} is not allowed`);

    for (const opt of asArray(svc.security_opt)) {
      const norm = strOf(opt).toLowerCase().replace(/\s+/g, "");
      if (WEAKENING_SECURITY_OPT.has(norm))
        out.push(`${at}: security_opt "${strOf(opt)}" weakens the sandbox and is not allowed`);
    }

    // Bind-mount source policy. At prewrite the source is as-authored; at
    // runtime `docker compose config` has already absolutised it and the
    // realpath containment check (assertModelSafe) is authoritative — here
    // we only catch the statically-obvious escapes.
    for (const vol of asArray(svc.volumes)) {
      const src = bindSource(vol);
      if (src == null) continue; // named/anonymous/tmpfs volume — not a bind
      const v = checkBindSourceStatic(src, mode);
      if (v) out.push(`${at}: bind mount source "${src}" ${v}`);
    }

    // Build context: with `--build`, the context dir is the only thing the
    // Dockerfile can read — `/` as context leaks the host / is a DoS.
    for (const p of buildContextPaths(svc.build)) {
      const v = checkBindSourceStatic(p, mode);
      if (v) out.push(`${at}: build context "${p}" ${v}`);
    }
  }

  // Top-level named volumes: `driver_opts` with a bind device is a bind
  // mount in disguise; `external: true` can attach a pre-existing sensitive
  // volume (e.g. the platform's own postgres data volume).
  const volumes = isRec(model.volumes) ? model.volumes : {};
  for (const [vname, def] of Object.entries(volumes)) {
    if (isRec(def) && def.external) out.push(`volume "${vname}": external volumes are not allowed`);
    const dev = isRec(def) && isRec(def.driver_opts) ? def.driver_opts.device : undefined;
    if (typeof dev === "string" && dev) {
      const v = checkBindSourceStatic(dev, mode);
      if (v) out.push(`volume "${vname}": driver_opts.device "${dev}" ${v}`);
    }
  }

  // External networks could let the env join an arbitrary/sensitive network.
  // The one legitimate case is the operator's Traefik proxy network, which
  // the platform's own rewriter attaches subdomain envs to — allow exactly
  // that, reject any other external network. Collect the top-level keys that
  // resolve to the allowed proxy net so we can then enforce that ONLY
  // Traefik-exposed services ride it.
  const networks = isRec(model.networks) ? model.networks : {};
  const proxyNetKeys = new Set<string>();
  for (const [nname, def] of Object.entries(networks)) {
    const extName = externalNetworkName(nname, def);
    if (extName == null) continue;
    if (!allowedExternalNets.has(extName)) {
      out.push(
        `network "${nname}" is an external network ("${extName}") that is ` +
          `not the configured proxy network — not allowed`
      );
    } else {
      proxyNetKeys.add(nname);
    }
  }

  // The proxy network is SHARED across every env. Docker registers a service's
  // bare name as a DNS alias on every network it joins, so a private service
  // (a DB, cache, …) left on the proxy net is resolvable by name from other
  // envs — letting one env silently connect to another env's database. Only
  // Traefik-exposed services (which the rewriter marks with
  // `traefik.enable=true`) may ride the shared net; anything else must stay on
  // the per-env internal network. Defense-in-depth behind the rewriter: this
  // also catches a hand-authored compose that joins a DB to the proxy net.
  if (proxyNetKeys.size > 0) {
    for (const [name, raw] of Object.entries(services)) {
      if (!isRec(raw)) continue;
      const onProxy = serviceNetworkNames(raw).some((n) => proxyNetKeys.has(n));
      if (onProxy && !serviceHasTraefikEnable(raw))
        out.push(
          `service "${name}" is attached to the shared proxy network but is ` +
            `not Traefik-exposed (no traefik.enable=true) — private services ` +
            `must stay on the internal network (a service on the shared ` +
            `network is reachable by name from other environments)`
        );
    }
  }

  // configs/secrets sourced from a host file must stay inside the env dir.
  for (const kind of ["configs", "secrets"] as const) {
    const m = isRec(model[kind]) ? (model[kind] as Rec) : {};
    for (const [cname, def] of Object.entries(m)) {
      const file = isRec(def) ? def.file : undefined;
      if (typeof file === "string" && file) {
        const v = checkBindSourceStatic(file, mode);
        if (v) out.push(`${kind} "${cname}": file "${file}" ${v}`);
      }
    }
  }

  return out;
}

/** Extract the host-side source of a bind mount, or null for named /
 * anonymous / tmpfs volumes (which cannot escape the host filesystem). */
function bindSource(vol: unknown): string | null {
  if (typeof vol === "string") {
    // short syntax: [SOURCE:]TARGET[:MODE]
    const parts = vol.split(":");
    if (parts.length < 2) return null; // anonymous volume (TARGET only)
    const src = parts[0];
    // A named volume is a bare token (no path separator, not . / ~). Anything
    // path-like is a bind.
    if (/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(src) && !src.includes("/")) return null;
    return src;
  }
  if (isRec(vol)) {
    const type = strOf(vol.type).trim().toLowerCase();
    if (type === "volume" || type === "tmpfs") return null;
    if (type === "bind") return typeof vol.source === "string" ? vol.source : "";
    if (type === "" && typeof vol.source === "string") {
      // No explicit type: path-like source ⇒ bind.
      const s = vol.source;
      if (/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(s) && !s.includes("/")) return null;
      return s;
    }
    if (type && type !== "volume" && type !== "tmpfs" && type !== "bind") {
      // cluster / npipe / image / device etc. — unexpected for env composes.
      return strOf(vol.source) || "(unsupported mount type)";
    }
  }
  return null;
}

function buildContextPaths(build: unknown): string[] {
  if (typeof build === "string") return [build];
  if (isRec(build)) {
    const ps: string[] = [];
    if (typeof build.context === "string") ps.push(build.context);
    if (isRec(build.additional_contexts))
      for (const v of Object.values(build.additional_contexts))
        if (typeof v === "string" && !v.includes("://")) ps.push(v);
    return ps;
  }
  return [];
}

/**
 * Statically-decidable bind violations (no filesystem access).
 *  - prewrite: the source is as-authored. Policy is "bind mounts must stay
 *    inside the env directory", so ANY absolute host path is rejected (this
 *    subsumes the docker socket, /etc, /, …); `..`-escaping relative paths
 *    are rejected; plain relative paths defer to the runtime check.
 *  - runtime: `docker compose config` has absolutised every source, so a
 *    static "is it absolute" test is meaningless here — return "" and let
 *    the authoritative realpath-containment check (assertModelSafe) decide.
 * Returns a reason fragment, or "" if not statically decidable.
 */
function checkBindSourceStatic(src: string, mode: Mode): string {
  if (src.includes("${"))
    return "uses an unresolved variable and cannot be safely validated";
  if (mode !== "prewrite") return "";
  const norm = src.replace(/\\/g, "/");
  if (path.isAbsolute(norm)) {
    const hint = SENSITIVE_HINTS.find(
      ([p]) => norm === p || norm.startsWith(p + "/")
    );
    return hint
      ? `is ${hint[1]} and is not allowed`
      : "is an absolute host path (bind mounts must stay inside the env directory)";
  }
  if (norm.split("/").some((seg) => seg === ".."))
    return "escapes the env directory via '..'";
  return "";
}

/**
 * Resolve a path to its real location, tolerating not-yet-existing leaves
 * (a bind source dir is often created by `compose up`). Walks up to the
 * deepest existing ancestor, realpaths that, then re-appends the remainder.
 */
async function canonicalize(p: string): Promise<string> {
  let cur = path.resolve(p);
  const tail: string[] = [];
  // Bounded walk; paths are short.
  for (let i = 0; i < 64; i++) {
    try {
      const real = await realpath(cur);
      return tail.length ? path.join(real, ...tail.reverse()) : real;
    } catch {
      const parent = path.dirname(cur);
      if (parent === cur) return path.resolve(p); // reached root, nothing real
      tail.push(path.basename(cur));
      cur = parent;
    }
  }
  return path.resolve(p);
}

function isInside(child: string, root: string): boolean {
  if (child === root) return true;
  const rootWithSep = root.endsWith(path.sep) ? root : root + path.sep;
  return child.startsWith(rootWithSep);
}

/**
 * Authoritative check against a resolved compose model. Runs the static
 * checks plus the async realpath containment for every bind-mount source,
 * build context, driver_opts device, and configs/secrets file.
 * `containmentRoot` is the env's own directory; bind sources must resolve
 * inside it.
 */
async function assertModelSafe(
  model: unknown,
  containmentRoot: string,
  allowedExternalNets: ReadonlySet<string>
): Promise<void> {
  const violations = collectStaticViolations(model, "runtime", allowedExternalNets);

  let root: string;
  try {
    root = await realpath(containmentRoot);
  } catch {
    root = path.resolve(containmentRoot);
  }

  const checkPath = async (label: string, src: string) => {
    if (src.includes("${")) {
      violations.push(`${label} "${src}" could not be resolved`);
      return;
    }
    const canon = await canonicalize(
      path.isAbsolute(src) ? src : path.join(root, src)
    );
    if (!isInside(canon, root))
      violations.push(
        `${label} "${src}" resolves to "${canon}", outside the env directory`
      );
  };

  if (isRec(model)) {
    const services = isRec(model.services) ? model.services : {};
    for (const [name, raw] of Object.entries(services)) {
      if (!isRec(raw)) continue;
      for (const vol of asArray(raw.volumes)) {
        const src = bindSource(vol);
        if (src != null && src !== "")
          await checkPath(`service "${name}" bind mount`, src);
      }
      for (const p of buildContextPaths(raw.build))
        await checkPath(`service "${name}" build context`, p);
    }
    const volumes = isRec(model.volumes) ? model.volumes : {};
    for (const [vname, def] of Object.entries(volumes)) {
      const dev = isRec(def) && isRec(def.driver_opts) ? def.driver_opts.device : undefined;
      if (typeof dev === "string" && dev)
        await checkPath(`volume "${vname}" driver_opts.device`, dev);
    }
    for (const kind of ["configs", "secrets"] as const) {
      const m = isRec(model[kind]) ? (model[kind] as Rec) : {};
      for (const [cname, def] of Object.entries(m)) {
        const file = isRec(def) ? def.file : undefined;
        if (typeof file === "string" && file)
          await checkPath(`${kind} "${cname}" file`, file);
      }
    }
  }

  if (violations.length > 0) throw securityError(violations);
}

function securityError(violations: string[]): ComposeSecurityError {
  const uniq = [...new Set(violations)];
  return new ComposeSecurityError(
    "Compose file rejected for security — it requests host-level access " +
      "that could compromise the machine:\n" +
      uniq.map((v) => `  • ${v}`).join("\n") +
      "\nRemove these directives. Bind mounts must stay inside the " +
      "environment's own directory; privileged mode, host namespaces, " +
      "device passthrough, and the Docker socket are never allowed."
  );
}

/** Options shared by the gate entry points. */
export type ComposeSecurityOptions = {
  /** External Docker networks that ARE legitimate — in practice the single
   * operator-configured Traefik proxy network (`PROXY_NETWORK`, default
   * "proxy") the platform's rewriter attaches subdomain envs to. */
  allowedExternalNetworks?: string[];
};

function netSet(opts?: ComposeSecurityOptions): ReadonlySet<string> {
  return new Set(
    (opts?.allowedExternalNetworks ?? []).filter((n) => typeof n === "string" && n)
  );
}

/**
 * AUTHORITATIVE runtime gate. Resolves the compose exactly as `docker
 * compose up` will (interpolation, anchors, extends, include) then validates
 * the resolved model. Throws {@link ComposeSecurityError} on violation or if
 * the compose is invalid (fail closed). `projectName` must match the `-p`
 * used for `up` so interpolation/`.env` resolution is identical.
 */
export async function assertComposeFileSafe(
  composeFilePath: string,
  envDir: string,
  projectName: string,
  opts: ComposeSecurityOptions = {}
): Promise<void> {
  const projectDir = path.dirname(composeFilePath);
  let stdout: string;
  try {
    const r = await exec(
      "docker",
      ["compose", "-p", projectName, "-f", composeFilePath, "config"],
      { timeout: 60_000, cwd: projectDir, maxBuffer: 32 * 1024 * 1024 }
    );
    stdout = r.stdout;
  } catch (err: unknown) {
    // Fail closed. `config`'s stderr names the offending key/service (safe);
    // its STDOUT would contain resolved secret values — never touch it here.
    const e = err as { stderr?: string; message?: string };
    const firstLine =
      (e.stderr || e.message || "compose config failed")
        .split("\n")
        .map((s) => s.trim())
        .filter(Boolean)[0] || "invalid compose file";
    throw new ComposeSecurityError(
      `Compose file is invalid and cannot be safely started: ${firstLine.slice(
        0,
        200
      )}`
    );
  }

  let model: unknown;
  try {
    model = parseYaml(stdout, { merge: true });
  } catch {
    throw new ComposeSecurityError(
      "Resolved compose output could not be parsed (fail closed)"
    );
  }
  await assertModelSafe(model, envDir, netSet(opts));
}

/**
 * Best-effort fail-fast for the save path (env create/update). Runs the
 * static structural checks on the raw YAML so an obviously-dangerous paste
 * is rejected immediately with a 4xx. NOT authoritative: `${VAR}`/extends/
 * include aren't resolved here and the env dir doesn't exist yet, so the
 * runtime gate ({@link assertComposeFileSafe}) remains the security
 * boundary. Anchors/merge keys ARE resolved (matching Compose).
 */
export function assertComposeStringSafe(
  rawYaml: string,
  opts: ComposeSecurityOptions = {}
): void {
  if (!rawYaml || !rawYaml.trim()) return; // empty compose handled elsewhere
  let model: unknown;
  try {
    model = parseYaml(rawYaml, { merge: true });
  } catch (err: unknown) {
    const m = (err as { message?: string }).message || "invalid YAML";
    throw new ComposeSecurityError(
      `Compose file is not valid YAML: ${String(m).slice(0, 200)}`
    );
  }
  if (model == null) return;
  const violations = collectStaticViolations(model, "prewrite", netSet(opts));
  if (violations.length > 0) throw securityError(violations);
}

// Exposed for the self-check script (this repo has no test runner; the
// `assertModelSafe` seam lets the check exercise the authoritative
// containment logic with a synthetic resolved model — i.e. what `docker
// compose config` would emit — without needing a Docker daemon).
export const __internal = {
  collectStaticViolations,
  bindSource,
  canonicalize,
  assertModelSafe,
};

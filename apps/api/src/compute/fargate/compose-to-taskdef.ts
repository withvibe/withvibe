import { parse as parseYaml } from "yaml";
import type { RegisterTaskDefinitionCommandInput } from "@aws-sdk/client-ecs";

/**
 * Translate a docker-compose file into one ECS Fargate task definition —
 * one task per env, one container per compose service.
 *
 * Scope (Phase 1, images-only):
 *   - `build:` is rejected: Fargate cannot build; images must come from a
 *     registry the client account can pull (public, or ECR in that account).
 *   - A bind mount of an env repository (`./<repo>`, optionally a subdirectory
 *     of it) resolves to that repo's clone on the task's EFS workspace: the
 *     task clones its own repos into /workspace, so the files a compose file
 *     expects to find next to it genuinely exist — just not on a host. Every
 *     other bind mount is still rejected; there is no shared host filesystem,
 *     and that is the whole point of the sandbox. Named volumes become
 *     task-scoped ephemeral volumes (data lives for the task, not restarts).
 *   - All containers share the task's network namespace (awsvpc), so
 *     cross-service traffic rides localhost. Compose service DNS names don't
 *     resolve, so service-name references inside environment values are
 *     rewritten to 127.0.0.1 (reported in `notes`).
 *
 * Pure function — no AWS calls — so it's covered by a self-check script
 * (compose-to-taskdef.check.ts) like the other compose transforms.
 */

export class ComposeTranslateError extends Error {}

export type TranslateInput = {
  composeYaml: string;
  /** Vars for ${VAR} interpolation — the env's .env file, like compose does. */
  dotEnv: Record<string, string>;
  family: string;
  logGroupName: string;
  region: string;
  executionRoleArn: string;
  taskRoleArn: string;
  /** EFS filesystem for persistent volumes; omit for ephemeral-only. */
  fileSystemId?: string | null;
  /** volume name -> EFS access point id. Volumes absent here stay ephemeral. */
  volumeAccessPoints?: Record<string, string>;
  /**
   * Directory names of the repositories attached to this env, as the task
   * clones them under /workspace. A bind mount of one of these resolves to
   * the clone; one of anything else cannot be satisfied and is rejected.
   */
  repoNames?: string[];
};

/**
 * A bind mount that was resolved to a path inside the task's workspace. The
 * translator is pure, so it only names the volume — the driver backs each one
 * with an EFS access point rooted at `workspacePath`.
 */
export type RepoMount = {
  /** Task volume name the container's mountPoint references. */
  volumeName: string;
  /** Repository this path belongs to (its directory under /workspace). */
  repoName: string;
  /** Path relative to the workspace root, e.g. `app` or `app/public`. */
  workspacePath: string;
};

export type TranslateResult = {
  taskDefinition: RegisterTaskDefinitionCommandInput;
  /** Compose service name → container ports it listens on (first = primary). */
  servicePorts: Record<string, number[]>;
  /** Human-readable translation decisions worth surfacing in the env log. */
  notes: string[];
  /** Repo-backed volumes the driver must create access points for. */
  repoMounts: RepoMount[];
  /**
   * Repositories a container bind-mounts, so the clone that populates them is
   * a hard prerequisite: a service started against an empty directory fails in
   * ways far more confusing than a start that refuses to finish.
   */
  requiredRepos: string[];
  /** Compose services that mount a repo — these wait for the clone. */
  servicesNeedingRepos: string[];
};

// Valid Fargate cpu/memory pairs (cpu units → allowed MiB range step-checked
// loosely; ECS enforces exactly, we just pick sane defaults and validate the
// override is one of the published cpu tiers).
const FARGATE_CPU_TIERS = new Set([256, 512, 1024, 2048, 4096, 8192, 16384]);
const DEFAULT_CPU = 1024;
const DEFAULT_MEMORY = 2048;

const NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/;

export function translateComposeToTaskDef(
  input: TranslateInput
): TranslateResult {
  const notes: string[] = [];
  const interpolated = interpolate(input.composeYaml, input.dotEnv);
  let doc: unknown;
  try {
    doc = parseYaml(interpolated);
  } catch (err) {
    throw new ComposeTranslateError(
      `Compose file is not valid YAML: ${err instanceof Error ? err.message : err}`
    );
  }
  if (!isRecord(doc) || !isRecord(doc.services)) {
    throw new ComposeTranslateError("Compose file has no services section");
  }
  const services = doc.services as Record<string, unknown>;
  const serviceNames = Object.keys(services);
  if (serviceNames.length === 0) {
    throw new ComposeTranslateError("Compose file has no services");
  }
  for (const name of serviceNames) {
    if (!NAME_RE.test(name)) {
      throw new ComposeTranslateError(`Invalid service name "${name}"`);
    }
  }

  const namedVolumes = new Set(
    isRecord(doc.volumes) ? Object.keys(doc.volumes) : []
  );
  const usedVolumes = new Set<string>();

  // Repo-backed bind mounts. Keyed by workspace path so two services mounting
  // the same directory share one volume (and so one access point) instead of
  // racing two mounts of the same inode.
  const repoNames = input.repoNames ?? [];
  const repoMountsByPath = new Map<string, RepoMount>();
  const requiredRepos = new Set<string>();
  const servicesNeedingRepos = new Set<string>();
  const repoVolume = (workspacePath: string, repoName: string): string => {
    const existing = repoMountsByPath.get(workspacePath);
    if (existing) return existing.volumeName;
    const base = `wv-repo-${workspacePath.replace(/[^a-zA-Z0-9]+/g, "-")}`
      .replace(/-+$/, "")
      .slice(0, 190);
    const taken = new Set(
      [...repoMountsByPath.values()].map((m) => m.volumeName)
    );
    let volumeName = base;
    for (let i = 2; taken.has(volumeName); i++) volumeName = `${base}-${i}`;
    repoMountsByPath.set(workspacePath, { volumeName, repoName, workspacePath });
    return volumeName;
  };
  const servicePorts: Record<string, number[]> = {};
  const containers: NonNullable<
    RegisterTaskDefinitionCommandInput["containerDefinitions"]
  > = [];

  for (const [name, raw] of Object.entries(services)) {
    if (!isRecord(raw)) {
      throw new ComposeTranslateError(`Service "${name}" is not a mapping`);
    }
    if (raw.build !== undefined) {
      throw new ComposeTranslateError(
        `Service "${name}" uses build: — Fargate envs are images-only. ` +
          `Push the image to a registry and reference it with image:.`
      );
    }
    const image = typeof raw.image === "string" ? raw.image.trim() : "";
    if (!image) {
      throw new ComposeTranslateError(`Service "${name}" has no image:`);
    }

    // ---- environment ------------------------------------------------------
    const env = readEnvironment(raw.environment, name);
    if (raw.env_file !== undefined) {
      const files = Array.isArray(raw.env_file) ? raw.env_file : [raw.env_file];
      for (const f of files) {
        const p = typeof f === "string" ? f : isRecord(f) ? f.path : null;
        if (p === ".env" || p === "./.env") {
          for (const [k, v] of Object.entries(input.dotEnv)) {
            if (!(k in env)) env[k] = v;
          }
        } else {
          notes.push(
            `service ${name}: env_file ${String(p)} ignored (only ./.env is supported on Fargate)`
          );
        }
      }
    }
    // Compose service DNS doesn't exist inside a task — rewrite peer service
    // names in env values to 127.0.0.1 (containers share the namespace).
    const peers = serviceNames.filter((s) => s !== name);
    for (const [k, v] of Object.entries(env)) {
      const rewritten = rewriteServiceHosts(v, peers, k);
      if (rewritten !== v) {
        env[k] = rewritten;
        notes.push(
          `service ${name}: env ${k} rewrote service hostname(s) to 127.0.0.1`
        );
      }
    }

    // ---- volumes ----------------------------------------------------------
    const mountPoints: { sourceVolume: string; containerPath: string; readOnly?: boolean }[] =
      [];
    if (raw.volumes !== undefined) {
      const vols = Array.isArray(raw.volumes) ? raw.volumes : [];
      for (const v of vols) {
        const parsed = parseVolumeEntry(v, namedVolumes);
        if (parsed.kind === "bind") {
          const repo = resolveRepoBind(parsed.source, repoNames);
          if (!repo) {
            throw new ComposeTranslateError(
              `Service "${name}" bind-mounts "${parsed.source}" — host paths don't exist on Fargate. ` +
                (repoNames.length > 0
                  ? `Only a path inside an attached repository works here (${repoNames
                      .map((r) => `./${r}`)
                      .join(", ")}); otherwise use a named volume (task-scoped) ` +
                    `or bake the files into the image.`
                  : `This env has no repositories attached, so use a named volume ` +
                    `(task-scoped) or bake the files into the image.`)
            );
          }
          const volumeName = repoVolume(repo.workspacePath, repo.repoName);
          requiredRepos.add(repo.repoName);
          servicesNeedingRepos.add(name);
          mountPoints.push({
            sourceVolume: volumeName,
            containerPath: parsed.target,
            ...(parsed.readOnly ? { readOnly: true } : {}),
          });
          notes.push(
            `service ${name}: "${parsed.source}" resolved to the ${repo.repoName} ` +
              `clone on the sandbox workspace`
          );
          continue;
        }
        usedVolumes.add(parsed.source);
        mountPoints.push({
          sourceVolume: parsed.source,
          containerPath: parsed.target,
          ...(parsed.readOnly ? { readOnly: true } : {}),
        });
      }
    }

    // ---- ports ------------------------------------------------------------
    // Template composes pass through the subdomain rewriter, which STRIPS
    // ports: and records the routing target in a Traefik label — read that
    // label first so template envs keep their route on Fargate.
    const ports = readPorts(raw.ports, raw.expose, raw.labels, name);
    servicePorts[name] = ports;

    // ---- command / entrypoint --------------------------------------------
    const command = normalizeCommandish(raw.command);
    const entryPoint = normalizeCommandish(raw.entrypoint);
    if (typeof raw.command === "string") {
      notes.push(
        `service ${name}: string command wrapped with sh -c (compose shell-word parsing is approximated)`
      );
    }

    // ---- healthcheck ------------------------------------------------------
    const healthCheck = readHealthcheck(raw.healthcheck, name, notes);

    // ---- depends_on -------------------------------------------------------
    const dependsOn = readDependsOn(raw.depends_on, serviceNames, name);

    containers.push({
      name,
      image,
      essential: true,
      environment: Object.entries(env).map(([k, v]) => ({
        name: k,
        value: v,
      })),
      ...(ports.length > 0
        ? {
            portMappings: ports.map((p) => ({
              containerPort: p,
              protocol: "tcp" as const,
            })),
          }
        : {}),
      ...(mountPoints.length > 0 ? { mountPoints } : {}),
      ...(command ? { command } : {}),
      ...(entryPoint ? { entryPoint } : {}),
      ...(typeof raw.working_dir === "string"
        ? { workingDirectory: raw.working_dir }
        : {}),
      ...(typeof raw.user === "string" || typeof raw.user === "number"
        ? { user: String(raw.user) }
        : {}),
      ...(healthCheck ? { healthCheck } : {}),
      ...(dependsOn.length > 0 ? { dependsOn } : {}),
      logConfiguration: {
        logDriver: "awslogs",
        options: {
          "awslogs-group": input.logGroupName,
          "awslogs-region": input.region,
          "awslogs-stream-prefix": "env",
        },
      },
    });
  }

  // ---- task sizing (x-withvibe: { cpu, memory }) --------------------------
  let cpu = DEFAULT_CPU;
  let memory = DEFAULT_MEMORY;
  const hints = isRecord(doc["x-withvibe"]) ? doc["x-withvibe"] : {};
  if (hints.cpu !== undefined) {
    const n = Number(hints.cpu);
    if (!FARGATE_CPU_TIERS.has(n)) {
      throw new ComposeTranslateError(
        `x-withvibe.cpu must be one of ${[...FARGATE_CPU_TIERS].join(", ")} (Fargate cpu units)`
      );
    }
    cpu = n;
  }
  if (hints.memory !== undefined) {
    const n = Number(hints.memory);
    if (!Number.isInteger(n) || n < 512 || n > 122880) {
      throw new ComposeTranslateError(
        "x-withvibe.memory must be MiB within Fargate limits"
      );
    }
    memory = n;
  }

  return {
    taskDefinition: {
      family: input.family,
      networkMode: "awsvpc",
      requiresCompatibilities: ["FARGATE"],
      cpu: String(cpu),
      memory: String(memory),
      executionRoleArn: input.executionRoleArn,
      taskRoleArn: input.taskRoleArn,
      runtimePlatform: {
        cpuArchitecture: "X86_64",
        operatingSystemFamily: "LINUX",
      },
      containerDefinitions: containers,
      ...(usedVolumes.size > 0
        ? {
            volumes: [...usedVolumes].map((name) => {
              const accessPointId = input.volumeAccessPoints?.[name];
              // With no access point the volume is task-scoped scratch that
              // dies with the task. With one, the same name resolves to a
              // directory on EFS that outlives every stop.
              if (!accessPointId || !input.fileSystemId) return { name };
              return {
                name,
                efsVolumeConfiguration: {
                  fileSystemId: input.fileSystemId,
                  transitEncryption: "ENABLED" as const,
                  authorizationConfig: { accessPointId, iam: "ENABLED" as const },
                },
              };
            }),
          }
        : {}),
    },
    servicePorts,
    notes,
    // The volume entries these name are appended by the driver, which is the
    // only layer that can turn a workspace path into an access point — same
    // arrangement as the workspace volume and the runner container.
    repoMounts: [...repoMountsByPath.values()],
    requiredRepos: [...requiredRepos],
    servicesNeedingRepos: [...servicesNeedingRepos],
  };
}

// ---------- helpers ---------------------------------------------------------

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Compose-style ${VAR} / ${VAR:-default} / ${VAR-default} interpolation. */
export function interpolate(
  yaml: string,
  vars: Record<string, string>
): string {
  return yaml.replace(
    /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::?-([^}]*))?\}/g,
    (_m, name: string, def: string | undefined) => vars[name] ?? def ?? ""
  );
}

function readEnvironment(
  raw: unknown,
  service: string
): Record<string, string> {
  const out: Record<string, string> = {};
  if (raw === undefined || raw === null) return out;
  if (Array.isArray(raw)) {
    for (const entry of raw) {
      if (typeof entry !== "string") continue;
      const idx = entry.indexOf("=");
      if (idx === -1) out[entry] = "";
      else out[entry.slice(0, idx)] = entry.slice(idx + 1);
    }
    return out;
  }
  if (isRecord(raw)) {
    for (const [k, v] of Object.entries(raw)) {
      out[k] = v === null || v === undefined ? "" : String(v);
    }
    return out;
  }
  throw new ComposeTranslateError(
    `Service "${service}" has an invalid environment section`
  );
}

/** Env keys whose BARE value plausibly names a host. The structural patterns
 * below (scheme://svc, @svc, svc:port) are safe on any key, but a bare value
 * equal to a service name is ambiguous — `MARIADB_DATABASE: wordpress` or
 * `MARIADB_USER: wordpress` must NOT become 127.0.0.1 just because a service
 * is also called wordpress. */
const HOSTISH_KEY_RE = /HOST|HOSTNAME|ADDR|ADDRESS|SERVER|ENDPOINT/i;

/** Rewrite peer-service hostnames in an env value to 127.0.0.1. Covers the
 * common shapes: scheme://svc, @svc (connection strings), svc:<port>, and —
 * only for host-looking keys — a bare value that IS the service name
 * (DB_HOST=db). */
export function rewriteServiceHosts(
  value: string,
  peers: string[],
  key = ""
): string {
  let out = value;
  for (const svc of peers) {
    if (out === svc) {
      if (HOSTISH_KEY_RE.test(key)) return "127.0.0.1";
      continue;
    }
    const esc = svc.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    out = out
      .replace(new RegExp(`(://)${esc}(?=[:/]|$)`, "g"), `$1127.0.0.1`)
      .replace(new RegExp(`(@)${esc}(?=[:/]|$)`, "g"), `$1127.0.0.1`)
      .replace(new RegExp(`(^|[\\s,;=])${esc}(?=:\\d)`, "g"), `$1127.0.0.1`);
  }
  return out;
}

/**
 * Resolve a compose bind source to a path inside the sandbox workspace, or
 * null when it cannot be satisfied there.
 *
 * Only a relative path whose first segment names an attached repository
 * resolves — that is the one case where the files a compose file asks for
 * genuinely exist in the task. Absolute paths, `~` and anything climbing out
 * with `..` are host paths by definition and have no sandbox equivalent; `.`
 * is ambiguous (the env directory for a template compose, the repository root
 * for a compose read out of a repo) so it is left to fail loudly rather than
 * guessed at.
 */
function resolveRepoBind(
  source: string,
  repoNames: string[]
): { repoName: string; workspacePath: string } | null {
  if (!source || source.startsWith("/") || source.startsWith("~")) return null;
  const rel = source.replace(/^\.\//, "").replace(/\/+$/, "");
  if (!rel || rel === "." || rel.startsWith("..")) return null;
  const segments = rel.split("/");
  if (segments.some((s) => s === "" || s === "." || s === "..")) return null;
  const repoName = segments[0];
  if (!repoNames.includes(repoName)) return null;
  return { repoName, workspacePath: segments.join("/") };
}

function parseVolumeEntry(
  v: unknown,
  named: Set<string>
):
  | { kind: "named"; source: string; target: string; readOnly: boolean }
  | { kind: "bind"; source: string; target: string; readOnly: boolean } {
  if (typeof v === "string") {
    const parts = v.split(":");
    if (parts.length === 1) {
      // Anonymous volume "path" — give it a stable name from the path.
      const target = parts[0];
      return {
        kind: "named",
        source: `anon-${target.replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-|-$/g, "")}`,
        target,
        readOnly: false,
      };
    }
    const [source, target, mode] = parts;
    // A bare `.` is a path, not a volume name — compose's own shorthand for
    // "the directory this file is in". Without it here it fell through to the
    // named-volume branch and became a task-scoped scratch volume called ".",
    // so a service asking for the project directory silently got an empty one.
    const isBind =
      source === "." ||
      source.startsWith("/") ||
      source.startsWith("./") ||
      source.startsWith("..") ||
      source.startsWith("~");
    if (isBind && !named.has(source)) {
      return { kind: "bind", source, target, readOnly: mode === "ro" };
    }
    return { kind: "named", source, target, readOnly: mode === "ro" };
  }
  if (isRecord(v)) {
    const type = typeof v.type === "string" ? v.type : "volume";
    const source = typeof v.source === "string" ? v.source : "";
    const target = typeof v.target === "string" ? v.target : "";
    if (type === "bind") {
      return { kind: "bind", source, target, readOnly: v.read_only === true };
    }
    return {
      kind: "named",
      source: source || "anon",
      target,
      readOnly: v.read_only === true,
    };
  }
  throw new ComposeTranslateError("Unparseable volume entry");
}

function readPorts(
  ports: unknown,
  expose: unknown,
  labels: unknown,
  service: string
): number[] {
  const out: number[] = [];
  const push = (n: number) => {
    if (Number.isInteger(n) && n > 0 && n < 65536 && !out.includes(n)) {
      out.push(n);
    }
  };
  // Traefik loadbalancer port label (injected by the subdomain rewriter) is
  // the authoritative routing target — read it FIRST so it stays primary.
  const labelEntries: string[] = Array.isArray(labels)
    ? labels.filter((l): l is string => typeof l === "string")
    : isRecord(labels)
      ? Object.entries(labels).map(([k, v]) => `${k}=${String(v)}`)
      : [];
  for (const entry of labelEntries) {
    const m = entry.match(
      /^traefik\.http\.services\.[^=]+\.loadbalancer\.server\.port=(\d+)$/
    );
    if (m) push(Number(m[1]));
  }
  if (Array.isArray(ports)) {
    for (const p of ports) {
      if (typeof p === "number") push(p);
      else if (typeof p === "string") {
        // "8080", "8080:80", "127.0.0.1:8080:80", with optional "/tcp"
        const clean = p.split("/")[0];
        const parts = clean.split(":");
        push(Number(parts[parts.length - 1]));
      } else if (isRecord(p) && p.target !== undefined) {
        push(Number(p.target));
      }
    }
  }
  if (Array.isArray(expose)) {
    for (const e of expose) push(Number(String(e).split("/")[0]));
  }
  if (ports !== undefined && !Array.isArray(ports)) {
    throw new ComposeTranslateError(
      `Service "${service}" has an invalid ports section`
    );
  }
  return out;
}

function normalizeCommandish(raw: unknown): string[] | null {
  if (raw === undefined || raw === null) return null;
  if (Array.isArray(raw)) return raw.map((x) => String(x));
  if (typeof raw === "string") return ["sh", "-c", raw];
  return null;
}

function parseDurationSec(raw: unknown): number | null {
  if (typeof raw === "number") return Math.round(raw);
  if (typeof raw !== "string") return null;
  const m = raw.match(/^(?:(\d+)m)?(?:(\d+(?:\.\d+)?)s)?(?:(\d+)ms)?$/);
  if (!m || (!m[1] && !m[2] && !m[3])) return null;
  const sec =
    Number(m[1] ?? 0) * 60 + Number(m[2] ?? 0) + Number(m[3] ?? 0) / 1000;
  return Math.max(1, Math.round(sec));
}

/**
 * ECS healthcheck limits. Compose has none, so a compose file written for
 * Docker can carry values ECS refuses outright (RegisterTaskDefinition fails
 * with "retries must be less than or equal to the maximum allowed value 10").
 */
const HEALTH_LIMITS = {
  interval: { min: 5, max: 300 },
  timeout: { min: 2, max: 120 },
  retries: { min: 1, max: 10 },
  startPeriod: { min: 0, max: 300 },
} as const;

function clamp(value: number, limit: { min: number; max: number }): number {
  return Math.min(limit.max, Math.max(limit.min, value));
}

function readHealthcheck(
  raw: unknown,
  service: string,
  notes: string[]
): {
  command: string[];
  interval?: number;
  timeout?: number;
  retries?: number;
  startPeriod?: number;
} | null {
  if (!isRecord(raw) || raw.disable === true) return null;
  const test = raw.test;
  let command: string[] | null = null;
  if (Array.isArray(test)) {
    // Compose and ECS share the ["CMD"|"CMD-SHELL", ...] format.
    command = test.map((x) => String(x));
  } else if (typeof test === "string") {
    command = ["CMD-SHELL", test];
  }
  if (!command || command.length === 0) return null;

  const rawInterval = parseDurationSec(raw.interval);
  const rawTimeout = parseDurationSec(raw.timeout);
  const rawStartPeriod = parseDurationSec(raw.start_period);
  const rawRetries =
    typeof raw.retries === "number" ? Math.round(raw.retries) : null;

  const interval = rawInterval ? clamp(rawInterval, HEALTH_LIMITS.interval) : null;
  const timeout = rawTimeout ? clamp(rawTimeout, HEALTH_LIMITS.timeout) : null;
  const retries = rawRetries ? clamp(rawRetries, HEALTH_LIMITS.retries) : null;
  let startPeriod = rawStartPeriod
    ? clamp(rawStartPeriod, HEALTH_LIMITS.startPeriod)
    : null;

  // Clamping retries alone would quietly shorten how long a service is given
  // to come up — and a container that is still installing dependencies when
  // its grace runs out is reported UNHEALTHY, which for an essential container
  // stops the task. So when retries are cut, buy the time back on the start
  // period, which is what it is for. (Capped at its own ECS maximum, so a
  // compose file asking for more than ECS can express still loses some.)
  if (rawRetries && retries && rawRetries > retries && interval) {
    const wanted = (rawStartPeriod ?? 0) + rawRetries * interval;
    const have = retries * interval;
    const compensated = clamp(wanted - have, HEALTH_LIMITS.startPeriod);
    if (compensated > (startPeriod ?? 0)) {
      startPeriod = compensated;
      notes.push(
        `service ${service}: healthcheck retries ${rawRetries} → ${retries} ` +
          `(ECS maximum); start_period raised to ${startPeriod}s to keep roughly ` +
          `the same ${wanted}s grace before the container counts as unhealthy`
      );
    }
  } else if (rawRetries && retries && rawRetries > retries) {
    notes.push(
      `service ${service}: healthcheck retries ${rawRetries} → ${retries} (ECS maximum)`
    );
  }
  if (rawInterval && interval && rawInterval !== interval) {
    notes.push(
      `service ${service}: healthcheck interval ${rawInterval}s → ${interval}s (ECS limit)`
    );
  }
  if (rawTimeout && timeout && rawTimeout !== timeout) {
    notes.push(
      `service ${service}: healthcheck timeout ${rawTimeout}s → ${timeout}s (ECS limit)`
    );
  }
  if (
    rawStartPeriod &&
    startPeriod === HEALTH_LIMITS.startPeriod.max &&
    rawStartPeriod > HEALTH_LIMITS.startPeriod.max
  ) {
    notes.push(
      `service ${service}: healthcheck start_period ${rawStartPeriod}s → ${startPeriod}s (ECS limit)`
    );
  }

  return {
    command,
    ...(interval ? { interval } : {}),
    ...(timeout ? { timeout } : {}),
    ...(retries ? { retries } : {}),
    ...(startPeriod ? { startPeriod } : {}),
  };
}

function readDependsOn(
  raw: unknown,
  serviceNames: string[],
  service: string
): { containerName: string; condition: "START" | "HEALTHY" | "SUCCESS" | "COMPLETE" }[] {
  const out: { containerName: string; condition: "START" | "HEALTHY" | "SUCCESS" | "COMPLETE" }[] =
    [];
  const add = (dep: string, condition: string | undefined) => {
    if (dep === service || !serviceNames.includes(dep)) return;
    // service_healthy maps to HEALTHY only when the dep has an ECS
    // healthcheck; the caller validated compose-level healthchecks map over,
    // so the translation is faithful. Everything else → START.
    out.push({
      containerName: dep,
      condition: condition === "service_healthy" ? "HEALTHY" : "START",
    });
  };
  if (Array.isArray(raw)) {
    for (const d of raw) if (typeof d === "string") add(d, undefined);
  } else if (isRecord(raw)) {
    for (const [dep, cfg] of Object.entries(raw)) {
      add(dep, isRecord(cfg) && typeof cfg.condition === "string" ? cfg.condition : undefined);
    }
  }
  return out;
}

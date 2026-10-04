import { stringify } from "yaml";
import {
  dependenciesOf,
  REF_RE,
  sizeToMiB,
  type EnvSpec,
  type RefField,
  type ServiceSpec,
} from "./env-spec";
import {
  SERVICE_PRESETS,
  type ResolvedCredentials,
} from "./service-presets";

/**
 * Compile an EnvSpec into a Compose file.
 *
 * Compose stays the runtime format — the local driver runs it directly and the
 * Fargate driver translates it — so compiling into it means the spec is purely
 * additive: nothing downstream changes. What changes is WHO writes the file.
 *
 * The target matters for exactly one thing, and it is the thing that has bitten
 * us twice: how one service addresses another. On the local target each service
 * is its own DNS name on the env network. In a Fargate task every container
 * shares one network namespace, so peers are on `127.0.0.1`. Today that
 * difference is patched afterwards by pattern-matching env VALUES, which is how
 * a database called `wordpress` once got renamed to `127.0.0.1`. Here the
 * compiler knows which values are hostnames because it is the one putting them
 * there, so the question never has to be guessed.
 */

export type CompileTarget = "local" | "fargate";

export type CompileOptions = {
  target: CompileTarget;
  /**
   * Supplies a stable secret for (service, purpose). Deterministic per env in
   * production, fixed in tests. Passing it in keeps this module pure.
   */
  secret: (service: string, purpose: string) => string;
};

export type CompileResult = {
  composeYaml: string;
  /** Service that owns the env's public URL, if any. */
  httpService: { name: string; port: number } | null;
  /** Credentials generated for managed engines, for display in the UI. */
  credentials: Record<string, ResolvedCredentials>;
  /** Human-readable notes about choices made, surfaced in the UI/logs. */
  notes: string[];
};

type ComposeService = {
  image: string;
  environment?: Record<string, string>;
  ports?: string[];
  volumes?: string[];
  command?: string | string[];
  depends_on?: string[];
  restart?: string;
  deploy?: { resources: { limits: { cpus?: string; memory?: string } } };
};

const DEFAULT_CPU = 0.5;
const DEFAULT_MEMORY = "512Mi";

export function compileToCompose(
  spec: EnvSpec,
  opts: CompileOptions
): CompileResult {
  const notes: string[] = [];
  const credentials: Record<string, ResolvedCredentials> = {};

  // Resolve managed-engine credentials first: a service's env can reference
  // another's password, so every credential must exist before interpolation.
  for (const [name, svc] of Object.entries(spec.services)) {
    if (!svc.type) continue;
    const preset = SERVICE_PRESETS[svc.type];
    if (!preset.hasCredentials) continue;
    credentials[name] = {
      user: svc.user ?? preset.defaultUser ?? "app",
      password: opts.secret(name, "password"),
      database: svc.database ?? preset.defaultDatabase ?? "app",
      rootPassword: opts.secret(name, "root-password"),
    };
  }

  const services: Record<string, ComposeService> = {};
  const volumes: Record<string, null> = {};
  let httpService: CompileResult["httpService"] = null;

  for (const [name, svc] of Object.entries(spec.services)) {
    const out: ComposeService = {
      image: imageFor(name, svc, notes),
      restart: "unless-stopped",
    };

    const env: Record<string, string> = {};
    // The engine's own credential variables come first so a user-supplied
    // value with the same key wins — they may be configuring a client, not
    // the server.
    if (svc.type) {
      const preset = SERVICE_PRESETS[svc.type];
      const creds = credentials[name];
      if (creds) Object.assign(env, preset.serverEnv(creds));
    }
    for (const [key, raw] of Object.entries(svc.env ?? {})) {
      env[key] = interpolateRefs(raw, spec, credentials, opts.target);
    }
    if (Object.keys(env).length > 0) out.environment = env;

    if (svc.command !== undefined) out.command = svc.command;

    // Ports. On local the subdomain rewriter turns these into Traefik routes;
    // on fargate the translator reads the container port. Either way the user
    // never writes a host port, so two envs can never collide on one.
    if (svc.http !== undefined) {
      out.ports = [String(svc.http)];
      httpService = { name, port: svc.http };
    }

    // Storage. A managed engine knows where its data lives; an image-based
    // service has no such convention, so we mount at /data and say so.
    if (svc.storage) {
      const volumeName = `${name}-data`;
      const path = svc.type ? SERVICE_PRESETS[svc.type].dataPath : "/data";
      out.volumes = [`${volumeName}:${path}`];
      volumes[volumeName] = null;
      if (!svc.type) {
        notes.push(
          `service "${name}": storage mounted at ${path} (no managed type to infer a data directory from)`
        );
      }
      if (opts.target === "fargate") {
        // Whether this actually persists depends on the client's AWS stack
        // having an EFS filesystem, which only the driver can see. It says so
        // precisely at start time; here we can only point at the dependency.
        notes.push(
          `service "${name}": ${svc.storage} of storage persists across stops when the AWS stack has EFS (deployed by the current infra template); on an older stack it is scratch space discarded with the task`
        );
      }
    }

    const deps = dependenciesOf(spec, name);
    if (deps.length > 0) out.depends_on = deps;

    // Limits are not optional here. The platform writes this file, so every
    // service gets a ceiling whether or not the author thought about it —
    // which is what stops one environment from starving its neighbours.
    const cpu = svc.cpu ?? DEFAULT_CPU;
    const memory = svc.memory ?? DEFAULT_MEMORY;
    out.deploy = {
      resources: { limits: { cpus: String(cpu), memory: toComposeSize(memory) } },
    };

    services[name] = out;
  }

  const doc: Record<string, unknown> = { services };
  if (Object.keys(volumes).length > 0) doc.volumes = volumes;

  // Task sizing for the Fargate translator, which reads this extension. Sum
  // the per-service limits and round up to a tier Fargate actually sells.
  if (opts.target === "fargate") {
    const totalCpu = Object.values(spec.services).reduce(
      (n, s) => n + (s.cpu ?? DEFAULT_CPU),
      0
    );
    const totalMiB = Object.values(spec.services).reduce(
      (n, s) => n + sizeToMiB(s.memory ?? DEFAULT_MEMORY),
      0
    );
    const { cpu, memory } = fargateTier(totalCpu, totalMiB);
    doc["x-withvibe"] = { cpu, memory };
    notes.push(
      `task sized ${cpu} CPU units / ${memory} MiB from the sum of service limits`
    );
  }

  return {
    composeYaml: stringify(doc, { lineWidth: 0 }),
    httpService,
    credentials,
    notes,
  };
}

function imageFor(
  name: string,
  svc: ServiceSpec,
  notes: string[]
): string {
  if (svc.image) return svc.image;
  const preset = SERVICE_PRESETS[svc.type!];
  const version = svc.version ?? preset.defaultVersion;
  if (!svc.version) {
    notes.push(`service "${name}": ${svc.type} version defaulted to ${version}`);
  }
  return preset.image(version);
}

/**
 * Replace `{{ service.field }}` with the value that field has on this target.
 * Unknown refs can't reach here — parseEnvSpec rejects them — so anything
 * unmatched is left verbatim rather than silently blanked.
 */
function interpolateRefs(
  value: string,
  spec: EnvSpec,
  credentials: Record<string, ResolvedCredentials>,
  target: CompileTarget
): string {
  return value.replace(REF_RE, (whole, service: string, field: string) => {
    const resolved = resolveRef(
      service,
      field as RefField,
      spec,
      credentials,
      target
    );
    return resolved ?? whole;
  });
}

function resolveRef(
  service: string,
  field: RefField,
  spec: EnvSpec,
  credentials: Record<string, ResolvedCredentials>,
  target: CompileTarget
): string | null {
  const svc = spec.services[service];
  if (!svc) return null;
  const preset = svc.type ? SERVICE_PRESETS[svc.type] : null;
  const creds = credentials[service];
  // One task, one network namespace: peers answer on loopback, not by name.
  const host = target === "fargate" ? "127.0.0.1" : service;
  const port = String(preset?.port ?? svc.http ?? 80);

  switch (field) {
    case "host":
      return host;
    case "port":
      return port;
    case "user":
      return creds?.user ?? "";
    case "password":
      return creds?.password ?? "";
    case "database":
      return creds?.database ?? "";
    case "url": {
      if (!preset) return `http://${host}:${port}`;
      if (!creds) return `${preset.urlScheme}://${host}:${port}`;
      return `${preset.urlScheme}://${creds.user}:${creds.password}@${host}:${port}/${creds.database}`;
    }
    default:
      return null;
  }
}

/** Compose wants "512m"/"2g"; the spec speaks Kubernetes-style sizes. */
function toComposeSize(size: string): string {
  return `${sizeToMiB(size)}m`;
}

/** Round a (cpu, memory) pair up to a combination Fargate accepts. */
function fargateTier(
  cpuUnitsRequested: number,
  memoryMiBRequested: number
): { cpu: number; memory: number } {
  const CPU_TIERS = [256, 512, 1024, 2048, 4096];
  // Fargate constrains memory by CPU tier; this is the documented matrix.
  const MEMORY_BY_CPU: Record<number, number[]> = {
    256: [512, 1024, 2048],
    512: [1024, 2048, 3072, 4096],
    1024: [2048, 3072, 4096, 5120, 6144, 7168, 8192],
    2048: [4096, 8192, 12288, 16384],
    4096: [8192, 16384, 30720],
  };
  const wantCpu = Math.ceil(cpuUnitsRequested * 1024);
  for (const cpu of CPU_TIERS) {
    if (cpu < wantCpu) continue;
    const memory = MEMORY_BY_CPU[cpu].find((m) => m >= memoryMiBRequested);
    if (memory !== undefined) return { cpu, memory };
  }
  return { cpu: 4096, memory: 30720 };
}

import { isPresetType, PRESET_TYPES, type PresetType } from "./service-presets";

/**
 * The environment spec: what a user declares, as opposed to the Compose file
 * or ECS task definition the platform generates from it.
 *
 * The vocabulary is deliberately closed. Every key here is one the platform
 * knows how to honor on BOTH compute targets, and anything absent is absent on
 * purpose — there is no slot for a host bind mount, a Traefik label, an
 * external network, or a raw `${VAR}` against the server's environment, so the
 * whole class of "tenant-authored Compose escapes the sandbox" simply cannot be
 * expressed. Validating a file somebody else wrote is a denylist you keep
 * losing; generating the file yourself is an allowlist by construction.
 *
 * Unknown keys are rejected rather than ignored: silently dropping a key the
 * user believed was doing something is how you get an environment that behaves
 * differently from what its author reads on screen.
 */

export type EnvSpec = {
  name?: string;
  services: Record<string, ServiceSpec>;
};

export type ServiceSpec = {
  /** Run this image. Mutually exclusive with `type`. */
  image?: string;
  /** Run a managed engine (postgres, redis, …). Mutually exclusive with `image`. */
  type?: PresetType;
  /** Tag for a managed engine; ignored for `image`. */
  version?: string;
  /** Container port to publish on the env's public URL. One per env. */
  http?: number;
  /** Environment variables. Values may contain `{{ service.field }}` refs. */
  env?: Record<string, string>;
  /** Persistent storage, e.g. "2Gi". Mounted at the engine's data path. */
  storage?: string;
  /** vCPU limit, e.g. 0.5. */
  cpu?: number;
  /** Memory limit, e.g. "512Mi". */
  memory?: string;
  /** Override the image's entrypoint command. */
  command?: string | string[];
  /** Logical database name for a managed engine. */
  database?: string;
  /** Username for a managed engine. */
  user?: string;
};

const SERVICE_KEYS = new Set([
  "image",
  "type",
  "version",
  "http",
  "env",
  "storage",
  "cpu",
  "memory",
  "command",
  "database",
  "user",
]);

const SPEC_KEYS = new Set(["name", "services"]);

/**
 * Compose service names become DNS labels on the env network: start with a
 * letter, end alphanumeric, 1-32 chars. The optional tail is what lets a
 * single-character name like `a` through.
 */
const SERVICE_NAME_RE = /^[a-z](?:[a-z0-9-]{0,30}[a-z0-9])?$/;

/** "512Mi", "2Gi", "1024M" — a number with a binary/decimal unit. */
const SIZE_RE = /^(\d+(?:\.\d+)?)(Mi|Gi|M|G)$/;

/** `{{ service.field }}` with tolerant inner whitespace. */
export const REF_RE = /\{\{\s*([a-z][a-z0-9-]*)\.([a-z]+)\s*\}\}/g;

/** Fields a service can expose to another service's env. */
export const REF_FIELDS = [
  "host",
  "port",
  "user",
  "password",
  "database",
  "url",
] as const;
export type RefField = (typeof REF_FIELDS)[number];

export class EnvSpecError extends Error {
  constructor(public readonly problems: string[]) {
    super(problems.join("; "));
    this.name = "EnvSpecError";
  }
}

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Validate an already-parsed spec object. Collects every problem rather than
 * throwing on the first, so a user fixing a spec sees the whole list at once.
 */
export function parseEnvSpec(input: unknown): EnvSpec {
  const problems: string[] = [];
  if (!isRec(input)) {
    throw new EnvSpecError(["spec must be an object"]);
  }
  for (const key of Object.keys(input)) {
    if (!SPEC_KEYS.has(key)) {
      problems.push(`unknown top-level key "${key}"`);
    }
  }
  if (input.name !== undefined && typeof input.name !== "string") {
    problems.push("name must be a string");
  }
  if (!isRec(input.services)) {
    throw new EnvSpecError([...problems, "services must be an object"]);
  }
  const serviceNames = Object.keys(input.services);
  if (serviceNames.length === 0) {
    problems.push("services must contain at least one service");
  }

  const services: Record<string, ServiceSpec> = {};
  let httpCount = 0;

  for (const name of serviceNames) {
    const at = `service "${name}"`;
    if (!SERVICE_NAME_RE.test(name)) {
      problems.push(
        `${at}: name must be lowercase letters, digits and dashes, starting with a letter`
      );
    }
    const raw = input.services[name];
    if (!isRec(raw)) {
      problems.push(`${at}: must be an object`);
      continue;
    }
    for (const key of Object.keys(raw)) {
      if (!SERVICE_KEYS.has(key)) {
        problems.push(
          `${at}: unknown key "${key}" (allowed: ${[...SERVICE_KEYS].sort().join(", ")})`
        );
      }
    }

    const svc: ServiceSpec = {};
    const hasImage = typeof raw.image === "string" && raw.image.trim() !== "";
    const hasType = raw.type !== undefined;

    if (hasImage && hasType) {
      problems.push(`${at}: set either "image" or "type", not both`);
    } else if (!hasImage && !hasType) {
      problems.push(`${at}: needs "image" or "type"`);
    }

    if (hasImage) svc.image = (raw.image as string).trim();
    if (hasType) {
      if (!isPresetType(raw.type)) {
        problems.push(
          `${at}: unknown type "${String(raw.type)}" (available: ${PRESET_TYPES.join(", ")})`
        );
      } else {
        svc.type = raw.type;
      }
    }

    if (raw.version !== undefined) {
      if (typeof raw.version !== "string" && typeof raw.version !== "number") {
        problems.push(`${at}: version must be a string`);
      } else {
        svc.version = String(raw.version);
      }
    }

    if (raw.http !== undefined) {
      if (
        typeof raw.http !== "number" ||
        !Number.isInteger(raw.http) ||
        raw.http < 1 ||
        raw.http > 65535
      ) {
        problems.push(`${at}: http must be a port number between 1 and 65535`);
      } else {
        svc.http = raw.http;
        httpCount++;
      }
    }

    if (raw.env !== undefined) {
      if (!isRec(raw.env)) {
        problems.push(`${at}: env must be an object`);
      } else {
        const env: Record<string, string> = {};
        for (const [k, v] of Object.entries(raw.env)) {
          if (typeof v !== "string" && typeof v !== "number") {
            problems.push(`${at}: env "${k}" must be a string or number`);
            continue;
          }
          env[k] = String(v);
        }
        svc.env = env;
      }
    }

    if (raw.storage !== undefined) {
      if (typeof raw.storage !== "string" || !SIZE_RE.test(raw.storage)) {
        problems.push(
          `${at}: storage must look like "2Gi" or "512Mi" (got ${JSON.stringify(raw.storage)})`
        );
      } else {
        svc.storage = raw.storage;
      }
    }

    if (raw.cpu !== undefined) {
      if (typeof raw.cpu !== "number" || !(raw.cpu > 0) || raw.cpu > 16) {
        problems.push(`${at}: cpu must be a number between 0 and 16`);
      } else {
        svc.cpu = raw.cpu;
      }
    }

    if (raw.memory !== undefined) {
      if (typeof raw.memory !== "string" || !SIZE_RE.test(raw.memory)) {
        problems.push(`${at}: memory must look like "512Mi" or "2Gi"`);
      } else {
        svc.memory = raw.memory;
      }
    }

    if (raw.command !== undefined) {
      if (typeof raw.command === "string") {
        svc.command = raw.command;
      } else if (
        Array.isArray(raw.command) &&
        raw.command.every((c) => typeof c === "string")
      ) {
        svc.command = raw.command as string[];
      } else {
        problems.push(`${at}: command must be a string or array of strings`);
      }
    }

    for (const field of ["database", "user"] as const) {
      if (raw[field] === undefined) continue;
      if (typeof raw[field] !== "string" || !(raw[field] as string).trim()) {
        problems.push(`${at}: ${field} must be a non-empty string`);
      } else {
        svc[field] = (raw[field] as string).trim();
      }
    }

    services[name] = svc;
  }

  if (httpCount > 1) {
    problems.push(
      `only one service may set "http" — found ${httpCount}. The env has a single public URL.`
    );
  }

  // Reference integrity. A typo'd service name must fail here rather than
  // reaching a container as a literal "{{ db.host }}" string.
  for (const [name, svc] of Object.entries(services)) {
    for (const [key, value] of Object.entries(svc.env ?? {})) {
      for (const ref of [...value.matchAll(REF_RE)]) {
        const [, target, field] = ref;
        if (!(target in services)) {
          problems.push(
            `service "${name}": env "${key}" references unknown service "${target}"`
          );
          continue;
        }
        if (!(REF_FIELDS as readonly string[]).includes(field)) {
          problems.push(
            `service "${name}": env "${key}" references unknown field "${field}" (available: ${REF_FIELDS.join(", ")})`
          );
          continue;
        }
        if (target === name) {
          problems.push(
            `service "${name}": env "${key}" references itself`
          );
        }
      }
    }
  }

  if (problems.length > 0) throw new EnvSpecError(problems);

  const spec: EnvSpec = { services };
  if (typeof input.name === "string") spec.name = input.name;
  return spec;
}

/** Services referenced by `name`'s env — i.e. what it must start after. */
export function dependenciesOf(
  spec: EnvSpec,
  name: string
): string[] {
  const svc = spec.services[name];
  const out = new Set<string>();
  for (const value of Object.values(svc?.env ?? {})) {
    for (const [, target] of value.matchAll(REF_RE)) {
      if (target !== name && target in spec.services) out.add(target);
    }
  }
  return [...out].sort();
}

/** Bytes for a "512Mi"/"2Gi" size, used for task sizing. */
export function sizeToMiB(size: string): number {
  const m = SIZE_RE.exec(size);
  if (!m) return 0;
  const n = Number(m[1]);
  switch (m[2]) {
    case "Gi":
      return Math.round(n * 1024);
    case "G":
      return Math.round((n * 1000 * 1000 * 1000) / (1024 * 1024));
    case "M":
      return Math.round((n * 1000 * 1000) / (1024 * 1024));
    default:
      return Math.round(n);
  }
}

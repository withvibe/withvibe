import { readFile } from "fs/promises";
import { parse as parseYaml } from "yaml";

export type DbEngine = "postgres" | "mysql";

export type DetectedDatabase = {
  service: string;
  engine: DbEngine;
  internalPort: number;
  publishedPort: number | null;
  user: string;
  password: string;
  database: string;
};

type ComposeService = {
  image?: string;
  environment?: Record<string, unknown> | string[];
  ports?: Array<string | number | { published?: number | string; target?: number | string }>;
};

type ComposeFile = {
  services?: Record<string, ComposeService>;
};

// Matches the family in the image reference. Registry prefix and tag are stripped first.
// postgres images: postgres, postgresql, pgvector/pgvector, timescale/timescaledb, supabase/postgres, bitnami/postgresql
// mysql images: mysql, mariadb, bitnami/mysql, bitnami/mariadb, percona
const POSTGRES_IMAGE_RE = /(^|\/)(postgres(ql)?|timescaledb|pgvector)(\b|$)/i;
const MYSQL_IMAGE_RE = /(^|\/)(mysql|mariadb|percona)(\b|$)/i;

const DEFAULT_PORTS: Record<DbEngine, number> = { postgres: 5432, mysql: 3306 };

function classifyImage(image: string | undefined): DbEngine | null {
  if (!image) return null;
  const repo = image.split(":")[0];
  if (POSTGRES_IMAGE_RE.test(repo)) return "postgres";
  if (MYSQL_IMAGE_RE.test(repo)) return "mysql";
  return null;
}

function normalizeEnv(env: ComposeService["environment"]): Record<string, string> {
  const out: Record<string, string> = {};
  if (!env) return out;
  if (Array.isArray(env)) {
    for (const entry of env) {
      if (typeof entry !== "string") continue;
      const eq = entry.indexOf("=");
      if (eq === -1) continue;
      out[entry.slice(0, eq)] = entry.slice(eq + 1);
    }
    return out;
  }
  for (const [k, v] of Object.entries(env)) {
    if (v == null) continue;
    out[k] = String(v);
  }
  return out;
}

// Picks the host-published port bound to the engine's default internal port.
// Returns null if no host mapping exists (DB only reachable inside the compose network).
function findPublishedPort(
  ports: ComposeService["ports"],
  internalPort: number
): number | null {
  if (!ports) return null;
  for (const p of ports) {
    if (typeof p === "number") {
      if (p === internalPort) return p;
      continue;
    }
    if (typeof p === "string") {
      // Formats: "5432", "5433:5432", "127.0.0.1:5433:5432", "5433:5432/tcp"
      const clean = p.split("/")[0];
      const parts = clean.split(":");
      const target = Number(parts[parts.length - 1]);
      const published = Number(parts.length > 1 ? parts[parts.length - 2] : parts[0]);
      if (target === internalPort && Number.isFinite(published)) return published;
      continue;
    }
    if (p && typeof p === "object") {
      const target = Number(p.target);
      const published = Number(p.published);
      if (target === internalPort && Number.isFinite(published)) return published;
    }
  }
  return null;
}

function buildPostgres(service: string, env: Record<string, string>, ports: ComposeService["ports"]): DetectedDatabase {
  const user = env.POSTGRES_USER || "postgres";
  // POSTGRES_DB defaults to POSTGRES_USER per the official image.
  const database = env.POSTGRES_DB || user;
  const password = env.POSTGRES_PASSWORD || "";
  const internalPort = DEFAULT_PORTS.postgres;
  return {
    service,
    engine: "postgres",
    internalPort,
    publishedPort: findPublishedPort(ports, internalPort),
    user,
    password,
    database,
  };
}

function buildMysql(service: string, env: Record<string, string>, ports: ComposeService["ports"]): DetectedDatabase {
  // MySQL/MariaDB: MYSQL_USER + MYSQL_PASSWORD create an additional user; if absent, root is the only login.
  // Prefer the non-root user when provided since root often isn't allowed over TCP.
  const hasAppUser = Boolean(env.MYSQL_USER || env.MARIADB_USER);
  const user = hasAppUser ? env.MYSQL_USER || env.MARIADB_USER || "root" : "root";
  const password = hasAppUser
    ? env.MYSQL_PASSWORD || env.MARIADB_PASSWORD || ""
    : env.MYSQL_ROOT_PASSWORD || env.MARIADB_ROOT_PASSWORD || "";
  const database = env.MYSQL_DATABASE || env.MARIADB_DATABASE || "";
  const internalPort = DEFAULT_PORTS.mysql;
  return {
    service,
    engine: "mysql",
    internalPort,
    publishedPort: findPublishedPort(ports, internalPort),
    user,
    password,
    database,
  };
}

export function detectDatabasesFromCompose(yamlSource: string): DetectedDatabase[] {
  let parsed: unknown;
  try {
    parsed = parseYaml(yamlSource);
  } catch {
    return [];
  }
  const services = (parsed as ComposeFile)?.services;
  if (!services || typeof services !== "object") return [];

  const detected: DetectedDatabase[] = [];
  for (const [name, svc] of Object.entries(services)) {
    if (!svc || typeof svc !== "object") continue;
    const engine = classifyImage(svc.image);
    if (!engine) continue;
    const env = normalizeEnv(svc.environment);
    detected.push(
      engine === "postgres" ? buildPostgres(name, env, svc.ports) : buildMysql(name, env, svc.ports)
    );
  }
  return detected;
}

export async function detectDatabasesFromFile(composePath: string): Promise<DetectedDatabase[]> {
  try {
    const source = await readFile(composePath, "utf-8");
    return detectDatabasesFromCompose(source);
  } catch {
    return [];
  }
}

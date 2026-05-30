import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import * as crypto from "node:crypto";
import { Client as PgClient } from "pg";
import { apiInContainer } from "../docker/sidecar-net";

const PLUGIN_DB_NAME = "withvibe_plugins";

/**
 * Provisions per-plugin postgres roles + schemas inside a dedicated
 * `withvibe_plugins` database. The plugin role can ONLY connect to that
 * database; the main `withvibe` app DB is off-limits at the connection
 * level, so a compromised plugin running arbitrary SQL still can't reach
 * User / Workspace / Env data.
 *
 * Security boundary (in order of strength):
 *   1. `REVOKE CONNECT ON DATABASE withvibe FROM PUBLIC` — applied at
 *      bootstrap. Plugin roles inherit no CONNECT privilege on the main
 *      DB; postgres refuses the connection before any query runs.
 *   2. Per-plugin role with `NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT`.
 *      Can't escalate, can't create siblings, can't bypass GRANT/REVOKE.
 *   3. Per-plugin schema owned by the plugin role; only USAGE on its own
 *      schema. `search_path` locked to that schema.
 *   4. Encrypted password at rest (AES-256-GCM with a key derived from
 *      INTERNAL_JWT_SECRET).
 */
@Injectable()
export class PluginPostgresService implements OnApplicationBootstrap {
  private readonly logger = new Logger(PluginPostgresService.name);

  private readonly host: string;
  private readonly port: number;
  private readonly adminUser: string;
  private readonly adminPassword: string;
  private readonly mainDb: string;
  // What plugin containers see when they dial out to postgres. Differs
  // from `this.host` because the api may run on the host while plugin
  // containers run, well, containerized.
  private readonly pluginContainerHost: string;
  private readonly pluginContainerPort: number;

  private readonly encryptionKey: Buffer;

  constructor(config: ConfigService) {
    const url = config.get<string>("DATABASE_URL");
    if (!url) {
      throw new Error(
        "DATABASE_URL is not set — required for PluginPostgresService"
      );
    }
    const parsed = new URL(url);
    this.host = parsed.hostname;
    this.port = parsed.port ? Number(parsed.port) : 5432;
    this.adminUser = decodeURIComponent(parsed.username);
    this.adminPassword = decodeURIComponent(parsed.password);
    this.mainDb = parsed.pathname.replace(/^\//, "") || "withvibe";

    // Plugin container's view of postgres. Override via env when the
    // auto-detect default is wrong (uncommon).
    const overrideHost = config.get<string>("WITHVIBE_PLUGIN_DB_HOST");
    const overridePort = config.get<string>("WITHVIBE_PLUGIN_DB_PORT");
    this.pluginContainerHost =
      overrideHost ||
      (this.host === "localhost" || this.host === "127.0.0.1"
        ? "host.docker.internal"
        : this.host);
    this.pluginContainerPort = overridePort
      ? Number(overridePort)
      : this.port;

    // AES-256-GCM key derived from INTERNAL_JWT_SECRET. Sharing the same
    // secret source as session JWTs is fine: leaking either is equally bad
    // for the deployment, and we avoid introducing a second key-management
    // surface.
    const internalSecret = config.get<string>("INTERNAL_JWT_SECRET");
    if (!internalSecret) {
      throw new Error(
        "INTERNAL_JWT_SECRET is not set — required for plugin credential encryption"
      );
    }
    this.encryptionKey = crypto
      .createHash("sha256")
      .update(`${internalSecret}|plugin-storage-v1`)
      .digest();
  }

  async onApplicationBootstrap(): Promise<void> {
    try {
      await this.ensurePluginDatabase();
      await this.lockDownMainDatabase();
    } catch (err) {
      // Boot-time failures here shouldn't take the whole api down. Plugins
      // that don't use shared-postgres storage keep working; ones that do
      // will surface clean errors at install/start time.
      this.logger.warn(
        `Plugin postgres bootstrap failed (shared-postgres storage will be unavailable): ${
          err instanceof Error ? err.message : String(err)
        }`
      );
    }
  }

  /**
   * Provision a fresh role + schema for a plugin instance. Idempotent:
   * existing roles get their password rotated; existing schemas are kept
   * (re-creating would lose the plugin's data on re-installs).
   */
  async provisionStorage(args: {
    pluginId: string;
    scopeKey: string;
  }): Promise<{ role: string; schema: string; password: string }> {
    const ident = sanitizeIdent(`plg_${args.pluginId}_${args.scopeKey}`);
    const role = ident;
    const schema = ident;
    const password = crypto.randomBytes(24).toString("base64url");
    const escapedPassword = password.replace(/'/g, "''");

    await this.withAdminClient(PLUGIN_DB_NAME, async (client) => {
      const { rows } = await client.query(
        "SELECT 1 FROM pg_roles WHERE rolname = $1",
        [role]
      );
      if (rows.length === 0) {
        await client.query(
          `CREATE ROLE ${qIdent(role)} LOGIN PASSWORD '${escapedPassword}' ` +
            `NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT CONNECTION LIMIT 10`
        );
      } else {
        await client.query(
          `ALTER ROLE ${qIdent(role)} WITH LOGIN PASSWORD '${escapedPassword}'`
        );
      }

      // Defensive: ensure no CONNECT inherited via per-role grant on the
      // main DB. (PUBLIC revoke happens in lockDownMainDatabase.)
      await client.query(
        `REVOKE CONNECT ON DATABASE ${qIdent(this.mainDb)} FROM ${qIdent(role)}`
      );
      await client.query(
        `GRANT CONNECT ON DATABASE ${qIdent(PLUGIN_DB_NAME)} TO ${qIdent(role)}`
      );

      await client.query(
        `CREATE SCHEMA IF NOT EXISTS ${qIdent(schema)} AUTHORIZATION ${qIdent(role)}`
      );
      // Belt + suspenders: no access to the public schema in this DB.
      await client.query(
        `REVOKE ALL ON SCHEMA public FROM ${qIdent(role)}`
      );
      // Lock search_path so the plugin can only see its own schema.
      await client.query(
        `ALTER ROLE ${qIdent(role)} SET search_path TO ${qIdent(schema)}`
      );
      // Resource caps to limit blast radius of a runaway plugin.
      await client.query(
        `ALTER ROLE ${qIdent(role)} SET statement_timeout = '60s'`
      );
    });

    this.logger.log(`Provisioned plugin storage: role=${role} schema=${schema}`);
    return { role, schema, password };
  }

  /**
   * Drop the schema + role. Called on plugin uninstall and on scope-instance
   * teardown (workspace delete, env delete). Best-effort: NOT failing on
   * already-gone objects so re-runs are safe.
   */
  async dropStorage(role: string, schema: string): Promise<void> {
    await this.withAdminClient(PLUGIN_DB_NAME, async (client) => {
      await client
        .query(`DROP SCHEMA IF EXISTS ${qIdent(schema)} CASCADE`)
        .catch((err) =>
          this.logger.warn(`DROP SCHEMA ${schema} failed: ${err.message}`)
        );
      // Reassign any leftover objects (e.g. ones the role created outside
      // its schema by accident) before dropping the role itself.
      await client
        .query(
          `REASSIGN OWNED BY ${qIdent(role)} TO ${qIdent(this.adminUser)}`
        )
        .catch(() => {});
      await client
        .query(`DROP OWNED BY ${qIdent(role)} CASCADE`)
        .catch(() => {});
      await client
        .query(`DROP ROLE IF EXISTS ${qIdent(role)}`)
        .catch((err) =>
          this.logger.warn(`DROP ROLE ${role} failed: ${err.message}`)
        );
    });
    this.logger.log(`Dropped plugin storage: role=${role} schema=${schema}`);
  }

  /** DATABASE_URL injected into the plugin container at spawn time. */
  buildDatabaseUrl(role: string, password: string, schema: string): string {
    const u = encodeURIComponent;
    return `postgres://${u(role)}:${u(password)}@${this.pluginContainerHost}:${this.pluginContainerPort}/${PLUGIN_DB_NAME}?schema=${u(schema)}`;
  }

  encrypt(plaintext: string): string {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv(
      "aes-256-gcm",
      this.encryptionKey,
      iv
    );
    const encrypted = Buffer.concat([
      cipher.update(plaintext, "utf8"),
      cipher.final(),
    ]);
    const tag = cipher.getAuthTag();
    return Buffer.concat([iv, tag, encrypted]).toString("base64");
  }

  decrypt(ciphertext: string): string {
    const buf = Buffer.from(ciphertext, "base64");
    const iv = buf.subarray(0, 12);
    const tag = buf.subarray(12, 28);
    const data = buf.subarray(28);
    const decipher = crypto.createDecipheriv(
      "aes-256-gcm",
      this.encryptionKey,
      iv
    );
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(data), decipher.final()]).toString(
      "utf8"
    );
  }

  // ── internals ──────────────────────────────────────────────────────────

  private async ensurePluginDatabase(): Promise<void> {
    // Connect to the maintenance DB (always called `postgres`) so we can
    // CREATE DATABASE — CREATE DATABASE can't run inside a transaction
    // or while connected to the target.
    await this.withAdminClient("postgres", async (client) => {
      const { rows } = await client.query(
        "SELECT 1 FROM pg_database WHERE datname = $1",
        [PLUGIN_DB_NAME]
      );
      if (rows.length === 0) {
        await client.query(`CREATE DATABASE ${qIdent(PLUGIN_DB_NAME)}`);
        this.logger.log(`Created plugin database "${PLUGIN_DB_NAME}"`);
      }
    });
  }

  /**
   * Revoke CONNECT on the main DB from PUBLIC so plugin roles (which only
   * inherit PUBLIC by default) can't connect. Grant CONNECT explicitly to
   * the app's own user. Skipped silently if the api role isn't a superuser
   * (operators with a least-privilege app role must do this once in their
   * deploy scripts).
   */
  private async lockDownMainDatabase(): Promise<void> {
    await this.withAdminClient("postgres", async (client) => {
      const { rows } = await client.query<{ usesuper: boolean }>(
        "SELECT usesuper FROM pg_user WHERE usename = current_user"
      );
      if (!rows[0]?.usesuper) {
        this.logger.warn(
          `Configured DATABASE_URL user is not a superuser — skipping ` +
            `REVOKE CONNECT FROM PUBLIC on ${this.mainDb}. Operator must ` +
            `run this once: REVOKE CONNECT ON DATABASE ${this.mainDb} FROM PUBLIC; ` +
            `GRANT CONNECT ON DATABASE ${this.mainDb} TO ${this.adminUser};`
        );
        return;
      }
      await client.query(
        `REVOKE CONNECT ON DATABASE ${qIdent(this.mainDb)} FROM PUBLIC`
      );
      await client.query(
        `GRANT CONNECT ON DATABASE ${qIdent(this.mainDb)} TO ${qIdent(this.adminUser)}`
      );
      this.logger.log(
        `Locked CONNECT on database "${this.mainDb}" to ${this.adminUser} only`
      );
    });
  }

  private async withAdminClient<T>(
    database: string,
    fn: (client: PgClient) => Promise<T>
  ): Promise<T> {
    const client = new PgClient({
      host: this.host,
      port: this.port,
      user: this.adminUser,
      password: this.adminPassword,
      database,
    });
    await client.connect();
    try {
      return await fn(client);
    } finally {
      await client.end().catch(() => {});
    }
  }
}

/** Postgres identifier quote. Always wraps in `"..."`; doubles embedded quotes. */
function qIdent(s: string): string {
  return `"${s.replace(/"/g, '""')}"`;
}

/**
 * Sanitize a logical name into a postgres identifier. Lowercase, alphanum +
 * underscore only, truncated to fit in postgres's 63-byte identifier limit
 * after the `plg_` prefix.
 */
function sanitizeIdent(s: string): string {
  const lower = s.toLowerCase().replace(/[^a-z0-9]+/g, "_");
  const trimmed = lower.replace(/^_+|_+$/g, "").slice(0, 60);
  return trimmed || "plg_unnamed";
}

// Re-export for callers that want to detect runtime context.
export { apiInContainer };

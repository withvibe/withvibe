/**
 * Catalog of managed service types — the "Add Postgres" button's worth of
 * knowledge, in one table.
 *
 * A preset is what lets `type: postgres` mean something: which image to run,
 * which port it listens on, where its data lives, and which environment
 * variables it expects its credentials in. Users never type any of that, which
 * is the whole point — and because the platform writes those values, it can
 * also generate the passwords instead of asking a human to invent one and
 * paste it into a template in plaintext.
 */

export type PresetType = "postgres" | "mysql" | "mariadb" | "redis" | "mongo";

export type ServicePreset = {
  /** Image repository; the spec's `version` picks the tag. */
  image: (version: string) => string;
  defaultVersion: string;
  port: number;
  /** Where the engine keeps its data — mounted when `storage` is set. */
  dataPath: string;
  /** Whether this engine has a username/password/database at all. */
  hasCredentials: boolean;
  /** Default logical database name when the spec doesn't pick one. */
  defaultDatabase?: string;
  /** Default user name when the spec doesn't pick one. */
  defaultUser?: string;
  /**
   * Environment the engine container itself needs to come up with those
   * credentials. Written by the compiler, never by the user.
   */
  serverEnv: (creds: ResolvedCredentials) => Record<string, string>;
  /** URL scheme for `{{ svc.url }}`. */
  urlScheme: string;
};

export type ResolvedCredentials = {
  user: string;
  password: string;
  database: string;
  rootPassword: string;
};

export const SERVICE_PRESETS: Record<PresetType, ServicePreset> = {
  postgres: {
    image: (v) => `postgres:${v}-alpine`,
    defaultVersion: "17",
    port: 5432,
    dataPath: "/var/lib/postgresql/data",
    hasCredentials: true,
    defaultDatabase: "app",
    defaultUser: "app",
    urlScheme: "postgresql",
    serverEnv: (c) => ({
      POSTGRES_USER: c.user,
      POSTGRES_PASSWORD: c.password,
      POSTGRES_DB: c.database,
    }),
  },
  mysql: {
    image: (v) => `mysql:${v}`,
    defaultVersion: "8",
    port: 3306,
    dataPath: "/var/lib/mysql",
    hasCredentials: true,
    defaultDatabase: "app",
    defaultUser: "app",
    urlScheme: "mysql",
    serverEnv: (c) => ({
      MYSQL_DATABASE: c.database,
      MYSQL_USER: c.user,
      MYSQL_PASSWORD: c.password,
      MYSQL_ROOT_PASSWORD: c.rootPassword,
    }),
  },
  mariadb: {
    image: (v) => `mariadb:${v}`,
    defaultVersion: "11",
    port: 3306,
    dataPath: "/var/lib/mysql",
    hasCredentials: true,
    defaultDatabase: "app",
    defaultUser: "app",
    urlScheme: "mysql",
    serverEnv: (c) => ({
      MARIADB_DATABASE: c.database,
      MARIADB_USER: c.user,
      MARIADB_PASSWORD: c.password,
      MARIADB_ROOT_PASSWORD: c.rootPassword,
    }),
  },
  redis: {
    image: (v) => `redis:${v}-alpine`,
    defaultVersion: "7",
    port: 6379,
    dataPath: "/data",
    hasCredentials: false,
    urlScheme: "redis",
    serverEnv: () => ({}),
  },
  mongo: {
    image: (v) => `mongo:${v}`,
    defaultVersion: "7",
    port: 27017,
    dataPath: "/data/db",
    hasCredentials: true,
    defaultDatabase: "app",
    defaultUser: "app",
    urlScheme: "mongodb",
    serverEnv: (c) => ({
      MONGO_INITDB_ROOT_USERNAME: c.user,
      MONGO_INITDB_ROOT_PASSWORD: c.password,
      MONGO_INITDB_DATABASE: c.database,
    }),
  },
};

export const PRESET_TYPES = Object.keys(SERVICE_PRESETS) as PresetType[];

export function isPresetType(v: unknown): v is PresetType {
  return typeof v === "string" && v in SERVICE_PRESETS;
}

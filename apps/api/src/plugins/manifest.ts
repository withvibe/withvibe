import { z } from "zod";

// Plugin scope — controls how many containers exist and who shares state.
//   env       — one container per (env, plugin). Isolated, env-bound.
//   workspace — one container per (workspace, plugin). Shared across envs
//               in the workspace. Right call for task boards, team notes.
//   global    — one container per plugin, shared across the deployment.
//               Operator dashboards, status pages, etc.
// Scope drives container uniqueness, lifecycle, networking, and which
// users can reach the plugin's UI.
export const PluginScope = z.enum(["env", "workspace", "global"]);
export type PluginScopeT = z.infer<typeof PluginScope>;

// Plugin storage backend.
//   none             — plugin handles its own persistence (or is stateless).
//   shared-postgres  — platform provisions a dedicated postgres role +
//                      schema in the `withvibe_plugins` database and
//                      injects DATABASE_URL. Role can ONLY connect to
//                      withvibe_plugins; the withvibe app DB is off-limits
//                      at the connection level.
//   embedded-volume  — (future) named docker volume mounted at /data.
export const PluginStorage = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("none") }),
  z.object({ kind: z.literal("shared-postgres") }),
  z.object({ kind: z.literal("embedded-volume") }),
]);
export type PluginStorageT = z.infer<typeof PluginStorage>;

// PluginManifest — the declarative contract a developer writes for their
// plugin. Validated on install (Phase 2 admin UI) and re-validated on every
// boot when reading PluginDefinition.manifest back from Prisma — fields
// here are effectively a long-term API, so add new ones conservatively.
export const PluginManifest = z.object({
  // Reverse-DNS-ish identifier; ends up in URLs and Docker labels, so
  // restrict to lowercase alnum + dot + dash, no leading/trailing punct.
  id: z
    .string()
    .min(3)
    .max(120)
    .regex(/^[a-z0-9][a-z0-9.-]*[a-z0-9]$/),
  name: z.string().min(1).max(120),
  version: z.string().min(1).max(40),
  // Lucide icon name (e.g. "list-todo", "database"). Unknown / missing
  // values fall back to the generic puzzle-piece icon on the web side.
  icon: z.string().min(1).max(40).optional(),
  // OCI image ref. Docker caches locally after the first pull.
  image: z.string().min(1).max(300),
  launch: z.object({
    port: z.number().int().positive().max(65535),
    healthPath: z.string().min(1).default("/"),
    // Static env vars injected at spawn. Values may contain {{TEMPLATE}}
    // tokens filled in by PluginsService.start (ENV_ID, WORKSPACE_ID).
    // Unknown tokens pass through unsubstituted so typos are visible.
    env: z.record(z.string(), z.string()).default({}),
  }),
  ui: z.object({
    iframePath: z.string().min(1).default("/"),
    needsWebsocket: z.boolean().default(false),
  }),
  // Optional MCP integration. When enabled, the platform forwards
  // /api/mcp/plugin_<id> from the agent runner to <plugin>:<port><endpoint>
  // so the AI in env chat picks up the plugin's tools automatically. Tools
  // are visible only while the plugin's scope-appropriate instance is
  // running (env-scoped: this env; workspace-scoped: this workspace;
  // global: always once started).
  mcp: z
    .object({
      enabled: z.boolean().default(false),
      endpoint: z.string().min(1).default("/mcp"),
    })
    .default({ enabled: false, endpoint: "/mcp" }),
  // Reserved for Phase 4 hardening. Today plugins inherit the user's
  // session at the proxy; declared permissions aren't yet narrowed.
  permissions: z.array(z.string()).default([]),
  // Scope + storage default to single-env, stateless — matches Phase 1's
  // semantics so existing manifests don't need editing.
  scope: PluginScope.default("env"),
  storage: PluginStorage.default({ kind: "none" }),
  // Per-env enable toggle default. When true, the plugin shows up in every
  // env's sidebar automatically; users can disable per-env via the sidebar
  // gear. When false, plugins are installed but hidden until each env opts
  // in. Stored on PluginDefinition and copied as the fallback for envs that
  // have no explicit EnvPluginPreference row.
  defaultEnabledInEnv: z.boolean().default(true),
});

export type PluginManifestT = z.infer<typeof PluginManifest>;

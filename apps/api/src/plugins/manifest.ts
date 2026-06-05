import { z } from "zod";

// Plugin scope — controls how many containers exist and who shares state.
//   env       — one container per (env, plugin). Isolated, env-bound.
//   workspace — one container per (workspace, plugin). Shared across envs
//               in the workspace. Right call for task boards, team notes.
//   global    — one container per plugin, shared across the deployment.
//               Operator dashboards, status pages, etc.
export const PluginScope = z.enum(["env", "workspace", "global"]);
export type PluginScopeT = z.infer<typeof PluginScope>;

// Plugin storage backend.
//   none             — plugin handles its own persistence (or is stateless).
//   shared-postgres  — platform provisions a dedicated postgres role +
//                      schema in the `withvibe_plugins` database and
//                      injects DATABASE_URL + PGSCHEMA. Role can ONLY
//                      connect to withvibe_plugins; the withvibe app DB
//                      is off-limits at the connection level.
//   embedded-volume  — (future) named docker volume mounted at /data.
export const PluginStorage = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("none") }),
  z.object({ kind: z.literal("shared-postgres") }),
  z.object({ kind: z.literal("embedded-volume") }),
]);
export type PluginStorageT = z.infer<typeof PluginStorage>;

// PluginManifest — the declarative contract a developer writes for their
// plugin. The manifest describes WHAT the plugin is, not HOW the platform
// runs it: ports, health paths, env injection, and per-env defaults are
// either conventions (port 8080, GET / for health, ENV_ID/WORKSPACE_ID/
// DATABASE_URL always injected) or deployer-side settings (per-env enable
// is admin-controlled). Validated on install + re-validated on every boot.
//
// CONVENTIONS the runtime enforces (no manifest field):
//   - HTTP server listens on port 8080
//   - Health probe is `GET /` returning a non-5xx status within 15s
//     (a redirect to /ui is fine — fetch follows it)
//   - System always injects ENV_ID and WORKSPACE_ID
//   - System injects DATABASE_URL + PGSCHEMA when storage.kind = shared-postgres
export const PluginManifest = z.object({
  // Reverse-DNS-ish identifier; ends up in URLs and Docker labels, so
  // restrict to lowercase alnum + dot + dash, no leading/trailing punct.
  id: z
    .string()
    .min(3)
    .max(120)
    .regex(/^[a-z0-9][a-z0-9.-]*[a-z0-9]$/),
  name: z.string().min(1).max(120),
  description: z.string().min(1).max(500),
  version: z.string().min(1).max(40),
  // Lucide icon name (e.g. "list-todo", "database"). Unknown / missing
  // values fall back to the generic puzzle-piece icon on the web side.
  icon: z.string().min(1).max(40).optional(),
  // OCI image ref. Docker caches locally after the first pull.
  image: z.string().min(1).max(300),
  // Scope + storage default to single-env, stateless.
  scope: PluginScope.default("env"),
  storage: PluginStorage.default({ kind: "none" }),
  // UI integration. `path` is where the iframe loads inside the container
  // (most plugins serve their UI at /ui to keep it off the API root).
  // `websocket: true` tells the proxy to handle WS upgrades.
  ui: z
    .object({
      path: z.string().min(1).default("/"),
      websocket: z.boolean().default(false),
    })
    .default({ path: "/", websocket: false }),
  // Optional MCP integration. When enabled, the platform forwards
  // /api/mcp/plugin_<id> from the agent runner to <plugin>:8080<path>
  // so the AI in env chat picks up the plugin's tools automatically.
  mcp: z
    .object({
      enabled: z.boolean().default(false),
      path: z.string().min(1).default("/mcp"),
    })
    .default({ enabled: false, path: "/mcp" }),
  // Optional guidance injected into the env-chat agent's system prompt whenever
  // this plugin is enabled in the env. Use it to tell the agent WHAT the plugin
  // is and WHEN to use its tools — otherwise the agent sees the MCP tools but
  // doesn't know the rules around them (e.g. "open a team vote before changing
  // the project"). Kept short; it's prepended verbatim to the system prompt.
  agentInstructions: z.string().max(2000).optional(),
});

export type PluginManifestT = z.infer<typeof PluginManifest>;

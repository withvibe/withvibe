import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { execFile } from "child_process";
import { promisify } from "util";
import { InjectPinoLogger, PinoLogger } from "nestjs-pino";
import { parse as parseYaml } from "yaml";
import { ZodError } from "zod";
import { PrismaService } from "../prisma/prisma.service";
import { composeProjectName } from "../docker/compose-naming";
import {
  attachToWithvibe,
  resolveSidecarTarget,
} from "../docker/sidecar-net";
import { SidecarProxy } from "../docker/sidecar-proxy";
import {
  PluginManifest,
  type PluginManifestT,
  type PluginScopeT,
} from "./manifest";
import { PluginPostgresService } from "./plugin-postgres.service";

const exec = promisify(execFile);

export type SpawnContext = {
  ENV_ID: string;
  WORKSPACE_ID: string;
};

export type PluginViewRow = {
  id: string;
  name: string;
  icon: string | null;
  scope: PluginScopeT;
  status: string;
  error: string | null;
  viewerUrl: string | null;
  enabled: boolean;
};

export type EnvPluginPrefRow = {
  id: string;
  name: string;
  icon: string | null;
  scope: PluginScopeT;
  enabled: boolean;
};

export type PluginAdminRow = {
  id: string;
  name: string;
  version: string;
  image: string;
  icon: string | null;
  enabled: boolean;
  defaultEnabledInEnv: boolean;
  installedAt: Date;
  installedBy: string | null;
  manifest: PluginManifestT;
  runningInstances: number;
};

type StartResult =
  | { ok: true; status: string; viewerUrl: string | null }
  | { ok: false; error: string };

type ScopeIdentity =
  | { kind: "env"; envId: string }
  | { kind: "workspace"; workspaceId: string }
  | { kind: "global" };

/**
 * Runtime for installed plugins. Scope-aware: a plugin's manifest declares
 * env/workspace/global scope, and the runtime keys its container + storage
 * by that scope so workspace-shared plugins (task boards, team tools) run
 * once per workspace rather than once per env. Storage is similarly
 * scope-keyed when shared-postgres is requested.
 */
@Injectable()
export class PluginsService {
  constructor(
    @InjectPinoLogger(PluginsService.name)
    private readonly logger: PinoLogger,
    private readonly prisma: PrismaService,
    private readonly sidecarProxy: SidecarProxy,
    private readonly postgres: PluginPostgresService
  ) {}

  parseManifest(raw: unknown): PluginManifestT {
    return PluginManifest.parse(raw);
  }

  // ── scope helpers ──────────────────────────────────────────────────────

  private computeScopeKey(identity: ScopeIdentity): string {
    switch (identity.kind) {
      case "env":
        return `env:${identity.envId}`;
      case "workspace":
        return `ws:${identity.workspaceId}`;
      case "global":
        return "global";
    }
  }

  private scopeIdentityFor(
    scope: PluginScopeT,
    envId: string,
    workspaceId: string
  ): ScopeIdentity {
    switch (scope) {
      case "env":
        return { kind: "env", envId };
      case "workspace":
        return { kind: "workspace", workspaceId };
      case "global":
        return { kind: "global" };
    }
  }

  private buildViewerUrl(
    pluginId: string,
    identity: ScopeIdentity,
    iframePath: string = "/"
  ): string {
    let base: string;
    switch (identity.kind) {
      case "env":
        base = `/api/plugins/view/${pluginId}/env/${identity.envId}`;
        break;
      case "workspace":
        base = `/api/plugins/view/${pluginId}/ws/${identity.workspaceId}`;
        break;
      case "global":
        base = `/api/plugins/view/${pluginId}/global/_`;
        break;
    }
    // Append the manifest's iframePath so the browser loads the plugin's
    // actual entry point. iframePath="/" → no suffix (proxy forwards /
    // to upstream); anything else gets appended verbatim so plugin authors
    // can route their iframe load at a non-root path (/ui, /admin, …).
    // The trailing slash on iframePath is intentionally NOT preserved —
    // see SidecarProxy's skipTrailingSlashRedirect note.
    if (iframePath && iframePath !== "/") {
      const normalized = iframePath.startsWith("/") ? iframePath : `/${iframePath}`;
      return base + normalized.replace(/\/+$/, "");
    }
    return base;
  }

  // ── admin: install / uninstall / toggle / list ─────────────────────────

  async listAll(): Promise<PluginAdminRow[]> {
    const rows = await this.prisma.client.pluginDefinition.findMany({
      orderBy: { installedAt: "asc" },
      include: {
        _count: { select: { instances: { where: { status: "running" } } } },
      },
    });
    return rows.map((p) => ({
      id: p.id,
      name: p.name,
      version: p.version,
      image: p.image,
      icon: this.parseManifest(p.manifest).icon ?? null,
      enabled: p.enabled,
      defaultEnabledInEnv: p.defaultEnabledInEnv,
      installedAt: p.installedAt,
      installedBy: p.installedBy,
      manifest: this.parseManifest(p.manifest),
      runningInstances: p._count.instances,
    }));
  }

  async install(
    manifestText: string,
    installedBy: string | null
  ): Promise<PluginAdminRow> {
    if (!manifestText || !manifestText.trim()) {
      throw new BadRequestException("Manifest is empty");
    }
    let raw: unknown;
    try {
      raw = parseYaml(manifestText);
    } catch (err) {
      throw new BadRequestException(
        `Manifest is not valid YAML/JSON: ${err instanceof Error ? err.message : String(err)}`
      );
    }
    let manifest: PluginManifestT;
    try {
      manifest = PluginManifest.parse(raw);
    } catch (err) {
      if (err instanceof ZodError) {
        throw new BadRequestException(
          `Manifest validation failed: ${err.issues
            .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
            .join("; ")}`
        );
      }
      throw err;
    }
    // Skip pull when the image is already present locally — covers the
    // dev-loop case (`docker build -t local/...`) and any image already in
    // the daemon's cache. Only when truly absent do we go to the registry.
    const alreadyLocal = await exec("docker", [
      "image",
      "inspect",
      manifest.image,
    ])
      .then(() => true)
      .catch(() => false);
    if (!alreadyLocal) {
      try {
        await exec("docker", ["pull", manifest.image], {
          timeout: 5 * 60 * 1000,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new BadRequestException(
          `Failed to pull image ${manifest.image}: ${msg.split("\n").slice(0, 3).join(" ")}`
        );
      }
    }
    await this.prisma.client.pluginDefinition.upsert({
      where: { id: manifest.id },
      create: {
        id: manifest.id,
        name: manifest.name,
        version: manifest.version,
        image: manifest.image,
        manifest,
        enabled: true,
        defaultEnabledInEnv: manifest.defaultEnabledInEnv,
        installedBy,
      },
      update: {
        name: manifest.name,
        version: manifest.version,
        image: manifest.image,
        manifest,
        defaultEnabledInEnv: manifest.defaultEnabledInEnv,
      },
    });
    this.registerRoute(manifest);
    this.logger.info(
      `Installed plugin ${manifest.id}@${manifest.version} scope=${manifest.scope} storage=${manifest.storage.kind} (image ${manifest.image}) by ${installedBy ?? "<unknown>"}`
    );
    const rows = await this.listAll();
    const row = rows.find((r) => r.id === manifest.id);
    if (!row) throw new Error("install: row vanished post-upsert");
    return row;
  }

  async upsertManifestForSeed(manifest: PluginManifestT): Promise<void> {
    await this.prisma.client.pluginDefinition.upsert({
      where: { id: manifest.id },
      create: {
        id: manifest.id,
        name: manifest.name,
        version: manifest.version,
        image: manifest.image,
        manifest,
        enabled: true,
        defaultEnabledInEnv: manifest.defaultEnabledInEnv,
      },
      update: {
        name: manifest.name,
        version: manifest.version,
        image: manifest.image,
        manifest,
        defaultEnabledInEnv: manifest.defaultEnabledInEnv,
      },
    });
  }

  async uninstall(pluginId: string): Promise<{ ok: true }> {
    const plugin = await this.prisma.client.pluginDefinition.findUnique({
      where: { id: pluginId },
    });
    if (!plugin) {
      throw new NotFoundException(`Plugin ${pluginId} not installed`);
    }
    await this.stopAllInstancesOfPlugin(pluginId);
    // Drop any provisioned postgres storage. Done after stop so containers
    // aren't holding open connections during DROP SCHEMA.
    const instances = await this.prisma.client.pluginInstance.findMany({
      where: { pluginId, NOT: { dbSchema: null } },
      select: { dbSchema: true },
    });
    for (const inst of instances) {
      if (inst.dbSchema) {
        await this.postgres.dropStorage(inst.dbSchema, inst.dbSchema).catch(
          (err) =>
            this.logger.warn(
              `Failed to drop plugin schema ${inst.dbSchema}: ${err}`
            )
        );
      }
    }
    this.unregisterRoute(pluginId);
    await this.prisma.client.pluginDefinition.delete({
      where: { id: pluginId },
    });
    this.logger.info(`Uninstalled plugin ${pluginId}`);
    return { ok: true };
  }

  /**
   * Admin-side mutation. Accepts any subset of {enabled, defaultEnabledInEnv}.
   * `enabled=false` tears down every running instance + unregisters the
   * proxy route; flipping back to true re-registers it. `defaultEnabledInEnv`
   * only affects envs that don't have an explicit EnvPluginPreference row
   * yet, so flipping it is cheap and reversible.
   */
  async updateAdminFlags(
    pluginId: string,
    patch: { enabled?: boolean; defaultEnabledInEnv?: boolean }
  ): Promise<PluginAdminRow> {
    const plugin = await this.prisma.client.pluginDefinition.findUnique({
      where: { id: pluginId },
    });
    if (!plugin) {
      throw new NotFoundException(`Plugin ${pluginId} not installed`);
    }
    const data: { enabled?: boolean; defaultEnabledInEnv?: boolean } = {};
    if (
      patch.enabled !== undefined &&
      patch.enabled !== plugin.enabled
    ) {
      data.enabled = patch.enabled;
    }
    if (
      patch.defaultEnabledInEnv !== undefined &&
      patch.defaultEnabledInEnv !== plugin.defaultEnabledInEnv
    ) {
      data.defaultEnabledInEnv = patch.defaultEnabledInEnv;
    }
    if (Object.keys(data).length === 0) {
      throw new ConflictException("No changes");
    }
    if (data.enabled === false) {
      await this.stopAllInstancesOfPlugin(pluginId);
      this.unregisterRoute(pluginId);
    }
    await this.prisma.client.pluginDefinition.update({
      where: { id: pluginId },
      data,
    });
    if (data.enabled === true) {
      this.registerRoute(this.parseManifest(plugin.manifest));
    }
    this.logger.info(
      `Plugin ${pluginId} updated: ${JSON.stringify(data)}`
    );
    const rows = await this.listAll();
    const row = rows.find((r) => r.id === pluginId);
    if (!row) throw new Error("updateAdminFlags: row vanished post-update");
    return row;
  }

  async listEnabled(): Promise<{ id: string; manifest: PluginManifestT }[]> {
    const rows = await this.prisma.client.pluginDefinition.findMany({
      where: { enabled: true },
      select: { id: true, manifest: true },
      orderBy: { installedAt: "asc" },
    });
    return rows.map((r) => ({
      id: r.id,
      manifest: this.parseManifest(r.manifest),
    }));
  }

  // ── per-env-page feed (all scopes, contextualized to this env) ─────────

  async listForEnv(
    envId: string,
    workspaceId: string
  ): Promise<PluginViewRow[]> {
    const enabled = await this.prisma.client.pluginDefinition.findMany({
      where: { enabled: true },
      orderBy: { installedAt: "asc" },
    });
    const prefs = await this.prisma.client.envPluginPreference.findMany({
      where: { envId },
      select: { pluginId: true, enabled: true },
    });
    const prefByPluginId = new Map(
      prefs.map((p) => [p.pluginId, p.enabled] as const)
    );
    const result: PluginViewRow[] = [];
    for (const p of enabled) {
      const envEnabled = prefByPluginId.get(p.id) ?? p.defaultEnabledInEnv;
      // Sidebar only shows plugins the env has opted into. Disabled plugins
      // are still visible in the "manage" dialog (see listPrefsForEnv).
      if (!envEnabled) continue;
      const manifest = this.parseManifest(p.manifest);
      const identity = this.scopeIdentityFor(
        manifest.scope,
        envId,
        workspaceId
      );
      const scopeKey = this.computeScopeKey(identity);
      const inst = await this.prisma.client.pluginInstance.findUnique({
        where: { pluginId_scopeKey: { pluginId: p.id, scopeKey } },
        select: { status: true, error: true },
      });
      const status = inst?.status ?? "stopped";
      result.push({
        id: p.id,
        name: manifest.name,
        icon: manifest.icon ?? null,
        scope: manifest.scope,
        status,
        error: inst?.error ?? null,
        viewerUrl:
          status === "running"
            ? this.buildViewerUrl(p.id, identity, manifest.ui.iframePath)
            : null,
        enabled: true,
      });
    }
    return result;
  }

  /**
   * Plugins available to this env with their current enable/disable state.
   * Powers the sidebar's "manage plugins" dialog. Includes both enabled and
   * disabled plugins so the user can flip them; admin-disabled plugins
   * (PluginDefinition.enabled=false) are excluded entirely.
   */
  async listPrefsForEnv(envId: string): Promise<EnvPluginPrefRow[]> {
    const defs = await this.prisma.client.pluginDefinition.findMany({
      where: { enabled: true },
      orderBy: { installedAt: "asc" },
    });
    const prefs = await this.prisma.client.envPluginPreference.findMany({
      where: { envId },
      select: { pluginId: true, enabled: true },
    });
    const prefByPluginId = new Map(
      prefs.map((p) => [p.pluginId, p.enabled] as const)
    );
    return defs.map((p) => {
      const manifest = this.parseManifest(p.manifest);
      return {
        id: p.id,
        name: manifest.name,
        icon: manifest.icon ?? null,
        scope: manifest.scope,
        enabled: prefByPluginId.get(p.id) ?? p.defaultEnabledInEnv,
      };
    });
  }

  /**
   * Toggle a plugin on/off for a specific env. For env-scoped plugins,
   * disabling also stops + removes that env's container (the data, including
   * any provisioned postgres schema, is kept so re-enabling reattaches it).
   * For workspace/global plugins this only affects UI visibility — the
   * shared container keeps running.
   */
  async setEnabledForEnv(
    envId: string,
    workspaceId: string,
    pluginId: string,
    enabled: boolean
  ): Promise<EnvPluginPrefRow> {
    const plugin = await this.prisma.client.pluginDefinition.findUnique({
      where: { id: pluginId },
      select: { id: true, manifest: true, enabled: true },
    });
    if (!plugin || !plugin.enabled) {
      throw new NotFoundException(`Plugin ${pluginId} not installed`);
    }
    const manifest = this.parseManifest(plugin.manifest);
    await this.prisma.client.envPluginPreference.upsert({
      where: { envId_pluginId: { envId, pluginId } },
      create: { envId, pluginId, enabled },
      update: { enabled },
    });
    // env-scoped: tear down the container when disabled. Data is kept on the
    // PluginInstance row (containerId/hostPort nulled) so re-enabling
    // restarts the same instance and reuses any shared-postgres credentials.
    if (!enabled && manifest.scope === "env") {
      await this.stopForEnvPage(pluginId, envId, workspaceId).catch((err) => {
        this.logger.warn(
          `Failed to stop env-scoped plugin ${pluginId} on disable (env=${envId}): ${err instanceof Error ? err.message : String(err)}`
        );
      });
    }
    return {
      id: plugin.id,
      name: manifest.name,
      icon: manifest.icon ?? null,
      scope: manifest.scope,
      enabled,
    };
  }

  /**
   * Lightweight check used by chat-context (agent MCP discovery) so disabled
   * plugins don't expose their tools. Returns true if the plugin is admin-
   * enabled AND this env has it enabled (or falls back to the plugin's
   * defaultEnabledInEnv when no row exists).
   */
  async isPluginEnabledForEnv(
    pluginId: string,
    envId: string
  ): Promise<boolean> {
    const def = await this.prisma.client.pluginDefinition.findUnique({
      where: { id: pluginId },
      select: { enabled: true, defaultEnabledInEnv: true },
    });
    if (!def || !def.enabled) return false;
    const pref = await this.prisma.client.envPluginPreference.findUnique({
      where: { envId_pluginId: { envId, pluginId } },
      select: { enabled: true },
    });
    return pref?.enabled ?? def.defaultEnabledInEnv;
  }

  // ── start / stop ────────────────────────────────────────────────────────

  async start(
    envId: string,
    pluginId: string,
    workspaceId: string
  ): Promise<StartResult> {
    const env = await this.prisma.client.env.findUnique({
      where: { id: envId },
      select: {
        id: true,
        workspaceId: true,
        containerStatus: true,
        deletedAt: true,
      },
    });
    if (!env || env.deletedAt || env.workspaceId !== workspaceId) {
      return { ok: false, error: "Env not found" };
    }

    const plugin = await this.prisma.client.pluginDefinition.findUnique({
      where: { id: pluginId },
    });
    if (!plugin || !plugin.enabled) {
      return { ok: false, error: "Plugin not installed or disabled" };
    }
    // Honor the per-env preference. Don't spawn a container for a plugin
    // the env explicitly disabled — start would otherwise be a backdoor
    // around the toggle.
    if (!(await this.isPluginEnabledForEnv(pluginId, envId))) {
      return { ok: false, error: "Plugin is disabled for this env" };
    }
    const manifest = this.parseManifest(plugin.manifest);
    const identity = this.scopeIdentityFor(
      manifest.scope,
      envId,
      workspaceId
    );
    const scopeKey = this.computeScopeKey(identity);

    // env-scoped plugins live on the env's compose network — env must be
    // running. workspace/global plugins don't depend on a specific env so
    // they can spawn anytime.
    if (manifest.scope === "env" && env.containerStatus !== "running") {
      return {
        ok: false,
        error: "Env must be running before starting env-scoped plugins.",
      };
    }

    // Reuse a live container if one is already running for this scope.
    const existing = await this.prisma.client.pluginInstance.findUnique({
      where: { pluginId_scopeKey: { pluginId, scopeKey } },
    });
    if (existing?.containerId) {
      if (await this.containerAlive(existing.containerId)) {
        if (existing.status !== "running") {
          await this.prisma.client.pluginInstance.update({
            where: { id: existing.id },
            data: { status: "running", error: null },
          });
        }
        return {
          ok: true,
          status: "running",
          viewerUrl: this.buildViewerUrl(
            pluginId,
            identity,
            manifest.ui.iframePath
          ),
        };
      }
      await this.hardStop(existing.containerId).catch(() => {});
    }

    // Network selection: env-scoped joins env compose net; others join
    // only `withvibe` (via attachToWithvibe later).
    let network: string | null = null;
    if (manifest.scope === "env") {
      const project = composeProjectName(envId);
      network = await this.findEnvNetwork(project);
      if (!network) {
        return {
          ok: false,
          error: `Could not find env compose network (project=${project}). Start the env first.`,
        };
      }
    }

    await this.upsertInstance(identity, pluginId, {
      status: "starting",
      error: null,
    });

    // Provision shared-postgres storage on first start. Idempotent: a
    // re-start of an existing instance with credentials skips this.
    let dbCredential: string | null = existing?.dbCredential ?? null;
    let dbSchema: string | null = existing?.dbSchema ?? null;
    let databaseUrl: string | null = null;
    if (manifest.storage.kind === "shared-postgres") {
      if (dbCredential && dbSchema) {
        const password = this.postgres.decrypt(dbCredential);
        databaseUrl = this.postgres.buildDatabaseUrl(
          dbSchema,
          password,
          dbSchema
        );
      } else {
        try {
          const provisioned = await this.postgres.provisionStorage({
            pluginId,
            scopeKey,
          });
          dbCredential = this.postgres.encrypt(provisioned.password);
          dbSchema = provisioned.schema;
          databaseUrl = this.postgres.buildDatabaseUrl(
            provisioned.role,
            provisioned.password,
            provisioned.schema
          );
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          await this.upsertInstance(identity, pluginId, {
            status: "error",
            error: `Failed to provision plugin storage: ${msg}`,
          });
          return {
            ok: false,
            error: `Failed to provision plugin storage: ${msg}`,
          };
        }
      }
    }

    try {
      const ctx: SpawnContext = { ENV_ID: envId, WORKSPACE_ID: workspaceId };
      const args: string[] = ["run", "--rm", "-d"];
      if (network) {
        args.push("--network", network);
      }
      args.push(
        "--label",
        `com.withvibe.plugin=${pluginId}`,
        "--label",
        `com.withvibe.scope=${manifest.scope}`,
        "--label",
        `com.withvibe.scope-key=${scopeKey}`
      );
      if (manifest.scope === "env") {
        args.push("--label", `com.withvibe.env=${envId}`);
      } else if (manifest.scope === "workspace") {
        args.push("--label", `com.withvibe.workspace=${workspaceId}`);
      }
      for (const [k, v] of Object.entries(manifest.launch.env)) {
        args.push("-e", `${k}=${this.interpolate(v, ctx)}`);
      }
      if (databaseUrl) {
        args.push("-e", `DATABASE_URL=${databaseUrl}`);
        if (dbSchema) args.push("-e", `PGSCHEMA=${dbSchema}`);
      }
      args.push("-p", `127.0.0.1:0:${manifest.launch.port}`);
      args.push(manifest.image);

      const { stdout: cidRaw } = await exec("docker", args, {
        timeout: 60_000,
      });
      const containerId = cidRaw.trim();
      if (!containerId) {
        throw new Error("docker run returned empty container id");
      }

      await attachToWithvibe(containerId);
      const port = await this.resolvePublishedPort(
        containerId,
        manifest.launch.port
      );
      if (!port) {
        await this.hardStop(containerId).catch(() => {});
        throw new Error(
          "Failed to resolve published port for plugin container"
        );
      }

      await this.pollHealth(
        `127.0.0.1:${port}`,
        manifest.launch.healthPath
      ).catch((err) => {
        this.logger.warn(
          `Health check did not pass within window for ${pluginId} (scope ${scopeKey}): ${err instanceof Error ? err.message : String(err)}`
        );
      });

      await this.upsertInstance(identity, pluginId, {
        containerId,
        hostPort: port,
        status: "running",
        error: null,
        startedAt: new Date(),
        dbCredential,
        dbSchema,
      });
      this.logger.info(
        `Started plugin ${pluginId} scope=${scopeKey} (container ${containerId.slice(0, 12)}, port ${port})`
      );
      return {
        ok: true,
        status: "running",
        viewerUrl: this.buildViewerUrl(pluginId, identity),
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await this.upsertInstance(identity, pluginId, {
        containerId: null,
        hostPort: null,
        status: "error",
        error: msg,
      });
      return { ok: false, error: msg };
    }
  }

  async stop(
    pluginId: string,
    scopeKey: string
  ): Promise<{ ok: true }> {
    const inst = await this.prisma.client.pluginInstance.findUnique({
      where: { pluginId_scopeKey: { pluginId, scopeKey } },
    });
    if (inst?.containerId) {
      await this.hardStop(inst.containerId).catch((err) => {
        this.logger.warn(
          `Failed to remove plugin container ${inst.containerId} for ${pluginId}@${scopeKey}: ${err instanceof Error ? err.message : String(err)}`
        );
      });
    }
    if (inst) {
      await this.prisma.client.pluginInstance.update({
        where: { id: inst.id },
        data: {
          containerId: null,
          hostPort: null,
          status: "stopped",
          error: null,
        },
      });
    }
    return { ok: true };
  }

  /**
   * Stop the (pluginId, scope=env, env=<envId>) plugin if one is running.
   * Convenience for env-page UI which knows envId, not scopeKey.
   */
  async stopForEnvPage(
    pluginId: string,
    envId: string,
    workspaceId: string
  ): Promise<{ ok: true }> {
    const plugin = await this.prisma.client.pluginDefinition.findUnique({
      where: { id: pluginId },
      select: { manifest: true },
    });
    if (!plugin) return { ok: true };
    const manifest = this.parseManifest(plugin.manifest);
    const scopeKey = this.computeScopeKey(
      this.scopeIdentityFor(manifest.scope, envId, workspaceId)
    );
    return this.stop(pluginId, scopeKey);
  }

  /**
   * Called from DockerService stop/rebuild. Only env-scoped instances tied
   * to *this* env are stopped — workspace/global plugins keep running.
   */
  async stopAllForEnv(envId: string): Promise<void> {
    const scopeKey = `env:${envId}`;
    const instances = await this.prisma.client.pluginInstance.findMany({
      where: { scopeKey, NOT: { containerId: null } },
      select: { pluginId: true },
    });
    for (const i of instances) {
      await this.stop(i.pluginId, scopeKey).catch(() => {});
    }
  }

  /** Workspace deletion path: stop and clean up workspace-scoped plugins. */
  async stopAllForWorkspace(workspaceId: string): Promise<void> {
    const scopeKey = `ws:${workspaceId}`;
    const instances = await this.prisma.client.pluginInstance.findMany({
      where: { scopeKey, NOT: { containerId: null } },
      select: { pluginId: true },
    });
    for (const i of instances) {
      await this.stop(i.pluginId, scopeKey).catch(() => {});
    }
  }

  /** Uninstall path: stop every instance across all scopes. */
  async stopAllInstancesOfPlugin(pluginId: string): Promise<void> {
    const instances = await this.prisma.client.pluginInstance.findMany({
      where: { pluginId, NOT: { containerId: null } },
      select: { scopeKey: true },
    });
    for (const i of instances) {
      await this.stop(pluginId, i.scopeKey).catch(() => {});
    }
  }

  // ── proxy target lookup (called from SidecarProxy via the route) ──────

  /**
   * Resolve a running plugin's host:port for the proxy. `scopeIdSegment` is
   * the URL segment after the scope discriminator (envId / workspaceId /
   * "_" for global).
   */
  async getProxyTarget(
    pluginId: string,
    scope: PluginScopeT,
    scopeIdSegment: string
  ): Promise<string | null> {
    const plugin = await this.prisma.client.pluginDefinition.findUnique({
      where: { id: pluginId },
      select: { manifest: true },
    });
    if (!plugin) return null;
    const manifest = this.parseManifest(plugin.manifest);
    if (manifest.scope !== scope) return null;
    let scopeKey: string;
    switch (scope) {
      case "env":
        scopeKey = `env:${scopeIdSegment}`;
        break;
      case "workspace":
        scopeKey = `ws:${scopeIdSegment}`;
        break;
      case "global":
        scopeKey = "global";
        break;
    }
    const inst = await this.prisma.client.pluginInstance.findUnique({
      where: { pluginId_scopeKey: { pluginId, scopeKey } },
      select: { containerId: true, hostPort: true, status: true },
    });
    if (!inst) return null;
    return resolveSidecarTarget({
      containerId: inst.containerId,
      status: inst.status,
      publishedPort: inst.hostPort,
      internalPort: manifest.launch.port,
    });
  }

  // ── proxy route registration (one route per plugin, scope-prefixed) ───

  registerRoute(manifest: PluginManifestT): void {
    const prefix = `/api/plugins/view/${manifest.id}/${manifest.scope === "global" ? "global" : manifest.scope === "workspace" ? "ws" : "env"}/`;
    this.sidecarProxy.addRoute({
      prefix,
      ws: manifest.ui.needsWebsocket,
      target: (scopeIdSegment) =>
        this.getProxyTarget(manifest.id, manifest.scope, scopeIdSegment),
      membershipCheck: (scopeIdSegment, userId) =>
        this.checkMembershipForScope(manifest.scope, scopeIdSegment, userId),
      skipTrailingSlashRedirect: true,
    });
  }

  unregisterRoute(pluginId: string): boolean {
    const prefixes = [
      `/api/plugins/view/${pluginId}/env/`,
      `/api/plugins/view/${pluginId}/ws/`,
      `/api/plugins/view/${pluginId}/global/`,
    ];
    let removed = false;
    for (const p of prefixes) {
      if (this.sidecarProxy.removeRoute(p)) removed = true;
    }
    return removed;
  }

  private async checkMembershipForScope(
    scope: PluginScopeT,
    scopeIdSegment: string,
    userId: string
  ): Promise<boolean> {
    switch (scope) {
      case "env": {
        const env = await this.prisma.client.env.findUnique({
          where: { id: scopeIdSegment },
          select: { workspaceId: true, deletedAt: true },
        });
        if (!env || env.deletedAt) return false;
        const member = await this.prisma.client.workspaceMember.findUnique({
          where: {
            workspaceId_userId: {
              workspaceId: env.workspaceId,
              userId,
            },
          },
        });
        return !!member;
      }
      case "workspace": {
        const member = await this.prisma.client.workspaceMember.findUnique({
          where: {
            workspaceId_userId: {
              workspaceId: scopeIdSegment,
              userId,
            },
          },
        });
        return !!member;
      }
      case "global":
        // Authenticated-user-only. Global-scoped plugins are deployment-
        // wide so any user with a valid session can reach the UI.
        return true;
    }
  }

  // ── helpers ────────────────────────────────────────────────────────────

  private interpolate(value: string, ctx: SpawnContext): string {
    return value.replace(/\{\{([A-Z][A-Z0-9_]*)\}\}/g, (m, key: string) => {
      return key in ctx ? ctx[key as keyof SpawnContext] : m;
    });
  }

  private async upsertInstance(
    identity: ScopeIdentity,
    pluginId: string,
    patch: {
      containerId?: string | null;
      hostPort?: number | null;
      status?: string;
      error?: string | null;
      startedAt?: Date | null;
      dbCredential?: string | null;
      dbSchema?: string | null;
    }
  ) {
    const scopeKey = this.computeScopeKey(identity);
    const envId =
      identity.kind === "env" ? identity.envId : null;
    const workspaceId =
      identity.kind === "workspace" ? identity.workspaceId : null;
    return this.prisma.client.pluginInstance.upsert({
      where: { pluginId_scopeKey: { pluginId, scopeKey } },
      create: {
        pluginId,
        scopeKind: identity.kind,
        scopeKey,
        envId,
        workspaceId,
        containerId: patch.containerId ?? null,
        hostPort: patch.hostPort ?? null,
        status: patch.status ?? "stopped",
        error: patch.error ?? null,
        startedAt: patch.startedAt ?? null,
        dbCredential: patch.dbCredential ?? null,
        dbSchema: patch.dbSchema ?? null,
      },
      update: patch,
    });
  }

  private async findEnvNetwork(project: string): Promise<string | null> {
    try {
      const { stdout } = await exec(
        "docker",
        [
          "network",
          "ls",
          "--filter",
          `label=com.docker.compose.project=${project}`,
          "--format",
          "{{.Name}}",
        ],
        { timeout: 10_000 }
      );
      const names = stdout
        .split("\n")
        .map((s) => s.trim())
        .filter(Boolean);
      if (names.length === 0) return null;
      const preferred = names.find((n) => n.endsWith("_default"));
      return preferred || names[0];
    } catch {
      return null;
    }
  }

  private async resolvePublishedPort(
    containerId: string,
    internalPort: number
  ): Promise<number | null> {
    try {
      const { stdout } = await exec(
        "docker",
        ["port", containerId, String(internalPort)],
        { timeout: 10_000 }
      );
      for (const line of stdout.split("\n")) {
        const m = line.match(/:(\d+)$/);
        if (m) return Number(m[1]);
      }
      return null;
    } catch {
      return null;
    }
  }

  private async containerAlive(id: string): Promise<boolean> {
    try {
      const { stdout } = await exec(
        "docker",
        ["inspect", "-f", "{{.State.Running}}", id],
        { timeout: 5_000 }
      );
      return stdout.trim() === "true";
    } catch {
      return false;
    }
  }

  private async hardStop(containerId: string): Promise<void> {
    await exec("docker", ["rm", "-f", containerId], { timeout: 30_000 });
  }

  private async pollHealth(target: string, path: string): Promise<void> {
    const deadline = Date.now() + 15_000;
    const url = `http://${target}${path.startsWith("/") ? path : `/${path}`}`;
    let lastErr: unknown = null;
    while (Date.now() < deadline) {
      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(3_000) });
        if (res.status < 500) return;
        lastErr = new Error(`status ${res.status}`);
      } catch (err) {
        lastErr = err;
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    throw lastErr instanceof Error
      ? lastErr
      : new Error("health check timeout");
  }
}

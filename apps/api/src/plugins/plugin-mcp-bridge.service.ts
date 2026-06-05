import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { InjectPinoLogger, PinoLogger } from "nestjs-pino";
import type { IncomingHttpHeaders } from "node:http";
import { PrismaService } from "../prisma/prisma.service";
import { PluginsService } from "./plugins.service";

/**
 * Bridges agent-runner MCP calls to the plugin container that owns the
 * tool. The McpController routes `/api/mcp/plugin_<pluginId>` here; we
 * resolve the running container for the plugin's scope (env-scoped uses
 * ctx.envId, workspace-scoped uses ctx.workspaceId, global uses the
 * single global instance), verify the caller is allowed to reach it, and
 * forward the JSON-RPC body unchanged. The plugin container's MCP server
 * sees its own native protocol — the bridge is just a hop.
 */
@Injectable()
export class PluginMcpBridgeService {
  constructor(
    @InjectPinoLogger(PluginMcpBridgeService.name)
    private readonly logger: PinoLogger,
    private readonly prisma: PrismaService,
    private readonly plugins: PluginsService
  ) {}

  /**
   * Forward an incoming JSON-RPC body to the plugin's MCP endpoint.
   * Returns the upstream response (status + headers + body) for the
   * controller to relay. Throws if the plugin isn't installed, isn't
   * MCP-enabled, isn't running for this scope, or the user isn't allowed.
   */
  async forward(args: {
    pluginId: string;
    ctx: {
      workspaceId: string;
      envId: string;
      userId: string;
    };
    method: string;
    body: Buffer;
    headers: IncomingHttpHeaders;
  }): Promise<{
    status: number;
    headers: Record<string, string | string[]>;
    body: Buffer;
  }> {
    const plugin = await this.prisma.client.pluginDefinition.findUnique({
      where: { id: args.pluginId },
    });
    if (!plugin || !plugin.enabled) {
      throw new NotFoundException(
        `Plugin ${args.pluginId} not installed or disabled`
      );
    }
    const manifest = this.plugins.parseManifest(plugin.manifest);
    if (!manifest.mcp.enabled) {
      throw new NotFoundException(
        `Plugin ${args.pluginId} does not expose an MCP server`
      );
    }

    // Resolve the scope identity from chat context.
    let scopeIdSegment: string;
    let accessOk: boolean;
    switch (manifest.scope) {
      case "env":
        scopeIdSegment = args.ctx.envId;
        accessOk = await this.isWorkspaceMember(
          args.ctx.workspaceId,
          args.ctx.userId
        );
        break;
      case "workspace":
        scopeIdSegment = args.ctx.workspaceId;
        accessOk = await this.isWorkspaceMember(
          args.ctx.workspaceId,
          args.ctx.userId
        );
        break;
      case "global":
        scopeIdSegment = "_";
        accessOk = true; // authenticated-user-only; the runner had to mint a valid bridge token
        break;
    }
    if (!accessOk) {
      throw new ForbiddenException("Not a workspace member");
    }

    const target = await this.plugins.getProxyTarget(
      args.pluginId,
      manifest.scope,
      scopeIdSegment
    );
    if (!target) {
      // Common case: plugin container hasn't been spawned yet for this
      // scope. We could auto-spawn here (would make MCP tools "just work"
      // without the user clicking the panel) but that adds 5–30s to the
      // first chat turn. Phase 5 keeps it explicit: user opens the
      // plugin panel once → spawn → from then on tools are visible.
      throw new NotFoundException(
        `Plugin ${args.pluginId} not running for this scope. Open the plugin panel once to start it.`
      );
    }

    // Forward the request. Plugin MCP servers are HTTP/JSON-RPC (or SSE
    // for streaming); we forward both headers and body verbatim so the
    // plugin sees its native protocol shape.
    const url = `http://${target}${manifest.mcp.path.startsWith("/") ? "" : "/"}${manifest.mcp.path}`;
    const forwardHeaders: Record<string, string> = {};
    for (const [k, v] of Object.entries(args.headers)) {
      if (v === undefined) continue;
      const lk = k.toLowerCase();
      // Drop hop-by-hop and api-internal headers.
      if (
        lk === "host" ||
        lk === "connection" ||
        lk === "keep-alive" ||
        lk === "te" ||
        lk === "upgrade" ||
        lk === "authorization" // strip the bridge token — plugin uses its own auth (or none)
      ) {
        continue;
      }
      forwardHeaders[k] = Array.isArray(v) ? v.join(", ") : v;
    }
    // Always include the request scope context so plugin MCP servers can
    // identify *who* is calling without re-parsing the URL.
    forwardHeaders["x-withvibe-plugin-scope"] = manifest.scope;
    forwardHeaders["x-withvibe-plugin-scope-key"] = scopeIdSegment;
    forwardHeaders["x-withvibe-user-id"] = args.ctx.userId;
    forwardHeaders["x-withvibe-env-id"] = args.ctx.envId;
    forwardHeaders["x-withvibe-workspace-id"] = args.ctx.workspaceId;

    let res: Response;
    try {
      res = await fetch(url, {
        method: args.method,
        headers: forwardHeaders,
        body:
          args.method === "GET" || args.method === "HEAD"
            ? undefined
            : // undici typings reject Buffer but the runtime accepts it.
              (args.body as unknown as BodyInit),
        // 60s — covers slow plugin tool calls without holding the api hostage.
        signal: AbortSignal.timeout(60_000),
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.warn(
        `Plugin MCP bridge: upstream fetch failed for ${args.pluginId} (${url}): ${msg}`
      );
      throw new NotFoundException(
        `Plugin ${args.pluginId} MCP upstream unreachable: ${msg}`
      );
    }

    const responseHeaders: Record<string, string | string[]> = {};
    res.headers.forEach((value, key) => {
      const lk = key.toLowerCase();
      if (
        lk === "connection" ||
        lk === "keep-alive" ||
        lk === "te" ||
        lk === "upgrade" ||
        lk === "transfer-encoding"
      ) {
        return;
      }
      responseHeaders[key] = value;
    });
    const body = Buffer.from(await res.arrayBuffer());
    return { status: res.status, headers: responseHeaders, body };
  }

  private async isWorkspaceMember(
    workspaceId: string,
    userId: string
  ): Promise<boolean> {
    const member = await this.prisma.client.workspaceMember.findUnique({
      where: { workspaceId_userId: { workspaceId, userId } },
    });
    return !!member;
  }

  /**
   * For each enabled plugin with mcp.enabled=true that has a *running*
   * instance reachable for this chat context, return the metadata the
   * claude-code engine needs to add it as an HTTP MCP server in mcp.json.
   * Tool namespacing is handled by the MCP client (claude CLI prefixes
   * tools with the server name).
   */
  async listMcpServersForContext(ctx: {
    workspaceId: string;
    envId: string;
  }): Promise<
    {
      pluginId: string;
      serverName: string;
      name: string;
      agentInstructions: string | null;
    }[]
  > {
    const plugins = await this.prisma.client.pluginDefinition.findMany({
      where: { enabled: true },
    });
    const prefs = await this.prisma.client.envPluginPreference.findMany({
      where: { envId: ctx.envId },
      select: { pluginId: true, enabled: true },
    });
    const prefByPluginId = new Map(
      prefs.map((p) => [p.pluginId, p.enabled] as const)
    );
    const out: {
      pluginId: string;
      serverName: string;
      name: string;
      agentInstructions: string | null;
    }[] = [];
    for (const p of plugins) {
      const manifest = this.plugins.parseManifest(p.manifest);
      if (!manifest.mcp.enabled) continue;
      // Honor the per-env toggle. A disabled plugin must not leak its
      // tools to the agent even if its (shared) container is up.
      const envEnabled = prefByPluginId.get(p.id) ?? p.defaultEnabledInEnv;
      if (!envEnabled) continue;
      let scopeKey: string;
      switch (manifest.scope) {
        case "env":
          scopeKey = `env:${ctx.envId}`;
          break;
        case "workspace":
          scopeKey = `ws:${ctx.workspaceId}`;
          break;
        case "global":
          scopeKey = "global";
          break;
      }
      const inst = await this.prisma.client.pluginInstance.findUnique({
        where: { pluginId_scopeKey: { pluginId: p.id, scopeKey } },
        select: { status: true },
      });
      if (inst?.status === "running") {
        out.push({
          pluginId: p.id,
          serverName: `plugin_${sanitizeServerName(p.id)}`,
          name: manifest.name,
          agentInstructions: manifest.agentInstructions ?? null,
        });
      }
    }
    return out;
  }
}

/**
 * Postgres-identifier-style sanitization — same rules MCP server names
 * need to follow to avoid breaking the claude CLI's `mcp__<server>__<tool>`
 * namespacing.
 */
function sanitizeServerName(id: string): string {
  return id.replace(/[^a-zA-Z0-9_]/g, "_");
}

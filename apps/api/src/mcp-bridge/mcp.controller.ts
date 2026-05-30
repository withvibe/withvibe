import {
  All,
  Controller,
  Headers,
  Param,
  Req,
  Res,
  UnauthorizedException,
} from "@nestjs/common";
import type { Request, Response } from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { InjectPinoLogger, PinoLogger } from "nestjs-pino";
import { McpTokenService } from "./mcp-token.service";
import { McpRegistryService } from "./mcp-registry.service";
import { PluginMcpBridgeService } from "../plugins/plugin-mcp-bridge.service";
import { PrismaService } from "../prisma/prisma.service";
import type { McpBridgeCtx } from "./mcp-tool-types";

const PLUGIN_PREFIX = "plugin_";

/**
 * HTTP MCP bridge — one route per bridged server, consumed by the Claude Code
 * runner container. Each request is stateless: a fresh McpServer +
 * StreamableHTTPServerTransport per call, tools re-registered from the
 * registry with the ctx decoded from the bearer JWT.
 *
 * Plugin servers (`plugin_<sanitized-id>`) take a different path: their tools
 * live inside the plugin container, so we forward the raw JSON-RPC body to
 * the plugin's MCP endpoint via PluginMcpBridgeService.
 */
@Controller("mcp")
export class McpController {
  constructor(
    @InjectPinoLogger(McpController.name)
    private readonly logger: PinoLogger,
    private readonly tokens: McpTokenService,
    private readonly registry: McpRegistryService,
    private readonly pluginMcp: PluginMcpBridgeService,
    private readonly prisma: PrismaService
  ) {}

  @All(":serverName")
  async handle(
    @Param("serverName") serverName: string,
    @Headers("authorization") authHeader: string | undefined,
    @Req() req: Request,
    @Res() res: Response
  ): Promise<void> {
    const token = parseBearer(authHeader);
    if (!token) {
      throw new UnauthorizedException("Missing bearer token");
    }
    const ctx = this.tokens.verify(token);

    if (serverName.startsWith(PLUGIN_PREFIX)) {
      await this.handlePluginBridge(serverName, ctx, req, res);
      return;
    }

    await this.handleBuiltinServer(serverName, ctx, req, res);
  }

  // ── built-in in-process servers (existing behavior) ────────────────────

  private async handleBuiltinServer(
    serverName: string,
    ctx: McpBridgeCtx,
    req: Request,
    res: Response
  ): Promise<void> {
    const spec = await this.registry.describeServer(serverName, ctx);

    const mcp = new McpServer(
      { name: spec.name, version: spec.version },
      { capabilities: { tools: {} } }
    );
    for (const t of spec.tools) {
      mcp.registerTool(
        t.name,
        { description: t.description, inputSchema: t.inputShape },
        async (args: Record<string, unknown>) => t.handler(args)
      );
    }

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });

    res.on("close", () => {
      void transport.close();
      void mcp.close();
    });

    try {
      await mcp.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      this.logger.error(
        `MCP bridge error (server=${serverName}, env=${ctx.envId}): ${
          err instanceof Error ? err.message : String(err)
        }`,
        err instanceof Error ? err.stack : undefined
      );
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          error: { code: -32603, message: "Internal MCP bridge error" },
          id: null,
        });
      }
    }
  }

  // ── plugin bridge (forwards JSON-RPC to plugin container) ──────────────

  private async handlePluginBridge(
    serverName: string,
    ctx: McpBridgeCtx,
    req: Request,
    res: Response
  ): Promise<void> {
    // Reverse the sanitization: find the enabled plugin whose id, after
    // [^a-zA-Z0-9_] → "_", matches the URL segment.
    const sanitized = serverName.slice(PLUGIN_PREFIX.length);
    const enabled = await this.prisma.client.pluginDefinition.findMany({
      where: { enabled: true },
      select: { id: true },
    });
    const match = enabled.find(
      (p) => p.id.replace(/[^a-zA-Z0-9_]/g, "_") === sanitized
    );
    if (!match) {
      res.status(404).json({
        jsonrpc: "2.0",
        error: {
          code: -32601,
          message: `Unknown plugin MCP server: ${serverName}`,
        },
        id: null,
      });
      return;
    }

    try {
      const upstream = await this.pluginMcp.forward({
        pluginId: match.id,
        ctx: {
          workspaceId: ctx.workspaceId,
          envId: ctx.envId,
          userId: ctx.userId,
        },
        method: req.method,
        body: Buffer.from(JSON.stringify(req.body ?? {})),
        headers: req.headers,
      });
      res.status(upstream.status);
      for (const [k, v] of Object.entries(upstream.headers)) {
        res.setHeader(k, v as string | string[]);
      }
      res.end(upstream.body);
    } catch (err) {
      this.logger.error(
        `Plugin MCP bridge (${match.id}) failed: ${err instanceof Error ? err.message : String(err)}`
      );
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          error: {
            code: -32603,
            message:
              err instanceof Error ? err.message : "Plugin MCP bridge error",
          },
          id: null,
        });
      }
    }
  }
}

function parseBearer(header: string | undefined): string | null {
  if (!header) return null;
  const m = /^Bearer\s+(.+)$/i.exec(header.trim());
  return m ? m[1] : null;
}

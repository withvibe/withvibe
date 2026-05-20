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
import { McpTokenService } from "./mcp-token.service";
import { McpRegistryService } from "./mcp-registry.service";
import { InjectPinoLogger, PinoLogger } from "nestjs-pino";

/**
 * HTTP MCP bridge — one route per bridged server, consumed by the Claude Code
 * runner container (Phase 4). Each request is stateless: a fresh McpServer +
 * StreamableHTTPServerTransport per call, tools re-registered from the
 * registry with the ctx decoded from the bearer JWT.
 *
 * This runs alongside (not instead of) the in-process SDK servers — the
 * Agent SDK engine keeps using those directly. Only the claude_code engine
 * reaches the HTTP endpoints.
 */
@Controller("mcp")
export class McpController {
  constructor(
    @InjectPinoLogger(McpController.name)
    private readonly logger: PinoLogger,
    private readonly tokens: McpTokenService,
    private readonly registry: McpRegistryService
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
}

function parseBearer(header: string | undefined): string | null {
  if (!header) return null;
  const m = /^Bearer\s+(.+)$/i.exec(header.trim());
  return m ? m[1] : null;
}

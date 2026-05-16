import { Injectable, UnauthorizedException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import jwt from "jsonwebtoken";
import type { McpBridgeCtx } from "./mcp-tool-types";

/**
 * Short-lived bearer token the Claude Code runner container presents when
 * calling /api/mcp/:serverName. Carries the per-chat-turn scope the bridge
 * uses to hand requests to the right service. Signed with the same
 * INTERNAL_JWT_SECRET the rest of the API uses so we don't add new secret
 * surface.
 *
 * 30-minute TTL — covers the longest realistic turn (slow builds polled via
 * wait_for_env_status) without the token outliving its usefulness.
 */
const DEFAULT_TTL_SEC = 30 * 60;

type McpJwtClaims = McpBridgeCtx & {
  kind: "mcp-bridge";
  iat?: number;
  exp?: number;
};

@Injectable()
export class McpTokenService {
  private readonly secret: string;

  constructor(config: ConfigService) {
    const secret = config.get<string>("INTERNAL_JWT_SECRET");
    if (!secret) {
      throw new Error(
        "INTERNAL_JWT_SECRET is not set — required for MCP bridge tokens"
      );
    }
    this.secret = secret;
  }

  sign(ctx: McpBridgeCtx, ttlSec: number = DEFAULT_TTL_SEC): string {
    const payload: McpJwtClaims = { ...ctx, kind: "mcp-bridge" };
    return jwt.sign(payload, this.secret, { expiresIn: ttlSec });
  }

  verify(token: string): McpBridgeCtx {
    let decoded: unknown;
    try {
      decoded = jwt.verify(token, this.secret);
    } catch {
      throw new UnauthorizedException("Invalid MCP bridge token");
    }
    if (
      !decoded ||
      typeof decoded !== "object" ||
      (decoded as { kind?: string }).kind !== "mcp-bridge"
    ) {
      throw new UnauthorizedException("Token is not an MCP bridge token");
    }
    const c = decoded as McpJwtClaims;
    if (!c.workspaceId || !c.envId || !c.userId) {
      throw new UnauthorizedException("MCP bridge token missing required fields");
    }
    return {
      workspaceId: c.workspaceId,
      envId: c.envId,
      userId: c.userId,
      sessionId: c.sessionId ?? null,
      agentId: c.agentId ?? null,
    };
  }
}

import { Module } from "@nestjs/common";
import { McpTokenService } from "./mcp-token.service";

/**
 * Isolated so ChatModule can inject McpTokenService to mint bridge tokens
 * at context-build time without pulling in the full HTTP bridge (which
 * itself imports ChatModule → would create a cycle).
 */
@Module({
  providers: [McpTokenService],
  exports: [McpTokenService],
})
export class McpTokenModule {}

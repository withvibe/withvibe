import { Module } from "@nestjs/common";
import { ChatModule } from "../chat/chat.module";
import { DockerModule } from "../docker/docker.module";
import { AgentsModule } from "../agents/agents.module";
import { EnvCloneModule } from "../env-clones/env-clone.module";
import { McpTokenModule } from "./mcp-token.module";
import { McpController } from "./mcp.controller";
import { McpRegistryService } from "./mcp-registry.service";

/**
 * HTTP MCP bridge — exposes the six in-process MCP servers over HTTP so the
 * Phase 4 Claude Code runner container can consume them. Reuses the services
 * that already implement the tool handlers in-process; the bridge is strictly
 * an alternate transport.
 */
@Module({
  imports: [McpTokenModule, ChatModule, DockerModule, AgentsModule, EnvCloneModule],
  controllers: [McpController],
  providers: [McpRegistryService],
})
export class McpBridgeModule {}

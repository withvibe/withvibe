import { Global, Module } from "@nestjs/common";
import { AgentSeedService } from "./agent-seed.service";

// Tiny helper module exposing `AgentSeedService` globally so envs + workspaces
// can seed the DevOps agent without a cross-module import graph. The full
// agents module (controller + skills + MCP) arrives in Phase 2e.
@Global()
@Module({
  providers: [AgentSeedService],
  exports: [AgentSeedService],
})
export class AgentSeedModule {}

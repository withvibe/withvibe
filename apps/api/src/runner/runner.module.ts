import { Module } from "@nestjs/common";
import { EnvCloneModule } from "../env-clones/env-clone.module";
import { ClaudeRunnerService } from "./claude-runner.service";

@Module({
  imports: [EnvCloneModule],
  providers: [ClaudeRunnerService],
  exports: [ClaudeRunnerService],
})
export class RunnerModule {}

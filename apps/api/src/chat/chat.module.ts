import { Module } from "@nestjs/common";
import { McpTokenModule } from "../mcp-bridge/mcp-token.module";
import { RunnerModule } from "../runner/runner.module";
import { EnvCloneModule } from "../env-clones/env-clone.module";
import { ChatContextService } from "./chat-context.service";
import { ChatStreamService } from "./chat-stream.service";
import { ClaudeCodeEngineService } from "./claude-code-engine.service";
import { ModelRouterService } from "./model-router.service";
import { TitleGeneratorService } from "./title-generator.service";
import { EnvKnowledgeService } from "./env-knowledge.service";
import { WorkspaceKnowledgeService } from "./workspace-knowledge.service";
import { MemberMemoryService } from "./member-memory.service";
import { HumanQuestionService } from "./human-question.service";
import { MemoryMirrorService } from "./memory-mirror.service";
import { ExternalContextMcpService } from "./external-context-mcp.service";
import { SessionsService } from "./sessions.service";
import { MessagesService } from "./messages.service";
import { ActiveRunsService } from "./active-runs.service";
import { SecurityScanService } from "./security-scan.service";
import { SessionsController } from "./sessions.controller";
import { MessagesController } from "./messages.controller";
import { SecurityScanController } from "./security-scan.controller";
import { InboxController } from "./inbox.controller";
import { ActiveRunsController } from "./active-runs.controller";
import { AttachmentsController } from "./attachments.controller";
import { BenchService } from "./bench/bench.service";
import { BenchController } from "./bench/bench.controller";

@Module({
  imports: [McpTokenModule, RunnerModule, EnvCloneModule],
  controllers: [
    SessionsController,
    MessagesController,
    SecurityScanController,
    InboxController,
    ActiveRunsController,
    AttachmentsController,
    BenchController,
  ],
  providers: [
    ChatContextService,
    ChatStreamService,
    ClaudeCodeEngineService,
    ModelRouterService,
    TitleGeneratorService,
    EnvKnowledgeService,
    WorkspaceKnowledgeService,
    MemberMemoryService,
    HumanQuestionService,
    MemoryMirrorService,
    ExternalContextMcpService,
    SessionsService,
    MessagesService,
    ActiveRunsService,
    SecurityScanService,
    BenchService,
  ],
  exports: [
    EnvKnowledgeService,
    WorkspaceKnowledgeService,
    MemberMemoryService,
    HumanQuestionService,
  ],
})
export class ChatModule {}

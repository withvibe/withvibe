import { Global, Module } from "@nestjs/common";
import { AgentsService } from "./agents.service";
import { AgentChatService } from "./agent-chat.service";
import { AgentGreetingService } from "./agent-greeting.service";
import { CloneSeedService } from "./clone-seed.service";
import { AgentsController, EnvAgentsController } from "./agents.controller";

@Global()
@Module({
  controllers: [AgentsController, EnvAgentsController],
  providers: [
    AgentsService,
    AgentChatService,
    AgentGreetingService,
    CloneSeedService,
  ],
  exports: [AgentsService, AgentChatService, AgentGreetingService],
})
export class AgentsModule {}

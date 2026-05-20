import { Module, forwardRef } from "@nestjs/common";
import { SlackService } from "./slack.service";
import { SlackMcpService } from "./slack-mcp.service";
import { SlackEventHandlerService } from "./slack-event-handler.service";
import { SlackSocketService } from "./slack-socket.service";
import { ChatModule } from "../chat/chat.module";
import { EnvCloneModule } from "../env-clones/env-clone.module";

/**
 * SlackModule depends on ChatModule (for MessagesService.startSessionTurn,
 * which the event handler calls to trigger an agent turn from a Slack
 * reply). ChatModule already imports SlackModule (for SlackMcpService in
 * ChatContextService), so we use forwardRef to break the cycle.
 * EnvCloneModule is imported for SlackMcpService.maybeResolveFile to
 * resolve agent-supplied file paths against the env's working directory.
 */
@Module({
  imports: [forwardRef(() => ChatModule), EnvCloneModule],
  providers: [
    SlackService,
    SlackMcpService,
    SlackEventHandlerService,
    SlackSocketService,
  ],
  exports: [SlackService, SlackMcpService, SlackSocketService],
})
export class SlackModule {}

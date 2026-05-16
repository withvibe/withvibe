import { ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import { displayName, type DisplayMember } from "@withvibe/db";
import { PrismaService } from "../prisma/prisma.service";
import { EnvKnowledgeService } from "../chat/env-knowledge.service";
import { WorkspaceKnowledgeService } from "../chat/workspace-knowledge.service";
import { MemberMemoryService } from "../chat/member-memory.service";
import { HumanQuestionService } from "../chat/human-question.service";
import { DockerMcpService } from "../docker/docker-mcp.service";
import { AgentChatService } from "../agents/agent-chat.service";
import { EnvCloneService } from "../env-clones/env-clone.service";
import type { McpBridgeCtx, McpServerSpec } from "./mcp-tool-types";

/**
 * Maps an HTTP MCP request — (serverName, decoded JWT ctx) — to the spec
 * the controller will register with `McpServer`. Each bridged service owns
 * the ctx derivations it needs (clone-owner lookup, display-name
 * resolution, env dir resolution). Async because some derivations hit the
 * DB.
 */
@Injectable()
export class McpRegistryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly envKnowledge: EnvKnowledgeService,
    private readonly workspaceKnowledge: WorkspaceKnowledgeService,
    private readonly memberMemory: MemberMemoryService,
    private readonly humanQuestion: HumanQuestionService,
    private readonly dockerMcp: DockerMcpService,
    private readonly agentChat: AgentChatService,
    private readonly envClones: EnvCloneService
  ) {}

  async describeServer(
    serverName: string,
    ctx: McpBridgeCtx
  ): Promise<McpServerSpec> {
    switch (serverName) {
      case "withvibe-env":
        return this.envKnowledge.describeMcpServer(ctx.envId);

      case "withvibe-workspace":
        return this.workspaceKnowledge.describeMcpServer(ctx.workspaceId);

      case "withvibe-member":
        return this.memberMemory.describeMcpServer(ctx.userId, ctx.workspaceId);

      case "withvibe-docker":
        return this.dockerMcp.describeMcpServer(ctx.envId);

      case "withvibe-agent": {
        if (!ctx.agentId) {
          throw new ForbiddenException(
            "withvibe-agent requires an agent-bound session"
          );
        }
        const envDir = this.envClones.envDir(ctx.workspaceId, ctx.envId);
        return this.agentChat.describeAgentMcpServer({
          agentId: ctx.agentId,
          envId: ctx.envId,
          envDir,
        });
      }

      case "withvibe-human": {
        if (!ctx.agentId) {
          throw new ForbiddenException(
            "withvibe-human requires an agent-bound session"
          );
        }
        // Derive askedOfUserId + targetDisplayName from current DB state so
        // clone-vs-regular-agent routing matches what ChatContextService
        // computed when the JWT was minted. Cheaper than baking these into
        // the JWT.
        const agent = await this.prisma.client.agent.findUnique({
          where: { id: ctx.agentId },
          select: {
            kind: true,
            cloneForUserId: true,
            cloneForUser: { select: { id: true, name: true, email: true } },
          },
        });
        if (!agent) {
          throw new NotFoundException("Agent not found");
        }
        const isClone =
          agent.kind === "member_clone" && !!agent.cloneForUserId;
        const askedOfUserId = isClone ? agent.cloneForUserId! : ctx.userId;

        const members = await this.prisma.client.workspaceMember.findMany({
          where: { workspaceId: ctx.workspaceId },
          select: {
            userId: true,
            user: { select: { name: true, email: true } },
          },
        });
        const scope: DisplayMember[] = members.map((m) => ({
          userId: m.userId,
          name: m.user.name,
          email: m.user.email,
        }));
        const askedOfMember = members.find((m) => m.userId === askedOfUserId);
        const targetDisplayName = isClone
          ? agent.cloneForUser?.name ||
            agent.cloneForUser?.email ||
            "the clone owner"
          : askedOfMember
            ? displayName(
                {
                  userId: askedOfMember.userId,
                  name: askedOfMember.user.name,
                  email: askedOfMember.user.email,
                },
                scope
              )
            : "the teammate";

        return this.humanQuestion.describeMcpServer({
          agentId: ctx.agentId,
          workspaceId: ctx.workspaceId,
          askedOfUserId,
          askerUserId: ctx.userId,
          sessionId: ctx.sessionId,
          envId: ctx.envId,
          targetDisplayName,
        });
      }

      default:
        throw new NotFoundException(`Unknown MCP server: ${serverName}`);
    }
  }
}

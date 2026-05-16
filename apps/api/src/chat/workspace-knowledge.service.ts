import { Injectable } from "@nestjs/common";
import { z } from "zod";
import {
  createSdkMcpServer,
  tool,
  type McpSdkServerConfigWithInstance,
} from "@anthropic-ai/claude-agent-sdk";
import { PrismaService } from "../prisma/prisma.service";
import type {
  McpServerSpec,
  McpToolDescriptor,
} from "../mcp-bridge/mcp-tool-types";

export type WorkspaceKnowledgeRow = {
  slug: string;
  title: string;
  description: string;
  content: string;
};

const SAVE_WORKSPACE_KNOWLEDGE_DESCRIPTION =
  "Save a team-wide FACT that every agent and every teammate should treat as shared ground truth across ALL envs in this workspace. This is for objective, universal facts — NOT behavior rules or personal preferences.\n\nUSE for things like:\n- 'We use PostgreSQL as the primary DB.'\n- 'Our main office timezone is UTC+3.'\n- 'Production deploys run on Fridays.'\n\nDO NOT USE for:\n- A rule about how YOU (a specific agent/clone) should answer → use save_skill instead (scope=workspace). Example: 'I always mention security on task questions' → that's about one clone's behavior, NOT a universal team fact.\n- A preference or opinion of the current speaker → use save_member_memory.\n- Something tied to ONE env (ports, setup quirks) → use save_env_knowledge.\n\nBefore calling, ask yourself: would every teammate — and every other agent in this workspace — want this surfaced as ground truth? If no, pick a different tool. If yes, save. Don't ask permission from the speaker.";

const SAVE_WORKSPACE_KNOWLEDGE_SHAPE = {
  title: z
    .string()
    .min(3)
    .max(100)
    .describe("Short human-readable title, 3-10 words."),
  description: z
    .string()
    .min(10)
    .max(300)
    .describe(
      "One-to-two sentence hook describing WHEN this fact is relevant — future assistants use this to decide if it applies."
    ),
  content: z
    .string()
    .min(10)
    .describe(
      "Markdown body of the fact — the actual note, decision, or rule."
    ),
};

/**
 * Cross-env, team-wide AI-distilled knowledge. Visible in every session
 * across every env in the workspace. Broader tier than EnvKnowledge —
 * use this for company/team/product facts that don't change when you
 * swap envs. Env-specific details (ports, compose quirks) still go in
 * save_env_knowledge.
 */
@Injectable()
export class WorkspaceKnowledgeService {
  constructor(private readonly prisma: PrismaService) {}

  async load(workspaceId: string): Promise<WorkspaceKnowledgeRow[]> {
    return this.prisma.client.workspaceKnowledge.findMany({
      where: { workspaceId },
      select: { slug: true, title: true, description: true, content: true },
      orderBy: { createdAt: "asc" },
    });
  }

  async uniqueSlug(workspaceId: string, title: string): Promise<string> {
    const base =
      title
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 50) || "knowledge";
    let slug = base;
    let n = 1;
    while (true) {
      const existing = await this.prisma.client.workspaceKnowledge.findUnique({
        where: { workspaceId_slug: { workspaceId, slug } },
        select: { id: true },
      });
      if (!existing) return slug;
      n += 1;
      slug = `${base}-${n}`;
    }
  }

  describeMcpServer(workspaceId: string): McpServerSpec {
    const self = this;
    const saveWorkspaceKnowledge: McpToolDescriptor<
      typeof SAVE_WORKSPACE_KNOWLEDGE_SHAPE
    > = {
      name: "save_workspace_knowledge",
      description: SAVE_WORKSPACE_KNOWLEDGE_DESCRIPTION,
      inputShape: SAVE_WORKSPACE_KNOWLEDGE_SHAPE,
      async handler(raw) {
        const input = z.object(SAVE_WORKSPACE_KNOWLEDGE_SHAPE).parse(raw);
        const slug = await self.uniqueSlug(workspaceId, input.title);
        await self.prisma.client.workspaceKnowledge.create({
          data: {
            workspaceId,
            slug,
            title: input.title,
            description: input.description,
            content: input.content,
            source: "ai_self",
          },
        });
        return {
          content: [
            {
              type: "text" as const,
              text: `Workspace knowledge "${input.title}" saved (slug: ${slug}). Visible to every agent and every env in this workspace from their next turn.`,
            },
          ],
        };
      },
    };
    return {
      name: "withvibe-workspace",
      version: "1.0.0",
      tools: [saveWorkspaceKnowledge],
    };
  }

  createMcpServer(workspaceId: string): McpSdkServerConfigWithInstance {
    const spec = this.describeMcpServer(workspaceId);
    return createSdkMcpServer({
      name: spec.name,
      version: spec.version,
      tools: spec.tools.map((t) =>
        tool(t.name, t.description, t.inputShape, t.handler)
      ),
    });
  }
}

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

export type MemberMemoryRow = {
  slug: string;
  title: string;
  description: string;
  content: string;
};

const SAVE_MEMBER_MEMORY_DESCRIPTION =
  "Save a private note about the CURRENT speaker (the human you're talking to right now) — their preferences, expertise, workflow, or personal style. Visible ONLY in this member's sessions across the workspace.\n\nUSE for things like:\n- 'Speaker prefers terse, bullet-pointed answers.'\n- 'Speaker is new to React; explain Next.js concepts from first principles.'\n- 'Speaker owns the payments service.'\n\nDO NOT USE for:\n- Behavior rules about YOU (an agent/clone) → save_skill. Example: 'I always mention security' — that's about how YOU answer, not about the speaker.\n- Facts that apply team-wide → save_workspace_knowledge.\n- Facts tied to one env → save_env_knowledge.\n- Anything the speaker didn't actually disclose to you.";

const SAVE_MEMBER_MEMORY_SHAPE = {
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
      "One-to-two sentence hook describing WHEN this memory is relevant — future assistants use this to decide if it applies."
    ),
  content: z
    .string()
    .min(10)
    .describe(
      "Markdown body of the note itself — the actual fact about this speaker."
    ),
};

/**
 * Per-member private memory. Scoped to (userId, workspaceId) — visible only
 * when that user is the speaker. Populated via the save_member_memory MCP
 * tool during chat. Seeds the member-clone agent in Phase 4.
 */
@Injectable()
export class MemberMemoryService {
  constructor(private readonly prisma: PrismaService) {}

  async load(userId: string, workspaceId: string): Promise<MemberMemoryRow[]> {
    return this.prisma.client.memberMemory.findMany({
      where: { userId, workspaceId },
      select: { slug: true, title: true, description: true, content: true },
      orderBy: { createdAt: "asc" },
    });
  }

  async uniqueSlug(
    userId: string,
    workspaceId: string,
    title: string
  ): Promise<string> {
    const base =
      title
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 50) || "memory";
    let slug = base;
    let n = 1;
    while (true) {
      const existing = await this.prisma.client.memberMemory.findUnique({
        where: {
          userId_workspaceId_slug: { userId, workspaceId, slug },
        },
        select: { id: true },
      });
      if (!existing) return slug;
      n += 1;
      slug = `${base}-${n}`;
    }
  }

  describeMcpServer(userId: string, workspaceId: string): McpServerSpec {
    const self = this;
    const saveMemberMemory: McpToolDescriptor<typeof SAVE_MEMBER_MEMORY_SHAPE> = {
      name: "save_member_memory",
      description: SAVE_MEMBER_MEMORY_DESCRIPTION,
      inputShape: SAVE_MEMBER_MEMORY_SHAPE,
      async handler(raw) {
        const input = z.object(SAVE_MEMBER_MEMORY_SHAPE).parse(raw);
        const slug = await self.uniqueSlug(userId, workspaceId, input.title);
        await self.prisma.client.memberMemory.create({
          data: {
            userId,
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
              text: `Noted privately: "${input.title}" (slug: ${slug}). I'll remember this in our future sessions — your teammates won't see it.`,
            },
          ],
        };
      },
    };
    return {
      name: "withvibe-member",
      version: "1.0.0",
      tools: [saveMemberMemory],
    };
  }

  /**
   * In-process MCP server exposing save_member_memory. The speaker's
   * userId/workspaceId are baked in at server construction, so the tool
   * always writes to the current speaker's memory — AI can't spoof another
   * user.
   */
  createMcpServer(
    userId: string,
    workspaceId: string
  ): McpSdkServerConfigWithInstance {
    const spec = this.describeMcpServer(userId, workspaceId);
    return createSdkMcpServer({
      name: spec.name,
      version: spec.version,
      tools: spec.tools.map((t) =>
        tool(t.name, t.description, t.inputShape, t.handler)
      ),
    });
  }
}

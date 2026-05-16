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

export type EnvKnowledgeRow = {
  slug: string;
  title: string;
  description: string;
  content: string;
};

const SAVE_ENV_KNOWLEDGE_DESCRIPTION =
  "Save a fact that applies ONLY to THIS env — not to other envs in the workspace. The test: if a teammate opens a different env tomorrow, would this fact still apply? If YES, you have the wrong tool — use save_workspace_knowledge instead.\n\nUSE for things like:\n- 'Postgres in this env runs on host port 5434.'\n- 'This env's docker-compose needs CHOKIDAR_USEPOLLING=true on macOS.'\n- 'The /api service in this env points at a staging DB snapshot.'\n\nDO NOT USE for:\n- Team-wide rules or facts → save_workspace_knowledge.\n- Behavior rules about yourself (an agent/clone) → save_skill.\n- Personal notes about the speaker → save_member_memory.\n\nCall proactively once the env-specific test passes. Don't save anything private to the speaker (credentials, personal opinions).";

const SAVE_ENV_KNOWLEDGE_SHAPE = {
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
      "One-to-two sentence hook describing WHEN this fact is relevant — future assistants use this to decide if the knowledge applies."
    ),
  content: z
    .string()
    .min(10)
    .describe(
      "Markdown body of the fact itself — the actual note, decision, or detail."
    ),
};

/**
 * Shared env knowledge: AI-distilled facts scoped to an Env, visible to every
 * member's sessions on that env. Populated via the save_env_knowledge MCP tool
 * during chat — no user CRUD UI in this phase. Pure DB; no filesystem mirror.
 */
@Injectable()
export class EnvKnowledgeService {
  constructor(private readonly prisma: PrismaService) {}

  async load(envId: string): Promise<EnvKnowledgeRow[]> {
    return this.prisma.client.envKnowledge.findMany({
      where: { envId },
      select: { slug: true, title: true, description: true, content: true },
      orderBy: { createdAt: "asc" },
    });
  }

  async uniqueSlug(envId: string, title: string): Promise<string> {
    const base =
      title
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 50) || "knowledge";
    let slug = base;
    let n = 1;
    while (true) {
      const existing = await this.prisma.client.envKnowledge.findUnique({
        where: { envId_slug: { envId, slug } },
        select: { id: true },
      });
      if (!existing) return slug;
      n += 1;
      slug = `${base}-${n}`;
    }
  }

  /**
   * Tool descriptors consumed by both the in-process SDK server (Agent SDK
   * engine) and the HTTP MCP bridge (Claude Code engine). Single source of
   * truth for the tool's schema + handler.
   */
  describeMcpServer(envId: string): McpServerSpec {
    const self = this;
    const saveEnvKnowledge: McpToolDescriptor<typeof SAVE_ENV_KNOWLEDGE_SHAPE> = {
      name: "save_env_knowledge",
      description: SAVE_ENV_KNOWLEDGE_DESCRIPTION,
      inputShape: SAVE_ENV_KNOWLEDGE_SHAPE,
      async handler(raw) {
        const input = z.object(SAVE_ENV_KNOWLEDGE_SHAPE).parse(raw);
        const slug = await self.uniqueSlug(envId, input.title);
        await self.prisma.client.envKnowledge.create({
          data: {
            envId,
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
              text: `Env knowledge "${input.title}" saved (slug: ${slug}). Visible to all teammates on this env from their next turn.`,
            },
          ],
        };
      },
    };

    return {
      name: "withvibe-env",
      version: "1.0.0",
      tools: [saveEnvKnowledge],
    };
  }

  /**
   * In-process MCP server exposing save_env_knowledge. Attached to every
   * chat session (with or without an agent) so the AI can record team-wide
   * facts. The entry is immediately visible to all other sessions via the
   * shared-env-knowledge block in the next context build.
   */
  createMcpServer(envId: string): McpSdkServerConfigWithInstance {
    const spec = this.describeMcpServer(envId);
    return createSdkMcpServer({
      name: spec.name,
      version: spec.version,
      tools: spec.tools.map((t) =>
        tool(t.name, t.description, t.inputShape, t.handler)
      ),
    });
  }
}

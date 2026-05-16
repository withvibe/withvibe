import { Injectable } from "@nestjs/common";
import { mkdir, rm, writeFile } from "fs/promises";
import path from "path";
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

const SAVE_SKILL_DESCRIPTION =
  "Save a behavior rule or recipe that applies specifically to YOU (this agent) — how you should answer, what to always check, a reusable how-to. Scoped to this one agent; other agents in the workspace never see it.\n\nUSE for things like (scope='workspace'):\n- 'I always mention security considerations on implementation questions.'\n- 'I always ask the user to open a Jira ticket before starting work.'\n- 'When someone asks for a code review, I check for error handling, types, and test coverage in that order.'\n\nUSE for (scope='env'):\n- A recipe that only makes sense in one env (e.g. a specific docker-compose setup for THIS env's stack).\n\nDO NOT USE for:\n- Facts every agent should know → save_workspace_knowledge.\n- Notes about a specific teammate → save_member_memory.\n\nPrefer scope='workspace' unless the rule is genuinely env-specific. Call proactively when the user gives you a behavior instruction (\"always do X\", \"remember to Y\"). Don't ask permission — save and briefly tell the user.";

const SAVE_SKILL_SHAPE = {
  name: z
    .string()
    .min(3)
    .max(100)
    .describe("Short human-readable name, 3-8 words."),
  description: z
    .string()
    .min(10)
    .max(300)
    .describe(
      "One-to-two sentence description of WHEN this skill should be invoked. This is how Claude decides whether to use it, so be specific about triggers."
    ),
  content: z
    .string()
    .min(20)
    .describe(
      "Markdown body of the skill — the actual instructions, recipe, or reference."
    ),
  scope: z
    .enum(["env", "workspace"])
    .describe(
      "Use 'env' for facts specific to this env (e.g., port numbers, local paths). Use 'workspace' for general principles that apply across all envs in this team."
    ),
};

export type SkillRow = {
  slug: string;
  name: string;
  description: string;
  content: string;
};

/**
 * Shared helpers for agent chat: skill materialization + the in-process
 * save_skill MCP tool. DB is source-of-truth for skills; filesystem is the
 * mirror Claude reads at chat time via its native Skill discovery (which
 * requires `settingSources: ["project"]` pointing at the env root).
 */
@Injectable()
export class AgentChatService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Load every skill that applies to this agent in this env:
   *   - workspace-scoped (always apply)
   *   - env-scoped matching envId
   */
  async loadApplicableSkills(
    agentId: string,
    envId: string
  ): Promise<SkillRow[]> {
    return this.prisma.client.agentSkill.findMany({
      where: {
        agentId,
        OR: [{ scope: "workspace" }, { scope: "env", envId }],
      },
      select: {
        slug: true,
        name: true,
        description: true,
        content: true,
      },
      orderBy: { createdAt: "asc" },
    });
  }

  /**
   * Write every applicable skill as SKILL.md under `<envDir>/.claude/skills/`.
   * Clobbers the dir first so deleted skills don't linger. Idempotent.
   */
  async materializeSkills(envDir: string, skills: SkillRow[]): Promise<void> {
    const skillsDir = path.join(envDir, ".claude", "skills");
    await rm(skillsDir, { recursive: true, force: true }).catch(() => {});
    if (skills.length === 0) return;
    await mkdir(skillsDir, { recursive: true });

    for (const skill of skills) {
      const dir = path.join(skillsDir, skill.slug);
      await mkdir(dir, { recursive: true });
      const frontmatter = [
        "---",
        `name: ${skill.name}`,
        `description: ${yamlEscape(skill.description)}`,
        "---",
        "",
      ].join("\n");
      await writeFile(
        path.join(dir, "SKILL.md"),
        frontmatter + skill.content,
        "utf-8"
      );
    }
  }

  /**
   * Multi-agent skill materialization for orchestrator sessions. Each skill
   * dir is prefixed with its owning agent's slug so skills from different
   * agents don't collide. Returns per-agent arrays of prefixed dir names —
   * suitable for passing straight to `AgentDefinition.skills`.
   *
   * Clobbers `.claude/skills/` up-front so stale skills don't linger across
   * turns or between orchestrator and agent-bound modes.
   */
  async materializeSkillsForManyAgents(
    envDir: string,
    perAgent: { agentSlug: string; skills: SkillRow[] }[]
  ): Promise<Record<string, string[]>> {
    const skillsDir = path.join(envDir, ".claude", "skills");
    await rm(skillsDir, { recursive: true, force: true }).catch(() => {});
    const result: Record<string, string[]> = {};
    const total = perAgent.reduce((a, x) => a + x.skills.length, 0);
    if (total === 0) return result;
    await mkdir(skillsDir, { recursive: true });

    for (const { agentSlug, skills } of perAgent) {
      const names: string[] = [];
      for (const skill of skills) {
        const prefixed = `${agentSlug}--${skill.slug}`;
        const dir = path.join(skillsDir, prefixed);
        await mkdir(dir, { recursive: true });
        const frontmatter = [
          "---",
          `name: ${skill.name}`,
          `description: ${yamlEscape(skill.description)}`,
          "---",
          "",
        ].join("\n");
        await writeFile(
          path.join(dir, "SKILL.md"),
          frontmatter + skill.content,
          "utf-8"
        );
        names.push(prefixed);
      }
      result[agentSlug] = names;
    }
    return result;
  }

  async uniqueSkillSlug(
    agentId: string,
    envId: string | null,
    name: string
  ): Promise<string> {
    const base =
      name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 50) || "skill";
    let slug = base;
    let n = 1;
    // AgentSkill has @@unique([agentId, envId, slug]). Collide → suffix.
    while (true) {
      const existing = await this.prisma.client.agentSkill.findFirst({
        where: { agentId, envId, slug },
        select: { id: true },
      });
      if (!existing) return slug;
      n += 1;
      slug = `${base}-${n}`;
    }
  }

  describeAgentMcpServer(args: {
    agentId: string;
    envId: string;
    envDir: string;
  }): McpServerSpec {
    const self = this;
    const saveSkill: McpToolDescriptor<typeof SAVE_SKILL_SHAPE> = {
      name: "save_skill",
      description: SAVE_SKILL_DESCRIPTION,
      inputShape: SAVE_SKILL_SHAPE,
      async handler(raw) {
        const input = z.object(SAVE_SKILL_SHAPE).parse(raw);
        const slug = await self.uniqueSkillSlug(
          args.agentId,
          input.scope === "env" ? args.envId : null,
          input.name
        );
        await self.prisma.client.agentSkill.create({
          data: {
            agentId: args.agentId,
            scope: input.scope,
            envId: input.scope === "env" ? args.envId : null,
            slug,
            name: input.name,
            description: input.description,
            content: input.content,
            source: "ai_self",
          },
        });

        const skillsDir = path.join(args.envDir, ".claude", "skills", slug);
        await mkdir(skillsDir, { recursive: true });
        const frontmatter = [
          "---",
          `name: ${input.name}`,
          `description: ${yamlEscape(input.description)}`,
          "---",
          "",
        ].join("\n");
        await writeFile(
          path.join(skillsDir, "SKILL.md"),
          frontmatter + input.content,
          "utf-8"
        );

        return {
          content: [
            {
              type: "text" as const,
              text: `Skill "${input.name}" saved (slug: ${slug}, scope: ${input.scope}).`,
            },
          ],
        };
      },
    };
    return {
      name: "withvibe-agent",
      version: "1.0.0",
      tools: [saveSkill],
    };
  }

  /**
   * Factory for the in-process MCP server that exposes `save_skill` to the
   * agent during chat. Handler dual-writes DB + SKILL.md file so the skill
   * is discoverable in the same session (next turn).
   */
  createAgentMcpServer(args: {
    agentId: string;
    envId: string;
    envDir: string;
  }): McpSdkServerConfigWithInstance {
    const spec = this.describeAgentMcpServer(args);
    return createSdkMcpServer({
      name: spec.name,
      version: spec.version,
      tools: spec.tools.map((t) =>
        tool(t.name, t.description, t.inputShape, t.handler)
      ),
    });
  }
}

function yamlEscape(s: string): string {
  const needsQuotes = /[:#\n"'\\]/.test(s) || s.includes("  ");
  if (!needsQuotes) return s;
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, " ")}"`;
}

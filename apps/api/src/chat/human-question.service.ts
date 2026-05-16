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

const ASK_HUMAN_SHAPE = {
  question: z
    .string()
    .min(10)
    .max(1000)
    .describe(
      "The question in plain English. Self-contained: include any context the human needs to answer without the chat history."
    ),
};

/**
 * `ask_human` MCP tool: agents escalate a question to a real teammate.
 * Async — the agent doesn't block waiting. Question lands in the target's
 * inbox; when answered, the answer auto-becomes a MemberMemory so the
 * agent picks it up on the next turn.
 *
 * Target is baked in per session:
 *   - Clone agents → the clone's owner
 *   - Regular agents → the current speaker
 */
@Injectable()
export class HumanQuestionService {
  constructor(private readonly prisma: PrismaService) {}

  describeMcpServer(opts: {
    agentId: string;
    workspaceId: string;
    askedOfUserId: string;
    askerUserId: string;
    sessionId: string | null;
    envId: string;
    targetDisplayName: string;
  }): McpServerSpec {
    const self = this;
    const askHuman: McpToolDescriptor<typeof ASK_HUMAN_SHAPE> = {
      name: "ask_human",
      description: `Ask ${opts.targetDisplayName} directly when you're uncertain about something only they would know. The question is DELIVERED ASYNCHRONOUSLY — you won't block waiting for a response; they'll answer from their inbox when they can. Their answer will be saved as memory and show up in your next turn. Use this sparingly: only when the answer can't be inferred from repo, env knowledge, or prior memory. Don't ask for permission from the current speaker — just call the tool, tell the speaker you've escalated, and continue with what you CAN answer now.`,
      inputShape: ASK_HUMAN_SHAPE,
      async handler(raw) {
        const input = z.object(ASK_HUMAN_SHAPE).parse(raw);
        await self.prisma.client.humanQuestion.create({
          data: {
            agentId: opts.agentId,
            workspaceId: opts.workspaceId,
            askedOfUserId: opts.askedOfUserId,
            askerUserId: opts.askerUserId,
            sessionId: opts.sessionId,
            envId: opts.envId,
            question: input.question,
            status: "pending",
          },
        });
        return {
          content: [
            {
              type: "text" as const,
              text: `Question queued for ${opts.targetDisplayName}. It will appear in their inbox; their answer will surface the next time you're invoked.`,
            },
          ],
        };
      },
    };
    return {
      name: "withvibe-human",
      version: "1.0.0",
      tools: [askHuman],
    };
  }

  createMcpServer(opts: {
    agentId: string;
    workspaceId: string;
    askedOfUserId: string;
    askerUserId: string;
    sessionId: string | null;
    envId: string;
    targetDisplayName: string;
  }): McpSdkServerConfigWithInstance {
    const spec = this.describeMcpServer(opts);
    return createSdkMcpServer({
      name: spec.name,
      version: spec.version,
      tools: spec.tools.map((t) =>
        tool(t.name, t.description, t.inputShape, t.handler)
      ),
    });
  }

  /** Inbox list for the calling user. */
  async listForUser(userId: string, workspaceId: string) {
    return this.prisma.client.humanQuestion.findMany({
      where: { askedOfUserId: userId, workspaceId },
      orderBy: [{ status: "asc" }, { createdAt: "desc" }],
      select: {
        id: true,
        question: true,
        answer: true,
        status: true,
        createdAt: true,
        answeredAt: true,
        agent: { select: { id: true, name: true, slug: true, kind: true } },
        askerUser: { select: { id: true, name: true, email: true } },
        session: { select: { id: true, title: true } },
        env: { select: { id: true, title: true } },
      },
    });
  }

  async pendingCount(userId: string, workspaceId: string): Promise<number> {
    return this.prisma.client.humanQuestion.count({
      where: { askedOfUserId: userId, workspaceId, status: "pending" },
    });
  }

  /**
   * Answer a question. Closes the loop + auto-writes a MemberMemory so
   * the agent that asked sees the answer on its next turn (via the normal
   * per-speaker memory block).
   */
  async answer(userId: string, questionId: string, answer: string) {
    const trimmed = answer.trim();
    if (trimmed.length < 1) {
      throw new Error("Answer cannot be empty");
    }
    const q = await this.prisma.client.humanQuestion.findUnique({
      where: { id: questionId },
      select: {
        id: true,
        askedOfUserId: true,
        workspaceId: true,
        status: true,
        question: true,
        agent: { select: { name: true } },
      },
    });
    if (!q || q.askedOfUserId !== userId) {
      throw new Error("Question not found");
    }
    if (q.status !== "pending") {
      throw new Error("Question already closed");
    }

    // Mark answered + spawn a MemberMemory so the asking agent picks it up.
    await this.prisma.client.$transaction(async (tx) => {
      await tx.humanQuestion.update({
        where: { id: questionId },
        data: {
          answer: trimmed,
          status: "answered",
          answeredAt: new Date(),
        },
      });

      const slug = await this.uniqueMemorySlug(
        tx,
        userId,
        q.workspaceId,
        q.question
      );
      await tx.memberMemory.create({
        data: {
          userId,
          workspaceId: q.workspaceId,
          slug,
          title: this.titleFromQuestion(q.question),
          description: `Q&A from ${q.agent?.name ?? "agent"}: answer given by the clone owner.`,
          content: `**Question (asked by ${q.agent?.name ?? "agent"}):** ${q.question}\n\n**Answer:** ${trimmed}`,
          source: "ai_from_correction",
        },
      });
    });

    return { ok: true };
  }

  async dismiss(userId: string, questionId: string) {
    const q = await this.prisma.client.humanQuestion.findUnique({
      where: { id: questionId },
      select: { askedOfUserId: true, status: true },
    });
    if (!q || q.askedOfUserId !== userId) {
      throw new Error("Question not found");
    }
    if (q.status !== "pending") return { ok: true };
    await this.prisma.client.humanQuestion.update({
      where: { id: questionId },
      data: { status: "dismissed", answeredAt: new Date() },
    });
    return { ok: true };
  }

  private titleFromQuestion(question: string): string {
    const first = question.trim().replace(/\s+/g, " ");
    return first.length <= 80 ? first : first.slice(0, 77) + "…";
  }

  private async uniqueMemorySlug(
    tx: {
      memberMemory: {
        findUnique: (args: {
          where: {
            userId_workspaceId_slug: {
              userId: string;
              workspaceId: string;
              slug: string;
            };
          };
          select: { id: true };
        }) => Promise<{ id: string } | null>;
      };
    },
    userId: string,
    workspaceId: string,
    question: string
  ): Promise<string> {
    const base =
      this.titleFromQuestion(question)
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 40) || "answer";
    let slug = `ask-${base}`;
    let n = 1;
    while (true) {
      const existing = await tx.memberMemory.findUnique({
        where: { userId_workspaceId_slug: { userId, workspaceId, slug } },
        select: { id: true },
      });
      if (!existing) return slug;
      n += 1;
      slug = `ask-${base}-${n}`;
    }
  }
}

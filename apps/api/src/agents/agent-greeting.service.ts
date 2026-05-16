import { Injectable, Logger } from "@nestjs/common";
import Anthropic from "@anthropic-ai/sdk";
import { PrismaService } from "../prisma/prisma.service";

/**
 * Haiku-generated first-message greetings for agents. Fire-and-forget via
 * best-effort sync path (slug already returned; fallback used on failure).
 * Mirrors title-generator: silent on failure, API-key-only (no OAuth tokens).
 */
@Injectable()
export class AgentGreetingService {
  private readonly logger = new Logger(AgentGreetingService.name);

  constructor(private readonly prisma: PrismaService) {}

  fallbackGreeting(name: string): string {
    return `Hi, I'm ${name}. How can I help?`;
  }

  async generate(opts: {
    workspaceId: string;
    name: string;
    description: string;
    systemPrompt: string;
  }): Promise<string> {
    const fallback = this.fallbackGreeting(opts.name);
    try {
      const workspace = await this.prisma.client.workspace.findUnique({
        where: { id: opts.workspaceId },
        select: { anthropicApiKey: true },
      });
      const apiKey =
        workspace?.anthropicApiKey || process.env.ANTHROPIC_API_KEY;
      if (!apiKey || apiKey.startsWith("sk-ant-oat")) return fallback;

      const client = new Anthropic({ apiKey });
      const response = await client.messages.create({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 120,
        messages: [
          {
            role: "user",
            content:
              `Write a short, friendly first-message greeting for a chat agent. The agent will use it verbatim to greet a teammate opening a new session.\n\n` +
              `Agent name: ${opts.name}\n` +
              `Agent description: ${opts.description}\n` +
              `Agent system prompt (for context on personality/purpose — don't quote it):\n${opts.systemPrompt.slice(0, 500)}\n\n` +
              `Rules:\n` +
              `- 1-2 sentences, ≤ 25 words total\n` +
              `- First-person ("I'm ${opts.name}, ...")\n` +
              `- End by inviting the teammate to describe what they're working on\n` +
              `- Warm but not saccharine; match the agent's purpose\n` +
              `- No quotes, no emojis, no trailing punctuation beyond a period\n\n` +
              `Respond with only the greeting.`,
          },
        ],
      });
      const text = response.content
        .map((b) =>
          (b as { type: string; text?: string }).type === "text"
            ? (b as { text?: string }).text || ""
            : ""
        )
        .join("")
        .trim()
        .replace(/^["'`“”‘’]+|["'`“”‘’]+$/g, "")
        .replace(/\s+/g, " ")
        .slice(0, 240);
      return text || fallback;
    } catch (err) {
      this.logger.warn(`agent-greeting failed: ${err}`);
      return fallback;
    }
  }
}

import { Injectable } from "@nestjs/common";
import Anthropic from "@anthropic-ai/sdk";
import { PrismaService } from "../prisma/prisma.service";
import { InjectPinoLogger, PinoLogger } from "nestjs-pino";

/**
 * Haiku-generated short titles for chat sessions. Fire-and-forget — silent
 * on failure so the deterministic first-line fallback stays. Note: only
 * accepts standard API keys (sk-ant-api03-*). OAuth tokens won't work here.
 */
@Injectable()
export class TitleGeneratorService {
  constructor(
    @InjectPinoLogger(TitleGeneratorService.name)
    private readonly logger: PinoLogger,
    private readonly prisma: PrismaService
  ) {}

  async generate(opts: {
    sessionId: string;
    firstMessage: string;
    workspaceId: string;
  }): Promise<void> {
    try {
      // Resolution order matches the chat path: the session owner's personal
      // key (set on /account) wins, then the workspace key, then the server env.
      const [session, workspace] = await Promise.all([
        this.prisma.client.chatSession.findUnique({
          where: { id: opts.sessionId },
          select: { user: { select: { anthropicApiKey: true } } },
        }),
        this.prisma.client.workspace.findUnique({
          where: { id: opts.workspaceId },
          select: { anthropicApiKey: true },
        }),
      ]);
      const apiKey =
        session?.user?.anthropicApiKey?.trim() ||
        workspace?.anthropicApiKey ||
        process.env.ANTHROPIC_API_KEY;
      if (!apiKey) return;
      // OAuth tokens aren't supported by the raw SDK — skip silently.
      if (apiKey.startsWith("sk-ant-oat")) return;

      const client = new Anthropic({ apiKey });
      const response = await client.messages.create({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 30,
        messages: [
          {
            role: "user",
            content:
              "Give this developer chat thread a short, descriptive title.\n\n" +
              "Rules:\n" +
              "- 3 to 6 words\n" +
              "- no quotes, no trailing punctuation\n" +
              "- title-case the first word only\n" +
              '- be specific (use concrete nouns: "Fix postgres exit code" not "Debug issue")\n\n' +
              "User's first message:\n" +
              opts.firstMessage.slice(0, 600) +
              "\n\nRespond with only the title.",
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
        .replace(/[.!?,;:]+$/g, "")
        .replace(/\s+/g, " ")
        .slice(0, 60);

      if (!text) return;

      const current = await this.prisma.client.chatSession.findUnique({
        where: { id: opts.sessionId },
        select: { title: true },
      });
      if (!current) return;

      const fallback = opts.firstMessage
        .split("\n")
        .map((l) => l.trim())
        .find(Boolean);
      const isFallback =
        !!fallback &&
        (current.title === fallback ||
          current.title === fallback.slice(0, 42).trimEnd() + "…" ||
          (current.title &&
            fallback.startsWith(current.title.replace(/…$/, ""))));

      if (!isFallback) return;

      await this.prisma.client.chatSession.update({
        where: { id: opts.sessionId },
        data: { title: text },
      });
    } catch (err) {
      this.logger.warn(`title-generator failed: ${err}`);
    }
  }
}

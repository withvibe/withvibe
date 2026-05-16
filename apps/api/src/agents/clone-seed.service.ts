import { Injectable, Logger } from "@nestjs/common";
import Anthropic from "@anthropic-ai/sdk";
import { PrismaService } from "../prisma/prisma.service";
import { positionLabel } from "@withvibe/db";

export type CloneSeed = {
  name: string;
  description: string;
  systemPrompt: string;
};

/**
 * Seeds a member-clone agent's initial persona from the user's profile
 * and their recent workspace messages. Haiku produces description +
 * systemPrompt. Falls back to static defaults on failure.
 */
@Injectable()
export class CloneSeedService {
  private readonly logger = new Logger(CloneSeedService.name);

  constructor(private readonly prisma: PrismaService) {}

  async generate(opts: {
    userId: string;
    workspaceId: string;
  }): Promise<CloneSeed> {
    const user = await this.prisma.client.user.findUnique({
      where: { id: opts.userId },
      select: {
        id: true,
        name: true,
        email: true,
        positions: true,
        bio: true,
      },
    });
    const displayName = user?.name || user?.email?.split("@")[0] || "teammate";
    const fallback: CloneSeed = {
      name: `${displayName}'s clone`,
      description: `AI clone of ${displayName} — answers on their behalf when they're unavailable.`,
      systemPrompt: this.defaultPrompt(displayName, user),
    };
    if (!user) return fallback;

    const workspace = await this.prisma.client.workspace.findUnique({
      where: { id: opts.workspaceId },
      select: { anthropicApiKey: true },
    });
    const apiKey =
      workspace?.anthropicApiKey || process.env.ANTHROPIC_API_KEY;
    if (!apiKey || apiKey.startsWith("sk-ant-oat")) return fallback;

    // Collect recent messages by this user in this workspace.
    const msgs = await this.prisma.client.message.findMany({
      where: {
        userId: opts.userId,
        role: "user",
        env: { workspaceId: opts.workspaceId },
      },
      orderBy: { createdAt: "desc" },
      take: 80,
      select: { content: true },
    });
    const sample = msgs
      .map((m) => m.content)
      .filter((c) => c.trim().length > 0)
      .slice(0, 80)
      .map((c) => `- ${c.slice(0, 280).replace(/\n/g, " ")}`)
      .join("\n");

    const positions = (user.positions ?? []).map(positionLabel).join(", ");

    const prompt =
      `You are writing the persona / system-prompt for an AI clone of a real teammate. The clone will be invokable by their teammates as a chat agent when the real person is unavailable.\n\n` +
      `CRITICAL FRAMING: the clone must answer FROM THE PERSPECTIVE OF ${displayName}'S ROLE, not as a generic AI assistant. A CEO's clone should answer strategically (product vision, business trade-offs, team-level decisions) — NOT in line-by-line technical detail. A Designer's clone should answer about UX, flows, visual language. A Backend Engineer's clone should answer about APIs, data models, infra. When the role is unambiguous, the clone's default stance should match it; don't slide into "developer talk" unless the role is actually engineering. If someone asks a question outside the role's remit, the clone should reframe it through the role's lens (e.g., a CEO answering an implementation question should focus on priorities, risk, and tradeoffs rather than code-level details) OR escalate via ask_human.\n\n` +
      `Teammate profile:\n` +
      `- Display name: ${displayName}\n` +
      (positions ? `- Role(s): ${positions}\n` : "- Role(s): (not specified on profile — infer conservatively)\n") +
      (user.bio ? `- Bio: ${user.bio}\n` : "") +
      `\nRecent messages they've written in chat (most recent first):\n` +
      (sample || "(no prior messages on record)") +
      `\n\nProduce TWO sections separated by the exact delimiters shown. No preamble.\n\n` +
      `===DESCRIPTION===\n` +
      `<one-line description of the clone, ≤ 120 chars. Shown to teammates in the agent list. Third person. MENTION THEIR ROLE if known.>\n\n` +
      `===SYSTEMPROMPT===\n` +
      `<multi-paragraph system prompt, ≤ 500 words. Speak AS INSTRUCTIONS TO THE CLONE. Structure:\n\n` +
      `1) ROLE-FIRST opener: begin with "You are an AI clone of ${displayName}${positions ? `, ${positions}` : ""}. Answer everything through the lens of that role." — explicitly.\n` +
      `2) What their role cares about (scope of concern, level of abstraction they operate at). Be specific to the role, not generic.\n` +
      `3) Recurring topics / themes inferred from their messages — but filtered through the role. If their messages are technical but their role is CEO, emphasize the strategic/product framing around those topics, not implementation depth.\n` +
      `4) Communication style (brief/detailed, formal/casual).\n` +
      `5) Known preferences, opinions, or conventions they've expressed.\n` +
      `6) Close with VERBATIM the following memory-tool guidance block (reformat naturally but preserve the tier assignments):\n` +
      `   "You have four save_* tools and a strict rule about which to use:\n` +
      `   - save_skill (scope='workspace'): YOUR DEFAULT for durable behavior rules about how you should answer — e.g. 'always mention security on task questions', 'prefer brief replies'. This is your main 'grow over time' channel. Visible in every chat with you across every env.\n` +
      `   - save_workspace_knowledge: team-wide FACTS that apply to everyone, not just you (e.g. 'our main DB is Postgres', 'we use Jira for all tasks'). Not your behavior — a fact anyone would benefit from.\n` +
      `   - save_env_knowledge: facts that only make sense inside a specific env (ports, compose quirks, that env's setup). Rarely needed.\n` +
      `   - save_member_memory: private notes about the CURRENT SPEAKER (not about ${displayName}). For most clone conversations you won't need this.\n` +
      `   When in doubt, use save_skill — it's the clone-specific 'this is how I work' channel. Do NOT reference filesystem memory files or MEMORY.md; those are SDK internals and not authoritative. Only the four save_* tools persist.\n` +
      `   If you need an answer only ${displayName} would know, use ask_human."\n\n` +
      `Do NOT fabricate details not supported by the profile or messages. Prefer conservative, honest language. Do NOT default to developer tone unless the role is engineering.>`;

    try {
      const client = new Anthropic({ apiKey });
      const response = await client.messages.create({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 900,
        messages: [{ role: "user", content: prompt }],
      });
      const text = response.content
        .map((b) =>
          (b as { type: string; text?: string }).type === "text"
            ? (b as { text?: string }).text || ""
            : ""
        )
        .join("")
        .trim();
      const parsed = this.parseSections(text);
      if (!parsed) return fallback;
      return {
        name: fallback.name,
        description: parsed.description || fallback.description,
        systemPrompt: parsed.systemPrompt || fallback.systemPrompt,
      };
    } catch (err) {
      this.logger.warn(`clone-seed failed: ${err}`);
      return fallback;
    }
  }

  private parseSections(
    text: string
  ): { description: string; systemPrompt: string } | null {
    const descMatch = text.match(
      /===DESCRIPTION===\s*([\s\S]*?)\s*===SYSTEMPROMPT===/
    );
    const promptMatch = text.match(/===SYSTEMPROMPT===\s*([\s\S]*?)\s*$/);
    if (!descMatch || !promptMatch) return null;
    return {
      description: descMatch[1].trim().slice(0, 280),
      systemPrompt: promptMatch[1].trim(),
    };
  }

  private defaultPrompt(
    displayName: string,
    user: {
      positions?: string[];
      bio?: string | null;
    } | null
  ): string {
    const positions = (user?.positions ?? []).map(positionLabel).join(", ");
    const roleLine = positions ? `, ${positions}` : "";
    const bioLine = user?.bio ? `\n\nAbout them: ${user.bio}` : "";
    const roleFocus = positions
      ? `Answer everything through the lens of your role (${positions}) — not as a generic AI assistant. Match the level of abstraction and concerns that role operates at. If someone asks about something outside your role's remit, either reframe it through your role's perspective or escalate.`
      : `Answer as ${displayName} would, matching the level of abstraction and concerns they'd bring. If you're unsure of their perspective, escalate rather than guessing.`;
    return `You are an AI clone of ${displayName}${roleLine}.${bioLine}

${roleFocus}

Act on ${displayName}'s behalf when they're unavailable. Be honest about what you don't know.

## Memory tools — which to use when

- **save_skill (scope='workspace')**: your DEFAULT for durable behavior rules about how you should answer (e.g. "always mention security on task questions"). Visible in every chat with you across every env. This is your main "grow over time" channel.
- **save_workspace_knowledge**: team-wide FACTS everyone benefits from (not your behavior — e.g. "our main DB is Postgres").
- **save_env_knowledge**: facts tied to ONE specific env (ports, compose quirks). Rare.
- **save_member_memory**: private notes about the current SPEAKER (not about ${displayName}). Rarely needed by a clone.
- **ask_human**: escalate to ${displayName} when only they can answer.

When in doubt, use save_skill. Do NOT reference filesystem memory or MEMORY.md files — those are SDK internals and not authoritative. Only the save_* tools persist.`;
  }
}

import { Injectable } from "@nestjs/common";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { PrismaService } from "../prisma/prisma.service";
import type { TemplateService, TemplateVariable } from "./template.types";
import { InjectPinoLogger, PinoLogger } from "nestjs-pino";

export type BindContext = {
  workspaceId: string;
  envTitle: string | null;
  envDescription: string | null;
  routingMode: "port" | "subdomain";
  routingBaseDomain: string | null;
  composeFile: string;
  resolvedVars: Record<string, string>;   // already-bound vars, for consistency
  emptyVars: TemplateVariable[];          // vars the deterministic resolver left empty
  agentInstructions?: string | null;      // template-wide guidance from the author
  services?: TemplateService[];           // per-service descriptions/roles/instructions
};

export type BindResult = {
  // Only vars the agent successfully proposed a value for. Missing keys stay
  // empty in the caller's resolvedVars map.
  proposals: Record<string, string>;
};

/**
 * Fills template variables that the deterministic resolver left empty, by
 * asking Claude Haiku to propose values from the surrounding context (compose
 * file, env metadata, other resolved vars, and each var's `description`).
 *
 * Fire-and-forget on errors: if Claude is unreachable or the response can't
 * be parsed, we return no proposals and let the caller write `.env` with the
 * empty string. Materialization is never blocked by agent flakiness.
 */
@Injectable()
export class AgentVariableBinderService {
  constructor(
    @InjectPinoLogger(AgentVariableBinderService.name)
    private readonly logger: PinoLogger,
    private readonly prisma: PrismaService
  ) {}

  async bindEmpty(ctx: BindContext): Promise<BindResult> {
    if (ctx.emptyVars.length === 0) return { proposals: {} };

    this.logger.info(
      `Agent binding: ${ctx.emptyVars.length} empty var(s) → ` +
        `[${ctx.emptyVars.map((v) => v.key).join(", ")}]`
    );

    const workspace = await this.prisma.client.workspace.findUnique({
      where: { id: ctx.workspaceId },
      select: { anthropicApiKey: true },
    });
    const key =
      workspace?.anthropicApiKey ||
      process.env.ANTHROPIC_API_KEY ||
      process.env.CLAUDE_CODE_OAUTH_TOKEN;
    if (!key) {
      this.logger.warn(
        "No Anthropic credential available — skipping agent-side variable binding"
      );
      return { proposals: {} };
    }

    // Route the credential by format. The Agent SDK reads these env vars:
    //   sk-ant-oat* → CLAUDE_CODE_OAUTH_TOKEN (Max/Pro subscription)
    //   sk-ant-api* → ANTHROPIC_API_KEY (standard API billing)
    const env: Record<string, string | undefined> = { ...process.env };
    if (key.startsWith("sk-ant-oat")) {
      env.CLAUDE_CODE_OAUTH_TOKEN = key;
      delete env.ANTHROPIC_API_KEY;
    } else {
      env.ANTHROPIC_API_KEY = key;
      delete env.CLAUDE_CODE_OAUTH_TOKEN;
    }

    const prompt = this.buildPrompt(ctx);

    try {
      const q = query({
        prompt,
        options: {
          model: "claude-haiku-4-5-20251001",
          systemPrompt: "You are a DevOps assistant. Respond with ONLY a JSON object — no prose, no markdown fences.",
          env: env as Record<string, string>,
          permissionMode: "bypassPermissions",
          allowDangerouslySkipPermissions: true,
        },
      });

      let text = "";
      for await (const msg of q) {
        if (msg.type === "assistant") {
          const content = (msg as { message?: { content?: unknown[] } }).message
            ?.content;
          if (Array.isArray(content)) {
            for (const block of content) {
              const b = block as { type?: string; text?: string };
              if (b.type === "text" && typeof b.text === "string") {
                text += b.text;
              }
            }
          }
        }
      }
      text = text.trim();

      const parsed = this.extractJson(text);
      if (!parsed) {
        this.logger.warn(
          "Agent variable binder: could not parse JSON from response"
        );
        return { proposals: {} };
      }

      // Only accept proposals for vars the caller actually asked about, and
      // only non-empty string values.
      const allowed = new Set(ctx.emptyVars.map((v) => v.key));
      const proposals: Record<string, string> = {};
      for (const [k, v] of Object.entries(parsed)) {
        if (!allowed.has(k)) continue;
        if (typeof v !== "string" || v.length === 0) continue;
        proposals[k] = v;
      }

      this.logger.info(
        `Agent returned ${Object.keys(proposals).length} proposal(s)` +
          (Object.keys(proposals).length > 0
            ? `: ${Object.entries(proposals)
                .map(([k, v]) => `${k}=${v}`)
                .join(", ")}`
            : " (raw response: " + text.slice(0, 200) + ")")
      );
      return { proposals };
    } catch (err) {
      this.logger.warn(`Agent variable binder failed: ${err}`);
      return { proposals: {} };
    }
  }

  private buildPrompt(ctx: BindContext): string {
    const varList = ctx.emptyVars
      .map((v) => {
        const bits = [
          `- key: ${v.key}`,
          `  kind: ${v.kind}`,
          v.description ? `  description: ${v.description}` : null,
          v.label ? `  label: ${v.label}` : null,
          v.service ? `  compose service: ${v.service}` : null,
          v.portKey ? `  port variable: ${v.portKey}` : null,
        ].filter(Boolean);
        return bits.join("\n");
      })
      .join("\n\n");

    const resolvedSnapshot =
      Object.entries(ctx.resolvedVars)
        .filter(([, v]) => v.length > 0)
        .map(([k, v]) => `  ${k}=${v}`)
        .join("\n") || "  (none)";

    const servicesBlock =
      ctx.services && ctx.services.length > 0
        ? [
            "",
            "Template author's notes on each service:",
            ...ctx.services.map((s) => {
              const bits = [`- ${s.name}`];
              if (s.role) bits.push(`  role: ${s.role}`);
              if (s.userFacing) bits.push(`  user-facing: yes`);
              if (s.description) bits.push(`  description: ${s.description}`);
              if (s.agentInstructions)
                bits.push(`  instructions: ${s.agentInstructions}`);
              return bits.join("\n");
            }),
          ].join("\n")
        : "";

    const authorInstructions =
      ctx.agentInstructions && ctx.agentInstructions.trim()
        ? [
            "",
            "Template author's instructions to you (follow these unless they",
            "conflict with the rules below):",
            ctx.agentInstructions.trim(),
          ].join("\n")
        : "";

    return [
      "You are the DevOps agent for a docker-compose dev environment.",
      "A template was just materialized into a new env. The deterministic",
      "resolver left some variables empty. Propose a value for each, using",
      "the compose file, already-resolved variables, and the env context.",
      "",
      `Env title: ${ctx.envTitle ?? "(untitled)"}`,
      `Env description: ${ctx.envDescription ?? "(none)"}`,
      `Routing mode: ${ctx.routingMode}`,
      ctx.routingBaseDomain ? `Base domain: ${ctx.routingBaseDomain}` : "",
      authorInstructions,
      "",
      "docker-compose.yml:",
      "```yaml",
      ctx.composeFile,
      "```",
      servicesBlock,
      "",
      "Already-resolved variables (do NOT re-propose these):",
      resolvedSnapshot,
      "",
      "Variables to bind:",
      varList,
      "",
      "Respond with ONLY a JSON object mapping variable key → proposed value.",
      'Example: {"API_URL":"http://backend-abc.localhost","DB_HOST":"mysql"}',
      "",
      "Rules:",
      "- Use concrete values, not placeholders.",
      "- For service-url kind: use http://<service>-<id>.<baseDomain>",
      "  format in subdomain mode. In port mode, use http://<host>:<port>.",
      "- If you genuinely can't infer a value, omit the key from the JSON.",
      "- Do NOT include explanations, commentary, or markdown fences.",
    ]
      .filter(Boolean)
      .join("\n");
  }

  private extractJson(text: string): Record<string, unknown> | null {
    // Haiku sometimes wraps JSON in ``` fences despite being told not to.
    const cleaned = text
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/\s*```\s*$/i, "")
      .trim();
    try {
      const parsed = JSON.parse(cleaned);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // try to find the first {...} block
      const match = cleaned.match(/\{[\s\S]*\}/);
      if (match) {
        try {
          const parsed = JSON.parse(match[0]);
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
            return parsed as Record<string, unknown>;
          }
        } catch {
          /* fall through */
        }
      }
    }
    return null;
  }
}

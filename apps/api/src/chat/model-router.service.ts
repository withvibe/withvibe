import { Injectable, Logger } from "@nestjs/common";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { createHash } from "node:crypto";
import {
  ConcreteModelId,
  DEFAULT_MODEL,
  ModelChoice,
  isModelChoice,
} from "./models";

// Maps the per-turn classification tier to a concrete Claude model id.
const TIER_TO_MODEL: Record<"simple" | "medium" | "hard", ConcreteModelId> = {
  simple: "claude-haiku-4-5",
  medium: "claude-sonnet-4-6",
  hard: "claude-opus-4-7",
};

// Five-minute in-memory cache of (prompt-hash → tier). Keeps retries and
// regenerates from re-billing the classifier. Process-local; no need for
// cross-instance coherence — wrong tier on a stale key just costs one extra
// classification call later.
const CACHE_TTL_MS = 5 * 60 * 1000;
const cache = new Map<string, { tier: keyof typeof TIER_TO_MODEL; at: number }>();
// Bump when classifier rules change so in-flight cache entries don't keep
// serving the old tier mapping after a deploy. Cheap and impossible to forget
// because tweaking the rules and not bumping this would silently keep stale
// behavior alive for 5 min on every long-running process.
const CLASSIFIER_RULES_VERSION = "v2-survey-medium";

@Injectable()
export class ModelRouterService {
  private readonly logger = new Logger(ModelRouterService.name);

  /**
   * Resolve the model to use for one chat turn. Precedence:
   *   1. Env override (`env.modelChoice`) — null/undefined falls through.
   *   2. Workspace default (`workspace.defaultModel`).
   *   3. If the resolved choice is a concrete id → return it.
   *   4. If `"auto"` → call the Haiku classifier; fall back to the safe
   *      default if the classifier or API key are unavailable.
   *
   * Opting out of auto-tiering: set `env.modelChoice` (or
   * `workspace.defaultModel`) to a concrete model id (e.g.
   * `claude-opus-4-7`). The router short-circuits at step 3 and never
   * downgrades — useful when you specifically want every turn on Opus
   * regardless of how mechanical the prompt looks.
   *
   * Never throws — chat must keep working even if the router can't reach
   * the API. Callers receive a usable model id in every case.
   */
  async resolve(opts: {
    envModelChoice: string | null | undefined;
    workspaceDefaultModel: string | null | undefined;
    apiKey: string | null;
    prompt: string;
  }): Promise<{ model: ConcreteModelId; auto: boolean; tier?: string }> {
    const choice: ModelChoice = isModelChoice(opts.envModelChoice)
      ? opts.envModelChoice
      : isModelChoice(opts.workspaceDefaultModel)
        ? opts.workspaceDefaultModel
        : "auto";

    if (choice !== "auto") {
      return { model: choice, auto: false };
    }

    const tier = await this.classify(opts.prompt, opts.apiKey);
    if (!tier) {
      return { model: DEFAULT_MODEL, auto: true };
    }
    return { model: TIER_TO_MODEL[tier], auto: true, tier };
  }

  private async classify(
    prompt: string,
    apiKey: string | null
  ): Promise<keyof typeof TIER_TO_MODEL | null> {
    // We intentionally route via the Agent SDK (not the raw Anthropic SDK):
    // the Agent SDK natively understands sk-ant-oat* (Pro/Max OAuth) tokens,
    // so the router works for users who don't have a raw API key.
    const key =
      apiKey ||
      process.env.ANTHROPIC_API_KEY ||
      process.env.CLAUDE_CODE_OAUTH_TOKEN ||
      null;
    if (!key) return null;

    const hash = createHash("sha256")
      .update(CLASSIFIER_RULES_VERSION + "\n" + prompt.slice(0, 4000))
      .digest("hex");
    const cached = cache.get(hash);
    if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
      return cached.tier;
    }

    // Route the credential by format. Mixing them up → "Invalid API key".
    const env: Record<string, string | undefined> = { ...process.env };
    if (key.startsWith("sk-ant-oat")) {
      env.CLAUDE_CODE_OAUTH_TOKEN = key;
      delete env.ANTHROPIC_API_KEY;
    } else {
      env.ANTHROPIC_API_KEY = key;
      delete env.CLAUDE_CODE_OAUTH_TOKEN;
    }

    const userPrompt =
      `Classify the difficulty of this developer chat request.\n\n` +
      `Tiers:\n` +
      `- "simple": short follow-ups, status questions, trivial edits, lookups, formatting fixes, single-file reads.\n` +
      `- "medium": typical feature work, bug investigation, refactors that touch a handful of files. ALSO: surveys, audits, codebase exploration, "look before you change" requests, planning-only requests — even when they span many files. These are mechanical reading/grepping work; they do NOT require Opus-level reasoning even if the codebase is large.\n` +
      `- "hard": ONLY when the task requires multi-step reasoning that no amount of file reading would replace — architectural design from scratch, novel algorithm work, multi-system trade-off analysis, security-correctness review where wrong = exploitable, or genuinely hard debugging where the bug is non-obvious from the code itself. If a competent senior engineer could do it by methodically reading the right files, it's "medium" not "hard".\n\n` +
      `Respond with EXACTLY one JSON object on a single line: {"tier":"simple"} or {"tier":"medium"} or {"tier":"hard"}. Nothing else.\n\n` +
      `Request:\n` +
      prompt.slice(0, 2000);

    try {
      const q = query({
        prompt: userPrompt,
        options: {
          model: "claude-haiku-4-5-20251001",
          // Plain string systemPrompt skips the multi-thousand-token
          // claude_code preset — keeps classification fast and cheap.
          systemPrompt:
            "You are a difficulty classifier. Respond with ONLY one JSON object on a single line, no prose, no markdown.",
          permissionMode: "bypassPermissions",
          allowDangerouslySkipPermissions: true,
          env: env as Record<string, string>,
          // Strip every built-in tool — classifier shouldn't touch the FS,
          // and even loading the tool definitions adds tokens + latency.
          disallowedTools: [
            "Bash",
            "BashOutput",
            "KillBash",
            "Read",
            "Write",
            "Edit",
            "MultiEdit",
            "NotebookEdit",
            "Glob",
            "Grep",
            "WebFetch",
            "WebSearch",
            "Task",
            "TodoWrite",
            "ExitPlanMode",
          ],
        },
      });

      let text = "";
      for await (const msg of q) {
        if (msg.type === "assistant") {
          for (const block of msg.message.content) {
            if (block.type === "text") text += block.text;
          }
        }
        if (msg.type === "result") break;
      }

      const match = text.match(/"tier"\s*:\s*"(simple|medium|hard)"/i);
      const tier = match
        ? (match[1].toLowerCase() as keyof typeof TIER_TO_MODEL)
        : null;
      if (!tier) {
        this.logger.warn(
          `router classifier returned unparseable: ${text.slice(0, 80)}`
        );
        return null;
      }
      cache.set(hash, { tier, at: Date.now() });
      return tier;
    } catch (err) {
      this.logger.warn(`router classifier failed: ${err}`);
      return null;
    }
  }
}

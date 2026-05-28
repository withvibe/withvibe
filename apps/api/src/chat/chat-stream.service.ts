import { Injectable } from "@nestjs/common";
import { mkdir } from "fs/promises";
import { existsSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { createHash } from "crypto";
import { query, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type { ChatContext } from "./chat-context.service";
import { ClaudeCodeEngineService } from "./claude-code-engine.service";
import { ModelRouterService } from "./model-router.service";
import { PrismaService } from "../prisma/prisma.service";
import { InjectPinoLogger, PinoLogger } from "nestjs-pino";

/**
 * Maps an Anthropic SDK failure (assistant `error` code or an HTTP
 * api_error_status on a result) to a clear, user-facing message. The most
 * common case in practice is a missing/invalid Anthropic API key, which the
 * SDK reports as `authentication_failed` or HTTP 401 — without this the turn
 * ends silently with no text and the user has no idea why.
 */
export function friendlyAuthError(
  code?: string | null,
  httpStatus?: number | null
): string {
  if (code === "authentication_failed" || httpStatus === 401 || httpStatus === 403) {
    return "Anthropic rejected the request — the API key is missing, invalid, or unauthorized. Add or fix the key in workspace Settings → Integrations (or set ANTHROPIC_API_KEY on the server).";
  }
  if (code === "billing_error") {
    return "Anthropic billing error — your account has no available credit or the plan doesn't allow this request. Check your Anthropic Console billing.";
  }
  if (code === "rate_limit" || httpStatus === 429) {
    return "Anthropic rate limit reached — please wait a moment and try again.";
  }
  if (code) return `AI request failed (${code}).`;
  if (httpStatus) return `AI request failed (HTTP ${httpStatus}).`;
  return "AI request failed.";
}

/**
 * Maps a non-success SDK `result` (subtype + terminal_reason + errors[]) to a
 * user-facing message. `error_during_execution` is the catch-all the SDK emits
 * when its turn loop throws; `terminal_reason` and `errors[]` say why. We map
 * the cases a user can actually act on and otherwise fall back to surfacing
 * the raw error text so the turn never ends with a meaningless code.
 */
export function friendlyResultError(
  subtype: string,
  terminalReason?: string | null,
  errors?: string[]
): string {
  const detail = errors && errors.length ? ` (${errors.join("; ")})` : "";
  switch (terminalReason) {
    case "prompt_too_long":
      return "The conversation grew too long for the model's context window. Start a new chat, or remove some attached repos/files to shrink the context.";
    case "model_error":
      return `The model returned an error mid-turn${detail}. Please try again.`;
    case "blocking_limit":
    case "rapid_refill_breaker":
      return "Anthropic usage limit reached — please wait a moment and try again.";
    case "stop_hook_prevented":
    case "hook_stopped":
      return "The turn was stopped by a configured hook before completing.";
    case "aborted_streaming":
    case "aborted_tools":
      return "The run was interrupted before it finished.";
  }
  if (subtype === "error_max_turns")
    return "The AI hit its maximum number of turns before finishing. Try a more focused request.";
  if (subtype === "error_max_budget_usd")
    return "The AI hit its per-run cost limit before finishing.";
  return `AI request failed (${subtype})${detail}.`;
}

export type DebugEvent =
  /** Emitted once per turn, immediately after the model router decides which Claude model handles this turn. Only emitted when debugMode is on so users can see auto-routing decisions live. */
  | {
      type: "debug_routed_model";
      model: string;
      /** True when the env/workspace setting was "auto" (router actually ran). False when a specific model id was pinned. */
      auto: boolean;
      /** Tier the auto router classified the prompt into (only set when `auto` is true). */
      tier?: string;
    }
  /** Every raw SDK message type — first, how long since query() started; next, how long since the previous event. Only emitted when debugMode is on. */
  | {
      type: "debug_sdk_event";
      sdkType: string;
      sdkSubtype?: string;
      sinceStartMs: number;
      sinceLastMs: number;
      summary?: string;
    }
  | {
      type: "debug_meta";
      model?: string;
      numTurns?: number;
      durationMs?: number;
      durationApiMs?: number;
      inputTokens?: number;
      outputTokens?: number;
      cacheCreationTokens?: number;
      cacheReadTokens?: number;
      totalCostUsd?: number;
      toolCallsByName: Record<string, number>;
      /** The turn's user prompt (verbatim). */
      userPrompt?: string;
      /** Our workspace/env-specific system-prompt suffix, appended after the `claude_code` preset. */
      systemAppend?: string;
      /** Approximate length of the SDK's `claude_code` preset (we can't read the text itself — the SDK doesn't expose it). */
      systemPresetNote?: string;
    }
  /**
   * Pre-API waterfall — emitted once per turn, just before the SDK call. Lets
   * the debug panel show where time goes between "user hit send" and "model
   * starts responding": queue wait, context build, dispatch overhead. All
   * timestamps are ms offsets from `receivedAt` (which is itself a wall-clock
   * epoch ms so multiple turns can be aligned on the same axis).
   */
  | {
      type: "debug_phases";
      /** Wall-clock epoch ms when the user message hit `MessagesService.postMessage`. */
      receivedAt: number;
      /** Ms from receivedAt to when `ActiveRunsService.execute()` started this turn. Captures queue wait + dispatch overhead. */
      dispatchAt: number;
      /** Ms from receivedAt to the start of `ChatContextService.build()`. */
      ctxBuildStartAt: number;
      /** Ms from receivedAt to the end of `ChatContextService.build()`. */
      ctxBuildDoneAt: number;
      /** Ms from receivedAt to the SDK `query()` call returning. */
      queryStartAt: number;
      /** Short SHA-256 prefix of `systemAppend`. Same hash across turns ⇒ stable prefix ⇒ prompt cache should hit. */
      systemAppendSha256: string;
      /** Byte length of `systemAppend`. Cache miss is much costlier when this grows. */
      systemAppendBytes: number;
    }
  /**
   * Per-tool round-trip — emitted when a `tool_result` lands for a previously
   * seen `tool_use`. `durationMs` is wall-clock from the model emitting the
   * tool call to the runner returning a result, so it includes both tool
   * execution and any inter-event scheduling cost.
   */
  | {
      type: "debug_tool_latency";
      toolUseId: string;
      name: string;
      durationMs: number;
      isError?: boolean;
    };

export type ChatEvent =
  | { type: "text"; delta: string }
  | { type: "thinking"; delta: string }
  /** `id` is the model-assigned tool_use_id — present in production, optional only because some legacy callers may not set it. UI uses it to correlate `debug_tool_latency` back to the right card. */
  | { type: "tool_use"; name: string; input: unknown; id?: string }
  | { type: "tool_result"; toolUseId: string; isError?: boolean }
  | { type: "done"; fullText: string; cost?: number; durationMs?: number }
  | { type: "error"; message: string }
  | DebugEvent;

/** One-line summary of an SDK message for the debug panel — never throws. */
function summarizeSdkMessage(msg: unknown): string | undefined {
  if (!msg || typeof msg !== "object") return undefined;
  const m = msg as {
    type?: string;
    subtype?: string;
    message?: { content?: unknown };
    event?: { type?: string };
  };
  if (m.type === "stream_event") {
    const evType = m.event?.type;
    return evType ? `stream_event.${evType}` : "stream_event";
  }
  if (m.type === "assistant" || m.type === "user") {
    const content = m.message?.content;
    if (Array.isArray(content)) {
      const kinds = content
        .map((b) =>
          b && typeof b === "object" && "type" in b ? String(b.type) : "?"
        )
        .join(",");
      return kinds ? `blocks:[${kinds}]` : undefined;
    }
  }
  if (m.type === "result") return m.subtype;
  return undefined;
}

@Injectable()
export class ChatStreamService {
  constructor(
    @InjectPinoLogger(ChatStreamService.name)
    private readonly logger: PinoLogger,
    private readonly claudeCode: ClaudeCodeEngineService,
    private readonly prisma: PrismaService,
    private readonly modelRouter: ModelRouterService
  ) {}

  async *stream(opts: {
    prompt: string;
    context: ChatContext;
    /** Aborted by ActiveRunsService.interrupt() — both engines wire it through. */
    signal?: AbortSignal;
    /**
     * Pre-stream timestamps from upstream (controller → enqueue → execute).
     * Optional so direct callers (bench, tests) can omit them — when absent
     * we skip the `debug_phases` emit. All values are wall-clock epoch ms.
     */
    marks?: {
      receivedAt: number;
      dispatchAt: number;
      ctxBuildStartAt: number;
      ctxBuildDoneAt: number;
    };
  }): AsyncGenerator<ChatEvent, void> {
    await mkdir(opts.context.cwd, { recursive: true }).catch(() => {});

    const agent = opts.context.agent;
    this.logger.info(
      `Querying agent${agent ? ` "${agent.agentId}"` : ""} cwd=${opts.context.cwd} engine=${opts.context.chatEngine}`
    );

    // Prepend the speaker markdown block so resumed sessions retain speaker
    // attribution across turns (both engines use session resume).
    opts = {
      ...opts,
      prompt: `${opts.context.speakerHeader}\n\n${opts.prompt}`,
    };

    // Resolve which Claude model handles this turn. "auto" runs the cheap
    // Haiku classifier; concrete ids are returned as-is. Never throws — falls
    // back to a safe default if the router can't reach the API.
    const routed = await this.modelRouter.resolve({
      envModelChoice: opts.context.envModelChoice,
      workspaceDefaultModel: opts.context.workspaceDefaultModel,
      apiKey: opts.context.anthropicApiKey,
      prompt: opts.prompt,
    });
    this.logger.info(
      `[router] env=${opts.context.envId} model=${routed.model}` +
        (routed.auto ? ` (auto${routed.tier ? `→${routed.tier}` : ""})` : "")
    );
    const model = routed.model;

    if (opts.context.debugMode) {
      yield {
        type: "debug_routed_model",
        model,
        auto: routed.auto,
        tier: routed.tier,
      };
    }

    if (opts.context.chatEngine === "claude_code") {
      const preflightError = await this.claudeCode.preflight(opts.context);
      if (preflightError) {
        this.logger.warn(
          `[claude-code] preflight failed, falling back to Agent SDK: ${preflightError}`
        );
        yield {
          type: "text",
          delta: `_⚠ Claude Code runner unavailable — falling back to Agent SDK for this turn. (${preflightError})_\n\n`,
        };
        // Fall through to the Agent SDK path below.
      } else {
        yield* this.claudeCode.stream({ ...opts, model });
        return;
      }
    }

    let fullText = "";
    try {
      const env: Record<string, string | undefined> = { ...process.env };
      // Route the key based on format. sk-ant-oat* → CLAUDE_CODE_OAUTH_TOKEN,
      // sk-ant-api* → ANTHROPIC_API_KEY. Mixing them up → "Invalid API key".
      const key =
        opts.context.anthropicApiKey ||
        process.env.ANTHROPIC_API_KEY ||
        process.env.CLAUDE_CODE_OAUTH_TOKEN;
      if (key) {
        if (key.startsWith("sk-ant-oat")) {
          env.CLAUDE_CODE_OAUTH_TOKEN = key;
          delete env.ANTHROPIC_API_KEY;
        } else {
          env.ANTHROPIC_API_KEY = key;
          delete env.CLAUDE_CODE_OAUTH_TOKEN;
        }
      } else {
        this.logger.error(
          `Agent query aborted${agent ? ` agent="${agent.agentId}"` : ""}: no Anthropic API key configured`
        );
        yield {
          type: "error",
          message:
            "No Anthropic API key configured. Add an API key in workspace Settings → Integrations, or set ANTHROPIC_API_KEY on the server.",
        };
        return;
      }

      const mcpServers = opts.context.mcpServers;
      const hasMcp = Object.keys(mcpServers).length > 0;
      const disallowedTools = opts.context.disallowedTools;
      const subagents = opts.context.subagents;
      const hasSubagents = Object.keys(subagents).length > 0;
      // Enable project settingSources whenever we've materialized skills
      // under .claude/skills/ — either for a bound agent or for sub-agents.
      const enableProjectSources = opts.context.hasSkills;

      // Full prompt dump for debugging — gated on CHAT_DEBUG_PROMPT=1.
      // Writes to stdout directly (logger adds pretty formatting that garbles
      // long multi-line blocks).
      if (process.env.CHAT_DEBUG_PROMPT === "1") {
        const divider = "═".repeat(80);
        const agentLabel = agent ? ` agent="${agent.agentId}"` : " (orchestrator)";
        const dump =
          `\n${divider}\n` +
          `[CHAT-DEBUG]${agentLabel} cwd=${opts.context.cwd}\n` +
          `${divider}\n` +
          `additionalDirectories: ${JSON.stringify(opts.context.additionalDirectories)}\n` +
          `mcpServers: ${JSON.stringify(Object.keys(mcpServers))}\n` +
          `extraAllowedTools: ${JSON.stringify(opts.context.extraAllowedTools)}\n` +
          `disallowedTools: ${JSON.stringify(disallowedTools)}\n` +
          `subagents (keys): ${JSON.stringify(Object.keys(subagents))}\n` +
          (hasSubagents
            ? `subagents (full): ${JSON.stringify(subagents, null, 2)}\n`
            : "") +
          `hasSkills: ${opts.context.hasSkills}\n` +
          `settingSources: ${enableProjectSources ? '["project"]' : "(none)"}\n` +
          `───── SYSTEM PROMPT APPEND ─────\n` +
          `${opts.context.systemAppend}\n` +
          `───── USER PROMPT ─────\n` +
          `${opts.prompt}\n` +
          `${divider}\n`;
        process.stdout.write(dump);
      }

      const debug = opts.context.debugMode;
      const queryStart = Date.now();
      let firstEventAt: number | null = null;
      let firstTextAt: number | null = null;
      let lastEventAt = queryStart;
      const toolCallsByName: Record<string, number> = {};
      // Track tool_use → tool_result wall-clock per id so we can attribute
      // turn time to specific tools (the model rarely reports this and "the
      // model feels slow" often turns out to be a slow tool, not slow API).
      const toolUseStartTimes = new Map<
        string,
        { name: string; startMs: number }
      >();

      if (debug && opts.marks) {
        const m = opts.marks;
        const append = opts.context.systemAppend ?? "";
        yield {
          type: "debug_phases",
          receivedAt: m.receivedAt,
          dispatchAt: m.dispatchAt - m.receivedAt,
          ctxBuildStartAt: m.ctxBuildStartAt - m.receivedAt,
          ctxBuildDoneAt: m.ctxBuildDoneAt - m.receivedAt,
          queryStartAt: queryStart - m.receivedAt,
          systemAppendSha256: createHash("sha256")
            .update(append)
            .digest("hex")
            .slice(0, 16),
          systemAppendBytes: Buffer.byteLength(append, "utf8"),
        };
      }
      // With includePartialMessages, the SDK emits stream_event deltas AND a
      // final "assistant" turn repeating the whole text. Track whether we saw
      // deltas so we can skip the repeat.
      let sawTextDelta = false;
      let sawThinkingDelta = false;

      // Bridge the upstream AbortSignal into the SDK's required AbortController.
      // We pre-construct one and forward `abort` so a single signal can drive
      // both this query AND the CLI engine path consistently.
      const sdkAbort = new AbortController();
      if (opts.signal) {
        if (opts.signal.aborted) sdkAbort.abort();
        else opts.signal.addEventListener("abort", () => sdkAbort.abort(), { once: true });
      }

      // Streaming input mode: hand the SDK an async iterator of user messages
      // instead of a string. We yield one message per turn and let `resume`
      // pick up the prior session, so the SDK owns multi-turn context.
      const resumeSessionId = await this.resolveResumeSessionId(
        opts.context.sessionId,
        opts.context.cwd,
        agent?.agentId
      );

      async function* userMessages(): AsyncGenerator<SDKUserMessage> {
        yield {
          type: "user",
          message: { role: "user", content: opts.prompt },
          parent_tool_use_id: null,
        };
      }

      const q = query({
        prompt: userMessages(),
        options: {
          model,
          cwd: opts.context.cwd,
          additionalDirectories: opts.context.additionalDirectories,
          systemPrompt: {
            type: "preset",
            preset: "claude_code",
            append: opts.context.systemAppend,
          },
          permissionMode: "bypassPermissions",
          allowDangerouslySkipPermissions: true,
          abortController: sdkAbort,
          env: env as Record<string, string>,
          ...(hasMcp && { mcpServers }),
          ...(disallowedTools.length > 0 && { disallowedTools }),
          ...(hasSubagents && { agents: subagents }),
          ...(enableProjectSources && { settingSources: ["project" as const] }),
          ...(resumeSessionId && { resume: resumeSessionId }),
          includePartialMessages: true,
        },
      });

      let capturedSessionId: string | null = null;

      for await (const msg of q) {
        const now = Date.now();
        if (firstEventAt === null) {
          firstEventAt = now;
          this.logger.info(
            `[chat-stream] first SDK event after ${firstEventAt - queryStart}ms (type=${msg.type})`
          );
        }
        if (debug) {
          const sdkSubtype = (msg as { subtype?: string }).subtype;
          yield {
            type: "debug_sdk_event",
            sdkType: msg.type,
            sdkSubtype,
            sinceStartMs: now - queryStart,
            sinceLastMs: now - lastEventAt,
            summary: summarizeSdkMessage(msg),
          };
        }
        lastEventAt = now;

        if (msg.type === "system" && (msg as { subtype?: string }).subtype === "init") {
          const sid = (msg as { session_id?: string }).session_id;
          if (sid && !capturedSessionId) capturedSessionId = sid;
        }

        if (msg.type === "stream_event") {
          const inner = (msg as { event?: {
            type?: string;
            delta?: { type?: string; text?: string; thinking?: string };
          } }).event;
          if (inner?.type === "content_block_delta" && inner.delta) {
            if (inner.delta.type === "text_delta" && inner.delta.text) {
              if (firstTextAt === null) {
                firstTextAt = Date.now();
                this.logger.info(
                  `[chat-stream] first text token after ${firstTextAt - queryStart}ms`
                );
              }
              fullText += inner.delta.text;
              sawTextDelta = true;
              yield { type: "text", delta: inner.delta.text };
            } else if (
              inner.delta.type === "thinking_delta" &&
              inner.delta.thinking
            ) {
              sawThinkingDelta = true;
              yield { type: "thinking", delta: inner.delta.thinking };
            }
          }
        } else if (msg.type === "assistant") {
          if (msg.error) {
            this.logger.error(
              `Agent assistant error (${msg.error})${agent ? ` agent="${agent.agentId}"` : ""}`
            );
            yield { type: "error", message: friendlyAuthError(msg.error) };
            return;
          }
          const content = msg.message.content;
          for (const block of content) {
            if (block.type === "text") {
              // Deltas already streamed this text — don't re-emit.
              if (sawTextDelta) continue;
              if (firstTextAt === null) {
                firstTextAt = Date.now();
                this.logger.info(
                  `[chat-stream] first text token after ${firstTextAt - queryStart}ms`
                );
              }
              fullText += block.text;
              yield { type: "text", delta: block.text };
            } else if (block.type === "tool_use") {
              toolCallsByName[block.name] =
                (toolCallsByName[block.name] ?? 0) + 1;
              const toolUseId = (block as { id?: string }).id;
              if (toolUseId) {
                toolUseStartTimes.set(toolUseId, {
                  name: block.name,
                  startMs: Date.now(),
                });
              }
              yield {
                type: "tool_use",
                name: block.name,
                input: block.input,
                id: toolUseId,
              };
            } else if (block.type === "thinking") {
              if (sawThinkingDelta) continue;
              const thinkingText =
                (block as { thinking?: string }).thinking ?? "";
              if (thinkingText) yield { type: "thinking", delta: thinkingText };
            }
          }
        } else if (msg.type === "user") {
          const content = msg.message.content;
          if (Array.isArray(content)) {
            for (const block of content) {
              if (
                typeof block === "object" &&
                block !== null &&
                "type" in block &&
                block.type === "tool_result"
              ) {
                const tr = block as { tool_use_id: string; is_error?: boolean };
                yield {
                  type: "tool_result",
                  toolUseId: tr.tool_use_id,
                  isError: tr.is_error,
                };
                if (debug) {
                  const start = toolUseStartTimes.get(tr.tool_use_id);
                  if (start) {
                    yield {
                      type: "debug_tool_latency",
                      toolUseId: tr.tool_use_id,
                      name: start.name,
                      durationMs: Date.now() - start.startMs,
                      isError: tr.is_error,
                    };
                    toolUseStartTimes.delete(tr.tool_use_id);
                  }
                }
              }
            }
          }
        } else if (msg.type === "result") {
          if (msg.subtype === "success" && !msg.is_error) {
            this.logger.info(
              `Agent query done${agent ? ` agent="${agent.agentId}"` : ""} cost=$${msg.total_cost_usd?.toFixed(4) ?? "?"} duration=${msg.duration_ms ?? "?"}ms turns=${(msg as { num_turns?: number }).num_turns ?? "?"} session=${capturedSessionId ?? "-"}`
            );
            await this.persistSdkSessionId(opts.context.sessionId, capturedSessionId);
            if (debug) {
              const r = msg as {
                duration_ms?: number;
                duration_api_ms?: number;
                num_turns?: number;
                usage?: {
                  input_tokens?: number;
                  output_tokens?: number;
                  cache_creation_input_tokens?: number;
                  cache_read_input_tokens?: number;
                };
                total_cost_usd?: number;
              };
              yield {
                type: "debug_meta",
                model,
                numTurns: r.num_turns,
                durationMs: r.duration_ms,
                durationApiMs: r.duration_api_ms,
                inputTokens: r.usage?.input_tokens,
                outputTokens: r.usage?.output_tokens,
                cacheCreationTokens: r.usage?.cache_creation_input_tokens,
                cacheReadTokens: r.usage?.cache_read_input_tokens,
                totalCostUsd: r.total_cost_usd,
                toolCallsByName,
                userPrompt: opts.prompt,
                systemAppend: opts.context.systemAppend,
                systemPresetNote:
                  "The SDK's `claude_code` preset (large system prompt with tool instructions, CWD hints, git context, etc.) is prepended to the text below but not exposed by the SDK — we can't display it verbatim. The input-token count above includes it.",
              };
            }
            yield {
              type: "done",
              fullText: fullText || msg.result,
              cost: msg.total_cost_usd,
              durationMs: msg.duration_ms,
            };
          } else {
            const httpStatus =
              msg.subtype === "success" ? (msg.api_error_status ?? null) : null;
            // Error result subtypes (error_during_execution, error_max_turns,
            // …) carry the real cause in `errors[]` and `terminal_reason`. The
            // generic subtype alone is undebuggable, so pull both through to
            // the log and the user-facing message.
            const errResult = msg as {
              errors?: string[];
              terminal_reason?: string;
            };
            const errors = errResult.errors ?? [];
            const terminalReason = errResult.terminal_reason;
            this.logger.error(
              `Agent query failed (${msg.subtype}${httpStatus ? ` http=${httpStatus}` : ""}${terminalReason ? ` terminal_reason=${terminalReason}` : ""})${agent ? ` agent="${agent.agentId}"` : ""}` +
                (errors.length ? ` errors=${JSON.stringify(errors)}` : "")
            );
            yield {
              type: "error",
              message: httpStatus
                ? friendlyAuthError(null, httpStatus)
                : friendlyResultError(msg.subtype, terminalReason, errors),
            };
          }
          return;
        }
      }

      // The SDK iterator completed without ever emitting a `result` — both
      // the success and error result branches `return`, so reaching here
      // means the claude child exited mid-turn. The worst case is it
      // produced *zero* events (e.g. it couldn't traverse into its working
      // directory and died in startup): without this guard the turn ends as
      // a silent "done" with no text and no error, which is undebuggable
      // from the UI. Surface it instead.
      if (firstEventAt === null) {
        this.logger.error(
          `Agent stream produced no SDK events${agent ? ` agent="${agent.agentId}"` : ""} — claude exited without output (is the working dir accessible to the claude user?)`
        );
        yield {
          type: "error",
          message:
            "The AI runner produced no output and exited without responding. This usually means it couldn't start in its working directory — check the API server logs.",
        };
      } else {
        this.logger.error(
          `Agent stream ended without a result event${agent ? ` agent="${agent.agentId}"` : ""}`
        );
        yield {
          type: "error",
          message: "The AI run ended unexpectedly without completing.",
        };
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(
        { err: err instanceof Error ? err : new Error(String(err)) },
        `Agent stream exception${agent ? ` agent="${agent.agentId}"` : ""}: ${msg}`
      );
      yield { type: "error", message: msg };
    }
  }

  /**
   * Resolve the SDK `resume` id for this turn — but only if its transcript
   * still exists under the *current* cwd. The Agent SDK partitions transcripts
   * by cwd (`~/.claude/projects/<cwd-with-non-alnum→dash>/<id>.jsonl`), so a
   * stored `sdkSessionId` created under a different cwd (e.g. the repos base
   * dir was relocated) is unresumable: `query({ resume })` fails the whole turn
   * with `error_during_execution: No conversation found with session ID`, and
   * the resulting early child-exit has crashed the API process via an
   * unhandled EPIPE on the SDK's stdin pipe. Validating up-front lets us fall
   * back to a fresh session cleanly instead of issuing a doomed resume. The
   * next successful turn overwrites the stale id.
   */
  private async resolveResumeSessionId(
    sessionId: string | null,
    cwd: string,
    agentId?: string
  ): Promise<string | null> {
    if (!sessionId) return null;
    const stored =
      (
        await this.prisma.client.chatSession.findUnique({
          where: { id: sessionId },
          select: { sdkSessionId: true },
        })
      )?.sdkSessionId ?? null;
    if (!stored) return null;

    const configDir = process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
    const projectDir = cwd.replace(/[^a-zA-Z0-9]/g, "-");
    const transcript = join(configDir, "projects", projectDir, `${stored}.jsonl`);
    if (existsSync(transcript)) return stored;

    this.logger.warn(
      `[chat-stream] resume transcript missing for session ${stored} (cwd=${cwd})${agentId ? ` agent="${agentId}"` : ""} — starting a fresh SDK session instead of a doomed resume`
    );
    return null;
  }

  private async persistSdkSessionId(
    sessionId: string | null,
    sdkSessionId: string | null
  ): Promise<void> {
    if (!sessionId || !sdkSessionId) return;
    try {
      await this.prisma.client.chatSession.update({
        where: { id: sessionId },
        data: { sdkSessionId },
      });
    } catch (err) {
      this.logger.warn(
        `[chat-stream] failed to persist sdkSessionId: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }
}

import { Injectable, Logger } from "@nestjs/common";
import { spawn } from "child_process";
import { mkdir, rm, writeFile } from "fs/promises";
import path from "path";
import { createHash, randomUUID } from "crypto";
import { PrismaService } from "../prisma/prisma.service";
import { ClaudeRunnerService } from "../runner/claude-runner.service";
import { EnvCloneService } from "../env-clones/env-clone.service";
import type { ChatContext } from "./chat-context.service";
import type { ChatEvent } from "./chat-stream.service";
import { friendlyAuthError } from "./chat-stream.service";
import type { ConcreteModelId } from "./models";
import { DEFAULT_MODEL } from "./models";

/** Resolved at runtime from process.env so dev/prod can point the runner at a different host. */
function mcpBridgeBaseUrl(): string {
  return process.env.CLAUDE_RUNNER_MCP_BASE_URL || "http://host.docker.internal:4000/api/mcp";
}

const MCP_SERVER_NAMES = [
  "withvibe-env",
  "withvibe-workspace",
  "withvibe-member",
  "withvibe-docker",
  "withvibe-agent",
  "withvibe-human",
] as const;

type ClaudeCliEvent =
  | {
      type: "system";
      subtype?: string;
      session_id?: string;
    }
  | {
      type: "assistant";
      error?: string;
      message: {
        content: Array<
          | { type: "text"; text: string }
          | { type: "tool_use"; id?: string; name: string; input: unknown }
          | { type: "thinking"; thinking?: string }
        >;
      };
    }
  | {
      type: "user";
      message: {
        content: Array<{
          type?: string;
          tool_use_id?: string;
          is_error?: boolean;
        }>;
      };
    }
  | {
      type: "result";
      subtype?: string;
      is_error?: boolean;
      api_error_status?: number | null;
      total_cost_usd?: number;
      duration_ms?: number;
      duration_api_ms?: number;
      num_turns?: number;
      usage?: {
        input_tokens?: number;
        output_tokens?: number;
        cache_creation_input_tokens?: number;
        cache_read_input_tokens?: number;
      };
      session_id?: string;
      result?: string;
    }
  | {
      type: "stream_event";
      event?: {
        type?: string;
        delta?: {
          type?: string;
          text?: string;
          thinking?: string;
        };
      };
    };

/**
 * Runs the real `claude` CLI inside the env's runner container via
 * `docker exec`, streams its NDJSON output, and emits the same `ChatEvent`
 * shape the Agent SDK path emits — so the rest of the system (UI, persistence,
 * active-runs) is engine-agnostic.
 *
 * MCP parity is via HTTP — the runner calls back to the Nest API at
 * /api/mcp/:serverName with the bridge token baked into context. `--resume`
 * is auto-managed: first turn writes the captured session id onto
 * `ChatSession.claudeSessionId`; subsequent turns pass it via --resume.
 */
@Injectable()
export class ClaudeCodeEngineService {
  private readonly logger = new Logger(ClaudeCodeEngineService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly runner: ClaudeRunnerService,
    private readonly envClones: EnvCloneService
  ) {}

  /**
   * Fast pre-check — returns null on success, or an error string. Used by
   * ChatStreamService to decide whether to auto-fall-back to the Agent SDK
   * engine BEFORE any stream events reach the client.
   */
  async preflight(context: ChatContext): Promise<string | null> {
    try {
      const name = await this.runner.ensureRunning(
        context.envId,
        context.workspaceId
      );
      this.logger.log(`[claude-code] runner ready: ${name}`);
      return null;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return msg;
    }
  }

  async *stream(opts: {
    prompt: string;
    context: ChatContext;
    /** Abort via ActiveRunsService.interrupt() — kills the docker exec child. */
    signal?: AbortSignal;
    /** Resolved by ChatStreamService (env override / workspace default / router). */
    model?: ConcreteModelId;
    /** Pre-stream waterfall marks — see ChatStreamService.stream for shape. */
    marks?: {
      receivedAt: number;
      dispatchAt: number;
      ctxBuildStartAt: number;
      ctxBuildDoneAt: number;
    };
  }): AsyncGenerator<ChatEvent, void> {
    const { context, prompt } = opts;
    const containerName = this.runner.containerName(context.envId);
    const envDir = this.envClones.envDir(context.workspaceId, context.envId);

    // Per-turn scratch dir (bind-mounted → visible inside the runner). Host
    // and container see identical paths because we mount envDir at /workspace
    // AND the turn dir ultimately lives under /workspace/.withvibe/runner.
    const turnId = Date.now().toString(36) + "-" + randomUUID().slice(0, 8);
    const hostTurnDir = path.join(envDir, ".withvibe", "runner", turnId);
    const containerTurnDir = `/workspace/.withvibe/runner/${turnId}`;
    await mkdir(hostTurnDir, { recursive: true });
    // HOME for the non-root claude process — must be writable for cache,
    // credentials, and the runtime's session store (used by --resume).
    await mkdir(path.join(envDir, ".withvibe", "home"), { recursive: true });

    // MCP config — one HTTP entry per bridged server, all sharing the session
    // bridge token. strict-mcp-config below ensures nothing else is loaded.
    const mcpConfig = {
      mcpServers: Object.fromEntries(
        MCP_SERVER_NAMES.map((name) => [
          name,
          {
            type: "http" as const,
            url: `${mcpBridgeBaseUrl()}/${name}`,
            headers: {
              Authorization: `Bearer ${context.mcpBridgeToken}`,
            },
          },
        ])
      ),
    };
    const mcpConfigHostPath = path.join(hostTurnDir, "mcp.json");
    const mcpConfigContainerPath = `${containerTurnDir}/mcp.json`;
    await writeFile(mcpConfigHostPath, JSON.stringify(mcpConfig, null, 2), "utf-8");

    // Resume id from DB, if any. Undefined on first turn.
    const resumeSessionId = context.sessionId
      ? (
          await this.prisma.client.chatSession.findUnique({
            where: { id: context.sessionId },
            select: { claudeSessionId: true },
          })
        )?.claudeSessionId ?? null
      : null;

    // API key routing mirrors the Agent SDK path (sk-ant-oat* → OAuth token,
    // everything else → API key).
    const key =
      context.anthropicApiKey ||
      process.env.ANTHROPIC_API_KEY ||
      process.env.CLAUDE_CODE_OAUTH_TOKEN ||
      "";
    const dockerEnvFlags: string[] = [];
    if (key) {
      if (key.startsWith("sk-ant-oat")) {
        dockerEnvFlags.push("-e", `CLAUDE_CODE_OAUTH_TOKEN=${key}`);
      } else {
        dockerEnvFlags.push("-e", `ANTHROPIC_API_KEY=${key}`);
      }
    } else {
      this.logger.error("[claude-code] run aborted: no Anthropic API key configured");
      yield {
        type: "error",
        message:
          "No Anthropic API key configured. Add an API key in workspace Settings → Integrations, or set ANTHROPIC_API_KEY on the server.",
      };
      return;
    }

    // Claude Code refuses to run with --dangerously-skip-permissions or
    // bypassPermissions as root. Run as the host API's uid/gid — the bind
    // mount already has those owners, and the host uid maps 1:1 into the
    // container, so the CLI sees a non-root uid.
    const uid = process.getuid?.() ?? 0;
    const gid = process.getgid?.() ?? 0;

    const claudeArgs = [
      "exec",
      "-i",
      "--user",
      `${uid}:${gid}`,
      "-e",
      `HOME=/workspace/.withvibe/home`,
      ...dockerEnvFlags,
      "-w",
      "/workspace",
      containerName,
      "claude",
      "-p",
      prompt,
      "--output-format",
      "stream-json",
      "--verbose",
      "--include-partial-messages",
      "--input-format",
      "text",
      "--model",
      opts.model ?? DEFAULT_MODEL,
      "--permission-mode",
      "bypassPermissions",
      "--append-system-prompt",
      context.systemAppend,
      "--mcp-config",
      mcpConfigContainerPath,
      "--strict-mcp-config",
    ];
    for (const dir of context.additionalDirectories) {
      // Host paths are bind-mounted 1:1 (envDir is always at /workspace).
      // Rewrite so the CLI sees paths the runner's filesystem actually has.
      const rel = path.relative(envDir, dir);
      const containerPath = rel && !rel.startsWith("..")
        ? `/workspace/${rel}`
        : dir;
      claudeArgs.push("--add-dir", containerPath);
    }
    if (context.disallowedTools.length > 0) {
      claudeArgs.push("--disallowedTools", context.disallowedTools.join(","));
    }
    if (resumeSessionId) {
      claudeArgs.push("--resume", resumeSessionId);
    }

    this.logger.log(
      `[claude-code] spawning docker exec (container=${containerName}, resume=${resumeSessionId ?? "-"}, tools-denied=${context.disallowedTools.length}, addl-dirs=${context.additionalDirectories.length})`
    );

    const child = spawn("docker", claudeArgs, { stdio: ["ignore", "pipe", "pipe"] });

    // Hook the upstream abort signal so interrupt() kills the runner cleanly.
    // SIGTERM → docker exec proxies it through; the claude CLI exits, stdout
    // closes, and our line-loop drains and exits.
    const abortHandler = () => {
      if (!child.killed && child.exitCode === null) {
        try {
          child.kill("SIGTERM");
        } catch {
          // already gone
        }
      }
    };
    if (opts.signal) {
      if (opts.signal.aborted) abortHandler();
      else opts.signal.addEventListener("abort", abortHandler, { once: true });
    }

    let stderrBuf = "";
    child.stderr.setEncoding("utf-8");
    child.stderr.on("data", (chunk: string) => {
      stderrBuf += chunk;
      if (stderrBuf.length > 32_000) {
        stderrBuf = stderrBuf.slice(-32_000);
      }
    });

    // Async line iteration over stdout.
    child.stdout.setEncoding("utf-8");
    const lineQueue: string[] = [];
    const lineWaiters: Array<(line: string | null) => void> = [];
    let pending = "";
    let childEnded = false;
    // Captured from the async 'error' handler — TS control-flow analysis
    // can't see the mutation, so we narrow manually at the read site.
    const errorBox: { err: Error | null } = { err: null };

    const pushLine = (line: string) => {
      const w = lineWaiters.shift();
      if (w) w(line);
      else lineQueue.push(line);
    };
    const signalEnd = () => {
      childEnded = true;
      while (lineWaiters.length) lineWaiters.shift()!(null);
    };

    child.stdout.on("data", (chunk: string) => {
      pending += chunk;
      let idx = pending.indexOf("\n");
      while (idx !== -1) {
        const line = pending.slice(0, idx).trim();
        pending = pending.slice(idx + 1);
        if (line) pushLine(line);
        idx = pending.indexOf("\n");
      }
    });
    child.on("error", (err) => {
      errorBox.err = err;
      signalEnd();
    });
    child.on("close", () => {
      if (pending.trim()) pushLine(pending.trim());
      pending = "";
      signalEnd();
    });

    const nextLine = (): Promise<string | null> =>
      new Promise((resolve) => {
        const q = lineQueue.shift();
        if (q !== undefined) resolve(q);
        else if (childEnded) resolve(null);
        else lineWaiters.push(resolve);
      });

    let fullText = "";
    let capturedSessionId: string | null = null;
    let yieldedAnyEvent = false;
    // With --include-partial-messages, text streams as stream_event deltas;
    // the final `assistant` event then repeats the whole text. Track whether
    // we saw any streamed deltas this turn so we can skip those repeats.
    let sawTextDelta = false;
    let sawThinkingDelta = false;

    // Debug-mode timing/accounting — mirrors what the Agent SDK path emits in
    // chat-stream.service.ts so the UI debug panel works for both engines.
    const debug = context.debugMode;
    const queryStart = Date.now();
    let lastEventAt = queryStart;
    const toolCallsByName: Record<string, number> = {};
    // tool_use_id → (name, t0). The CLI's `assistant` event includes the id
    // on tool_use blocks, and `user`/`tool_result` echoes it — same matching
    // as the Agent SDK path.
    const toolUseStartTimes = new Map<
      string,
      { name: string; startMs: number }
    >();

    if (debug && opts.marks) {
      const m = opts.marks;
      const append = context.systemAppend ?? "";
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

    try {
      while (true) {
        const line = await nextLine();
        if (line === null) break;

        let event: ClaudeCliEvent | null = null;
        try {
          event = JSON.parse(line) as ClaudeCliEvent;
        } catch {
          // Non-JSON lines from the CLI go to debug logs; don't crash.
          this.logger.warn(`[claude-code] non-JSON stdout line: ${line.slice(0, 200)}`);
          continue;
        }

        yieldedAnyEvent = true;

        if (debug) {
          const now = Date.now();
          yield {
            type: "debug_sdk_event",
            sdkType: event.type,
            sdkSubtype: (event as { subtype?: string }).subtype,
            sinceStartMs: now - queryStart,
            sinceLastMs: now - lastEventAt,
            summary: this.summarizeCliEvent(event),
          };
          lastEventAt = now;
        }

        if (event.type === "system") {
          if (event.session_id && !capturedSessionId) {
            capturedSessionId = event.session_id;
          }
          continue;
        }

        if (event.type === "stream_event") {
          const inner = event.event;
          if (inner?.type === "content_block_delta" && inner.delta) {
            if (inner.delta.type === "text_delta" && inner.delta.text) {
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
          continue;
        }

        if (event.type === "assistant") {
          if (event.error) {
            this.logger.error(`[claude-code] assistant error (${event.error})`);
            yield { type: "error", message: friendlyAuthError(event.error) };
            return;
          }
          for (const block of event.message.content) {
            if (block.type === "text") {
              // If deltas already streamed this text, don't re-emit.
              if (sawTextDelta) continue;
              fullText += block.text;
              yield { type: "text", delta: block.text };
            } else if (block.type === "tool_use") {
              toolCallsByName[block.name] =
                (toolCallsByName[block.name] ?? 0) + 1;
              if (block.id) {
                toolUseStartTimes.set(block.id, {
                  name: block.name,
                  startMs: Date.now(),
                });
              }
              yield {
                type: "tool_use",
                name: block.name,
                input: block.input,
                id: block.id,
              };
            } else if (block.type === "thinking") {
              if (sawThinkingDelta) continue;
              const t = block.thinking ?? "";
              if (t) yield { type: "thinking", delta: t };
            }
          }
          continue;
        }

        if (event.type === "user") {
          if (Array.isArray(event.message.content)) {
            for (const block of event.message.content) {
              if (block?.type === "tool_result" && block.tool_use_id) {
                yield {
                  type: "tool_result",
                  toolUseId: block.tool_use_id,
                  isError: block.is_error,
                };
                if (debug) {
                  const start = toolUseStartTimes.get(block.tool_use_id);
                  if (start) {
                    yield {
                      type: "debug_tool_latency",
                      toolUseId: block.tool_use_id,
                      name: start.name,
                      durationMs: Date.now() - start.startMs,
                      isError: block.is_error,
                    };
                    toolUseStartTimes.delete(block.tool_use_id);
                  }
                }
              }
            }
          }
          continue;
        }

        if (event.type === "result") {
          if (event.session_id && !capturedSessionId) {
            capturedSessionId = event.session_id;
          }
          if (event.subtype === "success" && !event.is_error) {
            this.logger.log(
              `[claude-code] run done cost=$${event.total_cost_usd?.toFixed(4) ?? "?"} duration=${event.duration_ms ?? "?"}ms session=${capturedSessionId ?? "-"}`
            );
            await this.persistSessionId(context.sessionId, capturedSessionId);
            if (debug) {
              yield {
                type: "debug_meta",
                model: opts.model ?? DEFAULT_MODEL,
                numTurns: event.num_turns,
                durationMs: event.duration_ms,
                durationApiMs: event.duration_api_ms,
                inputTokens: event.usage?.input_tokens,
                outputTokens: event.usage?.output_tokens,
                cacheCreationTokens: event.usage?.cache_creation_input_tokens,
                cacheReadTokens: event.usage?.cache_read_input_tokens,
                totalCostUsd: event.total_cost_usd,
                toolCallsByName,
                userPrompt: prompt,
                systemAppend: context.systemAppend,
                systemPresetNote:
                  "The Claude Code CLI's built-in system prompt is applied by the CLI itself; only the --append-system-prompt suffix below is ours. The input-token count above includes the CLI's preset.",
              };
            }
            yield {
              type: "done",
              fullText: fullText || event.result || "",
              cost: event.total_cost_usd,
              durationMs: event.duration_ms,
            };
          } else {
            const httpStatus = event.api_error_status ?? null;
            this.logger.error(
              `[claude-code] run failed subtype=${event.subtype ?? "?"}${httpStatus ? ` http=${httpStatus}` : ""} stderr=${this.tail(stderrBuf, 800)}`
            );
            yield {
              type: "error",
              message: httpStatus
                ? friendlyAuthError(null, httpStatus)
                : `Claude Code run failed (${event.subtype ?? "unknown"}).`,
            };
          }
          // Wait for child exit so finally{} runs deterministically.
          while (!childEnded) {
            const more = await nextLine();
            if (more === null) break;
          }
          return;
        }
      }

      // Fell out of the loop with no `result` event — the CLI exited without
      // finishing cleanly. Surface a readable error.
      if (errorBox.err) {
        yield {
          type: "error",
          message: `Runner process error: ${errorBox.err.message}`,
        };
      } else if (!yieldedAnyEvent) {
        yield {
          type: "error",
          message: `Runner produced no output. stderr: ${this.tail(stderrBuf, 600) || "(empty)"}`,
        };
      } else {
        yield {
          type: "error",
          message: `Runner exited without a result event. stderr: ${this.tail(stderrBuf, 600) || "(empty)"}`,
        };
      }
    } finally {
      if (!child.killed && child.exitCode === null) {
        child.kill("SIGTERM");
      }
      if (opts.signal) opts.signal.removeEventListener("abort", abortHandler);
      // Best-effort cleanup of scratch dir. Leaving it around isn't fatal but
      // clutters envDir across turns.
      rm(hostTurnDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  private async persistSessionId(
    sessionId: string | null,
    claudeSessionId: string | null
  ): Promise<void> {
    if (!sessionId || !claudeSessionId) return;
    try {
      await this.prisma.client.chatSession.update({
        where: { id: sessionId },
        data: { claudeSessionId },
      });
    } catch (err) {
      this.logger.warn(
        `[claude-code] failed to persist claudeSessionId: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  private tail(s: string, max: number): string {
    if (s.length <= max) return s.trim();
    return "…" + s.slice(-max).trim();
  }

  /** One-line summary of a CLI NDJSON event for the debug panel — never throws. */
  private summarizeCliEvent(event: ClaudeCliEvent): string | undefined {
    if (event.type === "stream_event") {
      const evType = event.event?.type;
      return evType ? `stream_event.${evType}` : "stream_event";
    }
    if (event.type === "assistant" || event.type === "user") {
      const content = event.message?.content;
      if (Array.isArray(content)) {
        const kinds = content
          .map((b) =>
            b && typeof b === "object" && "type" in b ? String(b.type) : "?"
          )
          .join(",");
        return kinds ? `blocks:[${kinds}]` : undefined;
      }
    }
    if (event.type === "result") return event.subtype;
    return undefined;
  }
}

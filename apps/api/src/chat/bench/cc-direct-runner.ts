import { spawn } from "child_process";
import type {
  BenchEngineRun,
  BenchScenario,
  BenchTurnMetrics,
} from "./bench.types";

/**
 * Run a scenario through the host `claude` CLI directly — no docker, no MCP,
 * no `--append-system-prompt`, no skills. This is the "if the API itself
 * weren't fast enough this would also be slow" baseline.
 *
 * Multi-turn is implemented via `--resume`: the first turn captures the
 * `session_id` from the CLI's `system.init` event and follow-up turns pass
 * it back through the resume flag, mirroring how the in-process engines
 * handle multi-turn.
 */
export async function runCcDirect(
  scenario: BenchScenario,
  iteration: number
): Promise<BenchEngineRun> {
  const cwd = scenario.ccDirectCwd ?? process.cwd();
  const turns: BenchTurnMetrics[] = [];
  let resumeSessionId: string | null = null;

  for (let idx = 0; idx < scenario.prompts.length; idx++) {
    const turn = await runCcDirectTurn({
      prompt: scenario.prompts[idx],
      turnIdx: idx,
      cwd,
      model: scenario.model,
      resumeSessionId,
    });
    turns.push(turn.metrics);
    if (!resumeSessionId && turn.sessionId) {
      resumeSessionId = turn.sessionId;
    }
  }

  const sumInputTokens = sumOf(turns, (t) => t.inputTokens);
  const sumOutputTokens = sumOf(turns, (t) => t.outputTokens);
  const sumCacheReadTokens = sumOf(turns, (t) => t.cacheReadTokens);
  const sumCacheCreationTokens = sumOf(turns, (t) => t.cacheCreationTokens);
  const totalCostUsd = sumOf(turns, (t) => t.totalCostUsd ?? 0);
  const cacheDenom =
    sumCacheReadTokens + sumInputTokens + sumCacheCreationTokens;
  const cacheHitRatio =
    cacheDenom === 0 ? null : sumCacheReadTokens / cacheDenom;

  return {
    engine: "claude_code_direct",
    iteration,
    // No DB session — fall back to the CLI's session id (or empty if the
    // first turn never produced one, which means it errored out anyway).
    sessionId: resumeSessionId ?? "",
    turns,
    totalMs: turns.reduce((acc, t) => acc + t.totalMs, 0),
    sumInputTokens,
    sumOutputTokens,
    sumCacheReadTokens,
    sumCacheCreationTokens,
    cacheHitRatio,
    totalCostUsd,
  };
}

type CcCliEvent =
  | { type: "system"; subtype?: string; session_id?: string }
  | {
      type: "assistant";
      message: {
        content: Array<
          | { type: "text"; text: string }
          | { type: "tool_use"; id?: string; name: string; input?: unknown }
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
      total_cost_usd?: number;
      duration_ms?: number;
      duration_api_ms?: number;
      num_turns?: number;
      session_id?: string;
      result?: string;
      usage?: {
        input_tokens?: number;
        output_tokens?: number;
        cache_creation_input_tokens?: number;
        cache_read_input_tokens?: number;
      };
    }
  | {
      type: "stream_event";
      event?: {
        type?: string;
        delta?: { type?: string; text?: string; thinking?: string };
      };
    };

async function runCcDirectTurn(args: {
  prompt: string;
  turnIdx: number;
  cwd: string;
  model?: string;
  resumeSessionId: string | null;
}): Promise<{ metrics: BenchTurnMetrics; sessionId: string | null }> {
  const receivedAt = Date.now();
  const cliArgs = [
    "-p",
    args.prompt,
    "--output-format",
    "stream-json",
    "--verbose",
    "--include-partial-messages",
    "--input-format",
    "text",
    "--permission-mode",
    "bypassPermissions",
  ];
  if (args.model) {
    cliArgs.push("--model", args.model);
  }
  if (args.resumeSessionId) {
    cliArgs.push("--resume", args.resumeSessionId);
  }

  // Pass through API auth from the host environment — same envs the in-process
  // engines pick up. We don't strip anything; CC will use whichever is set.
  const child = spawn("claude", cliArgs, {
    cwd: args.cwd,
    stdio: ["ignore", "pipe", "pipe"],
    env: process.env,
  });

  let ttftMs: number | null = null;
  let totalMs = 0;
  let errored: string | null = null;
  let sessionId: string | null = null;
  let inputTokens: number | null = null;
  let outputTokens: number | null = null;
  let cacheReadTokens: number | null = null;
  let cacheCreationTokens: number | null = null;
  let totalCostUsd: number | null = null;
  let numTurns: number | null = null;
  const toolCallsByName: Record<string, number> = {};
  const toolStartTimes = new Map<string, { name: string; startMs: number }>();
  const toolLatencies: BenchTurnMetrics["toolLatencies"] = [];

  let stderrBuf = "";
  child.stderr.setEncoding("utf-8");
  child.stderr.on("data", (chunk: string) => {
    stderrBuf += chunk;
    if (stderrBuf.length > 32_000) stderrBuf = stderrBuf.slice(-32_000);
  });

  child.stdout.setEncoding("utf-8");
  let pending = "";

  const handleEvent = (ev: CcCliEvent) => {
    if (ev.type === "system" && ev.session_id && !sessionId) {
      sessionId = ev.session_id;
    } else if (ev.type === "stream_event") {
      const delta = ev.event?.delta;
      if (
        ev.event?.type === "content_block_delta" &&
        delta?.type === "text_delta" &&
        delta.text &&
        ttftMs === null
      ) {
        ttftMs = Date.now() - receivedAt;
      }
    } else if (ev.type === "assistant") {
      for (const block of ev.message.content) {
        if (block.type === "tool_use") {
          toolCallsByName[block.name] =
            (toolCallsByName[block.name] ?? 0) + 1;
          if (block.id) {
            toolStartTimes.set(block.id, {
              name: block.name,
              startMs: Date.now(),
            });
          }
        } else if (block.type === "text" && ttftMs === null && block.text) {
          // Some turns emit only the final assistant block, no stream_events.
          ttftMs = Date.now() - receivedAt;
        }
      }
    } else if (ev.type === "user") {
      for (const block of ev.message.content ?? []) {
        if (block?.type === "tool_result" && block.tool_use_id) {
          const start = toolStartTimes.get(block.tool_use_id);
          if (start) {
            toolLatencies.push({
              name: start.name,
              durationMs: Date.now() - start.startMs,
              isError: block.is_error ?? false,
            });
            toolStartTimes.delete(block.tool_use_id);
          }
        }
      }
    } else if (ev.type === "result") {
      if (ev.session_id && !sessionId) sessionId = ev.session_id;
      numTurns = ev.num_turns ?? null;
      inputTokens = ev.usage?.input_tokens ?? null;
      outputTokens = ev.usage?.output_tokens ?? null;
      cacheReadTokens = ev.usage?.cache_read_input_tokens ?? null;
      cacheCreationTokens = ev.usage?.cache_creation_input_tokens ?? null;
      totalCostUsd = ev.total_cost_usd ?? null;
      if (ev.subtype && ev.subtype !== "success") {
        errored = `cli result subtype=${ev.subtype}`;
      }
    }
  };

  const exitPromise = new Promise<void>((resolve) => {
    child.on("close", () => {
      if (pending.trim()) {
        try {
          handleEvent(JSON.parse(pending) as CcCliEvent);
        } catch {
          // ignore — final partial line wasn't JSON
        }
        pending = "";
      }
      resolve();
    });
  });

  child.stdout.on("data", (chunk: string) => {
    pending += chunk;
    let nl = pending.indexOf("\n");
    while (nl !== -1) {
      const line = pending.slice(0, nl).trim();
      pending = pending.slice(nl + 1);
      if (line) {
        try {
          handleEvent(JSON.parse(line) as CcCliEvent);
        } catch {
          // Non-JSON lines (the CLI sometimes emits warnings to stdout) are ignored.
        }
      }
      nl = pending.indexOf("\n");
    }
  });

  child.on("error", (err) => {
    errored = errored ?? err.message;
  });

  await exitPromise;

  totalMs = Date.now() - receivedAt;
  if (child.exitCode !== 0 && !errored) {
    const tail = stderrBuf.slice(-400);
    errored = `claude exit=${child.exitCode}${tail ? ` stderr=${tail}` : ""}`;
  }

  const metrics: BenchTurnMetrics = {
    turnIdx: args.turnIdx,
    prompt: args.prompt,
    ttftMs,
    totalMs,
    // No harness in front of the CLI here — the only "overhead" is process
    // startup, which is folded into ttftMs/totalMs already.
    harnessOverheadMs: null,
    phases: { dispatchMs: null, ctxBuildMs: null, queryStartMs: null },
    systemAppendSha256: null,
    systemAppendBytes: null,
    numTurns,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheCreationTokens,
    totalCostUsd,
    toolLatencies,
    toolCallsByName,
    errored,
  };

  return { metrics, sessionId };
}

function sumOf<T>(items: T[], pick: (t: T) => number | null): number {
  return items.reduce((acc, it) => acc + (pick(it) ?? 0), 0);
}

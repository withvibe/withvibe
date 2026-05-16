/**
 * Bench scenario + report shapes. Scenarios feed both the CLI runner
 * (`pnpm bench:chat <file>`) and the debug-mode-only POST /api/bench
 * endpoint, so they intentionally stay JSON-serializable.
 */

/**
 * Three benchable code paths:
 *   - `agent_sdk`         — the in-process Agent SDK path (the default chat engine)
 *   - `claude_code`       — our docker-exec'd `claude` CLI engine, fed the same
 *                           systemAppend + MCP servers as the SDK path
 *   - `claude_code_direct` — host `claude` CLI run on a clean cwd with NO
 *                           systemAppend / NO MCP / NO skills. Pure baseline
 *                           for "is the API itself slow vs. our context big?"
 */
export type BenchEngine = "agent_sdk" | "claude_code" | "claude_code_direct";

export type BenchScenario = {
  /** Human-readable label written into the report and surfaced in the table. */
  name: string;
  /** Workspace + env to run against. Must already exist in the DB. */
  envId: string;
  /** User the bench session is owned by. Affects member-memory + speaker block. */
  userId: string;
  /** Ordered list of prompts. Each prompt becomes one turn in the same session. */
  prompts: string[];
  /** Engines under test. Defaults to all three. */
  engines?: BenchEngine[];
  /** How many fresh-session repeats per engine. Defaults to 1. */
  iterations?: number;
  /** Pinned model id, or "auto" to let the router decide. Defaults to scenario-empty (uses env/workspace defaults). */
  model?: string;
  /**
   * Working directory for the `claude_code_direct` engine. Ignored by the
   * other engines (which use the env's working dir). Defaults to the API
   * process's cwd if omitted — usually fine for "any-codebase" prompts.
   */
  ccDirectCwd?: string;
};

export type BenchTurnMetrics = {
  turnIdx: number;
  prompt: string;
  /** Wall-clock ms from receivedAt to first streamed text token. Null if the turn errored before any text. */
  ttftMs: number | null;
  /** Wall-clock ms from receivedAt to the `done` event. */
  totalMs: number;
  /** Pre-API harness overhead — receivedAt → queryStart. Pulled from `debug_phases`. */
  harnessOverheadMs: number | null;
  /** Subset of `debug_phases` offsets, all relative to receivedAt. */
  phases: {
    dispatchMs: number | null;
    ctxBuildMs: number | null;
    queryStartMs: number | null;
  };
  /** First 16 hex of the systemAppend hash — same value across turns ⇒ cache-friendly. */
  systemAppendSha256: string | null;
  systemAppendBytes: number | null;
  /** Numbers from the SDK / CLI `result` event's `usage` block. */
  numTurns: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheCreationTokens: number | null;
  totalCostUsd: number | null;
  /** Per-tool wall-clock latencies, in arrival order. */
  toolLatencies: Array<{
    name: string;
    durationMs: number;
    isError: boolean;
  }>;
  toolCallsByName: Record<string, number>;
  /** Set to the error message if the turn ended with an `error` event. */
  errored: string | null;
};

export type BenchEngineRun = {
  engine: BenchEngine;
  iteration: number;
  sessionId: string;
  turns: BenchTurnMetrics[];
  /** Sum of `totalMs` across all turns in this run. */
  totalMs: number;
  /** Aggregated token counts across all turns. */
  sumInputTokens: number;
  sumOutputTokens: number;
  sumCacheReadTokens: number;
  sumCacheCreationTokens: number;
  /** Cache hit ratio across the run: cacheRead / (cacheRead + non-cached input). */
  cacheHitRatio: number | null;
  totalCostUsd: number;
};

export type BenchReport = {
  scenario: string;
  envId: string;
  startedAt: string;
  finishedAt: string;
  iterations: number;
  engines: BenchEngine[];
  prompts: string[];
  runs: BenchEngineRun[];
};

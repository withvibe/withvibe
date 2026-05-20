import { Injectable } from "@nestjs/common";
import { mkdir, writeFile } from "fs/promises";
import path from "path";
import { PrismaService } from "../../prisma/prisma.service";
import { ChatContextService } from "../chat-context.service";
import { ChatStreamService } from "../chat-stream.service";
import { runCcDirect } from "./cc-direct-runner";
import type {
  BenchEngine,
  BenchEngineRun,
  BenchReport,
  BenchScenario,
  BenchTurnMetrics,
} from "./bench.types";
import { InjectPinoLogger, PinoLogger } from "nestjs-pino";

/**
 * Drives a `BenchScenario` through one or both engines and emits a structured
 * `BenchReport`. The bench bypasses the active-runs queue + SSE plumbing and
 * calls `ChatStreamService.stream()` directly — that's what we want, because
 * we're trying to measure the engine itself, not the queue/SSE wrappers (the
 * `debug_phases` event already reports their cost in production paths).
 *
 * Each iteration creates a fresh `ChatSession` so prompt-cache behavior is
 * exercised honestly (cold first turn, warm follow-ups).
 */
@Injectable()
export class BenchService {
  constructor(
    @InjectPinoLogger(BenchService.name)
    private readonly logger: PinoLogger,
    private readonly prisma: PrismaService,
    private readonly context: ChatContextService,
    private readonly chat: ChatStreamService
  ) {}

  /** Default output dir — relative to repo root. CLI / endpoint can override. */
  static readonly DEFAULT_OUT_DIR = "apps/api/bench/results";

  async run(scenario: BenchScenario): Promise<BenchReport> {
    const engines: BenchEngine[] =
      scenario.engines && scenario.engines.length > 0
        ? scenario.engines
        : ["agent_sdk", "claude_code", "claude_code_direct"];
    const iterations = Math.max(1, scenario.iterations ?? 1);

    const startedAt = new Date().toISOString();
    const runs: BenchEngineRun[] = [];

    // Alternate engines across iterations to spread out network jitter.
    // Iteration 1 → engines[0], engines[1]; iteration 2 → engines[1], engines[0]; etc.
    for (let i = 0; i < iterations; i++) {
      const order = i % 2 === 0 ? engines : [...engines].reverse();
      for (const engine of order) {
        this.logger.info(
          `[bench] iteration ${i + 1}/${iterations} engine=${engine} scenario="${scenario.name}"`
        );
        const run = await this.runOne(scenario, engine, i + 1);
        runs.push(run);
      }
    }

    const finishedAt = new Date().toISOString();
    return {
      scenario: scenario.name,
      envId: scenario.envId,
      startedAt,
      finishedAt,
      iterations,
      engines,
      prompts: scenario.prompts,
      runs,
    };
  }

  /** Persist a report to disk + return the absolute path written. */
  async writeReport(
    report: BenchReport,
    outDir: string = BenchService.DEFAULT_OUT_DIR
  ): Promise<string> {
    const stamp = report.startedAt.replace(/[:.]/g, "-");
    const safeName = report.scenario.replace(/[^a-z0-9_-]+/gi, "_");
    const fileName = `${stamp}_${safeName}.json`;
    const absDir = path.resolve(outDir);
    await mkdir(absDir, { recursive: true });
    const absPath = path.join(absDir, fileName);
    await writeFile(absPath, JSON.stringify(report, null, 2), "utf-8");
    this.logger.info(`[bench] report written: ${absPath}`);
    return absPath;
  }

  /** Render a Markdown summary table. Caller is responsible for printing/persisting. */
  formatMarkdown(report: BenchReport): string {
    const header = `# Bench: ${report.scenario}\n\nenv=${report.envId} iterations=${report.iterations} engines=${report.engines.join(",")}\n`;
    const rows: string[] = [];
    rows.push(
      "| iter | engine | turn | total ms | TTFT ms | overhead ms | input | output | cache rd | cache wr | hit% | $ |"
    );
    rows.push(
      "|------|--------|------|---------:|--------:|------------:|------:|-------:|---------:|---------:|-----:|--:|"
    );
    for (const run of report.runs) {
      run.turns.forEach((t) => {
        const cacheTotal =
          (t.cacheReadTokens ?? 0) +
          (t.inputTokens ?? 0) +
          (t.cacheCreationTokens ?? 0);
        const hit =
          cacheTotal === 0
            ? null
            : Math.round(((t.cacheReadTokens ?? 0) / cacheTotal) * 100);
        rows.push(
          `| ${run.iteration} | ${run.engine} | ${t.turnIdx} | ${t.totalMs} | ${t.ttftMs ?? "-"} | ${t.harnessOverheadMs ?? "-"} | ${t.inputTokens ?? "-"} | ${t.outputTokens ?? "-"} | ${t.cacheReadTokens ?? "-"} | ${t.cacheCreationTokens ?? "-"} | ${hit ?? "-"} | ${t.totalCostUsd?.toFixed(4) ?? "-"} |`
        );
      });
    }
    rows.push("");
    rows.push("## Run totals");
    rows.push(
      "| iter | engine | total ms | sum input | sum output | sum cache rd | hit% | $ |"
    );
    rows.push(
      "|------|--------|---------:|----------:|-----------:|-------------:|-----:|--:|"
    );
    for (const run of report.runs) {
      const hit = run.cacheHitRatio === null
        ? "-"
        : `${Math.round(run.cacheHitRatio * 100)}`;
      rows.push(
        `| ${run.iteration} | ${run.engine} | ${run.totalMs} | ${run.sumInputTokens} | ${run.sumOutputTokens} | ${run.sumCacheReadTokens} | ${hit} | ${run.totalCostUsd.toFixed(4)} |`
      );
    }
    return `${header}\n${rows.join("\n")}\n`;
  }

  /**
   * Run one (engine, iteration) pair: create a fresh session, fire each prompt
   * sequentially, drain events into per-turn metrics, return aggregate. Errors
   * in any turn are recorded on the turn but do not abort the iteration —
   * downstream comparison can still use the partial data.
   */
  private async runOne(
    scenario: BenchScenario,
    engine: BenchEngine,
    iteration: number
  ): Promise<BenchEngineRun> {
    // claude_code_direct doesn't touch our DB — it spawns the host CLI on a
    // clean cwd to give us a "no harness, no MCP, no systemAppend" baseline.
    if (engine === "claude_code_direct") {
      return runCcDirect(scenario, iteration);
    }

    // Fresh session per iteration — see (1) decision in plan: clean slate so
    // resume baggage doesn't pollute timings.
    const session = await this.prisma.client.chatSession.create({
      data: {
        envId: scenario.envId,
        userId: scenario.userId,
        title: `[bench] ${scenario.name} #${iteration} ${engine}`,
      },
    });

    const turns: BenchTurnMetrics[] = [];
    for (let idx = 0; idx < scenario.prompts.length; idx++) {
      const prompt = scenario.prompts[idx];
      const turn = await this.runTurn({
        scenarioName: scenario.name,
        engine,
        sessionId: session.id,
        envId: scenario.envId,
        userId: scenario.userId,
        prompt,
        turnIdx: idx,
      });
      turns.push(turn);
    }

    const sumInputTokens = sumOf(turns, (t) => t.inputTokens);
    const sumOutputTokens = sumOf(turns, (t) => t.outputTokens);
    const sumCacheReadTokens = sumOf(turns, (t) => t.cacheReadTokens);
    const sumCacheCreationTokens = sumOf(turns, (t) => t.cacheCreationTokens);
    const totalCostUsd = sumOf(turns, (t) => t.totalCostUsd ?? 0);
    const cacheDenom =
      sumCacheReadTokens + sumInputTokens + sumCacheCreationTokens;
    const cacheHitRatio = cacheDenom === 0 ? null : sumCacheReadTokens / cacheDenom;

    return {
      engine,
      iteration,
      sessionId: session.id,
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

  private async runTurn(args: {
    scenarioName: string;
    /** Only the in-process engines route through `runTurn`. claude_code_direct is dispatched in `runOne`. */
    engine: "agent_sdk" | "claude_code";
    sessionId: string;
    envId: string;
    userId: string;
    prompt: string;
    turnIdx: number;
  }): Promise<BenchTurnMetrics> {
    const receivedAt = Date.now();
    const dispatchAt = Date.now();
    const ctxBuildStartAt = Date.now();
    const context = await this.context.build(
      args.envId,
      args.userId,
      args.sessionId
    );
    const ctxBuildDoneAt = Date.now();

    // Force the engine under test + ensure debug events are emitted regardless
    // of workspace setting (the bench owns this run's lifecycle).
    const benchContext = {
      ...context,
      chatEngine: args.engine,
      debugMode: true,
    };

    const metrics: BenchTurnMetrics = {
      turnIdx: args.turnIdx,
      prompt: args.prompt,
      ttftMs: null,
      totalMs: 0,
      harnessOverheadMs: null,
      phases: { dispatchMs: null, ctxBuildMs: null, queryStartMs: null },
      systemAppendSha256: null,
      systemAppendBytes: null,
      numTurns: null,
      inputTokens: null,
      outputTokens: null,
      cacheReadTokens: null,
      cacheCreationTokens: null,
      totalCostUsd: null,
      toolLatencies: [],
      toolCallsByName: {},
      errored: null,
    };

    try {
      for await (const ev of this.chat.stream({
        prompt: args.prompt,
        context: benchContext,
        marks: { receivedAt, dispatchAt, ctxBuildStartAt, ctxBuildDoneAt },
      })) {
        if (ev.type === "text" && metrics.ttftMs === null) {
          metrics.ttftMs = Date.now() - receivedAt;
        } else if (ev.type === "debug_phases") {
          metrics.harnessOverheadMs = ev.queryStartAt;
          metrics.phases = {
            dispatchMs: ev.dispatchAt,
            ctxBuildMs: ev.ctxBuildDoneAt - ev.ctxBuildStartAt,
            queryStartMs: ev.queryStartAt,
          };
          metrics.systemAppendSha256 = ev.systemAppendSha256;
          metrics.systemAppendBytes = ev.systemAppendBytes;
        } else if (ev.type === "debug_tool_latency") {
          metrics.toolLatencies.push({
            name: ev.name,
            durationMs: ev.durationMs,
            isError: ev.isError ?? false,
          });
        } else if (ev.type === "debug_meta") {
          metrics.numTurns = ev.numTurns ?? null;
          metrics.inputTokens = ev.inputTokens ?? null;
          metrics.outputTokens = ev.outputTokens ?? null;
          metrics.cacheReadTokens = ev.cacheReadTokens ?? null;
          metrics.cacheCreationTokens = ev.cacheCreationTokens ?? null;
          metrics.totalCostUsd = ev.totalCostUsd ?? null;
          metrics.toolCallsByName = ev.toolCallsByName;
        } else if (ev.type === "error") {
          metrics.errored = ev.message;
        } else if (ev.type === "done") {
          // We measure to the done event so cost/tokens are guaranteed already
          // captured (debug_meta lands just before done in chat-stream).
          metrics.totalMs = Date.now() - receivedAt;
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      metrics.errored = metrics.errored ?? msg;
      this.logger.error(
        `[bench] turn failed: scenario="${args.scenarioName}" engine=${args.engine} turn=${args.turnIdx}: ${msg}`
      );
    }

    if (metrics.totalMs === 0) {
      // No `done` event arrived (errored mid-stream). Still record wall-clock
      // so the row isn't blank in the report.
      metrics.totalMs = Date.now() - receivedAt;
    }

    return metrics;
  }
}

function sumOf<T>(items: T[], pick: (t: T) => number | null): number {
  return items.reduce((acc, it) => acc + (pick(it) ?? 0), 0);
}

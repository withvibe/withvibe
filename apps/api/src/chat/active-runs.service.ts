import { Injectable } from "@nestjs/common";
import { randomUUID } from "crypto";
import { PrismaService } from "../prisma/prisma.service";
import { ChatContextService, type ChatContext } from "./chat-context.service";
import {
  ChatStreamService,
  type ChatEvent,
  type DebugEvent,
} from "./chat-stream.service";
import { InjectPinoLogger, PinoLogger } from "nestjs-pino";

type DebugSdkEvent = Extract<DebugEvent, { type: "debug_sdk_event" }>;
type DebugMeta = Extract<DebugEvent, { type: "debug_meta" }>;

/**
 * A turn is an ordered list of blocks — text and tool calls interleaved in the
 * order the SDK/CLI emitted them. Lets the UI render a transcript that mirrors
 * the agent's actual flow ("let me read X → [Read tool] → now I'll edit Y →
 * [Edit tool] → done") instead of piling all tools above a monolithic text.
 */
export type MessageSegment =
  | { type: "text"; text: string }
  /** `id` is the model-assigned tool_use_id — the UI uses it to show per-tool wall-clock latency from `debug_tool_latency` events. Optional only because messages persisted before this feature don't carry it. */
  | { type: "tool_use"; name: string; input: unknown; id?: string };

export type StreamedEvent =
  | ChatEvent
  | { type: "user_saved"; id: string }
  | { type: "run_started"; runId: string }
  | { type: "run_ended"; status: "done" | "error" | "interrupted"; error?: string }
  | { type: "queued"; queuedCount: number }
  /**
   * Terminal frame — emitted once a turn ends *and* the per-session queue
   * is drained. Subscribers should close their SSE stream. This is what
   * separates "a turn just finished but another's coming" from "the session
   * is fully idle now".
   */
  | { type: "session_idle" };

export type ActiveRunStatus = "running" | "done" | "error" | "interrupted";

type Subscriber = (ev: StreamedEvent) => void;

/**
 * One in-flight agent turn. Lock granularity is **per-session** — different
 * sessions in the same env can run in parallel (Claude-Code-style: shared
 * cwd, user-coordinated; if two turns clash on files, that's the user's
 * problem, same as opening two terminals on one repo).
 *
 * If a new user message arrives for a session that already has a running
 * turn, it gets pushed to `pendingTurns` and dispatched as soon as the
 * current turn finishes. The user can keep typing — no 409, no disabled UI.
 */
type ActiveRun = {
  runId: string;
  envId: string;
  workspaceId: string;
  userId: string;
  sessionId: string;
  status: ActiveRunStatus;
  // Replay buffer for the current turn — cleared when a new turn starts so
  // late subscribers don't see a stale prior turn's events. Subscribers are
  // session-scoped (see sessionSubscribers) and survive across turns.
  events: StreamedEvent[];
  startedAt: Date;
  error?: string;
  // AbortController wired into the engine — interrupt() aborts it, which
  // breaks the SDK / kills the CLI child cleanly.
  abortController: AbortController;
  // Aggregates, kept so we can persist once the run ends.
  fullText: string;
  thinkingText: string;
  toolCalls: { name: string; input: unknown; id?: string }[];
  // Chronological transcript of this turn — text segments interleaved with
  // tool calls in the order they arrived from the model.
  segments: MessageSegment[];
  cost?: number;
  durationMs?: number;
  debugEvents: Array<Omit<DebugSdkEvent, "type">>;
  debugMeta?: Omit<DebugMeta, "type">;
  // Per-tool wall-clock latencies, keyed by tool_use_id. Populated from
  // `debug_tool_latency` events; persisted into message metadata so the UI
  // can show the durations on revisited turns.
  debugToolLatencies: Record<
    string,
    { name: string; durationMs: number; isError?: boolean }
  >;
  // Timer that removes the finished run from the map after a grace period
  // so late reconnects can still replay the final events.
  reapHandle?: NodeJS.Timeout;
  // Id of the assistant Message row, created on first text/tool event so
  // partial output survives an api process restart mid-stream.
  messageId?: string;
  // Latest persisted text length — used to decide whether a flush actually
  // has new content to write.
  persistedLen: number;
  // Timestamp of the last successful flush; throttles writes during streaming.
  lastFlushAt: number;
  // True while a flush is in flight, so we don't pile up parallel writes.
  flushInFlight: boolean;
};

/** A user message queued behind an active turn — dispatched as the next run. */
type PendingTurn = {
  workspaceId: string;
  envId: string;
  userId: string;
  sessionId: string;
  prompt: string;
  userMessageId: string;
  /** Wall-clock ms when the message hit `MessagesService.postMessage`. */
  receivedAt: number;
};

// How long a finished run stays in memory so reconnecting clients can still
// replay + see the ending. Client should have refetched the DB by then.
// Bumped from 60s — sleeping laptops, slow tabs, and network blips routinely
// take longer than a minute to reattach.
const FINISHED_RUN_TTL_MS = 10 * 60_000;
// Throttle for in-stream DB writes. ~1s is plenty smooth for the user and
// keeps DB load reasonable on long runs.
const FLUSH_INTERVAL_MS = 1_000;

/** Workspace-scoped run lifecycle event — emitted to workspace subscribers. */
export type WorkspaceRunEvent =
  | {
      type: "run_started";
      envId: string;
      sessionId: string;
      runId: string;
    }
  | {
      type: "run_ended";
      envId: string;
      sessionId: string;
      runId: string;
      status: "done" | "error" | "interrupted";
      error?: string;
    };

type WorkspaceSubscriber = (ev: WorkspaceRunEvent) => void;

@Injectable()
export class ActiveRunsService {
  // Keyed by sessionId — different sessions in the same env can run in parallel.
  private readonly runs = new Map<string, ActiveRun>();
  // Pending turns queued behind an in-flight run, FIFO per session.
  private readonly pending = new Map<string, PendingTurn[]>();
  // Session-scoped subscribers — outlive any single turn. When the server
  // auto-dispatches a queued turn behind the current one, subscribers stay
  // attached and receive the new turn's events transparently. Closed only
  // when the queue is drained (we emit a synthetic `session_idle` frame).
  private readonly sessionSubs = new Map<string, Set<Subscriber>>();
  // Subscribers interested in run lifecycle across an entire workspace (for
  // the env-list "agent running" indicator and completion notifications).
  private readonly workspaceSubs = new Map<string, Set<WorkspaceSubscriber>>();

  constructor(
    @InjectPinoLogger(ActiveRunsService.name)
    private readonly logger: PinoLogger,
    private readonly prisma: PrismaService,
    private readonly context: ChatContextService,
    private readonly chat: ChatStreamService
  ) {}

  /** Returns the active run for a session, if any. */
  get(sessionId: string): ActiveRun | undefined {
    return this.runs.get(sessionId);
  }

  /** Is a turn currently running for this session? */
  isRunning(sessionId: string): boolean {
    const run = this.runs.get(sessionId);
    return !!run && run.status === "running";
  }

  /** Is anything queued (or running) for this session? */
  pendingCount(sessionId: string): number {
    return this.pending.get(sessionId)?.length ?? 0;
  }

  /**
   * Env IDs in a workspace that currently have at least one running session.
   * De-duplicated — multiple parallel sessions in the same env collapse to
   * a single envId so the env-list indicator doesn't flicker.
   */
  listRunningEnvs(workspaceId: string): string[] {
    const out = new Set<string>();
    for (const r of this.runs.values()) {
      if (r.workspaceId === workspaceId && r.status === "running") {
        out.add(r.envId);
      }
    }
    return [...out];
  }

  /**
   * Subscribe to run_started / run_ended events for every session in a
   * workspace. Used by the env list + workspace shell to drive the "agent
   * running" indicator and completion notifications.
   */
  subscribeWorkspace(
    workspaceId: string,
    cb: WorkspaceSubscriber
  ): () => void {
    let set = this.workspaceSubs.get(workspaceId);
    if (!set) {
      set = new Set();
      this.workspaceSubs.set(workspaceId, set);
    }
    set.add(cb);
    return () => {
      const s = this.workspaceSubs.get(workspaceId);
      if (!s) return;
      s.delete(cb);
      if (s.size === 0) this.workspaceSubs.delete(workspaceId);
    };
  }

  private emitWorkspaceEvent(run: ActiveRun, ev: WorkspaceRunEvent) {
    const set = this.workspaceSubs.get(run.workspaceId);
    if (!set || set.size === 0) return;
    for (const sub of set) {
      try {
        sub(ev);
      } catch (err) {
        this.logger.warn(
          `Workspace subscriber threw (${ev.type}): ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }
  }

  /**
   * Enqueue a user message into the session's run pipeline. If nothing is
   * running, it kicks off a turn immediately. If a turn is mid-flight, the
   * message is queued and dispatched as soon as that turn finishes — the
   * client gets a synthetic `queued` event so the UI can show it.
   *
   * Returns the run that the new turn will run as (current run if queued,
   * the freshly started run otherwise) plus a flag indicating which.
   */
  enqueue(params: {
    envId: string;
    workspaceId: string;
    userId: string;
    sessionId: string;
    prompt: string;
    userMessageId: string;
    /** Optional — defaults to now. Caller should pass the moment the message hit the API. */
    receivedAt?: number;
  }): { run: ActiveRun; queued: boolean } {
    const receivedAt = params.receivedAt ?? Date.now();
    const existing = this.runs.get(params.sessionId);
    if (existing && existing.status === "running") {
      const queue = this.pending.get(params.sessionId) ?? [];
      queue.push({
        envId: params.envId,
        workspaceId: params.workspaceId,
        userId: params.userId,
        sessionId: params.sessionId,
        prompt: params.prompt,
        userMessageId: params.userMessageId,
        receivedAt,
      });
      this.pending.set(params.sessionId, queue);
      // The user_saved + queued events tell the live SSE consumer that the
      // new message landed and is waiting behind the current turn. They go
      // through pushEvent so they're buffered for late reattachers too.
      this.pushEvent(existing, {
        type: "user_saved",
        id: params.userMessageId,
      });
      this.pushEvent(existing, {
        type: "queued",
        queuedCount: queue.length,
      });
      this.logger.info(
        `Message queued: session=${params.sessionId} pending=${queue.length}`
      );
      return { run: existing, queued: true };
    }
    return { run: this.startTurn({ ...params, receivedAt }), queued: false };
  }

  /**
   * Start a new agent turn for a session. Caller has already verified that
   * no run is in flight for this session.
   */
  private startTurn(params: {
    envId: string;
    workspaceId: string;
    userId: string;
    sessionId: string;
    prompt: string;
    userMessageId: string;
    receivedAt: number;
  }): ActiveRun {
    // If there's a finished run lingering, replace it so reattach finds the
    // new turn instead of replaying the old finished events.
    this.reapNow(params.sessionId);

    const run: ActiveRun = {
      runId: randomUUID(),
      envId: params.envId,
      workspaceId: params.workspaceId,
      userId: params.userId,
      sessionId: params.sessionId,
      status: "running",
      events: [],
      startedAt: new Date(),
      abortController: new AbortController(),
      fullText: "",
      thinkingText: "",
      toolCalls: [],
      segments: [],
      debugEvents: [],
      debugToolLatencies: {},
      persistedLen: 0,
      lastFlushAt: 0,
      flushInFlight: false,
    };
    this.runs.set(params.sessionId, run);

    // Seed replay with the synthetic events the client needs.
    this.pushEvent(run, { type: "run_started", runId: run.runId });
    this.pushEvent(run, { type: "user_saved", id: params.userMessageId });
    this.emitWorkspaceEvent(run, {
      type: "run_started",
      envId: run.envId,
      sessionId: run.sessionId,
      runId: run.runId,
    });

    // Kick off the agent work in the background — intentionally not awaited.
    void this.execute(run, params.prompt, params.receivedAt);

    return run;
  }

  /**
   * Subscribe to a session's event stream. Replays buffered events for the
   * current turn, then streams live events through any queued auto-dispatched
   * turns until `session_idle` fires. Returns null if there's no run for
   * this session. The returned unsubscribe function is safe to call any time.
   */
  subscribe(sessionId: string, cb: Subscriber): (() => void) | null {
    const run = this.runs.get(sessionId);
    if (!run) return null;

    // Replay buffered events synchronously so the subscriber catches up.
    for (const ev of run.events) cb(ev);

    if (run.status !== "running" && this.pendingCount(sessionId) === 0) {
      // Turn already finished and nothing queued — emit session_idle so the
      // caller can close cleanly. Don't add to sessionSubs.
      cb({ type: "session_idle" });
      return () => {};
    }

    let set = this.sessionSubs.get(sessionId);
    if (!set) {
      set = new Set();
      this.sessionSubs.set(sessionId, set);
    }
    set.add(cb);
    return () => {
      const s = this.sessionSubs.get(sessionId);
      if (!s) return;
      s.delete(cb);
      if (s.size === 0) this.sessionSubs.delete(sessionId);
    };
  }

  /**
   * Abort every running turn belonging to an env and drop any queued messages
   * for those sessions. Called by env delete so a mid-build agent doesn't
   * keep writing into a clone directory that's about to be torn down. Returns
   * the number of runs that were aborted (informational; used for logging).
   */
  abortAllForEnv(envId: string): number {
    let aborted = 0;
    for (const run of this.runs.values()) {
      if (run.envId !== envId) continue;
      if (run.status !== "running") continue;
      this.pending.delete(run.sessionId);
      try {
        run.abortController.abort();
        aborted++;
      } catch {
        // already aborted — ignore
      }
    }
    if (aborted > 0) {
      this.logger.info(
        `Aborted ${aborted} in-flight run(s) for env ${envId} (env delete)`
      );
    }
    return aborted;
  }

  /**
   * Interrupt the current turn for this session. Aborts the SDK / runner and
   * **discards the queue** — if the user pressed stop they probably don't
   * want their queued messages to fire next either. Returns true if there
   * was a running turn to interrupt.
   */
  interrupt(sessionId: string): boolean {
    const run = this.runs.get(sessionId);
    if (!run || run.status !== "running") return false;
    this.pending.delete(sessionId);
    try {
      run.abortController.abort();
    } catch {
      // already aborted — ignore
    }
    this.logger.info(`Run interrupt requested: session=${sessionId}`);
    return true;
  }

  private pushEvent(run: ActiveRun, ev: StreamedEvent) {
    run.events.push(ev);
    const subs = this.sessionSubs.get(run.sessionId);
    if (!subs) return;
    for (const sub of subs) {
      try {
        sub(ev);
      } catch (err) {
        this.logger.warn(
          `Subscriber threw while handling event (${ev.type}): ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }
  }

  /** Direct emit to session subscribers without buffering on a run's events. */
  private emitToSession(sessionId: string, ev: StreamedEvent) {
    const subs = this.sessionSubs.get(sessionId);
    if (!subs) return;
    for (const sub of subs) {
      try {
        sub(ev);
      } catch (err) {
        this.logger.warn(
          `Session subscriber threw (${ev.type}): ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }
  }

  private async execute(
    run: ActiveRun,
    prompt: string,
    receivedAt: number
  ): Promise<void> {
    const dispatchAt = Date.now();
    const ctxBuildStartAt = Date.now();
    let context: ChatContext;
    try {
      context = await this.context.build(run.envId, run.userId, run.sessionId);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(
        { err: err instanceof Error ? err : new Error(String(err)) },
        `Context build failed for env=${run.envId} session=${run.sessionId}: ${msg}`
      );
      this.pushEvent(run, { type: "error", message: msg });
      this.finish(run, "error", msg);
      return;
    }
    const ctxBuildDoneAt = Date.now();

    this.logger.info(
      `Agent run starting: run=${run.runId} env=${run.envId} session=${run.sessionId}`
    );

    let errored = false;
    let errorMessage: string | undefined;
    let interrupted = false;

    try {
      for await (const ev of this.chat.stream({
        prompt,
        context,
        signal: run.abortController.signal,
        marks: { receivedAt, dispatchAt, ctxBuildStartAt, ctxBuildDoneAt },
      })) {
        if (run.abortController.signal.aborted) {
          interrupted = true;
          break;
        }
        this.pushEvent(run, ev);
        if (ev.type === "text") {
          run.fullText += ev.delta;
          const last = run.segments[run.segments.length - 1];
          if (last && last.type === "text") {
            last.text += ev.delta;
          } else {
            run.segments.push({ type: "text", text: ev.delta });
          }
          // Throttled flush so partial output survives an api restart.
          await this.maybeFlush(run);
        } else if (ev.type === "thinking") run.thinkingText += ev.delta;
        else if (ev.type === "tool_use") {
          run.toolCalls.push({ name: ev.name, input: ev.input, id: ev.id });
          run.segments.push({
            type: "tool_use",
            name: ev.name,
            input: ev.input,
            id: ev.id,
          });
          // Tool calls are visible boundaries — flush so the persisted
          // segment order reflects the live stream even mid-run.
          await this.maybeFlush(run, true);
        } else if (ev.type === "done") {
          run.cost = ev.cost;
          run.durationMs = ev.durationMs;
          if (!run.fullText) run.fullText = ev.fullText;
        } else if (ev.type === "debug_sdk_event") {
          const { type: _t, ...rest } = ev;
          run.debugEvents.push(rest);
        } else if (ev.type === "debug_meta") {
          const { type: _t, ...rest } = ev;
          run.debugMeta = rest;
        } else if (ev.type === "debug_tool_latency") {
          run.debugToolLatencies[ev.toolUseId] = {
            name: ev.name,
            durationMs: ev.durationMs,
            isError: ev.isError,
          };
        } else if (ev.type === "error") {
          errored = true;
          errorMessage = ev.message;
        }
      }
    } catch (err) {
      // Abort throws inside the SDK iterator — treat that as interrupt, not error.
      if (run.abortController.signal.aborted) {
        interrupted = true;
      } else {
        const msg = err instanceof Error ? err.message : String(err);
        this.logger.error(
          { err: err instanceof Error ? err : new Error(String(err)) },
          `Agent run exception: run=${run.runId} env=${run.envId} — ${msg}`
        );
        this.pushEvent(run, { type: "error", message: msg });
        errored = true;
        errorMessage = msg;
      }
    }

    if (interrupted) {
      this.pushEvent(run, {
        type: "error",
        message: "Interrupted by user",
      });
    }

    // Final persistence — write the full state and flip status to terminal.
    // If we already created a row mid-stream we just update it; otherwise we
    // create one now (covers runs that errored / were interrupted before any
    // text/tool event).
    const terminalStatus: "done" | "error" | "interrupted" = interrupted
      ? "interrupted"
      : errored
        ? "error"
        : "done";
    if (run.fullText || errored || interrupted) {
      try {
        await this.persistFinal(run, terminalStatus);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.logger.error(
          `Failed to persist assistant message: run=${run.runId} — ${msg}`
        );
      }
    }

    this.finish(run, terminalStatus, errorMessage);
  }

  /** Build the metadata JSON for an assistant Message row. */
  private buildMetadata(
    run: ActiveRun,
    status: "streaming" | "done" | "error" | "interrupted"
  ) {
    return JSON.parse(
      JSON.stringify({
        status,
        toolCalls: run.toolCalls,
        segments: run.segments.length ? run.segments : undefined,
        cost: run.cost,
        durationMs: run.durationMs,
        errored: status === "error",
        interrupted: status === "interrupted",
        thinking: run.thinkingText || undefined,
        debugEvents: run.debugEvents.length ? run.debugEvents : undefined,
        debugMeta: run.debugMeta,
        debugToolLatencies: Object.keys(run.debugToolLatencies).length
          ? run.debugToolLatencies
          : undefined,
      })
    );
  }

  /**
   * Flush the in-flight assistant message to the DB. Creates the row on the
   * first call (so process death after this point can't lose the partial
   * output) and updates it on subsequent calls. Throttled by FLUSH_INTERVAL_MS
   * unless `force` is true.
   */
  private async maybeFlush(run: ActiveRun, force = false): Promise<void> {
    if (run.flushInFlight) return;
    if (!run.fullText) return;
    if (run.fullText.length === run.persistedLen && run.messageId && !force) {
      return;
    }
    const now = Date.now();
    if (!force && now - run.lastFlushAt < FLUSH_INTERVAL_MS) return;

    run.flushInFlight = true;
    const snapshotLen = run.fullText.length;
    try {
      if (!run.messageId) {
        const row = await this.prisma.client.message.create({
          data: {
            envId: run.envId,
            userId: run.userId,
            sessionId: run.sessionId,
            role: "assistant",
            content: run.fullText,
            metadata: this.buildMetadata(run, "streaming"),
          },
          select: { id: true },
        });
        run.messageId = row.id;
      } else {
        await this.prisma.client.message.update({
          where: { id: run.messageId },
          data: {
            content: run.fullText,
            metadata: this.buildMetadata(run, "streaming"),
          },
        });
      }
      run.persistedLen = snapshotLen;
      run.lastFlushAt = Date.now();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.warn(
        `Mid-stream flush failed: run=${run.runId} — ${msg}`
      );
    } finally {
      run.flushInFlight = false;
    }
  }

  /** Final persist — guarantees the row exists and reflects terminal state. */
  private async persistFinal(
    run: ActiveRun,
    status: "done" | "error" | "interrupted"
  ): Promise<void> {
    const metadata = this.buildMetadata(run, status);
    if (run.messageId) {
      await this.prisma.client.message.update({
        where: { id: run.messageId },
        data: { content: run.fullText, metadata },
      });
    } else {
      const row = await this.prisma.client.message.create({
        data: {
          envId: run.envId,
          userId: run.userId,
          sessionId: run.sessionId,
          role: "assistant",
          content: run.fullText,
          metadata,
        },
        select: { id: true },
      });
      run.messageId = row.id;
    }
    run.persistedLen = run.fullText.length;
  }

  private finish(
    run: ActiveRun,
    status: "done" | "error" | "interrupted",
    error?: string
  ) {
    if (run.status !== "running") return;
    run.status = status;
    run.error = error;
    this.pushEvent(run, { type: "run_ended", status, error });
    this.emitWorkspaceEvent(run, {
      type: "run_ended",
      envId: run.envId,
      sessionId: run.sessionId,
      runId: run.runId,
      status,
      error,
    });
    this.logger.info(
      `Agent run finished: run=${run.runId} env=${run.envId} session=${run.sessionId} status=${status}`
    );
    // Keep it in the map briefly so reconnecting clients can replay the tail.
    run.reapHandle = setTimeout(() => {
      // Only reap if it's still the same run.
      const current = this.runs.get(run.sessionId);
      if (current === run) this.runs.delete(run.sessionId);
    }, FINISHED_RUN_TTL_MS);

    // On interrupt, the user wanted to stop — drop the queue and close the
    // session-level stream too.
    if (status === "interrupted") {
      this.pending.delete(run.sessionId);
      this.emitToSession(run.sessionId, { type: "session_idle" });
      this.sessionSubs.delete(run.sessionId);
      return;
    }

    // Drain queue: if more user messages piled up while this turn was running,
    // dispatch the next one immediately. Subscribers stay attached at the
    // session level — they'll see the new run_started without reconnecting.
    const queue = this.pending.get(run.sessionId);
    if (!queue || queue.length === 0) {
      // Fully idle now — emit session_idle so SSE consumers close.
      this.emitToSession(run.sessionId, { type: "session_idle" });
      this.sessionSubs.delete(run.sessionId);
      return;
    }
    const next = queue.shift()!;
    if (queue.length === 0) this.pending.delete(run.sessionId);
    else this.pending.set(run.sessionId, queue);
    // Tiny defer so the run_ended event flushes to subscribers before the
    // next run_started lands — keeps the UI's state machine simple.
    setImmediate(() => {
      this.startTurn(next);
    });
  }

  private reapNow(sessionId: string) {
    const existing = this.runs.get(sessionId);
    if (!existing) return;
    if (existing.status === "running") return;
    if (existing.reapHandle) clearTimeout(existing.reapHandle);
    this.runs.delete(sessionId);
  }
}

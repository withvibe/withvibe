import { Injectable } from "@nestjs/common";
import { InjectPinoLogger, PinoLogger } from "nestjs-pino";

/** One question as the model posed it — mirrors the SDK's AskUserQuestionInput. */
export type PendingQuestion = {
  question: string;
  header: string;
  multiSelect: boolean;
  options: { label: string; description: string; preview?: string }[];
};

export type QuestionAnswers = Record<string, string>;
export type QuestionAnnotations = Record<
  string,
  { preview?: string; notes?: string }
>;

/** What the waiting `canUseTool` call gets back. */
export type QuestionOutcome =
  | { answered: true; answers: QuestionAnswers; annotations?: QuestionAnnotations }
  | { answered: false; reason: string };

type Entry = {
  sessionId: string | null;
  envId: string;
  /** Only this user may answer — the speaker whose turn opened the question. */
  askedOfUserId: string;
  questions: PendingQuestion[];
  settle: (outcome: QuestionOutcome) => void;
  timer: NodeJS.Timeout;
  createdAt: number;
};

/**
 * How long a question may sit unanswered. The turn is held open for this
 * whole window (the model is blocked inside the tool call), so it trades
 * "user stepped away for coffee" against "a dead tab pins a run forever".
 */
const ANSWER_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * Blocking human-in-the-loop for the SDK's `AskUserQuestion` tool.
 *
 * Unlike [[HumanQuestionService]]'s `ask_human` — which queues to an inbox and
 * lets the turn finish — this one suspends the turn mid-tool-call: the SDK
 * calls `canUseTool`, we park a promise here, the browser answers over a
 * separate request, and the resolved answers go back as `updatedInput.answers`
 * so the model continues in the same turn.
 *
 * In-process by design: the promise being resolved lives in this Node process,
 * so the answering request must land on the same instance as the run. Fine for
 * the single-api-container deployment; revisit if the api is ever scaled out.
 */
@Injectable()
export class PendingQuestionsService {
  constructor(
    @InjectPinoLogger(PendingQuestionsService.name)
    private readonly logger: PinoLogger
  ) {}

  private readonly pending = new Map<string, Entry>();

  /**
   * Park a question and wait. Always settles — on answer, on cancel, or on
   * timeout — so a caller can `await` this without a deadlock path.
   */
  register(args: {
    toolUseId: string;
    sessionId: string | null;
    envId: string;
    askedOfUserId: string;
    questions: PendingQuestion[];
    signal?: AbortSignal;
  }): Promise<QuestionOutcome> {
    const { toolUseId } = args;
    return new Promise<QuestionOutcome>((resolve) => {
      let done = false;
      const settle = (outcome: QuestionOutcome) => {
        if (done) return;
        done = true;
        const entry = this.pending.get(toolUseId);
        if (entry) clearTimeout(entry.timer);
        this.pending.delete(toolUseId);
        resolve(outcome);
      };

      const timer = setTimeout(() => {
        this.logger.warn(`Question ${toolUseId} timed out unanswered`);
        settle({
          answered: false,
          reason: "The user did not answer in time.",
        });
      }, ANSWER_TIMEOUT_MS);
      // Don't hold the event loop open on an unanswered question.
      timer.unref?.();

      this.pending.set(toolUseId, {
        sessionId: args.sessionId,
        envId: args.envId,
        askedOfUserId: args.askedOfUserId,
        questions: args.questions,
        settle,
        timer,
        createdAt: Date.now(),
      });

      // An interrupted run must not leave the model waiting on a question
      // whose UI is already gone.
      if (args.signal) {
        if (args.signal.aborted) {
          settle({ answered: false, reason: "The run was interrupted." });
        } else {
          args.signal.addEventListener(
            "abort",
            () => settle({ answered: false, reason: "The run was interrupted." }),
            { once: true }
          );
        }
      }
    });
  }

  /**
   * Questions this user still owes an answer to in this env/session. The card
   * lives in the streamed turn, so a page reload loses it while the run stays
   * parked — this is what lets the UI redraw it instead of leaving the user
   * staring at a stalled agent until the timeout fires.
   */
  listFor(args: {
    envId: string;
    sessionId: string | null;
    userId: string;
  }): { toolUseId: string; questions: PendingQuestion[]; askedAt: number }[] {
    const out: {
      toolUseId: string;
      questions: PendingQuestion[];
      askedAt: number;
    }[] = [];
    for (const [toolUseId, entry] of this.pending) {
      if (entry.envId !== args.envId) continue;
      if (entry.askedOfUserId !== args.userId) continue;
      if (args.sessionId !== null && entry.sessionId !== args.sessionId) continue;
      out.push({
        toolUseId,
        questions: entry.questions,
        askedAt: entry.createdAt,
      });
    }
    return out.sort((a, b) => a.askedAt - b.askedAt);
  }

  /** Metadata for the answering endpoint's authorization check. */
  peek(toolUseId: string): Pick<
    Entry,
    "sessionId" | "envId" | "askedOfUserId" | "questions"
  > | null {
    const e = this.pending.get(toolUseId);
    if (!e) return null;
    return {
      sessionId: e.sessionId,
      envId: e.envId,
      askedOfUserId: e.askedOfUserId,
      questions: e.questions,
    };
  }

  /**
   * Deliver the user's selection. Returns false when there's nothing waiting
   * — a double-submit, or an answer that arrived after the timeout.
   */
  answer(args: {
    toolUseId: string;
    userId: string;
    answers: QuestionAnswers;
    annotations?: QuestionAnnotations;
  }): { ok: true } | { ok: false; error: string } {
    const entry = this.pending.get(args.toolUseId);
    if (!entry) {
      return { ok: false, error: "This question is no longer waiting for an answer." };
    }
    if (entry.askedOfUserId !== args.userId) {
      return { ok: false, error: "Only the person asked can answer this question." };
    }
    entry.settle({
      answered: true,
      answers: args.answers,
      ...(args.annotations && { annotations: args.annotations }),
    });
    return { ok: true };
  }

  /** User dismissed the card — let the model carry on without an answer. */
  skip(toolUseId: string, userId: string): { ok: boolean } {
    const entry = this.pending.get(toolUseId);
    if (!entry || entry.askedOfUserId !== userId) return { ok: false };
    entry.settle({
      answered: false,
      reason: "The user skipped the question.",
    });
    return { ok: true };
  }
}

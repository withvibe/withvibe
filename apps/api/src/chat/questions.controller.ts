import {
  BadRequestException,
  Body,
  Controller,
  Get,
  NotFoundException,
  Param,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { CurrentUser } from "../auth/current-user.decorator";
import type { AuthUser } from "../auth/jwt.strategy";
import {
  PendingQuestionsService,
  type QuestionAnnotations,
  type QuestionAnswers,
} from "./pending-questions.service";

/**
 * Answers for an in-flight `AskUserQuestion`. The turn that asked is parked
 * inside `canUseTool` waiting on this call, so it must reach the same api
 * process that owns the run (see [[PendingQuestionsService]]).
 */
@Controller("workspaces/:workspaceId/envs/:envId/questions")
@UseGuards(JwtAuthGuard)
export class QuestionsController {
  constructor(private readonly pendingQuestions: PendingQuestionsService) {}

  /**
   * Questions still waiting on this user. Lets a reloaded page redraw a card
   * whose turn is parked server-side — without it the run looks hung until
   * the answer timeout fires.
   */
  @Get("pending")
  pending(
    @CurrentUser() user: AuthUser,
    @Param("envId") envId: string,
    @Query("sessionId") sessionId?: string
  ) {
    return this.pendingQuestions.listFor({
      envId,
      sessionId: sessionId?.trim() ? sessionId : null,
      userId: user.id,
    });
  }

  @Post(":toolUseId/answer")
  answer(
    @CurrentUser() user: AuthUser,
    @Param("envId") envId: string,
    @Param("toolUseId") toolUseId: string,
    @Body() body: { answers?: unknown; annotations?: unknown }
  ) {
    const waiting = this.pendingQuestions.peek(toolUseId);
    if (!waiting || waiting.envId !== envId) {
      throw new NotFoundException(
        "This question is no longer waiting for an answer."
      );
    }

    const answers = normalizeAnswers(body?.answers);
    if (!answers) {
      throw new BadRequestException(
        "answers must be an object mapping each question to the chosen option"
      );
    }
    // Every question must be answered — the model asked them as a set, and a
    // partial map would silently read as "no opinion" on the rest.
    const missing = waiting.questions
      .map((q) => q.question)
      .filter((q) => !answers[q]?.trim());
    if (missing.length > 0) {
      throw new BadRequestException(
        `Missing an answer for: ${missing.join("; ")}`
      );
    }

    const result = this.pendingQuestions.answer({
      toolUseId,
      userId: user.id,
      answers,
      ...(normalizeAnnotations(body?.annotations) && {
        annotations: normalizeAnnotations(body?.annotations)!,
      }),
    });
    if (!result.ok) throw new BadRequestException(result.error);
    return { ok: true };
  }

  /** Dismiss without answering — the model is told and carries on. */
  @Post(":toolUseId/skip")
  skip(
    @CurrentUser() user: AuthUser,
    @Param("envId") envId: string,
    @Param("toolUseId") toolUseId: string
  ) {
    const waiting = this.pendingQuestions.peek(toolUseId);
    if (!waiting || waiting.envId !== envId) {
      throw new NotFoundException(
        "This question is no longer waiting for an answer."
      );
    }
    const result = this.pendingQuestions.skip(toolUseId, user.id);
    if (!result.ok) {
      throw new NotFoundException(
        "This question is no longer waiting for an answer."
      );
    }
    return { ok: true };
  }
}

function normalizeAnswers(raw: unknown): QuestionAnswers | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const out: QuestionAnswers = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value !== "string") return null;
    out[key] = value;
  }
  return out;
}

function normalizeAnnotations(raw: unknown): QuestionAnnotations | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const out: QuestionAnnotations = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!value || typeof value !== "object") continue;
    const { preview, notes } = value as Record<string, unknown>;
    out[key] = {
      ...(typeof preview === "string" && { preview }),
      ...(typeof notes === "string" && { notes }),
    };
  }
  return Object.keys(out).length > 0 ? out : null;
}

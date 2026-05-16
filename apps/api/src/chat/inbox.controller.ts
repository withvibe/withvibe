import {
  BadRequestException,
  Body,
  Controller,
  Get,
  NotFoundException,
  Param,
  Post,
  UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { CurrentUser } from "../auth/current-user.decorator";
import type { AuthUser } from "../auth/jwt.strategy";
import { WorkspaceAccessService } from "../common/workspace-access.service";
import { HumanQuestionService } from "./human-question.service";

@Controller("workspaces/:workspaceId/inbox")
@UseGuards(JwtAuthGuard)
export class InboxController {
  constructor(
    private readonly access: WorkspaceAccessService,
    private readonly questions: HumanQuestionService
  ) {}

  @Get()
  async list(
    @CurrentUser() user: AuthUser,
    @Param("workspaceId") workspaceId: string
  ) {
    await this.access.member(user.id, workspaceId);
    return this.questions.listForUser(user.id, workspaceId);
  }

  @Get("count")
  async count(
    @CurrentUser() user: AuthUser,
    @Param("workspaceId") workspaceId: string
  ) {
    await this.access.member(user.id, workspaceId);
    const pending = await this.questions.pendingCount(user.id, workspaceId);
    return { pending };
  }

  @Post(":questionId/answer")
  async answer(
    @CurrentUser() user: AuthUser,
    @Param("workspaceId") workspaceId: string,
    @Param("questionId") questionId: string,
    @Body() body: { answer: string }
  ) {
    await this.access.member(user.id, workspaceId);
    try {
      return await this.questions.answer(user.id, questionId, body.answer || "");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes("not found")) throw new NotFoundException(message);
      throw new BadRequestException(message);
    }
  }

  @Post(":questionId/dismiss")
  async dismiss(
    @CurrentUser() user: AuthUser,
    @Param("workspaceId") workspaceId: string,
    @Param("questionId") questionId: string
  ) {
    await this.access.member(user.id, workspaceId);
    try {
      return await this.questions.dismiss(user.id, questionId);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes("not found")) throw new NotFoundException(message);
      throw new BadRequestException(message);
    }
  }
}

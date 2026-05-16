import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Post,
  UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard } from "../../auth/jwt-auth.guard";
import { CurrentUser } from "../../auth/current-user.decorator";
import type { AuthUser } from "../../auth/jwt.strategy";
import { WorkspaceAccessService } from "../../common/workspace-access.service";
import { PrismaService } from "../../prisma/prisma.service";
import { BenchService } from "./bench.service";
import type { BenchScenario } from "./bench.types";

/**
 * POST /api/bench — runs a `BenchScenario` synchronously and returns the
 * report. Authenticated, gated by workspace membership *and* the workspace's
 * `debugMode` flag, so a normal end-user can't kick off bench runs that
 * mutate sessions + spend tokens.
 *
 * Long requests: a multi-turn scenario can take minutes. Clients should set
 * a generous timeout. The CLI runner (`pnpm bench:chat`) is the friendlier
 * way to drive this for local development.
 */
@Controller("bench")
@UseGuards(JwtAuthGuard)
export class BenchController {
  constructor(
    private readonly bench: BenchService,
    private readonly access: WorkspaceAccessService,
    private readonly prisma: PrismaService
  ) {}

  @Post()
  async run(
    @CurrentUser() user: AuthUser,
    @Body() body: BenchScenario & { writeReport?: boolean }
  ) {
    const scenario = this.validate(body);

    const env = await this.prisma.client.env.findUnique({
      where: { id: scenario.envId },
      select: {
        workspaceId: true,
        deletedAt: true,
        workspace: { select: { debugMode: true } },
      },
    });
    if (!env || env.deletedAt) {
      throw new BadRequestException("Env not found");
    }
    await this.access.member(user.id, env.workspaceId);
    if (!env.workspace.debugMode) {
      throw new ForbiddenException(
        "Bench requires the workspace to have debugMode enabled"
      );
    }

    const report = await this.bench.run(scenario);
    let reportPath: string | null = null;
    if (body.writeReport !== false) {
      reportPath = await this.bench.writeReport(report);
    }
    return { report, reportPath, markdown: this.bench.formatMarkdown(report) };
  }

  private validate(input: BenchScenario): BenchScenario {
    if (typeof input.name !== "string" || !input.name.trim()) {
      throw new BadRequestException("name is required");
    }
    if (typeof input.envId !== "string" || !input.envId.trim()) {
      throw new BadRequestException("envId is required");
    }
    if (typeof input.userId !== "string" || !input.userId.trim()) {
      throw new BadRequestException("userId is required");
    }
    if (
      !Array.isArray(input.prompts) ||
      input.prompts.length === 0 ||
      !input.prompts.every((p) => typeof p === "string" && p.trim())
    ) {
      throw new BadRequestException("prompts must be a non-empty string[]");
    }
    if (
      input.engines &&
      !input.engines.every(
        (e) =>
          e === "agent_sdk" ||
          e === "claude_code" ||
          e === "claude_code_direct"
      )
    ) {
      throw new BadRequestException(
        "engines may only contain 'agent_sdk', 'claude_code', or 'claude_code_direct'"
      );
    }
    return input;
  }
}

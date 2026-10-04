import { Body, Controller, Get, Param, Post, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { CurrentUser } from "../auth/current-user.decorator";
import type { AuthUser } from "../auth/jwt.strategy";
import { WorkspaceAccessService } from "../common/workspace-access.service";
import { EnvSpecService } from "./env-spec.service";
import type { ComputeTarget } from "@withvibe/db";

/**
 * Authoring surface for environment specs.
 *
 * `preview` exists so the UI can validate and show the generated Compose
 * before anything is created — the spec is meant to be edited, and an editor
 * that only tells you about a mistake after provisioning is an editor people
 * stop trusting. It writes nothing.
 */
@Controller("workspaces/:workspaceId/env-spec")
@UseGuards(JwtAuthGuard)
export class EnvSpecController {
  constructor(
    private readonly spec: EnvSpecService,
    private readonly access: WorkspaceAccessService
  ) {}

  /** Catalog for the "add a service" picker. */
  @Get("service-types")
  async serviceTypes(
    @CurrentUser() user: AuthUser,
    @Param("workspaceId") workspaceId: string
  ) {
    await this.access.member(user.id, workspaceId);
    return { serviceTypes: this.spec.serviceTypes() };
  }

  /** Validate a spec and return what it would compile to. Creates nothing. */
  @Post("preview")
  async preview(
    @CurrentUser() user: AuthUser,
    @Param("workspaceId") workspaceId: string,
    @Body() body: { spec?: unknown; computeTarget?: unknown }
  ) {
    await this.access.member(user.id, workspaceId);
    const target: ComputeTarget =
      body?.computeTarget === "fargate" ? "fargate" : "local";
    const compiled = this.spec.parseAndCompile({
      input: body?.spec,
      target,
    });
    return {
      ok: true,
      computeTarget: target,
      composeFile: compiled.composeYaml,
      httpService: compiled.httpService,
      notes: compiled.notes,
      // Credentials are shown back deliberately: the platform invented them,
      // so this is the only place the user can learn what they are.
      credentials: compiled.credentials,
    };
  }
}

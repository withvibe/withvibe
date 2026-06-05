import { Injectable } from "@nestjs/common";
import { InjectPinoLogger, PinoLogger } from "nestjs-pino";
import { PrismaService } from "../prisma/prisma.service";
import { DemoModeService } from "../common/demo-mode.service";
import { WorkspacesService } from "../workspaces/workspaces.service";
import { EnvsService } from "../envs/envs.service";

/**
 * In DEMO_MODE, every fresh visitor is dropped into their OWN isolated
 * workspace already running one cloned `vibe-aquarium` env, so they can click
 * straight in and start vibe coding. This reuses the existing
 * `WorkspacesService.create()` (seeds the aquarium template) and
 * `EnvsService.create()` (materializes + starts the env, clone/build async).
 *
 * Idempotent + best-effort: skips if the user already belongs to a workspace,
 * and never throws to its caller (a transient clone failure must not block
 * account creation — the user can still spin the one allowed env up by hand).
 */
@Injectable()
export class DemoProvisionService {
  constructor(
    @InjectPinoLogger(DemoProvisionService.name)
    private readonly logger: PinoLogger,
    private readonly prisma: PrismaService,
    private readonly demo: DemoModeService,
    private readonly workspaces: WorkspacesService,
    private readonly envs: EnvsService
  ) {}

  /** Provision the demo workspace + aquarium env for a (usually brand-new) user. */
  async provisionDemoWorkspace(userId: string): Promise<void> {
    if (!this.demo.enabled) return;
    try {
      // Already has a workspace? Then this user was provisioned before (or is
      // an existing account); don't create duplicates.
      const memberships = await this.prisma.client.workspaceMember.count({
        where: { userId },
      });
      if (memberships > 0) return;

      // Personalize the workspace name so an invited member doesn't end up with
      // two identically-named "Demo — vibe-aquarium" workspaces (their own +
      // the one they were invited to). Falls back to the email local-part, then
      // a short id suffix, so it's always distinct.
      const user = await this.prisma.client.user.findUnique({
        where: { id: userId },
        select: { name: true, email: true },
      });
      const owner =
        user?.name?.trim() ||
        user?.email?.split("@")[0]?.trim() ||
        `user-${userId.slice(-4)}`;
      const { id: workspaceId } = await this.workspaces.create(userId, {
        name: `${owner}'s aquarium`,
      });

      const template = await this.prisma.client.envTemplate.findUnique({
        where: {
          workspaceId_slug: {
            workspaceId,
            slug: this.demo.templateSlug,
          },
        },
        select: { id: true },
      });
      if (!template) {
        this.logger.warn(
          `demo provision: aquarium template missing for workspace ${workspaceId} ` +
            `(is DEMO_TEMPLATE_REPOS / the vibe-aquarium repo reachable?)`
        );
        return;
      }

      await this.envs.create(userId, workspaceId, {
        title: this.demo.templateSlug,
        templateId: template.id,
      });

      await this.prisma.client.user.update({
        where: { id: userId },
        data: { defaultWorkspaceId: workspaceId },
      });

      this.logger.info(
        `demo provision: workspace ${workspaceId} + aquarium env ready for user ${userId}`
      );
    } catch (err) {
      this.logger.error(
        `demo provision failed for user ${userId}: ${
          err instanceof Error ? err.message : String(err)
        }`
      );
    }
  }
}

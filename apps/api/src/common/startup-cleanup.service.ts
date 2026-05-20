import { Injectable, OnApplicationBootstrap } from "@nestjs/common";
import { execFile } from "child_process";
import { promisify } from "util";
import { PrismaService } from "../prisma/prisma.service";
import { InjectPinoLogger, PinoLogger } from "nestjs-pino";
import { composeProjectName } from "../docker/compose-naming";

const exec = promisify(execFile);

/**
 * Reset "in-flight" statuses that survived a process restart, then reconcile
 * envs marked "running" against actual Docker state.
 *
 * In-flight (cloning/creating/building/starting/stopping) → "error": the
 * background job died with the process and won't ever finish.
 *
 * "running" → reconcile with `docker ps`: env containers usually have no
 * restart policy, so a host reboot leaves them stopped while the DB still
 * says running. Templates that opt into `restart: unless-stopped` (e.g. the
 * aquarium demo) genuinely come back, so we can't blindly flip everything
 * to stopped — we ask Docker per env.
 */
@Injectable()
export class StartupCleanupService implements OnApplicationBootstrap {
  constructor(
    @InjectPinoLogger(StartupCleanupService.name)
    private readonly logger: PinoLogger,
    private readonly prisma: PrismaService
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    const c = this.prisma.client;
    const reason = "interrupted by Nest restart — please retry";

    const [clones, envClones, envs] = await Promise.all([
      c.repoClone.updateMany({
        where: { cloneStatus: "cloning" },
        data: { cloneStatus: "error", errorMsg: reason },
      }),
      c.envRepo.updateMany({
        where: { envCloneStatus: "creating" },
        data: { envCloneStatus: "error", envCloneError: reason },
      }),
      c.env.updateMany({
        where: {
          containerStatus: { in: ["starting", "building", "stopping"] },
        },
        data: { containerStatus: "error", containerError: reason },
      }),
    ]);

    const total = clones.count + envClones.count + envs.count;
    if (total > 0) {
      this.logger.warn(
        `Startup cleanup: reset ${clones.count} repo clones, ${envClones.count} env clones, ${envs.count} envs stuck mid-job`
      );
    } else {
      this.logger.info("Startup cleanup: nothing to reset");
    }

    await this.reconcileRunningEnvs();
  }

  private async reconcileRunningEnvs(): Promise<void> {
    const c = this.prisma.client;
    const runningEnvs = await c.env.findMany({
      where: { containerStatus: "running" },
      select: { id: true },
    });
    if (runningEnvs.length === 0) return;

    const results = await Promise.all(
      runningEnvs.map(async (e) => ({
        id: e.id,
        alive: await this.composeProjectHasRunningContainer(e.id),
      }))
    );

    const dead = results.filter((r) => r.alive === false).map((r) => r.id);
    const unknown = results.filter((r) => r.alive === null).length;

    if (dead.length > 0) {
      await c.env.updateMany({
        where: { id: { in: dead } },
        data: { containerStatus: "stopped", containerPorts: {} },
      });
      this.logger.warn(
        `Startup cleanup: flipped ${dead.length} env(s) from running → stopped (no live container found)`
      );
    }
    if (unknown > 0) {
      this.logger.warn(
        `Startup cleanup: could not verify ${unknown} env(s) (docker unreachable); left as-is`
      );
    }
  }

  // null = docker call failed (don't touch DB), true/false = authoritative.
  private async composeProjectHasRunningContainer(
    envId: string
  ): Promise<boolean | null> {
    const project = composeProjectName(envId);
    try {
      const { stdout } = await exec(
        "docker",
        [
          "ps",
          "-q",
          "--filter",
          `label=com.docker.compose.project=${project}`,
          "--filter",
          "status=running",
        ],
        { timeout: 10_000 }
      );
      return stdout.trim().length > 0;
    } catch (err) {
      this.logger.debug(
        { envId, err: (err as Error).message },
        "docker ps failed during reconcile"
      );
      return null;
    }
  }
}

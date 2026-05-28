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
 * to stopped — we ask Docker per env. A host reboot can also bring *some*
 * services back (those with a restart policy) but not others, leaving the
 * env half-up; we report that as "partial" so the badge stops claiming a
 * fully-running env when servlet/db are actually down.
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
        state: await this.composeProjectState(e.id),
      }))
    );

    // null state = docker call failed → leave the env as-is.
    // total === 0 (no containers at all) or running === 0 → stopped.
    // 0 < running < total → partial (some services up, some down).
    // running === total → fully up, leave as "running".
    const dead = results
      .filter((r) => r.state && r.state.running === 0)
      .map((r) => r.id);
    const partial = results
      .filter(
        (r) => r.state && r.state.running > 0 && r.state.running < r.state.total
      )
      .map((r) => r.id);
    const unknown = results.filter((r) => r.state === null).length;

    if (dead.length > 0) {
      await c.env.updateMany({
        where: { id: { in: dead } },
        data: { containerStatus: "stopped", containerPorts: {} },
      });
      this.logger.warn(
        `Startup cleanup: flipped ${dead.length} env(s) from running → stopped (no live container found)`
      );
    }
    if (partial.length > 0) {
      await c.env.updateMany({
        where: { id: { in: partial } },
        data: { containerStatus: "partial" },
      });
      this.logger.warn(
        `Startup cleanup: flipped ${partial.length} env(s) from running → partial (only some services came back)`
      );
    }
    if (unknown > 0) {
      this.logger.warn(
        `Startup cleanup: could not verify ${unknown} env(s) (docker unreachable); left as-is`
      );
    }
  }

  // null = docker call failed (don't touch DB). Otherwise counts of how many
  // of the project's containers are running vs how many exist at all. Mirrors
  // finalizeAfterUp's definition that every compose service should be running.
  private async composeProjectState(
    envId: string
  ): Promise<{ running: number; total: number } | null> {
    const project = composeProjectName(envId);
    try {
      const { stdout } = await exec(
        "docker",
        [
          "ps",
          "-a",
          "--filter",
          `label=com.docker.compose.project=${project}`,
          "--format",
          "{{.State}}",
        ],
        { timeout: 10_000 }
      );
      const states = stdout
        .split("\n")
        .map((s) => s.trim())
        .filter(Boolean);
      return {
        running: states.filter((s) => s === "running").length,
        total: states.length,
      };
    } catch (err) {
      this.logger.debug(
        { envId, err: (err as Error).message },
        "docker ps failed during reconcile"
      );
      return null;
    }
  }
}

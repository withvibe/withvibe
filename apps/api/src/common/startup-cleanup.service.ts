import { Injectable, Logger, OnApplicationBootstrap } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";

/**
 * Reset "in-flight" statuses that survived a process restart.
 *
 * Fire-and-forget background jobs (git clones, env-clone creation, docker
 * compose up/down/rebuild) live only in this Nest process. If the process
 * died or was restarted mid-job, the DB row still says "cloning" /
 * "creating" / "building" and the UI hangs forever waiting for a status
 * that'll never flip.
 *
 * Cheap fix: on boot, flip anything stuck to "error" with an obvious
 * explanation. The user can retry. No queue needed.
 */
@Injectable()
export class StartupCleanupService implements OnApplicationBootstrap {
  private readonly logger = new Logger(StartupCleanupService.name);

  constructor(private readonly prisma: PrismaService) {}

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
      this.logger.log("Startup cleanup: nothing to reset");
    }
  }
}

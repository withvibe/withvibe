import { Injectable, NotFoundException } from "@nestjs/common";
import type { ComputeTarget } from "@withvibe/db";
import { PrismaService } from "../prisma/prisma.service";
import { LocalDockerDriver } from "./local-docker.driver";
import { FargateDriver } from "./fargate/fargate.driver";
import type { EnvComputeDriver } from "./env-compute-driver";

/**
 * Resolves an env to the compute driver that runs it. `Env.computeTarget` is
 * fixed at creation, so the driver for a given env never changes.
 *
 * A target present in the ComputeTarget enum but with no registered driver
 * fails loudly here — creation refuses such envs up front (EnvsService), so
 * hitting this error means a gap between the two lists.
 */
@Injectable()
export class EnvComputeService {
  private readonly drivers = new Map<ComputeTarget, EnvComputeDriver>();

  constructor(
    private readonly prisma: PrismaService,
    local: LocalDockerDriver,
    fargate: FargateDriver
  ) {
    this.register(local);
    this.register(fargate);
  }

  register(driver: EnvComputeDriver): void {
    this.drivers.set(driver.target, driver);
  }

  async driverFor(envId: string): Promise<EnvComputeDriver> {
    const env = await this.prisma.client.env.findUnique({
      where: { id: envId },
      select: { computeTarget: true },
    });
    if (!env) throw new NotFoundException(`Env ${envId} not found`);
    const driver = this.drivers.get(env.computeTarget);
    if (!driver) {
      throw new Error(
        `No compute driver registered for target "${env.computeTarget}" (env ${envId})`
      );
    }
    return driver;
  }
}

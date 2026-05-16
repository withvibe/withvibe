import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import net from "net";
import { PrismaService } from "../prisma/prisma.service";

const DEFAULT_RANGE_START = 30000;
const DEFAULT_RANGE_END = 39999;
const MAX_ATTEMPTS_PER_KEY = 40;

/**
 * Allocates unique host ports for template-driven envs and persists them in
 * the AllocatedPort table. Allocation is idempotent per (envId, key): calling
 * twice returns the same port.
 *
 * Collision sources:
 *   1. Another env already owns the port (DB unique on hostPort) → reroll.
 *   2. A non-managed process is listening on it (e.g. a leftover container
 *      started outside the platform) → probe with a short TCP listen and
 *      reroll if the port is busy.
 *
 * Races between concurrent allocate() calls are caught by the DB unique
 * constraint (P2002) — the loser rerolls.
 */
@Injectable()
export class PortAllocatorService {
  private readonly logger = new Logger(PortAllocatorService.name);
  private readonly rangeStart: number;
  private readonly rangeEnd: number;

  constructor(
    private readonly prisma: PrismaService,
    config: ConfigService
  ) {
    this.rangeStart = Number(config.get("ENV_PORT_RANGE_START")) || DEFAULT_RANGE_START;
    this.rangeEnd = Number(config.get("ENV_PORT_RANGE_END")) || DEFAULT_RANGE_END;
    if (this.rangeEnd <= this.rangeStart) {
      throw new Error("ENV_PORT_RANGE_END must be greater than ENV_PORT_RANGE_START");
    }
  }

  /** Returns the existing or newly allocated host port for each key. */
  async allocate(envId: string, keys: string[]): Promise<Record<string, number>> {
    const unique = Array.from(new Set(keys));
    if (unique.length === 0) return {};

    const existing = await this.prisma.client.allocatedPort.findMany({
      where: { envId, key: { in: unique } },
      select: { key: true, hostPort: true },
    });
    const byKey = new Map(existing.map((r) => [r.key, r.hostPort] as const));
    const remaining = unique.filter((k) => !byKey.has(k));

    for (const key of remaining) {
      const port = await this.allocateOne(envId, key);
      byKey.set(key, port);
    }

    const out: Record<string, number> = {};
    for (const k of unique) out[k] = byKey.get(k)!;
    return out;
  }

  async releaseForEnv(envId: string): Promise<void> {
    const { count } = await this.prisma.client.allocatedPort.deleteMany({
      where: { envId },
    });
    if (count > 0) {
      this.logger.log(`Released ${count} port(s) for env ${envId}`);
    }
  }

  private async allocateOne(envId: string, key: string): Promise<number> {
    for (let attempt = 0; attempt < MAX_ATTEMPTS_PER_KEY; attempt++) {
      const candidate = this.randomPort();
      if (!(await this.isPortFree(candidate))) continue;
      try {
        await this.prisma.client.allocatedPort.create({
          data: { envId, key, hostPort: candidate },
        });
        return candidate;
      } catch (err) {
        // P2002 = unique violation; treat as collision and try again.
        if ((err as { code?: string }).code !== "P2002") throw err;
      }
    }
    throw new Error(
      `Could not allocate host port for env ${envId} key ${key} after ${MAX_ATTEMPTS_PER_KEY} attempts ` +
        `(range ${this.rangeStart}-${this.rangeEnd})`
    );
  }

  private randomPort(): number {
    const span = this.rangeEnd - this.rangeStart + 1;
    return this.rangeStart + Math.floor(Math.random() * span);
  }

  private isPortFree(port: number): Promise<boolean> {
    return new Promise((resolve) => {
      const server = net.createServer();
      server.once("error", () => resolve(false));
      server.once("listening", () => {
        server.close(() => resolve(true));
      });
      // Bind to 0.0.0.0 — docker-compose publishes on the same interface,
      // so matching behavior here gives us a realistic probe.
      server.listen(port, "0.0.0.0");
    });
  }
}

import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { prisma } from "@withvibe/db";
import type { PrismaClient } from "@withvibe/db";

/**
 * Thin Nest-injectable wrapper around the shared Prisma singleton from
 * `@withvibe/db`. Reusing the singleton keeps connection pooling sane in
 * dev-server restarts and avoids two Prisma clients on the same DB.
 */
@Injectable()
export class PrismaService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PrismaService.name);
  readonly client: InstanceType<typeof PrismaClient> = prisma;

  async onModuleInit() {
    // Prisma connects lazily on first query, so nothing to do here.
    // Exposed for symmetry with shutdown.
    this.logger.log("Prisma ready (lazy-connect)");
  }

  async onModuleDestroy() {
    await this.client.$disconnect().catch(() => {});
  }
}

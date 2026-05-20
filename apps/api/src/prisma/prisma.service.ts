import { Injectable, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { InjectPinoLogger, PinoLogger } from "nestjs-pino";
import { prisma } from "@withvibe/db";
import type { PrismaClient } from "@withvibe/db";

/**
 * Thin Nest-injectable wrapper around the shared Prisma singleton from
 * `@withvibe/db`. Reusing the singleton keeps connection pooling sane in
 * dev-server restarts and avoids two Prisma clients on the same DB.
 *
 * On boot, we eagerly establish the TCP connection with retry+backoff. The
 * previous lazy-connect behaviour caused the very first login to hang
 * indefinitely on a fresh-install bringup, because the Prisma client was
 * created but the underlying connection wasn't actually opened until the
 * first query — and if Postgres wasn't ready yet, that query blocked
 * forever with the user staring at a spinner. Eager-connect surfaces the
 * problem at boot time (container restarts) instead of hanging requests.
 */
@Injectable()
export class PrismaService implements OnModuleInit, OnModuleDestroy {
  readonly client: InstanceType<typeof PrismaClient> = prisma;
  private connected = false;

  constructor(
    @InjectPinoLogger(PrismaService.name)
    private readonly logger: PinoLogger
  ) {}

  isReady(): boolean {
    return this.connected;
  }

  async onModuleInit() {
    const maxAttempts = 30;
    const delayMs = 1000;
    let lastErr: unknown = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        await this.client.$connect();
        // Validate the connection — $connect can resolve before the pool is
        // actually usable on some adapters; an explicit query is the
        // smallest safe probe.
        await this.client.$queryRaw`SELECT 1`;
        this.connected = true;
        if (attempt > 1) {
          this.logger.info(
            `Prisma connected on attempt ${attempt}/${maxAttempts}`
          );
        } else {
          this.logger.info("Prisma connected");
        }
        return;
      } catch (err) {
        lastErr = err;
        if (attempt === 1) {
          this.logger.warn(
            `Postgres not ready yet — retrying every ${delayMs}ms (up to ${maxAttempts} attempts)`
          );
        }
        await new Promise((r) => setTimeout(r, delayMs));
      }
    }
    this.logger.error(
      { err: lastErr instanceof Error ? lastErr : new Error(String(lastErr)) },
      `Prisma failed to connect after ${maxAttempts} attempts; aborting bootstrap so the container restarts.`
    );
    throw lastErr instanceof Error
      ? lastErr
      : new Error("Prisma connection failed");
  }

  async onModuleDestroy() {
    await this.client.$disconnect().catch(() => {});
  }
}

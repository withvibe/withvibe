import {
  Injectable,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from "@nestjs/common";
import { InjectPinoLogger, PinoLogger } from "nestjs-pino";
import { SocketModeClient } from "@slack/socket-mode";
import { PrismaService } from "../prisma/prisma.service";
import {
  SlackEventHandlerService,
  type SlackMessageEvent,
} from "./slack-event-handler.service";

/**
 * Owns one Socket Mode connection per workspace with both Slack tokens set
 * (`slackBotToken` + `slackAppToken`). Boots all configured workspaces on
 * application bootstrap; `reconnectWorkspace(id)` is called by
 * WorkspacesService when a token changes (add / replace / clear) so the
 * connection set stays in sync with DB state without a process restart.
 *
 * We boot on `onApplicationBootstrap` (not `onModuleInit`) deliberately:
 * Nest runs all providers' `onModuleInit` hooks concurrently, so an eager
 * DB query here would race PrismaService's connect-with-retry guard. On a
 * fresh install, Postgres' first-boot window briefly rejects auth, that
 * query throws, and the unhandled rejection crash-loops the container until
 * Postgres settles. `onApplicationBootstrap` only fires after every
 * `onModuleInit` resolves — i.e. after PrismaService has connected — so the
 * DB is guaranteed ready. The try/catch below is belt-and-suspenders: a DB
 * hiccup must never take the whole API process down.
 *
 * The SocketModeClient retries internally on transient disconnects — we
 * only own start/stop and the per-event routing into
 * SlackEventHandlerService.
 */
@Injectable()
export class SlackSocketService
  implements OnApplicationBootstrap, OnModuleDestroy
{
  // workspaceId → live client. Absence means "not connected" — either no
  // tokens, or the start() call hasn't returned yet.
  private clients = new Map<string, SocketModeClient>();

  constructor(
    @InjectPinoLogger(SlackSocketService.name)
    private readonly logger: PinoLogger,
    private readonly prisma: PrismaService,
    private readonly handler: SlackEventHandlerService
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    let workspaces: { id: string; slackAppToken: string | null }[];
    try {
      workspaces = await this.prisma.client.workspace.findMany({
        where: {
          slackBotToken: { not: null },
          slackAppToken: { not: null },
          deletedAt: null,
        },
        select: { id: true, slackAppToken: true, name: true },
      });
    } catch (err) {
      // Never let a boot-time DB error crash the process — Slack connections
      // are non-critical and `reconnectWorkspace` will re-establish them when
      // tokens are next touched.
      this.logger.warn(
        `Skipping Slack socket boot — DB query failed: ${
          err instanceof Error ? err.message : String(err)
        }`
      );
      return;
    }
    for (const ws of workspaces) {
      if (!ws.slackAppToken) continue;
      try {
        await this.connect(ws.id, ws.slackAppToken);
      } catch (err) {
        this.logger.warn(
          `Slack socket connect failed at boot (workspace=${ws.id}): ${
            err instanceof Error ? err.message : String(err)
          }`
        );
      }
    }
  }

  async onModuleDestroy(): Promise<void> {
    const all = Array.from(this.clients.entries());
    this.clients.clear();
    await Promise.allSettled(
      all.map(async ([id, client]) => {
        try {
          await client.disconnect();
        } catch (err) {
          this.logger.warn(
            `Slack socket disconnect error (workspace=${id}): ${
              err instanceof Error ? err.message : String(err)
            }`
          );
        }
      })
    );
  }

  /**
   * Sync the live connection for this workspace with current DB state.
   * Called from WorkspacesService.updateIntegrations after any Slack token
   * field changes. Handles all four cases:
   *   - both tokens set, no live client      → connect
   *   - both tokens set, live client exists  → reconnect (token may have rotated)
   *   - missing a token, live client exists  → disconnect
   *   - missing a token, no live client      → no-op
   */
  async reconnectWorkspace(workspaceId: string): Promise<void> {
    const existing = this.clients.get(workspaceId);
    if (existing) {
      this.clients.delete(workspaceId);
      try {
        await existing.disconnect();
      } catch (err) {
        this.logger.warn(
          `Slack socket teardown error (workspace=${workspaceId}): ${
            err instanceof Error ? err.message : String(err)
          }`
        );
      }
    }

    const ws = await this.prisma.client.workspace.findUnique({
      where: { id: workspaceId },
      select: { slackBotToken: true, slackAppToken: true },
    });
    if (!ws?.slackBotToken || !ws?.slackAppToken) return;

    try {
      await this.connect(workspaceId, ws.slackAppToken);
    } catch (err) {
      this.logger.warn(
        `Slack socket connect failed (workspace=${workspaceId}): ${
          err instanceof Error ? err.message : String(err)
        }`
      );
    }
  }

  private async connect(workspaceId: string, appToken: string): Promise<void> {
    const client = new SocketModeClient({ appToken });

    client.on("message", async (args: unknown) => {
      const { event, ack } = args as {
        event?: SlackMessageEvent;
        ack: () => Promise<void>;
      };
      try {
        await ack();
      } catch {
        // ack errors are non-fatal; Slack will redeliver if needed.
      }
      if (!event || event.type !== "message") return;
      try {
        await this.handler.handleMessageEvent(workspaceId, event);
      } catch (err) {
        this.logger.error(
          `Slack handler error (workspace=${workspaceId}): ${
            err instanceof Error ? err.message : String(err)
          }`
        );
      }
    });

    client.on("error", (err: Error) => {
      this.logger.warn(
        `Slack socket error (workspace=${workspaceId}): ${err.message}`
      );
    });

    await client.start();
    this.clients.set(workspaceId, client);
    this.logger.info(`Slack socket connected (workspace=${workspaceId})`);
  }
}

import { Injectable } from "@nestjs/common";
import { InjectPinoLogger, PinoLogger } from "nestjs-pino";
import { WebClient, ErrorCode } from "@slack/web-api";
import { PrismaService } from "../prisma/prisma.service";

export type SlackAuthInfo = {
  teamId: string;
  teamName: string;
  botUserId: string;
};

/**
 * Thin wrapper around @slack/web-api. Stateless on tokens — callers pass the
 * workspace bot token per call. The DB write for `slackBotToken` itself lives
 * in `WorkspacesService.updateIntegrations`, which calls `testToken` here to
 * validate + capture team metadata before persisting.
 *
 * Member→Slack-user mapping is the one stateful concern: `resolveMemberSlackId`
 * looks up by email on first use and caches the id on `User.slackUserId`.
 */
@Injectable()
export class SlackService {
  constructor(
    @InjectPinoLogger(SlackService.name)
    private readonly logger: PinoLogger,
    private readonly prisma: PrismaService
  ) {}

  /**
   * Validate a bot token by calling `auth.test`. Returns workspace metadata
   * on success; throws on failure with a user-friendly message.
   */
  async testToken(token: string): Promise<SlackAuthInfo> {
    const client = new WebClient(token);
    try {
      const res = await client.auth.test();
      if (!res.ok || !res.team_id || !res.team || !res.user_id) {
        throw new Error("Slack auth.test returned an unexpected response");
      }
      return {
        teamId: String(res.team_id),
        teamName: String(res.team),
        botUserId: String(res.user_id),
      };
    } catch (err) {
      const msg = friendlySlackError(err, "Invalid Slack bot token");
      throw new Error(msg);
    }
  }

  /**
   * Validate an app-level token (`xapp-...`) by opening + immediately closing
   * a Socket Mode connection via `apps.connections.open`. The endpoint
   * returns a WSS URL on success; failures (wrong scope, bad token) come back
   * as Slack errors we surface verbatim.
   */
  async testAppToken(appToken: string): Promise<void> {
    if (!appToken.startsWith("xapp-")) {
      throw new Error(
        "App-level tokens start with `xapp-`. The bot token (`xoxb-`) goes in the other field."
      );
    }
    const client = new WebClient(appToken);
    try {
      const res = await client.apps.connections.open();
      if (!res.ok || !res.url) {
        throw new Error("apps.connections.open returned an unexpected response");
      }
    } catch (err) {
      throw new Error(friendlySlackError(err, "Invalid Slack app-level token"));
    }
  }

  /**
   * Post a message to a channel, DM, or thread.
   * Pass `threadTs` to reply inside an existing thread.
   */
  async postMessage(
    token: string,
    params: { channel: string; text: string; threadTs?: string }
  ): Promise<{ channel: string; ts: string }> {
    const client = new WebClient(token);
    const res = await client.chat.postMessage({
      channel: params.channel,
      text: params.text,
      thread_ts: params.threadTs,
    });
    if (!res.ok || !res.channel || !res.ts) {
      throw new Error("Slack chat.postMessage failed");
    }
    return { channel: String(res.channel), ts: String(res.ts) };
  }

  /**
   * Upload a single file to a channel, DM, or thread via files.uploadV2.
   * `initialComment` becomes the accompanying message text (so callers can
   * "send a file + caption" in one call). `threadTs` makes it a thread reply.
   * Requires the bot scope `files:write`.
   */
  async uploadFile(
    token: string,
    params: {
      channel: string;
      file: Buffer;
      filename: string;
      initialComment?: string;
      threadTs?: string;
      title?: string;
    }
  ): Promise<void> {
    const client = new WebClient(token);
    // The SDK's `FilesUploadV2Arguments` is a discriminated union where the
    // thread variant requires `thread_ts: string` (not optional). TS can't
    // narrow when we conditionally include the field, so we build a plain
    // object and cast through `unknown` — the runtime payload is correct.
    const args: Record<string, unknown> = {
      channel_id: params.channel,
      file: params.file,
      filename: params.filename,
    };
    if (params.initialComment) args.initial_comment = params.initialComment;
    if (params.threadTs) args.thread_ts = params.threadTs;
    if (params.title) args.title = params.title;
    try {
      await client.files.uploadV2(
        args as unknown as Parameters<typeof client.files.uploadV2>[0]
      );
    } catch (err) {
      throw new Error(friendlySlackError(err, "Slack file upload failed"));
    }
  }

  /**
   * Look up a Slack user by email. Returns the Slack user id, or null when
   * no Slack member has that email. Throws on auth / transport errors.
   */
  async lookupByEmail(token: string, email: string): Promise<string | null> {
    const client = new WebClient(token);
    try {
      const res = await client.users.lookupByEmail({ email });
      if (!res.ok || !res.user?.id) return null;
      return res.user.id;
    } catch (err) {
      // `users_not_found` is an expected outcome for non-member emails.
      if (
        typeof err === "object" &&
        err &&
        "data" in err &&
        typeof (err as { data?: { error?: string } }).data?.error === "string" &&
        (err as { data: { error: string } }).data.error === "users_not_found"
      ) {
        return null;
      }
      throw new Error(friendlySlackError(err, "Slack lookup failed"));
    }
  }

  /**
   * Lazy resolver: return the cached `User.slackUserId` if present; otherwise
   * call `users.lookupByEmail` against the workspace's Slack token, cache the
   * result on the user, and return it. Returns null when Slack is not
   * connected for this workspace, or when the user has no matching Slack
   * account.
   */
  async resolveMemberSlackId(params: {
    workspaceId: string;
    userId: string;
  }): Promise<string | null> {
    const user = await this.prisma.client.user.findUnique({
      where: { id: params.userId },
      select: { id: true, email: true, slackUserId: true },
    });
    if (!user) return null;
    return this.resolveSlackUserByEmail({
      workspaceId: params.workspaceId,
      email: user.email,
      cachedSlackUserId: user.slackUserId,
      cacheOnUserId: user.id,
    });
  }

  /**
   * Email-keyed twin of `resolveMemberSlackId` — the agent tool path knows the
   * email (it gets it from the agent's tool call) but not necessarily the
   * WithVibe user id. Tries the cached User.slackUserId first when a User row
   * exists for this email, then falls through to `users.lookupByEmail` and
   * caches the result.
   */
  async resolveSlackUserByEmail(params: {
    workspaceId: string;
    email: string;
    /** Optional: skip the User lookup if the caller already has these. */
    cachedSlackUserId?: string | null;
    cacheOnUserId?: string;
  }): Promise<string | null> {
    if (params.cachedSlackUserId) return params.cachedSlackUserId;

    const ws = await this.prisma.client.workspace.findUnique({
      where: { id: params.workspaceId },
      select: { slackBotToken: true },
    });
    if (!ws?.slackBotToken) return null;

    let cacheOnUserId = params.cacheOnUserId;
    if (!cacheOnUserId) {
      const user = await this.prisma.client.user.findUnique({
        where: { email: params.email },
        select: { id: true, slackUserId: true },
      });
      if (user?.slackUserId) return user.slackUserId;
      cacheOnUserId = user?.id;
    }

    const slackUserId = await this.lookupByEmail(ws.slackBotToken, params.email);
    if (!slackUserId) return null;

    if (cacheOnUserId) {
      await this.prisma.client.user.update({
        where: { id: cacheOnUserId },
        data: { slackUserId },
      });
    }
    return slackUserId;
  }
}

function friendlySlackError(err: unknown, fallback: string): string {
  if (typeof err === "object" && err) {
    const code = (err as { code?: string }).code;
    const dataErr = (err as { data?: { error?: string } }).data?.error;
    if (code === ErrorCode.PlatformError && dataErr) {
      // E.g. invalid_auth, account_inactive, missing_scope, channel_not_found.
      return `Slack: ${dataErr}`;
    }
    if (code === ErrorCode.RequestError) {
      return "Slack: could not reach api.slack.com";
    }
    const msg = (err as { message?: string }).message;
    if (typeof msg === "string" && msg) return msg;
  }
  return fallback;
}

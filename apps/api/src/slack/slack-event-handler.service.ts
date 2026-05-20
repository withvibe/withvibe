import { Injectable } from "@nestjs/common";
import { InjectPinoLogger, PinoLogger } from "nestjs-pino";
import { PrismaService } from "../prisma/prisma.service";
import { MessagesService } from "../chat/messages.service";

/**
 * Subset of the Slack `message` event we care about. Slack actually delivers
 * a much bigger payload — we only reach in for the fields needed to match a
 * pending question and craft the agent turn.
 */
export type SlackMessageEvent = {
  type: string;
  subtype?: string;
  channel?: string;
  user?: string;
  text?: string;
  ts?: string;
  thread_ts?: string;
  bot_id?: string;
};

/**
 * Routes incoming Slack `message` events to the right pending question and
 * triggers an agent turn with the reply. Stateless — owned by
 * SlackSocketService, which is the only caller in normal operation.
 */
@Injectable()
export class SlackEventHandlerService {
  constructor(
    @InjectPinoLogger(SlackEventHandlerService.name)
    private readonly logger: PinoLogger,
    private readonly prisma: PrismaService,
    private readonly messages: MessagesService
  ) {}

  async handleMessageEvent(
    workspaceId: string,
    event: SlackMessageEvent
  ): Promise<void> {
    // Filter to thread replies only — ignore the bot's own parent message
    // (where thread_ts === ts) and any non-thread chatter in channels the
    // bot happens to see.
    if (!event.thread_ts || event.thread_ts === event.ts) return;
    // Ignore bot messages (including our own) and edits/joins/leaves.
    if (event.bot_id) return;
    if (event.subtype && event.subtype !== "thread_broadcast") return;
    if (!event.text || !event.user) return;

    const pending = await this.prisma.client.slackPendingQuestion.findUnique({
      where: { slackThreadTs: event.thread_ts },
    });
    if (!pending) return;
    // thread_ts is globally unique in practice, but defense in depth: an event
    // delivered by the wrong workspace's socket should never act on another
    // workspace's pending row.
    if (pending.workspaceId !== workspaceId) {
      this.logger.warn(
        `Slack event workspace mismatch: event=${workspaceId} pending=${pending.workspaceId} thread=${event.thread_ts}`
      );
      return;
    }
    if (pending.status !== "pending") return;

    const session = await this.prisma.client.chatSession.findUnique({
      where: { id: pending.chatSessionId },
      select: {
        id: true,
        userId: true,
        envId: true,
        env: { select: { workspaceId: true } },
      },
    });
    if (!session) {
      this.logger.warn(
        `Slack reply for vanished session ${pending.chatSessionId} — marking cancelled`
      );
      await this.prisma.client.slackPendingQuestion.update({
        where: { id: pending.id },
        data: { status: "cancelled", answeredAt: new Date() },
      });
      return;
    }

    // Resolve sender's WithVibe identity from the cached Slack user id. If
    // the slack_ask targeted them by email, User.slackUserId was cached at
    // that point — so DM replies almost always have a hit. Channel-wide
    // asks may get a sender we've never resolved; in that case we render
    // with the raw Slack handle and the agent's prompt still works.
    const sender = await this.prisma.client.user.findFirst({
      where: { slackUserId: event.user },
      select: { name: true, email: true },
    });
    const senderName = sender?.name ?? sender?.email ?? null;

    // Mark answered first. If the turn enqueue fails, we still have the
    // answer captured in the DB for the inbox UI to show.
    await this.prisma.client.slackPendingQuestion.update({
      where: { id: pending.id },
      data: {
        status: "answered",
        answer: event.text,
        answeredAt: new Date(),
        answeredBySlackUserId: event.user,
        answeredByName: senderName,
      },
    });

    const senderLabel =
      senderName ?? sender?.email ?? `Slack user <@${event.user}>`;
    const targetLabel = pending.askedEmail
      ? ` (asked of ${pending.askedEmail})`
      : "";
    // The `content` field is what the AGENT sees — full context. The UI
    // HIDES this message entirely from the asker (it would be noise in the
    // chat — the asker only wants the conclusion, like a manager who
    // delegates a question and only wants the final answer back). So the
    // agent itself must surface the relevant info from the reply when it
    // eventually responds.
    const senderRef = senderName ?? "the Slack responder";
    const content = [
      `[Slack reply — HIDDEN from the WithVibe chat UI]`,
      ``,
      `Your question${targetLabel}:`,
      `> ${pending.question.replace(/\n/g, "\n> ")}`,
      ``,
      `${senderLabel} replied on Slack:`,
      event.text,
      ``,
      `--- How to handle this ---`,
      ``,
      `This reply card is NOT shown to the WithVibe asker. They only see your text response (or nothing, if you continue the Slack convo). Decide one of:`,
      ``,
      `1. KEEP TALKING TO SLACK: if you need more from ${senderRef}, call \`slack_continue_thread\` with a follow-up. Your turn in this chat will be hidden — keep the conversation private until you have an answer.`,
      ``,
      `2. WRAP UP: if you have what you need, respond in this chat with the final answer AND call \`slack_conclude\` with a short summary. When mentioning the answer, ALWAYS attribute it like \`**${senderRef}** (via Slack): "<their answer>"\` so the asker knows where it came from.`,
      ``,
      `3. INVOLVE THE ASKER: if you genuinely need the WithVibe asker's input mid-Slack-conversation (clarification, choice between options ${senderRef} surfaced, etc.), respond in this chat normally — your text will be shown. Don't do this if ${senderRef}'s reply is just routine back-and-forth; only when the asker needs to weigh in.`,
    ].join("\n");

    try {
      await this.messages.startSessionTurn(
        session.userId,
        session.env.workspaceId,
        session.envId,
        session.id,
        content,
        {
          source: "slack_reply",
          slackThreadTs: event.thread_ts,
          slackChannel: event.channel,
          slackUserId: event.user,
          senderName,
          senderEmail: sender?.email ?? null,
          replyText: event.text,
          askedQuestion: pending.question,
          pendingQuestionId: pending.id,
        }
      );
    } catch (err) {
      this.logger.error(
        `Failed to trigger agent turn from Slack reply (session=${session.id}): ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }
}

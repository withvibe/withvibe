import { Injectable, NotFoundException } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { WorkspaceAccessService } from "../common/workspace-access.service";
import { AgentSeedService } from "../agents/agent-seed.service";
import { MessagesService } from "./messages.service";
import { InjectPinoLogger, PinoLogger } from "nestjs-pino";

/**
 * Phase ids the agent emits as it works through a scan. Kept in sync with
 * the UI's progress bar (apps/web .../_security-panel.tsx). Order matters —
 * the UI advances the bar by index.
 */
export const SECURITY_SCAN_PHASES = [
  "collect",
  "secrets",
  "deps",
  "code",
  "report",
] as const;

/**
 * The kickoff message we post (as the user) into the Security agent's
 * session. The agent already has a rich security persona + skills
 * (security-scope-recent-diff, *-injection-checks, *-secrets-scan,
 * *-finding-format). This prompt layers two machine-readable contracts on
 * top so the scan UI can render a progress bar + a structured diagnostic
 * instead of a raw chat transcript:
 *
 *  1. `::SCAN_PHASE:: <id>` lines — emitted on their own line when the agent
 *     enters each phase. Drives the progress bar.
 *  2. A single trailing ```scan-result fenced block of strict JSON — the
 *     authoritative result the diagnostic card renders from.
 */
function buildKickoffPrompt(): string {
  return `Run an automated **security scan** of the code changes in this environment.

This is triggered from a button, not a chat — a human is watching a progress bar, not reading this transcript. Follow the protocol below exactly.

## Scope
Review **every attached repo**. For each repo, look at *all* changes versus its base branch — committed, uncommitted, and untracked. Use git yourself to establish the diff (you have the \`security-scope-recent-diff\` skill — apply it per repo). Do not ask the user questions; make reasonable assumptions and note them in the report.

## Progress protocol
As you move through the scan, print a line **on its own**, exactly:

\`::SCAN_PHASE:: <id>\`

using these ids in order (skip none; emit each once, when you start that phase):

- \`collect\` — enumerating changed files across all repos
- \`secrets\` — scanning the diff for hardcoded secrets / credentials
- \`deps\` — checking dependency & config changes (lockfiles, Dockerfiles, CI, env)
- \`code\` — reviewing changed code for vulnerabilities (injection, authz, SSRF, XSS, deserialization, path traversal, crypto)
- \`report\` — compiling the final diagnostic

You may write normal analysis text between phase markers — that's fine.

## Final result (required)
After your human-readable findings, output **exactly one** fenced code block tagged \`scan-result\` containing **only** valid JSON (no comments, no trailing commas), matching this shape:

\`\`\`scan-result
{
  "verdict": "pass" | "warn" | "fail",
  "summary": "one or two sentences a developer can paste into a ticket",
  "counts": { "critical": 0, "high": 0, "medium": 0, "low": 0 },
  "findings": [
    {
      "severity": "critical" | "high" | "medium" | "low",
      "title": "short imperative title",
      "repo": "repo name or empty string",
      "file": "path/relative/to/repo or empty string",
      "line": 0,
      "detail": "what the bug is and the concrete attack",
      "recommendation": "how to fix it"
    }
  ]
}
\`\`\`

Verdict rule: \`fail\` if any critical/high finding, \`warn\` if only medium/low, \`pass\` if no findings. \`line\` is the 0 when not applicable. Keep \`findings\` empty (\`[]\`) when the changes are clean. The JSON block must be the last thing in your reply.`;
}

@Injectable()
export class SecurityScanService {
  constructor(
    @InjectPinoLogger(SecurityScanService.name)
    private readonly logger: PinoLogger,
    private readonly prisma: PrismaService,
    private readonly access: WorkspaceAccessService,
    private readonly agentSeed: AgentSeedService,
    private readonly messages: MessagesService
  ) {}

  private async assertEnv(
    userId: string,
    workspaceId: string,
    envId: string
  ) {
    await this.access.member(userId, workspaceId);
    const env = await this.prisma.client.env.findUnique({
      where: { id: envId },
      select: { workspaceId: true, deletedAt: true },
    });
    if (!env || env.workspaceId !== workspaceId || env.deletedAt) {
      throw new NotFoundException("Env not found");
    }
  }

  /**
   * Find (or create) the Security agent's chat session for this env + user.
   * Reuses one session per user so scan history stays in one Security
   * thread — matching how the chat UI's `openAgentSession` behaves.
   */
  private async ensureSession(
    userId: string,
    workspaceId: string,
    envId: string
  ): Promise<{ sessionId: string; agentId: string }> {
    // Idempotent — also backfills any newly-added Security seed skills.
    const { id: agentId } = await this.agentSeed.ensureSecurityAgent(
      workspaceId
    );

    const existing = await this.prisma.client.chatSession.findFirst({
      where: { envId, userId, agentId },
      orderBy: { createdAt: "asc" },
      select: { id: true },
    });
    if (existing) return { sessionId: existing.id, agentId };

    const created = await this.prisma.client.chatSession.create({
      data: { envId, userId, agentId, title: "Security review" },
      select: { id: true },
    });
    return { sessionId: created.id, agentId };
  }

  /**
   * Returns the Security session for this env (so the panel can load prior
   * scans / reattach to a running one), without starting anything.
   */
  async latest(
    userId: string,
    workspaceId: string,
    envId: string
  ): Promise<{ sessionId: string | null; agentId: string }> {
    await this.assertEnv(userId, workspaceId, envId);
    const { id: agentId } = await this.agentSeed.ensureSecurityAgent(
      workspaceId
    );
    const existing = await this.prisma.client.chatSession.findFirst({
      where: { envId, userId, agentId },
      orderBy: { createdAt: "asc" },
      select: { id: true },
    });
    return { sessionId: existing?.id ?? null, agentId };
  }

  /**
   * Kick off a scan: post the structured kickoff prompt into the Security
   * agent session and return the sessionId. The caller subscribes to the
   * run via the existing `/messages/active-run/stream` endpoint.
   */
  async start(
    userId: string,
    workspaceId: string,
    envId: string
  ): Promise<{ sessionId: string }> {
    await this.assertEnv(userId, workspaceId, envId);
    const { sessionId } = await this.ensureSession(
      userId,
      workspaceId,
      envId
    );
    await this.messages.startSessionTurn(
      userId,
      workspaceId,
      envId,
      sessionId,
      buildKickoffPrompt()
    );
    this.logger.info(
      `Security scan started: env=${envId} session=${sessionId} user=${userId}`
    );
    return { sessionId };
  }
}

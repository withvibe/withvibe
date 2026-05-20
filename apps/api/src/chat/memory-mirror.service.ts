import { Injectable } from "@nestjs/common";
import { mkdir, rm, writeFile } from "fs/promises";
import path from "path";
import { positionLabel } from "@withvibe/db";
import { PrismaService } from "../prisma/prisma.service";
import { InjectPinoLogger, PinoLogger } from "nestjs-pino";

/**
 * Ephemeral filesystem mirror of DB-backed memory.
 * Clobbered + rewritten at the start of every chat turn so the AI can
 * Read/Grep it natively. DB remains source of truth — the AI MUST use
 * save_* MCP tools to persist; writing to files directly has no effect.
 *
 * Layout is domain-shaped (workspace → members/agents/env) to mirror the
 * product model. Scoped to ONE workspace + ONE env per materialization
 * (the current chat's scope).
 */
@Injectable()
export class MemoryMirrorService {
  constructor(
    @InjectPinoLogger(MemoryMirrorService.name)
    private readonly logger: PinoLogger,
    private readonly prisma: PrismaService
  ) {}

  async materialize(args: {
    envDir: string;
    workspace: {
      id: string;
      name: string;
      description: string | null;
    };
    env: {
      id: string;
      title: string;
      status: string;
      description: string | null;
    };
    speakerUserId: string;
    /** If this session is bound to a member-clone, the clone owner's id. Same as speakerUserId for owner-bound clone sessions. Null otherwise. */
    cloneOwnerUserId: string | null;
    members: Array<{
      id: string;
      name: string | null;
      email: string;
      positions: string[];
      bio: string | null;
    }>;
    /** Agents enabled in this env — plus the bound agent if any. */
    enabledAgents: Array<{
      id: string;
      slug: string;
      name: string;
      description: string;
      systemPrompt: string;
      kind: string;
      cloneForUserId: string | null;
    }>;
    /** Per-agent skill summaries (applicable to this env). */
    agentSkillsSummary: Record<
      string,
      Array<{
        slug: string;
        name: string;
        description: string;
        scope: string;
      }>
    >;
  }): Promise<void> {
    const memoryDir = path.join(args.envDir, ".withvibe", "memory");
    await rm(memoryDir, { recursive: true, force: true }).catch(() => {});
    await mkdir(memoryDir, { recursive: true });

    try {
      await this.writeRoot(memoryDir);
      await this.writeWorkspaceInfo(memoryDir, args.workspace);
      await this.writeWorkspaceKnowledge(memoryDir, args.workspace.id);
      await this.writeEnv(memoryDir, args.env, args.enabledAgents);
      await this.writeMembers(
        memoryDir,
        args.members,
        args.speakerUserId,
        args.cloneOwnerUserId,
        args.workspace.id
      );
      await this.writeAgents(memoryDir, args.enabledAgents, args.agentSkillsSummary);
      await this.writeIndex(memoryDir, args);
    } catch (err) {
      this.logger.warn(`memory-mirror materialize failed: ${err}`);
    }
  }

  // ───────────────────────── Root files ─────────────────────────

  private async writeRoot(memoryDir: string): Promise<void> {
    const readme = `# Filesystem memory mirror — READ-ONLY

This tree is a **per-turn snapshot** of the DB-backed memory system. Use \`Read\`, \`Grep\`, and \`Glob\` here to search or quote specific entries. Writing files here has **no effect** — the mirror is regenerated every turn from the DB.

To persist a fact, use the appropriate \`save_*\` MCP tool:

| When you want to save… | Use |
|---|---|
| a behavior rule for a specific agent | \`save_skill\` |
| a team-wide fact (cross-env) | \`save_workspace_knowledge\` |
| a fact tied to ONE env | \`save_env_knowledge\` |
| a private note about the current speaker | \`save_member_memory\` |
| a question only the clone's owner can answer | \`ask_human\` |

Start at [INDEX.md](INDEX.md) for a quick tour of what's in this workspace.
`;
    await writeFile(path.join(memoryDir, "README.md"), readme, "utf-8");
  }

  private async writeIndex(
    memoryDir: string,
    args: {
      workspace: { name: string };
      env: { title: string };
      speakerUserId: string;
      cloneOwnerUserId: string | null;
      members: Array<{ id: string; name: string | null; email: string }>;
      enabledAgents: Array<{ id: string; slug: string; name: string }>;
    }
  ): Promise<void> {
    const memberLinks = args.members
      .map((m) => `- [${m.name || m.email}](members/${m.id}/PROFILE.md)`)
      .join("\n");
    const agentLinks = args.enabledAgents
      .map((a) => `- [${a.name}](agents/${a.id}/PERSONA.md)`)
      .join("\n");
    const speakerNote = `This session's speaker: \`members/${args.speakerUserId}/\` (your memory notes about them are under \`members/${args.speakerUserId}/memory/\`).`;
    const cloneNote =
      args.cloneOwnerUserId && args.cloneOwnerUserId !== args.speakerUserId
        ? `\nThis session is bound to a **clone** of member \`${args.cloneOwnerUserId}\`. Their memory is mirrored at \`members/${args.cloneOwnerUserId}/memory/\` — read it to embody them, but you cannot save there in this session.`
        : "";

    const body = `# Memory index — ${args.workspace.name} / ${args.env.title}

${speakerNote}${cloneNote}

## Quick links

- [Workspace info](WORKSPACE.md)
- [Workspace knowledge (cross-env facts)](workspace-knowledge/)
- [This env](env/INFO.md) — [enabled agents](env/AGENTS.md) — [env-specific knowledge](env/knowledge/)

## Members

${memberLinks || "(no members listed)"}

## Agents available in this env

${agentLinks || "(none)"}

---

Reminder: this is a **read-only mirror**. DB is source of truth. Persist via \`save_*\` MCP tools.
`;
    await writeFile(path.join(memoryDir, "INDEX.md"), body, "utf-8");
  }

  // ──────────────────────── Workspace ────────────────────────

  private async writeWorkspaceInfo(
    memoryDir: string,
    workspace: { id: string; name: string; description: string | null }
  ): Promise<void> {
    const body = `---
id: ${workspace.id}
name: ${yamlEscape(workspace.name)}
---

# ${workspace.name}

${workspace.description || "(no description)"}
`;
    await writeFile(path.join(memoryDir, "WORKSPACE.md"), body, "utf-8");
  }

  private async writeWorkspaceKnowledge(
    memoryDir: string,
    workspaceId: string
  ): Promise<void> {
    const rows = await this.prisma.client.workspaceKnowledge.findMany({
      where: { workspaceId },
      orderBy: { createdAt: "asc" },
      select: {
        slug: true,
        title: true,
        description: true,
        content: true,
        source: true,
        updatedAt: true,
      },
    });
    const dir = path.join(memoryDir, "workspace-knowledge");
    await mkdir(dir, { recursive: true });

    const indexLines = rows.length
      ? rows
          .map((r) => `- [${r.title}](${r.slug}.md) — ${r.description}`)
          .join("\n")
      : "(none yet — save cross-env facts with `save_workspace_knowledge`)";
    await writeFile(
      path.join(dir, "INDEX.md"),
      `# Workspace knowledge (cross-env, team-wide)\n\n${indexLines}\n`,
      "utf-8"
    );

    for (const r of rows) {
      const body = `---
tier: workspace
slug: ${r.slug}
title: ${yamlEscape(r.title)}
description: ${yamlEscape(r.description)}
source: ${r.source}
updated: ${r.updatedAt.toISOString()}
---

${r.content}
`;
      await writeFile(path.join(dir, `${r.slug}.md`), body, "utf-8");
    }
  }

  // ──────────────────────────── Env ────────────────────────────

  private async writeEnv(
    memoryDir: string,
    env: {
      id: string;
      title: string;
      status: string;
      description: string | null;
    },
    enabledAgents: Array<{ id: string; slug: string; name: string }>
  ): Promise<void> {
    const envDir = path.join(memoryDir, "env");
    await mkdir(envDir, { recursive: true });

    const info = `---
id: ${env.id}
title: ${yamlEscape(env.title)}
status: ${env.status}
---

# ${env.title}

Status: **${env.status}**

${env.description || "(no description)"}
`;
    await writeFile(path.join(envDir, "INFO.md"), info, "utf-8");

    const agentsList = enabledAgents.length
      ? enabledAgents
          .map((a) => `- [${a.name}](../agents/${a.id}/PERSONA.md) (\`${a.slug}\`)`)
          .join("\n")
      : "(no agents enabled in this env)";
    await writeFile(
      path.join(envDir, "AGENTS.md"),
      `# Agents enabled in this env\n\n${agentsList}\n`,
      "utf-8"
    );

    const kRows = await this.prisma.client.envKnowledge.findMany({
      where: { envId: env.id },
      orderBy: { createdAt: "asc" },
      select: {
        slug: true,
        title: true,
        description: true,
        content: true,
        source: true,
        updatedAt: true,
      },
    });
    const kDir = path.join(envDir, "knowledge");
    await mkdir(kDir, { recursive: true });
    const kIndex = kRows.length
      ? kRows
          .map((r) => `- [${r.title}](${r.slug}.md) — ${r.description}`)
          .join("\n")
      : "(none yet — save env-specific facts with `save_env_knowledge`)";
    await writeFile(
      path.join(kDir, "INDEX.md"),
      `# Env knowledge (specific to this env)\n\n${kIndex}\n`,
      "utf-8"
    );
    for (const r of kRows) {
      const body = `---
tier: env
slug: ${r.slug}
title: ${yamlEscape(r.title)}
description: ${yamlEscape(r.description)}
source: ${r.source}
updated: ${r.updatedAt.toISOString()}
---

${r.content}
`;
      await writeFile(path.join(kDir, `${r.slug}.md`), body, "utf-8");
    }
  }

  // ────────────────────────── Members ──────────────────────────

  private async writeMembers(
    memoryDir: string,
    members: Array<{
      id: string;
      name: string | null;
      email: string;
      positions: string[];
      bio: string | null;
    }>,
    speakerUserId: string,
    cloneOwnerUserId: string | null,
    workspaceId: string
  ): Promise<void> {
    const membersDir = path.join(memoryDir, "members");
    await mkdir(membersDir, { recursive: true });

    const indexBody = `# Members

Public roster. Each member has a \`PROFILE.md\` with public info. The current speaker's private \`memory/\` folder is also included; for clone-bound sessions, the clone owner's \`memory/\` is included as read-only.

${members
  .map(
    (m) =>
      `- [${m.name || m.email}](${m.id}/PROFILE.md) — ${m.email}${
        m.positions.length
          ? ` — ${m.positions.map(positionLabel).join(", ")}`
          : ""
      }`
  )
  .join("\n")}
`;
    await writeFile(path.join(membersDir, "INDEX.md"), indexBody, "utf-8");

    for (const m of members) {
      const userDir = path.join(membersDir, m.id);
      await mkdir(userDir, { recursive: true });
      await writeFile(
        path.join(userDir, "PROFILE.md"),
        this.memberProfile(m),
        "utf-8"
      );
    }

    // Speaker's own memory (always writeable by them via save_member_memory).
    await this.writeMemberMemory(
      path.join(membersDir, speakerUserId, "memory"),
      speakerUserId,
      workspaceId,
      members.find((m) => m.id === speakerUserId)?.name ||
        members.find((m) => m.id === speakerUserId)?.email ||
        "current speaker",
      /* readOnly= */ false
    );

    // Clone owner's memory — only if bound to a clone AND owner != speaker.
    if (cloneOwnerUserId && cloneOwnerUserId !== speakerUserId) {
      const owner = members.find((m) => m.id === cloneOwnerUserId);
      await this.writeMemberMemory(
        path.join(membersDir, cloneOwnerUserId, "memory"),
        cloneOwnerUserId,
        workspaceId,
        owner?.name || owner?.email || "the clone owner",
        /* readOnly= */ true
      );
    }
  }

  private memberProfile(m: {
    id: string;
    name: string | null;
    email: string;
    positions: string[];
    bio: string | null;
  }): string {
    const positions = m.positions.map(positionLabel).join(", ");
    return `---
id: ${m.id}
name: ${yamlEscape(m.name || "")}
email: ${m.email}
positions: ${yamlEscape(positions)}
---

# ${m.name || m.email}

- Email: ${m.email}
${positions ? `- Role(s): ${positions}\n` : ""}${m.bio ? `\nAbout them: ${m.bio}\n` : ""}`;
  }

  private async writeMemberMemory(
    dir: string,
    userId: string,
    workspaceId: string,
    displayName: string,
    readOnly: boolean
  ): Promise<void> {
    const rows = await this.prisma.client.memberMemory.findMany({
      where: { userId, workspaceId },
      orderBy: { createdAt: "asc" },
      select: {
        slug: true,
        title: true,
        description: true,
        content: true,
        source: true,
        updatedAt: true,
      },
    });
    await mkdir(dir, { recursive: true });

    const banner = readOnly
      ? `> **READ-ONLY in this session.** You are reading ${displayName}'s private memory because this session is bound to their clone. You cannot save to it here — only ${displayName} can, from their own sessions.\n\n`
      : `> This is your private memory about ${displayName}. Persist new notes with \`save_member_memory\` (they will appear here on the next turn).\n\n`;

    const indexList = rows.length
      ? rows
          .map((r) => `- [${r.title}](${r.slug}.md) — ${r.description}`)
          .join("\n")
      : "(no notes yet)";
    await writeFile(
      path.join(dir, "README.md"),
      `# Private notes about ${displayName}\n\n${banner}${indexList}\n`,
      "utf-8"
    );

    for (const r of rows) {
      const body = `---
tier: member_memory
user: ${userId}
slug: ${r.slug}
title: ${yamlEscape(r.title)}
description: ${yamlEscape(r.description)}
source: ${r.source}
updated: ${r.updatedAt.toISOString()}
readOnly: ${readOnly}
---

${r.content}
`;
      await writeFile(path.join(dir, `${r.slug}.md`), body, "utf-8");
    }
  }

  // ──────────────────────────── Agents ────────────────────────────

  private async writeAgents(
    memoryDir: string,
    enabledAgents: Array<{
      id: string;
      slug: string;
      name: string;
      description: string;
      systemPrompt: string;
      kind: string;
      cloneForUserId: string | null;
    }>,
    skillsSummary: Record<
      string,
      Array<{ slug: string; name: string; description: string; scope: string }>
    >
  ): Promise<void> {
    const agentsDir = path.join(memoryDir, "agents");
    await mkdir(agentsDir, { recursive: true });

    const indexBody = `# Agents enabled in this env

${
  enabledAgents.length === 0
    ? "(none)"
    : enabledAgents
        .map(
          (a) =>
            `- [${a.name}](${a.id}/PERSONA.md) (\`${a.slug}\`)${
              a.kind === "member_clone"
                ? ` — clone of member \`${a.cloneForUserId}\``
                : ""
            }`
        )
        .join("\n")
}
`;
    await writeFile(path.join(agentsDir, "INDEX.md"), indexBody, "utf-8");

    for (const a of enabledAgents) {
      const dir = path.join(agentsDir, a.id);
      await mkdir(dir, { recursive: true });

      const persona = `---
id: ${a.id}
slug: ${a.slug}
name: ${yamlEscape(a.name)}
kind: ${a.kind}
${a.cloneForUserId ? `cloneForUserId: ${a.cloneForUserId}\n` : ""}---

# ${a.name}

**Description:** ${a.description}

## Persona (system prompt)

${a.systemPrompt}
`;
      await writeFile(path.join(dir, "PERSONA.md"), persona, "utf-8");

      const skills = skillsSummary[a.id] ?? [];
      const skillsBody = `# Skills for ${a.name}

${
  skills.length === 0
    ? "(none yet)"
    : skills
        .map(
          (s) =>
            `- **${s.name}** (\`${s.slug}\`, scope: ${s.scope}) — ${s.description}`
        )
        .join("\n")
}

Full skill bodies live under \`../../.claude/skills/\` (if materialized for this session — bound-agent sessions only).
`;
      await writeFile(path.join(dir, "SKILLS.md"), skillsBody, "utf-8");
    }
  }
}

function yamlEscape(s: string): string {
  const needsQuotes = /[:#\n"'\\]/.test(s) || s.includes("  ");
  if (!needsQuotes) return s;
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, " ")}"`;
}

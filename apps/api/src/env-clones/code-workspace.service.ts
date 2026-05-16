import { Injectable, Logger } from "@nestjs/common";
import { mkdir, readdir, writeFile } from "fs/promises";
import { type Dirent } from "fs";
import path from "path";
import { PrismaService } from "../prisma/prisma.service";
import { ensureEnvDir, resolveRepoBaseDir } from "../common/repo-base-dir";

/**
 * Maintains the per-env VS Code workspace + extension recommendations on
 * disk. Both the code-server sidecar and the `code tunnel` desktop path open
 * `<envSlug>.code-workspace` so all repos in the env show up as folders in a
 * single VS Code window (multi-root workspace). `extensions.json` recommends
 * the Claude Code extension so users get a one-click install prompt the first
 * time they open the env.
 *
 * Idempotent — call on every env-repo add/remove. Best-effort: filesystem
 * errors are logged but never thrown back to the caller (it's metadata; the
 * env continues to work without it).
 *
 * NOTE: keeps its own envDir computation (rather than depending on
 * `EnvCloneService`) because `EnvCloneService` calls into here after each
 * mutation — depending the other way would be circular.
 */
@Injectable()
export class CodeWorkspaceService {
  private readonly logger = new Logger(CodeWorkspaceService.name);

  constructor(private readonly prisma: PrismaService) {}

  private get baseDir(): string {
    return resolveRepoBaseDir();
  }

  envDir(workspaceId: string, envId: string): string {
    return path.join(this.baseDir, workspaceId, "clones", envId);
  }

  /** Slug used for the .code-workspace filename. Stable per-env. */
  workspaceFileName(envId: string, title: string): string {
    const slug =
      title
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 40) || "env";
    return `${slug}-${envId.slice(-6)}.code-workspace`;
  }

  /** Absolute path to the .code-workspace for this env (whether or not it exists). */
  async workspaceFilePath(envId: string): Promise<string | null> {
    const env = await this.prisma.client.env.findUnique({
      where: { id: envId },
      select: { id: true, title: true, workspaceId: true },
    });
    if (!env) return null;
    return path.join(
      this.envDir(env.workspaceId, env.id),
      this.workspaceFileName(env.id, env.title)
    );
  }

  /**
   * (Re)write `<envDir>/<slug>.code-workspace` + `<envDir>/.vscode/extensions.json`.
   * Lists every envRepo with a ready clone as a folder entry.
   */
  async writeWorkspaceFiles(envId: string): Promise<void> {
    try {
      const env = await this.prisma.client.env.findUnique({
        where: { id: envId },
        select: {
          id: true,
          title: true,
          workspaceId: true,
          envRepos: {
            select: {
              envClonePath: true,
              envCloneStatus: true,
              repo: { select: { name: true } },
            },
          },
        },
      });
      if (!env) return;

      const envDir = this.envDir(env.workspaceId, env.id);
      await ensureEnvDir(envDir);

      const folders: { name: string; path: string }[] = env.envRepos
        .filter((er) => er.envCloneStatus === "ready" && er.envClonePath)
        .map((er) => ({
          name: er.repo.name,
          // Path relative to the .code-workspace file (which lives in envDir).
          path: path.relative(envDir, er.envClonePath as string),
        }));

      // Surface every top-level directory under `extracontext/` (user
      // uploads + the AI's `ai/` folder) as VS Code workspace folders.
      try {
        const extraDir = path.join(envDir, "extracontext");
        const entries = (await readdir(extraDir, {
          withFileTypes: true,
          encoding: "utf8",
        })) as Dirent[];
        for (const e of entries) {
          if (e.name.startsWith(".") || !e.isDirectory()) continue;
          folders.push({
            name: `extracontext: ${e.name}`,
            path: path.join("extracontext", e.name),
          });
        }
      } catch {
        // extracontext/ may not exist yet on a fresh env — fine.
      }

      const workspaceFile = path.join(
        envDir,
        this.workspaceFileName(env.id, env.title)
      );
      const workspaceContent = {
        folders,
        settings: {
          "workbench.colorTheme": "Default Dark Modern",
          "workbench.startupEditor": "none",
          "telemetry.telemetryLevel": "off",
          "security.workspace.trust.enabled": false,
          "files.exclude": {
            "**/.git": true,
            "**/node_modules": true,
          },
        },
        extensions: {
          recommendations: ["anthropic.claude-code"],
        },
      };
      await writeFile(
        workspaceFile,
        JSON.stringify(workspaceContent, null, 2),
        "utf-8"
      );

      const vscodeDir = path.join(envDir, ".vscode");
      await mkdir(vscodeDir, { recursive: true });
      await writeFile(
        path.join(vscodeDir, "extensions.json"),
        JSON.stringify(
          { recommendations: ["anthropic.claude-code"] },
          null,
          2
        ),
        "utf-8"
      );
    } catch (err) {
      this.logger.warn(
        `Failed to write VS Code workspace files for env ${envId}: ${
          err instanceof Error ? err.message : String(err)
        }`
      );
    }
  }
}

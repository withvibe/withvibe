import { Injectable } from "@nestjs/common";
import { PrismaService } from "../../prisma/prisma.service";
import { EnvCloneService } from "../../env-clones/env-clone.service";
import { GitProxyService } from "../../git-proxy/git-proxy.service";
import { FargateExecService } from "./fargate-exec.service";
import {
  buildRepoBootstrapScript,
  SandboxRepoScriptError,
  SANDBOX_WORKSPACE_DIR,
  type SandboxRepo,
} from "./sandbox-repo-script";
import { InjectPinoLogger, PinoLogger } from "nestjs-pino";

/** How long to wait for the exec bridge before giving up on the clone. The
 * runner has to boot, fetch the bridge from the api and start serving; a
 * cold image pull is the slow case. */
const BRIDGE_WAIT_MS = 120_000;
const BRIDGE_POLL_MS = 3_000;
/** Cloning a large monorepo over the proxy is the slow case here. */
const CLONE_TIMEOUT_MS = 15 * 60_000;

/**
 * Puts an env's repositories inside its Fargate sandbox.
 *
 * A local env gets its repos by bind-mounting clones the platform made on the
 * host. A Fargate task has no host to mount from, so the repos have to arrive
 * some other way — and shipping them through the platform would mean the
 * platform holding a working copy of the client's code, which is exactly what
 * running the sandbox in the client's own account was meant to avoid.
 *
 * So the task clones them itself, from the git proxy. The sandbox never sees a
 * GitHub credential, the platform never sees a working copy, and the clone
 * lands on the task's EFS-backed /workspace so it survives the stop/start
 * cycle the idle reaper puts every sandbox through.
 */
@Injectable()
export class SandboxReposService {
  constructor(
    @InjectPinoLogger(SandboxReposService.name)
    private readonly logger: PinoLogger,
    private readonly prisma: PrismaService,
    private readonly envClones: EnvCloneService,
    private readonly gitProxy: GitProxyService,
    private readonly bridge: FargateExecService
  ) {}

  /**
   * Identity the sandbox's git operations run as.
   *
   * The env's creator, because that is the only per-user identity available at
   * start time — nobody has acted in the env yet. Commits are attributed to
   * them; authentication is still the workspace's GitHub token, which the
   * proxy attaches and the sandbox never sees.
   */
  private async committerFor(envId: string) {
    const env = await this.prisma.client.env.findUnique({
      where: { id: envId },
      select: {
        createdById: true,
        createdBy: { select: { id: true, name: true, email: true } },
      },
    });
    if (!env?.createdById || !env.createdBy) return null;
    const user = env.createdBy;
    return {
      userId: user.id,
      // Same derivation as GitService.ensureCommitterIdentity, so a commit
      // made by the agent in the sandbox is attributed exactly as one made
      // through the git panel.
      name: user.name || user.email?.split("@")[0] || "withvibe",
      email: user.email || `${user.id}@withvibe.local`,
    };
  }

  /**
   * Clone (or update) every repo attached to the env, inside its running task.
   *
   * Never throws: a repository that cannot be cloned is a problem to show
   * someone, not a reason to fail a start that otherwise succeeded. The
   * environment is still usable without it, and failing the start would
   * discard the running task and the diagnosis with it.
   */
  async bootstrap(envId: string, log: (line: string) => void): Promise<void> {
    try {
      await this.doBootstrap(envId, log);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.warn(`[sandbox-repos] bootstrap failed for env ${envId}: ${msg}`);
      log(`[repos] could not set up repositories: ${msg}\n`);
    }
  }

  private async doBootstrap(
    envId: string,
    log: (line: string) => void
  ): Promise<void> {
    const envRepos = await this.prisma.client.envRepo.findMany({
      where: { envId },
      include: { repo: { select: { name: true } } },
    });
    if (envRepos.length === 0) return;

    const env = await this.prisma.client.env.findUnique({
      where: { id: envId },
      select: { title: true },
    });
    const committer = await this.committerFor(envId);
    if (!committer) {
      log(
        `[repos] skipped: this env has no recorded creator, so there is no identity ` +
          `to attribute commits to. Repositories can still be cloned from inside the sandbox.\n`
      );
      return;
    }

    const repos: SandboxRepo[] = [];
    for (const er of envRepos) {
      const remote = this.gitProxy.remoteUrlFor(envId, er.repo.name);
      if (!remote) {
        log(
          `[repos] skipped: the api has no publicly reachable URL, so the sandbox ` +
            `cannot reach the git proxy. Set FARGATE_API_BASE_URL on the api.\n`
        );
        return;
      }
      repos.push({
        name: er.repo.name,
        remote,
        branch: er.branch || this.envClones.envBranchName(envId, env?.title ?? ""),
        baseBranch: er.baseBranch || "main",
      });
    }

    let script: string;
    try {
      script = buildRepoBootstrapScript(repos, committer);
    } catch (err) {
      if (err instanceof SandboxRepoScriptError) {
        log(`[repos] ${err.message}\n`);
        return;
      }
      throw err;
    }

    log(`[repos] waiting for the sandbox to accept commands…\n`);
    const ready = await this.waitForBridge(envId);
    if (ready) {
      log(`[repos] ${ready}\n`);
      return;
    }

    log(
      `[repos] setting up ${repos.length} repositor${repos.length === 1 ? "y" : "ies"} ` +
        `in ${SANDBOX_WORKSPACE_DIR} as ${committer.name} <${committer.email}>\n`
    );

    const result = await this.run(envId, script, {
      // The proxy credential, scoped to this env and this user. It reaches the
      // sandbox as process environment for this one command rather than being
      // written into any repository's config, so it leaves nothing behind on
      // the EFS volume for the next task to find.
      ...this.gitProxy.gitConfigEnvFor(envId, committer.userId),
      GIT_TERMINAL_PROMPT: "0",
      HOME: `${SANDBOX_WORKSPACE_DIR}/.withvibe/home`,
    });

    for (const line of result.output.split("\n")) {
      if (line.trim()) log(`${line}\n`);
    }
    if (result.exitCode !== 0) {
      log(`[repos] repository setup exited ${result.exitCode}\n`);
    }
  }

  /** Null once the bridge answers; an explanatory string if it never does. */
  private async waitForBridge(envId: string): Promise<string | null> {
    const deadline = Date.now() + BRIDGE_WAIT_MS;
    let last = "bridge never answered";
    while (Date.now() < deadline) {
      const err = await this.bridge.preflight(envId);
      if (!err) return null;
      last = err;
      await new Promise((r) => setTimeout(r, BRIDGE_POLL_MS));
    }
    return `skipped: the sandbox did not become reachable in time (${last})`;
  }

  private run(
    envId: string,
    script: string,
    env: Record<string, string>
  ): Promise<{ exitCode: number; output: string }> {
    return new Promise((resolve) => {
      let output = "";
      let settled = false;
      const finish = (exitCode: number) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ exitCode, output });
      };

      const timer = setTimeout(() => {
        output += `\n[repos] timed out after ${Math.round(CLONE_TIMEOUT_MS / 60000)} minutes`;
        handle?.kill();
        finish(-1);
      }, CLONE_TIMEOUT_MS);

      let handle: Awaited<ReturnType<FargateExecService["execStream"]>> | null = null;
      void this.bridge
        .execStream(envId, {
          argv: ["sh", "-c", script],
          cwd: SANDBOX_WORKSPACE_DIR,
          env,
        })
        .then((h) => {
          handle = h;
          h.stdout.on("data", (chunk: string) => (output += chunk));
          h.stderr.on("data", (chunk: string) => (output += chunk));
          h.on("error", (err) => {
            output += `\n[repos] ${err instanceof Error ? err.message : String(err)}`;
          });
          h.on("close", () => finish(h.exitCode ?? -1));
        })
        .catch((err: unknown) => {
          output += `\n[repos] ${err instanceof Error ? err.message : String(err)}`;
          finish(-1);
        });
    });
  }
}

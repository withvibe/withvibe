import { ForbiddenException, Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { ComputeTarget } from "@withvibe/db";

/**
 * Single source of truth for SAAS_MODE — "this deployment hosts tenants who do
 * not trust each other, and whom we do not trust."
 *
 * The `local` compute target runs a tenant's own Compose file on the platform's
 * Docker host, beside every other tenant's source tree and the platform's own
 * secrets. That is fine for a single-team install and unacceptable for a shared
 * one, and no amount of per-bug hardening changes it: the tenant's containers
 * are simply on the wrong machine. SAAS_MODE therefore refuses `local`
 * outright and leaves `fargate`, where the tenant's containers run in the
 * tenant's OWN AWS account.
 *
 * The same reasoning bans host-side sidecars (code-server, VS Code tunnel, DB
 * viewer, QA browser) for fargate envs: those spawn containers on the PLATFORM
 * host and bind-mount platform directories, so attaching one to a cloud
 * sandbox would quietly undo the isolation the sandbox exists to provide.
 *
 * `SAAS_LOCAL_WORKSPACE_IDS` is the operator's own escape hatch — a comma
 * separated allowlist of workspaces that may still create `local` envs (the
 * operator's own team on their own box). Empty by default: in SAAS_MODE nobody
 * gets `local` unless named explicitly.
 */
@Injectable()
export class SaasModeService {
  constructor(private readonly config: ConfigService) {}

  get enabled(): boolean {
    return this.config.get<string>("SAAS_MODE") === "true";
  }

  /** Workspaces explicitly permitted to keep using the `local` target. */
  private get localAllowlist(): Set<string> {
    const raw = this.config.get<string>("SAAS_LOCAL_WORKSPACE_IDS") ?? "";
    return new Set(
      raw
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    );
  }

  /** True when this workspace may create/run `local` envs. */
  localAllowedFor(workspaceId: string): boolean {
    if (!this.enabled) return true;
    return this.localAllowlist.has(workspaceId);
  }

  /**
   * Gate for sidecars that run as containers on the PLATFORM host (code-server,
   * VS Code tunnel, DB viewer, QA browser).
   *
   * Two independent refusals:
   *
   *  - **Any fargate env, in any mode.** The sandbox's containers live in the
   *    customer's AWS account; a host-side sidecar would attach to the
   *    platform host instead and bind-mount platform directories. The user
   *    would believe they are inside their sandbox while actually holding a
   *    session on our machine. Wrong target, not merely unsafe.
   *  - **Any non-allowlisted workspace in SAAS_MODE.** These sidecars mount
   *    host paths — the VS Code tunnel mounts REPO_BASE_DIR, i.e. *every*
   *    workspace's clones — so they are only appropriate for a workspace
   *    already trusted with the host.
   */
  assertHostSidecarAllowed(args: {
    workspaceId: string;
    computeTarget: ComputeTarget;
    sidecar: string;
  }): void {
    if (args.computeTarget === "fargate") {
      throw new ForbiddenException(
        `${args.sidecar} isn't available for cloud sandboxes — it would run on the platform server, not inside your environment. Use the environment's terminal instead.`
      );
    }
    if (!this.hostSidecarsAllowedFor(args.workspaceId)) {
      throw new ForbiddenException(
        `${args.sidecar} isn't available on this deployment.`
      );
    }
  }

  private hostSidecarsAllowedFor(workspaceId: string): boolean {
    return this.localAllowedFor(workspaceId);
  }
}

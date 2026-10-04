/**
 * Pure decision logic for the Fargate reaper (FargateReaperService).
 *
 * Kept free of Nest/Prisma/AWS imports on purpose: deciding WHICH env gets
 * stopped is the part with teeth — get it wrong and you either kill a sandbox
 * someone is working in, or let a forgotten task bill forever — so it has to
 * be testable without standing up a database or an AWS account.
 * See fargate-reaper.check.ts.
 */

/** Statuses that imply a task should exist in AWS right now. */
export function isLiveStatus(status: string): boolean {
  return ["running", "starting", "building", "partial", "stopping"].includes(
    status
  );
}

export type LiveTask = {
  taskArn: string;
  /** Value of the withvibe-deployment tag, or null when the task carries none. */
  deploymentId: string | null;
};

export type ReapEnvRow = {
  id: string;
  containerStatus: string;
  deletedAt: Date | null;
  /**
   * Written only once RunTask has returned. Its absence on a live-status env
   * means a start is still in flight — the task may not exist yet, which is
   * not the same as having died.
   */
  fargateTaskArn: string | null;
};

/**
 * Diff what AWS is running against what the database believes.
 *
 *  - `orphanEnvIds`: a live task whose env is deleted, missing, or not
 *    supposed to be running → stop the task.
 *  - `ghostEnvIds`: an env we call running with no live task → mark stopped.
 */
export function diffTasksVsEnvs(args: {
  /** envId → live withvibe task in the cluster. */
  liveTasks: Map<string, LiveTask>;
  envs: ReapEnvRow[];
  /** Identity of the deployment running this reconcile. */
  deploymentId: string;
}): { orphanEnvIds: string[]; ghostEnvIds: string[]; foreignEnvIds: string[] } {
  const byId = new Map(args.envs.map((e) => [e.id, e]));
  const orphanEnvIds: string[] = [];
  const foreignEnvIds: string[] = [];
  for (const [envId, task] of args.liveTasks) {
    const env = byId.get(envId);
    if (env) {
      // The env is ours. Its recorded state is authoritative, tag or not.
      if (!env.deletedAt && isLiveStatus(env.containerStatus)) continue;
      orphanEnvIds.push(envId);
      continue;
    }
    // Unknown env. One client AWS account can be connected to several
    // deployments (prod + staging, or a developer's laptop), and they share
    // this cluster — so "I don't recognize this env" usually means the task
    // belongs to somebody else's control plane, NOT that it is abandoned.
    // Only reap it when it carries OUR deployment tag; an absent tag is
    // likewise not ours to judge (it predates tagging, or came from a
    // deployment that doesn't tag).
    if (task.deploymentId && task.deploymentId === args.deploymentId) {
      orphanEnvIds.push(envId);
    } else {
      foreignEnvIds.push(envId);
    }
  }
  const ghostEnvIds = args.envs
    .filter(
      (e) =>
        !e.deletedAt &&
        isLiveStatus(e.containerStatus) &&
        // A start in flight has no ARN yet and ECS has nothing to report, so
        // it would look identical to a dead task. Requiring the ARN keeps a
        // periodic reconcile from killing an env mid-launch.
        !!e.fargateTaskArn &&
        !args.liveTasks.has(e.id)
    )
    .map((e) => e.id);
  return { orphanEnvIds, ghostEnvIds, foreignEnvIds };
}

/**
 * Has this env gone quiet long enough to reap? `lastActivityAt` is null until
 * the first chat turn / shell / lifecycle action, so a sandbox that was
 * started and never touched falls back to its start time and still gets
 * reaped. Both null → reap, since an env with no timestamps at all can't be
 * shown to be in use.
 */
export function isIdle(
  env: { lastActivityAt: Date | null; lastContainerAt: Date | null },
  cutoff: Date
): boolean {
  const last = env.lastActivityAt ?? env.lastContainerAt;
  return !last || last <= cutoff;
}

/**
 * Self-check for the Fargate reaper's decision logic. This repo has no test
 * runner, so (matching check:compose-to-taskdef) this is a ts-node script:
 *
 *   pnpm --filter @withvibe/api check:fargate-reaper
 *
 * Only the pure functions are covered — deciding WHICH env gets stopped is
 * the part with teeth. Getting it wrong either kills a sandbox someone is
 * working in, or lets a forgotten task bill forever.
 *
 * Exits non-zero on any unexpected outcome.
 */
import {
  diffTasksVsEnvs,
  isIdle,
  isLiveStatus,
  type ReapEnvRow,
} from "./fargate-reap-logic";

let pass = 0;
let fail = 0;
function expect(name: string, cond: boolean, detail = "") {
  if (cond) {
    pass++;
    console.log(`  ok  ${name}`);
  } else {
    fail++;
    console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function env(
  id: string,
  containerStatus: string,
  deletedAt: Date | null = null,
  // Default to "RunTask already returned" — the common case. Tests that care
  // about a start still in flight pass null explicitly.
  fargateTaskArn: string | null = `arn:aws:ecs:::task/${id}`
): ReapEnvRow {
  return { id, containerStatus, deletedAt, fargateTaskArn };
}

const OURS = "deploy-ours";
const THEIRS = "deploy-theirs";

// Tasks started by THIS deployment unless stated otherwise.
const tasks = (...ids: string[]) =>
  new Map(
    ids.map((id) => [
      id,
      { taskArn: `arn:aws:ecs:::task/${id}`, deploymentId: OURS },
    ])
  );

const taskFrom = (id: string, deploymentId: string | null) =>
  new Map([[id, { taskArn: `arn:aws:ecs:::task/${id}`, deploymentId }]]);

// ---------- isLiveStatus -----------------------------------------------------

expect(
  "running/starting/building/partial/stopping count as live",
  ["running", "starting", "building", "partial", "stopping"].every(isLiveStatus)
);
expect(
  "stopped/error are not live",
  !isLiveStatus("stopped") && !isLiveStatus("error")
);

// ---------- diffTasksVsEnvs: the agreeing case -------------------------------

{
  const d = diffTasksVsEnvs({
    liveTasks: tasks("e1"),
    deploymentId: OURS,
    envs: [env("e1", "running")],
  });
  expect(
    "agreement produces no action",
    d.orphanEnvIds.length === 0 && d.ghostEnvIds.length === 0,
    JSON.stringify(d)
  );
}

// ---------- orphans: task alive, DB says otherwise ---------------------------

{
  const d = diffTasksVsEnvs({
    liveTasks: tasks("e1"),
    deploymentId: OURS,
    envs: [env("e1", "stopped")],
  });
  expect(
    "task running while DB says stopped → orphan",
    JSON.stringify(d.orphanEnvIds) === JSON.stringify(["e1"]),
    JSON.stringify(d)
  );
}

{
  // The exact bug that stranded two billing tasks: StartupCleanupService used
  // to flip fargate envs to "stopped" on every api restart, abandoning a live
  // task. The reaper has to catch that even after the DB has forgotten.
  const d = diffTasksVsEnvs({
    liveTasks: tasks("e1"),
    deploymentId: OURS,
    envs: [env("e1", "running", new Date())],
  });
  expect(
    "task running under a soft-deleted env → orphan",
    JSON.stringify(d.orphanEnvIds) === JSON.stringify(["e1"])
  );
}

{
  const d = diffTasksVsEnvs({
    liveTasks: tasks("gone"),
    envs: [],
    deploymentId: OURS,
  });
  expect(
    "task with no env row at all → orphan",
    JSON.stringify(d.orphanEnvIds) === JSON.stringify(["gone"])
  );
}

// ---------- ghosts: DB says running, no task ---------------------------------

{
  const d = diffTasksVsEnvs({
    liveTasks: tasks(),
    deploymentId: OURS,
    envs: [env("e1", "running")],
  });
  expect(
    "env running with no task → ghost",
    JSON.stringify(d.ghostEnvIds) === JSON.stringify(["e1"]),
    JSON.stringify(d)
  );
}

{
  const d = diffTasksVsEnvs({
    liveTasks: tasks(),
    deploymentId: OURS,
    envs: [env("e1", "stopped"), env("e2", "error")],
  });
  expect(
    "stopped/error envs with no task are not ghosts",
    d.ghostEnvIds.length === 0,
    JSON.stringify(d)
  );
}

{
  // A start in flight has no task ARN yet for a few seconds, and the reaper
  // reconciles on a timer — marking it stopped mid-launch would be a
  // self-inflicted race that kills the env the user just asked for.
  const d = diffTasksVsEnvs({
    liveTasks: tasks(),
    deploymentId: OURS,
    envs: [env("e1", "starting", null, null)],
  });
  expect(
    "a start still in flight (no task ARN yet) is left alone",
    d.ghostEnvIds.length === 0 && d.orphanEnvIds.length === 0,
    JSON.stringify(d)
  );
}

{
  // Same shape, but the ARN is recorded: RunTask returned and the task is
  // genuinely gone, so this one really is a ghost.
  const d = diffTasksVsEnvs({
    liveTasks: tasks(),
    deploymentId: OURS,
    envs: [env("e1", "starting")],
  });
  expect(
    "a 'starting' env WITH a task ARN and no live task → ghost",
    JSON.stringify(d.ghostEnvIds) === JSON.stringify(["e1"])
  );
}

{
  const d = diffTasksVsEnvs({
    liveTasks: tasks(),
    deploymentId: OURS,
    envs: [env("e1", "running", new Date())],
  });
  expect(
    "soft-deleted env is never a ghost (nothing to correct)",
    d.ghostEnvIds.length === 0
  );
}

// ---------- mixed cluster ----------------------------------------------------

{
  const d = diffTasksVsEnvs({
    liveTasks: tasks("keep", "orphan"),
    deploymentId: OURS,
    envs: [
      env("keep", "running"),
      env("orphan", "stopped"),
      env("ghost", "running"),
    ],
  });
  expect(
    "mixed: one orphan, one ghost, one left alone",
    JSON.stringify(d.orphanEnvIds) === JSON.stringify(["orphan"]) &&
      JSON.stringify(d.ghostEnvIds) === JSON.stringify(["ghost"]),
    JSON.stringify(d)
  );
}

// ---------- isIdle -----------------------------------------------------------

const now = Date.now();
const cutoff = new Date(now - 60 * 60_000); // 60 minutes ago
const recent = new Date(now - 5 * 60_000);
const ancient = new Date(now - 120 * 60_000);

expect(
  "recent activity → not idle",
  !isIdle({ lastActivityAt: recent, lastContainerAt: ancient }, cutoff)
);
expect(
  "old activity → idle",
  isIdle({ lastActivityAt: ancient, lastContainerAt: ancient }, cutoff)
);
expect(
  "never used, started recently → not idle",
  !isIdle({ lastActivityAt: null, lastContainerAt: recent }, cutoff)
);
expect(
  "never used, started long ago → idle (the forgotten-sandbox case)",
  isIdle({ lastActivityAt: null, lastContainerAt: ancient }, cutoff)
);
expect(
  "activity wins over an older start time",
  !isIdle({ lastActivityAt: recent, lastContainerAt: ancient }, cutoff)
);
expect(
  "a stale activity stamp is NOT rescued by a recent start",
  // Start touches activity too (docker.controller), so this combination
  // means something skipped the touch — reap rather than bill indefinitely.
  isIdle({ lastActivityAt: ancient, lastContainerAt: recent }, cutoff)
);
expect(
  "no timestamps at all → idle",
  isIdle({ lastActivityAt: null, lastContainerAt: null }, cutoff)
);

// ---------- multi-deployment safety ----------------------------------------
// The bug this prevents: a laptop dev server and the production server both
// connect to the SAME client AWS account, so each sees the other's tasks as
// "an env I've never heard of" and stops it mid-session.

{
  const d = diffTasksVsEnvs({
    liveTasks: taskFrom("their-env", THEIRS),
    envs: [],
    deploymentId: OURS,
  });
  expect(
    "unknown env tagged for ANOTHER deployment is never stopped",
    d.orphanEnvIds.length === 0 &&
      JSON.stringify(d.foreignEnvIds) === JSON.stringify(["their-env"]),
    JSON.stringify(d)
  );
}

{
  const d = diffTasksVsEnvs({
    liveTasks: taskFrom("untagged-env", null),
    envs: [],
    deploymentId: OURS,
  });
  expect(
    "unknown env with NO deployment tag is left alone, not reaped",
    d.orphanEnvIds.length === 0 &&
      JSON.stringify(d.foreignEnvIds) === JSON.stringify(["untagged-env"]),
    JSON.stringify(d)
  );
}

{
  const d = diffTasksVsEnvs({
    liveTasks: taskFrom("gone", OURS),
    envs: [],
    deploymentId: OURS,
  });
  expect(
    "unknown env tagged as OURS is still reaped (a genuine orphan)",
    JSON.stringify(d.orphanEnvIds) === JSON.stringify(["gone"]) &&
      d.foreignEnvIds.length === 0
  );
}

{
  // Our own env, stopped in our DB, but the task was started by the other
  // deployment: our DB row is authoritative for an env we own.
  const d = diffTasksVsEnvs({
    liveTasks: taskFrom("e1", THEIRS),
    envs: [env("e1", "stopped")],
    deploymentId: OURS,
  });
  expect(
    "a KNOWN env is judged by our DB regardless of the tag",
    JSON.stringify(d.orphanEnvIds) === JSON.stringify(["e1"])
  );
}

{
  const d = diffTasksVsEnvs({
    liveTasks: taskFrom("e1", THEIRS),
    envs: [env("e1", "running")],
    deploymentId: OURS,
  });
  expect(
    "a known RUNNING env is never stopped, whatever the tag says",
    d.orphanEnvIds.length === 0
  );
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);

import { createHash } from "crypto";

/** ECS tag key carrying the identity of the WithVibe deployment that ran a task. */
export const DEPLOYMENT_TAG_KEY = "withvibe-deployment";

/**
 * Stable identifier for THIS WithVibe deployment.
 *
 * One client AWS account can legitimately be connected to more than one
 * deployment — production plus staging, or a developer's laptop alongside the
 * real server. They all share the same ECS cluster, so "a task whose env I
 * don't recognize" does NOT mean "an abandoned task": it usually means it
 * belongs to somebody else's control plane. Tagging tasks with the deployment
 * that started them is what lets the reaper tell those two cases apart.
 *
 * Derived from INTERNAL_JWT_SECRET by default so existing installs get a
 * stable id with no new configuration. It is a one-way hash truncated to 16
 * hex chars — it identifies the deployment without being usable to recover
 * the secret. Override with WITHVIBE_DEPLOYMENT_ID when several deployments
 * share a secret, or when you want a readable name in the AWS console.
 */
export function deploymentId(): string {
  const explicit = process.env.WITHVIBE_DEPLOYMENT_ID?.trim();
  if (explicit) return explicit.slice(0, 64);
  const seed = process.env.INTERNAL_JWT_SECRET ?? "";
  if (!seed) return "unknown";
  return createHash("sha256")
    .update(`withvibe-deployment:${seed}`)
    .digest("hex")
    .slice(0, 16);
}

import { apiFetch } from "./api";
import { getCurrentUser, type CurrentUser } from "./auth";

type AuthError = { error: Response };
type AuthSuccess = { user: CurrentUser };
type MemberSuccess = {
  user: CurrentUser;
  member: { workspaceId: string; userId: string; role: "admin" | "member" };
};

export async function requireAuth(): Promise<AuthError | AuthSuccess> {
  const user = await getCurrentUser();
  if (!user) {
    return { error: Response.json({ error: "Unauthorized" }, { status: 401 }) };
  }
  return { user };
}

/**
 * Confirm the caller is a member of the workspace. Delegates to NestJS,
 * which is the source of truth — we don't keep a Prisma client in the web
 * app anymore.
 */
export async function requireWorkspaceMember(
  workspaceId: string
): Promise<AuthError | MemberSuccess> {
  const auth = await requireAuth();
  if ("error" in auth) return auth;

  const res = await apiFetch(`/workspaces/${workspaceId}`, { cache: "no-store" });
  if (res.status === 401) {
    return { error: Response.json({ error: "Unauthorized" }, { status: 401 }) };
  }
  if (res.status === 403 || res.status === 404) {
    return {
      error: Response.json(
        { error: "Not a workspace member" },
        { status: 403 }
      ),
    };
  }
  if (!res.ok) {
    return {
      error: Response.json(
        { error: "Workspace lookup failed" },
        { status: 500 }
      ),
    };
  }
  const body = (await res.json()) as { role: "admin" | "member" };
  return {
    user: auth.user,
    member: { workspaceId, userId: auth.user.id, role: body.role },
  };
}

export async function requireWorkspaceAdmin(
  workspaceId: string
): Promise<AuthError | MemberSuccess> {
  const result = await requireWorkspaceMember(workspaceId);
  if ("error" in result) return result;
  if (result.member.role !== "admin") {
    return {
      error: Response.json(
        { error: "Admin access required" },
        { status: 403 }
      ),
    };
  }
  return result;
}

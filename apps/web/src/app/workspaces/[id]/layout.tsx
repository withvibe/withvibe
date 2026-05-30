import { redirect, notFound } from "next/navigation";
import { apiJson } from "@/lib/api";
import { WorkspaceShell } from "./_shell";

type Bootstrap = {
  version: string;
  workspace: { id: string; name: string };
  role: "admin" | "member";
  user: {
    id: string;
    name: string | null;
    email: string;
    isDeploymentAdmin: boolean;
  };
  workspaces: Array<{ id: string; name: string }>;
  defaultWorkspaceId: string | null;
  integrations: { anthropic: boolean; github: boolean };
};

export default async function WorkspaceLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const res = await apiJson<Bootstrap>(`/workspaces/${id}/bootstrap`, {
    cache: "no-store",
  });

  if (res === null) {
    // 401 from /me means no session; 404 means not a member or workspace gone.
    // apiJson collapses both — redirect to login covers the no-session case;
    // notFound() is more accurate for the not-a-member case but we can't
    // distinguish here without a second call. Login redirect is safe either
    // way (a still-authed user simply lands back here).
    redirect("/login");
  }

  if (!res.workspace) notFound();

  return (
    <WorkspaceShell
      version={res.version}
      workspace={res.workspace}
      role={res.role}
      user={{
        name: res.user.name,
        email: res.user.email,
        isDeploymentAdmin: res.user.isDeploymentAdmin,
      }}
      workspaces={res.workspaces}
      defaultWorkspaceId={res.defaultWorkspaceId}
      integrations={res.integrations}
    >
      {children}
    </WorkspaceShell>
  );
}

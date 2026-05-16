import { redirect } from "next/navigation";
import { apiJson } from "@/lib/api";

type WorkspacesList = {
  defaultWorkspaceId: string | null;
  memberships: Array<{
    workspaceId: string;
    workspace: { id: string; name: string };
  }>;
};

export default async function Home() {
  const data = await apiJson<WorkspacesList>("/workspaces", {
    cache: "no-store",
  });

  if (!data) {
    redirect("/login");
  }

  if (data.defaultWorkspaceId) {
    const stillMember = data.memberships.some(
      (m) => m.workspaceId === data.defaultWorkspaceId
    );
    if (stillMember) redirect(`/workspaces/${data.defaultWorkspaceId}`);
  }

  if (data.memberships.length > 0) {
    redirect(`/workspaces/${data.memberships[0].workspaceId}`);
  }

  redirect("/workspaces/new");
}

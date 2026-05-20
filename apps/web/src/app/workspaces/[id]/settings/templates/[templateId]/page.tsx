"use client";

import { use, useEffect, useState } from "react";
import { Skeleton } from "@/components/ui/skeleton";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  TemplateEditor,
  type EditorAsset,
  type EditorRepo,
  type EditorService,
  type EditorVariable,
  type TemplateEditorState,
} from "../template-editor";

type TemplateDetail = {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  composeFile: string;
  variables: unknown;
  assets: { path: string; content: string; isTemplate: boolean }[];
  repos?: { repoId: string; baseBranch: string | null }[];
  routingMode?: "port" | "subdomain";
  routingBaseDomain?: string | null;
  qaBrowserMode?: "sidecar" | "user_browser";
  agentInstructions?: string | null;
  services?: unknown;
};

export default function EditTemplatePage(
  props: PageProps<"/workspaces/[id]/settings/templates/[templateId]">
) {
  const { id, templateId } = use(props.params);
  const [state, setState] = useState<TemplateEditorState | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/workspaces/${id}/env-templates/${templateId}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(r)))
      .then((d: TemplateDetail) => {
        if (cancelled) return;
        const variables: EditorVariable[] = Array.isArray(d.variables)
          ? (d.variables as EditorVariable[])
          : [];
        const assets: EditorAsset[] = (d.assets || []).map((a) => ({
          path: a.path,
          content: a.content,
          isTemplate: a.isTemplate,
        }));
        const repos: EditorRepo[] = (d.repos || []).map((r) => ({
          id: r.repoId,
          baseBranch: r.baseBranch ?? "",
        }));
        const services: EditorService[] = Array.isArray(d.services)
          ? (d.services as Array<Record<string, unknown>>).map((s) => ({
              name: typeof s.name === "string" ? s.name : "",
              description:
                typeof s.description === "string" ? s.description : "",
              role: typeof s.role === "string" ? s.role : "",
              userFacing: s.userFacing === true,
              agentInstructions:
                typeof s.agentInstructions === "string"
                  ? s.agentInstructions
                  : "",
            }))
          : [];
        setState({
          slug: d.slug,
          name: d.name,
          description: d.description ?? "",
          composeFile: d.composeFile,
          variables,
          assets,
          repos,
          routingMode: d.routingMode ?? "port",
          routingBaseDomain: d.routingBaseDomain ?? "",
          qaBrowserMode: d.qaBrowserMode ?? "sidecar",
          agentInstructions: d.agentInstructions ?? "",
          services,
        });
      })
      .catch(async (r) => {
        if (cancelled) return;
        try {
          const j = await r.json();
          setError(j.message || "Failed to load template");
        } catch {
          setError("Failed to load template");
        }
      });
    return () => {
      cancelled = true;
    };
  }, [id, templateId]);

  // The TemplateEditor renders its own IDE shell (full-width 3-pane layout)
  // so we skip the centered container. Errors and loading states render in a
  // small centered container before the editor takes over.
  if (error) {
    return (
      <div className="max-w-2xl mx-auto px-6 py-10">
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      </div>
    );
  }
  if (state === null) {
    return (
      <div className="max-w-4xl mx-auto px-6 py-10">
        <Skeleton className="h-[600px] rounded-md" />
      </div>
    );
  }
  return (
    <TemplateEditor
      workspaceId={id}
      mode="edit"
      templateId={templateId}
      initial={state}
    />
  );
}

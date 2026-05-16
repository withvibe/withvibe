"use client";

import { use } from "react";
import { TemplateEditor } from "../template-editor";

export default function NewTemplatePage(
  props: PageProps<"/workspaces/[id]/settings/templates/new">
) {
  const { id } = use(props.params);
  return (
    <div className="max-w-4xl mx-auto px-6 sm:px-8 py-10 space-y-6">
      <header className="space-y-1">
        <h1 className="text-2xl font-mono font-bold tracking-tight">
          New environment template
        </h1>
        <p className="text-sm text-muted-foreground max-w-prose">
          Define the compose stack, the variables the orchestrator fills in,
          and any asset files that should land in the env workspace.
        </p>
      </header>

      <TemplateEditor
        workspaceId={id}
        mode="create"
        initial={{
          slug: "",
          name: "",
          description: "",
          composeFile: "",
          variables: [],
          assets: [],
          repos: [],
          routingMode: "port",
          routingBaseDomain: "",
          qaBrowserMode: "sidecar",
          agentInstructions: "",
          services: [],
        }}
      />
    </div>
  );
}

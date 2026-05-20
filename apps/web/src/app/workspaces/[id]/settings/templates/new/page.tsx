"use client";

import { use } from "react";
import { TemplateEditor } from "../template-editor";

export default function NewTemplatePage(
  props: PageProps<"/workspaces/[id]/settings/templates/new">
) {
  const { id } = use(props.params);
  // The TemplateEditor renders its own IDE shell (full-width 3-pane layout)
  // so we skip the centered container that older pages used.
  return (
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
  );
}

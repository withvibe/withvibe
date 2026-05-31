"use client";

import { use, useState } from "react";
import { useRouter } from "next/navigation";
import dynamic from "next/dynamic";
import { AlertTriangle, ArrowLeft, FileCode, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { IdeShell } from "@/components/ide-shell";
import { cn } from "@/lib/utils";

const MonacoEditor = dynamic(
  () => import("@monaco-editor/react").then((m) => m.default),
  {
    ssr: false,
    loading: () => (
      <div className="text-xs text-muted-foreground p-3">Loading editor…</div>
    ),
  }
);

const MANIFEST_FILENAME = "manifest.yaml";

const SAMPLE_MANIFEST = `# WithVibe plugin manifest.
# The image is pulled at install time — set it to something docker can
# resolve (public registry or one you've already \`docker login\`ed into).
id: acme.taskboard
name: Task Board
description: Workspace task management for AI teams.
version: 1.0.0
icon: list-todo
image: ghcr.io/acme/withvibe-taskboard:1.0.0

# Scope: one container per env / per workspace / per deployment.
scope: workspace

# Storage: 'none' for stateless; 'shared-postgres' to receive a dedicated
# DB schema + DATABASE_URL env var (isolated from withvibe's own DB).
storage:
  kind: shared-postgres

# UI: where the iframe loads inside the container, and whether the proxy
# needs to handle WebSocket upgrades.
ui:
  path: /ui
  websocket: false

# Optional MCP server exposed to the agent.
mcp:
  enabled: true
  path: /mcp
`;

export default function NewPluginPage(
  props: PageProps<"/workspaces/[id]/admin/plugins/new">
) {
  const { id: workspaceId } = use(props.params);
  const router = useRouter();
  const pluginsHref = `/workspaces/${workspaceId}/admin/plugins`;
  const [manifestText, setManifestText] = useState(SAMPLE_MANIFEST);
  const [installing, setInstalling] = useState(false);
  const [installError, setInstallError] = useState<string | null>(null);

  async function install() {
    setInstalling(true);
    setInstallError(null);
    try {
      const res = await fetch("/api/admin/plugins", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ manifestText }),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        setInstallError(
          parseError(text) || `Install failed (HTTP ${res.status})`
        );
        return;
      }
      toast.success("Plugin installed");
      router.push(pluginsHref);
    } finally {
      setInstalling(false);
    }
  }

  return (
    <IdeShell
      header={
        <>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => router.push(pluginsHref)}
            disabled={installing}
          >
            <ArrowLeft className="size-4" />
            Plugins
          </Button>
          <span className="text-muted-foreground/50">/</span>
          <h1 className="text-sm font-mono font-medium">Install plugin</h1>
          <div className="ml-auto flex items-center gap-2">
            <Button
              size="sm"
              variant="outline"
              onClick={() => router.push(pluginsHref)}
              disabled={installing}
            >
              Cancel
            </Button>
            <Button size="sm" onClick={install} disabled={installing}>
              {installing && <Loader2 className="size-4 animate-spin" />}
              {installing ? "Pulling image…" : "Install"}
            </Button>
          </div>
        </>
      }
      sidebar={
        <div className="text-sm">
          <div className="px-3 pt-2 pb-1 text-[10px] font-mono uppercase tracking-wider text-muted-foreground">
            Files
          </div>
          <button
            type="button"
            className={cn(
              "w-full flex items-center gap-2 px-3 py-1.5 text-left transition-colors border-l-2",
              "bg-foreground/[0.06] border-foreground/40 text-foreground"
            )}
          >
            <FileCode className="size-3.5 shrink-0" />
            <span className="font-mono text-xs truncate">
              {MANIFEST_FILENAME}
            </span>
          </button>
        </div>
      }
      center={
        <div className="flex flex-col h-full">
          {installError && (
            <div className="border-b border-destructive/40 bg-destructive/10 p-2 text-xs text-destructive flex gap-2 shrink-0">
              <AlertTriangle className="size-4 shrink-0 mt-0.5" />
              <pre className="whitespace-pre-wrap break-all flex-1">
                {installError}
              </pre>
              <button
                type="button"
                onClick={() => setInstallError(null)}
                className="text-destructive/60 hover:text-destructive shrink-0"
              >
                ×
              </button>
            </div>
          )}
          {/* File tab bar — mirrors the template editor's look. */}
          <div className="border-b border-border/60 bg-card/30 shrink-0 flex items-center">
            <div className="flex items-center gap-2 px-3 py-1.5 border-r border-border/60 bg-background/40 text-xs font-mono">
              <FileCode className="size-3.5" />
              {MANIFEST_FILENAME}
            </div>
          </div>
          <div className="flex-1 min-h-0">
            <MonacoEditor
              height="100%"
              language="yaml"
              theme="vs-dark"
              value={manifestText}
              onChange={(v) => setManifestText(v ?? "")}
              options={{
                minimap: { enabled: false },
                fontSize: 13,
                tabSize: 2,
                insertSpaces: true,
                scrollBeyondLastLine: false,
                wordWrap: "on",
                lineNumbers: "on",
                renderWhitespace: "selection",
                automaticLayout: true,
              }}
            />
          </div>
        </div>
      }
      ai={
        <div className="p-4 space-y-4 text-xs overflow-y-auto">
          <div>
            <div className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground mb-1.5">
              Manifest reference
            </div>
            <p className="text-muted-foreground leading-relaxed">
              The manifest is the entire input. The image is pulled from the
              registry at install time — there&apos;s no separate code upload.
            </p>
          </div>

          <Section title="Required fields">
            <Field name="id" desc="Reverse-DNS-ish: lowercase alnum + dot/dash. Becomes URL + tool prefix." />
            <Field name="name" desc="Display name in the activity bar." />
            <Field name="description" desc="One-line summary shown in the marketplace listing." />
            <Field name="version" desc="Free-form, e.g. 1.0.0." />
            <Field name="image" desc="Full OCI ref, e.g. ghcr.io/acme/foo:1.0." />
          </Section>

          <Section title="Optional">
            <Field name="icon" desc="Lucide icon name (list-todo, database, globe, …)." />
            <Field name="scope" desc="env (default) | workspace | global. Drives how many containers run + who shares state." />
            <Field name="storage.kind" desc="none (default) | shared-postgres. Set shared-postgres to get DATABASE_URL + isolated schema." />
            <Field name="ui.path" desc="Path the iframe loads (default '/'). Use '/ui' to keep UI off the API root." />
            <Field name="ui.websocket" desc="Set true if upstream uses WS (code-server-style). Default false." />
            <Field name="mcp.enabled" desc="Expose an MCP server so the agent picks up your tools automatically." />
            <Field name="mcp.path" desc="Path of the MCP endpoint inside the container (default '/mcp')." />
          </Section>

          <Section title="Runtime conventions (no manifest field)">
            <p className="text-muted-foreground leading-relaxed">
              Plugins agree to a few rules so the manifest stays a
              description, not configuration:
            </p>
            <ul className="space-y-1 text-muted-foreground list-disc list-inside">
              <li>HTTP server listens on port <code className="font-mono">8080</code>.</li>
              <li>Health probe is <code className="font-mono">GET /</code> returning non-5xx within 15s (a redirect to /ui is fine).</li>
              <li>System injects <code className="font-mono">ENV_ID</code> + <code className="font-mono">WORKSPACE_ID</code> always; <code className="font-mono">DATABASE_URL</code> + <code className="font-mono">PGSCHEMA</code> when storage=shared-postgres.</li>
              <li>Plugins handle their own user auth + external API keys (e.g. via their own UI).</li>
            </ul>
          </Section>

          <Section title="What install does">
            <ol className="space-y-1 text-muted-foreground list-decimal list-inside">
              <li>Validate manifest (zod)</li>
              <li>
                <code className="font-mono">docker pull</code> the image
              </li>
              <li>Store as PluginDefinition</li>
              <li>Register the same-origin proxy route</li>
            </ol>
          </Section>
        </div>
      }
    />
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground mb-1.5">
        {title}
      </div>
      <div className="space-y-1.5">{children}</div>
    </div>
  );
}

function Field({ name, desc }: { name: string; desc: string }) {
  return (
    <div>
      <code className="font-mono text-[11px] text-foreground bg-muted/40 px-1 py-0.5 rounded">
        {name}
      </code>
      <p className="text-muted-foreground mt-0.5 leading-snug">{desc}</p>
    </div>
  );
}

function parseError(raw: string): string | null {
  if (!raw) return null;
  try {
    const obj = JSON.parse(raw) as { message?: string | string[] };
    if (Array.isArray(obj.message)) return obj.message.join("; ");
    if (typeof obj.message === "string") return obj.message;
  } catch {
    /* not JSON */
  }
  return raw;
}

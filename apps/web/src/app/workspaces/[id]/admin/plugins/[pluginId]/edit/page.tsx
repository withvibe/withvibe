"use client";

import { use, useEffect, useState } from "react";
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

export default function EditPluginPage(
  props: PageProps<"/workspaces/[id]/admin/plugins/[pluginId]/edit">
) {
  const { id: workspaceId, pluginId } = use(props.params);
  const router = useRouter();
  const pluginsHref = `/workspaces/${workspaceId}/admin/plugins`;
  const [manifestText, setManifestText] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const res = await fetch(
        `/api/workspaces/${workspaceId}/admin/plugins/${encodeURIComponent(pluginId)}`
      );
      if (cancelled) return;
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        setLoadError(parseError(text) || `HTTP ${res.status}`);
        return;
      }
      const body = (await res.json()) as { manifestText: string };
      setManifestText(body.manifestText);
    })();
    return () => {
      cancelled = true;
    };
  }, [pluginId, workspaceId]);

  async function save() {
    if (manifestText === null) return;
    setSaving(true);
    setSaveError(null);
    try {
      const res = await fetch(
        `/api/workspaces/${workspaceId}/admin/plugins/${encodeURIComponent(pluginId)}/update`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ manifestText }),
        }
      );
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        setSaveError(parseError(text) || `Update failed (HTTP ${res.status})`);
        return;
      }
      toast.success(
        "Plugin updated. Restart it from each env's plugin panel to pick up the new image."
      );
      router.push(pluginsHref);
    } finally {
      setSaving(false);
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
            disabled={saving}
          >
            <ArrowLeft className="size-4" />
            Plugins
          </Button>
          <span className="text-muted-foreground/50">/</span>
          <h1 className="text-sm font-mono font-medium">Update plugin</h1>
          <div className="ml-auto flex items-center gap-2">
            <Button
              size="sm"
              variant="outline"
              onClick={() => router.push(pluginsHref)}
              disabled={saving}
            >
              Cancel
            </Button>
            <Button
              size="sm"
              onClick={save}
              disabled={saving || manifestText === null}
            >
              {saving && <Loader2 className="size-4 animate-spin" />}
              {saving ? "Updating…" : "Update"}
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
          {loadError && (
            <div className="border-b border-destructive/40 bg-destructive/10 p-2 text-xs text-destructive flex gap-2 shrink-0">
              <AlertTriangle className="size-4 shrink-0 mt-0.5" />
              <pre className="whitespace-pre-wrap break-all flex-1">
                Failed to load current manifest: {loadError}
              </pre>
            </div>
          )}
          {saveError && (
            <div className="border-b border-destructive/40 bg-destructive/10 p-2 text-xs text-destructive flex gap-2 shrink-0">
              <AlertTriangle className="size-4 shrink-0 mt-0.5" />
              <pre className="whitespace-pre-wrap break-all flex-1">
                {saveError}
              </pre>
              <button
                type="button"
                onClick={() => setSaveError(null)}
                className="text-destructive/60 hover:text-destructive shrink-0"
              >
                ×
              </button>
            </div>
          )}
          <div className="border-b border-border/60 bg-card/30 shrink-0 flex items-center">
            <div className="flex items-center gap-2 px-3 py-1.5 border-r border-border/60 bg-background/40 text-xs font-mono">
              <FileCode className="size-3.5" />
              {MANIFEST_FILENAME}
            </div>
          </div>
          <div className="flex-1 min-h-0">
            {manifestText === null ? (
              <div className="p-3 text-xs text-muted-foreground">
                {loadError ? "Could not load manifest." : "Loading manifest…"}
              </div>
            ) : (
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
            )}
          </div>
        </div>
      }
      ai={
        <div className="p-4 space-y-4 text-xs overflow-y-auto">
          <div>
            <div className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground mb-1.5">
              Update behavior
            </div>
            <p className="text-muted-foreground leading-relaxed">
              Replaces the stored manifest and, for registry images, force-pulls
              so a moving tag picks up new content. Running plugin instances
              are stopped so the next env start uses the new image — restart
              each env&apos;s plugin from its panel after saving.
            </p>
          </div>

          <Section title="What changes safely">
            <Field
              name="version, name, icon"
              desc="Cosmetic / metadata. Updates the admin list and activity bar."
            />
            <Field
              name="image"
              desc="New OCI tag. Force-pulled on save; local-only tags reuse what docker has."
            />
            <Field
              name="ui, mcp, launch.env"
              desc="Picked up on next container start. Already-running instances keep the old config until restarted."
            />
            <Field
              name="defaultEnabledInEnv"
              desc="Affects only new envs. Existing per-env preferences are preserved."
            />
          </Section>

          <Section title="What you should NOT change">
            <Field
              name="id"
              desc="The id keys the definition + URL + tool prefix. Changing it is an install of a different plugin — uninstall the old one first."
            />
            <Field
              name="scope"
              desc="Flipping scope orphans existing storage and instances. Uninstall and re-install if you really need to switch."
            />
            <Field
              name="storage.kind"
              desc="Going from shared-postgres to none (or vice versa) won't migrate data. Plan a manual export first."
            />
          </Section>

          <Section title="On save">
            <ol className="space-y-1 text-muted-foreground list-decimal list-inside">
              <li>Validate manifest (zod)</li>
              <li>Stop every running instance of this plugin</li>
              <li>Force-pull the image (or reuse local)</li>
              <li>Upsert PluginDefinition + re-register proxy route</li>
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

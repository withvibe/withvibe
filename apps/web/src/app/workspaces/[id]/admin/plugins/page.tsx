"use client";

import { use, useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
  Link2,
  Loader2,
  Package,
  Pencil,
  Plus,
  Power,
  Store,
  Trash2,
} from "lucide-react";
import { Checkbox } from "@/components/ui/checkbox";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

type AdminPluginRow = {
  id: string;
  manifestId: string;
  name: string;
  version: string;
  image: string;
  icon: string | null;
  enabled: boolean;
  defaultEnabledInEnv: boolean;
  installedAt: string;
  installedBy: string | null;
  runningInstances: number;
};

export default function AdminPluginsPage(
  props: PageProps<"/workspaces/[id]/admin/plugins">
) {
  const { id: workspaceId } = use(props.params);
  const router = useRouter();
  const [plugins, setPlugins] = useState<AdminPluginRow[] | null>(null);
  const [actingId, setActingId] = useState<string | null>(null);
  const [deleteOpen, setDeleteOpen] = useState<AdminPluginRow | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState("");
  const [deleting, setDeleting] = useState(false);
  const [fromUrlOpen, setFromUrlOpen] = useState(false);
  const [manifestUrl, setManifestUrl] = useState("");
  const [installingFromUrl, setInstallingFromUrl] = useState(false);

  const load = useCallback(async () => {
    const res = await fetch(`/api/workspaces/${workspaceId}/admin/plugins`);
    if (!res.ok) {
      toast.error(`Failed to load plugins (HTTP ${res.status})`);
      return;
    }
    const body = (await res.json()) as { plugins: AdminPluginRow[] };
    setPlugins(body.plugins);
  }, [workspaceId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function toggleEnabled(p: AdminPluginRow) {
    setActingId(p.id);
    try {
      const res = await fetch(
        `/api/workspaces/${workspaceId}/admin/plugins/${encodeURIComponent(p.id)}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ enabled: !p.enabled }),
        }
      );
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        toast.error(parseError(text) || `Failed (HTTP ${res.status})`);
        return;
      }
      toast.success(p.enabled ? "Plugin disabled" : "Plugin enabled");
      await load();
    } finally {
      setActingId(null);
    }
  }

  async function setDefaultEnabledInEnv(p: AdminPluginRow, next: boolean) {
    setActingId(p.id);
    setPlugins((rows) =>
      rows
        ? rows.map((r) =>
            r.id === p.id ? { ...r, defaultEnabledInEnv: next } : r
          )
        : rows
    );
    try {
      const res = await fetch(
        `/api/workspaces/${workspaceId}/admin/plugins/${encodeURIComponent(p.id)}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ defaultEnabledInEnv: next }),
        }
      );
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        toast.error(parseError(text) || `Failed (HTTP ${res.status})`);
        setPlugins((rows) =>
          rows
            ? rows.map((r) =>
                r.id === p.id ? { ...r, defaultEnabledInEnv: !next } : r
              )
            : rows
        );
        return;
      }
      toast.success(
        next
          ? "New envs will see this plugin by default"
          : "New envs will need to enable this plugin manually"
      );
    } finally {
      setActingId(null);
    }
  }

  async function installFromUrl() {
    const url = manifestUrl.trim();
    if (!url) return;
    setInstallingFromUrl(true);
    try {
      const res = await fetch(
        `/api/workspaces/${workspaceId}/admin/plugins/install-from-url`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ manifestUrl: url }),
        }
      );
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        toast.error(parseError(text) || `Install failed (HTTP ${res.status})`);
        return;
      }
      toast.success("Plugin installed");
      setFromUrlOpen(false);
      setManifestUrl("");
      await load();
    } finally {
      setInstallingFromUrl(false);
    }
  }

  async function uninstall() {
    if (!deleteOpen) return;
    setDeleting(true);
    try {
      const res = await fetch(
        `/api/workspaces/${workspaceId}/admin/plugins/${encodeURIComponent(deleteOpen.id)}`,
        { method: "DELETE" }
      );
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        toast.error(parseError(text) || `Failed (HTTP ${res.status})`);
        return;
      }
      toast.success("Plugin uninstalled");
      setDeleteOpen(null);
      setDeleteConfirm("");
      await load();
    } finally {
      setDeleting(false);
    }
  }

  return (
    <div className="max-w-[1100px] mx-auto p-4 sm:p-6 space-y-6">
      <header className="flex items-center justify-between gap-4 flex-wrap">
        <div className="space-y-1 min-w-0">
          <h1 className="text-xl font-mono font-bold flex items-center gap-2">
            <Package className="size-5" /> Plugins
          </h1>
          <p className="text-sm text-muted-foreground">
            Plugins installed here are available in every env&apos;s activity
            bar in this workspace. Disabling stops every running instance
            across this workspace&apos;s envs.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            onClick={() =>
              router.push(
                `/workspaces/${workspaceId}/admin/plugins/marketplace`
              )
            }
          >
            <Store className="size-4" /> Browse marketplace
          </Button>
          <Button variant="outline" onClick={() => setFromUrlOpen(true)}>
            <Link2 className="size-4" /> From URL
          </Button>
          <Button
            onClick={() =>
              router.push(`/workspaces/${workspaceId}/admin/plugins/new`)
            }
          >
            <Plus className="size-4" /> Install plugin
          </Button>
        </div>
      </header>

      {plugins === null ? (
        <div className="space-y-2">
          <Skeleton className="h-14 w-full" />
          <Skeleton className="h-14 w-full" />
        </div>
      ) : plugins.length === 0 ? (
        <div className="rounded-md border border-dashed border-border/60 p-10 text-center text-sm text-muted-foreground">
          No plugins installed yet. Click <strong>Install plugin</strong> to
          paste a manifest in the editor.
        </div>
      ) : (
        <ul className="space-y-2">
          {plugins.map((p) => (
            <li
              key={p.id}
              className={cn(
                "rounded-md border bg-card p-3 flex items-center gap-3 flex-wrap",
                !p.enabled && "opacity-60"
              )}
            >
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="font-mono text-sm font-medium">
                    {p.name}
                  </span>
                  <span className="text-[11px] font-mono text-muted-foreground">
                    {p.manifestId}@{p.version}
                  </span>
                  <span
                    className={cn(
                      "text-[10px] font-mono uppercase px-1.5 py-0.5 rounded border",
                      p.enabled
                        ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-400"
                        : "border-border bg-muted text-muted-foreground"
                    )}
                  >
                    {p.enabled ? "enabled" : "disabled"}
                  </span>
                  {p.runningInstances > 0 && (
                    <span className="text-[10px] font-mono uppercase px-1.5 py-0.5 rounded border border-primary/30 bg-primary/10 text-primary">
                      {p.runningInstances} running
                    </span>
                  )}
                </div>
                <div className="text-xs font-mono text-muted-foreground truncate mt-0.5">
                  {p.image}
                </div>
              </div>
              <label
                className="flex items-center gap-2 text-[11px] font-mono cursor-pointer select-none"
                title="Whether newly-created envs see this plugin in their activity bar by default. Existing env preferences aren't changed."
              >
                <Checkbox
                  checked={p.defaultEnabledInEnv}
                  disabled={actingId === p.id || !p.enabled}
                  onCheckedChange={(v) =>
                    setDefaultEnabledInEnv(p, v === true)
                  }
                />
                <span className="text-muted-foreground">
                  default in new envs
                </span>
              </label>
              <Button
                size="sm"
                variant="outline"
                onClick={() =>
                  router.push(
                    `/workspaces/${workspaceId}/admin/plugins/${encodeURIComponent(p.id)}/edit`
                  )
                }
                disabled={actingId === p.id}
                title="Edit manifest and push a new image"
              >
                <Pencil className="size-4" />
                Update
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => toggleEnabled(p)}
                disabled={actingId === p.id}
                title={p.enabled ? "Disable plugin" : "Enable plugin"}
              >
                {actingId === p.id ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <Power className="size-4" />
                )}
                {p.enabled ? "Disable" : "Enable"}
              </Button>
              <Button
                size="icon"
                variant="ghost"
                onClick={() => {
                  setDeleteOpen(p);
                  setDeleteConfirm("");
                }}
                title="Uninstall"
              >
                <Trash2 className="size-4 text-destructive" />
              </Button>
            </li>
          ))}
        </ul>
      )}

      <Dialog
        open={fromUrlOpen}
        onOpenChange={(o) => {
          if (!o && !installingFromUrl) {
            setFromUrlOpen(false);
            setManifestUrl("");
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Install from URL</DialogTitle>
            <DialogDescription>
              Paste the HTTPS URL of a plugin manifest (
              <code className="font-mono">manifest.yaml</code>). Useful for
              private mirrors, self-hosted catalogs, or sharing a plugin
              before it&apos;s published.
            </DialogDescription>
          </DialogHeader>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void installFromUrl();
            }}
            className="space-y-2"
          >
            <Label htmlFor="manifest-url" className="text-xs font-mono">
              Manifest URL
            </Label>
            <Input
              id="manifest-url"
              type="url"
              required
              autoFocus
              autoComplete="off"
              placeholder="https://example.com/plugins/foo/manifest.yaml"
              value={manifestUrl}
              onChange={(e) => setManifestUrl(e.target.value)}
              disabled={installingFromUrl}
            />
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  setFromUrlOpen(false);
                  setManifestUrl("");
                }}
                disabled={installingFromUrl}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                disabled={installingFromUrl || !manifestUrl.trim()}
              >
                {installingFromUrl && (
                  <Loader2 className="size-4 animate-spin" />
                )}
                {installingFromUrl ? "Pulling image…" : "Install"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog
        open={Boolean(deleteOpen)}
        onOpenChange={(o) => {
          if (!o) {
            setDeleteOpen(null);
            setDeleteConfirm("");
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="text-destructive">
              Uninstall plugin?
            </DialogTitle>
            <DialogDescription>
              This stops every running instance of{" "}
              <strong>{deleteOpen?.name}</strong> across all envs and deletes
              the plugin definition. Envs that were using it lose their
              activity-bar entry; the plugin&apos;s data volumes are NOT
              deleted.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="delete-confirm" className="text-xs font-mono">
              Type <code className="px-1 py-0.5 rounded bg-muted">uninstall</code> to confirm:
            </Label>
            <Input
              id="delete-confirm"
              autoFocus
              autoComplete="off"
              value={deleteConfirm}
              onChange={(e) => setDeleteConfirm(e.target.value)}
              disabled={deleting}
            />
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setDeleteOpen(null)}
              disabled={deleting}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={uninstall}
              disabled={
                deleting ||
                deleteConfirm.trim().toLowerCase() !== "uninstall"
              }
            >
              {deleting ? "Uninstalling…" : "Uninstall"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
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

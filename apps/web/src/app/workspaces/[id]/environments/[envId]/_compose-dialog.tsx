"use client";

import { useEffect, useState } from "react";
import { FileCode, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { toast } from "sonner";

type AssetMeta = { path: string; size: number; updatedAt: string };

export function ComposeDialog({
  open,
  onOpenChange,
  workspaceId,
  envId,
  initialValue,
  initialAssets,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  workspaceId: string;
  envId: string;
  initialValue: string | null;
  initialAssets: AssetMeta[];
  onSaved: () => Promise<void> | void;
}) {
  const [value, setValue] = useState(initialValue || "");
  const [assets, setAssets] = useState<AssetMeta[]>(initialAssets);
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);

  useEffect(() => {
    if (open) {
      setValue(initialValue || "");
      setAssets(initialAssets);
    }
  }, [open, initialValue, initialAssets]);

  async function saveCompose() {
    setSaving(true);
    try {
      const res = await fetch(
        `/api/workspaces/${workspaceId}/envs/${envId}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ composeFile: value.trim() || null }),
        }
      );
      if (!res.ok) {
        const msg = await res.text().catch(() => "Failed to save");
        toast.error(msg || "Failed to save");
        return;
      }
      toast.success(
        value.trim()
          ? "Custom compose saved — rebuild to apply"
          : "Custom compose cleared — falling back to repo compose"
      );
      await onSaved();
      onOpenChange(false);
    } finally {
      setSaving(false);
    }
  }

  async function clearCustom() {
    if (!initialValue) return;
    if (!confirm("Remove the env-level compose override?")) return;
    setValue("");
    setSaving(true);
    try {
      const res = await fetch(
        `/api/workspaces/${workspaceId}/envs/${envId}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ composeFile: null }),
        }
      );
      if (res.ok) {
        toast.success("Custom compose cleared");
        await onSaved();
        onOpenChange(false);
      }
    } finally {
      setSaving(false);
    }
  }

  async function uploadFiles(picked: { path: string; file: File }[]) {
    if (picked.length === 0) return;
    setUploading(true);
    try {
      const fd = new FormData();
      for (const p of picked) {
        fd.append(
          "files",
          new File([p.file], p.path, { type: p.file.type })
        );
      }
      const res = await fetch(
        `/api/workspaces/${workspaceId}/envs/${envId}/assets`,
        { method: "POST", body: fd }
      );
      if (!res.ok) {
        const msg = await res.text().catch(() => "Upload failed");
        toast.error(msg || "Upload failed");
        return;
      }
      const next = (await res.json()) as AssetMeta[];
      setAssets(next);
      toast.success(`Uploaded ${picked.length} file(s)`);
      await onSaved();
    } finally {
      setUploading(false);
    }
  }

  async function deleteAsset(assetPath: string) {
    if (!confirm(`Remove ${assetPath}?`)) return;
    const res = await fetch(
      `/api/workspaces/${workspaceId}/envs/${envId}/assets/${assetPath
        .split("/")
        .map(encodeURIComponent)
        .join("/")}`,
      { method: "DELETE" }
    );
    if (!res.ok) {
      toast.error("Failed to remove");
      return;
    }
    const next = (await res.json()) as AssetMeta[];
    setAssets(next);
    await onSaved();
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 font-mono">
            <FileCode className="size-4" />
            Compose &amp; assets
          </DialogTitle>
          <DialogDescription>
            Paste an env-level <code className="font-mono">docker-compose.yml</code>{" "}
            (overrides any compose from attached repos) and upload extra files
            (schemas, configs, seed data) that the DevOps agent can reference as{" "}
            <code className="font-mono">./assets/&lt;path&gt;</code>.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <Label>docker-compose.yml</Label>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => {
                const el = document.getElementById(
                  "compose-file-upload"
                ) as HTMLInputElement | null;
                el?.click();
              }}
            >
              Upload file
            </Button>
          </div>
          <input
            id="compose-file-upload"
            type="file"
            accept=".yml,.yaml,application/yaml,text/yaml,text/plain"
            className="hidden"
            onChange={async (e) => {
              const f = e.target.files?.[0];
              e.target.value = "";
              if (!f) return;
              const text = await f.text();
              setValue(text);
            }}
          />
          <Textarea
            value={value}
            onChange={(e) => setValue(e.target.value)}
            rows={12}
            spellCheck={false}
            placeholder={`services:\n  app:\n    build: ./my-repo\n    ports:\n      - "3000:3000"`}
            className="font-mono text-xs"
          />
        </div>

        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <Label>Assets</Label>
            <div className="flex gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={uploading}
                onClick={() => {
                  const el = document.getElementById(
                    "compose-assets-files"
                  ) as HTMLInputElement | null;
                  el?.click();
                }}
              >
                Upload files
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={uploading}
                onClick={() => {
                  const el = document.getElementById(
                    "compose-assets-folder"
                  ) as HTMLInputElement | null;
                  el?.click();
                }}
              >
                Upload folder
              </Button>
            </div>
          </div>
          <input
            id="compose-assets-files"
            type="file"
            multiple
            className="hidden"
            onChange={(e) => {
              const list = Array.from(e.target.files ?? []);
              void uploadFiles(list.map((f) => ({ path: f.name, file: f })));
              e.target.value = "";
            }}
          />
          <input
            id="compose-assets-folder"
            type="file"
            multiple
            className="hidden"
            // Set folder-mode attributes imperatively — JSX forwards
            // `webkitdirectory=""` inconsistently and silently falls back to
            // a regular file picker otherwise.
            ref={(el) => {
              if (!el) return;
              el.setAttribute("webkitdirectory", "");
              el.setAttribute("directory", "");
            }}
            onChange={(e) => {
              const list = Array.from(e.target.files ?? []);
              void uploadFiles(
                list.map((f) => ({
                  // webkitRelativePath preserves the picked folder name and
                  // any sub-structure (e.g. "myfolder/sub/file.sql") — kept
                  // verbatim so assets land under assets/<picked>/...
                  path:
                    (f as File & { webkitRelativePath?: string })
                      .webkitRelativePath || f.name,
                  file: f,
                }))
              );
              e.target.value = "";
            }}
          />
          {assets.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              No assets yet.
            </p>
          ) : (
            <ul className="space-y-1 text-xs font-mono max-h-48 overflow-auto">
              {assets.map((a) => (
                <li
                  key={a.path}
                  className="flex items-center justify-between gap-2 rounded border px-2 py-1"
                >
                  <span className="truncate" title={a.path}>
                    {a.path}
                  </span>
                  <span className="text-muted-foreground shrink-0">
                    {formatBytes(a.size)}
                  </span>
                  <button
                    type="button"
                    onClick={() => void deleteAsset(a.path)}
                    className="text-destructive hover:underline shrink-0"
                  >
                    Remove
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        <DialogFooter className="sm:justify-between">
          <div>
            {initialValue && (
              <Button
                variant="outline"
                onClick={clearCustom}
                disabled={saving}
              >
                <Trash2 className="size-4 text-destructive" />
                Clear compose
              </Button>
            )}
          </div>
          <div className="flex gap-2">
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              Close
            </Button>
            <Button onClick={saveCompose} disabled={saving}>
              {saving ? "Saving…" : "Save compose"}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

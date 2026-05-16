"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  Download,
  FilePlus2,
  FileText,
  Folder,
  FolderPlus,
  Pencil,
  RefreshCw,
  Sparkles,
  Trash2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { toast } from "sonner";

type TreeEntry = {
  name: string;
  path: string;
  kind: "file" | "folder";
  size: number;
  modifiedAt: string;
  children?: TreeEntry[];
};

type TreeResponse = { root: TreeEntry };

function formatSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  const now = Date.now();
  const diffMs = now - d.getTime();
  const min = 60_000;
  const hour = 60 * min;
  const day = 24 * hour;
  if (diffMs < min) return "just now";
  if (diffMs < hour) return `${Math.floor(diffMs / min)}m ago`;
  if (diffMs < day) return `${Math.floor(diffMs / hour)}h ago`;
  if (diffMs < 7 * day) return `${Math.floor(diffMs / day)}d ago`;
  return d.toLocaleDateString();
}

function flatten(
  entries: TreeEntry[] | undefined,
  expanded: Record<string, boolean>,
  depth = 0
): { entry: TreeEntry; depth: number }[] {
  if (!entries) return [];
  const out: { entry: TreeEntry; depth: number }[] = [];
  for (const e of entries) {
    out.push({ entry: e, depth });
    if (e.kind === "folder" && expanded[e.path]) {
      out.push(...flatten(e.children, expanded, depth + 1));
    }
  }
  return out;
}

export function ContextPanel({
  workspaceId,
  envId,
}: {
  workspaceId: string;
  envId: string;
}) {
  const [tree, setTree] = useState<TreeEntry | null>(null);
  const [loading, setLoading] = useState(false);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({
    ai: true, // expand the AI folder by default so deliverables are visible
  });
  const [uploadKind, setUploadKind] = useState<null | "files" | "folder">(null);
  const [uploadDest, setUploadDest] = useState("");
  const [pendingFiles, setPendingFiles] = useState<File[]>([]);
  const [uploading, setUploading] = useState(false);
  const [renaming, setRenaming] = useState<TreeEntry | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [deleting, setDeleting] = useState<TreeEntry | null>(null);
  const [busy, setBusy] = useState(false);
  const filesInput = useRef<HTMLInputElement | null>(null);
  const folderInput = useRef<HTMLInputElement | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(
        `/api/workspaces/${workspaceId}/envs/${envId}/context/tree`
      );
      if (!res.ok) {
        toast.error("Failed to load extra context");
        return;
      }
      const json = (await res.json()) as TreeResponse;
      setTree(json.root);
    } finally {
      setLoading(false);
    }
  }, [workspaceId, envId]);

  useEffect(() => {
    void load();
  }, [load]);

  // Auto-refresh while panel is open — agents may write new files mid-session.
  useEffect(() => {
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, [load]);

  // Split children into "user files" (everything except the ai/ folder) and
  // "AI-generated" (contents of ai/, rendered without the ai/ wrapper). Disk
  // layout doesn't change — this is presentation only.
  const { userRows, aiChildren, aiHasAny } = useMemo(() => {
    const children = tree?.children ?? [];
    const aiFolder = children.find(
      (c) => c.path === "ai" && c.kind === "folder"
    );
    const others = children.filter(
      (c) => !(c.path === "ai" && c.kind === "folder")
    );
    return {
      userRows: flatten(others, expanded),
      aiChildren: aiFolder?.children ?? [],
      aiHasAny: !!aiFolder && (aiFolder.children?.length ?? 0) > 0,
    };
  }, [tree, expanded]);

  const aiRows = useMemo(
    () => flatten(aiChildren, expanded),
    [aiChildren, expanded]
  );

  function toggle(p: string) {
    setExpanded((e) => ({ ...e, [p]: !e[p] }));
  }

  function downloadUrl(relPath: string, asAttachment = false): string {
    const params = new URLSearchParams({ path: relPath });
    if (asAttachment) params.set("disposition", "attachment");
    return `/api/workspaces/${workspaceId}/envs/${envId}/context/file?${params.toString()}`;
  }

  function openInNewTab(relPath: string) {
    window.open(downloadUrl(relPath, false), "_blank", "noopener");
  }

  function triggerDownload(relPath: string) {
    const a = document.createElement("a");
    a.href = downloadUrl(relPath, true);
    a.download = relPath.split("/").pop() ?? "download";
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  function startUpload(kind: "files" | "folder") {
    setUploadKind(kind);
    setUploadDest("");
    setPendingFiles([]);
  }

  function pickFiles() {
    filesInput.current?.click();
  }

  function pickFolder() {
    folderInput.current?.click();
  }

  async function submitUpload() {
    if (!uploadKind) return;
    if (pendingFiles.length === 0) {
      toast.error("Pick at least one file");
      return;
    }
    setUploading(true);
    try {
      const fd = new FormData();
      const dest = uploadDest.trim().replace(/^\/+|\/+$/g, "");
      if (dest) fd.append("destDir", dest);
      // Browsers strip path separators from the multipart filename, so
      // webkitRelativePath would be lost if we leaned on it. Send each file
      // alongside its relative path as a parallel `paths` field; the server
      // pairs them by index.
      const paths: string[] = [];
      for (const f of pendingFiles) {
        const rel =
          (f as File & { webkitRelativePath?: string }).webkitRelativePath ||
          f.name;
        paths.push(rel);
        fd.append("files", f);
      }
      fd.append("paths", JSON.stringify(paths));
      const res = await fetch(
        `/api/workspaces/${workspaceId}/envs/${envId}/context/upload`,
        { method: "POST", body: fd }
      );
      if (!res.ok) {
        const msg = await res.text().catch(() => "");
        toast.error(msg || "Upload failed");
        return;
      }
      const json = (await res.json()) as TreeResponse;
      setTree(json.root);
      toast.success(`Uploaded ${pendingFiles.length} file(s)`);
      setUploadKind(null);
      setPendingFiles([]);
    } finally {
      setUploading(false);
    }
  }

  function startRename(entry: TreeEntry) {
    setRenameValue(entry.path);
    setRenaming(entry);
  }

  async function submitRename() {
    if (!renaming) return;
    const to = renameValue.trim();
    if (!to || to === renaming.path) {
      setRenaming(null);
      return;
    }
    setBusy(true);
    try {
      const res = await fetch(
        `/api/workspaces/${workspaceId}/envs/${envId}/context/entry`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ fromPath: renaming.path, toPath: to }),
        }
      );
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        toast.error(text || "Rename failed");
        return;
      }
      const json = (await res.json()) as TreeResponse;
      setTree(json.root);
      toast.success("Renamed");
      setRenaming(null);
    } finally {
      setBusy(false);
    }
  }

  async function confirmDelete() {
    if (!deleting) return;
    setBusy(true);
    try {
      const params = new URLSearchParams({ path: deleting.path });
      const res = await fetch(
        `/api/workspaces/${workspaceId}/envs/${envId}/context/entry?${params.toString()}`,
        { method: "DELETE" }
      );
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        toast.error(text || "Delete failed");
        return;
      }
      const json = (await res.json()) as TreeResponse;
      setTree(json.root);
      toast.success(`Deleted ${deleting.name}`);
      setDeleting(null);
    } finally {
      setBusy(false);
    }
  }

  function renderRow(
    { entry, depth }: { entry: TreeEntry; depth: number },
    insideAi = false
  ) {
    return (
      <li
        key={entry.path}
        className="flex items-center gap-2 px-3 py-1.5 hover:bg-muted/40 group"
        style={{ paddingLeft: 12 + depth * 16 }}
      >
        {entry.kind === "folder" ? (
          <button
            type="button"
            onClick={() => toggle(entry.path)}
            className="inline-flex items-center justify-center size-5 text-muted-foreground hover:text-foreground"
          >
            {expanded[entry.path] ? (
              <ChevronDown className="size-3.5" />
            ) : (
              <ChevronRight className="size-3.5" />
            )}
          </button>
        ) : (
          <span className="size-5" />
        )}
        {entry.kind === "folder" ? (
          <Folder
            className={`size-4 shrink-0 ${insideAi ? "text-primary/70" : "text-muted-foreground"}`}
          />
        ) : (
          <FileText
            className={`size-4 shrink-0 ${insideAi ? "text-primary/80" : "text-muted-foreground"}`}
          />
        )}
        <button
          type="button"
          onClick={() => {
            if (entry.kind === "folder") toggle(entry.path);
            else openInNewTab(entry.path);
          }}
          className="flex-1 min-w-0 text-left text-sm font-mono truncate hover:underline"
          title={entry.path}
        >
          {entry.name}
        </button>
        <span className="text-[11px] text-muted-foreground shrink-0 tabular-nums">
          {entry.kind === "file" ? formatSize(entry.size) : ""}
        </span>
        <span className="text-[11px] text-muted-foreground shrink-0 w-16 text-right">
          {formatTime(entry.modifiedAt)}
        </span>
        <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
          {entry.kind === "file" && (
            <Button
              size="icon"
              variant="ghost"
              className="size-7"
              onClick={() => triggerDownload(entry.path)}
              title="Download"
            >
              <Download className="size-3.5" />
            </Button>
          )}
          <Button
            size="icon"
            variant="ghost"
            className="size-7"
            onClick={() => startRename(entry)}
            title="Rename / move"
          >
            <Pencil className="size-3.5" />
          </Button>
          <Button
            size="icon"
            variant="ghost"
            className="size-7 text-destructive hover:text-destructive"
            onClick={() => setDeleting(entry)}
            title="Delete"
          >
            <Trash2 className="size-3.5" />
          </Button>
        </div>
      </li>
    );
  }

  return (
    <div className="h-full flex flex-col">
      <div className="px-3 py-2 border-b border-border/60 shrink-0 space-y-2">
        <p className="text-xs text-muted-foreground">
          Files mounted at <code className="font-mono">./extracontext/</code>{" "}
          in the env. Upload reference material (folders, datasets, docs) for
          the AI to read, or browse AI-produced deliverables under{" "}
          <code className="font-mono">ai/</code>.
        </p>
        <div className="flex items-center gap-1">
          <Button
            size="sm"
            variant="outline"
            onClick={() => startUpload("folder")}
          >
            <FolderPlus className="size-4" />
            Upload folder
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => startUpload("files")}
          >
            <FilePlus2 className="size-4" />
            Upload file(s)
          </Button>
          <div className="ml-auto" />
          <Button
            size="icon"
            variant="ghost"
            onClick={() => void load()}
            title="Refresh"
            disabled={loading}
          >
            <RefreshCw
              className={`size-3.5 ${loading ? "animate-spin" : ""}`}
            />
          </Button>
        </div>
      </div>

      <div className="flex-1 min-h-0 overflow-auto">
        {/* Section: user-uploaded files (everything except ai/) */}
        <div className="px-3 py-1.5 text-[10px] uppercase tracking-wide font-mono text-muted-foreground bg-muted/30 border-b border-border/60 sticky top-0 z-10">
          Your files
        </div>
        {userRows.length === 0 ? (
          <div className="p-4 text-center text-xs text-muted-foreground">
            No uploads yet. Use the buttons above to attach reference material.
          </div>
        ) : (
          <ul className="divide-y divide-border/60">
            {userRows.map((r) => renderRow(r))}
          </ul>
        )}

        {/* Section: AI-generated files (contents of ai/, rendered without
            the wrapper folder so paths feel natural). */}
        <div className="px-3 py-1.5 mt-2 text-[10px] uppercase tracking-wide font-mono text-primary/90 bg-primary/5 border-y border-primary/20 sticky top-0 z-10 flex items-center gap-1.5">
          <Sparkles className="size-3" />
          AI-generated
        </div>
        {!aiHasAny ? (
          <div className="p-4 text-center text-xs text-muted-foreground">
            Nothing here yet. Try asking:
            <div className="mt-1.5 italic text-foreground/80">
              &ldquo;Create a technical document about what this env is and
              save it as a PDF.&rdquo;
            </div>
          </div>
        ) : (
          <ul className="divide-y divide-border/60">
            {aiRows.map((r) => renderRow(r, true))}
          </ul>
        )}
      </div>

      {/* Hidden file inputs — kept mounted so the dialog "Choose…" buttons
          can trigger them via refs. */}
      <input
        ref={filesInput}
        id="ctx-file-input"
        type="file"
        multiple
        className="hidden"
        onChange={(e) => setPendingFiles(Array.from(e.target.files ?? []))}
      />
      <input
        ref={folderInput}
        id="ctx-folder-input"
        type="file"
        // @ts-expect-error — non-standard but supported by Chromium-based browsers
        webkitdirectory=""
        directory=""
        multiple
        className="hidden"
        onChange={(e) => setPendingFiles(Array.from(e.target.files ?? []))}
      />

      <Dialog
        open={!!uploadKind}
        onOpenChange={(v) => !v && setUploadKind(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {uploadKind === "folder" ? "Upload folder" : "Upload file(s)"}
            </DialogTitle>
            <DialogDescription>
              Files land under <code>extracontext/</code>. Optionally type a
              destination subfolder (e.g. <code>research/papers</code>) — it
              will be created if missing.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3 mt-2">
            <div className="space-y-1">
              <label
                htmlFor="ctx-dest"
                className="block text-xs text-muted-foreground"
              >
                Destination folder (optional, relative to{" "}
                <code>extracontext/</code>)
              </label>
              <Input
                id="ctx-dest"
                value={uploadDest}
                onChange={(e) => setUploadDest(e.target.value)}
                placeholder="leave blank for root"
                disabled={uploading}
              />
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={uploadKind === "folder" ? pickFolder : pickFiles}
              disabled={uploading}
            >
              {uploadKind === "folder"
                ? "Choose folder…"
                : "Choose file(s)…"}
            </Button>
            {pendingFiles.length > 0 && (
              <p className="text-xs text-muted-foreground">
                {pendingFiles.length} file(s) selected
                {pendingFiles[0] &&
                  (
                    pendingFiles[0] as File & { webkitRelativePath?: string }
                  ).webkitRelativePath
                  ? ` from "${(
                      pendingFiles[0] as File & { webkitRelativePath?: string }
                    ).webkitRelativePath?.split("/")[0]}"`
                  : ""}
              </p>
            )}
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setUploadKind(null)}
              disabled={uploading}
            >
              Cancel
            </Button>
            <Button
              onClick={() => void submitUpload()}
              disabled={uploading || pendingFiles.length === 0}
            >
              {uploading ? "Uploading…" : "Upload"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!renaming} onOpenChange={(v) => !v && setRenaming(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Rename or move</DialogTitle>
            <DialogDescription>
              Path is relative to <code>extracontext/</code>. Use forward
              slashes to move into a subfolder (e.g.{" "}
              <code>docs/architecture.md</code>).
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2 mt-2">
            <Input
              autoFocus
              value={renameValue}
              onChange={(e) => setRenameValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void submitRename();
              }}
              disabled={busy}
            />
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setRenaming(null)}
              disabled={busy}
            >
              Cancel
            </Button>
            <Button onClick={() => void submitRename()} disabled={busy}>
              {busy ? "Renaming…" : "Rename"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!deleting} onOpenChange={(v) => !v && setDeleting(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="text-destructive">
              Delete {deleting?.kind === "folder" ? "folder" : "file"}?
            </DialogTitle>
            <DialogDescription>
              {deleting?.kind === "folder" ? (
                <>
                  This will permanently delete{" "}
                  <strong>{deleting?.path}</strong> and everything inside it.
                </>
              ) : (
                <>
                  This will permanently delete{" "}
                  <strong>{deleting?.path}</strong>.
                </>
              )}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setDeleting(null)}
              disabled={busy}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => void confirmDelete()}
              disabled={busy}
            >
              {busy ? "Deleting…" : "Delete"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

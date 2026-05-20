"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import dynamic from "next/dynamic";
import {
  ChevronDown,
  ChevronRight,
  Code2,
  Download,
  FilePlus2,
  FileText,
  Folder,
  FolderPlus,
  Loader2,
  Pencil,
  Plus,
  RefreshCw,
  Sparkles,
  Trash2,
  Upload,
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

// Monaco bundles its own web worker — never render it server-side.
const MonacoEditor = dynamic(
  () => import("@monaco-editor/react").then((m) => m.default),
  {
    ssr: false,
    loading: () => (
      <div className="flex items-center justify-center h-full text-xs text-muted-foreground">
        <Loader2 className="size-4 animate-spin mr-2" />
        Loading editor…
      </div>
    ),
  }
);

// Files we'll preview in Monaco. Anything outside this set keeps the
// download-only flow (binaries, PDFs, images, archives). The server also
// guards with a null-byte sniff so a misnamed binary won't bypass this.
const EDITABLE_EXTENSIONS = new Set([
  "md", "txt", "json", "yaml", "yml", "toml", "ini", "conf", "cfg",
  "csv", "tsv", "log", "env", "sh", "bash", "zsh", "fish",
  "js", "jsx", "ts", "tsx", "mjs", "cjs",
  "py", "rb", "go", "rs", "java", "kt", "scala", "swift",
  "c", "cc", "cpp", "h", "hpp", "cs", "php", "lua", "r",
  "html", "htm", "css", "scss", "sass", "less",
  "sql", "graphql", "gql", "proto",
  "xml", "svg", "dockerfile", "gitignore", "dockerignore", "editorconfig",
  "prettierrc", "eslintrc", "babelrc",
]);

function isEditablePath(p: string): boolean {
  const base = p.split("/").pop() ?? "";
  const lower = base.toLowerCase();
  if (lower === "dockerfile" || lower.startsWith("dockerfile.")) return true;
  if (lower.startsWith(".env")) return true;
  if (lower.startsWith(".") && !lower.includes(".", 1)) return true; // .gitignore, .prettierrc
  const dot = lower.lastIndexOf(".");
  if (dot < 0) return false;
  return EDITABLE_EXTENSIONS.has(lower.slice(dot + 1));
}

function monacoLanguageForPath(p: string): string {
  const lower = p.toLowerCase();
  const base = lower.split("/").pop() ?? "";
  if (base === "dockerfile" || base.startsWith("dockerfile.")) return "dockerfile";
  if (base === ".env" || base.startsWith(".env.")) return "ini";
  if (lower.endsWith(".yml") || lower.endsWith(".yaml")) return "yaml";
  if (lower.endsWith(".json")) return "json";
  if (lower.endsWith(".sh") || lower.endsWith(".bash") || lower.endsWith(".zsh")) return "shell";
  if (lower.endsWith(".toml") || lower.endsWith(".ini") || lower.endsWith(".conf")) return "ini";
  if (lower.endsWith(".md")) return "markdown";
  if (lower.endsWith(".ts") || lower.endsWith(".tsx")) return "typescript";
  if (lower.endsWith(".js") || lower.endsWith(".jsx") || lower.endsWith(".mjs") || lower.endsWith(".cjs")) return "javascript";
  if (lower.endsWith(".py")) return "python";
  if (lower.endsWith(".rb")) return "ruby";
  if (lower.endsWith(".go")) return "go";
  if (lower.endsWith(".rs")) return "rust";
  if (lower.endsWith(".java")) return "java";
  if (lower.endsWith(".sql")) return "sql";
  if (lower.endsWith(".html") || lower.endsWith(".htm")) return "html";
  if (lower.endsWith(".css")) return "css";
  if (lower.endsWith(".scss") || lower.endsWith(".sass")) return "scss";
  if (lower.endsWith(".xml") || lower.endsWith(".svg")) return "xml";
  if (lower.endsWith(".csv") || lower.endsWith(".tsv")) return "plaintext";
  return "plaintext";
}

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
  // Folder-create dialog (kept simple — just a name field). `parentPath` is
  // "" for the root.
  const [creatingFolder, setCreatingFolder] = useState<
    null | { parentPath: string }
  >(null);
  const [createName, setCreateName] = useState("");
  // File create-or-edit editor state. `mode: "new"` opens a blank Monaco
  // panel with a name input; the file is POSTed at save time. `mode: "edit"`
  // loads existing content over HTTP and PUTs the result on save. Either way
  // it's the same Dialog so users don't have to learn two UIs.
  type EditorState =
    | {
        mode: "new";
        parentPath: string;
        name: string;
        content: string;
        saving: boolean;
      }
    | {
        mode: "edit";
        path: string;
        content: string;
        originalContent: string;
        loading: boolean;
        saving: boolean;
        loadError: string | null;
      };
  const [editor, setEditor] = useState<EditorState | null>(null);
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

  function startUpload(kind: "files" | "folder", destPath = "") {
    setUploadKind(kind);
    setUploadDest(destPath);
    setPendingFiles([]);
  }

  function startCreate(kind: "folder" | "file", parentPath: string) {
    if (kind === "folder") {
      setCreatingFolder({ parentPath });
      setCreateName("");
      return;
    }
    setEditor({
      mode: "new",
      parentPath,
      name: "",
      content: "",
      saving: false,
    });
  }

  async function startEdit(entry: TreeEntry) {
    if (entry.kind !== "file") return;
    if (!isEditablePath(entry.path)) {
      toast.error(
        "This file isn't editable in the browser — try Download, or open it in the VS Code tunnel."
      );
      return;
    }
    // Open the editor immediately with a loading state, fetch content in
    // parallel. Good UX even on slow networks — Monaco mounts while we wait.
    setEditor({
      mode: "edit",
      path: entry.path,
      content: "",
      originalContent: "",
      loading: true,
      saving: false,
      loadError: null,
    });
    try {
      const res = await fetch(
        `/api/workspaces/${workspaceId}/envs/${envId}/context/file/text?` +
          new URLSearchParams({ path: entry.path }).toString()
      );
      if (!res.ok) {
        const msg = await res.text().catch(() => "");
        let parsed: string | null = null;
        try {
          parsed = (JSON.parse(msg) as { message?: string }).message ?? null;
        } catch {
          // not JSON, fall through
        }
        setEditor((prev) =>
          prev && prev.mode === "edit"
            ? { ...prev, loading: false, loadError: parsed || msg || "Failed to load file" }
            : prev
        );
        return;
      }
      const data = (await res.json()) as { content: string; size: number };
      setEditor((prev) =>
        prev && prev.mode === "edit"
          ? {
              ...prev,
              content: data.content,
              originalContent: data.content,
              loading: false,
            }
          : prev
      );
    } catch (err) {
      setEditor((prev) =>
        prev && prev.mode === "edit"
          ? { ...prev, loading: false, loadError: String(err) }
          : prev
      );
    }
  }

  async function submitCreateFolder() {
    if (!creatingFolder) return;
    const name = createName.trim().replace(/^\/+|\/+$/g, "");
    if (!name) {
      toast.error("Name is required");
      return;
    }
    if (name.includes("/") || name === "." || name === "..") {
      toast.error("Use the parent folder's button — names can't contain '/'");
      return;
    }
    const fullPath = creatingFolder.parentPath
      ? `${creatingFolder.parentPath}/${name}`
      : name;
    setBusy(true);
    try {
      const res = await fetch(
        `/api/workspaces/${workspaceId}/envs/${envId}/context/folder`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ path: fullPath }),
        }
      );
      if (!res.ok) {
        const msg = await res.text().catch(() => "");
        toast.error(msg || "Failed to create folder");
        return;
      }
      const json = (await res.json()) as TreeResponse;
      setTree(json.root);
      if (creatingFolder.parentPath) {
        setExpanded((prev) => ({ ...prev, [creatingFolder.parentPath]: true }));
      }
      toast.success(`Created folder ${fullPath}`);
      setCreatingFolder(null);
    } finally {
      setBusy(false);
    }
  }

  async function submitEditor() {
    if (!editor) return;
    if (editor.mode === "new") {
      const name = editor.name.trim().replace(/^\/+|\/+$/g, "");
      if (!name) {
        toast.error("Name is required");
        return;
      }
      if (name.includes("/") || name === "." || name === "..") {
        toast.error("Names can't contain '/'");
        return;
      }
      const fullPath = editor.parentPath ? `${editor.parentPath}/${name}` : name;
      setEditor({ ...editor, saving: true });
      try {
        const res = await fetch(
          `/api/workspaces/${workspaceId}/envs/${envId}/context/file`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ path: fullPath, content: editor.content }),
          }
        );
        if (!res.ok) {
          const msg = await res.text().catch(() => "");
          toast.error(msg || "Failed to create file");
          setEditor((prev) => (prev ? { ...prev, saving: false } : prev));
          return;
        }
        const json = (await res.json()) as TreeResponse;
        setTree(json.root);
        if (editor.parentPath) {
          setExpanded((prev) => ({ ...prev, [editor.parentPath]: true }));
        }
        toast.success(`Created ${fullPath}`);
        setEditor(null);
      } catch (err) {
        toast.error(String(err));
        setEditor((prev) => (prev ? { ...prev, saving: false } : prev));
      }
      return;
    }
    // mode === "edit"
    if (editor.loading) return;
    setEditor({ ...editor, saving: true });
    try {
      const res = await fetch(
        `/api/workspaces/${workspaceId}/envs/${envId}/context/file`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ path: editor.path, content: editor.content }),
        }
      );
      if (!res.ok) {
        const msg = await res.text().catch(() => "");
        toast.error(msg || "Failed to save");
        setEditor((prev) => (prev ? { ...prev, saving: false } : prev));
        return;
      }
      const json = (await res.json()) as TreeResponse;
      setTree(json.root);
      toast.success(`Saved ${editor.path}`);
      setEditor(null);
    } catch (err) {
      toast.error(String(err));
      setEditor((prev) => (prev ? { ...prev, saving: false } : prev));
    }
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
          {entry.kind === "folder" && (
            <>
              <Button
                size="icon"
                variant="ghost"
                className="size-7"
                onClick={() => startCreate("folder", entry.path)}
                title="New folder inside"
              >
                <FolderPlus className="size-3.5" />
              </Button>
              <Button
                size="icon"
                variant="ghost"
                className="size-7"
                onClick={() => startCreate("file", entry.path)}
                title="New file inside"
              >
                <FilePlus2 className="size-3.5" />
              </Button>
              <Button
                size="icon"
                variant="ghost"
                className="size-7"
                onClick={() => startUpload("files", entry.path)}
                title="Upload into this folder"
              >
                <Upload className="size-3.5" />
              </Button>
            </>
          )}
          {entry.kind === "file" && isEditablePath(entry.path) && (
            <Button
              size="icon"
              variant="ghost"
              className="size-7"
              onClick={() => void startEdit(entry)}
              title="Edit"
            >
              <Code2 className="size-3.5" />
            </Button>
          )}
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
        <div className="flex items-center gap-1 flex-wrap">
          <Button
            size="sm"
            variant="outline"
            onClick={() => startCreate("folder", "")}
            title="Create an empty folder at the extracontext/ root"
          >
            <FolderPlus className="size-4" />
            New folder
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => startCreate("file", "")}
            title="Create a new file at the extracontext/ root"
          >
            <Plus className="size-4" />
            New file
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => startUpload("folder")}
          >
            <Upload className="size-4" />
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

      {/* Folder-create dialog — stays a simple name field. */}
      <Dialog
        open={!!creatingFolder}
        onOpenChange={(v) => !v && setCreatingFolder(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>New folder</DialogTitle>
            <DialogDescription>
              {creatingFolder?.parentPath ? (
                <>
                  Will be created inside <code>{creatingFolder.parentPath}</code>.
                </>
              ) : (
                <>
                  Will be created at the root of <code>extracontext/</code>.
                </>
              )}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2 mt-2">
            <Input
              autoFocus
              placeholder="folder-name"
              value={createName}
              onChange={(e) => setCreateName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void submitCreateFolder();
              }}
              disabled={busy}
            />
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setCreatingFolder(null)}
              disabled={busy}
            >
              Cancel
            </Button>
            <Button
              onClick={() => void submitCreateFolder()}
              disabled={busy || !createName.trim()}
            >
              {busy ? "Creating…" : "Create"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* File create-or-edit dialog — full Monaco editor. */}
      <Dialog
        open={!!editor}
        onOpenChange={(v) => {
          if (v) return;
          // Guard unsaved edits: confirm before tossing a dirty buffer.
          if (
            editor &&
            editor.mode === "edit" &&
            !editor.saving &&
            editor.content !== editor.originalContent
          ) {
            if (
              !window.confirm("Discard unsaved changes?")
            ) {
              return;
            }
          }
          setEditor(null);
        }}
      >
        <DialogContent className="max-w-4xl w-[min(96vw,1100px)] p-0 gap-0 flex flex-col h-[min(85vh,800px)]">
          <DialogHeader className="px-5 pt-4 pb-3 border-b border-border/60 shrink-0">
            <DialogTitle className="font-mono text-sm">
              {editor?.mode === "new"
                ? `New file${editor.parentPath ? ` in ${editor.parentPath}` : ""}`
                : `Edit ${editor?.path ?? ""}`}
            </DialogTitle>
            <DialogDescription className="text-[11px] text-muted-foreground">
              {editor?.mode === "new" ? (
                <>
                  Saved under <code>extracontext/</code>. Cmd/Ctrl-S to save.
                </>
              ) : (
                <>
                  Cmd/Ctrl-S to save. Changes mirror to the env clone so the
                  agent sees them immediately.
                </>
              )}
            </DialogDescription>
          </DialogHeader>

          {editor?.mode === "new" && (
            <div className="px-5 py-3 border-b border-border/60 shrink-0">
              <Input
                autoFocus
                placeholder="file.md"
                value={editor.name}
                onChange={(e) =>
                  setEditor((prev) =>
                    prev && prev.mode === "new"
                      ? { ...prev, name: e.target.value }
                      : prev
                  )
                }
                disabled={editor.saving}
                className="font-mono"
              />
            </div>
          )}

          <div
            className="flex-1 min-h-0"
            onKeyDown={(e) => {
              // Cmd/Ctrl-S → save without leaving the editor.
              if ((e.metaKey || e.ctrlKey) && e.key === "s") {
                e.preventDefault();
                void submitEditor();
              }
            }}
          >
            {editor && editor.mode === "edit" && editor.loadError ? (
              <div className="h-full flex items-center justify-center text-xs text-destructive p-6 text-center">
                {editor.loadError}
              </div>
            ) : editor && editor.mode === "edit" && editor.loading ? (
              <div className="h-full flex items-center justify-center text-xs text-muted-foreground">
                <Loader2 className="size-4 animate-spin mr-2" />
                Loading file…
              </div>
            ) : editor ? (
              <MonacoEditor
                height="100%"
                language={monacoLanguageForPath(
                  editor.mode === "new"
                    ? editor.name || "untitled.txt"
                    : editor.path
                )}
                value={editor.content}
                onChange={(v) =>
                  setEditor((prev) =>
                    prev
                      ? prev.mode === "new"
                        ? { ...prev, content: v ?? "" }
                        : { ...prev, content: v ?? "" }
                      : prev
                  )
                }
                options={{
                  minimap: { enabled: false },
                  fontSize: 12,
                  scrollBeyondLastLine: false,
                  wordWrap: "on",
                  tabSize: 2,
                  readOnly: editor.mode === "edit" && editor.loading,
                }}
                theme="vs-dark"
              />
            ) : null}
          </div>

          <DialogFooter className="px-5 py-3 border-t border-border/60 shrink-0">
            <div className="flex-1 text-[11px] text-muted-foreground">
              {editor?.mode === "edit" &&
              editor.content !== editor.originalContent
                ? "● Unsaved changes"
                : null}
            </div>
            <Button
              variant="outline"
              onClick={() => setEditor(null)}
              disabled={editor?.saving}
            >
              Cancel
            </Button>
            <Button
              onClick={() => void submitEditor()}
              disabled={
                !editor ||
                editor.saving ||
                (editor.mode === "new" && !editor.name.trim()) ||
                (editor.mode === "edit" &&
                  (editor.loading ||
                    editor.content === editor.originalContent))
              }
            >
              {editor?.saving
                ? "Saving…"
                : editor?.mode === "new"
                  ? "Create"
                  : "Save"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import dynamic from "next/dynamic";
import {
  ChevronDown,
  ChevronRight,
  File,
  FilePlus,
  Folder,
  FolderOpen,
  FolderPlus,
  FolderUp,
  Pencil,
  Trash2,
  Upload,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import type { EditorAsset } from "./template-editor";

// Monaco loads its own worker bundle in the browser; avoid SSR.
const MonacoEditor = dynamic(
  () => import("@monaco-editor/react").then((m) => m.default),
  { ssr: false, loading: () => <div className="text-xs text-muted-foreground p-2">Loading editor…</div> }
);

type Props = {
  assets: EditorAsset[];
  onChange: (next: EditorAsset[]) => void;
  /**
   * "embedded" hides the built-in editor column and emits selection events
   * upward — used when the tree lives in the IDE sidebar and the actual file
   * is edited in a Monaco tab elsewhere. "standalone" (default) shows the
   * tree + editor side-by-side, the original behavior.
   */
  variant?: "standalone" | "embedded";
  /** Controlled selection — when set, the tree highlights this path. */
  selectedPath?: string | null;
  /** Fires whenever a file row is clicked in embedded mode. */
  onSelectFile?: (path: string) => void;
};

type TreeNode =
  | { kind: "folder"; name: string; path: string; children: TreeNode[] }
  | { kind: "file"; name: string; path: string; asset: EditorAsset };

function joinPath(a: string, b: string) {
  if (!a) return b;
  if (!b) return a;
  return `${a}/${b}`;
}

function dirname(p: string) {
  const i = p.lastIndexOf("/");
  return i === -1 ? "" : p.slice(0, i);
}

function basename(p: string) {
  const i = p.lastIndexOf("/");
  return i === -1 ? p : p.slice(i + 1);
}

function buildTree(
  assets: EditorAsset[],
  ephemeralFolders: string[]
): TreeNode {
  const root: TreeNode = { kind: "folder", name: "", path: "", children: [] };

  function ensureFolder(folderPath: string): TreeNode {
    if (!folderPath) return root;
    const parts = folderPath.split("/");
    let node = root;
    let acc = "";
    for (const part of parts) {
      acc = acc ? `${acc}/${part}` : part;
      if (node.kind !== "folder") {
        // shouldn't happen — guard against malformed paths
        return root;
      }
      let child = node.children.find(
        (c) => c.kind === "folder" && c.name === part
      );
      if (!child) {
        child = { kind: "folder", name: part, path: acc, children: [] };
        node.children.push(child);
      }
      node = child;
    }
    return node;
  }

  for (const folder of ephemeralFolders) ensureFolder(folder);

  for (const a of assets) {
    const parent = ensureFolder(dirname(a.path));
    if (parent.kind !== "folder") continue;
    parent.children.push({
      kind: "file",
      name: basename(a.path),
      path: a.path,
      asset: a,
    });
  }

  function sortRec(n: TreeNode) {
    if (n.kind !== "folder") return;
    n.children.sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === "folder" ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    for (const c of n.children) sortRec(c);
  }
  sortRec(root);

  return root;
}

function languageForPath(path: string): string {
  const lower = path.toLowerCase();
  const base = basename(lower);
  if (base === "dockerfile" || base.startsWith("dockerfile.")) return "dockerfile";
  if (base === ".env" || base.startsWith(".env.")) return "ini";
  if (lower.endsWith(".yml") || lower.endsWith(".yaml")) return "yaml";
  if (lower.endsWith(".json")) return "json";
  if (lower.endsWith(".sh") || lower.endsWith(".bash")) return "shell";
  if (lower.endsWith(".toml") || lower.endsWith(".ini")) return "ini";
  if (lower.endsWith(".md")) return "markdown";
  if (lower.endsWith(".ts") || lower.endsWith(".tsx")) return "typescript";
  if (lower.endsWith(".js") || lower.endsWith(".jsx")) return "javascript";
  if (lower.endsWith(".py")) return "python";
  if (lower.endsWith(".sql")) return "sql";
  if (lower.endsWith(".html")) return "html";
  if (lower.endsWith(".css")) return "css";
  if (lower.endsWith(".conf")) return "ini";
  return "plaintext";
}

const NAME_RE = /^[A-Za-z0-9._-][A-Za-z0-9._\- ]{0,254}$/;

function validateName(name: string): string | null {
  const n = name.trim();
  if (!n) return "Name can't be empty";
  if (n === "." || n === "..") return `"${n}" is not allowed`;
  if (n.includes("/")) return "Name can't contain '/'";
  if (!NAME_RE.test(n)) return "Invalid characters in name";
  return null;
}

export function AssetTree({
  assets,
  onChange,
  variant = "standalone",
  selectedPath,
  onSelectFile,
}: Props) {
  const embedded = variant === "embedded";
  const [ephemeralFolders, setEphemeralFolders] = useState<string[]>([]);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set([""]));
  // Internal selection only matters in standalone mode. In embedded mode the
  // parent owns selection via `selectedPath`.
  const [internalSelectedFile, setInternalSelectedFile] = useState<string | null>(
    null
  );
  const selectedFile = embedded
    ? selectedPath ?? null
    : internalSelectedFile;
  const setSelectedFile = (path: string | null) => {
    if (embedded) {
      if (path) onSelectFile?.(path);
    } else {
      setInternalSelectedFile(path);
    }
  };
  const [selectedFolder, setSelectedFolder] = useState<string>("");
  const [renaming, setRenaming] = useState<{
    path: string;
    kind: "file" | "folder";
  } | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [creating, setCreating] = useState<{
    parent: string;
    kind: "file" | "folder";
  } | null>(null);
  const [createValue, setCreateValue] = useState("");
  const filesInputRef = useRef<HTMLInputElement>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);

  // Set folder-mode attributes imperatively — JSX forwards `webkitdirectory=""`
  // inconsistently across React/Next versions, which silently drops us back
  // to the file picker.
  useEffect(() => {
    const el = folderInputRef.current;
    if (!el) return;
    el.setAttribute("webkitdirectory", "");
    el.setAttribute("directory", "");
  }, []);

  const tree = useMemo(
    () => buildTree(assets, ephemeralFolders),
    [assets, ephemeralFolders]
  );

  const selectedAsset = selectedFile
    ? assets.find((a) => a.path === selectedFile) ?? null
    : null;

  function toggleExpand(path: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }

  function expandAncestors(path: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      next.add("");
      const parts = path.split("/");
      let acc = "";
      for (const p of parts.slice(0, -1)) {
        acc = acc ? `${acc}/${p}` : p;
        next.add(acc);
      }
      return next;
    });
  }

  // Returns true if path1 is path2 or a descendant of it.
  function isDescendantOf(path1: string, path2: string) {
    if (!path2) return true; // everything is under root
    return path1 === path2 || path1.startsWith(`${path2}/`);
  }

  function pathExists(p: string): boolean {
    if (assets.some((a) => a.path === p)) return true;
    if (ephemeralFolders.some((f) => f === p || f.startsWith(`${p}/`))) return true;
    if (assets.some((a) => a.path.startsWith(`${p}/`))) return true;
    return false;
  }

  function createFile(parent: string, name: string) {
    const err = validateName(name);
    if (err) {
      toast.error(err);
      return;
    }
    const path = joinPath(parent, name.trim());
    if (pathExists(path)) {
      toast.error(`"${name}" already exists`);
      return;
    }
    onChange([...assets, { path, content: "", isTemplate: false }]);
    setEphemeralFolders((prev) => prev.filter((f) => f !== parent));
    setSelectedFile(path);
    expandAncestors(path);
  }

  function createFolder(parent: string, name: string) {
    const err = validateName(name);
    if (err) {
      toast.error(err);
      return;
    }
    const path = joinPath(parent, name.trim());
    if (pathExists(path)) {
      toast.error(`"${name}" already exists`);
      return;
    }
    setEphemeralFolders((prev) => [...prev, path]);
    setSelectedFolder(path);
    expandAncestors(joinPath(path, "x")); // expand all ancestors of path itself
  }

  function deleteFile(path: string) {
    onChange(assets.filter((a) => a.path !== path));
    if (selectedFile === path) setSelectedFile(null);
  }

  function deleteFolder(path: string) {
    onChange(assets.filter((a) => !isDescendantOf(a.path, path)));
    setEphemeralFolders((prev) =>
      prev.filter((f) => !isDescendantOf(f, path))
    );
    if (selectedFile && isDescendantOf(selectedFile, path)) {
      setSelectedFile(null);
    }
    if (isDescendantOf(selectedFolder, path)) setSelectedFolder("");
  }

  function renameFile(oldPath: string, newName: string) {
    const err = validateName(newName);
    if (err) {
      toast.error(err);
      return;
    }
    const newPath = joinPath(dirname(oldPath), newName.trim());
    if (newPath === oldPath) return;
    if (pathExists(newPath)) {
      toast.error(`"${newName}" already exists`);
      return;
    }
    onChange(
      assets.map((a) => (a.path === oldPath ? { ...a, path: newPath } : a))
    );
    if (selectedFile === oldPath) setSelectedFile(newPath);
  }

  function renameFolder(oldPath: string, newName: string) {
    const err = validateName(newName);
    if (err) {
      toast.error(err);
      return;
    }
    const newPath = joinPath(dirname(oldPath), newName.trim());
    if (newPath === oldPath) return;
    if (pathExists(newPath)) {
      toast.error(`"${newName}" already exists`);
      return;
    }
    onChange(
      assets.map((a) =>
        isDescendantOf(a.path, oldPath)
          ? { ...a, path: newPath + a.path.slice(oldPath.length) }
          : a
      )
    );
    setEphemeralFolders((prev) =>
      prev.map((f) =>
        isDescendantOf(f, oldPath) ? newPath + f.slice(oldPath.length) : f
      )
    );
    if (selectedFile && isDescendantOf(selectedFile, oldPath)) {
      setSelectedFile(newPath + selectedFile.slice(oldPath.length));
    }
    if (isDescendantOf(selectedFolder, oldPath)) {
      setSelectedFolder(newPath + selectedFolder.slice(oldPath.length));
    }
  }

  function moveTo(sourcePath: string, sourceKind: "file" | "folder", destFolder: string) {
    if (sourceKind === "folder" && isDescendantOf(destFolder, sourcePath)) {
      toast.error("Can't move a folder into itself");
      return;
    }
    const newPath = joinPath(destFolder, basename(sourcePath));
    if (newPath === sourcePath) return;
    if (pathExists(newPath)) {
      toast.error(`"${basename(sourcePath)}" already exists in destination`);
      return;
    }
    if (sourceKind === "file") {
      onChange(
        assets.map((a) => (a.path === sourcePath ? { ...a, path: newPath } : a))
      );
      if (selectedFile === sourcePath) setSelectedFile(newPath);
    } else {
      onChange(
        assets.map((a) =>
          isDescendantOf(a.path, sourcePath)
            ? { ...a, path: newPath + a.path.slice(sourcePath.length) }
            : a
        )
      );
      setEphemeralFolders((prev) =>
        prev.map((f) =>
          isDescendantOf(f, sourcePath)
            ? newPath + f.slice(sourcePath.length)
            : f
        )
      );
      if (selectedFile && isDescendantOf(selectedFile, sourcePath)) {
        setSelectedFile(newPath + selectedFile.slice(sourcePath.length));
      }
    }
    expandAncestors(joinPath(newPath, "x"));
  }

  async function handleUpload(files: FileList | null) {
    if (!files || files.length === 0) return;
    const targetFolder = selectedFolder;
    const reads = Array.from(files).map(async (f) => {
      // webkitRelativePath includes the picked folder's name (e.g.
      // "myfolder/sub/file.sql"); we keep it so the user's folder structure
      // is preserved under the active target.
      const rel =
        (f as File & { webkitRelativePath?: string }).webkitRelativePath ||
        f.name;
      const path = joinPath(targetFolder, rel);
      const content = await f.text();
      return { path, content, isTemplate: false } satisfies EditorAsset;
    });
    const added = await Promise.all(reads);
    const byPath = new Map(assets.map((a) => [a.path, a]));
    for (const a of added) byPath.set(a.path, a);
    onChange(Array.from(byPath.values()));
    expandAncestors(joinPath(targetFolder, "x"));
  }

  function updateSelectedAsset(patch: Partial<EditorAsset>) {
    if (!selectedAsset) return;
    onChange(
      assets.map((a) => (a.path === selectedAsset.path ? { ...a, ...patch } : a))
    );
  }

  // Embedded variant collapses to a single column (just the tree), removes
  // the wrapper border (the sidebar already has its own), and lets the parent
  // size the height. Standalone keeps the original two-column UI.
  return (
    <div
      className={
        embedded
          ? "flex flex-col"
          : "grid gap-3 sm:grid-cols-[260px_1fr] rounded-md border"
      }
    >
      <div
        className={
          embedded
            ? "flex flex-col"
            : "border-r min-h-[400px] flex flex-col"
        }
      >
        <div className="flex items-center justify-between gap-1 px-2 py-2 border-b">
          <span className="text-xs font-mono text-muted-foreground">
            {selectedFolder ? selectedFolder + "/" : "/"}
          </span>
          <div className="flex gap-1">
            <Button
              type="button"
              variant="ghost"
              size="icon"
              title="New file"
              onClick={() => {
                setCreating({ parent: selectedFolder, kind: "file" });
                setCreateValue("");
                expandAncestors(joinPath(selectedFolder, "x"));
                setExpanded((prev) => new Set(prev).add(selectedFolder));
              }}
            >
              <FilePlus className="size-4" />
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              title="New folder"
              onClick={() => {
                setCreating({ parent: selectedFolder, kind: "folder" });
                setCreateValue("");
                expandAncestors(joinPath(selectedFolder, "x"));
                setExpanded((prev) => new Set(prev).add(selectedFolder));
              }}
            >
              <FolderPlus className="size-4" />
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              title="Upload files into this folder"
              onClick={() => filesInputRef.current?.click()}
            >
              <Upload className="size-4" />
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              title="Upload a folder (preserves the folder structure)"
              onClick={() => folderInputRef.current?.click()}
            >
              <FolderUp className="size-4" />
            </Button>
          </div>
        </div>
        <input
          ref={filesInputRef}
          type="file"
          multiple
          className="hidden"
          onChange={(e) => {
            void handleUpload(e.target.files);
            e.target.value = "";
          }}
        />
        <input
          ref={folderInputRef}
          type="file"
          multiple
          className="hidden"
          onChange={(e) => {
            void handleUpload(e.target.files);
            e.target.value = "";
          }}
        />
        <div
          className="flex-1 overflow-auto p-1 text-sm"
          onClick={(e) => {
            // click on empty area selects root
            if (e.target === e.currentTarget) setSelectedFolder("");
          }}
          onDragOver={(e) => {
            e.preventDefault();
            e.dataTransfer.dropEffect = "move";
          }}
          onDrop={(e) => {
            e.preventDefault();
            const data = e.dataTransfer.getData("application/x-asset-path");
            const kind = e.dataTransfer.getData(
              "application/x-asset-kind"
            ) as "file" | "folder";
            if (!data || !kind) return;
            moveTo(data, kind, "");
          }}
        >
          <TreeFolderChildren
            node={tree}
            depth={0}
            expanded={expanded}
            selectedFile={selectedFile}
            selectedFolder={selectedFolder}
            renaming={renaming}
            renameValue={renameValue}
            setRenameValue={setRenameValue}
            creating={creating}
            createValue={createValue}
            setCreateValue={setCreateValue}
            onSelectFile={(p) => {
              setSelectedFile(p);
              setSelectedFolder(dirname(p));
            }}
            onSelectFolder={(p) => setSelectedFolder(p)}
            onToggleExpand={toggleExpand}
            onStartRename={(path, kind, name) => {
              setRenaming({ path, kind });
              setRenameValue(name);
            }}
            onCommitRename={(path, kind) => {
              const name = renameValue;
              setRenaming(null);
              setRenameValue("");
              if (kind === "file") renameFile(path, name);
              else renameFolder(path, name);
            }}
            onCancelRename={() => {
              setRenaming(null);
              setRenameValue("");
            }}
            onCommitCreate={() => {
              if (!creating) return;
              const { parent, kind } = creating;
              const name = createValue;
              setCreating(null);
              setCreateValue("");
              if (kind === "file") createFile(parent, name);
              else createFolder(parent, name);
            }}
            onCancelCreate={() => {
              setCreating(null);
              setCreateValue("");
            }}
            onDeleteFile={deleteFile}
            onDeleteFolder={deleteFolder}
            onStartCreate={(parent, kind) => {
              setCreating({ parent, kind });
              setCreateValue("");
              setExpanded((prev) => new Set(prev).add(parent));
            }}
            onMove={moveTo}
          />
        </div>
      </div>

      {/* Right pane — editor. Hidden in embedded mode; the parent renders
          the file in its own Monaco tab. */}
      {!embedded && (
      <div className="min-h-[400px] flex flex-col">
        {selectedAsset ? (
          <>
            <div className="flex items-center justify-between gap-2 px-3 py-2 border-b">
              <code className="font-mono text-xs truncate">
                {selectedAsset.path}
              </code>
              <div className="flex items-center gap-2">
                <Checkbox
                  id="asset-interpolate"
                  checked={selectedAsset.isTemplate}
                  onCheckedChange={(c) =>
                    updateSelectedAsset({ isTemplate: c === true })
                  }
                />
                <Label
                  htmlFor="asset-interpolate"
                  className="text-xs cursor-pointer"
                >
                  Interpolate{" "}
                  <code className="font-mono">{"${VAR}"}</code>
                </Label>
              </div>
            </div>
            <div className="flex-1 min-h-[360px]">
              <MonacoEditor
                height="100%"
                language={languageForPath(selectedAsset.path)}
                value={selectedAsset.content}
                onChange={(v) =>
                  updateSelectedAsset({ content: v ?? "" })
                }
                options={{
                  minimap: { enabled: false },
                  fontSize: 12,
                  scrollBeyondLastLine: false,
                  wordWrap: "on",
                  tabSize: 2,
                }}
                theme="vs-dark"
              />
            </div>
          </>
        ) : (
          <div className="flex-1 flex items-center justify-center text-xs text-muted-foreground p-6 text-center">
            <div className="space-y-2">
              <p>Select a file to edit, or create one with the buttons above.</p>
              <p>
                Drag files between folders to reorganize. Drop onto empty space
                to move to root.
              </p>
            </div>
          </div>
        )}
      </div>
      )}
    </div>
  );
}

type TreeChildrenProps = {
  node: TreeNode;
  depth: number;
  expanded: Set<string>;
  selectedFile: string | null;
  selectedFolder: string;
  renaming: { path: string; kind: "file" | "folder" } | null;
  renameValue: string;
  setRenameValue: (v: string) => void;
  creating: { parent: string; kind: "file" | "folder" } | null;
  createValue: string;
  setCreateValue: (v: string) => void;
  onSelectFile: (path: string) => void;
  onSelectFolder: (path: string) => void;
  onToggleExpand: (path: string) => void;
  onStartRename: (path: string, kind: "file" | "folder", name: string) => void;
  onCommitRename: (path: string, kind: "file" | "folder") => void;
  onCancelRename: () => void;
  onCommitCreate: () => void;
  onCancelCreate: () => void;
  onDeleteFile: (path: string) => void;
  onDeleteFolder: (path: string) => void;
  onStartCreate: (parent: string, kind: "file" | "folder") => void;
  onMove: (sourcePath: string, sourceKind: "file" | "folder", destFolder: string) => void;
};

function TreeFolderChildren(props: TreeChildrenProps) {
  if (props.node.kind !== "folder") return null;
  const showCreate =
    props.creating && props.creating.parent === props.node.path;
  return (
    <ul className="space-y-0.5">
      {props.node.children.map((child) =>
        child.kind === "folder" ? (
          <TreeFolderItem key={child.path} {...props} folder={child} />
        ) : (
          <TreeFileItem key={child.path} {...props} file={child} />
        )
      )}
      {showCreate && (
        <li
          style={{ paddingLeft: `${(props.depth + 1) * 12}px` }}
          className="py-0.5"
        >
          <div className="flex items-center gap-1">
            {props.creating!.kind === "folder" ? (
              <Folder className="size-4 shrink-0" />
            ) : (
              <File className="size-4 shrink-0" />
            )}
            <Input
              autoFocus
              value={props.createValue}
              onChange={(e) => props.setCreateValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  props.onCommitCreate();
                } else if (e.key === "Escape") {
                  props.onCancelCreate();
                }
              }}
              onBlur={() => props.onCommitCreate()}
              className="h-6 text-xs"
              placeholder={
                props.creating!.kind === "folder" ? "folder-name" : "file.ext"
              }
            />
          </div>
        </li>
      )}
    </ul>
  );
}

function TreeFolderItem(
  props: TreeChildrenProps & { folder: Extract<TreeNode, { kind: "folder" }> }
) {
  const { folder } = props;
  const isOpen = props.expanded.has(folder.path);
  const isSelected = props.selectedFolder === folder.path;
  const isRenaming =
    props.renaming?.path === folder.path && props.renaming.kind === "folder";
  return (
    <li>
      <div
        draggable={!isRenaming}
        onDragStart={(e) => {
          e.dataTransfer.setData("application/x-asset-path", folder.path);
          e.dataTransfer.setData("application/x-asset-kind", "folder");
          e.dataTransfer.effectAllowed = "move";
        }}
        onDragOver={(e) => {
          e.preventDefault();
          e.stopPropagation();
          e.dataTransfer.dropEffect = "move";
        }}
        onDrop={(e) => {
          e.preventDefault();
          e.stopPropagation();
          const sourcePath = e.dataTransfer.getData("application/x-asset-path");
          const sourceKind = e.dataTransfer.getData(
            "application/x-asset-kind"
          ) as "file" | "folder";
          if (!sourcePath || !sourceKind) return;
          props.onMove(sourcePath, sourceKind, folder.path);
        }}
        className={cn(
          "group flex items-center gap-1 rounded px-1 py-0.5 cursor-pointer hover:bg-accent",
          isSelected && "bg-accent"
        )}
        style={{ paddingLeft: `${props.depth * 12 + 4}px` }}
        onClick={(e) => {
          e.stopPropagation();
          props.onSelectFolder(folder.path);
          props.onToggleExpand(folder.path);
        }}
      >
        {isOpen ? (
          <ChevronDown className="size-3 shrink-0" />
        ) : (
          <ChevronRight className="size-3 shrink-0" />
        )}
        {isOpen ? (
          <FolderOpen className="size-4 shrink-0" />
        ) : (
          <Folder className="size-4 shrink-0" />
        )}
        {isRenaming ? (
          <Input
            autoFocus
            value={props.renameValue}
            onChange={(e) => props.setRenameValue(e.target.value)}
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === "Enter") {
                e.preventDefault();
                props.onCommitRename(folder.path, "folder");
              } else if (e.key === "Escape") {
                props.onCancelRename();
              }
            }}
            onBlur={() => props.onCommitRename(folder.path, "folder")}
            className="h-6 text-xs flex-1"
          />
        ) : (
          <span className="text-xs font-mono truncate flex-1">{folder.name}</span>
        )}
        {!isRenaming && (
          <div className="hidden group-hover:flex items-center gap-0.5">
            <button
              type="button"
              title="New file"
              className="p-0.5 hover:bg-background rounded"
              onClick={(e) => {
                e.stopPropagation();
                props.onStartCreate(folder.path, "file");
              }}
            >
              <FilePlus className="size-3" />
            </button>
            <button
              type="button"
              title="New folder"
              className="p-0.5 hover:bg-background rounded"
              onClick={(e) => {
                e.stopPropagation();
                props.onStartCreate(folder.path, "folder");
              }}
            >
              <FolderPlus className="size-3" />
            </button>
            <button
              type="button"
              title="Rename"
              className="p-0.5 hover:bg-background rounded"
              onClick={(e) => {
                e.stopPropagation();
                props.onStartRename(folder.path, "folder", folder.name);
              }}
            >
              <Pencil className="size-3" />
            </button>
            <button
              type="button"
              title="Delete"
              className="p-0.5 hover:bg-background rounded text-destructive"
              onClick={(e) => {
                e.stopPropagation();
                if (
                  confirm(
                    `Delete folder "${folder.path}" and everything in it?`
                  )
                ) {
                  props.onDeleteFolder(folder.path);
                }
              }}
            >
              <Trash2 className="size-3" />
            </button>
          </div>
        )}
      </div>
      {isOpen && (
        <TreeFolderChildren {...props} node={folder} depth={props.depth + 1} />
      )}
    </li>
  );
}

function TreeFileItem(
  props: TreeChildrenProps & { file: Extract<TreeNode, { kind: "file" }> }
) {
  const { file } = props;
  const isSelected = props.selectedFile === file.path;
  const isRenaming =
    props.renaming?.path === file.path && props.renaming.kind === "file";
  return (
    <li>
      <div
        draggable={!isRenaming}
        onDragStart={(e) => {
          e.dataTransfer.setData("application/x-asset-path", file.path);
          e.dataTransfer.setData("application/x-asset-kind", "file");
          e.dataTransfer.effectAllowed = "move";
        }}
        className={cn(
          "group flex items-center gap-1 rounded px-1 py-0.5 cursor-pointer hover:bg-accent",
          isSelected && "bg-accent"
        )}
        style={{ paddingLeft: `${props.depth * 12 + 4 + 12}px` }}
        onClick={(e) => {
          e.stopPropagation();
          props.onSelectFile(file.path);
        }}
      >
        <File className="size-4 shrink-0" />
        {isRenaming ? (
          <Input
            autoFocus
            value={props.renameValue}
            onChange={(e) => props.setRenameValue(e.target.value)}
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === "Enter") {
                e.preventDefault();
                props.onCommitRename(file.path, "file");
              } else if (e.key === "Escape") {
                props.onCancelRename();
              }
            }}
            onBlur={() => props.onCommitRename(file.path, "file")}
            className="h-6 text-xs flex-1"
          />
        ) : (
          <span className="text-xs font-mono truncate flex-1">{file.name}</span>
        )}
        {!isRenaming && (
          <div className="hidden group-hover:flex items-center gap-0.5">
            <button
              type="button"
              title="Rename"
              className="p-0.5 hover:bg-background rounded"
              onClick={(e) => {
                e.stopPropagation();
                props.onStartRename(file.path, "file", file.name);
              }}
            >
              <Pencil className="size-3" />
            </button>
            <button
              type="button"
              title="Delete"
              className="p-0.5 hover:bg-background rounded text-destructive"
              onClick={(e) => {
                e.stopPropagation();
                if (confirm(`Delete file "${file.path}"?`)) {
                  props.onDeleteFile(file.path);
                }
              }}
            >
              <Trash2 className="size-3" />
            </button>
          </div>
        )}
      </div>
    </li>
  );
}

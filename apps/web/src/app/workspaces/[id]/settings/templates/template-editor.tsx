"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import dynamic from "next/dynamic";
import { Plus, Sparkles, Trash2, Upload, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  AssistantPanel,
  type ApplyToolResult,
  type AssistantPanelHandle,
} from "./assistant-panel";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { RoutingModeFields, type RoutingMode } from "@/components/routing-mode-fields";
import { BranchAutocomplete } from "@/components/branch-autocomplete";
import { toast } from "sonner";
import { IdeShell } from "@/components/ide-shell";
import {
  SidebarNav,
  type SectionEntry,
  type SectionKey,
  type SectionStatus,
} from "./_components/sidebar-nav";
import { SidebarFiles, COMPOSE_PATH } from "./_components/sidebar-files";
import { FileTabs } from "./_components/file-tabs";
import { useDemoMode } from "../../_demo-mode";

// Monaco loads its own worker bundle in the browser; avoid SSR.
const MonacoEditor = dynamic(
  () => import("@monaco-editor/react").then((m) => m.default),
  {
    ssr: false,
    loading: () => (
      <div className="text-xs text-muted-foreground p-3">Loading editor…</div>
    ),
  }
);

export type TemplateVariableKind =
  | "system-port"
  | "user-input"
  | "secret"
  | "default"
  | "service-url";

export type EditorVariable = {
  key: string;
  kind: TemplateVariableKind;
  label?: string;
  description?: string;
  defaultValue?: string;
  required?: boolean;
  secretName?: string;
  service?: string;
  portKey?: string;
};

export type EditorAsset = {
  path: string;
  content: string;
  isTemplate: boolean;
};

export type EditorRepo = {
  id: string;
  baseBranch: string;
};

export type EditorService = {
  name: string;
  description: string;
  role: string;
  userFacing: boolean;
  agentInstructions: string;
};

export type TemplateEditorState = {
  slug: string;
  name: string;
  description: string;
  composeFile: string;
  variables: EditorVariable[];
  assets: EditorAsset[];
  repos: EditorRepo[];
  routingMode: RoutingMode;
  routingBaseDomain: string;
  qaBrowserMode: "sidecar" | "user_browser";
  agentInstructions: string;
  services: EditorService[];
};

// Extracts service names from a docker-compose YAML by scanning for keys
// directly under a top-level `services:` block. Intentionally light-weight —
// we only need the names, not a full YAML parse, and the editor stays usable
// even with malformed YAML in flight.
export function extractServiceNames(composeFile: string): string[] {
  const lines = composeFile.split(/\r?\n/);
  const names: string[] = [];
  let inServices = false;
  let baseIndent: number | null = null;
  for (const raw of lines) {
    if (!raw.trim() || raw.trim().startsWith("#")) continue;
    const indent = raw.match(/^[ \t]*/)?.[0].length ?? 0;
    if (!inServices) {
      if (/^services\s*:\s*$/.test(raw)) {
        inServices = true;
      }
      continue;
    }
    // Left the services block when we hit another top-level key
    if (indent === 0) {
      inServices = false;
      continue;
    }
    if (baseIndent === null) baseIndent = indent;
    if (indent !== baseIndent) continue;
    const m = raw.match(/^[ \t]+([A-Za-z0-9][A-Za-z0-9._-]*)\s*:\s*$/);
    if (m && !names.includes(m[1])) names.push(m[1]);
  }
  return names;
}

type WorkspaceRepo = { id: string; name: string };

const KIND_OPTIONS: { value: TemplateVariableKind; label: string; help: string }[] = [
  {
    value: "system-port",
    label: "System port",
    help: "Allocated automatically by the orchestrator. Unique per env.",
  },
  {
    value: "user-input",
    label: "User input",
    help: "Collected from the end-user on the create-env form.",
  },
  {
    value: "secret",
    label: "Secret",
    help: "Pulled from server-side env var (secretName).",
  },
  {
    value: "default",
    label: "Default",
    help: "Static value baked into the template.",
  },
  {
    value: "service-url",
    label: "Service URL",
    help: "Resolves to the full URL of another service in this env. Subdomain mode → http://<service>-<id>.<base>. Port mode → http://host:<portKey's value>.",
  },
];

export function TemplateEditor({
  workspaceId,
  mode,
  initial,
  templateId,
}: {
  workspaceId: string;
  mode: "create" | "edit";
  initial: TemplateEditorState;
  templateId?: string;
}) {
  const router = useRouter();
  const demoMode = useDemoMode();
  const [state, setState] = useState<TemplateEditorState>(initial);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [availableRepos, setAvailableRepos] = useState<WorkspaceRepo[] | null>(
    null
  );
  const [branchInfo, setBranchInfo] = useState<
    Record<string, { branches: string[]; defaultBranch: string | null }>
  >({});
  // The center pane shows either the active section's form OR the active
  // file's Monaco editor — never both. Picking a section clears activeFile;
  // opening a file clears activeSection. openFiles is the tab strip's order.
  const [activeSection, setActiveSection] = useState<SectionKey | null>("basics");
  const [openFiles, setOpenFiles] = useState<string[]>([]);
  const [activeFile, setActiveFile] = useState<string | null>(null);

  function selectSection(key: SectionKey) {
    setActiveSection(key);
    setActiveFile(null);
  }

  function openFile(path: string) {
    setActiveFile(path);
    setActiveSection(null);
    setOpenFiles((prev) => (prev.includes(path) ? prev : [...prev, path]));
  }

  function closeFile(path: string) {
    setOpenFiles((prev) => {
      const next = prev.filter((p) => p !== path);
      // If closing the active tab, jump to the neighbor on the right (or left
      // if it was the last tab). If no tabs remain, fall back to a section.
      if (path === activeFile) {
        if (next.length === 0) {
          setActiveFile(null);
          setActiveSection("basics");
        } else {
          const closedIdx = prev.indexOf(path);
          setActiveFile(next[Math.min(closedIdx, next.length - 1)]);
        }
      }
      return next;
    });
  }

  // Stable snapshot for the assistant panel — it reads the latest state on
  // every send without re-rendering when state changes.
  const stateRef = useRef(state);
  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  const assistantRef = useRef<AssistantPanelHandle>(null);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/workspaces/${workspaceId}/repos`)
      .then((r) => (r.ok ? r.json() : []))
      .then((d: WorkspaceRepo[]) => {
        if (!cancelled) setAvailableRepos(Array.isArray(d) ? d : []);
      })
      .catch(() => {
        if (!cancelled) setAvailableRepos([]);
      });
    return () => {
      cancelled = true;
    };
  }, [workspaceId]);

  // Branch suggestions for the per-repo base-branch fields. Best-effort: if
  // the repo's clone isn't ready (or the call fails) the field still works
  // as plain free-text, which is the point — a template may pin a branch
  // that doesn't exist yet.
  const loadBranches = useCallback(
    async (repoId: string) => {
      if (branchInfo[repoId]) return;
      setBranchInfo((prev) =>
        prev[repoId]
          ? prev
          : { ...prev, [repoId]: { branches: [], defaultBranch: null } }
      );
      try {
        const res = await fetch(
          `/api/workspaces/${workspaceId}/repos/${repoId}/branches`
        );
        if (!res.ok) return;
        const d = (await res.json()) as {
          branches: string[];
          defaultBranch: string | null;
        };
        setBranchInfo((prev) => ({
          ...prev,
          [repoId]: {
            branches: Array.isArray(d.branches) ? d.branches : [],
            defaultBranch: d.defaultBranch ?? null,
          },
        }));
      } catch {
        // keep the empty entry — field degrades to free-text
      }
    },
    [workspaceId, branchInfo]
  );

  // Preload suggestions for repos already attached to the template.
  const attachedRepoIdsKey = state.repos.map((r) => r.id).join(",");
  useEffect(() => {
    for (const r of state.repos) void loadBranches(r.id);
    // attachedRepoIdsKey captures membership changes without depending on the
    // array identity (which changes on every keystroke via setState).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attachedRepoIdsKey, loadBranches]);

  function setField<K extends keyof TemplateEditorState>(
    key: K,
    value: TemplateEditorState[K]
  ) {
    setState((prev) => ({ ...prev, [key]: value }));
  }

  // Keep the services list in sync with the compose YAML: add rows for
  // newly-declared services, drop rows for services that no longer exist.
  // User-entered description/role/userFacing/agentInstructions are preserved
  // for any service whose name persists. Done inline at edit time so we don't
  // need a useEffect that calls setState.
  function setComposeFile(composeFile: string) {
    setState((prev) => {
      const names = extractServiceNames(composeFile);
      const byName = new Map(prev.services.map((s) => [s.name, s]));
      const services: EditorService[] = names.map(
        (n) =>
          byName.get(n) ?? {
            name: n,
            description: "",
            role: "",
            userFacing: false,
            agentInstructions: "",
          }
      );
      return { ...prev, composeFile, services };
    });
  }

  function addVariable() {
    setState((prev) => ({
      ...prev,
      variables: [...prev.variables, { key: "", kind: "user-input" }],
    }));
  }

  function updateVariable(i: number, patch: Partial<EditorVariable>) {
    setState((prev) => ({
      ...prev,
      variables: prev.variables.map((v, j) => (j === i ? { ...v, ...patch } : v)),
    }));
  }

  function removeVariable(i: number) {
    setState((prev) => ({
      ...prev,
      variables: prev.variables.filter((_, j) => j !== i),
    }));
  }

  function updateService(name: string, patch: Partial<EditorService>) {
    setState((prev) => ({
      ...prev,
      services: prev.services.map((s) =>
        s.name === name ? { ...s, ...patch } : s
      ),
    }));
  }

  function toggleRepo(repoId: string, checked: boolean) {
    setState((prev) => {
      if (checked) {
        if (prev.repos.some((r) => r.id === repoId)) return prev;
        return {
          ...prev,
          repos: [...prev.repos, { id: repoId, baseBranch: "" }],
        };
      }
      return { ...prev, repos: prev.repos.filter((r) => r.id !== repoId) };
    });
  }

  function updateRepoBranch(repoId: string, branch: string) {
    setState((prev) => ({
      ...prev,
      repos: prev.repos.map((r) =>
        r.id === repoId ? { ...r, baseBranch: branch } : r
      ),
    }));
  }

  // Applies an assistant tool call to the editor state. Returns ok=false
  // with a reason if the call can't be applied (e.g. patch string not found,
  // duplicate variable key) so the assistant panel can mark the card failed.
  const applyToolCall = useCallback(
    (name: string, input: Record<string, unknown>): ApplyToolResult => {
      const str = (k: string) => {
        const v = input[k];
        return typeof v === "string" ? v : "";
      };
      const bool = (k: string) => input[k] === true;

      switch (name) {
        case "setComposeFile": {
          setComposeFile(str("content"));
          return { ok: true };
        }
        case "patchComposeFile": {
          const oldS = str("oldString");
          const newS = str("newString");
          if (!oldS) return { ok: false, error: "oldString is empty" };
          const current = stateRef.current.composeFile;
          const idx = current.indexOf(oldS);
          if (idx === -1)
            return { ok: false, error: "oldString not found in current compose" };
          if (current.indexOf(oldS, idx + 1) !== -1)
            return {
              ok: false,
              error: "oldString is not unique in the current compose",
            };
          setComposeFile(current.slice(0, idx) + newS + current.slice(idx + oldS.length));
          return { ok: true };
        }
        case "setAgentInstructions": {
          setField("agentInstructions", str("content"));
          return { ok: true };
        }
        case "addVariable": {
          const key = str("key").toUpperCase();
          if (!/^[A-Z][A-Z0-9_]*$/.test(key))
            return { ok: false, error: "key must be UPPER_SNAKE_CASE" };
          if (stateRef.current.variables.some((v) => v.key === key))
            return { ok: false, error: `Variable "${key}" already exists` };
          const kindRaw = str("kind");
          const allowed: TemplateVariableKind[] = [
            "system-port",
            "user-input",
            "secret",
            "default",
            "service-url",
          ];
          if (!allowed.includes(kindRaw as TemplateVariableKind))
            return { ok: false, error: `Invalid kind "${kindRaw}"` };
          const v: EditorVariable = {
            key,
            kind: kindRaw as TemplateVariableKind,
          };
          if (str("label")) v.label = str("label");
          if (str("description")) v.description = str("description");
          if (str("defaultValue")) v.defaultValue = str("defaultValue");
          if (bool("required")) v.required = true;
          if (str("secretName")) v.secretName = str("secretName");
          if (str("service")) v.service = str("service");
          if (str("portKey")) v.portKey = str("portKey").toUpperCase();
          setState((prev) => ({ ...prev, variables: [...prev.variables, v] }));
          return { ok: true };
        }
        case "updateVariable": {
          const key = str("key");
          const patch = (input.patch ?? {}) as Record<string, unknown>;
          if (!stateRef.current.variables.some((v) => v.key === key))
            return { ok: false, error: `Variable "${key}" not found` };
          setState((prev) => ({
            ...prev,
            variables: prev.variables.map((v) => {
              if (v.key !== key) return v;
              const next: EditorVariable = { ...v };
              for (const [pk, pv] of Object.entries(patch)) {
                if (pv === null) {
                  delete (next as Record<string, unknown>)[pk];
                } else if (typeof pv === "string" || typeof pv === "boolean") {
                  (next as Record<string, unknown>)[pk] = pv;
                }
              }
              return next;
            }),
          }));
          return { ok: true };
        }
        case "removeVariable": {
          const key = str("key");
          if (!stateRef.current.variables.some((v) => v.key === key))
            return { ok: false, error: `Variable "${key}" not found` };
          setState((prev) => ({
            ...prev,
            variables: prev.variables.filter((v) => v.key !== key),
          }));
          return { ok: true };
        }
        case "setService": {
          const svcName = str("name");
          if (!svcName) return { ok: false, error: "name is required" };
          const exists = stateRef.current.services.some(
            (s) => s.name === svcName
          );
          if (!exists) {
            return {
              ok: false,
              error: `Service "${svcName}" not found in compose. Add it to the compose file first.`,
            };
          }
          setState((prev) => ({
            ...prev,
            services: prev.services.map((s) =>
              s.name === svcName
                ? {
                    ...s,
                    description:
                      typeof input.description === "string"
                        ? str("description")
                        : s.description,
                    role: typeof input.role === "string" ? str("role") : s.role,
                    userFacing:
                      typeof input.userFacing === "boolean"
                        ? bool("userFacing")
                        : s.userFacing,
                    agentInstructions:
                      typeof input.agentInstructions === "string"
                        ? str("agentInstructions")
                        : s.agentInstructions,
                  }
                : s
            ),
          }));
          return { ok: true };
        }
        case "writeAsset": {
          const path = str("path").replace(/^\/+/, "");
          if (!path) return { ok: false, error: "path is required" };
          if (path.includes("..") || path.startsWith(".withvibe-"))
            return { ok: false, error: "Invalid asset path" };
          const content = str("content");
          const isTemplate = bool("isTemplate");
          setState((prev) => {
            const idx = prev.assets.findIndex((a) => a.path === path);
            if (idx === -1) {
              return {
                ...prev,
                assets: [...prev.assets, { path, content, isTemplate }],
              };
            }
            return {
              ...prev,
              assets: prev.assets.map((a, j) =>
                j === idx ? { ...a, content, isTemplate } : a
              ),
            };
          });
          return { ok: true };
        }
        case "removeAsset": {
          const path = str("path");
          if (!stateRef.current.assets.some((a) => a.path === path))
            return { ok: false, error: `Asset "${path}" not found` };
          setState((prev) => ({
            ...prev,
            assets: prev.assets.filter((a) => a.path !== path),
          }));
          return { ok: true };
        }
        default:
          return { ok: false, error: `Unknown tool "${name}"` };
      }
    },
    []
  );

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    // Demo mode: let visitors explore the template editor, but block saving
    // (the api rejects it too).
    if (demoMode) {
      setError(
        "This is a live demo — you can explore the template editor, but saving is disabled."
      );
      return;
    }
    setError("");
    setSubmitting(true);

    const payload = {
      slug: state.slug.trim(),
      name: state.name.trim(),
      description: state.description.trim() || null,
      composeFile: state.composeFile,
      variables: state.variables.map((v) => {
        const out: EditorVariable = { key: v.key.trim(), kind: v.kind };
        if (v.label?.trim()) out.label = v.label.trim();
        if (v.description?.trim()) out.description = v.description.trim();
        if (v.defaultValue !== undefined && v.defaultValue !== "")
          out.defaultValue = v.defaultValue;
        if (v.kind === "user-input" && v.required) out.required = true;
        if (v.kind === "secret" && v.secretName?.trim())
          out.secretName = v.secretName.trim();
        if (v.kind === "service-url") {
          if (v.service?.trim()) out.service = v.service.trim();
          if (v.portKey?.trim()) out.portKey = v.portKey.trim();
        }
        return out;
      }),
      assets: state.assets.map((a) => ({
        path: a.path,
        content: a.content,
        isTemplate: a.isTemplate,
      })),
      repos: state.repos.map((r) => ({
        id: r.id,
        baseBranch: r.baseBranch.trim() || null,
      })),
      routingMode: state.routingMode,
      routingBaseDomain:
        state.routingMode === "subdomain"
          ? state.routingBaseDomain.trim() || null
          : null,
      qaBrowserMode: state.qaBrowserMode,
      agentInstructions: state.agentInstructions.trim() || null,
      services: state.services
        .filter(
          (s) =>
            s.description.trim() ||
            s.role.trim() ||
            s.userFacing ||
            s.agentInstructions.trim()
        )
        .map((s) => {
          const out: {
            name: string;
            description?: string;
            role?: string;
            userFacing?: boolean;
            agentInstructions?: string;
          } = { name: s.name };
          if (s.description.trim()) out.description = s.description.trim();
          if (s.role.trim()) out.role = s.role.trim();
          if (s.userFacing) out.userFacing = true;
          if (s.agentInstructions.trim())
            out.agentInstructions = s.agentInstructions.trim();
          return out;
        }),
    };

    const url =
      mode === "create"
        ? `/api/workspaces/${workspaceId}/env-templates`
        : `/api/workspaces/${workspaceId}/env-templates/${templateId}`;
    const method = mode === "create" ? "POST" : "PATCH";
    const res = await fetch(url, {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    setSubmitting(false);
    if (!res.ok) {
      const d = await res.json().catch(() => ({}));
      setError(d.message || d.error || "Save failed");
      return;
    }
    toast.success(mode === "create" ? "Template created" : "Template saved");
    router.push(`/workspaces/${workspaceId}/settings/templates`);
    router.refresh();
  }

  // Section completion: drives the sidebar checkmarks. Compose + assets used
  // to be sections; they're files now and live in the sidebar's Files panel.
  const sections = useMemo<SectionEntry[]>(() => {
    const basicsStatus: SectionStatus =
      state.slug.trim() && state.name.trim() ? "complete" : "incomplete";
    const agentStatus: SectionStatus = state.agentInstructions.trim()
      ? "complete"
      : "optional";
    const servicesStatus: SectionStatus =
      state.services.length === 0 ? "optional" : "complete";
    const variablesStatus: SectionStatus =
      state.variables.length === 0
        ? "optional"
        : state.variables.some((v) => !v.key.trim())
          ? "warning"
          : "complete";
    const reposStatus: SectionStatus =
      state.repos.length === 0 ? "optional" : "complete";
    const runtimeOk =
      state.routingMode !== "subdomain" ||
      state.routingBaseDomain.trim().length > 0;
    const runtimeStatus: SectionStatus = runtimeOk ? "complete" : "warning";

    return [
      { key: "basics", label: "Basics", status: basicsStatus },
      { key: "agent", label: "Agent instructions", status: agentStatus },
      { key: "services", label: "Services", status: servicesStatus },
      { key: "variables", label: "Variables", status: variablesStatus },
      { key: "repos", label: "Repositories", status: reposStatus },
      { key: "runtime", label: "Routing & QA", status: runtimeStatus },
    ];
  }, [state]);

  return (
    <form onSubmit={submit}>
      <IdeShell
        header={
          <>
            <div className="flex-1 min-w-0">
              <div className="text-sm font-mono font-medium">
                {mode === "create" ? "New template" : "Edit template"}
                {state.name && (
                  <span className="text-muted-foreground"> — {state.name}</span>
                )}
              </div>
              <div className="text-xs text-muted-foreground truncate">
                Define the stack, the variables the orchestrator fills in, and
                any asset files.
              </div>
            </div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => router.back()}
            >
              Cancel
            </Button>
            <Button type="submit" size="sm" disabled={submitting}>
              {submitting
                ? "Saving…"
                : mode === "create"
                  ? "Create template"
                  : "Save changes"}
            </Button>
          </>
        }
        sidebar={
          <div className="flex flex-col gap-3 pb-3">
            <SidebarNav
              sections={sections}
              activeKey={activeSection}
              onSelect={selectSection}
            />
            <SidebarFiles
              assets={state.assets}
              onAssetsChange={(next) => setField("assets", next)}
              activeFile={activeFile}
              onOpenFile={openFile}
              composePresent={state.composeFile.trim().length > 0}
            />
          </div>
        }
        ai={
          <AssistantPanel
            ref={assistantRef}
            workspaceId={workspaceId}
            getState={() => stateRef.current}
            applyToolCall={applyToolCall}
            variant="inline"
          />
        }
        center={
          activeFile !== null ? (
            <FileView
              activeFile={activeFile}
              openFiles={openFiles}
              onActivate={openFile}
              onClose={closeFile}
              composeFile={state.composeFile}
              setComposeFile={setComposeFile}
              assets={state.assets}
              onAssetChange={(path, content) =>
                setField(
                  "assets",
                  state.assets.map((a) =>
                    a.path === path ? { ...a, content } : a
                  )
                )
              }
              onAssetInterpolateChange={(path, isTemplate) =>
                setField(
                  "assets",
                  state.assets.map((a) =>
                    a.path === path ? { ...a, isTemplate } : a
                  )
                )
              }
              mode={mode}
              error={error}
              onUploadCompose={() =>
                document.getElementById("tpl-compose-file")?.click()
              }
              onGenerateCompose={(description) =>
                assistantRef.current?.openWith({
                  prompt:
                    `Generate a docker-compose.yml and the matching variables, services notes, and any required asset files for the following stack:\n\n${description}\n\n` +
                    "Use the appropriate tools (setComposeFile, addVariable, setService, writeAsset). " +
                    "Pick port-based variables for any host ports (kind: system-port). Use service-url variables for inter-service URLs. " +
                    "Mark user-facing services. Keep the design minimal — only include services the user described.",
                  autoSend: true,
                })
              }
            >
              <input
                id="tpl-compose-file"
                type="file"
                accept=".yml,.yaml,application/yaml,text/yaml,text/plain"
                className="hidden"
                onChange={async (e) => {
                  const f = e.target.files?.[0];
                  e.target.value = "";
                  if (!f) return;
                  try {
                    const text = await f.text();
                    setComposeFile(text);
                    toast.success(`Loaded ${f.name}`);
                  } catch {
                    toast.error("Failed to read file");
                  }
                }}
              />
            </FileView>
          ) : (
          <div className="max-w-4xl mx-auto px-6 sm:px-8 py-6 space-y-6">
            {error && (
              <Alert variant="destructive">
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}

            {activeSection === "basics" && (
              <>
      <section className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor="slug">Slug</Label>
          <Input
            id="slug"
            required
            disabled={mode === "edit"}
            value={state.slug}
            onChange={(e) => setField("slug", e.target.value)}
            placeholder="my-stack"
            className="font-mono"
          />
          <p className="text-xs text-muted-foreground">
            URL-safe identifier. Cannot be changed after creation.
          </p>
        </div>
        <div className="space-y-2">
          <Label htmlFor="name">Name</Label>
          <Input
            id="name"
            required
            value={state.name}
            onChange={(e) => setField("name", e.target.value)}
            placeholder="My stack"
          />
        </div>
      </section>

      <div className="space-y-2">
        <Label htmlFor="description">Description</Label>
        <Textarea
          id="description"
          rows={2}
          value={state.description}
          onChange={(e) => setField("description", e.target.value)}
          placeholder="What this template spins up and when to pick it."
        />
      </div>
              </>
            )}

            {activeSection === "agent" && (
      <section className="space-y-3 rounded-md border p-4">
        <div>
          <h3 className="font-mono text-sm font-semibold">Agent instructions</h3>
          <p className="text-xs text-muted-foreground">
            Free-text guidance for the DevOps agent that materializes envs from
            this template. Use it to explain non-obvious choices, set tone for
            variable resolution, or call out things to avoid. Optional.
          </p>
        </div>
        <Textarea
          rows={4}
          value={state.agentInstructions}
          onChange={(e) => setField("agentInstructions", e.target.value)}
          className="text-xs h-32 resize-y overflow-auto [field-sizing:fixed]"
          placeholder={`e.g. "Prefer named volumes over bind mounts. Treat any *_URL variable as internal-only — do not expose it through subdomain routing."`}
        />
      </section>
            )}

            {activeSection === "services" && (
      <section className="space-y-3">
        <div className="flex items-start justify-between gap-2">
          <div>
            <h3 className="font-mono text-sm font-semibold">Services</h3>
            <p className="text-xs text-muted-foreground">
              Auto-detected from the compose YAML above. Describe each service so
              the DevOps agent (and future UI surfaces) know what it&apos;s for. All
              fields optional — leave blank to skip enrichment for a service.
            </p>
          </div>
          {state.services.length > 0 && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() =>
                assistantRef.current?.openWith({
                  prompt:
                    "Look at the current compose file and propose a description, role (e.g. frontend / backend / db / worker), and userFacing flag for each service. Use the setService tool for each. Skip services that are obvious infrastructure (e.g. nginx-proxy, traefik) unless they're user-facing.",
                  autoSend: true,
                })
              }
            >
              <Sparkles className="size-4" /> Ask DevOps
            </Button>
          )}
        </div>
        {state.services.length === 0 ? (
          <p className="text-xs text-muted-foreground italic">
            No services detected in the compose file yet.
          </p>
        ) : (
          <div className="space-y-3">
            {state.services.map((s) => (
              <div
                key={s.name}
                className="space-y-2 rounded-md border p-3"
              >
                <div className="flex items-center justify-between gap-2">
                  <code className="font-mono text-sm font-semibold">{s.name}</code>
                  <div className="flex items-center gap-2">
                    <Checkbox
                      id={`svc-userfacing-${s.name}`}
                      checked={s.userFacing}
                      onCheckedChange={(c) =>
                        updateService(s.name, { userFacing: c === true })
                      }
                    />
                    <Label
                      htmlFor={`svc-userfacing-${s.name}`}
                      className="text-xs cursor-pointer"
                    >
                      User-facing (humans open this in a browser)
                    </Label>
                  </div>
                </div>
                <div className="grid gap-2 sm:grid-cols-[1fr_1fr]">
                  <div className="space-y-1">
                    <Label className="text-xs">Role</Label>
                    <Input
                      value={s.role}
                      onChange={(e) =>
                        updateService(s.name, { role: e.target.value })
                      }
                      placeholder="frontend, backend, db, worker, …"
                    />
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs">Description</Label>
                    <Input
                      value={s.description}
                      onChange={(e) =>
                        updateService(s.name, { description: e.target.value })
                      }
                      placeholder="What this service does"
                    />
                  </div>
                </div>
                <div className="space-y-1">
                  <Label className="text-xs">Agent instructions (optional)</Label>
                  <Textarea
                    rows={2}
                    value={s.agentInstructions}
                    onChange={(e) =>
                      updateService(s.name, { agentInstructions: e.target.value })
                    }
                    className="text-xs h-20 resize-y overflow-auto [field-sizing:fixed]"
                    placeholder="Per-service guidance for the DevOps agent"
                  />
                </div>
              </div>
            ))}
          </div>
        )}
      </section>
            )}

            {activeSection === "runtime" && (
              <>
      <section className="space-y-3 rounded-md border p-4">
        <div>
          <h3 className="font-mono text-sm font-semibold">Routing</h3>
          <p className="text-xs text-muted-foreground">
            How envs created from this template publish their services. Locked
            in when an env is created — can&apos;t be changed per-env.
          </p>
        </div>
        <RoutingModeFields
          routingMode={state.routingMode}
          routingBaseDomain={state.routingBaseDomain}
          onChange={({ routingMode, routingBaseDomain }) =>
            setState((prev) => ({ ...prev, routingMode, routingBaseDomain }))
          }
        />
      </section>

      <section className="space-y-3 rounded-md border p-4">
        <div>
          <h3 className="font-mono text-sm font-semibold">QA browser</h3>
          <p className="text-xs text-muted-foreground">
            Which browser the QA agent drives for envs created from this
            template. Locked in at create time — users can&apos;t pick a
            different mode when they spin up an env from this template.
          </p>
        </div>
        <div className="space-y-2">
          <label className="flex items-start gap-2 text-xs cursor-pointer">
            <input
              type="radio"
              name="template-qa-browser-mode"
              value="sidecar"
              checked={state.qaBrowserMode === "sidecar"}
              onChange={() =>
                setState((prev) => ({ ...prev, qaBrowserMode: "sidecar" }))
              }
              className="mt-0.5"
            />
            <span>
              <span className="font-medium">Sidecar (default)</span> — runs a
              headed Chromium in a Docker container per env. Isolated, works
              for headless / scheduled runs, no extension required.
            </span>
          </label>
          <label className="flex items-start gap-2 text-xs cursor-pointer">
            <input
              type="radio"
              name="template-qa-browser-mode"
              value="user_browser"
              checked={state.qaBrowserMode === "user_browser"}
              onChange={() =>
                setState((prev) => ({
                  ...prev,
                  qaBrowserMode: "user_browser",
                }))
              }
              className="mt-0.5"
            />
            <span>
              <span className="font-medium">User browser</span> — drives the
              user&apos;s real Chrome via the WithVibe extension. Reuses real
              login state on staging, native rendering. Requires the user to
              have the extension installed and paired.
            </span>
          </label>
        </div>
      </section>
              </>
            )}

            {activeSection === "variables" && (
      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="font-mono text-sm font-semibold">Variables</h3>
            <p className="text-xs text-muted-foreground">
              Each variable becomes a line in the generated{" "}
              <code className="font-mono text-foreground">.env</code>.
            </p>
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={addVariable}
          >
            <Plus className="size-4" /> Add variable
          </Button>
        </div>
        {state.variables.length === 0 && (
          <p className="text-xs text-muted-foreground italic">
            No variables yet.
          </p>
        )}
        <div className="space-y-3">
          {state.variables.map((v, i) => (
            <div
              key={i}
              className="grid gap-2 rounded-md border p-3 sm:grid-cols-[1fr_1fr_1fr_auto]"
            >
              <div className="space-y-1">
                <Label className="text-xs">Key</Label>
                <Input
                  value={v.key}
                  onChange={(e) =>
                    updateVariable(i, { key: e.target.value.toUpperCase() })
                  }
                  placeholder="APP_PORT"
                  className="font-mono"
                />
              </div>
              <div className="space-y-1">
                <Label className="text-xs">Kind</Label>
                <Select
                  value={v.kind}
                  onValueChange={(value) =>
                    updateVariable(i, { kind: value as TemplateVariableKind })
                  }
                >
                  <SelectTrigger className="font-mono">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {KIND_OPTIONS.map((o) => (
                      <SelectItem key={o.value} value={o.value}>
                        {o.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-[10px] text-muted-foreground">
                  {KIND_OPTIONS.find((o) => o.value === v.kind)?.help}
                </p>
              </div>
              <div className="space-y-1">
                <Label className="text-xs">
                  {v.kind === "user-input"
                    ? "Label shown to user"
                    : v.kind === "secret"
                      ? "Secret env var name"
                      : v.kind === "service-url"
                        ? "Service name (compose)"
                        : "Default value"}
                </Label>
                {v.kind === "secret" ? (
                  <Input
                    value={v.secretName || ""}
                    onChange={(e) =>
                      updateVariable(i, { secretName: e.target.value })
                    }
                    placeholder={v.key || "OPENAI_API_KEY"}
                    className="font-mono"
                  />
                ) : v.kind === "user-input" ? (
                  <Input
                    value={v.label || ""}
                    onChange={(e) => updateVariable(i, { label: e.target.value })}
                    placeholder="e.g. Google Maps API Key"
                  />
                ) : v.kind === "service-url" ? (
                  <Input
                    value={v.service || ""}
                    onChange={(e) =>
                      updateVariable(i, { service: e.target.value })
                    }
                    placeholder="myservice"
                    className="font-mono"
                  />
                ) : (
                  <Input
                    value={v.defaultValue || ""}
                    onChange={(e) =>
                      updateVariable(i, { defaultValue: e.target.value })
                    }
                    className="font-mono"
                  />
                )}
              </div>
              <div className="flex items-end">
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  onClick={() => removeVariable(i)}
                  aria-label="Remove variable"
                >
                  <Trash2 className="size-4 text-destructive" />
                </Button>
              </div>
              {v.kind === "user-input" && (
                <div className="sm:col-span-3 grid gap-2 sm:grid-cols-2">
                  <div className="space-y-1">
                    <Label className="text-xs">
                      Default (shown pre-filled)
                    </Label>
                    <Input
                      value={v.defaultValue || ""}
                      onChange={(e) =>
                        updateVariable(i, { defaultValue: e.target.value })
                      }
                    />
                  </div>
                  <div className="flex items-end gap-2">
                    <Checkbox
                      id={`var-required-${i}`}
                      checked={!!v.required}
                      onCheckedChange={(c) =>
                        updateVariable(i, { required: c === true })
                      }
                    />
                    <Label
                      htmlFor={`var-required-${i}`}
                      className="text-xs cursor-pointer"
                    >
                      Required — env creation fails if missing and no default.
                    </Label>
                  </div>
                </div>
              )}
              {v.kind === "service-url" && (
                <div className="sm:col-span-3 space-y-1">
                  <Label className="text-xs">
                    Port-mode fallback: system-port variable key (optional)
                  </Label>
                  <Input
                    value={v.portKey || ""}
                    onChange={(e) =>
                      updateVariable(i, { portKey: e.target.value.toUpperCase() })
                    }
                    placeholder="BACKEND_PORT"
                    className="font-mono"
                  />
                  <p className="text-[10px] text-muted-foreground">
                    When this workspace uses port-based routing, the URL
                    resolves to{" "}
                    <code className="font-mono">
                      http://$PUBLIC_HOST:$&#123;portKey&#125;
                    </code>
                    . Leave blank if this template is subdomain-only.
                  </p>
                </div>
              )}
              <div className="sm:col-span-3">
                <Label className="text-xs">Description (for the DevOps agent)</Label>
                <Input
                  value={v.description || ""}
                  onChange={(e) =>
                    updateVariable(i, { description: e.target.value })
                  }
                  placeholder="What this variable means — the DevOps agent reads this to decide what value to bind."
                />
                <p className="text-[10px] text-muted-foreground mt-1">
                  Not shown to end-users. This is the context the DevOps agent
                  uses when resolving the variable for a new env.
                </p>
              </div>
            </div>
          ))}
        </div>
      </section>
            )}

            {activeSection === "repos" && (
      <section className="space-y-3">
        <div>
          <h3 className="font-mono text-sm font-semibold">Repositories</h3>
          <p className="text-xs text-muted-foreground">
            Repos selected here will be auto-attached to any env created from
            this template — the end-user won&apos;t pick them on the create-env
            form. Leave empty to let the end-user pick manually.
          </p>
        </div>
        {availableRepos === null ? (
          <p className="text-xs text-muted-foreground italic">Loading repos…</p>
        ) : availableRepos.length === 0 ? (
          <p className="text-xs text-muted-foreground italic">
            No repos in this workspace yet.
          </p>
        ) : (
          <div className="space-y-2">
            {(() => {
              const unselected = availableRepos.filter(
                (r) => !state.repos.some((sr) => sr.id === r.id)
              );
              return (
                <Select
                  value=""
                  onValueChange={(value) => {
                    if (value) toggleRepo(value, true);
                  }}
                  disabled={unselected.length === 0}
                >
                  <SelectTrigger>
                    <SelectValue
                      placeholder={
                        unselected.length === 0
                          ? "All repos already added"
                          : "Add a repository…"
                      }
                    />
                  </SelectTrigger>
                  <SelectContent>
                    {unselected.map((repo) => (
                      <SelectItem
                        key={repo.id}
                        value={repo.id}
                        className="font-mono"
                      >
                        {repo.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              );
            })()}
            {state.repos.length === 0 ? (
              <p className="text-xs text-muted-foreground italic">
                No repos selected.
              </p>
            ) : (
              <div className="space-y-2">
                {state.repos.map((selected) => {
                  const repo = availableRepos.find((r) => r.id === selected.id);
                  return (
                    <div
                      key={selected.id}
                      className="grid gap-2 rounded-md border p-3 sm:grid-cols-[1fr_1fr_auto] items-end"
                    >
                      <div className="space-y-1">
                        <Label className="text-xs">Repository</Label>
                        <div className="font-mono text-sm">
                          {repo?.name ?? selected.id}
                        </div>
                      </div>
                      <div className="space-y-1">
                        <Label className="text-xs">
                          Base branch (optional)
                        </Label>
                        <BranchAutocomplete
                          branches={
                            branchInfo[selected.id]?.branches || []
                          }
                          value={selected.baseBranch}
                          onValueChange={(v) =>
                            updateRepoBranch(selected.id, v)
                          }
                          defaultBranch={
                            branchInfo[selected.id]?.defaultBranch
                          }
                          placeholder="Repo default (e.g. main)"
                        />
                      </div>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        onClick={() => toggleRepo(selected.id, false)}
                        aria-label={`Remove ${repo?.name ?? selected.id}`}
                      >
                        <Trash2 className="size-4 text-destructive" />
                      </Button>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}
      </section>
            )}

          </div>
          )
        }
      />
    </form>
  );
}

/**
 * Center-pane file view: VS Code-style tab strip on top, the active file's
 * Monaco editor below, a per-file toolbar and status bar around the editor.
 * The compose file gets an Upload + Clear toolbar + the BlankStateGenerator
 * in `create` mode when the file is empty. Asset files get an Interpolate
 * toggle. The hidden compose <input> is forwarded via children so the parent
 * controls its onChange.
 */
function FileView({
  activeFile,
  openFiles,
  onActivate,
  onClose,
  composeFile,
  setComposeFile,
  assets,
  onAssetChange,
  onAssetInterpolateChange,
  mode,
  error,
  onUploadCompose,
  onGenerateCompose,
  children,
}: {
  activeFile: string;
  openFiles: string[];
  onActivate: (path: string) => void;
  onClose: (path: string) => void;
  composeFile: string;
  setComposeFile: (s: string) => void;
  assets: EditorAsset[];
  onAssetChange: (path: string, content: string) => void;
  onAssetInterpolateChange: (path: string, isTemplate: boolean) => void;
  mode: "create" | "edit";
  error: string;
  onUploadCompose: () => void;
  onGenerateCompose: (description: string) => void;
  children?: React.ReactNode;
}) {
  const isCompose = activeFile === COMPOSE_PATH;
  const asset = isCompose ? null : assets.find((a) => a.path === activeFile);

  return (
    <div className="h-full flex flex-col">
      {error && (
        <div className="shrink-0 border-b border-destructive/40 bg-destructive/10 px-4 py-2">
          <Alert variant="destructive" className="border-0 bg-transparent p-0">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        </div>
      )}

      <FileTabs
        openFiles={openFiles}
        activeFile={activeFile}
        onActivate={onActivate}
        onClose={onClose}
      />

      {/* Per-file toolbar */}
      <div className="shrink-0 flex items-center gap-2 border-b border-border/60 bg-card/30 px-3 py-1.5 text-xs">
        <code className="font-mono text-muted-foreground truncate">
          {isCompose ? "docker-compose.yml" : activeFile}
        </code>
        <div className="ml-auto flex items-center gap-1">
          {isCompose ? (
            <>
              {composeFile && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => setComposeFile("")}
                >
                  <X className="size-3.5" /> Clear
                </Button>
              )}
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={onUploadCompose}
              >
                <Upload className="size-3.5" /> Upload
              </Button>
            </>
          ) : asset ? (
            <label className="flex items-center gap-1.5 cursor-pointer">
              <Checkbox
                id="file-interpolate"
                checked={asset.isTemplate}
                onCheckedChange={(c) =>
                  onAssetInterpolateChange(asset.path, c === true)
                }
              />
              <span className="text-xs">
                Interpolate{" "}
                <code className="font-mono">{"${VAR}"}</code>
              </span>
            </label>
          ) : null}
        </div>
      </div>

      {/* Editor body */}
      {isCompose && mode === "create" && !composeFile.trim() ? (
        <div className="flex-1 min-h-0 grid grid-cols-1 lg:grid-cols-[1fr_2fr]">
          <div className="border-r border-border/60 p-4 overflow-y-auto">
            <BlankStateGenerator onGenerate={onGenerateCompose} />
            <p className="text-xs text-muted-foreground mt-4">
              Or upload a compose file, or just start typing in the editor on
              the right — the AI panel on the far right will help you refine
              it.
            </p>
          </div>
          <div className="min-h-0">
            <MonacoEditor
              height="100%"
              language="yaml"
              value={composeFile}
              onChange={(v) => setComposeFile(v ?? "")}
              options={MONACO_OPTIONS}
              theme="vs-dark"
            />
          </div>
        </div>
      ) : isCompose ? (
        <div className="flex-1 min-h-0">
          <MonacoEditor
            height="100%"
            language="yaml"
            value={composeFile}
            onChange={(v) => setComposeFile(v ?? "")}
            options={MONACO_OPTIONS}
            theme="vs-dark"
          />
        </div>
      ) : asset ? (
        <div className="flex-1 min-h-0">
          <MonacoEditor
            height="100%"
            language={languageForPath(asset.path)}
            value={asset.content}
            onChange={(v) => onAssetChange(asset.path, v ?? "")}
            options={MONACO_OPTIONS}
            theme="vs-dark"
          />
        </div>
      ) : (
        <div className="flex-1 min-h-0 flex items-center justify-center text-xs text-muted-foreground p-6 text-center">
          File not found — it may have been renamed or removed.
        </div>
      )}

      {/* Status bar */}
      <div className="shrink-0 border-t border-border/60 bg-card/40 px-3 py-1 flex items-center gap-3 text-[11px] text-muted-foreground">
        <span className="font-mono">
          {isCompose ? "YAML" : asset ? languageForPath(asset.path) : ""}
        </span>
        {isCompose && (
          <span>
            Use{" "}
            <code className="font-mono text-foreground">{"${VAR_NAME}"}</code>{" "}
            placeholders — the orchestrator writes a{" "}
            <code className="font-mono text-foreground">.env</code> at start
            time.
          </span>
        )}
        <span className="ml-auto">
          {(isCompose
            ? composeFile.length
            : asset?.content.length ?? 0
          ).toLocaleString()}{" "}
          chars
        </span>
      </div>

      {children}
    </div>
  );
}

function languageForPath(path: string): string {
  const lower = path.toLowerCase();
  const base = lower.split("/").pop() ?? "";
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

const MONACO_OPTIONS = {
  minimap: { enabled: false },
  fontSize: 13,
  scrollBeyondLastLine: false,
  wordWrap: "on" as const,
  tabSize: 2,
  renderLineHighlight: "all" as const,
  smoothScrolling: true,
  cursorBlinking: "smooth" as const,
};

function BlankStateGenerator({
  onGenerate,
}: {
  onGenerate: (description: string) => void;
}) {
  const [text, setText] = useState("");
  return (
    <div className="rounded-md border border-dashed bg-muted/30 p-3 space-y-2">
      <div className="flex items-center gap-2 text-xs font-mono">
        <Sparkles className="size-4" /> Generate with DevOps
      </div>
      <p className="text-xs text-muted-foreground">
        Describe what you want and the assistant will draft a compose file,
        variables, and services for you to review.
      </p>
      <Textarea
        rows={2}
        value={text}
        onChange={(e) => setText(e.target.value)}
        className="text-sm h-20 resize-y [field-sizing:fixed]"
        placeholder='e.g. "Next.js app with a postgres database and a redis cache"'
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            const t = text.trim();
            if (t) {
              onGenerate(t);
              setText("");
            }
          }
        }}
      />
      <div className="flex justify-end">
        <Button
          type="button"
          size="sm"
          disabled={!text.trim()}
          onClick={() => {
            const t = text.trim();
            if (!t) return;
            onGenerate(t);
            setText("");
          }}
        >
          Generate
        </Button>
      </div>
    </div>
  );
}

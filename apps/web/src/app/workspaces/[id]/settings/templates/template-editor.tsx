"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Plus, Sparkles, Trash2, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { AssetTree } from "./asset-tree";
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
  const [state, setState] = useState<TemplateEditorState>(initial);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [availableRepos, setAvailableRepos] = useState<WorkspaceRepo[] | null>(
    null
  );
  const [branchInfo, setBranchInfo] = useState<
    Record<string, { branches: string[]; defaultBranch: string | null }>
  >({});

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

  return (
    <form onSubmit={submit} className="space-y-8">
      <div className="flex justify-end">
        <AssistantPanel
          ref={assistantRef}
          workspaceId={workspaceId}
          getState={() => stateRef.current}
          applyToolCall={applyToolCall}
        />
      </div>

      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

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

      <div className="space-y-2">
        <div className="flex items-center justify-between gap-2">
          <Label htmlFor="compose">docker-compose.yml</Label>
          <div className="flex items-center gap-2">
            {state.composeFile && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => setField("composeFile", "")}
              >
                Clear
              </Button>
            )}
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => document.getElementById("tpl-compose-file")?.click()}
            >
              <Upload className="size-4" /> Upload file
            </Button>
          </div>
        </div>

        {mode === "create" && !state.composeFile.trim() && (
          <BlankStateGenerator
            onGenerate={(description) =>
              assistantRef.current?.openWith({
                prompt:
                  `Generate a docker-compose.yml and the matching variables, services notes, and any required asset files for the following stack:\n\n${description}\n\n` +
                  "Use the appropriate tools (setComposeFile, addVariable, setService, writeAsset). " +
                  "Pick port-based variables for any host ports (kind: system-port). Use service-url variables for inter-service URLs. " +
                  "Mark user-facing services. Keep the design minimal — only include services the user described.",
                autoSend: true,
              })
            }
          />
        )}
        <p className="text-xs text-muted-foreground">
          Use <code className="font-mono text-foreground">{"${VAR_NAME}"}</code>{" "}
          placeholders. The orchestrator will write a{" "}
          <code className="font-mono text-foreground">.env</code> next to this
          file at start time — compose reads it automatically.
          <br />
          Leave this empty if your template attaches exactly one repo and that
          repo has its own{" "}
          <code className="font-mono text-foreground">docker-compose.yml</code>{" "}
          at its root — the materializer will use it directly.
        </p>
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
        <Textarea
          id="compose"
          spellCheck={false}
          value={state.composeFile}
          onChange={(e) => setComposeFile(e.target.value)}
          className="font-mono text-xs h-80 resize-y overflow-auto [field-sizing:fixed]"
          placeholder={`Paste your docker-compose.yml here, or click "Upload file" above. Leave empty to use a single attached repo's own docker-compose.yml.\n\nservices:\n  app:\n    ports:\n      - "\${APP_PORT}:8080"`}
        />
      </div>

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
              <Sparkles className="size-4" /> Suggest with AI
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

      <section className="space-y-3">
        <div>
          <h3 className="font-mono text-sm font-semibold">Assets</h3>
          <p className="text-xs text-muted-foreground">
            Files copied into the env dir on materialization. Toggle{" "}
            <span className="font-mono">Interpolate</span> on a file to
            substitute <code className="font-mono text-foreground">{"${VAR}"}</code>{" "}
            inside its content. Drag files between folders to reorganize.
          </p>
        </div>
        <AssetTree
          assets={state.assets}
          onChange={(next) => setField("assets", next)}
        />
      </section>

      <div className="flex justify-end gap-2">
        <Button
          type="button"
          variant="outline"
          onClick={() => router.back()}
        >
          Cancel
        </Button>
        <Button type="submit" disabled={submitting}>
          {submitting
            ? "Saving…"
            : mode === "create"
              ? "Create template"
              : "Save changes"}
        </Button>
      </div>
    </form>
  );
}

function BlankStateGenerator({
  onGenerate,
}: {
  onGenerate: (description: string) => void;
}) {
  const [text, setText] = useState("");
  return (
    <div className="rounded-md border border-dashed bg-muted/30 p-3 space-y-2">
      <div className="flex items-center gap-2 text-xs font-mono">
        <Sparkles className="size-4" /> Generate with AI
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

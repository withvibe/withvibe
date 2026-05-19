"use client";

import { useRouter } from "next/navigation";
import { use, useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { RoutingModeFields, type RoutingMode } from "@/components/routing-mode-fields";
import { BranchCombobox } from "@/components/branch-combobox";
import { Loader2 } from "lucide-react";

type Repo = {
  id: string;
  name: string;
  defaultForNewEnvs: boolean;
  cloneStatus: "pending" | "cloning" | "ready" | "error";
};

type BranchInfo = {
  branches: string[];
  defaultBranch: string | null;
  loading: boolean;
};

type TemplateVariableKind =
  | "system-port"
  | "user-input"
  | "secret"
  | "default";

type TemplateVariable = {
  key: string;
  kind: TemplateVariableKind;
  label?: string;
  description?: string;
  defaultValue?: string;
  required?: boolean;
  secretName?: string;
};

type TemplateRepoRef = {
  repoId: string;
  baseBranch: string | null;
  repo: { id: string; name: string };
};

type TemplateSummary = {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  variables: TemplateVariable[];
  repos: TemplateRepoRef[];
  routingMode: RoutingMode;
  routingBaseDomain: string | null;
  qaBrowserMode: "sidecar" | "user_browser";
};

export default function NewEnvironmentPage(
  props: PageProps<"/workspaces/[id]/environments/new">
) {
  const { id } = use(props.params);
  const router = useRouter();
  const [repos, setRepos] = useState<Repo[] | null>(null);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [composeFile, setComposeFile] = useState("");
  const [showCompose, setShowCompose] = useState(false);
  const [stagedAssets, setStagedAssets] = useState<
    { path: string; file: File }[]
  >([]);
  const [selectedRepoIds, setSelectedRepoIds] = useState<Set<string>>(
    new Set()
  );
  const [branchInfo, setBranchInfo] = useState<Record<string, BranchInfo>>({});
  const [chosenBranch, setChosenBranch] = useState<Record<string, string | null>>({});
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [templates, setTemplates] = useState<TemplateSummary[] | null>(null);
  const [templateId, setTemplateId] = useState<string | null>(null);
  const [templateVars, setTemplateVars] = useState<Record<string, string>>({});
  const [routingMode, setRoutingMode] = useState<RoutingMode>("port");
  const [routingBaseDomain, setRoutingBaseDomain] = useState("");
  const [qaBrowserMode, setQaBrowserMode] = useState<
    "sidecar" | "user_browser"
  >("sidecar");

  useEffect(() => {
    fetch(`/api/workspaces/${id}/repos`)
      .then((r) => r.json())
      .then((data: Repo[]) => {
        setRepos(data);
        const defaults = new Set(
          data.filter((r) => r.defaultForNewEnvs).map((r) => r.id)
        );
        setSelectedRepoIds(defaults);
      });
    fetch(`/api/workspaces/${id}/env-templates`)
      .then((r) => (r.ok ? r.json() : []))
      .then((data: TemplateSummary[]) => setTemplates(data))
      .catch(() => setTemplates([]));
  }, [id]);

  const selectedTemplate =
    templateId && templates
      ? templates.find((t) => t.id === templateId) || null
      : null;
  const templateOwnsRepos =
    !!selectedTemplate && (selectedTemplate.repos?.length ?? 0) > 0;

  // When a template is picked, pre-fill user-input defaults once and mirror
  // the template's routing config (which the env will inherit on submit).
  useEffect(() => {
    if (!selectedTemplate) {
      setTemplateVars({});
      return;
    }
    setTemplateVars((prev) => {
      const next = { ...prev };
      for (const v of selectedTemplate.variables) {
        if (v.kind !== "user-input") continue;
        if (next[v.key] === undefined) {
          next[v.key] = v.defaultValue ?? "";
        }
      }
      return next;
    });
    setRoutingMode(selectedTemplate.routingMode);
    setRoutingBaseDomain(selectedTemplate.routingBaseDomain ?? "");
    setQaBrowserMode(selectedTemplate.qaBrowserMode);
  }, [selectedTemplate]);

  const loadBranches = useCallback(
    async (repoId: string) => {
      if (branchInfo[repoId]) return;
      setBranchInfo((prev) => ({
        ...prev,
        [repoId]: { branches: [], defaultBranch: null, loading: true },
      }));
      const res = await fetch(
        `/api/workspaces/${id}/repos/${repoId}/branches`
      );
      if (!res.ok) {
        setBranchInfo((prev) => ({
          ...prev,
          [repoId]: { branches: [], defaultBranch: null, loading: false },
        }));
        return;
      }
      const data = (await res.json()) as {
        branches: string[];
        defaultBranch: string | null;
      };
      setBranchInfo((prev) => ({
        ...prev,
        [repoId]: {
          branches: data.branches,
          defaultBranch: data.defaultBranch,
          loading: false,
        },
      }));
      if (data.defaultBranch) {
        // Don't clobber a branch already chosen — e.g. a template's
        // configured base branch seeded before this fetch resolves. The
        // functional update keeps it race-safe against the seeding effect.
        setChosenBranch((prev) =>
          prev[repoId] ? prev : { ...prev, [repoId]: data.defaultBranch! }
        );
      }
    },
    [id, branchInfo]
  );

  // Preload branches for repos selected by default.
  useEffect(() => {
    for (const repoId of selectedRepoIds) loadBranches(repoId);
  }, [selectedRepoIds, loadBranches]);

  // When a template owns the repos, preload each repo's branch list and seed
  // its picker with the template's configured base branch. If the template
  // left it unset, loadBranches falls back to the repo's default branch.
  useEffect(() => {
    if (!templateOwnsRepos || !selectedTemplate) return;
    for (const r of selectedTemplate.repos) {
      const tb = r.baseBranch;
      if (tb) {
        setChosenBranch((prev) =>
          prev[r.repoId] === undefined ? { ...prev, [r.repoId]: tb } : prev
        );
      }
      void loadBranches(r.repoId);
    }
  }, [templateOwnsRepos, selectedTemplate, loadBranches]);

  function toggleRepo(repoId: string) {
    setSelectedRepoIds((prev) => {
      const next = new Set(prev);
      if (next.has(repoId)) next.delete(repoId);
      else {
        next.add(repoId);
        void loadBranches(repoId);
      }
      return next;
    });
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError("");

    // For template-owned repos, send only base-branch overrides — the server
    // still owns the repo list and falls back to the template's configured
    // branch for anything we leave null.
    const reposPayload = templateOwnsRepos
      ? selectedTemplate!.repos.map((r) => ({
          id: r.repoId,
          baseBranch: chosenBranch[r.repoId] || null,
        }))
      : Array.from(selectedRepoIds).map((repoId) => ({
          id: repoId,
          baseBranch: chosenBranch[repoId] || null,
        }));

    // Strip values for variables that aren't user-input — the UI may carry
    // stale entries if a template was swapped, and the API would reject or
    // (worse) misinterpret them.
    const scrubbedVars: Record<string, string> = {};
    if (selectedTemplate) {
      for (const v of selectedTemplate.variables) {
        if (v.kind !== "user-input") continue;
        const val = templateVars[v.key];
        if (typeof val === "string") scrubbedVars[v.key] = val;
      }
    }

    const res = await fetch(`/api/workspaces/${id}/envs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title,
        description,
        repos: reposPayload,
        composeFile: templateId ? null : composeFile.trim() || null,
        templateId,
        templateVars: templateId ? scrubbedVars : undefined,
        qaBrowserMode,
        // Routing only travels in the body for custom-compose envs; when a
        // template is selected the server reads it from the template.
        ...(templateId
          ? {}
          : {
              routingMode,
              routingBaseDomain:
                routingMode === "subdomain"
                  ? routingBaseDomain.trim() || null
                  : null,
            }),
      }),
    });

    if (!res.ok) {
      const d = await res.json().catch(() => ({}));
      setError(d.error || "Failed to create environment");
      setSubmitting(false);
      return;
    }

    const { id: envId } = await res.json();

    if (stagedAssets.length > 0) {
      const fd = new FormData();
      for (const a of stagedAssets) {
        // The server keys file identity off `originalname`. Construct a
        // File with the relative path so folder structure is preserved.
        fd.append("files", new File([a.file], a.path, { type: a.file.type }));
      }
      const uploadRes = await fetch(
        `/api/workspaces/${id}/envs/${envId}/assets`,
        { method: "POST", body: fd }
      );
      if (!uploadRes.ok) {
        const msg = await uploadRes.text().catch(() => "Asset upload failed");
        setError(
          `Env created, but uploading assets failed: ${msg || "server error"}. You can re-upload from the env page.`
        );
        setSubmitting(false);
        router.push(`/workspaces/${id}/environments/${envId}`);
        return;
      }
    }

    router.push(`/workspaces/${id}/environments/${envId}`);
  }

  return (
    <div className="max-w-3xl mx-auto p-6 sm:p-8">
      <Card>
        <CardHeader>
          <CardTitle className="font-mono">New environment</CardTitle>
          <CardDescription>
            An environment is a self-contained piece of work — a feature, a
            fix, an experiment. The AI will have context about it.
          </CardDescription>
        </CardHeader>

        <form onSubmit={handleSubmit}>
          <CardContent className="space-y-8">
            {error && (
              <Alert variant="destructive">
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}

            <section className="space-y-5">
              <div className="border-b border-border/60 pb-1">
                <h3 className="text-xs font-mono uppercase tracking-wider text-muted-foreground">
                  Basics
                </h3>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label>Template</Label>
                  {templates === null ? (
                    <Skeleton className="h-9 rounded-md" />
                  ) : (
                    <Select
                      value={templateId ?? "__none__"}
                      onValueChange={(v) =>
                        setTemplateId(v === "__none__" ? null : v)
                      }
                    >
                      <SelectTrigger className="font-mono">
                        <SelectValue>
                          {selectedTemplate ? selectedTemplate.name : "None"}
                        </SelectValue>
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="__none__">None</SelectItem>
                        {templates.map((t) => (
                          <SelectItem key={t.id} value={t.id}>
                            {t.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  )}
                  <p className="text-xs text-muted-foreground">
                    {selectedTemplate?.description ? (
                      <span className="italic">{selectedTemplate.description}</span>
                    ) : (
                      <>
                        Pre-configured stack. Pick{" "}
                        <span className="font-mono text-foreground">None</span>{" "}
                        to bring your own compose.
                      </>
                    )}
                  </p>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="title">Name</Label>
                  <Input
                    id="title"
                    required
                    value={title}
                    onChange={(e) => setTitle(e.target.value)}
                    placeholder="dark-mode-toggle"
                    className="font-mono"
                  />
                </div>
              </div>

              <div className="space-y-2">
                <Label htmlFor="description">
                  What is this environment about?
                </Label>
                <Textarea
                  id="description"
                  rows={4}
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="Describe the goal, constraints, what done looks like."
                />
              </div>
            </section>

            <section className="space-y-5">
              <div className="border-b border-border/60 pb-1">
                <h3 className="text-xs font-mono uppercase tracking-wider text-muted-foreground">
                  Code
                </h3>
              </div>

              <div className="space-y-2">
                <Label>Repositories &amp; base branches</Label>
              {templateOwnsRepos ? (
                <>
                  <p className="text-xs text-muted-foreground">
                    Repositories are set by the template. You can still pick a
                    different base branch per repo before creating this env.
                  </p>
                  <div className="rounded-md border divide-y divide-border/60">
                    {selectedTemplate!.repos.map((r) => {
                      const info = branchInfo[r.repoId];
                      const repoMeta = repos?.find((x) => x.id === r.repoId);
                      const ready = repoMeta?.cloneStatus === "ready";
                      return (
                        <div
                          key={r.repoId}
                          className="flex items-center gap-3 px-3 py-2"
                        >
                          <span className="text-sm font-mono">
                            {r.repo.name}
                          </span>
                          <div className="ml-auto w-48">
                            {!ready ? (
                              <span className="text-xs text-muted-foreground font-mono">
                                {repoMeta
                                  ? `branch picker disabled — clone ${repoMeta.cloneStatus}`
                                  : "loading…"}
                              </span>
                            ) : info?.loading ? (
                              <Skeleton className="h-8 rounded-md" />
                            ) : (
                              <BranchCombobox
                                branches={info?.branches || []}
                                value={chosenBranch[r.repoId] || null}
                                defaultBranch={info?.defaultBranch}
                                onValueChange={(v) =>
                                  setChosenBranch((prev) => ({
                                    ...prev,
                                    [r.repoId]: v,
                                  }))
                                }
                              />
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </>
              ) : (
                <>
              <p className="text-xs text-muted-foreground">
                Each selected repo gets its own per-env clone branched off the
                chosen base — your env edits stay isolated from main.
              </p>
              {repos === null ? (
                <Skeleton className="h-24 rounded-md" />
              ) : repos.length === 0 ? (
                <p className="text-xs text-muted-foreground">
                  No repositories yet.{" "}
                  <Link
                    href={`/workspaces/${id}/settings/repos`}
                    className="text-primary hover:underline"
                  >
                    Add one
                  </Link>
                  .
                </p>
              ) : (
                <div className="rounded-md border divide-y divide-border/60 max-h-80 overflow-auto">
                  {repos.map((r) => {
                    const checked = selectedRepoIds.has(r.id);
                    const info = branchInfo[r.id];
                    const ready = r.cloneStatus === "ready";
                    return (
                      <div
                        key={r.id}
                        className="flex items-center gap-3 px-3 py-2"
                      >
                        <Checkbox
                          id={`repo-${r.id}`}
                          checked={checked}
                          onCheckedChange={() => toggleRepo(r.id)}
                        />
                        <label
                          htmlFor={`repo-${r.id}`}
                          className={
                            ready
                              ? "text-sm font-mono cursor-pointer"
                              : "text-sm font-mono text-muted-foreground cursor-pointer"
                          }
                        >
                          {r.name}
                        </label>
                        {!ready && (
                          <Badge variant="outline" className="text-xs">
                            {r.cloneStatus}
                          </Badge>
                        )}
                        {r.defaultForNewEnvs && (
                          <Badge
                            variant="secondary"
                            className="text-xs font-mono"
                          >
                            default
                          </Badge>
                        )}
                        <div className="ml-auto w-48">
                          {!checked ? (
                            // Always show the picker, but branches only load
                            // once the repo is checked (toggleRepo →
                            // loadBranches). Disabled until then.
                            <BranchCombobox
                              branches={[]}
                              value={null}
                              disabled
                              placeholder="Select repo first"
                              onValueChange={() => {}}
                            />
                          ) : !ready ? (
                            <span className="text-xs text-muted-foreground font-mono">
                              branch picker disabled — clone {r.cloneStatus}
                            </span>
                          ) : !info || info.loading ? (
                            <Skeleton className="h-8 rounded-md" />
                          ) : (
                            <BranchCombobox
                              branches={info.branches || []}
                              value={chosenBranch[r.id] || null}
                              defaultBranch={info.defaultBranch}
                              onValueChange={(v) =>
                                setChosenBranch((prev) => ({
                                  ...prev,
                                  [r.id]: v,
                                }))
                              }
                            />
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
                </>
              )}
            </div>

              {selectedTemplate && (
                <div className="space-y-3 rounded-md border border-border/60 bg-card/30 p-4">
                  <div className="space-y-1">
                    <Label className="font-mono text-sm">Template inputs</Label>
                    <p className="text-xs text-muted-foreground">
                      These are the fields the template author left for you to
                      fill in. Everything else is resolved automatically.
                    </p>
                  </div>
                  {selectedTemplate.variables.filter(
                    (v) => v.kind === "user-input"
                  ).length === 0 ? (
                    <p className="text-xs text-muted-foreground italic">
                      This template has no user inputs.
                    </p>
                  ) : (
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                      {selectedTemplate.variables
                        .filter((v) => v.kind === "user-input")
                        .map((v) => (
                          <div key={v.key} className="space-y-1.5">
                            <Label htmlFor={`tvar-${v.key}`} className="text-xs">
                              {v.label || v.key}
                              {v.required && (
                                <span className="text-destructive ml-1">*</span>
                              )}
                            </Label>
                            <Input
                              id={`tvar-${v.key}`}
                              required={v.required}
                              value={templateVars[v.key] ?? ""}
                              onChange={(e) =>
                                setTemplateVars((prev) => ({
                                  ...prev,
                                  [v.key]: e.target.value,
                                }))
                              }
                              placeholder={v.defaultValue || v.key}
                              className="font-mono"
                            />
                            {v.description && (
                              <p className="text-[11px] text-muted-foreground">
                                {v.description}
                              </p>
                            )}
                          </div>
                        ))}
                    </div>
                  )}
                </div>
              )}
            </section>

            <section className="space-y-5">
              <div className="border-b border-border/60 pb-1">
                <h3 className="text-xs font-mono uppercase tracking-wider text-muted-foreground">
                  Runtime
                </h3>
              </div>

              <div className="space-y-3 rounded-md border border-border/60 bg-card/30 p-4">
                <div>
                  <Label className="font-mono text-sm">QA browser</Label>
                <p className="text-xs text-muted-foreground mt-1">
                  {selectedTemplate
                    ? "Set by the selected template — can't be changed per-env."
                    : "Where the QA agent runs the browser when it tests this env."}
                </p>
              </div>
              <div className="space-y-2">
                <label
                  className={`flex items-start gap-3 text-xs ${selectedTemplate ? "cursor-not-allowed opacity-60" : "cursor-pointer"}`}
                >
                  <input
                    type="radio"
                    name="qa-browser-mode"
                    value="sidecar"
                    checked={qaBrowserMode === "sidecar"}
                    onChange={() => setQaBrowserMode("sidecar")}
                    disabled={!!selectedTemplate}
                    className="mt-0.5"
                  />
                  <span>
                    <span className="font-mono">Sidecar (default)</span>
                    <br />
                    <span className="text-muted-foreground">
                      Headless Chromium runs in a Docker container, streamed to
                      you over VNC. Isolated from your real browser, works
                      unattended.
                    </span>
                  </span>
                </label>
                <label
                  className={`flex items-start gap-3 text-xs ${selectedTemplate ? "cursor-not-allowed opacity-60" : "cursor-pointer"}`}
                >
                  <input
                    type="radio"
                    name="qa-browser-mode"
                    value="user_browser"
                    checked={qaBrowserMode === "user_browser"}
                    onChange={() => setQaBrowserMode("user_browser")}
                    disabled={!!selectedTemplate}
                    className="mt-0.5"
                  />
                  <span>
                    <span className="font-mono">My browser (extension)</span>
                    <br />
                    <span className="text-muted-foreground">
                      The agent drives a tab in your real Chrome via the
                      WithVibe extension. Faster, uses your real login — but
                      shows Chrome&apos;s &quot;extension is debugging&quot;
                      banner and only works while you&apos;re here.
                    </span>
                  </span>
                </label>
              </div>
            </div>

              <div className="space-y-3 rounded-md border border-border/60 bg-card/30 p-4">
                <div>
                  <Label className="font-mono text-sm">Routing</Label>
                </div>
                <RoutingModeFields
                  routingMode={routingMode}
                  routingBaseDomain={routingBaseDomain}
                  onChange={({ routingMode: m, routingBaseDomain: b }) => {
                    setRoutingMode(m);
                    setRoutingBaseDomain(b);
                  }}
                  disabled={!!selectedTemplate}
                  disabledReason={
                    selectedTemplate
                      ? "Set by the selected template — can't be changed per-env."
                      : undefined
                  }
                />
              </div>
            </section>

            <section
              className="space-y-5"
              hidden={!!templateId}
              aria-hidden={!!templateId}
            >
              <div className="border-b border-border/60 pb-1">
                <h3 className="text-xs font-mono uppercase tracking-wider text-muted-foreground">
                  Advanced
                </h3>
              </div>

              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <Label>Custom docker-compose (optional)</Label>
                <button
                  type="button"
                  onClick={() => setShowCompose((v) => !v)}
                  className="text-xs text-muted-foreground hover:text-foreground"
                >
                  {showCompose ? "Hide" : "Add"}
                </button>
              </div>
              {showCompose && (
                <>
                  <p className="text-xs text-muted-foreground">
                    Overrides any compose found in attached repos. Runs from
                    the workspace dir, so services reference repos as{" "}
                    <code className="font-mono text-foreground">./repo-name</code>.
                    Leave empty to let the DevOps agent detect / generate one.
                  </p>
                  <div className="flex flex-wrap gap-2">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        const el = document.getElementById(
                          "compose-file-input"
                        ) as HTMLInputElement | null;
                        el?.click();
                      }}
                    >
                      Upload compose file
                    </Button>
                    {composeFile && (
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() => setComposeFile("")}
                      >
                        Clear
                      </Button>
                    )}
                  </div>
                  <input
                    id="compose-file-input"
                    type="file"
                    accept=".yml,.yaml,application/yaml,text/yaml,text/plain"
                    className="hidden"
                    onChange={async (e) => {
                      const f = e.target.files?.[0];
                      e.target.value = "";
                      if (!f) return;
                      const text = await f.text();
                      setComposeFile(text);
                    }}
                  />
                  <Textarea
                    rows={10}
                    spellCheck={false}
                    value={composeFile}
                    onChange={(e) => setComposeFile(e.target.value)}
                    placeholder={`services:\n  app:\n    build: ./my-repo\n    ports:\n      - "3000:3000"`}
                    className="font-mono text-xs"
                  />

                  <div className="pt-2">
                    <Label>Extra files / folders (optional)</Label>
                    <p className="text-xs text-muted-foreground mt-1">
                      Land under <code className="font-mono text-foreground">./assets/</code>{" "}
                      at the env root. Reference them in the compose as{" "}
                      <code className="font-mono text-foreground">./assets/db/schema.sql</code>
                      {" "}etc. Folder structure is preserved.
                    </p>
                    <div className="flex flex-wrap gap-2 mt-2">
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => {
                          const el = document.getElementById(
                            "asset-files-input"
                          ) as HTMLInputElement | null;
                          el?.click();
                        }}
                      >
                        Add files
                      </Button>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => {
                          const el = document.getElementById(
                            "asset-folder-input"
                          ) as HTMLInputElement | null;
                          el?.click();
                        }}
                      >
                        Add folder
                      </Button>
                    </div>
                    <input
                      id="asset-files-input"
                      type="file"
                      multiple
                      className="hidden"
                      onChange={(e) => {
                        const list = Array.from(e.target.files ?? []);
                        setStagedAssets((prev) => [
                          ...prev,
                          ...list.map((f) => ({ path: f.name, file: f })),
                        ]);
                        e.target.value = "";
                      }}
                    />
                    <input
                      id="asset-folder-input"
                      type="file"
                      multiple
                      className="hidden"
                      // Set folder-mode attributes imperatively — JSX
                      // forwards `webkitdirectory=""` inconsistently across
                      // React/Next versions, which silently drops us back to
                      // the file picker.
                      ref={(el) => {
                        if (!el) return;
                        el.setAttribute("webkitdirectory", "");
                        el.setAttribute("directory", "");
                      }}
                      onChange={(e) => {
                        const list = Array.from(e.target.files ?? []);
                        setStagedAssets((prev) => [
                          ...prev,
                          ...list.map((f) => ({
                            // webkitRelativePath preserves the picked folder
                            // name and any sub-structure — kept verbatim so
                            // assets land under assets/<picked>/...
                            path:
                              (f as File & { webkitRelativePath?: string })
                                .webkitRelativePath || f.name,
                            file: f,
                          })),
                        ]);
                        e.target.value = "";
                      }}
                    />
                    {stagedAssets.length > 0 && (
                      <ul className="mt-2 space-y-1 text-xs font-mono">
                        {stagedAssets.map((a, i) => (
                          <li
                            key={i}
                            className="flex items-center justify-between gap-2 rounded border px-2 py-1"
                          >
                            <span className="truncate" title={a.path}>
                              {a.path}
                            </span>
                            <span className="text-muted-foreground shrink-0">
                              {formatBytes(a.file.size)}
                            </span>
                            <button
                              type="button"
                              onClick={() =>
                                setStagedAssets((prev) =>
                                  prev.filter((_, j) => j !== i)
                                )
                              }
                              className="text-destructive hover:underline shrink-0"
                            >
                              Remove
                            </button>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                </>
              )}
              </div>
            </section>

            <div className="flex justify-end gap-2 pt-2">
              <Button
                type="button"
                variant="outline"
                render={<Link href={`/workspaces/${id}`} />}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={submitting}>
                {submitting && <Loader2 className="size-4 animate-spin" />}
                {submitting ? "Creating…" : "Create environment"}
              </Button>
            </div>
          </CardContent>
        </form>
      </Card>
    </div>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}


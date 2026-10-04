"use client";

import { useCallback, useEffect, useState } from "react";
import {
  Boxes,
  Database,
  Eye,
  Globe,
  HardDrive,
  Loader2,
  Plus,
  Trash2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { toast } from "sonner";

/** Mirrors apps/api/src/env-spec/env-spec.ts — keep the two in step. */
export type ServiceSpec = {
  image?: string;
  type?: string;
  version?: string;
  http?: number;
  env?: Record<string, string>;
  storage?: string;
  cpu?: number;
  memory?: string;
  database?: string;
  user?: string;
};
export type EnvSpec = { name?: string; services: Record<string, ServiceSpec> };

type ServiceType = {
  type: string;
  defaultVersion: string;
  port: number;
  hasCredentials: boolean;
  dataPath: string;
  image: string;
};

type Preview = {
  composeFile: string;
  notes: string[];
  httpService: { name: string; port: number } | null;
};

/**
 * Service-spec editor. The user adds services and fills in a handful of
 * fields; the platform compiles that into the Compose file. Anything a
 * service can't express here — a host mount, a routing label, a raw
 * `${VAR}` — is absent on purpose rather than merely discouraged.
 */
type SpecDialogProps = {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  workspaceId: string;
  envId: string;
  initialSpec: EnvSpec | null;
  computeTarget: string;
  onSaved: () => Promise<void> | void;
};

export function SpecDialog(props: SpecDialogProps) {
  // Remount the body each time the dialog opens so its edit state starts from
  // the current props. React's own answer to "reset state when a prop
  // changes" — cheaper to reason about than mirroring props in an effect, and
  // it cannot leave a cancelled edit behind.
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      {props.open && <SpecDialogBody {...props} />}
    </Dialog>
  );
}

function SpecDialogBody({
  onOpenChange,
  workspaceId,
  envId,
  initialSpec,
  computeTarget,
  onSaved,
}: SpecDialogProps) {
  const [services, setServices] = useState<[string, ServiceSpec][]>(() =>
    Object.entries(initialSpec?.services ?? {}),
  );
  const [catalog, setCatalog] = useState<ServiceType[]>([]);
  const [problems, setProblems] = useState<string[]>([]);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [showCompose, setShowCompose] = useState(false);
  const [checking, setChecking] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    void (async () => {
      const res = await fetch(
        `/api/workspaces/${workspaceId}/env-spec/service-types`,
      );
      if (!res.ok) return;
      const d = await res.json();
      setCatalog(d.serviceTypes ?? []);
    })();
  }, [workspaceId]);

  const asSpec = useCallback(
    (): EnvSpec => ({ services: Object.fromEntries(services) }),
    [services],
  );

  /** Compile without saving — the only way to see problems before committing. */
  const check = useCallback(async (): Promise<Preview | null> => {
    setChecking(true);
    const res = await fetch(`/api/workspaces/${workspaceId}/env-spec/preview`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ spec: asSpec(), computeTarget }),
    });
    setChecking(false);
    const d = await res.json().catch(() => null);
    if (!res.ok) {
      setProblems(d?.problems ?? [d?.message ?? "Could not check the spec"]);
      setPreview(null);
      return null;
    }
    setProblems([]);
    const p: Preview = {
      composeFile: d.composeFile,
      notes: d.notes ?? [],
      httpService: d.httpService ?? null,
    };
    setPreview(p);
    return p;
  }, [workspaceId, asSpec, computeTarget]);

  async function save() {
    // Never save something that doesn't compile: the error would otherwise
    // surface much later, at start time, with no obvious cause.
    const ok = await check();
    if (!ok) {
      toast.error("Fix the problems below first");
      return;
    }
    setSaving(true);
    const res = await fetch(`/api/workspaces/${workspaceId}/envs/${envId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ serviceSpec: asSpec() }),
    });
    setSaving(false);
    if (!res.ok) {
      const d = await res.json().catch(() => null);
      setProblems(d?.problems ?? [d?.message ?? "Failed to save"]);
      toast.error(d?.message ?? "Failed to save");
      return;
    }
    toast.success("Services saved — rebuild to apply");
    await onSaved();
    onOpenChange(false);
  }

  function addService(type: string | null) {
    const base = type ? type : "service";
    let name = base;
    let n = 2;
    const taken = new Set(services.map(([k]) => k));
    while (taken.has(name)) name = `${base}${n++}`;
    const spec: ServiceSpec = type ? { type } : { image: "", http: undefined };
    setServices((s) => [...s, [name, spec]]);
  }

  function patch(index: number, next: Partial<ServiceSpec>) {
    setServices((s) =>
      s.map((entry, i) =>
        i === index ? [entry[0], { ...entry[1], ...next }] : entry,
      ),
    );
  }

  function rename(index: number, name: string) {
    setServices((s) =>
      s.map((entry, i) => (i === index ? [name, entry[1]] : entry)),
    );
  }

  return (
    <DialogContent className="max-w-3xl">
      <DialogHeader>
        <DialogTitle className="font-mono text-sm flex items-center gap-2">
          <Boxes className="size-4" />
          Services
        </DialogTitle>
        <DialogDescription className="text-xs">
          Describe what the environment needs. WithVibe writes the Compose file,
          wires the services to each other, generates database passwords, and
          sets resource limits.
        </DialogDescription>
      </DialogHeader>

      <div className="space-y-3 max-h-[55vh] overflow-y-auto pr-1">
        {services.length === 0 && (
          <p className="text-xs text-muted-foreground py-6 text-center">
            No services yet. Add a database or an image to get started.
          </p>
        )}

        {services.map(([name, svc], i) => {
          const preset = catalog.find((c) => c.type === svc.type);
          return (
            <div
              key={i}
              className="rounded-md border border-border/60 bg-card/30 p-4 space-y-3"
            >
              <div className="flex items-center gap-2">
                {svc.type ? (
                  <Database className="size-3.5 text-primary shrink-0" />
                ) : (
                  <Boxes className="size-3.5 text-primary shrink-0" />
                )}
                <Input
                  value={name}
                  onChange={(e) => rename(i, e.target.value)}
                  className="h-7 font-mono text-xs max-w-[12rem]"
                  aria-label="Service name"
                />
                {svc.type && (
                  <Badge variant="secondary" className="font-mono text-[10px]">
                    {svc.type}
                  </Badge>
                )}
                {svc.http !== undefined && (
                  <Badge className="font-mono text-[10px] gap-1">
                    <Globe className="size-2.5" />
                    public
                  </Badge>
                )}
                <Button
                  variant="ghost"
                  size="icon-xs"
                  className="ml-auto"
                  onClick={() =>
                    setServices((s) => s.filter((_, j) => j !== i))
                  }
                  aria-label={`Remove ${name}`}
                >
                  <Trash2 className="size-3.5" />
                </Button>
              </div>

              <div className="grid gap-3 sm:grid-cols-2">
                {svc.type ? (
                  <Field label="Version">
                    <Input
                      value={svc.version ?? ""}
                      placeholder={preset?.defaultVersion ?? "latest"}
                      onChange={(e) =>
                        patch(i, { version: e.target.value || undefined })
                      }
                      className="h-7 font-mono text-xs"
                    />
                  </Field>
                ) : (
                  <Field label="Image">
                    <Input
                      value={svc.image ?? ""}
                      placeholder="nginx:alpine"
                      onChange={(e) => patch(i, { image: e.target.value })}
                      className="h-7 font-mono text-xs"
                    />
                  </Field>
                )}

                <Field
                  label="Public port"
                  hint="The one service reachable from a browser"
                >
                  <Input
                    value={svc.http ?? ""}
                    placeholder="none"
                    inputMode="numeric"
                    onChange={(e) =>
                      patch(i, {
                        http: e.target.value
                          ? Number(e.target.value)
                          : undefined,
                      })
                    }
                    className="h-7 font-mono text-xs"
                  />
                </Field>

                <Field label="Storage" hint={preset?.dataPath ?? "/data"}>
                  <Input
                    value={svc.storage ?? ""}
                    placeholder="none (e.g. 2Gi)"
                    onChange={(e) =>
                      patch(i, { storage: e.target.value || undefined })
                    }
                    className="h-7 font-mono text-xs"
                  />
                </Field>

                {preset?.hasCredentials && (
                  <Field label="Database name">
                    <Input
                      value={svc.database ?? ""}
                      placeholder="app"
                      onChange={(e) =>
                        patch(i, { database: e.target.value || undefined })
                      }
                      className="h-7 font-mono text-xs"
                    />
                  </Field>
                )}
              </div>

              <EnvEditor
                env={svc.env ?? {}}
                peers={services.map(([n]) => n).filter((n) => n !== name)}
                onChange={(env) => patch(i, { env })}
              />
            </div>
          );
        })}

        <div className="flex items-center gap-2 flex-wrap">
          <Select
            onValueChange={(v) =>
              addService(typeof v === "string" && v !== "__image__" ? v : null)
            }
          >
            <SelectTrigger className="h-8 w-[15rem] text-xs">
              <SelectValue placeholder="Add a service…" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__image__" className="text-xs">
                <span className="font-mono">Any Docker image</span>
              </SelectItem>
              {catalog.map((c) => (
                <SelectItem key={c.type} value={c.type} className="text-xs">
                  <span className="font-mono">{c.type}</span>
                  <span className="text-muted-foreground"> — {c.image}</span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Plus className="size-3.5 text-muted-foreground" />
        </div>

        {problems.length > 0 && (
          <Alert variant="destructive">
            <AlertDescription>
              <ul className="list-disc pl-4 space-y-1 text-xs">
                {problems.map((p, i) => (
                  <li key={i}>{p}</li>
                ))}
              </ul>
            </AlertDescription>
          </Alert>
        )}

        {preview && problems.length === 0 && (
          <div className="rounded-md border border-border/60 bg-card/30 p-3 space-y-2">
            <div className="flex items-center gap-2">
              <HardDrive className="size-3.5 text-muted-foreground" />
              <span className="text-xs font-mono">
                Compiles for{" "}
                <span className="text-foreground">{computeTarget}</span>
              </span>
              <Button
                variant="ghost"
                size="xs"
                className="ml-auto gap-1.5"
                onClick={() => setShowCompose((v) => !v)}
              >
                <Eye className="size-3" />
                {showCompose ? "Hide" : "Show"} generated compose
              </Button>
            </div>
            {preview.notes.map((n, i) => (
              <p key={i} className="text-[11px] text-muted-foreground">
                {n}
              </p>
            ))}
            {showCompose && (
              <pre className="rounded-md border border-border/60 bg-card/50 p-3 text-[11px] font-mono overflow-x-auto whitespace-pre max-h-64">
                {preview.composeFile}
              </pre>
            )}
          </div>
        )}
      </div>

      <DialogFooter className="sm:justify-between">
        <Button
          variant="outline"
          size="sm"
          onClick={() => void check()}
          disabled={checking || services.length === 0}
          className="gap-1.5"
        >
          {checking ? (
            <Loader2 className="size-3.5 animate-spin" />
          ) : (
            <Eye className="size-3.5" />
          )}
          Check
        </Button>
        <div className="flex gap-2">
          <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            size="sm"
            onClick={() => void save()}
            disabled={saving || services.length === 0}
            className="gap-1.5"
          >
            {saving && <Loader2 className="size-3.5 animate-spin" />}
            Save
          </Button>
        </div>
      </DialogFooter>
    </DialogContent>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1">
      <Label className="text-[11px] text-muted-foreground">{label}</Label>
      {children}
      {hint && <p className="text-[10px] text-muted-foreground">{hint}</p>}
    </div>
  );
}

/**
 * Environment variables, with the cross-service reference syntax surfaced as
 * clickable chips. Typing `{{ db.password }}` by hand works, but nobody
 * should have to discover that it exists.
 */
function EnvEditor({
  env,
  peers,
  onChange,
}: {
  env: Record<string, string>;
  peers: string[];
  onChange: (env: Record<string, string>) => void;
}) {
  const rows = Object.entries(env);
  return (
    <div className="space-y-1.5">
      <Label className="text-[11px] text-muted-foreground">
        Environment variables
      </Label>
      {rows.map(([k, v], i) => (
        <div key={i} className="flex items-center gap-1.5">
          <Input
            value={k}
            placeholder="KEY"
            onChange={(e) => {
              const next = rows.slice();
              next[i] = [e.target.value, v];
              onChange(Object.fromEntries(next));
            }}
            className="h-7 font-mono text-[11px] max-w-[14rem]"
          />
          <Input
            value={v}
            placeholder="value or {{ db.url }}"
            onChange={(e) => {
              const next = rows.slice();
              next[i] = [k, e.target.value];
              onChange(Object.fromEntries(next));
            }}
            className="h-7 font-mono text-[11px]"
          />
          <Button
            variant="ghost"
            size="icon-xs"
            onClick={() =>
              onChange(Object.fromEntries(rows.filter((_, j) => j !== i)))
            }
            aria-label="Remove variable"
          >
            <Trash2 className="size-3" />
          </Button>
        </div>
      ))}
      <div className="flex items-center gap-1.5 flex-wrap">
        <Button
          variant="ghost"
          size="xs"
          onClick={() => onChange({ ...env, "": "" })}
          className="gap-1 text-[11px]"
        >
          <Plus className="size-3" />
          Add variable
        </Button>
        {peers.length > 0 && rows.length > 0 && (
          <span className="text-[10px] text-muted-foreground">
            reference another service with{" "}
            <code className="px-1 py-0.5 bg-muted rounded font-mono">
              {`{{ ${peers[0]}.url }}`}
            </code>
          </span>
        )}
      </div>
    </div>
  );
}

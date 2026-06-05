"use client";

import { use, useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";
import { useDemoMode } from "../../_demo-mode";

type TemplateRow = {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  variables: unknown;
  createdAt: string;
  updatedAt: string;
};

export default function TemplatesListPage(
  props: PageProps<"/workspaces/[id]/settings/templates">
) {
  const { id } = use(props.params);
  const demoMode = useDemoMode();
  const [rows, setRows] = useState<TemplateRow[] | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);

  const load = useCallback(async () => {
    const res = await fetch(`/api/workspaces/${id}/env-templates`);
    if (res.ok) setRows(await res.json());
    else setRows([]);
  }, [id]);

  useEffect(() => {
    load();
  }, [load]);

  async function onDelete(templateId: string, name: string) {
    if (!confirm(`Delete template "${name}"? Envs already created from it are unaffected.`))
      return;
    setDeleting(templateId);
    const res = await fetch(
      `/api/workspaces/${id}/env-templates/${templateId}`,
      { method: "DELETE" }
    );
    setDeleting(null);
    if (res.ok) {
      toast.success("Template deleted");
      load();
    } else {
      toast.error("Delete failed");
    }
  }

  return (
    <div className="max-w-4xl mx-auto px-6 sm:px-8 py-10 space-y-6">
      <header className="flex items-start justify-between gap-4">
        <div className="space-y-1">
          <h1 className="text-2xl font-mono font-bold tracking-tight">
            Environment templates
          </h1>
          <p className="text-sm text-muted-foreground max-w-prose">
            Pre-configured compose + assets that non-technical teammates pick
            from when creating a new env. The orchestrator fills in ports,
            paths and secrets automatically.
          </p>
        </div>
        <Button
          render={<Link href={`/workspaces/${id}/settings/templates/new`} />}
        >
          <Plus className="size-4" /> New template
        </Button>
      </header>

      {rows === null ? (
        <Skeleton className="h-40 rounded-md" />
      ) : rows.length === 0 ? (
        <div className="rounded-md border border-dashed p-10 text-center space-y-2">
          <p className="text-sm text-muted-foreground">
            No templates yet.
          </p>
          <Button
            variant="outline"
            size="sm"
            render={<Link href={`/workspaces/${id}/settings/templates/new`} />}
          >
            Create your first template
          </Button>
        </div>
      ) : (
        <div className="rounded-md border divide-y divide-border/60">
          {rows.map((t) => {
            const varCount = Array.isArray(t.variables)
              ? t.variables.length
              : 0;
            return (
              <div
                key={t.id}
                className="flex items-center gap-4 px-4 py-3"
              >
                <div className="flex-1 min-w-0 space-y-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <Link
                      href={`/workspaces/${id}/settings/templates/${t.id}`}
                      className="font-mono text-sm font-semibold hover:underline"
                    >
                      {t.name}
                    </Link>
                    <Badge variant="outline" className="font-mono text-[10px]">
                      {t.slug}
                    </Badge>
                    <span className="text-[10px] text-muted-foreground font-mono">
                      {varCount} var{varCount === 1 ? "" : "s"}
                    </span>
                  </div>
                  {t.description && (
                    <p className="text-xs text-muted-foreground truncate">
                      {t.description}
                    </p>
                  )}
                </div>
                {!demoMode && (
                  <Button
                    variant="ghost"
                    size="icon"
                    disabled={deleting === t.id}
                    onClick={() => onDelete(t.id, t.name)}
                    aria-label="Delete template"
                  >
                    <Trash2 className="size-4 text-destructive" />
                  </Button>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

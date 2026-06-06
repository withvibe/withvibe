"use client";

import { use, useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
  ArrowLeft,
  BadgeCheck,
  DollarSign,
  ExternalLink,
  Heart,
  Loader2,
  Lock,
  Scale,
  Search,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";

type CatalogRow = {
  slug: string;
  name: string;
  description: string;
  sourceRepoUrl: string | null;
  categories: string[];
  pricing: string;
  license: string | null;
  publisher: {
    name: string | null;
    githubLogin: string;
    isVerified: boolean;
  };
  latestVersion: string | null;
  icon: string | null;
};

export default function MarketplacePage(
  props: PageProps<"/workspaces/[id]/admin/plugins/marketplace">
) {
  const { id: workspaceId } = use(props.params);
  const router = useRouter();
  const [rows, setRows] = useState<CatalogRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [installing, setInstalling] = useState<string | null>(null);

  const load = useCallback(
    async (query: string) => {
      setRows(null);
      setError(null);
      const url = new URL(
        `/api/workspaces/${workspaceId}/admin/plugins/marketplace/catalog`,
        window.location.origin
      );
      if (query) url.searchParams.set("q", query);
      const res = await fetch(
        url.toString().replace(window.location.origin, "")
      );
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        setError(parseError(text) || `Failed to load (HTTP ${res.status})`);
        setRows([]);
        return;
      }
      const body = (await res.json()) as { plugins: CatalogRow[] };
      setRows(body.plugins);
    },
    [workspaceId]
  );

  useEffect(() => {
    void load("");
  }, [load]);

  async function install(slug: string) {
    setInstalling(slug);
    try {
      // Slug-only — the api side composes the marketplace URL from
      // WITHVIBE_MARKETPLACE_BASE_URL, fetches the manifest, runs the
      // existing install path.
      const res = await fetch(
        `/api/workspaces/${workspaceId}/admin/plugins/install-from-marketplace`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ slug }),
        }
      );
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        toast.error(parseError(text) || `Install failed (HTTP ${res.status})`);
        return;
      }
      toast.success(`Installed ${slug}`);
      router.push(`/workspaces/${workspaceId}/admin/plugins`);
    } finally {
      setInstalling(null);
    }
  }

  return (
    <div className="max-w-[1100px] mx-auto p-4 sm:p-6 space-y-6">
      <header className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <Button
            variant="ghost"
            size="sm"
            onClick={() =>
              router.push(`/workspaces/${workspaceId}/admin/plugins`)
            }
          >
            <ArrowLeft className="size-4" /> Plugins
          </Button>
          <h1 className="text-xl font-mono font-bold">Marketplace</h1>
        </div>
      </header>

      <p className="text-sm text-muted-foreground">
        Browse plugins published on the WithVibe marketplace and install
        them into this workspace in one click. The product fetches the
        manifest from the marketplace and runs the same install path you
        get with a pasted YAML.
      </p>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          void load(q);
        }}
        className="relative max-w-md"
      >
        <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground" />
        <Input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search plugins…"
          className="pl-8 h-9 text-sm"
        />
      </form>

      {error ? (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-xs text-destructive">
          {error}
        </div>
      ) : null}

      {rows === null ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          <Skeleton className="h-32" />
          <Skeleton className="h-32" />
          <Skeleton className="h-32" />
        </div>
      ) : rows.length === 0 ? (
        <div className="rounded-md border border-dashed border-border/60 p-10 text-center text-sm text-muted-foreground">
          No plugins published yet.
        </div>
      ) : (
        <ul className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {rows.map((p) => (
            <li
              key={p.slug}
              className="rounded-md border bg-card p-4 flex flex-col gap-2"
            >
              <div className="flex items-baseline gap-2 flex-wrap">
                <span className="font-medium">{p.name}</span>
                {p.latestVersion ? (
                  <span className="text-[11px] font-mono text-muted-foreground">
                    v{p.latestVersion}
                  </span>
                ) : null}
              </div>
              <p className="text-[11px] font-mono text-muted-foreground truncate">
                {p.slug}
              </p>
              <p className="text-sm text-muted-foreground line-clamp-3 flex-1">
                {p.description}
              </p>
              <div className="flex flex-wrap items-center gap-1.5">
                <PricingPill pricing={p.pricing} />
                <LicensePill
                  license={p.license}
                  sourceRepoUrl={p.sourceRepoUrl}
                />
              </div>
              <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
                <span>
                  by {p.publisher.name ?? `@${p.publisher.githubLogin}`}
                </span>
                {p.publisher.isVerified ? (
                  <span
                    title="Verified publisher"
                    className="inline-flex items-center gap-0.5 text-emerald-300"
                  >
                    <BadgeCheck className="size-3.5" />
                  </span>
                ) : null}
                {p.sourceRepoUrl ? (
                  <a
                    href={p.sourceRepoUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1 font-mono text-primary hover:underline"
                  >
                    source <ExternalLink className="size-3" />
                  </a>
                ) : null}
              </div>
              {p.categories.length > 0 && (
                <div className="flex flex-wrap gap-1">
                  {p.categories.map((c) => (
                    <span
                      key={c}
                      className="text-[10px] font-mono uppercase tracking-wider px-1.5 py-0.5 rounded border border-border bg-muted/40 text-muted-foreground"
                    >
                      {c}
                    </span>
                  ))}
                </div>
              )}
              <Button
                size="sm"
                onClick={() => install(p.slug)}
                disabled={installing !== null}
              >
                {installing === p.slug ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : null}
                {installing === p.slug ? "Installing…" : "Install"}
              </Button>
            </li>
          ))}
        </ul>
      )}
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

function PricingPill({ pricing }: { pricing: string }) {
  const map: Record<
    string,
    { label: string; cls: string; icon: React.ComponentType<{ className?: string }> }
  > = {
    free: {
      label: "Free",
      cls: "border-emerald-500/30 bg-emerald-500/10 text-emerald-300",
      icon: Heart,
    },
    freemium: {
      label: "Freemium",
      cls: "border-sky-500/30 bg-sky-500/10 text-sky-300",
      icon: DollarSign,
    },
    paid: {
      label: "Paid",
      cls: "border-amber-500/30 bg-amber-500/10 text-amber-300",
      icon: DollarSign,
    },
  };
  const meta = map[pricing] ?? {
    label: pricing,
    cls: "border-border bg-muted text-muted-foreground",
    icon: DollarSign,
  };
  const Icon = meta.icon;
  return (
    <span
      className={`inline-flex items-center gap-1 text-[10px] font-mono uppercase tracking-wider px-1.5 py-0.5 rounded border ${meta.cls}`}
    >
      <Icon className="size-3" />
      {meta.label}
    </span>
  );
}

function LicensePill({
  license,
  sourceRepoUrl,
}: {
  license: string | null;
  sourceRepoUrl: string | null;
}) {
  if (!license) return null;
  const isProprietary = license === "Proprietary";
  const Icon = isProprietary ? Lock : Scale;
  const cls = isProprietary
    ? "border-amber-500/30 bg-amber-500/10 text-amber-300"
    : "border-violet-500/30 bg-violet-500/10 text-violet-300";
  const content = (
    <span
      className={`inline-flex items-center gap-1 text-[10px] font-mono uppercase tracking-wider px-1.5 py-0.5 rounded border ${cls}`}
    >
      <Icon className="size-3" />
      {license}
    </span>
  );
  if (!isProprietary && sourceRepoUrl) {
    return (
      <a
        href={sourceRepoUrl}
        target="_blank"
        rel="noreferrer"
        className="hover:opacity-80"
      >
        {content}
      </a>
    );
  }
  return content;
}

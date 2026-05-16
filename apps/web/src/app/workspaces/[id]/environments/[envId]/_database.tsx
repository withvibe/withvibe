"use client";

import { useState } from "react";
import { Copy, ExternalLink, Loader2, Play, Square } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import type { ContainerStatus } from "./_runtime";

export type DetectedDatabase = {
  service: string;
  engine: "postgres" | "mysql";
  internalPort: number;
  publishedPort: number | null;
  user: string;
  password: string;
  database: string;
};

export function DatabasePanel({
  workspaceId,
  envId,
  containerStatus,
  detectedDatabases,
  dbViewerPort,
  dbViewerStatus,
  onAction,
}: {
  workspaceId: string;
  envId: string;
  containerStatus: ContainerStatus;
  detectedDatabases: DetectedDatabase[] | null;
  dbViewerPort: number | null;
  dbViewerStatus: string | null;
  onAction: () => void | Promise<void>;
}) {
  const [acting, setActing] = useState(false);
  const dbs = detectedDatabases ?? [];
  const running = containerStatus === "running";
  const viewerRunning = dbViewerStatus === "running" && dbViewerPort != null;

  if (!running) {
    return (
      <Placeholder>
        Start the env to access its databases.
      </Placeholder>
    );
  }

  if (dbs.length === 0) {
    return (
      <Placeholder>
        No databases detected in this env&apos;s compose file. Add a postgres
        or mysql service — the DevOps agent in chat can help.
      </Placeholder>
    );
  }

  async function action(kind: "start" | "stop") {
    setActing(true);
    try {
      const res = await fetch(
        `/api/workspaces/${workspaceId}/envs/${envId}/db-viewer`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: kind }),
        }
      );
      if (!res.ok) {
        const text = await res.text();
        toast.error(text || `Failed to ${kind} viewer`);
        return;
      }
      toast.success(kind === "start" ? "Viewer started" : "Viewer stopped");
      await onAction();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setActing(false);
    }
  }

  // Same-origin proxied path — Next rewrites this to the api in dev, Traefik
  // routes it in prod. The old `http://127.0.0.1:<port>` was the *browser's*
  // own loopback, so "Open Adminer" only worked when the api ran locally.
  const viewerUrl = viewerRunning
    ? `/api/db-viewer/view/${envId}/`
    : null;

  return (
    <div className="p-4 space-y-4 overflow-auto h-full">
      <section className="space-y-2">
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <h3 className="text-xs font-mono font-semibold uppercase tracking-wide text-muted-foreground">
            Databases detected
          </h3>
          <div className="flex items-center gap-2">
            {viewerUrl ? (
              <>
                <Button
                  size="sm"
                  variant="default"
                  render={<a href={viewerUrl} target="_blank" rel="noreferrer" />}
                >
                  <ExternalLink className="size-4" />
                  Open Adminer
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => action("stop")}
                  disabled={acting}
                >
                  {acting ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : (
                    <Square className="size-4" />
                  )}
                  Stop viewer
                </Button>
              </>
            ) : (
              <Button
                size="sm"
                variant="outline"
                onClick={() => action("start")}
                disabled={acting}
              >
                {acting ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <Play className="size-4" />
                )}
                Start viewer
              </Button>
            )}
          </div>
        </div>
        <p className="text-[11px] text-muted-foreground">
          {viewerUrl
            ? `Adminer is running at 127.0.0.1:${dbViewerPort}. It opens in a new tab — use the credentials below to log in. Adminer stops automatically when the env stops.`
            : "Starts an Adminer container attached to this env's compose network. Tables, queries, rows — all in the browser. Adminer stops automatically when the env stops."}
        </p>
      </section>

      <ul className="space-y-3">
        {dbs.map((d) => (
          <DbCard key={d.service} db={d} />
        ))}
      </ul>
    </div>
  );
}

function DbCard({ db }: { db: DetectedDatabase }) {
  const scheme = db.engine === "postgres" ? "postgres" : "mysql";
  const creds = `${encodeURIComponent(db.user)}${db.password ? `:${encodeURIComponent(db.password)}` : ""}`;
  const dbPath = db.database ? `/${db.database}` : "";
  const internalUrl = `${scheme}://${creds}@${db.service}:${db.internalPort}${dbPath}`;
  const hostUrl =
    db.publishedPort !== null
      ? `${scheme}://${creds}@localhost:${db.publishedPort}${dbPath}`
      : null;

  return (
    <li className="rounded-md border bg-card p-3 space-y-2">
      <div className="flex items-center gap-2">
        <span className="text-sm font-mono font-medium">{db.service}</span>
        <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-muted border text-muted-foreground uppercase">
          {db.engine}
        </span>
      </div>

      <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[11px] font-mono">
        <Field label="user" value={db.user} />
        <Field
          label="password"
          value={db.password || "(none)"}
          hidden={!!db.password}
        />
        {db.database && <Field label="database" value={db.database} />}
      </div>

      <div className="space-y-1.5">
        <UrlRow label="From the host" url={hostUrl} />
        <UrlRow label="Inside compose network" url={internalUrl} />
      </div>
    </li>
  );
}

function Field({
  label,
  value,
  hidden,
}: {
  label: string;
  value: string;
  hidden?: boolean;
}) {
  const [revealed, setRevealed] = useState(false);
  const display = hidden && !revealed ? "•".repeat(Math.min(value.length, 10)) : value;
  return (
    <>
      <span className="text-muted-foreground">{label}</span>
      <span className="flex items-center gap-2 min-w-0">
        <code className="truncate text-foreground">{display}</code>
        {hidden && (
          <button
            type="button"
            onClick={() => setRevealed((v) => !v)}
            className="text-[10px] text-muted-foreground hover:text-foreground shrink-0"
          >
            {revealed ? "hide" : "reveal"}
          </button>
        )}
        <button
          type="button"
          onClick={() => {
            navigator.clipboard.writeText(value);
            toast.success(`${label} copied`);
          }}
          className="text-muted-foreground hover:text-foreground shrink-0"
          title={`Copy ${label}`}
        >
          <Copy className="size-3" />
        </button>
      </span>
    </>
  );
}

function UrlRow({ label, url }: { label: string; url: string | null }) {
  if (!url) {
    return (
      <div className="text-[11px] text-muted-foreground italic">
        {label}: not exposed to the host — add a `ports:` entry to the compose
        service to connect from a local DB client.
      </div>
    );
  }
  return (
    <div className="text-[11px]">
      <div className="text-muted-foreground font-mono mb-0.5">{label}</div>
      <div className="flex items-center gap-2 rounded border bg-muted/30 px-2 py-1">
        <code className="truncate flex-1 font-mono text-foreground/90">{url}</code>
        <button
          type="button"
          onClick={() => {
            navigator.clipboard.writeText(url);
            toast.success("URL copied");
          }}
          className="text-muted-foreground hover:text-foreground shrink-0"
          title="Copy URL"
        >
          <Copy className="size-3" />
        </button>
      </div>
    </div>
  );
}

function Placeholder({ children }: { children: React.ReactNode }) {
  return (
    <div className="h-full min-h-[400px] flex items-center justify-center text-center p-8 text-sm text-muted-foreground bg-muted/10">
      {children}
    </div>
  );
}

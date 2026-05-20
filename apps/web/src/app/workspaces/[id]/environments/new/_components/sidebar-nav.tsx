"use client";

import { Check, Circle, AlertCircle, FolderOpen } from "lucide-react";
import { cn } from "@/lib/utils";

export type SectionKey = "basics" | "code" | "runtime" | "advanced";

export type SectionStatus = "complete" | "incomplete" | "warning" | "optional";

export type SectionEntry = {
  key: SectionKey;
  label: string;
  status: SectionStatus;
  hint?: string;
};

export function SidebarNav({
  sections,
  activeKey,
  onSelect,
  files,
}: {
  sections: SectionEntry[];
  activeKey: SectionKey;
  onSelect: (key: SectionKey) => void;
  /** Optional file tree — shown when no template owns the compose. */
  files?: ReactFilesProps;
}) {
  return (
    <div className="py-3 text-sm">
      <SectionGroup title="Setup">
        {sections.map((s) => (
          <SectionRow
            key={s.key}
            entry={s}
            active={s.key === activeKey}
            onClick={() => onSelect(s.key)}
          />
        ))}
      </SectionGroup>

      {files && (
        <SectionGroup title="Files">
          <FilesPlaceholder {...files} />
        </SectionGroup>
      )}
    </div>
  );
}

function SectionGroup({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="mb-2">
      <div className="px-3 pt-2 pb-1 text-[10px] font-mono uppercase tracking-wider text-muted-foreground">
        {title}
      </div>
      <div className="flex flex-col">{children}</div>
    </div>
  );
}

function SectionRow({
  entry,
  active,
  onClick,
}: {
  entry: SectionEntry;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex items-center gap-2 px-3 py-1.5 text-left transition-colors text-sm border-l-2",
        active
          ? "bg-foreground/[0.06] border-foreground/40 text-foreground"
          : "border-transparent hover:bg-foreground/[0.04] text-muted-foreground hover:text-foreground"
      )}
      title={entry.hint}
    >
      <StatusDot status={entry.status} />
      <span className="font-mono">{entry.label}</span>
    </button>
  );
}

function StatusDot({ status }: { status: SectionStatus }) {
  if (status === "complete") {
    return <Check className="size-3.5 text-emerald-700/80 dark:text-emerald-500/80 shrink-0" />;
  }
  if (status === "warning") {
    return <AlertCircle className="size-3.5 text-yellow-600 dark:text-yellow-400 shrink-0" />;
  }
  if (status === "incomplete") {
    return <Circle className="size-3.5 text-muted-foreground/60 shrink-0" />;
  }
  return <Circle className="size-3.5 text-muted-foreground/30 shrink-0" />;
}

type ReactFilesProps = {
  // Phase 1 placeholder — Phase 3 will replace this with a real tree.
  composePresent: boolean;
  assetCount: number;
  onOpenAdvanced: () => void;
};

function FilesPlaceholder({
  composePresent,
  assetCount,
  onOpenAdvanced,
}: ReactFilesProps) {
  return (
    <button
      type="button"
      onClick={onOpenAdvanced}
      className="flex items-start gap-2 px-3 py-2 text-left hover:bg-accent/50 transition-colors text-xs text-muted-foreground hover:text-foreground"
    >
      <FolderOpen className="size-3.5 shrink-0 mt-0.5" />
      <div className="space-y-0.5">
        <div className="font-mono text-foreground/80">
          {composePresent ? "docker-compose.yml" : "no compose yet"}
        </div>
        <div className="text-[11px]">
          {assetCount > 0
            ? `${assetCount} asset${assetCount === 1 ? "" : "s"} staged`
            : "configure in Advanced"}
        </div>
      </div>
    </button>
  );
}

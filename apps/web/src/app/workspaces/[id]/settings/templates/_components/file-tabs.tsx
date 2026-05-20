"use client";

import { FileCode, File as FileIcon, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { COMPOSE_PATH } from "./sidebar-files";

function basename(p: string) {
  const i = p.lastIndexOf("/");
  return i === -1 ? p : p.slice(i + 1);
}

function labelFor(path: string) {
  if (path === COMPOSE_PATH) return "docker-compose.yml";
  return basename(path);
}

/**
 * VS Code-style tab strip. Each entry is one open file; click to activate,
 * × to close. The active tab borders the bottom to "merge" into the editor
 * below it.
 */
export function FileTabs({
  openFiles,
  activeFile,
  onActivate,
  onClose,
}: {
  openFiles: string[];
  activeFile: string | null;
  onActivate: (path: string) => void;
  onClose: (path: string) => void;
}) {
  if (openFiles.length === 0) return null;
  return (
    <div className="shrink-0 flex items-stretch border-b border-border/60 bg-card/40 overflow-x-auto">
      {openFiles.map((path) => {
        const active = path === activeFile;
        const isCompose = path === COMPOSE_PATH;
        return (
          <div
            key={path}
            className={cn(
              "group flex items-center gap-2 pl-3 pr-1 py-2 border-r border-border/60 text-sm cursor-pointer transition-colors",
              active
                ? "bg-background text-foreground border-b-0 -mb-px"
                : "text-muted-foreground hover:bg-foreground/[0.03] hover:text-foreground"
            )}
            onClick={() => onActivate(path)}
            title={path}
          >
            {isCompose ? (
              <FileCode className="size-3.5 text-muted-foreground shrink-0" />
            ) : (
              <FileIcon className="size-3.5 text-muted-foreground shrink-0" />
            )}
            <span className="font-mono whitespace-nowrap">
              {labelFor(path)}
            </span>
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onClose(path);
              }}
              className="ml-1 size-5 rounded hover:bg-foreground/10 inline-flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
              aria-label={`Close ${labelFor(path)}`}
              title="Close"
            >
              <X className="size-3" />
            </button>
          </div>
        );
      })}
    </div>
  );
}

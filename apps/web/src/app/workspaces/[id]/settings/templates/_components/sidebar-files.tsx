"use client";

import { FileCode } from "lucide-react";
import { cn } from "@/lib/utils";
import { AssetTree } from "../asset-tree";
import type { EditorAsset } from "../template-editor";

export const COMPOSE_PATH = "$compose";

/**
 * Sidebar file panel: a fixed `docker-compose.yml` row up top, the embedded
 * AssetTree below. Selecting a row tells the parent which file to open as a
 * Monaco tab in the center pane.
 *
 * The compose pseudo-path `$compose` distinguishes the compose file from
 * any asset path (`$` is forbidden by `validateName`, so no real asset can
 * ever collide).
 */
export function SidebarFiles({
  assets,
  onAssetsChange,
  activeFile,
  onOpenFile,
  composePresent,
}: {
  assets: EditorAsset[];
  onAssetsChange: (next: EditorAsset[]) => void;
  activeFile: string | null;
  onOpenFile: (path: string) => void;
  composePresent: boolean;
}) {
  return (
    <div className="text-sm">
      <div className="px-3 pt-2 pb-1 text-[10px] font-mono uppercase tracking-wider text-muted-foreground">
        Files
      </div>

      <button
        type="button"
        onClick={() => onOpenFile(COMPOSE_PATH)}
        className={cn(
          "w-full flex items-center gap-2 px-3 py-1.5 text-left transition-colors border-l-2",
          activeFile === COMPOSE_PATH
            ? "bg-foreground/[0.06] border-foreground/40 text-foreground"
            : "border-transparent hover:bg-foreground/[0.04] text-muted-foreground hover:text-foreground"
        )}
      >
        <FileCode className="size-3.5 shrink-0" />
        <span className="font-mono text-xs truncate">docker-compose.yml</span>
        {!composePresent && (
          <span className="ml-auto text-[10px] text-muted-foreground/70">
            empty
          </span>
        )}
      </button>

      <div className="px-2 pt-2">
        <AssetTree
          assets={assets}
          onChange={onAssetsChange}
          variant="embedded"
          selectedPath={
            activeFile && activeFile !== COMPOSE_PATH ? activeFile : null
          }
          onSelectFile={onOpenFile}
        />
      </div>
    </div>
  );
}

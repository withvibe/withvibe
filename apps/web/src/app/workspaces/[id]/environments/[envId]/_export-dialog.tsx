"use client";

import { useState } from "react";
import { Check, Copy } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

// Shown when the user clicks "Export" on an env detail page. The CLI handles
// auth separately via `withvibe login` (device flow), so we only hand over
// the envId — no per-env token minted here.
export function ExportDialog({
  open,
  onOpenChange,
  envId,
  envTitle,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  envId: string;
  envTitle: string;
}) {
  const command = `withvibe env ${envId}`;
  const [copied, setCopied] = useState(false);

  async function copyCommand() {
    await navigator.clipboard.writeText(command);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Run this env on your machine</DialogTitle>
          <DialogDescription>
            The CLI clones the repos, allocates free local ports, starts docker
            compose, and opens{" "}
            <span className="font-mono text-foreground">{envTitle}</span> in
            VSCode.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 mt-2">
          <div className="flex items-center gap-2">
            <code className="flex-1 font-mono text-xs bg-muted rounded-md border px-3 py-2 truncate">
              {command}
            </code>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={copyCommand}
              className="shrink-0"
            >
              {copied ? (
                <>
                  <Check className="size-3.5" /> Copied
                </>
              ) : (
                <>
                  <Copy className="size-3.5" /> Copy
                </>
              )}
            </Button>
          </div>

          <div className="space-y-2">
            <p className="text-xs font-medium">First time?</p>
            <ul className="space-y-1.5 pl-4 list-disc text-xs text-muted-foreground">
              <li>
                Install the CLI:{" "}
                <code className="font-mono text-foreground">
                  npm i -g withvibe
                </code>
              </li>
              <li>
                Authorize this machine once:{" "}
                <code className="font-mono text-foreground">
                  withvibe login
                </code>
              </li>
              <li>
                <strong className="text-foreground">Docker Desktop</strong>,{" "}
                <strong className="text-foreground">Git</strong>, and{" "}
                <strong className="text-foreground">VSCode</strong> — the CLI
                offers to install any that are missing
              </li>
            </ul>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

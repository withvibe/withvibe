"use client";

import { useState } from "react";
import { Code2, ExternalLink, Globe, Laptop, Loader2, LogOut } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useDemoMode } from "../../_demo-mode";
import type { ContainerStatus } from "./_runtime";

type TunnelAuthDialogState =
  | { open: false }
  | { open: true; loginUrl: string; loginCode: string };

type CodeServerResponse = { ok?: boolean; url?: string; error?: string };

type CodeTunnelResponse = {
  ok?: boolean;
  status?: "running" | "needs_auth";
  tunnelName?: string;
  vscodeUri?: string;
  vscodeDevUrl?: string;
  loginUrl?: string;
  loginCode?: string;
  error?: string;
};

function safeJson<T>(text: string): T | null {
  if (!text) return null;
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

export function VsCodeMenu({
  workspaceId,
  envId,
  containerStatus,
}: {
  workspaceId: string;
  envId: string;
  containerStatus: ContainerStatus;
}) {
  const [busy, setBusy] = useState<null | "browser" | "desktop" | "vscodedev">(
    null
  );
  const [authDialog, setAuthDialog] = useState<TunnelAuthDialogState>({
    open: false,
  });
  // The tunnel sidecar bind-mounts every workspace's clones, so it's hidden on
  // the shared demo deployment. The api also blocks `start` server-side; this
  // is the cosmetic mirror. code-server (Browser) stays — it's per-env scoped.
  const demoMode = useDemoMode();

  const isRunning = containerStatus === "running";

  async function openInBrowser() {
    if (!isRunning) {
      toast.error("Start the env first to open VS Code in the browser.");
      return;
    }
    setBusy("browser");
    try {
      const res = await fetch(
        `/api/workspaces/${workspaceId}/envs/${envId}/code-server`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "start" }),
        }
      );
      const text = await res.text();
      const json = safeJson<CodeServerResponse>(text);
      if (!res.ok || !json?.url) {
        toast.error(json?.error || text || "Failed to start code-server");
        return;
      }
      // Full new tab — user explicitly asked NOT to embed in an iframe.
      window.open(json.url, "_blank", "noopener");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  async function startTunnel(
    target: "desktop" | "vscodedev"
  ): Promise<void> {
    setBusy(target);
    try {
      const res = await fetch(
        `/api/workspaces/${workspaceId}/envs/${envId}/code-tunnel`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "start" }),
        }
      );
      const text = await res.text();
      const json = safeJson<CodeTunnelResponse>(text);
      if (!res.ok && json?.status !== "needs_auth") {
        toast.error(json?.error || text || "Failed to start tunnel");
        return;
      }
      if (json?.status === "needs_auth" && json.loginUrl && json.loginCode) {
        setAuthDialog({
          open: true,
          loginUrl: json.loginUrl,
          loginCode: json.loginCode,
        });
        return;
      }
      if (json?.status !== "running") {
        toast.error("Tunnel response missing expected fields");
        return;
      }
      if (target === "desktop" && json.vscodeUri) {
        window.location.href = json.vscodeUri;
        toast.success("Opening VS Code on your computer…");
        return;
      }
      if (target === "vscodedev" && json.vscodeDevUrl) {
        window.open(json.vscodeDevUrl, "_blank", "noopener");
        toast.success("Opening vscode.dev in a new tab…");
        return;
      }
      toast.error("Tunnel response missing expected fields");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  const openInDesktop = () => startTunnel("desktop");
  const openInVscodeDev = () => startTunnel("vscodedev");

  async function logoutTunnel() {
    try {
      await fetch(
        `/api/workspaces/${workspaceId}/envs/${envId}/code-tunnel/logout`,
        { method: "POST" }
      );
      toast.success("Tunnel auth cleared. You'll be asked to sign in next time.");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          className={cn(
            "inline-flex items-center justify-center size-8 rounded-md transition-smooth relative",
            "text-muted-foreground hover:text-primary hover:bg-muted",
            "data-[popup-open]:bg-primary/10 data-[popup-open]:text-primary"
          )}
          title="Open in VS Code"
          aria-label="Open in VS Code"
        >
          {busy ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <Code2 className="size-4" />
          )}
        </DropdownMenuTrigger>
        <DropdownMenuContent side="left" align="start" sideOffset={8}>
          <DropdownMenuGroup>
            <DropdownMenuLabel>Open in VS Code</DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              disabled={!isRunning || busy !== null}
              onClick={openInBrowser}
            >
              <Globe className="size-4" />
              <div className="flex flex-col">
                <span className="font-medium">Browser</span>
                <span className="text-[11px] text-muted-foreground">
                  code-server in a new tab
                </span>
              </div>
            </DropdownMenuItem>
            {/* VS Code Tunnel options. In the live demo these are shown but
                disabled — the tunnel needs a one-time GitHub device sign-in
                that doesn't fit a shared demo — so visitors can still see the
                feature exists. The `demoMode` guards below set disabled + a
                "Demo" badge and swap the subtext to the reason. */}
            <DropdownMenuItem
              disabled={demoMode || busy !== null}
              onClick={demoMode ? undefined : openInDesktop}
            >
              <Laptop className="size-4" />
              <div className="flex flex-col">
                <span className="flex items-center gap-1.5 font-medium">
                  Desktop
                  {demoMode && (
                    <Badge variant="outline" className="px-1 py-0 text-[10px]">
                      Demo
                    </Badge>
                  )}
                </span>
                <span className="text-[11px] text-muted-foreground">
                  {demoMode
                    ? "Not available in the live demo"
                    : "via VS Code Tunnel (your local app)"}
                </span>
              </div>
            </DropdownMenuItem>
            <DropdownMenuItem
              disabled={demoMode || busy !== null}
              onClick={demoMode ? undefined : openInVscodeDev}
            >
              <ExternalLink className="size-4" />
              <div className="flex flex-col">
                <span className="flex items-center gap-1.5 font-medium">
                  vscode.dev (browser)
                  {demoMode && (
                    <Badge variant="outline" className="px-1 py-0 text-[10px]">
                      Demo
                    </Badge>
                  )}
                </span>
                <span className="text-[11px] text-muted-foreground">
                  {demoMode
                    ? "Not available in the live demo"
                    : "same tunnel, no local VS Code needed"}
                </span>
              </div>
            </DropdownMenuItem>
            {!demoMode && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={logoutTunnel}>
                  <LogOut className="size-4" />
                  <span>Sign out of tunnel auth</span>
                </DropdownMenuItem>
              </>
            )}
          </DropdownMenuGroup>
        </DropdownMenuContent>
      </DropdownMenu>

      <Dialog
        open={authDialog.open}
        onOpenChange={(open) => {
          if (!open) setAuthDialog({ open: false });
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>One-time tunnel sign-in</DialogTitle>
            <DialogDescription>
              VS Code Tunnel needs to authenticate with GitHub once. After
              that, your auth is remembered and future env opens are instant.
            </DialogDescription>
          </DialogHeader>
          {authDialog.open && (
            <div className="space-y-4">
              <ol className="list-decimal pl-5 text-sm space-y-1">
                <li>
                  Open{" "}
                  <a
                    href={authDialog.loginUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="text-primary underline"
                  >
                    {authDialog.loginUrl}
                  </a>
                </li>
                <li>
                  Enter this code:{" "}
                  <code className="px-2 py-0.5 rounded bg-muted text-foreground font-mono">
                    {authDialog.loginCode}
                  </code>
                </li>
                <li>
                  Click &ldquo;Try again&rdquo; below once GitHub confirms the
                  device.
                </li>
              </ol>
              <DialogFooter>
                <Button
                  variant="outline"
                  onClick={() => setAuthDialog({ open: false })}
                >
                  Cancel
                </Button>
                <Button
                  onClick={() => {
                    setAuthDialog({ open: false });
                    openInDesktop();
                  }}
                >
                  Try again
                </Button>
              </DialogFooter>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}

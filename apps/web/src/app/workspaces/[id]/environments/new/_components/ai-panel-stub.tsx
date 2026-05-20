"use client";

import { Sparkles, Send } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";

/**
 * Phase-1 stub: visible-but-inert AI panel so the layout is in place. Phase 4
 * replaces this with a wired AssistantPanel that calls the env-assist endpoint
 * and proposes tool calls (setComposeFile, writeAsset, setTitle, …) the user
 * accepts or rejects.
 */
export function AiPanelStub() {
  return (
    <>
      <div className="border-b border-border/60 px-4 py-3">
        <div className="flex items-center gap-2 text-sm font-medium">
          <Sparkles className="size-4 text-primary" /> DevOps
        </div>
        <p className="text-xs text-muted-foreground mt-1">
          Describe what you want and I&apos;ll set up the stack — services,
          ports, env vars, assets.
        </p>
      </div>

      <div className="flex-1 overflow-y-auto p-4 space-y-3">
        <div className="text-xs text-muted-foreground">Try:</div>
        <div className="space-y-2">
          {[
            "Spin up a Next.js app with Postgres and Redis",
            "Add an nginx reverse-proxy in front of the api service",
            "Generate an init.sql that creates a users table",
            "Wire up MailHog for local email testing",
          ].map((p) => (
            <button
              key={p}
              type="button"
              disabled
              className="block w-full text-left rounded-md border border-border/60 bg-background/40 px-3 py-2 text-xs text-muted-foreground/70 cursor-not-allowed"
              title="Coming next — Phase 4 wires the assistant in."
            >
              {p}
            </button>
          ))}
        </div>
        <div className="rounded-md border border-dashed border-border/60 p-3 text-xs text-muted-foreground">
          DevOps goes live once Phase 4 is wired up. The panel space is
          reserved so you can see how the layout breathes.
        </div>
      </div>

      <div className="border-t border-border/60 p-3 space-y-2">
        <Textarea
          rows={3}
          disabled
          placeholder="Ask DevOps…  (coming soon)"
          className="text-sm resize-none [field-sizing:fixed]"
        />
        <div className="flex justify-end">
          <Button type="button" size="sm" disabled>
            <Send className="size-4" /> Send
          </Button>
        </div>
      </div>
    </>
  );
}

"use client";

import { logout, useUser } from "@/lib/auth-client";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import Link from "next/link";
import { LogOut } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Brand } from "@/components/brand";
import { AmbientBackground } from "@/components/auth/app-preview";

export default function NewWorkspacePage() {
  const { status } = useUser();
  const router = useRouter();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (status === "unauthenticated") router.push("/login");
  }, [status, router]);

  // Demo mode: visitors are auto-provisioned a single workspace and can't
  // create more (the api enforces this). Best-effort UI redirect to home;
  // NEXT_PUBLIC_DEMO_MODE is build-time-inlined, so the server 403 below is the
  // authoritative guard for from-registry images.
  useEffect(() => {
    if (process.env.NEXT_PUBLIC_DEMO_MODE === "true") router.replace("/");
  }, [router]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError("");

    const res = await fetch("/api/workspaces", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, description }),
    });

    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      setError(data.error || "Failed to create workspace");
      setLoading(false);
      return;
    }

    const { id } = await res.json();
    router.push(`/workspaces/${id}`);
  }

  if (status !== "authenticated") {
    return (
      <div className="min-h-screen flex items-center justify-center text-muted-foreground text-sm">
        Loading...
      </div>
    );
  }

  return (
    <div className="relative min-h-screen flex flex-col overflow-hidden bg-background">
      <AmbientBackground />

      <header className="relative z-10 flex items-center justify-between px-6 sm:px-10 h-16 border-b border-border/40 backdrop-blur-sm">
        <Link href="/" className="transition-smooth hover:opacity-80">
          <Brand />
        </Link>
        <Button
          variant="ghost"
          size="sm"
          onClick={async () => {
            await logout();
            router.push("/login");
          }}
        >
          <LogOut className="size-4" />
          Sign out
        </Button>
      </header>

      <main className="relative z-10 flex-1 flex items-center justify-center px-6 py-10 sm:py-16">
        <div
          className="animate-fade-up w-full max-w-lg"
          style={{ animationDelay: "80ms" }}
        >
          <div className="relative rounded-2xl border border-border/60 bg-card/40 p-8 shadow-2xl backdrop-blur-xl">
            <div className="pointer-events-none absolute -inset-px -z-10 rounded-2xl bg-gradient-to-br from-primary/30 via-transparent to-accent/20 opacity-60 blur-md" />

            <div
              className="animate-fade-up font-mono text-[10px] uppercase tracking-wider text-muted-foreground"
              style={{ animationDelay: "140ms" }}
            >
              Step 1 · Set up your workspace
            </div>
            <h1
              className="animate-fade-up mt-2 font-mono text-3xl font-bold tracking-tight"
              style={{ animationDelay: "180ms" }}
            >
              Create a workspace
            </h1>
            <p
              className="animate-fade-up mt-2 text-sm text-muted-foreground"
              style={{ animationDelay: "240ms" }}
            >
              A workspace is your R&amp;D team. Invite teammates afterwards.
            </p>

            <form
              onSubmit={handleSubmit}
              className="animate-fade-up mt-8 space-y-5"
              style={{ animationDelay: "300ms" }}
            >
              {error && (
                <Alert variant="destructive">
                  <AlertDescription>{error}</AlertDescription>
                </Alert>
              )}

              <div className="space-y-2">
                <Label
                  htmlFor="name"
                  className="font-mono text-xs uppercase tracking-wider text-muted-foreground"
                >
                  Workspace name
                </Label>
                <Input
                  id="name"
                  required
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Acme R&D"
                  className="bg-background/60 h-11"
                />
              </div>

              <div className="space-y-2">
                <Label
                  htmlFor="description"
                  className="font-mono text-xs uppercase tracking-wider text-muted-foreground"
                >
                  Description{" "}
                  <span className="lowercase tracking-normal text-muted-foreground/70">
                    (optional)
                  </span>
                </Label>
                <Textarea
                  id="description"
                  rows={2}
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="What does this team work on?"
                  className="bg-background/60"
                />
              </div>

              <Button
                type="submit"
                className="glow-primary transition-smooth h-11 w-full font-mono font-semibold hover:brightness-110"
                disabled={loading}
              >
                {loading ? (
                  <span className="inline-flex items-center gap-2">
                    <span className="size-2 animate-ping rounded-full bg-primary-foreground" />
                    Creating…
                  </span>
                ) : (
                  "Create workspace →"
                )}
              </Button>
            </form>
          </div>
        </div>
      </main>
    </div>
  );
}

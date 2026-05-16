"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Brand } from "@/components/brand";
import {
  AmbientBackground,
  AppPreview,
  FeatureChips,
} from "@/components/auth/app-preview";
import { PositionSelect } from "@/components/profile/position-select";

function RegisterForm() {
  const router = useRouter();
  const params = useSearchParams();
  const invite = params.get("invite");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [positions, setPositions] = useState<string[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError("");

    try {
      const res = await fetch("/api/auth/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password, name, positions }),
      });

      if (!res.ok) {
        const data = await res
          .json()
          .catch(() => ({}) as { message?: string; error?: string });
        setError(data.message || data.error || "Registration failed");
        return;
      }

      const next = invite ? `/login?invite=${invite}` : "/login?registered=true";
      router.push(next);
    } catch {
      setError("Network error — please try again");
    } finally {
      setLoading(false);
    }
  }

  const loginHref = invite ? `/login?invite=${invite}` : "/login";

  return (
    <div className="relative min-h-svh flex flex-col overflow-hidden bg-background">
      <AmbientBackground />

      <header className="relative z-10 flex items-center justify-between px-4 sm:px-6 lg:px-10 h-14 sm:h-16 border-b border-border/40 backdrop-blur-sm">
        <Link href="/" className="transition-smooth hover:opacity-80">
          <Brand />
        </Link>
        <span className="hidden sm:inline-flex items-center gap-2 font-mono text-xs text-muted-foreground">
          <span className="animate-pulse-dot inline-block size-1.5 rounded-full bg-accent" />
          online
        </span>
      </header>

      <main className="relative z-10 flex-1 flex items-center justify-center px-4 py-8 sm:px-6 sm:py-12 lg:px-10 lg:py-10 xl:py-16">
        <div className="mx-auto grid w-full max-w-6xl xl:max-w-7xl 2xl:max-w-[88rem] gap-8 lg:gap-12 xl:gap-24 lg:grid-cols-2 lg:items-center">
          <div className="hidden lg:flex lg:justify-center">
            <div className="w-full max-w-[26rem] xl:max-w-[34rem] 2xl:max-w-2xl">
              <AppPreview />
            </div>
          </div>

          <div>
            <div
              className="animate-fade-up mx-auto w-full max-w-md lg:max-w-lg xl:max-w-xl"
              style={{ animationDelay: "80ms" }}
            >
              <div className="relative rounded-2xl border border-border/60 bg-card/40 p-5 sm:p-8 lg:p-10 xl:p-12 shadow-2xl backdrop-blur-xl">
                <div className="pointer-events-none absolute -inset-px -z-10 rounded-2xl bg-gradient-to-br from-primary/30 via-transparent to-accent/20 opacity-60 blur-md" />

                <h1
                  className="animate-fade-up font-mono text-2xl sm:text-3xl xl:text-4xl font-bold tracking-tight"
                  style={{ animationDelay: "160ms" }}
                >
                  Create your account
                </h1>
                <p
                  className="animate-fade-up mt-2 text-sm text-muted-foreground"
                  style={{ animationDelay: "280ms" }}
                >
                  {invite
                    ? "Sign up to join the workspace."
                    : "Vibe code as a team. In isolated environments."}
                </p>

                <form
                  onSubmit={handleSubmit}
                  className="animate-fade-up mt-6 sm:mt-8 space-y-5"
                  style={{ animationDelay: "340ms" }}
                >
                  {error && (
                    <Alert variant="destructive">
                      <AlertDescription>{error}</AlertDescription>
                    </Alert>
                  )}

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    <div className="space-y-2">
                      <Label
                        htmlFor="name"
                        className="font-mono text-xs uppercase tracking-wider text-muted-foreground"
                      >
                        Name
                      </Label>
                      <Input
                        id="name"
                        type="text"
                        value={name}
                        onChange={(e) => setName(e.target.value)}
                        autoComplete="name"
                        placeholder="Your name"
                        className="bg-background/60 h-11 lg:h-12"
                      />
                    </div>
                    <div className="space-y-2">
                      <Label
                        htmlFor="email"
                        className="font-mono text-xs uppercase tracking-wider text-muted-foreground"
                      >
                        Email
                      </Label>
                      <Input
                        id="email"
                        type="email"
                        required
                        value={email}
                        onChange={(e) => setEmail(e.target.value)}
                        autoComplete="email"
                        placeholder="you@company.com"
                        className="bg-background/60 h-11 lg:h-12"
                      />
                    </div>
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 items-start">
                    <div className="space-y-2">
                      <Label
                        htmlFor="password"
                        className="font-mono text-xs uppercase tracking-wider text-muted-foreground"
                      >
                        Password
                      </Label>
                      <Input
                        id="password"
                        type="password"
                        required
                        minLength={8}
                        value={password}
                        onChange={(e) => setPassword(e.target.value)}
                        autoComplete="new-password"
                        placeholder="At least 8 characters"
                        className="bg-background/60 h-11 lg:h-12"
                      />
                    </div>
                    <PositionSelect
                      positions={positions}
                      onPositionsChange={setPositions}
                      label="Role"
                      labelClassName="font-mono text-xs uppercase tracking-wider text-muted-foreground"
                    />
                  </div>

                  <Button
                    type="submit"
                    className="glow-primary transition-smooth h-11 lg:h-12 w-full sm:w-auto sm:min-w-48 sm:mx-auto sm:flex px-8 font-mono font-semibold hover:brightness-110"
                    disabled={loading}
                  >
                    {loading ? (
                      <span className="inline-flex items-center gap-2">
                        <span className="size-2 animate-ping rounded-full bg-primary-foreground" />
                        Creating account…
                      </span>
                    ) : (
                      "Create account →"
                    )}
                  </Button>
                </form>

                <p
                  className="animate-fade-up mt-6 text-center text-sm text-muted-foreground"
                  style={{ animationDelay: "420ms" }}
                >
                  Already have an account?{" "}
                  <Link
                    href={loginHref}
                    className="transition-smooth font-medium text-primary hover:underline hover:text-primary/90"
                  >
                    Sign in
                  </Link>
                </p>
              </div>

              <div
                className="animate-fade-up mt-6"
                style={{ animationDelay: "500ms" }}
              >
                <FeatureChips />
              </div>
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}

export default function RegisterPage() {
  return (
    <Suspense fallback={null}>
      <RegisterForm />
    </Suspense>
  );
}

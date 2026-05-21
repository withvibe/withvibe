"use client";

import {
  LoginTimeoutError,
  ServerStartingError,
  login as loginApi,
} from "@/lib/auth-client";
import { useSearchParams } from "next/navigation";
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

function LoginForm() {
  const params = useSearchParams();
  const invite = params.get("invite");
  const next = params.get("next");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError("");

    try {
      await loginApi(email, password);
      const dest = invite
        ? `/invite/${invite}`
        : next && next.startsWith("/")
          ? next
          : "/";
      // Hard navigation, not router.push: Next.js prefetches the destination
      // at /login mount time WHILE THE USER IS STILL UNAUTHENTICATED. The
      // cached RSC payload for `/` therefore contains the server-side
      // `redirect("/login")` from when the API said 401 — and router.push
      // honors that stale cache, bouncing the user right back to /login
      // (silently, so the spinner stays spinning forever). A hard nav
      // forces a fresh request with the new session cookie, sidestepping
      // the prefetch entirely.
      window.location.assign(dest);
    } catch (err) {
      if (err instanceof ServerStartingError) {
        // Fresh-install bringup case — the API container is up but Prisma is
        // still establishing its connection (retry budget ~30s). Tell the
        // user explicitly instead of letting them think their password is
        // wrong.
        setError(
          "Server is still starting. Please wait a few seconds and try again."
        );
      } else if (err instanceof LoginTimeoutError) {
        setError(
          "Login request timed out. Check that the server is reachable, then try again."
        );
      } else {
        setError("Invalid email or password");
      }
      setLoading(false);
    }
  }

  const registerHref = invite ? `/register?invite=${invite}` : "/register";

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
                  Welcome back
                </h1>
                <p
                  className="animate-fade-up mt-2 text-sm text-muted-foreground"
                  style={{ animationDelay: "280ms" }}
                >
                  {invite
                    ? "Sign in to accept your invitation."
                    : "Vibe code as a team. In isolated environments."}
                </p>

                <form
                  onSubmit={handleSubmit}
                  className="animate-fade-up mt-6 sm:mt-8 space-y-4"
                  style={{ animationDelay: "340ms" }}
                >
                  {error && (
                    <Alert variant="destructive">
                      <AlertDescription>{error}</AlertDescription>
                    </Alert>
                  )}

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
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      autoComplete="current-password"
                      className="bg-background/60 h-11 lg:h-12"
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
                        Authenticating…
                      </span>
                    ) : (
                      "Sign in →"
                    )}
                  </Button>
                </form>

                <p
                  className="animate-fade-up mt-6 text-center text-sm text-muted-foreground"
                  style={{ animationDelay: "420ms" }}
                >
                  New here?{" "}
                  <Link
                    href={registerHref}
                    className="transition-smooth font-medium text-primary hover:underline hover:text-primary/90"
                  >
                    Create an account
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

export default function LoginPage() {
  return (
    <Suspense fallback={null}>
      <LoginForm />
    </Suspense>
  );
}

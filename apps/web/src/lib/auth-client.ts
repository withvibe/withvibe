"use client";

import { useEffect, useRef, useState } from "react";
import { redirectToLogin } from "./fetch-client";

export type ClientUser = {
  id: string;
  email: string;
  name: string | null;
  defaultWorkspaceId: string | null;
};

export type AuthStatus = "loading" | "authenticated" | "unauthenticated";

/**
 * Client-side auth helpers. All of these talk to NestJS through the same
 * `/api/*` paths the browser already uses for the rest of the app — the
 * session cookie is sent automatically.
 */

/** Thrown when the server replies 503 — the API is up but its DB isn't. */
export class ServerStartingError extends Error {
  constructor() {
    super("server_starting");
    this.name = "ServerStartingError";
  }
}

/** Thrown when the network/server doesn't respond within the time budget. */
export class LoginTimeoutError extends Error {
  constructor() {
    super("login_timeout");
    this.name = "LoginTimeoutError";
  }
}

export async function login(email: string, password: string): Promise<void> {
  // 15s budget — long enough for slow networks, short enough that the user
  // sees a clear error instead of an indefinite spinner if the API is wedged.
  // On a fresh-install bringup the Prisma retry takes up to ~30s; if the
  // user submits the form during that window they'll hit 503 and see the
  // "server is starting" message below.
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  let res: Response;
  try {
    res = await fetch("/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password }),
      signal: controller.signal,
    });
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new LoginTimeoutError();
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
  if (res.status === 503) {
    throw new ServerStartingError();
  }
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { message?: string };
    throw new Error(body.message || "Invalid credentials");
  }
}

export async function logout(): Promise<void> {
  await fetch("/api/auth/logout", { method: "POST" });
}

export async function register(input: {
  email: string;
  password: string;
  name?: string;
  positions?: string[];
  bio?: string;
}): Promise<void> {
  const res = await fetch("/api/auth/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { message?: string };
    throw new Error(body.message || "Registration failed");
  }
}

export function googleLoginHref(): string {
  return "/api/auth/google";
}

/**
 * Fetch the current user once on mount. Returns `null` while loading or if
 * the user is not signed in. For use in client components that need to
 * react to auth state — server components should use `getCurrentUser()`
 * from `@/lib/auth`.
 */
export function useUser(): {
  user: ClientUser | null;
  status: AuthStatus;
  refresh: () => void;
} {
  const [user, setUser] = useState<ClientUser | null>(null);
  const [status, setStatus] = useState<AuthStatus>("loading");
  const [tick, setTick] = useState(0);
  const wasAuthedRef = useRef(false);

  useEffect(() => {
    let cancelled = false;

    async function check() {
      try {
        const res = await fetch("/api/auth/me", { cache: "no-store" });
        if (cancelled) return;
        if (res.ok) {
          const data = (await res.json()) as ClientUser;
          setUser(data);
          setStatus("authenticated");
          wasAuthedRef.current = true;
        } else {
          setUser(null);
          setStatus("unauthenticated");
          // If the user was authenticated in this session and just got 401,
          // their cookie expired — bounce them to /login with `?next=`.
          if (wasAuthedRef.current && res.status === 401) {
            redirectToLogin();
          }
        }
      } catch {
        if (cancelled) return;
        setUser(null);
        setStatus("unauthenticated");
      }
    }

    void check();

    // Re-check on tab focus and periodically so an expired session is
    // detected promptly even if the user isn't navigating.
    const onFocus = () => void check();
    window.addEventListener("focus", onFocus);
    const interval = window.setInterval(check, 5 * 60 * 1000);

    return () => {
      cancelled = true;
      window.removeEventListener("focus", onFocus);
      window.clearInterval(interval);
    };
  }, [tick]);

  return { user, status, refresh: () => setTick((t) => t + 1) };
}

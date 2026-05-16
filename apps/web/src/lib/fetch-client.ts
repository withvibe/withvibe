"use client";

/**
 * Browser-side fetch wrapper that redirects to /login on 401. Use this
 * instead of bare `fetch` for any authenticated client-side request — when
 * the session cookie expires mid-session, the user lands back on /login
 * with `?next=` set to the current path so they bounce back after sign-in.
 *
 * Auth endpoints (/api/auth/*) opt out: they have their own UX (the login
 * form must surface 401 as "invalid credentials", not a redirect loop).
 */
export async function authedFetch(
  input: RequestInfo | URL,
  init?: RequestInit
): Promise<Response> {
  const res = await fetch(input, init);
  if (res.status === 401 && shouldRedirect(input)) {
    redirectToLogin();
  }
  return res;
}

function shouldRedirect(input: RequestInfo | URL): boolean {
  const url =
    typeof input === "string"
      ? input
      : input instanceof URL
        ? input.pathname
        : input.url;
  // Don't bounce on the auth endpoints themselves — login/register/me handle
  // 401 inline.
  return !url.includes("/api/auth/");
}

export function redirectToLogin(): void {
  if (typeof window === "undefined") return;
  const here = window.location.pathname + window.location.search;
  if (window.location.pathname === "/login") return;
  window.location.href = `/login?next=${encodeURIComponent(here)}`;
}

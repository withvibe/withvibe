import { NextResponse, type NextRequest } from "next/server";

const SESSION_COOKIE = "withvibe_session";

const PUBLIC_PATHS = new Set(["/login", "/register"]);
const PUBLIC_PREFIXES = ["/api", "/cli-auth", "/invite", "/_next", "/favicon"];

/**
 * Edge gate for the web app. If the session cookie is missing, redirect
 * browser navigations to `/login?next=<path>`. We do not verify the JWT
 * here (that would require exposing the signing secret to the edge); the
 * NestJS API is still the source of truth and rejects invalid tokens with
 * 401, which the client interceptor turns into the same redirect.
 */
export function middleware(req: NextRequest) {
  const { pathname, search } = req.nextUrl;

  if (PUBLIC_PATHS.has(pathname)) return NextResponse.next();
  if (PUBLIC_PREFIXES.some((p) => pathname.startsWith(p))) {
    return NextResponse.next();
  }

  const hasSession = req.cookies.get(SESSION_COOKIE)?.value;
  if (hasSession) return NextResponse.next();

  const loginUrl = req.nextUrl.clone();
  loginUrl.pathname = "/login";
  loginUrl.search = `?next=${encodeURIComponent(pathname + search)}`;
  return NextResponse.redirect(loginUrl);
}

export const config = {
  matcher: [
    // Match everything except static assets and Next internals. The function
    // body does the finer-grained allow-listing above.
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:png|jpg|jpeg|gif|svg|ico|webp)$).*)",
  ],
};

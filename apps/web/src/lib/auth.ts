import { apiJson } from "./api";

export type CurrentUser = {
  id: string;
  email: string;
  name: string | null;
  defaultWorkspaceId: string | null;
  positions: string[];
  bio: string | null;
};

/**
 * Server-side: returns the signed-in user, or `null` if the request has no
 * valid session cookie. Use from server components and route handlers.
 */
export async function getCurrentUser(): Promise<CurrentUser | null> {
  return apiJson<CurrentUser>("/auth/me", { cache: "no-store" });
}

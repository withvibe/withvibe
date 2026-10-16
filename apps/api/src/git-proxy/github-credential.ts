/**
 * Whose GitHub token a piece of git work runs with.
 *
 * Every repository operation in an env belongs to a person — the one who
 * pressed the button, or the one whose turn the agent is acting on. So it
 * authenticates with *their* token: their access decides what they can reach,
 * and their account is what GitHub records against the commit. A shared
 * workspace token makes every push look identical and gives everyone the union
 * of everyone's access.
 *
 * Which is why a user without a personal token is refused rather than quietly
 * falling back to the workspace one. Falling back is the more forgiving
 * behaviour and it reintroduces exactly what per-user tokens exist to remove.
 *
 * The workspace token is still the credential for workspace-level work that
 * has no acting user — discovering which repositories exist, and anything a
 * background job does on an env's behalf (there, the env's creator stands in;
 * see SandboxReposService).
 */

export type GitHubCredential = {
  token: string;
  /** Which setting it came from — for log lines and error messages. */
  source: "user" | "workspace" | "server";
  /** The GitHub identity, when we know it. Only personal tokens carry one. */
  login: string | null;
  userId: number | null;
};

export type CredentialInputs = {
  user: { githubToken: string | null; githubLogin: string | null; githubUserId: number | null } | null;
  workspace: { githubToken: string | null } | null;
  /** Deployment-wide GITHUB_TOKEN, the last resort for workspace-level work. */
  server?: string | null;
};

/**
 * The acting user's own token, or null. Never falls back — callers acting on
 * behalf of a person must refuse instead, so `null` here is a refusal and not
 * a reason to keep looking.
 */
export function personalCredential(
  inputs: CredentialInputs
): GitHubCredential | null {
  const token = inputs.user?.githubToken?.trim();
  if (!token) return null;
  return {
    token,
    source: "user",
    login: inputs.user?.githubLogin ?? null,
    userId: inputs.user?.githubUserId ?? null,
  };
}

/**
 * Workspace-level credential: for work with no acting user. Falls back through
 * workspace → server, and returns null when neither is configured.
 */
export function workspaceCredential(
  inputs: CredentialInputs
): GitHubCredential | null {
  const ws = inputs.workspace?.githubToken?.trim();
  if (ws) return { token: ws, source: "workspace", login: null, userId: null };
  const server = inputs.server?.trim();
  if (server) return { token: server, source: "server", login: null, userId: null };
  return null;
}

/**
 * The committer identity to record for a person.
 *
 * GitHub attributes a commit to an account by its email, and the address it
 * accepts for that is `<id>+<login>@users.noreply.github.com` — so a user who
 * has connected their GitHub account gets commits that actually appear as
 * theirs on GitHub, rather than only locally. Without that connection we fall
 * back to the WithVibe identity, which is what the whole product did before
 * and still reads correctly in `git log`.
 */
export function committerIdentity(user: {
  id: string;
  name: string | null;
  email: string | null;
  githubLogin?: string | null;
  githubUserId?: number | null;
}): { name: string; email: string } {
  const name = user.name || user.email?.split("@")[0] || "withvibe";
  if (user.githubLogin && user.githubUserId) {
    return {
      name,
      email: `${user.githubUserId}+${user.githubLogin}@users.noreply.github.com`,
    };
  }
  return { name, email: user.email || `${user.id}@withvibe.local` };
}

/** Message shown when the person acting has no token of their own. */
export function missingCredentialMessage(host: string): string {
  return (
    `${host} needs your own GitHub token. Git in an environment authenticates ` +
    `as you, not as the workspace, so pushes and private repositories use your ` +
    `access and are recorded against your account. Add a personal access token ` +
    `under Account -> GitHub.`
  );
}

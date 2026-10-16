/**
 * Self-check for whose GitHub token git work runs with. This repo has no test
 * runner, so (matching check:git-proxy) this is a ts-node script:
 *
 *   pnpm --filter @withvibe/api check:github-credential
 *
 * The decision this file encodes is small and very easy to undo by accident:
 * a user acting in an environment uses THEIR token, and a user without one is
 * refused rather than quietly falling back to the workspace's. Re-introducing
 * the fallback would look like a kindness and would silently restore exactly
 * what per-user tokens exist to remove — every push attributed to one shared
 * account, and everyone holding the union of everyone's access.
 *
 * Exits non-zero on any unexpected outcome.
 */
import {
  personalCredential,
  workspaceCredential,
  committerIdentity,
  missingCredentialMessage,
} from "./github-credential";

let pass = 0;
let fail = 0;
function expect(name: string, cond: boolean, detail = "") {
  if (cond) {
    pass++;
    console.log(`  ok  ${name}`);
  } else {
    fail++;
    console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const withToken = {
  githubToken: "ghp_user",
  githubLogin: "alice",
  githubUserId: 4242,
};
const noToken = { githubToken: null, githubLogin: null, githubUserId: null };

// ---- the acting user's token ------------------------------------------------

{
  const c = personalCredential({
    user: withToken,
    workspace: { githubToken: "ghp_workspace" },
  });
  expect("a user with a token uses their own", c?.token === "ghp_user", c?.token);
  expect("and it is reported as theirs", c?.source === "user", c?.source);
  expect("carrying the GitHub identity", c?.login === "alice" && c?.userId === 4242);
}

{
  // The one that matters: a workspace token sitting right there, unused.
  const c = personalCredential({
    user: noToken,
    workspace: { githubToken: "ghp_workspace" },
    server: "ghp_server",
  });
  expect(
    "a user WITHOUT a token does not fall back to the workspace's",
    c === null,
    JSON.stringify(c)
  );
}

{
  const c = personalCredential({ user: null, workspace: null });
  expect("no user at all is also a refusal", c === null);
}

{
  const c = personalCredential({
    user: { githubToken: "   ", githubLogin: null, githubUserId: null },
    workspace: { githubToken: "ghp_workspace" },
  });
  expect("a blank token is not a token", c === null);
}

// ---- workspace-level work ---------------------------------------------------
// Discovering which repositories exist has no acting user, so it does fall
// back — workspace, then the deployment-wide token.

{
  const c = workspaceCredential({
    user: withToken,
    workspace: { githubToken: "ghp_workspace" },
    server: "ghp_server",
  });
  expect("workspace work prefers the workspace token", c?.token === "ghp_workspace");
  expect("and never silently borrows a person's", c?.source === "workspace");
}

{
  const c = workspaceCredential({
    user: withToken,
    workspace: { githubToken: null },
    server: "ghp_server",
  });
  expect("falling back to the deployment token", c?.token === "ghp_server");
  expect("reported as the server's", c?.source === "server");
}

{
  const c = workspaceCredential({ user: withToken, workspace: null });
  expect("with neither configured it is null, not the user's", c === null);
}

// ---- committer identity -----------------------------------------------------

{
  const id = committerIdentity({
    id: "cu_1",
    name: "Alice",
    email: "alice@corp.com",
    githubLogin: "alice",
    githubUserId: 4242,
  });
  expect(
    "a connected account commits under the address GitHub attributes",
    id.email === "4242+alice@users.noreply.github.com",
    id.email
  );
  expect("keeping the display name", id.name === "Alice");
}

{
  const id = committerIdentity({
    id: "cu_1",
    name: "Alice",
    email: "alice@corp.com",
  });
  expect(
    "without a connected account it stays the WithVibe identity",
    id.email === "alice@corp.com" && id.name === "Alice"
  );
}

{
  // A login with no id cannot form the noreply address — half the pair is not
  // enough, and guessing an id would attribute the commit to a stranger.
  const id = committerIdentity({
    id: "cu_1",
    name: null,
    email: "alice@corp.com",
    githubLogin: "alice",
    githubUserId: null,
  });
  expect(
    "a login without an id does not produce a noreply address",
    id.email === "alice@corp.com",
    id.email
  );
  expect("and the name falls back to the email local part", id.name === "alice");
}

{
  const id = committerIdentity({ id: "cu_9", name: null, email: null });
  expect(
    "a user with no email at all still gets a usable identity",
    id.email === "cu_9@withvibe.local" && id.name === "withvibe",
    JSON.stringify(id)
  );
}

// ---- the refusal message ----------------------------------------------------

{
  const msg = missingCredentialMessage("github.com");
  expect("the refusal names the host", msg.includes("github.com"));
  expect(
    "and says where to fix it",
    msg.includes("Account -> GitHub"),
    msg
  );
  expect(
    "without blaming the workspace, which is no longer the answer",
    !msg.includes("Workspace"),
    msg
  );
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);

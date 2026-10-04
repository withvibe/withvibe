/**
 * Self-check for the git proxy's pure parts: the sandbox credential and the
 * push inspector. This repo has no test runner, so (matching
 * check:fargate-reaper) this is a ts-node script:
 *
 *   pnpm --filter @withvibe/api check:git-proxy
 *
 * These two pieces are what stand between a sandbox and the workspace's repos.
 * A forgeable token hands every repo to anyone who can reach the api; a parser
 * that reads a push wrongly either blocks legitimate work or waves a force-push
 * to main straight through.
 *
 * Exits non-zero on any unexpected outcome.
 */
import {
  mintGitProxyToken,
  verifyGitProxyToken,
  tokenFromAuthHeader,
} from "./git-proxy-token";
import { randomBytes } from "crypto";
import { PassThrough, Writable } from "stream";
import {
  parseReceivePackCommands,
  forwardRemainder,
  readCommandList,
  rejectionReason,
  branchOf,
  isCreate,
  isDelete,
  MAX_COMMAND_LIST_BYTES,
  type ReceivePackCommand,
} from "./git-pkt-line";

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

const SECRET = "test-secret-not-a-real-one";
const OTHER_SECRET = "a-different-secret";
const OID_A = "a".repeat(40);
const OID_B = "b".repeat(40);
const ZERO = "0".repeat(40);

/** Build a pkt-line body the way git would. */
function pkt(line: string): Buffer {
  const payload = Buffer.from(line, "utf-8");
  const length = (payload.length + 4).toString(16).padStart(4, "0");
  return Buffer.concat([Buffer.from(length, "ascii"), payload]);
}
const FLUSH = Buffer.from("0000", "ascii");
const PACK = Buffer.from("PACK\x00\x00\x00\x02fake packfile bytes", "binary");

// ---- token ---------------------------------------------------------------

{
  const token = mintGitProxyToken("env1", "user1", SECRET);
  const claims = verifyGitProxyToken(token, SECRET);
  expect(
    "a minted token round-trips to its env and user",
    claims?.envId === "env1" && claims?.userId === "user1"
  );
}

{
  const token = mintGitProxyToken("env1", "user1", SECRET);
  expect(
    "a token does not verify under a different secret",
    verifyGitProxyToken(token, OTHER_SECRET) === null
  );
}

{
  // The attack this exists to stop: edit the user id and keep the signature.
  const token = mintGitProxyToken("env1", "user1", SECRET).replace("user1", "user2");
  expect("the user id cannot be swapped", verifyGitProxyToken(token, SECRET) === null);
}

{
  const token = mintGitProxyToken("env1", "user1", SECRET).replace("env1", "env2");
  expect("the env id cannot be swapped", verifyGitProxyToken(token, SECRET) === null);
}

{
  const token = mintGitProxyToken("env1", "user1", SECRET);
  const truncated = token.slice(0, -1);
  expect(
    "a truncated signature is rejected rather than compared short",
    verifyGitProxyToken(truncated, SECRET) === null
  );
}

{
  expect("garbage is rejected", verifyGitProxyToken("not-a-token", SECRET) === null);
  expect("an empty token is rejected", verifyGitProxyToken("", SECRET) === null);
  expect(
    "no token verifies when the secret is empty",
    verifyGitProxyToken(mintGitProxyToken("e", "u", SECRET), "") === null
  );
}

{
  let threw = false;
  try {
    mintGitProxyToken("env1", "user.with.dots", SECRET);
  } catch {
    threw = true;
  }
  expect("ids containing the delimiter are refused at mint time", threw);
}

{
  const token = mintGitProxyToken("env1", "user1", SECRET);
  expect(
    "Bearer headers are read",
    tokenFromAuthHeader(`Bearer ${token}`) === token
  );
  expect(
    "Basic headers are read with the token as the password",
    tokenFromAuthHeader(
      `Basic ${Buffer.from(`withvibe:${token}`).toString("base64")}`
    ) === token
  );
  expect(
    "Basic headers are read with the token as the username",
    tokenFromAuthHeader(`Basic ${Buffer.from(`${token}:x`).toString("base64")}`) === token
  );
  expect("a missing header yields nothing", tokenFromAuthHeader(undefined) === null);
  expect("an unknown scheme yields nothing", tokenFromAuthHeader(`Digest ${token}`) === null);
}

// ---- pkt-line parsing ----------------------------------------------------

{
  const body = Buffer.concat([
    pkt(`${OID_A} ${OID_B} refs/heads/env/my-feature\0report-status side-band-64k\n`),
    FLUSH,
    PACK,
  ]);
  const r = parseReceivePackCommands(body);
  expect(
    "a single-ref push parses, capabilities and all",
    r.status === "ok" &&
      r.commands.length === 1 &&
      r.commands[0].ref === "refs/heads/env/my-feature"
  );
  expect(
    "headerBytes stops at the flush, before the packfile",
    r.status === "ok" && r.headerBytes === body.length - PACK.length
  );
}

{
  const body = Buffer.concat([
    pkt(`${OID_A} ${OID_B} refs/heads/one\0report-status\n`),
    pkt(`${ZERO} ${OID_B} refs/heads/two\n`),
    pkt(`${OID_A} ${ZERO} refs/heads/three\n`),
    FLUSH,
  ]);
  const r = parseReceivePackCommands(body);
  expect("every ref in a multi-ref push is seen", r.status === "ok" && r.commands.length === 3);
  if (r.status === "ok") {
    expect("a zero old-oid reads as a create", isCreate(r.commands[1]));
    expect("a zero new-oid reads as a delete", isDelete(r.commands[2]));
    expect("branch names drop the refs/heads/ prefix", branchOf(r.commands[0]) === "one");
    expect("a tag has no branch name", branchOf({ oldOid: OID_A, newOid: OID_B, ref: "refs/tags/v1" }) === null);
  }
}

{
  // The case the incremental reader hits on every real push: the command list
  // split across TCP chunks. Every prefix must say "incomplete", never "ok".
  const body = Buffer.concat([
    pkt(`${OID_A} ${OID_B} refs/heads/main\n`),
    pkt(`${OID_A} ${OID_B} refs/heads/other\n`),
    FLUSH,
  ]);
  let allIncomplete = true;
  for (let i = 0; i < body.length; i++) {
    if (parseReceivePackCommands(body.subarray(0, i)).status !== "incomplete") {
      allIncomplete = false;
      break;
    }
  }
  expect("no proper prefix of a command list ever parses as complete", allIncomplete);
  expect("the full command list parses", parseReceivePackCommands(body).status === "ok");
}

{
  const r = parseReceivePackCommands(Buffer.from("zzzz", "ascii"));
  expect("a non-hex length is an error, not a retry", r.status === "error");
}

{
  const r = parseReceivePackCommands(Buffer.concat([pkt("push-cert 0001\n"), FLUSH]));
  expect(
    "an unreadable command line fails closed rather than reading as empty",
    r.status === "error"
  );
}

{
  // Fail closed on a flood: an endless "almost a command list" must not be
  // buffered forever waiting for a flush that never comes.
  const huge = Buffer.alloc(MAX_COMMAND_LIST_BYTES + 1024, 0x41);
  Buffer.from("0010", "ascii").copy(huge, 0);
  const r = parseReceivePackCommands(huge);
  expect("an oversized command list is refused", r.status === "error");
}

// ---- streaming handover --------------------------------------------------

/**
 * The failure this guards against is invisible in a small test and corrupting
 * in production: if a single byte is dropped between "stop reading the command
 * list" and "pipe the rest upstream", the packfile arrives truncated and the
 * push fails with a checksum error nobody can trace back to here.
 */
async function handover(chunkSize: number, packBytes: number) {
  const header = Buffer.concat([
    pkt(`${OID_A} ${OID_B} refs/heads/env/big\0report-status\n`),
    FLUSH,
  ]);
  const packfile = randomBytes(packBytes);
  const body = Buffer.concat([header, packfile]);

  const stream = new PassThrough();
  // Feed the whole body in before reading, so the reader is racing a stream
  // that already has more buffered than it wants — the worst case for the
  // pause/pipe handover.
  for (let i = 0; i < body.length; i += chunkSize) {
    stream.write(body.subarray(i, i + chunkSize));
  }
  stream.end();

  const { prefix, result, ended } = await readCommandList(stream);

  // Stand in for the upstream request, so the test exercises the same
  // forwarding path the proxy uses rather than a hand-rolled copy of it.
  const received: Buffer[] = [];
  const sink = new Writable({
    write(chunk: Buffer, _enc, cb) {
      received.push(chunk);
      cb();
    },
  });
  const closed = new Promise<void>((resolve) => sink.on("finish", () => resolve()));
  forwardRemainder(stream, sink, prefix, ended);
  // A destination that is never closed is the bug this test exists to catch,
  // so time out rather than hang the check script.
  const timedOut = await Promise.race([
    closed.then(() => false),
    new Promise<boolean>((r) => setTimeout(() => r(true), 5000)),
  ]);

  return {
    result,
    forwarded: Buffer.concat(received),
    body,
    headerLength: header.length,
    timedOut,
  };
}

async function streamingChecks() {
  {
    const { result, forwarded, body, headerLength, timedOut } = await handover(
      8 * 1024,
      2 * 1024 * 1024
    );
    expect("a 2MB push still parses its command list", result.status === "ok");
    expect("a 2MB push closes the upstream body", !timedOut);
    expect(
      "the command list is read without over-reading into the packfile",
      result.status === "ok" && result.headerBytes === headerLength
    );
    expect(
      "every byte of a 2MB body survives the pause/pipe handover",
      forwarded.length === body.length && forwarded.equals(body),
      `forwarded ${forwarded.length} of ${body.length} bytes`
    );
  }

  {
    // One byte at a time: the command list spans many chunks and the handover
    // happens mid-stream with plenty still buffered.
    const { result, forwarded, body, timedOut } = await handover(1, 4096);
    expect("a byte-at-a-time push parses", result.status === "ok");
    expect("a byte-at-a-time push closes the upstream body", !timedOut);
    expect(
      "no bytes are lost when the handover happens mid-chunk-storm",
      forwarded.equals(body)
    );
  }

  {
    // A push whose body is nothing but the command list — the `ended` path,
    // where there is no remainder to pipe at all.
    const { result, forwarded, body, timedOut } = await handover(64 * 1024, 0);
    expect("a push with an empty packfile parses", result.status === "ok");
    expect(
      "a body consumed entirely by the reader still closes upstream",
      !timedOut,
      "the upstream request was never ended — the push would hang"
    );
    expect("an empty remainder forwards exactly the header", forwarded.equals(body));
  }
}

// ---- push policy ---------------------------------------------------------

const cmd = (ref: string, old = OID_A, next = OID_B): ReceivePackCommand => ({
  oldOid: old,
  newOid: next,
  ref,
});
const PROTECTED = { protectBaseBranch: true, baseBranch: "develop" };
const OPEN = { protectBaseBranch: false, baseBranch: "develop" };

expect(
  "an env branch is allowed",
  rejectionReason([cmd("refs/heads/env/feature-abc123")], PROTECTED) === null
);
expect(
  "the configured base branch is refused",
  rejectionReason([cmd("refs/heads/develop")], PROTECTED) !== null
);
expect(
  "main is refused even when the base branch is something else",
  rejectionReason([cmd("refs/heads/main")], PROTECTED) !== null
);
expect(
  "master is refused too",
  rejectionReason([cmd("refs/heads/master")], PROTECTED) !== null
);
expect(
  "one protected ref poisons a batch that is otherwise fine",
  rejectionReason(
    [cmd("refs/heads/env/ok"), cmd("refs/heads/main")],
    PROTECTED
  ) !== null
);
expect(
  "deleting a protected branch is refused",
  rejectionReason([cmd("refs/heads/main", OID_A, ZERO)], PROTECTED) !== null
);
expect(
  "turning protection off allows main",
  rejectionReason([cmd("refs/heads/main")], OPEN) === null
);
expect(
  "tags are allowed",
  rejectionReason([cmd("refs/tags/v1.0.0")], PROTECTED) === null
);
expect(
  "a ref outside heads/tags is refused even with protection off",
  rejectionReason([cmd("refs/replace/abc")], OPEN) !== null
);
expect(
  "HEAD cannot be pushed directly",
  rejectionReason([cmd("HEAD")], OPEN) !== null
);
expect("an empty push is allowed", rejectionReason([], PROTECTED) === null);

void streamingChecks().then(() => {
  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
});

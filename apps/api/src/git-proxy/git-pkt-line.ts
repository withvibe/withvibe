/**
 * Just enough of git's wire format to read what a push is asking for.
 *
 * A `git-receive-pack` request opens with one pkt-line per ref being updated —
 * `<old-oid> <new-oid> <ref>` — terminated by a flush packet, followed by the
 * packfile. Reading that prefix is what turns the proxy from a tunnel into a
 * policy point: it is the only place where "this push touches main" can be
 * known before the push reaches GitHub.
 *
 * The parser is incremental because the prefix arrives in whatever chunks the
 * network produces, and the packfile behind it can be hundreds of megabytes —
 * nothing here may depend on buffering the whole body.
 *
 * pkt-line: 4 hex digits of length (counting those 4 bytes), then the payload.
 * "0000" is a flush packet. "0001"/"0002" are delimiters that do not appear in
 * a command list.
 */

import type { Readable } from "stream";

export type ReceivePackCommand = {
  oldOid: string;
  newOid: string;
  ref: string;
};

export type ParseResult =
  | { status: "ok"; commands: ReceivePackCommand[]; headerBytes: number }
  /** Valid so far, but the flush packet has not arrived yet. */
  | { status: "incomplete" }
  | { status: "error"; reason: string };

/** Longest command list we will buffer before giving up. A push of a thousand
 * refs is under 100KB; anything larger is not a shape we should be guessing at. */
export const MAX_COMMAND_LIST_BYTES = 128 * 1024;

const ZERO_OID = /^0+$/;
const COMMAND_RE = /^([0-9a-f]{40,64}) ([0-9a-f]{40,64}) (.+)$/;

export function parseReceivePackCommands(buf: Buffer): ParseResult {
  const commands: ReceivePackCommand[] = [];
  let offset = 0;

  for (;;) {
    if (offset + 4 > buf.length) {
      return buf.length > MAX_COMMAND_LIST_BYTES
        ? { status: "error", reason: "command list exceeds the size we are willing to inspect" }
        : { status: "incomplete" };
    }

    const lengthHex = buf.toString("ascii", offset, offset + 4);
    if (!/^[0-9a-fA-F]{4}$/.test(lengthHex)) {
      return { status: "error", reason: `malformed pkt-line length "${lengthHex}"` };
    }
    const length = parseInt(lengthHex, 16);

    if (length === 0) {
      // Flush: the command list is complete.
      return { status: "ok", commands, headerBytes: offset + 4 };
    }
    if (length < 4) {
      return { status: "error", reason: `unexpected delimiter packet ${lengthHex} in a command list` };
    }
    if (offset + length > buf.length) {
      return buf.length > MAX_COMMAND_LIST_BYTES
        ? { status: "error", reason: "command list exceeds the size we are willing to inspect" }
        : { status: "incomplete" };
    }

    let payload = buf.toString("utf-8", offset + 4, offset + length);
    offset += length;

    // Capabilities ride on the first line after a NUL; the trailing newline is
    // optional in the spec and present in practice.
    const nul = payload.indexOf("\0");
    if (nul !== -1) payload = payload.slice(0, nul);
    if (payload.endsWith("\n")) payload = payload.slice(0, -1);

    const m = payload.match(COMMAND_RE);
    if (!m) {
      // Signed pushes wrap the commands in a push-certificate, which this does
      // not read. Refusing is the safe answer: an unreadable command list must
      // never be mistaken for an empty one.
      return {
        status: "error",
        reason: `unrecognised line in the command list: "${payload.slice(0, 80)}"`,
      };
    }
    commands.push({ oldOid: m[1], newOid: m[2], ref: m[3] });
  }
}

/**
 * Read exactly as much of a push body as the command list needs, keeping the
 * bytes so they can still be forwarded.
 *
 * The packfile behind the command list can be hundreds of megabytes, so the
 * stream is paused the moment the list is complete and the remainder is left
 * for the caller to pipe. The delicate part is the handover: the listener is
 * removed and the stream paused in the same synchronous tick, because a
 * flowing stream with no `data` listener drops what it reads. Losing bytes
 * there would corrupt the packfile in a way that only shows up on large
 * pushes, so it is worth keeping in one tested place.
 */
export function readCommandList(
  stream: Readable
): Promise<{ prefix: Buffer; result: ParseResult; ended: boolean }> {
  return new Promise((resolve, reject) => {
    let buf = Buffer.alloc(0);
    let settled = false;

    const finish = (result: ParseResult, ended: boolean) => {
      if (settled) return;
      settled = true;
      stream.off("data", onData);
      stream.off("end", onEnd);
      stream.off("error", onError);
      stream.off("aborted", onAborted);
      stream.pause();
      resolve({ prefix: buf, result, ended });
    };

    const onData = (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      const result = parseReceivePackCommands(buf);
      if (result.status !== "incomplete") finish(result, false);
      else if (buf.length > MAX_COMMAND_LIST_BYTES) {
        finish(
          {
            status: "error",
            reason: "command list exceeds the size we are willing to inspect",
          },
          false
        );
      }
    };
    const onEnd = () => finish(parseReceivePackCommands(buf), true);
    // `ended` is reported as a best-effort hint only. A body small enough to
    // arrive in one chunk finishes here while `end` is still queued, so it is
    // reported as not-ended and then ends a tick later — before the caller has
    // attached its pipe. Callers must therefore re-check `readableEnded` at the
    // moment they forward, not trust this flag alone; see forwardRemainder.
    const onError = (err: Error) => {
      if (settled) return;
      settled = true;
      reject(err);
    };
    const onAborted = () => onError(new Error("client aborted the push"));

    stream.on("data", onData);
    stream.on("end", onEnd);
    stream.on("error", onError);
    stream.on("aborted", onAborted);
    stream.resume();
  });
}

/**
 * Forward a body whose head has already been read: write the bytes we consumed,
 * then hand over the rest.
 *
 * The `readableEnded` check is the whole reason this is a function. A stream
 * that has already emitted `end` will never emit it again, so `pipe()` would
 * attach happily and then never close the destination — and a request body that
 * is never closed is a push that hangs until it times out. Small bodies hit
 * that case every time, which makes it exactly the kind of bug that passes
 * every manual test and then appears in production.
 */
export function forwardRemainder(
  stream: Readable,
  dest: { write(chunk: Buffer): unknown; end(): unknown },
  prefix: Buffer,
  endedWhenRead: boolean
): void {
  if (prefix.length > 0) dest.write(prefix);
  if (endedWhenRead || stream.readableEnded) dest.end();
  else stream.pipe(dest as NodeJS.WritableStream);
}

export function isDelete(cmd: ReceivePackCommand): boolean {
  return ZERO_OID.test(cmd.newOid);
}

export function isCreate(cmd: ReceivePackCommand): boolean {
  return ZERO_OID.test(cmd.oldOid);
}

/** `refs/heads/feature` → `feature`; anything else → null. */
export function branchOf(cmd: ReceivePackCommand): string | null {
  return cmd.ref.startsWith("refs/heads/") ? cmd.ref.slice("refs/heads/".length) : null;
}

export type PushPolicy = {
  protectBaseBranch: boolean;
  baseBranch: string | null;
};

/**
 * Mirror of GitService.assertNotProtectedBranch, applied to a push arriving
 * over the wire instead of one issued by the api. Returns the reason to reject,
 * or null to allow.
 */
export function rejectionReason(
  commands: ReceivePackCommand[],
  policy: PushPolicy
): string | null {
  const protectedNames = new Set(
    [policy.baseBranch, "main", "master"].filter(Boolean) as string[]
  );

  for (const cmd of commands) {
    // Branches and tags are the whole legitimate surface. Refusing everything
    // else keeps replace-refs, notes and raw refs/* writes off the table
    // without having to reason about each one.
    if (!cmd.ref.startsWith("refs/heads/") && !cmd.ref.startsWith("refs/tags/")) {
      return `refusing to push "${cmd.ref}": only branches and tags may be pushed through this proxy`;
    }
    if (!policy.protectBaseBranch) continue;

    const branch = branchOf(cmd);
    if (branch && protectedNames.has(branch)) {
      return (
        `Refusing to push: branch "${branch}" is protected. ` +
        `Disable Workspace.protectBaseBranch to override.`
      );
    }
  }
  return null;
}

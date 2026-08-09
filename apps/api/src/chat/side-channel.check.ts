/**
 * Proves the anti-deadlock property `side-channel.ts` exists for: an event
 * pushed from inside a *blocked* consumer callback must reach the output
 * stream before that callback returns.
 *
 * Run with: pnpm --filter @withvibe/api exec ts-node src/chat/side-channel.check.ts
 */
import { SideChannel, merge } from "./side-channel";

let failures = 0;
function check(name: string, ok: boolean, detail?: string) {
  if (ok) {
    console.log(`  ok  ${name}`);
  } else {
    failures += 1;
    console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

/** A source that stalls until released — stands in for the SDK going quiet
 *  while it waits for a parked tool call. */
function stallingSource(before: string[], release: Promise<void>, after: string[]) {
  return (async function* () {
    for (const v of before) yield v;
    await release;
    for (const v of after) yield v;
  })();
}

async function main() {
  // ── the deadlock case ────────────────────────────────────────────────────
  {
    let releaseSource: () => void = () => {};
    const released = new Promise<void>((r) => (releaseSource = r));
    const side = new SideChannel<string>();
    const source = stallingSource(["a"], released, ["b"]);

    const seen: string[] = [];
    let sawQuestionBeforeAnswer = false;

    const consume = (async () => {
      for await (const item of merge(source, side)) {
        seen.push(`${item.kind}:${item.value}`);
        // The moment the side event surfaces, unblock the source — this is
        // what "the browser answered" does in the real flow.
        if (item.kind === "side" && item.value === "question") {
          sawQuestionBeforeAnswer = true;
          releaseSource();
        }
      }
    })();

    // Source is stalled; push from the "blocked callback".
    side.push("question");
    await consume;

    check(
      "side event flushes while the source is stalled",
      sawQuestionBeforeAnswer,
      `saw ${JSON.stringify(seen)}`
    );
    check(
      "both source values still arrive, in order",
      seen.filter((s) => s.startsWith("source:")).join(",") ===
        "source:a,source:b",
      JSON.stringify(seen)
    );
  }

  // ── nothing is dropped when the source ends first ────────────────────────
  {
    const side = new SideChannel<string>();
    const source = (async function* () {
      yield "only";
    })();
    side.push("late-1");
    side.push("late-2");
    const seen: string[] = [];
    for await (const item of merge(source, side)) seen.push(`${item.kind}:${item.value}`);
    check(
      "queued side events drain after the source finishes",
      seen.includes("side:late-1") && seen.includes("side:late-2"),
      JSON.stringify(seen)
    );
  }

  // ── a closed side channel doesn't end the merge early ────────────────────
  {
    const side = new SideChannel<string>();
    side.close();
    const source = (async function* () {
      yield "x";
      yield "y";
    })();
    const seen: string[] = [];
    for await (const item of merge(source, side)) seen.push(String(item.value));
    check(
      "closed side channel still lets the source finish",
      seen.join(",") === "x,y",
      JSON.stringify(seen)
    );
  }

  console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) failed.`);
  process.exit(failures === 0 ? 0 : 1);
}

void main();

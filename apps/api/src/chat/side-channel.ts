/**
 * Lets a callback running *outside* the SDK message loop push events into the
 * same outbound stream.
 *
 * The problem this solves: `canUseTool` is invoked by the SDK concurrently
 * with `for await (const msg of query)`. When it blocks waiting for a human,
 * the SDK produces no further messages until it returns — so a naive "buffer
 * it and yield on the next iteration" never flushes, and the browser never
 * learns there's a question to answer. Deadlock.
 *
 * `merge()` races the SDK iterator against a side queue, so an event pushed
 * from inside `canUseTool` goes out immediately while the tool call is still
 * parked.
 */

export class SideChannel<T> {
  private readonly items: T[] = [];
  private readonly waiters: ((r: IteratorResult<T>) => void)[] = [];
  private closed = false;

  push(item: T): void {
    if (this.closed) return;
    const waiter = this.waiters.shift();
    if (waiter) waiter({ value: item, done: false });
    else this.items.push(item);
  }

  close(): void {
    this.closed = true;
    while (this.waiters.length > 0) {
      this.waiters.shift()?.({ value: undefined as never, done: true });
    }
  }

  next(): Promise<IteratorResult<T>> {
    const item = this.items.shift();
    if (item !== undefined) return Promise.resolve({ value: item, done: false });
    if (this.closed) return Promise.resolve({ value: undefined as never, done: true });
    return new Promise((resolve) => this.waiters.push(resolve));
  }
}

export type Merged<S, E> =
  | { kind: "source"; value: S }
  | { kind: "side"; value: E };

/**
 * Yield from `source` and `side` as each produces, ending when `source` is
 * exhausted. Any side events already queued at that point are drained first
 * so nothing pushed just before the last SDK message is lost.
 *
 * Note both pending promises are held across iterations and only replaced
 * once they resolve — racing freshly-created promises each turn would drop
 * whichever value lost the race.
 */
export async function* merge<S, E>(
  source: AsyncIterable<S>,
  side: SideChannel<E>
): AsyncGenerator<Merged<S, E>> {
  const iterator = source[Symbol.asyncIterator]();
  let sourceNext = iterator.next();
  let sideNext = side.next();
  let sideDone = false;

  for (;;) {
    // Once the side channel is finished, stop racing — awaiting a
    // never-settling placeholder would strand any value it still held.
    if (sideDone) {
      const result = await sourceNext;
      if (result.done) break;
      yield { kind: "source", value: result.value };
      sourceNext = iterator.next();
      continue;
    }

    const winner = await Promise.race([
      sourceNext.then((result) => ({ from: "source" as const, result })),
      sideNext.then((result) => ({ from: "side" as const, result })),
    ]);

    if (winner.from === "side") {
      if (winner.result.done) {
        sideDone = true;
        continue;
      }
      yield { kind: "side", value: winner.result.value };
      sideNext = side.next();
      continue;
    }

    if (winner.result.done) break;
    yield { kind: "source", value: winner.result.value };
    sourceNext = iterator.next();
  }

  if (sideDone) return;

  // The source is finished. `sideNext` may already hold a value that lost the
  // last race — award it before draining, or it is silently dropped. Closing
  // first makes any still-pending `next()` resolve as done, so this
  // terminates whether or not anything is queued.
  side.close();
  for (;;) {
    const rest = await sideNext;
    if (rest.done) return;
    yield { kind: "side", value: rest.value };
    sideNext = side.next();
  }
}

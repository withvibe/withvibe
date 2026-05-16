import net from "node:net";

// Returns true iff the given TCP port is free on 0.0.0.0. We probe by
// trying to bind a transient server — that's the same behavior `compose up`
// would hit, so an "in use" result here always reflects reality.
export function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once("error", () => resolve(false));
    srv.once("listening", () => srv.close(() => resolve(true)));
    srv.listen(port, "0.0.0.0");
  });
}

// Walk upward from `start` until we hit a free port or run out of tries.
// Returns the chosen port, or null if nothing in [start, start+maxTries) is
// free (very rare — only happens on truly busy hosts).
export async function findFreePort(
  start: number,
  maxTries = 50
): Promise<number | null> {
  for (let p = start; p < start + maxTries; p++) {
    if (await isPortFree(p)) return p;
  }
  return null;
}

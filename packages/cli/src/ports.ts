import net from "node:net";

// Pick a free host port by asking the OS for port 0 on localhost. The OS hands
// us an ephemeral port, then we immediately close the listener. There's a
// tiny race between close+reuse, but for a compose `up` 1-2s later the odds
// of collision are negligible in practice.
export async function pickFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (addr && typeof addr === "object") {
        const port = addr.port;
        server.close(() => resolve(port));
      } else {
        server.close();
        reject(new Error("Failed to pick free port"));
      }
    });
  });
}

export async function pickFreePorts(n: number): Promise<number[]> {
  const ports: number[] = [];
  // Serial allocation so we don't double-assign the same OS-ephemeral port.
  // The cost (a few ms per port) doesn't matter at the scale of a compose stack.
  for (let i = 0; i < n; i++) {
    ports.push(await pickFreePort());
  }
  return ports;
}

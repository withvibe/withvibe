import { Injectable } from "@nestjs/common";

const LOG_BUFFER_MAX = 120_000; // chars per env; oldest chunks dropped first

type LogSubscriber = (chunk: string) => void;

/**
 * In-memory per-env lifecycle log buffer with SSE-friendly subscribe
 * semantics. Compute-target agnostic: the local docker driver pushes
 * `docker compose` output here, and remote drivers (Fargate) push their
 * provisioning/CloudWatch output into the same buffer — so the UI log
 * panel and the docker MCP tools read one stream regardless of where the
 * env runs.
 *
 * State lives on the singleton and resets when the Nest process restarts.
 */
@Injectable()
export class EnvLogBufferService {
  private readonly buffers = new Map<string, string[]>();
  private readonly subs = new Map<string, Set<LogSubscriber>>();

  subscribe(envId: string, onChunk: LogSubscriber): () => void {
    // Replay backlog first so new subscribers see what already happened.
    const buf = this.buffers.get(envId) || [];
    for (const c of buf) onChunk(c);
    const subs = this.subs.get(envId) || new Set();
    subs.add(onChunk);
    this.subs.set(envId, subs);
    return () => {
      subs.delete(onChunk);
      if (subs.size === 0) this.subs.delete(envId);
    };
  }

  clear(envId: string) {
    this.buffers.delete(envId);
  }

  /** Snapshot of the buffer as a single string, optionally tail-limited. */
  snapshot(envId: string, maxChars = 8000): string {
    const joined = (this.buffers.get(envId) || []).join("");
    if (joined.length <= maxChars) return joined;
    return joined.slice(joined.length - maxChars);
  }

  push(envId: string, chunk: string) {
    if (!chunk) return;
    const buf = this.buffers.get(envId) || [];
    buf.push(chunk);
    let total = buf.reduce((n, s) => n + s.length, 0);
    while (total > LOG_BUFFER_MAX && buf.length > 1) {
      total -= (buf.shift() || "").length;
    }
    this.buffers.set(envId, buf);
    const subs = this.subs.get(envId);
    if (subs) for (const s of subs) s(chunk);
  }
}

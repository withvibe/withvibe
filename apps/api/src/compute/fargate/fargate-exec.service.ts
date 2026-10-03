import { Injectable } from "@nestjs/common";
import * as https from "https";
import { createHmac } from "crypto";
import { PassThrough } from "stream";
import { EventEmitter } from "events";
import * as selfsigned from "selfsigned";
import { PrismaService } from "../../prisma/prisma.service";
import { InjectPinoLogger, PinoLogger } from "nestjs-pino";

export const FARGATE_BRIDGE_PORT = Number(
  process.env.FARGATE_BRIDGE_PORT || 7777
);

/** The public base URL the TASK uses to reach the api (bridge fetch + MCP
 * callbacks). Local docker uses host.docker.internal; a Fargate task needs a
 * genuinely public URL. */
export function fargateApiBaseUrl(): string | null {
  return (
    process.env.FARGATE_API_BASE_URL ||
    process.env.PUBLIC_API_BASE_URL ||
    process.env.API_PUBLIC_URL ||
    null
  );
}

/**
 * Handle shape shared with the local `docker exec` path: structurally
 * compatible with the subset of ChildProcess the chat engine consumes, so
 * the engine's stream loop is transport-agnostic.
 */
export type BridgeExecHandle = {
  stdout: PassThrough;
  stderr: PassThrough;
  killed: boolean;
  exitCode: number | null;
  kill(signal?: string): void;
  on(event: "error" | "close", cb: (...args: unknown[]) => void): void;
};

/**
 * Api-side client of the exec bridge riding in a Fargate env's runner
 * container (see bridge-source.ts). TLS is pinned to the per-env self-signed
 * cert stored on the Env row; auth is a deterministic HMAC token derived
 * from INTERNAL_JWT_SECRET, so nothing new needs persisting or rotating.
 */
@Injectable()
export class FargateExecService {
  constructor(
    @InjectPinoLogger(FargateExecService.name)
    private readonly logger: PinoLogger,
    private readonly prisma: PrismaService
  ) {}

  /** Deterministic per-env bridge token — same derivation at task-start
   * (goes into the container env) and at call time. */
  bridgeToken(envId: string): string {
    const secret = process.env.INTERNAL_JWT_SECRET || "";
    return createHmac("sha256", secret)
      .update(`fargate-bridge:${envId}`)
      .digest("hex");
  }

  /** Fresh self-signed cert per task start. The private key goes only into
   * the task's environment; the cert is persisted on the Env row for
   * pinning. One year of validity > any sane task lifetime. */
  async generateBridgeCert(
    envId: string
  ): Promise<{ cert: string; key: string }> {
    const pems = await selfsigned.generate(
      [{ name: "commonName", value: `wv-env-${envId}` }],
      {
        keySize: 2048,
        algorithm: "sha256",
        notAfterDate: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000),
      }
    );
    return { cert: pems.cert, key: pems.private };
  }

  private async target(envId: string): Promise<
    | { ip: string; cert: string; token: string }
    | { error: string }
  > {
    const env = await this.prisma.client.env.findUnique({
      where: { id: envId },
      select: { fargatePublicIp: true, fargateBridgeCert: true },
    });
    if (!env?.fargatePublicIp) {
      return { error: "Env has no running Fargate task (start it first)" };
    }
    if (!env.fargateBridgeCert) {
      return {
        error:
          "Env task has no bridge certificate — it predates the exec bridge; rebuild the env",
      };
    }
    return {
      ip: env.fargatePublicIp,
      cert: env.fargateBridgeCert,
      token: this.bridgeToken(envId),
    };
  }

  private requestOptions(
    t: { ip: string; cert: string; token: string },
    method: string,
    path: string
  ): https.RequestOptions {
    return {
      host: t.ip,
      port: FARGATE_BRIDGE_PORT,
      method,
      path,
      headers: { authorization: `Bearer ${t.token}` },
      // Pin the per-env self-signed cert; the host is a raw IP so hostname
      // verification is meaningless — the pinned CA IS the identity.
      ca: t.cert,
      rejectUnauthorized: true,
      checkServerIdentity: () => undefined,
      timeout: 15_000,
    };
  }

  /** Fast pre-check mirroring ClaudeRunnerService.ensureRunning semantics:
   * null on success, error string on failure. */
  async preflight(envId: string): Promise<string | null> {
    const t = await this.target(envId);
    if ("error" in t) return t.error;
    return new Promise((resolve) => {
      const req = https.request(
        this.requestOptions(t, "GET", "/healthz"),
        (res) => {
          let body = "";
          res.setEncoding("utf-8");
          res.on("data", (c) => (body += c));
          res.on("end", () => {
            if (res.statusCode !== 200) {
              resolve(`bridge /healthz returned ${res.statusCode}`);
              return;
            }
            try {
              const j = JSON.parse(body) as { ok?: boolean; claude?: string };
              if (!j.ok) resolve("bridge reports not-ok");
              else if (!j.claude)
                resolve("claude CLI not available in the runner container");
              else resolve(null);
            } catch {
              resolve("bridge /healthz returned invalid JSON");
            }
          });
        }
      );
      req.on("error", (err) => resolve(`bridge unreachable: ${err.message}`));
      req.on("timeout", () => {
        req.destroy();
        resolve("bridge healthz timed out");
      });
      req.end();
    });
  }

  /**
   * Run a command in the env's runner container, streaming stdout/stderr.
   * `files` are written inside the container before the spawn (how the
   * per-turn mcp.json reaches the sandbox — there is no shared filesystem).
   */
  async execStream(
    envId: string,
    job: {
      argv: string[];
      env?: Record<string, string>;
      cwd?: string;
      files?: Record<string, string>;
    }
  ): Promise<BridgeExecHandle> {
    const t = await this.target(envId);
    const stdout = new PassThrough({ encoding: "utf-8" });
    const stderr = new PassThrough({ encoding: "utf-8" });
    const events = new EventEmitter();
    const handle: BridgeExecHandle = {
      stdout,
      stderr,
      killed: false,
      exitCode: null,
      kill: () => {},
      on: (ev, cb) => void events.on(ev, cb),
    };

    if ("error" in t) {
      // Surface as an immediately-erroring handle so the engine's existing
      // error path handles it uniformly.
      queueMicrotask(() => {
        events.emit("error", new Error(t.error));
        events.emit("close");
      });
      return handle;
    }

    const opts = this.requestOptions(t, "POST", "/exec");
    (opts.headers as Record<string, string>)["content-type"] =
      "application/json";
    // The exec itself can run for many minutes — only connection inactivity
    // should kill it, not a wall clock.
    opts.timeout = 0;

    const req = https.request(opts, (res) => {
      if (res.statusCode !== 200) {
        events.emit(
          "error",
          new Error(`bridge /exec returned ${res.statusCode}`)
        );
        res.resume();
        return;
      }
      let pending = "";
      res.setEncoding("utf-8");
      res.on("data", (chunk: string) => {
        pending += chunk;
        let idx = pending.indexOf("\n");
        while (idx !== -1) {
          const line = pending.slice(0, idx).trim();
          pending = pending.slice(idx + 1);
          idx = pending.indexOf("\n");
          if (!line) continue;
          try {
            const ev = JSON.parse(line) as {
              t: "out" | "err" | "exit";
              d?: string;
              code?: number;
            };
            if (ev.t === "out" && ev.d) stdout.write(ev.d);
            else if (ev.t === "err" && ev.d) stderr.write(ev.d);
            else if (ev.t === "exit") {
              handle.exitCode = ev.code ?? -1;
            }
          } catch {
            // Non-JSON noise from the bridge — treat as stderr.
            stderr.write(line + "\n");
          }
        }
      });
      res.on("end", () => {
        stdout.end();
        stderr.end();
        events.emit("close");
      });
      res.on("error", (err) => {
        events.emit("error", err);
        stdout.end();
        stderr.end();
        events.emit("close");
      });
    });
    req.on("error", (err) => {
      events.emit("error", err);
      events.emit("close");
    });
    handle.kill = () => {
      handle.killed = true;
      // Dropping the connection makes the bridge SIGTERM the child.
      try {
        req.destroy();
      } catch {}
    };
    req.end(JSON.stringify(job));
    this.logger.info(
      `[fargate-exec] exec ${job.argv[0]} in env ${envId} via ${t.ip}:${FARGATE_BRIDGE_PORT}`
    );
    return handle;
  }
}

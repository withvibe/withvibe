/**
 * Source of the exec bridge that runs inside a Fargate env's runner
 * container. Kept as a template literal so the api can serve it at
 * GET /api/fargate/bridge.js — the runner container fetches and runs it at
 * boot, which versions the bridge with the api (no image rebuilds).
 *
 * Contract (all requests except /healthz require `Authorization: Bearer
 * $WV_BRIDGE_TOKEN`):
 *   GET  /healthz          → { ok, claude: <version|null> }
 *   POST /exec             → body { argv, env?, cwd?, files? }; writes the
 *                            files, spawns argv, streams NDJSON events
 *                            {t:"out"|"err",d} ... {t:"exit",code}. Closing
 *                            the response kills the child (SIGTERM).
 *
 * Transport is HTTPS with a per-env self-signed cert the api generates at
 * task start and pins on its side — the bridge rides the task's public IP,
 * so nothing (tokens, MCP configs) may cross in cleartext.
 *
 * Node stdlib only — the runner image guarantees node, nothing else.
 */
export const BRIDGE_SOURCE = `"use strict";
const https = require("https");
const { spawn, execFile } = require("child_process");
const fs = require("fs");
const path = require("path");

const TOKEN = process.env.WV_BRIDGE_TOKEN || "";
const PORT = Number(process.env.WV_BRIDGE_PORT || 7777);
const CERT = Buffer.from(process.env.WV_BRIDGE_TLS_CERT_B64 || "", "base64").toString("utf-8");
const KEY = Buffer.from(process.env.WV_BRIDGE_TLS_KEY_B64 || "", "base64").toString("utf-8");
if (!TOKEN || !CERT || !KEY) {
  console.error("[bridge] missing WV_BRIDGE_TOKEN / TLS material — refusing to start");
  process.exit(1);
}

let claudeVersion = null;
execFile("claude", ["--version"], { timeout: 15000 }, (err, stdout) => {
  claudeVersion = err ? null : String(stdout).trim();
});

function send(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { "content-type": "application/json" });
  res.end(body);
}

function authed(req) {
  const h = req.headers["authorization"] || "";
  return h === "Bearer " + TOKEN;
}

function readBody(req, cb) {
  let data = "";
  req.setEncoding("utf-8");
  req.on("data", (c) => {
    data += c;
    if (data.length > 5_000_000) req.destroy();
  });
  req.on("end", () => cb(data));
}

const server = https.createServer({ cert: CERT, key: KEY }, (req, res) => {
  if (req.method === "GET" && req.url === "/healthz") {
    return send(res, 200, { ok: true, claude: claudeVersion });
  }
  if (!authed(req)) return send(res, 401, { error: "unauthorized" });

  if (req.method === "POST" && req.url === "/exec") {
    return readBody(req, (raw) => {
      let job;
      try {
        job = JSON.parse(raw);
      } catch {
        return send(res, 400, { error: "bad json" });
      }
      if (!Array.isArray(job.argv) || job.argv.length === 0) {
        return send(res, 400, { error: "argv required" });
      }
      try {
        for (const [p, content] of Object.entries(job.files || {})) {
          fs.mkdirSync(path.dirname(p), { recursive: true });
          fs.writeFileSync(p, String(content), "utf-8");
        }
        if (job.cwd) fs.mkdirSync(job.cwd, { recursive: true });
      } catch (err) {
        return send(res, 500, { error: "file write failed: " + err.message });
      }

      res.writeHead(200, { "content-type": "application/x-ndjson" });
      const line = (obj) => {
        try { res.write(JSON.stringify(obj) + "\\n"); } catch {}
      };
      let child;
      try {
        child = spawn(job.argv[0], job.argv.slice(1), {
          cwd: job.cwd || "/workspace",
          env: Object.assign({}, process.env, job.env || {}),
          stdio: ["ignore", "pipe", "pipe"],
        });
      } catch (err) {
        line({ t: "err", d: "spawn failed: " + err.message });
        line({ t: "exit", code: -1 });
        return res.end();
      }
      child.stdout.setEncoding("utf-8");
      child.stderr.setEncoding("utf-8");
      child.stdout.on("data", (d) => line({ t: "out", d }));
      child.stderr.on("data", (d) => line({ t: "err", d }));
      child.on("error", (err) => {
        line({ t: "err", d: "child error: " + err.message });
      });
      child.on("close", (code) => {
        line({ t: "exit", code: code == null ? -1 : code });
        res.end();
      });
      const kill = () => {
        try { child.kill("SIGTERM"); } catch {}
      };
      res.on("close", kill);
      req.on("close", () => {});
    });
  }
  return send(res, 404, { error: "not found" });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log("[bridge] listening on :" + PORT);
});
`;

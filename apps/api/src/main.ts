import "reflect-metadata";
// Load .env BEFORE any other import so shared packages (e.g. @withvibe/db)
// can read process.env.DATABASE_URL at import time.
import "dotenv/config";
import { NestFactory } from "@nestjs/core";
import { Logger, type LogLevel } from "@nestjs/common";
import { json, urlencoded } from "express";
import cookieParser from "cookie-parser";
import { AppModule } from "./app.module";
import { TerminalService } from "./terminal/terminal.service";
import { UserBrowserGateway } from "./docker/user-browser.gateway";
import { QaViewGateway } from "./docker/qa-view.gateway";
import { QaViewHttpProxy } from "./docker/qa-view.http-proxy";
import { SidecarProxy } from "./docker/sidecar-proxy";
import { assertSecretsAtBoot } from "./common/startup-secrets";

// The api runs as root (needs docker.sock) but spawns the claude runner as
// gid 1500. Default umask 022 produces 0644 files / 0755 dirs — claude
// (group 1500 via setgid on envDir) can read them but not write. Bumping
// umask to 002 makes every subsequent fs.mkdir/fs.writeFile leave its
// result group-writable (0664/0775), so the runner agent can edit cloned
// repo files and write compose/extras without per-call chmods. The setgid
// bit on envDir (set in `ensureEnvDir`) handles group propagation.
process.umask(0o002);

async function bootstrap() {
  // C4: fail closed on a weak/empty/placeholder INTERNAL_JWT_SECRET before
  // doing any work. In production this exits; outside it warns loudly.
  assertSecretsAtBoot(process.env, new Logger("Startup"));

  const logLevels: LogLevel[] =
    process.env.LOG_LEVEL === "debug"
      ? ["debug", "log", "warn", "error", "fatal"]
      : ["log", "warn", "error", "fatal"];

  const app = await NestFactory.create(AppModule, { logger: logLevels });
  app.setGlobalPrefix("api");
  // Default body-parser cap is 100KB — too small for template saves that
  // bundle whole folders of assets as JSON. Large binary uploads go through
  // the multipart /assets endpoint and don't hit this limit.
  // cookieParser first (the proxies authenticate off the session cookie),
  // then the same-origin reverse proxies, then the body parsers. The
  // proxies MUST sit ahead of json()/urlencoded(): they stream the raw
  // request body upstream, so the body parsers must not consume it first
  // (code-server / Adminer POSTs). Non-matching paths fall through to the
  // body parsers and Nest as before.
  app.use(cookieParser());
  app.use(app.get(QaViewHttpProxy).middleware());
  app.use(app.get(SidecarProxy).middleware());
  app.use(json({ limit: "50mb" }));
  app.use(urlencoded({ limit: "50mb", extended: true }));

  const port = Number(process.env.API_PORT) || 4000;
  await app.listen(port);

  // Attach WebSocket upgrade handler to the underlying HTTP server.
  // Done after listen() so httpServer is bound.
  const httpServer = app.getHttpServer();
  const terminal = app.get(TerminalService);
  terminal.attach(httpServer);
  const qaBrowserGateway = app.get(UserBrowserGateway);
  qaBrowserGateway.attach(httpServer);
  const qaViewGateway = app.get(QaViewGateway);
  qaViewGateway.attach(httpServer);
  // code-server's workbench/terminals/extension-host all run over WS.
  const sidecarProxy = app.get(SidecarProxy);
  sidecarProxy.attach(httpServer);

  const logger = new Logger("Bootstrap");
  logger.log(`Nest API listening on http://localhost:${port}/api`);
  logger.log(
    `Terminal WebSocket handler attached at ws://localhost:${port}/api/terminal/:envId/:container`
  );
  logger.log(
    `QA-browser extension WebSocket handler attached at ws://localhost:${port}/api/qa-browser/ws/:envId`
  );
  logger.log(
    `QA-browser noVNC viewer at http://localhost:${port}/api/qa-browser/view/:envId (WS relay at /api/qa-browser/view-ws/:envId)`
  );
}

void bootstrap();

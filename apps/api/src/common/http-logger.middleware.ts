import { Injectable, Logger, NestMiddleware } from "@nestjs/common";
import type { NextFunction, Request, Response } from "express";

const MAX_BODY_BYTES = 2048;
const SKIP_PATHS = new Set(["/health", "/api/health"]);

function truncateBody(obj: unknown): unknown {
  const str = JSON.stringify(obj);
  if (!str || str.length <= MAX_BODY_BYTES) return obj;
  return `[truncated ${str.length} chars]`;
}

@Injectable()
export class HttpLoggerMiddleware implements NestMiddleware {
  private readonly logger = new Logger("HTTP");

  use(req: Request, res: Response, next: NextFunction): void {
    const { method, originalUrl, body, query } = req;

    if (SKIP_PATHS.has(originalUrl)) {
      next();
      return;
    }

    const start = Date.now();

    const parts: string[] = [`→ ${method} ${originalUrl}`];
    if (query && Object.keys(query).length > 0) {
      parts.push(`query=${JSON.stringify(truncateBody(query))}`);
    }
    if (body && Object.keys(body as object).length > 0) {
      parts.push(`body=${JSON.stringify(truncateBody(body))}`);
    }
    this.logger.debug(parts.join(" "));

    res.on("finish", () => {
      const ms = Date.now() - start;
      this.logger.debug(`← ${method} ${originalUrl} ${res.statusCode} (${ms}ms)`);
    });

    next();
  }
}

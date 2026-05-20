import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from "@nestjs/common";
import { PinoLogger } from "nestjs-pino";
import { Observable } from "rxjs";
import type { Request } from "express";

/**
 * Tag every log line emitted during a request with the resolved domain
 * context — userId from the auth guard, plus any of workspaceId/envId/
 * sessionId/envRepoId we can pull off the route params. PinoLogger.assign()
 * uses nestjs-pino's per-request AsyncLocalStorage, so the bound fields
 * automatically flow into every `Logger` call made by any service handling
 * this request — no need to thread context through method signatures.
 *
 * Runs after Nest has resolved guards (so req.user is populated) and route
 * params (so :workspaceId/:envId/etc. are on req.params).
 *
 * Wired globally in app.module.ts via APP_INTERCEPTOR; nothing else needs
 * to touch it.
 */
@Injectable()
export class RequestContextInterceptor implements NestInterceptor {
  constructor(private readonly logger: PinoLogger) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== "http") return next.handle();
    const req = context.switchToHttp().getRequest<
      Request & {
        user?: { id?: string };
        params?: Record<string, string>;
      }
    >();

    // Build the field set lazily so we don't `assign({})` (which is harmless
    // but adds a no-op object to the log baggage).
    const fields: Record<string, string> = {};
    if (req.user?.id) fields.userId = req.user.id;
    const params = req.params ?? {};
    if (params.workspaceId) fields.workspaceId = params.workspaceId;
    if (params.envId) fields.envId = params.envId;
    if (params.envRepoId) fields.envRepoId = params.envRepoId;
    if (params.sessionId) fields.sessionId = params.sessionId;
    if (params.agentId) fields.agentId = params.agentId;

    if (Object.keys(fields).length > 0) {
      this.logger.assign(fields);
    }

    return next.handle();
  }
}

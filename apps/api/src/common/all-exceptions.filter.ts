import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
} from "@nestjs/common";
import { InjectPinoLogger, PinoLogger } from "nestjs-pino";
import type { Request, Response } from "express";

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  constructor(
    @InjectPinoLogger("ExceptionFilter")
    private readonly logger: PinoLogger
  ) {}

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const req = ctx.getRequest<Request>();
    const res = ctx.getResponse<Response>();

    // Nothing we can do if headers are already sent (e.g. mid-stream error).
    if (res.headersSent) return;

    const isHttp = exception instanceof HttpException;
    const status = isHttp
      ? exception.getStatus()
      : HttpStatus.INTERNAL_SERVER_ERROR;

    const message = isHttp
      ? (() => {
          const r = exception.getResponse();
          return typeof r === "string"
            ? r
            : ((r as { message?: string }).message ?? exception.message);
        })()
      : exception instanceof Error
        ? exception.message
        : String(exception);

    const context = `${req.method} ${req.url}`;

    if (status >= 500) {
      this.logger.error(
        { err: exception instanceof Error ? exception : new Error(String(exception)) },
        `${context} → ${status} ${message}`
      );
    } else {
      this.logger.warn(`${context} → ${status} ${message}`);
    }

    res.status(status).json({
      statusCode: status,
      message,
      path: req.url,
      timestamp: new Date().toISOString(),
    });
  }
}

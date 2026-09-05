import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
} from "@nestjs/common";
import type { Response } from "express";

/**
 * Normalizes every error response to `{ error: string }`, matching the
 * pre-Nest Express API contract that clients/tests depend on instead of
 * Nest's default `{ statusCode, message, error }` shape.
 */
@Catch()
export class HttpErrorFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const res = ctx.getResponse<Response>();

    const status =
      exception instanceof HttpException
        ? exception.getStatus()
        : HttpStatus.INTERNAL_SERVER_ERROR;

    let message: string;
    if (exception instanceof HttpException) {
      const body = exception.getResponse();
      if (typeof body === "string") {
        message = body;
      } else {
        const b = body as { message?: string | string[]; error?: string };
        const m = b.message ?? b.error;
        message = Array.isArray(m) ? m.join(", ") : m ?? exception.message;
      }
    } else {
      message = (exception as Error)?.message ?? "Internal server error";
    }

    res.status(status).json({ error: message });
  }
}

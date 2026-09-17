import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import type { Response } from 'express';
import { apiFail, type ApiErrorBody } from '../http/api-response';
import { ErrorCode } from '../errors/error-codes';
import { AppException } from '../errors/app-exception';
import { AppLogger } from '../logger/app-logger';
import type { EsportaRequest } from '../http/request-context';

const STATUS_TO_CODE: Record<number, string> = {
  400: ErrorCode.BAD_REQUEST,
  401: ErrorCode.UNAUTHENTICATED,
  403: ErrorCode.FORBIDDEN,
  404: ErrorCode.NOT_FOUND,
  405: ErrorCode.METHOD_NOT_ALLOWED,
  409: ErrorCode.CONFLICT,
  422: ErrorCode.UNPROCESSABLE,
  429: ErrorCode.RATE_LIMITED,
  502: ErrorCode.UPSTREAM_ERROR,
  503: ErrorCode.SERVICE_UNAVAILABLE,
};

/**
 * Client-facing text for any 5xx. Provider and database failures carry raw
 * internals in their message (`permission denied for table posts`,
 * `R2 DELETE failed (403)`, PostgREST sentences, SQLSTATEs, RPC names). None of
 * that is a client contract, so the wire never carries it and the log keeps it.
 */
const GENERIC_5XX_MESSAGE = 'Something went wrong.';

/**
 * Turns any thrown value into the standard error envelope (plan §30) and logs
 * failures once, here — this is the single catch-all, so errors from guards
 * (which run before interceptors) are covered too. 5xx messages AND details are
 * made generic so internal details never leak to clients; the real message is
 * logged.
 *
 * The details scrub is not a nicety: `AppException`s raised from
 * `mapPostgrestError` carry the raw PostgREST sentence, SQLSTATE, hint and the
 * failing RPC name in `details` (deliberately, so admin consoles can phrase a
 * 4xx refusal precisely), and providers raise raw upstream messages. Forwarding
 * those on a 5xx handed a client the schema, the function name and the
 * provider's status code. 4xx keeps both message and details — business rules
 * and the semantic admin hints (`owner_only`, `rate_limited`,
 * `superadmin_locked`, …) travel on 4xx only.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  constructor(private readonly logger: AppLogger) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const res = ctx.getResponse<Response>();
    const req = ctx.getRequest<EsportaRequest>();
    const requestId = req?.esporta?.requestId;

    const { status, error, logMessage, stack } = this.normalise(exception);

    if (status >= 500) {
      this.logger.error(logMessage, stack, 'HTTP');
      this.logger.event('request_error', {
        context: 'HTTP',
        requestId,
        userId: req?.esporta?.user?.id,
        method: req?.method,
        route: req?.originalUrl?.split('?')[0],
        status,
        errorCode: error.code,
      });
    } else {
      this.logger.event('request_rejected', {
        context: 'HTTP',
        requestId,
        userId: req?.esporta?.user?.id,
        method: req?.method,
        route: req?.originalUrl?.split('?')[0],
        status,
        errorCode: error.code,
      });
    }

    if (res.headersSent) return;
    res.status(status).json(apiFail(error, { requestId }));
  }

  private normalise(exception: unknown): {
    status: number;
    error: ApiErrorBody;
    logMessage: string;
    stack?: string;
  } {
    if (exception instanceof AppException) {
      const body = exception.getResponse() as ApiErrorBody;
      const status = exception.getStatus();
      // 5xx: generic message, no details. 4xx: verbatim — the business rule and
      // its semantic hint are the client contract (see the class doc).
      const scrubbed = status >= 500;
      return {
        status,
        error: {
          code: body.code,
          message: scrubbed ? GENERIC_5XX_MESSAGE : body.message,
          details: scrubbed ? undefined : body.details,
        },
        logMessage: body.message,
        stack: exception.stack,
      };
    }

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const raw = exception.getResponse();
      const { message, details } = this.extractHttp(raw);
      const code =
        status === HttpStatus.BAD_REQUEST && details
          ? ErrorCode.VALIDATION_ERROR
          : STATUS_TO_CODE[status] ?? ErrorCode.INTERNAL_ERROR;
      // 5xx get a generic client message (and no details); everything else is
      // safe to surface.
      const clientMessage = status >= 500 ? GENERIC_5XX_MESSAGE : message;
      return {
        status,
        error: { code, message: clientMessage, details: status >= 500 ? undefined : details },
        logMessage: message,
        stack: exception.stack,
      };
    }

    const err = exception instanceof Error ? exception : new Error(String(exception));
    return {
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      error: { code: ErrorCode.INTERNAL_ERROR, message: 'Something went wrong.' },
      logMessage: err.message,
      stack: err.stack,
    };
  }

  private extractHttp(raw: unknown): { message: string; details?: unknown } {
    if (typeof raw === 'string') return { message: raw };
    if (raw && typeof raw === 'object') {
      const obj = raw as Record<string, unknown>;
      const msg = obj.message;
      // ValidationPipe hands back message: string[]
      if (Array.isArray(msg)) {
        return { message: 'Validation failed.', details: msg };
      }
      if (typeof msg === 'string') return { message: msg };
    }
    return { message: 'Request failed.' };
  }
}

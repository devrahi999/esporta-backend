import { HttpException, HttpStatus } from '@nestjs/common';
import { ErrorCode, type ErrorCodeValue } from './error-codes';

interface AppExceptionBody {
  code: ErrorCodeValue;
  message: string;
  details?: unknown;
}

/**
 * An HttpException that carries a stable {@link ErrorCode} alongside the status.
 * The exception filter turns it into the standard error envelope (plan §30).
 * Prefer these named constructors over throwing raw HttpExceptions so every
 * error reaches the client with a code Flutter can switch on.
 */
export class AppException extends HttpException {
  readonly code: ErrorCodeValue;
  readonly details?: unknown;

  constructor(
    status: number,
    code: ErrorCodeValue,
    message: string,
    details?: unknown,
  ) {
    const body: AppExceptionBody = { code, message, details };
    super(body, status);
    this.code = code;
    this.details = details;
  }

  static badRequest(message: string, code: ErrorCodeValue = ErrorCode.BAD_REQUEST, details?: unknown) {
    return new AppException(HttpStatus.BAD_REQUEST, code, message, details);
  }

  static validation(message: string, details?: unknown) {
    return new AppException(HttpStatus.BAD_REQUEST, ErrorCode.VALIDATION_ERROR, message, details);
  }

  static unauthenticated(message = 'You are not signed in.', code: ErrorCodeValue = ErrorCode.UNAUTHENTICATED) {
    return new AppException(HttpStatus.UNAUTHORIZED, code, message);
  }

  static forbidden(message = 'You are not allowed to do that.', code: ErrorCodeValue = ErrorCode.FORBIDDEN, details?: unknown) {
    return new AppException(HttpStatus.FORBIDDEN, code, message, details);
  }

  static reauthRequired(message = 'Please re-authenticate to continue.') {
    return new AppException(HttpStatus.FORBIDDEN, ErrorCode.REAUTH_REQUIRED, message);
  }

  static notFound(message = 'Not found.', code: ErrorCodeValue = ErrorCode.NOT_FOUND, details?: unknown) {
    return new AppException(HttpStatus.NOT_FOUND, code, message, details);
  }

  static conflict(message: string, code: ErrorCodeValue = ErrorCode.CONFLICT, details?: unknown) {
    return new AppException(HttpStatus.CONFLICT, code, message, details);
  }

  static unprocessable(message: string, code: ErrorCodeValue = ErrorCode.UNPROCESSABLE, details?: unknown) {
    return new AppException(HttpStatus.UNPROCESSABLE_ENTITY, code, message, details);
  }

  static upstream(message = 'An upstream service failed.', details?: unknown) {
    return new AppException(HttpStatus.BAD_GATEWAY, ErrorCode.UPSTREAM_ERROR, message, details);
  }

  static unavailable(message = 'Service temporarily unavailable.') {
    return new AppException(HttpStatus.SERVICE_UNAVAILABLE, ErrorCode.SERVICE_UNAVAILABLE, message);
  }

  static internal(message = 'Something went wrong.') {
    return new AppException(HttpStatus.INTERNAL_SERVER_ERROR, ErrorCode.INTERNAL_ERROR, message);
  }
}

import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { tap } from 'rxjs/operators';
import { AppLogger } from '../logger/app-logger';
import type { EsportaRequest } from '../http/request-context';

/**
 * Logs one structured line per successfully-handled HTTP request
 * (method, route, status, duration, requestId, userId). Errors are logged by the
 * global exception filter instead, so failures — including those thrown in
 * guards before this interceptor runs — are never missed or double-counted.
 */
@Injectable()
export class LoggingInterceptor implements NestInterceptor {
  constructor(private readonly logger: AppLogger) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') return next.handle();

    const http = context.switchToHttp();
    const req = http.getRequest<EsportaRequest>();
    const res = http.getResponse<{ statusCode: number }>();
    const startedAt = Date.now();

    return next.handle().pipe(
      tap(() => {
        this.logger.event('request', {
          context: 'HTTP',
          requestId: req.esporta?.requestId,
          userId: req.esporta?.user?.id,
          method: req.method,
          route: (req.route?.path as string) ?? req.originalUrl?.split('?')[0],
          status: res.statusCode,
          durationMs: Date.now() - startedAt,
        });
      }),
    );
  }
}

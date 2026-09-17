import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';
import {
  apiOk,
  ENVELOPE,
  isEnveloped,
  type ApiResponse,
} from '../http/api-response';
import type { EsportaRequest } from '../http/request-context';

/**
 * Wraps every controller return value in the standard success envelope
 * (plan §30) and stamps `meta.requestId`. Controllers that need custom `meta`
 * (pagination, etc.) can return an `enveloped(...)` value, which is passed
 * through with its meta merged rather than double-wrapped.
 */
@Injectable()
export class ResponseInterceptor<T> implements NestInterceptor<T, ApiResponse<T>> {
  intercept(context: ExecutionContext, next: CallHandler<T>): Observable<ApiResponse<T>> {
    if (context.getType() !== 'http') {
      return next.handle() as unknown as Observable<ApiResponse<T>>;
    }
    const req = context.switchToHttp().getRequest<EsportaRequest>();
    const requestId = req.esporta?.requestId;

    return next.handle().pipe(
      map((data): ApiResponse<T> => {
        if (isEnveloped(data)) {
          const { [ENVELOPE]: _marker, ...envelope } = data;
          return {
            ...envelope,
            meta: { requestId, ...envelope.meta },
          } as ApiResponse<T>;
        }
        return apiOk((data ?? null) as T, { requestId });
      }),
    );
  }
}

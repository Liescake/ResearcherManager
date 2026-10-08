import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { ok } from '@rm/shared';
import type { ApiEnvelope } from '@rm/shared';
import type { Observable } from 'rxjs';
import { map } from 'rxjs/operators';
import type { RequestLike, ResponseLike } from './request-context';
import { resolveRequestId } from './request-context';

/**
 * 统一响应信封：把控制器返回值包装为 { data, meta, error }。
 * 控制器只返回业务数据，错误由 ApiExceptionFilter 统一处理。
 */
@Injectable()
export class ApiResponseInterceptor<T> implements NestInterceptor<T, ApiEnvelope<T>> {
  intercept(context: ExecutionContext, next: CallHandler<T>): Observable<ApiEnvelope<T>> {
    const http = context.switchToHttp();
    const request = http.getRequest<RequestLike>();
    const response = http.getResponse<ResponseLike>();
    const requestId = resolveRequestId(request, response);

    return next.handle().pipe(
      map((data) =>
        ok(data, {
          requestId,
          generatedAt: new Date().toISOString(),
        }),
      ),
    );
  }
}

import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { isApiEnvelope, ok } from '@rm/shared';
import type { ApiEnvelope } from '@rm/shared';
import type { Observable } from 'rxjs';
import { map } from 'rxjs/operators';
import type { RequestLike, ResponseLike } from './request-context';
import { resolveRequestId } from './request-context';

/**
 * 统一响应信封：把控制器返回值包装为 { data, meta, error }。
 * 控制器只返回业务数据，错误由 ApiExceptionFilter 统一处理。
 *
 * 例外（显式约定，用于「meta 需要承载分页等元数据」的列表端点）：控制器可以返回由共享
 * `okPaginated` 预先构建的信封，此时拦截器**不再二次包装**（否则会出现 `data.data` 嵌套、
 * 并且 `meta.page/pageSize/total/totalPages` 会丢失），只把服务端解析的 `requestId` 与
 * `generatedAt` **覆盖**进 `meta`——请求 ID 永远来自本层解析，不由控制器或客户端决定。
 */
@Injectable()
export class ApiResponseInterceptor<T> implements NestInterceptor<T, ApiEnvelope<unknown>> {
  intercept(context: ExecutionContext, next: CallHandler<T>): Observable<ApiEnvelope<unknown>> {
    const http = context.switchToHttp();
    const request = http.getRequest<RequestLike>();
    const response = http.getResponse<ResponseLike>();
    const requestId = resolveRequestId(request, response);

    return next.handle().pipe(map((data) => toEnvelope(data, requestId)));
  }
}

/** 已构建信封 → 补齐服务端元数据；其余返回值 → 包装为新信封 */
function toEnvelope<T>(data: T, requestId: string): ApiEnvelope<unknown> {
  const generatedAt = new Date().toISOString();
  if (isApiEnvelope(data)) {
    return {
      data: data.data,
      meta: { ...data.meta, requestId, generatedAt },
      error: data.error,
    };
  }
  return ok(data, { requestId, generatedAt });
}

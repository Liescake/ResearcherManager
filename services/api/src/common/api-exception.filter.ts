import { ArgumentsHost, Catch, ExceptionFilter, HttpException, Logger } from '@nestjs/common';
import { ApiErrorCode, BusinessRuleError, fail, statusForErrorCode } from '@rm/shared';
import type { ApiEnvelope } from '@rm/shared';
import { ZodError } from 'zod';
import { projectApiErrorBody, stableInternalErrorBody } from './operational-output';
import type { RequestLike, ResponseLike } from './request-context';
import { resolveRequestId, safeRequestPath } from './request-context';

/**
 * 统一错误出口：
 * - 业务错误（BusinessRuleError / StateTransitionError）→ 对应错误码；
 * - 入参校验失败（ZodError）→ VALIDATION_FAILED + 字段级 issues；
 * - HttpException → 按状态码映射错误码；
 * - 其他异常 → INTERNAL_ERROR，且不向客户端泄露内部细节。
 * 日志只写脱敏信息（方法、路径、状态、错误码），不写请求体与隐私原文。
 *
 * **闭集脱敏投影（本次加固）**：错误响应不再直接输出「映射结果」，而是先经过统一运维出口契约
 * （`common/operational-output.ts`）的投影：
 * - 信封收敛为 `{ data: null, meta: { requestId }, error: { code, message, requestId, details? } }`；
 * - **状态码与错误码永不变**（客户端按 code 分支，不解析 message）：文案安全则保留，
 *   命中脱敏规则（连接串 / 口令 / SQL / 证据 ID / 内部路径 / owner-user ID / provider 名称 /
 *   原始异常）则替换为该错误码的稳定默认文案；`details` 命中即整体丢弃；
 * - **任何 5xx 一律走 `stableInternalErrorBody()`**：只有 `INTERNAL_ERROR` + 稳定默认文案 +
 *   requestId，不带自定义 message、不带 details —— 500 的输出因此与具体异常无关、可回归断言。
 *
 * 这条投影与 health / runtime-info / 启动日志共用同一套判定，避免四个出口各写一遍规则而产生
 * 不对称的缺口（例如新增出口时漏掉脱敏）。
 */
@Catch()
export class ApiExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(ApiExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const request = http.getRequest<RequestLike>();
    const response = http.getResponse<ResponseLike>();
    const requestId = resolveRequestId(request, response);
    const { status, body } = this.toResponse(exception, requestId);

    this.logger.warn(
      `[${requestId}] ${request?.method ?? 'UNKNOWN'} ${safeRequestPath(request)} -> ${status} ${
        body.error?.code ?? 'UNKNOWN'
      }`,
    );

    if (typeof response.status === 'function' && typeof response.json === 'function') {
      const responseWithStatus = response.status(status);
      if (responseWithStatus?.json) responseWithStatus.json(body);
      return;
    }
    // 非 HTTP 上下文（例如定时任务）时至少不吞掉异常
    this.logger.error(`[${requestId}] 无法写入响应：${describeError(exception)}`);
  }

  private toResponse(
    exception: unknown,
    requestId: string,
  ): { status: number; body: ApiEnvelope<never> } {
    const mapped = this.mapException(exception, requestId);
    // 5xx：稳定脱敏错误体（与异常内容无关）；其余：闭集 + 脱敏投影（码与状态不变）
    const body =
      mapped.status >= 500 ? stableInternalErrorBody(requestId) : projectApiErrorBody(mapped.body);
    return { status: mapped.status, body };
  }

  private mapException(
    exception: unknown,
    requestId: string,
  ): { status: number; body: ApiEnvelope<never> } {
    if (exception instanceof BusinessRuleError) {
      const body = fail(exception.code, {
        message: safeBusinessMessage(exception),
        requestId,
        ...(exception.details ? { details: exception.details } : {}),
      });
      return { status: httpStatusForBusinessCode(exception.code), body };
    }

    if (exception instanceof ZodError) {
      const issues = exception.issues.map((issue) => ({
        path: issue.path.join('.'),
        message: issue.message,
      }));
      const firstMessage = issues[0]?.message;
      return {
        status: 400,
        body: fail(ApiErrorCode.ValidationFailed, {
          ...(firstMessage ? { message: firstMessage } : {}),
          requestId,
          details: { issues },
        }),
      };
    }

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const code = errorCodeForHttpStatus(status);
      const responseBody = exception.getResponse();
      const rawMessage =
        typeof responseBody === 'string' ? responseBody : readMessage(responseBody);
      const message =
        status >= 500 || isRequestBodyParseFailure(exception, rawMessage) ? undefined : rawMessage;
      return {
        status,
        body: fail(code, {
          ...(message ? { message } : {}),
          requestId,
        }),
      };
    }

    // 未知异常：对外只给稳定错误码与安全消息，细节进日志
    this.logger.error(`[${requestId}] 未处理异常: ${describeError(exception)}`);
    return { status: 500, body: fail(ApiErrorCode.InternalError, { requestId }) };
  }
}

/**
 * 请求体解析失败（body-parser）的消息会**回显原始请求体片段**，例如
 * `Unexpected token '"', ""{"api_key":"sk-…"}"" is not valid JSON`。按 `error-codes.ts` 的
 * 「message 必须是用户安全消息，不得泄露敏感字段原文」规则，这类消息一律替换为稳定默认文案：
 * **错误码与状态码不变**（客户端按 code 分支，不解析 message），只去掉回显。
 *
 * 识别依据（任一成立即可，避免依赖 Nest 包装后是否保留 `type`）：
 * 1. 异常自带 body-parser 的错误类型（`entity.parse.failed` / `entity.verify.failed`）；
 * 2. 消息形如 JSON 解析失败（strict 模式拒绝 JSON 标量 / 语法错误 / 截断）。
 */
function isRequestBodyParseFailure(
  exception: HttpException,
  rawMessage: string | undefined,
): boolean {
  const type = (exception as { type?: unknown }).type;
  if (type === 'entity.parse.failed' || type === 'entity.verify.failed') return true;
  return (
    typeof rawMessage === 'string' &&
    /is not valid JSON|Unexpected end of JSON input|in JSON at position \d+/u.test(rawMessage)
  );
}

function readMessage(responseBody: unknown): string | undefined {
  if (typeof responseBody === 'object' && responseBody !== null) {
    const message = (responseBody as { message?: unknown }).message;
    if (typeof message === 'string') {
      return message;
    }
    if (Array.isArray(message)) {
      const first = message.find((item): item is string => typeof item === 'string');
      return first;
    }
  }
  return undefined;
}

function errorCodeForHttpStatus(status: number): ApiErrorCode {
  switch (status) {
    case 400:
      return ApiErrorCode.ValidationFailed;
    case 401:
      return ApiErrorCode.Unauthenticated;
    case 403:
      return ApiErrorCode.Forbidden;
    case 404:
      return ApiErrorCode.NotFound;
    case 409:
      return ApiErrorCode.Conflict;
    case 429:
      return ApiErrorCode.RateLimited;
    default:
      return status >= 500 ? ApiErrorCode.InternalError : ApiErrorCode.ValidationFailed;
  }
}

/**
 * 业务错误码 → HTTP 状态码。
 * 未知业务码按 400 处理：这类错误来自我们自己的领域规则，不是服务端崩溃。
 */
function httpStatusForBusinessCode(code: string): number {
  switch (code) {
    case 'STATE_TRANSITION_INVALID':
    case 'MEMBERSHIP_NOT_ACTIVE':
      return 409;
    default: {
      const mapped = statusForErrorCode(code);
      // 共享包对未知错误码返回 500；领域规则拒绝应按 400 返回
      return mapped === 500 ? 400 : mapped;
    }
  }
}

/** 业务消息本身是面向用户的安全文案；仍然做长度截断，避免异常刷屏 */
function safeBusinessMessage(error: BusinessRuleError): string {
  const message =
    typeof error.message === 'string' && error.message.trim() !== '' ? error.message : error.code;
  return message.length > 200 ? `${message.slice(0, 199)}…` : message;
}

function describeError(exception: unknown): string {
  if (exception instanceof Error) {
    return exception.name;
  }
  return typeof exception;
}

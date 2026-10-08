import { Logger, NotFoundException } from '@nestjs/common';
import type { ArgumentsHost } from '@nestjs/common';
import { BusinessRuleError, StateTransitionError, studentProfileInputSchema } from '@rm/shared';
import type { ApiEnvelope } from '@rm/shared';
import { ZodError } from 'zod';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiExceptionFilter } from './api-exception.filter';

interface Capture {
  status?: number;
  body?: ApiEnvelope<never>;
}

function createHost(capture: Capture, request: Record<string, unknown> = {}) {
  const response = {
    status(code: number) {
      capture.status = code;
      return this;
    },
    json(body: unknown) {
      capture.body = body as ApiEnvelope<never>;
      return this;
    },
    setHeader: () => undefined,
    getHeader: () => undefined,
  };
  return {
    switchToHttp: () => ({
      getRequest: () => ({ method: 'POST', url: '/api/v1/x?token=secret', ...request }),
      getResponse: () => response,
    }),
  } as unknown as ArgumentsHost;
}

function zodError(): ZodError {
  const result = studentProfileInputSchema.safeParse({ name: '' });
  if (result.success) {
    throw new Error('测试数据应当校验失败');
  }
  return result.error;
}

describe('统一异常映射', () => {
  beforeEach(() => {
    // 过滤器的日志属于被测行为之外，静音以保持测试输出可读
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });

  it('状态机非法转移映射为 409 与 STATE_TRANSITION_INVALID', () => {
    const capture: Capture = {};
    new ApiExceptionFilter().catch(
      new StateTransitionError('application', 'rejected', 'completed'),
      createHost(capture),
    );

    expect(capture.status).toBe(409);
    expect(capture.body?.error?.code).toBe('STATE_TRANSITION_INVALID');
    expect(capture.body?.data).toBeNull();
    expect(capture.body?.error?.requestId).toBeTruthy();
  });

  it('业务规则错误保留稳定错误码与安全消息', () => {
    const capture: Capture = {};
    new ApiExceptionFilter().catch(
      new BusinessRuleError('MEMBERSHIP_NOT_ACTIVE', '当前成员关系不是 active，无法提交退组'),
      createHost(capture),
    );

    expect(capture.status).toBe(409);
    expect(capture.body?.error?.code).toBe('MEMBERSHIP_NOT_ACTIVE');
  });

  it('zod 校验失败映射为 400 并返回字段级 issues', () => {
    const capture: Capture = {};
    new ApiExceptionFilter().catch(zodError(), createHost(capture));

    expect(capture.status).toBe(400);
    expect(capture.body?.error?.code).toBe('VALIDATION_FAILED');
    const details = capture.body?.error?.details as unknown as {
      issues: { path: string; message: string }[];
    };
    expect(details.issues.length).toBeGreaterThan(0);
    expect(details.issues[0]).toHaveProperty('path');
  });

  it('HttpException 按状态码映射，不返回 200 假成功', () => {
    const capture: Capture = {};
    new ApiExceptionFilter().catch(new NotFoundException('小组不存在'), createHost(capture));

    expect(capture.status).toBe(404);
    expect(capture.body?.error?.code).toBe('NOT_FOUND');
    expect(capture.body?.error?.message).toBe('小组不存在');
  });

  it('未知异常返回 500 且不回显内部错误细节', () => {
    const capture: Capture = {};
    new ApiExceptionFilter().catch(
      new Error('connect failed: postgresql://user:sup3rsecret@db:5432/app'),
      createHost(capture),
    );

    expect(capture.status).toBe(500);
    expect(capture.body?.error?.code).toBe('INTERNAL_ERROR');
    expect(JSON.stringify(capture.body)).not.toContain('sup3rsecret');
  });

  it('错误响应中的请求 ID 与请求头一致（不写入 URL 查询串）', () => {
    const capture: Capture = {};
    new ApiExceptionFilter().catch(
      new BusinessRuleError('X', 'y'),
      createHost(capture, { headers: { 'x-request-id': 'req-42' } }),
    );
    expect(capture.body?.error?.requestId).toBeTruthy();
  });
});

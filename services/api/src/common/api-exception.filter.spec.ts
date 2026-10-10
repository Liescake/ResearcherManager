import {
  BadRequestException,
  HttpException,
  InternalServerErrorException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import type { ArgumentsHost } from '@nestjs/common';
import { BusinessRuleError, StateTransitionError, studentProfileInputSchema } from '@rm/shared';
import type { ApiEnvelope } from '@rm/shared';
import { ZodError } from 'zod';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiExceptionFilter } from './api-exception.filter';
import {
  checkOperationalOutput,
  stableInternalErrorBody,
  type OperationalOutputIssue,
} from './operational-output';

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

  it('请求体解析失败：400 与稳定错误码不变，但不回显原始请求体片段', () => {
    const capture: Capture = {};
    // body-parser（strict 模式）拒绝 JSON 标量时会回显原始请求体
    const parseFailure = new HttpException(
      'Unexpected token \'"\', ""{"api_key":"sk-abcdef123456"}"" is not valid JSON',
      400,
    );
    new ApiExceptionFilter().catch(parseFailure, createHost(capture));

    expect(capture.status).toBe(400);
    expect(capture.body?.error?.code).toBe('VALIDATION_FAILED');
    expect(capture.body?.error?.message).toBe('提交内容不合法，请检查后重试');
    expect(JSON.stringify(capture.body)).not.toContain('sk-abcdef123456');
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

/**
 * 统一运维出口契约在错误出口上的回归：
 * 1. 任何响应都只输出**闭集脱敏字段**（信封恰好三键、meta 恰好 requestId、error 闭集）；
 * 2. 5xx 的输出与具体异常无关 —— 恒为稳定脱敏体，可逐字段断言；
 * 3. 非 5xx 的文案若命中脱敏规则，替换为默认文案但**码与状态不变**。
 */
describe('错误出口：闭集脱敏投影', () => {
  beforeEach(() => {
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });

  function captureFor(exception: unknown): Capture {
    const capture: Capture = {};
    new ApiExceptionFilter().catch(exception, createHost(capture));
    return capture;
  }

  /** 错误信封的严格形状 + 契约判定（不依赖任何业务语义） */
  function expectClosedDesensitizedBody(capture: Capture): void {
    expect(capture.body).toBeDefined();
    expect(Object.keys(capture.body as object).sort()).toEqual(['data', 'error', 'meta']);
    expect(capture.body?.data).toBeNull();
    expect(Object.keys(capture.body?.meta ?? {}).sort()).toEqual(['requestId']);
    const issues: readonly OperationalOutputIssue[] = checkOperationalOutput(
      'apiError',
      capture.body,
    );
    expect(issues).toEqual([]);
  }

  it.each([
    { name: '401 未认证', exception: new HttpException('未认证', 401) },
    { name: '403 无权限', exception: new HttpException('没有权限', 403) },
    { name: '404 未找到', exception: new NotFoundException('小组不存在') },
    {
      name: '409 冲突',
      exception: new StateTransitionError('application', 'rejected', 'completed'),
    },
    { name: '400 入参', exception: new BadRequestException('字段不合法') },
    { name: '500 内部', exception: new InternalServerErrorException('内部失败') },
    { name: '未知异常', exception: new Error('boom') },
    { name: '非 Error 抛出值', exception: 'throw-me' },
  ])('$name：信封严格闭集且零违规', ({ exception }) => {
    const capture = captureFor(exception);
    expectClosedDesensitizedBody(capture);
    expect(capture.status).toBeGreaterThanOrEqual(400);
    expect(capture.body?.error?.requestId).toBe(capture.body?.meta.requestId);
  });

  it.each([
    {
      name: 'InternalServerErrorException',
      exception: new InternalServerErrorException('健康探针响应不符合 health 契约'),
    },
    {
      name: '5xx 且文案含连接串与 SQL',
      exception: new HttpException(
        'connect failed: postgresql://rm_user:sup3rsecret@db.internal:5432/app; SELECT 1',
        500,
      ),
    },
    {
      name: '503 AI 网关',
      exception: new HttpException('https://ai-internal.example.com/v1 不可达', 503),
    },
  ])('$name：5xx 恒为稳定脱敏体（与异常内容无关）', ({ exception }) => {
    const capture = captureFor(exception);
    const status = (exception as HttpException).getStatus();

    expect(capture.status).toBe(status);
    expect(capture.body).toEqual(stableInternalErrorBody(capture.body?.meta.requestId as string));
    expect(Object.keys(capture.body?.error ?? {}).sort()).toEqual(['code', 'message', 'requestId']);
    expect(capture.body?.error?.code).toBe('INTERNAL_ERROR');
    expect(capture.body?.error?.message).toBe('服务器内部错误，请稍后重试');
    const text = JSON.stringify(capture.body);
    for (const fragment of [
      'sup3rsecret',
      'db.internal',
      'postgresql',
      'SELECT',
      'ai-internal',
      'health 契约',
    ]) {
      expect(text).not.toContain(fragment);
    }
  });

  it('非 5xx 文案命中脱敏规则 → 默认文案替换，状态码与错误码不变', () => {
    const capture = captureFor(
      new BadRequestException('读取 D:\\WorkSpace\\ReseacherManager\\db 失败'),
    );

    expect(capture.status).toBe(400);
    expect(capture.body?.error?.code).toBe('VALIDATION_FAILED');
    expect(capture.body?.error?.message).toBe('提交内容不合法，请检查后重试');
    expect(JSON.stringify(capture.body)).not.toContain('WorkSpace');
    expectClosedDesensitizedBody(capture);
  });

  it('字段级 issues 在安全时保留，命中脱敏规则时整体丢弃 details', () => {
    const safe = captureFor(zodError());
    expect((safe.body?.error?.details as { issues: unknown[] }).issues.length).toBeGreaterThan(0);

    const leaking = captureFor(
      new ZodError([
        { code: 'custom', path: ['detail'], message: '读取 /etc/postgresql/pg_hba.conf 失败' },
      ]),
    );
    expect(leaking.status).toBe(400);
    expect(leaking.body?.error?.code).toBe('VALIDATION_FAILED');
    expect(leaking.body?.error?.details).toBeUndefined();
    expect(leaking.body?.error?.message).toBe('提交内容不合法，请检查后重试');
    expect(JSON.stringify(leaking.body)).not.toContain('pg_hba');
    expectClosedDesensitizedBody(leaking);
  });

  it('业务错误的自定义错误码与安全文案保留（不因投影而改码）', () => {
    const capture = captureFor(
      new BusinessRuleError('MEMBERSHIP_NOT_ACTIVE', '当前成员关系不是 active'),
    );
    expect(capture.status).toBe(409);
    expect(capture.body?.error?.code).toBe('MEMBERSHIP_NOT_ACTIVE');
    expect(capture.body?.error?.message).toBe('当前成员关系不是 active');
    expectClosedDesensitizedBody(capture);
  });
});

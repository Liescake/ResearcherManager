import 'reflect-metadata';
import { request } from 'node:http';
import type { INestApplication, Type } from '@nestjs/common';
import { InternalServerErrorException, Logger, Module } from '@nestjs/common';
import { APP_FILTER, APP_INTERCEPTOR, NestFactory } from '@nestjs/core';
import { ApiErrorCode } from '@rm/shared';
import type { ApiEnvelope } from '@rm/shared';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiExceptionFilter } from '../../common/api-exception.filter';
import { ApiResponseInterceptor } from '../../common/api-response.interceptor';
import { ConfigModule } from '../../config/config.module';
import { loadEnv } from '../../config/env';
import {
  checkHealthDataAgainstContract,
  checkReadinessDataAgainstContract,
} from '../ruoyi-adapter/contract/health-contract';
import { HealthController } from './health.controller';
import { HealthModule } from './health.module';
import type { HealthPayload, ReadinessPayload } from './health.service';
import { SERVICE_NAME, SERVICE_VERSION, HealthService } from './health.service';

/**
 * 真实控制器测试：启动**真实 Nest 应用**（保留全局响应信封与统一异常映射），
 * 通过真实 HTTP 断言 /health 与 /health/ready 的契约校验行为：
 * 合法数据原样返回（字段与路径不变），非法数据服务端 500 且不泄露、不被当作正常输出。
 */

const degradedEnv = loadEnv({});
const readyEnv = loadEnv({
  DATABASE_URL: 'postgresql://postgres:postgres@127.0.0.1:5432/researcher_manager',
  SESSION_SECRET: 'a'.repeat(48),
  AI_MATCHING_ENABLED: 'true',
  AI_PROVIDER: 'http-json',
});

/** 合法 /health 输出（时间戳固定，便于断言取值未被改写） */
const validHealth: HealthPayload = new HealthService(degradedEnv).getHealth(
  new Date('2026-01-01T00:00:00.000Z'),
);
/** 合法 /health/ready 输出（degraded：缺少 DATABASE_URL / SESSION_SECRET） */
const validReadiness: ReadinessPayload = new HealthService(degradedEnv).getReadiness();

/** 契约 additionalProperties: false：未声明的额外字段必须被拦截 */
const healthWithUndeclaredField = { ...validHealth, internalAddress: '10.0.0.1:5432' };

const startedApps: INestApplication[] = [];

/**
 * 与生产装配同构的测试模块：只把 HealthService 换成测试替身，全局信封与异常映射保持一致。
 * 合法路径仍使用真实 HealthService。
 */
function healthTestModule(service: unknown): Type<unknown> {
  @Module({
    controllers: [HealthController],
    providers: [
      { provide: HealthService, useValue: service },
      { provide: APP_INTERCEPTOR, useClass: ApiResponseInterceptor },
      { provide: APP_FILTER, useClass: ApiExceptionFilter },
    ],
  })
  class HealthControllerTestModule {}

  return HealthControllerTestModule;
}

/** 真实 HTTP 起点：与 main.ts 一致地设置 /api/v1 全局前缀 */
async function startApp(module: Type<unknown>): Promise<string> {
  const app = await NestFactory.create(module, { logger: false });
  app.setGlobalPrefix('api/v1');
  await app.listen(0, '127.0.0.1');
  startedApps.push(app);

  return `${await app.getUrl()}/api/v1`;
}

interface HttpResult {
  status: number;
  text: string;
  body: ApiEnvelope<unknown>;
}

/** 每次请求使用独立连接（agent: false），避免 keep-alive 让 app.close() 等待空闲连接 */
function get(baseUrl: string, path: string): Promise<HttpResult> {
  return new Promise<HttpResult>((resolve, reject) => {
    const req = request(`${baseUrl}${path}`, { agent: false }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => {
        text += chunk;
      });
      res.on('end', () => {
        resolve({
          status: res.statusCode ?? 0,
          text,
          body: JSON.parse(text) as ApiEnvelope<unknown>,
        });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

afterAll(async () => {
  await Promise.all(startedApps.map((app) => app.close()));
});

describe('健康探针正常输出保持不变（真实 Nest 应用 + 真实 HTTP）', () => {
  it('合法 /health 数据原样返回：路径与字段集合不变', async () => {
    const baseUrl = await startApp(healthTestModule(new HealthService(degradedEnv)));
    const { status, body } = await get(baseUrl, '/health');

    expect(status).toBe(200);
    expect(body.error).toBeNull();
    expect(body.data).toMatchObject({
      status: 'ok',
      service: SERVICE_NAME,
      version: SERVICE_VERSION,
      prefix: '/api/v1',
    });
    expect(Object.keys(body.data as Record<string, unknown>).sort()).toEqual([
      'prefix',
      'service',
      'status',
      'timestamp',
      'uptimeSeconds',
      'version',
    ]);
    expect(body.meta.requestId).toBeTruthy();
    // 合法输出没有被新校验误伤
    expect(checkHealthDataAgainstContract(body.data)).toEqual([]);
  });

  it('配置齐全时 /health/ready 仍是 ready', async () => {
    const baseUrl = await startApp(healthTestModule(new HealthService(readyEnv)));
    const { status, body } = await get(baseUrl, '/health/ready');

    expect(status).toBe(200);
    expect(body.error).toBeNull();
    expect(Object.keys(body.data as Record<string, unknown>).sort()).toEqual(['checks', 'status']);
    const readiness = body.data as ReadinessPayload;
    expect(readiness.status).toBe('ready');
    expect(readiness.checks.every((check) => check.status === 'ok')).toBe(true);
    expect(checkReadinessDataAgainstContract(body.data)).toEqual([]);
  });

  it('缺少依赖配置时 /health/ready 保持 degraded，而不是传输失败', async () => {
    const baseUrl = await startApp(healthTestModule(new HealthService(degradedEnv)));
    const { status, body } = await get(baseUrl, '/health/ready');

    // degraded 是业务事实：HTTP 仍是 200 + error: null，不能被改成错误响应
    expect(status).toBe(200);
    expect(body.error).toBeNull();
    const readiness = body.data as ReadinessPayload;
    expect(readiness.status).toBe('degraded');
    expect(readiness.checks).toHaveLength(3);
    expect(checkReadinessDataAgainstContract(body.data)).toEqual([]);
  });
});

describe('非法健康数据必须服务端 500，不允许被当作正常输出', () => {
  const illegalHealthCases: ReadonlyArray<{ name: string; payload: unknown }> = [
    { name: '契约未声明的额外字段', payload: healthWithUndeclaredField },
    {
      name: '缺失必需字段 prefix',
      payload: (() => {
        const { prefix: _prefix, ...rest } = validHealth;
        return rest;
      })(),
    },
    { name: '非法 semver', payload: { ...validHealth, version: '0.1' } },
    { name: '非 ISO 时间戳', payload: { ...validHealth, timestamp: '2026-01-01 00:00:00' } },
  ];

  it.each(illegalHealthCases)('/health 非法数据（$name）→ 500', async ({ payload }) => {
    const baseUrl = await startApp(healthTestModule({ getHealth: () => payload }));
    const { status, text, body } = await get(baseUrl, '/health');

    expect(status).toBe(500);
    expect(body.data).toBeNull();
    expect(body.error?.code).toBe(ApiErrorCode.InternalError);
    // 非法数据不能顺着错误响应泄露出去
    expect(text).not.toContain('10.0.0.1');
    expect(text).not.toContain('internalAddress');
  });

  const illegalReadinessCases: ReadonlyArray<{ name: string; payload: unknown }> = [
    {
      name: '闭集之外的巡检项',
      payload: {
        ...validReadiness,
        checks: [...validReadiness.checks, { name: 'redis', status: 'ok' }],
      },
    },
    { name: '空的 checks', payload: { ...validReadiness, checks: [] } },
    {
      name: '巡检项出现未声明字段',
      payload: { ...validReadiness, checks: [{ name: 'database', status: 'ok', host: 'db' }] },
    },
    {
      name: 'status=ready 但存在非 ok 检查项',
      payload: { status: 'ready', checks: [{ name: 'database', status: 'not_configured' }] },
    },
    {
      name: 'status=degraded 但全部检查项为 ok',
      payload: {
        status: 'degraded',
        checks: [
          { name: 'database', status: 'ok' },
          { name: 'sessionSecret', status: 'ok' },
          { name: 'aiMatching', status: 'ok' },
        ],
      },
    },
  ];

  it.each(illegalReadinessCases)('/health/ready 非法数据（$name）→ 500', async ({ payload }) => {
    const baseUrl = await startApp(healthTestModule({ getReadiness: () => payload }));
    const { status, body } = await get(baseUrl, '/health/ready');

    expect(status).toBe(500);
    expect(body.data).toBeNull();
    expect(body.error?.code).toBe(ApiErrorCode.InternalError);
  });
});

describe('运维取值级脱敏门禁：契约合法但含敏感取值同样 500', () => {
  const secretConnectionString =
    'postgresql://rm_user:pg-sup3rsecret@db.internal:5432/researcher_manager';
  const readinessWithSecret = {
    status: 'ready',
    checks: [
      { name: 'database', status: 'ok', detail: `已连接 ${secretConnectionString}` },
      { name: 'sessionSecret', status: 'ok' },
      { name: 'aiMatching', status: 'ok' },
    ],
  };

  it('契约检查本身通过（字段名与取值类型都合法），因此只能由脱敏门禁拦下', () => {
    expect(checkReadinessDataAgainstContract(readinessWithSecret)).toEqual([]);
  });

  it('真实 HTTP：/health/ready → 500，且响应不回显连接串的任何片段', async () => {
    const baseUrl = await startApp(healthTestModule({ getReadiness: () => readinessWithSecret }));
    const { status, text, body } = await get(baseUrl, '/health/ready');

    expect(status).toBe(500);
    expect(body.data).toBeNull();
    expect(body.error?.code).toBe(ApiErrorCode.InternalError);
    for (const fragment of ['sup3rsecret', 'db.internal', '5432', 'postgresql://', 'rm_user']) {
      expect(text).not.toContain(fragment);
    }
  });

  it('控制器单元：detail 里出现 SQL 语句同样抛 500（不返回不合规数据）', () => {
    const controller = new HealthController({
      getReadiness: () => ({
        status: 'ready',
        checks: [
          { name: 'database', status: 'ok', detail: 'SELECT count(*) FROM pg_stat_activity' },
          { name: 'sessionSecret', status: 'ok' },
          { name: 'aiMatching', status: 'ok' },
        ],
      }),
    } as unknown as HealthService);

    expect(() => controller.getReadiness()).toThrow(InternalServerErrorException);
  });

  it('控制器单元：内部文件路径出现在 detail 里同样抛 500', () => {
    const controller = new HealthController({
      getReadiness: () => ({
        status: 'degraded',
        checks: [
          { name: 'database', status: 'ok', detail: 'D:\\WorkSpace\\ReseacherManager\\db' },
          { name: 'sessionSecret', status: 'not_configured' },
          { name: 'aiMatching', status: 'degraded' },
        ],
      }),
    } as unknown as HealthService);

    expect(() => controller.getReadiness()).toThrow(InternalServerErrorException);
  });
});

describe('控制器契约校验的单元行为', () => {
  beforeEach(() => {
    // 契约违规的日志属于观测行为，静音以保持测试输出可读
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });

  function controllerWith(service: unknown): HealthController {
    return new HealthController(service as unknown as HealthService);
  }

  it('校验通过时返回同一对象：不复制、不改写任何字段', () => {
    const controller = controllerWith({
      getHealth: () => validHealth,
      getReadiness: () => validReadiness,
    });

    expect(controller.getHealth()).toBe(validHealth);
    expect(controller.getReadiness()).toBe(validReadiness);
  });

  it('校验失败时抛出 500，而不是把不合规数据返回给调用方', () => {
    const controller = controllerWith({ getHealth: () => healthWithUndeclaredField });

    let thrown: unknown;
    try {
      controller.getHealth();
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(InternalServerErrorException);
    expect((thrown as InternalServerErrorException).getStatus()).toBe(500);
  });
});

@Module({
  imports: [ConfigModule, HealthModule],
  providers: [
    { provide: APP_INTERCEPTOR, useClass: ApiResponseInterceptor },
    { provide: APP_FILTER, useClass: ApiExceptionFilter },
  ],
})
class HealthWiringModule {}

describe('生产模块装配（ConfigModule + HealthModule，运行时无 design:paramtypes）', () => {
  it('真实模块图能解析依赖，并返回契约合规的 /health 与 /health/ready', async () => {
    const baseUrl = await startApp(HealthWiringModule);

    const health = await get(baseUrl, '/health');
    expect(health.status).toBe(200);
    expect(checkHealthDataAgainstContract(health.body.data)).toEqual([]);

    const readiness = await get(baseUrl, '/health/ready');
    expect(readiness.status).toBe(200);
    expect(checkReadinessDataAgainstContract(readiness.body.data)).toEqual([]);
  });
});

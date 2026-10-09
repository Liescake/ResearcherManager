import 'reflect-metadata';
import { request } from 'node:http';
import type { INestApplication, Type } from '@nestjs/common';
import { InternalServerErrorException, Logger, Module } from '@nestjs/common';
import { APP_FILTER, APP_INTERCEPTOR, NestFactory } from '@nestjs/core';
import { ApiErrorCode } from '@rm/shared';
import type { ApiEnvelope } from '@rm/shared';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiExceptionFilter } from '../../common/api-exception.filter';
import { ApiResponseInterceptor } from '../../common/api-response.interceptor';
import { APP_ENV, ConfigModule } from '../../config/config.module';
import type { AppEnv } from '../../config/env';
import { loadEnv } from '../../config/env';
import { describeDependencyReadinessTier } from '../../db/persistence/dependency-readiness';
import { HealthModule } from '../health/health.module';
import {
  checkHealthDataAgainstContract,
  checkReadinessDataAgainstContract,
} from '../ruoyi-adapter/contract/health-contract';
import { RuntimeInfoController } from './runtime-info.controller';
import { RuntimeInfoModule } from './runtime-info.module';
import type { RuntimeInfoPayload } from './runtime-info.service';
import {
  RUNTIME_INFO_FIELDS,
  RuntimeInfoService,
  checkRuntimeInfoFields,
  toRuntimeInfo,
} from './runtime-info.service';

/**
 * 真实控制器测试：启动**真实 Nest 应用**（保留全局响应信封与统一异常映射），
 * 通过真实 HTTP 断言 `GET /api/v1/runtime-info`：
 * 1. 字段闭集（恰好 7 个白名单字段，多一个少一个都不行）；
 * 2. 开关矩阵（NODE_ENV / API_PORT / API_PREFIX / DATABASE_URL / 依赖就绪门禁档位 /
 *    AI_PROVIDER / AI_MATCHING_ENABLED）；
 * 3. 敏感值不泄露（连接串、会话密钥、AI key、AI base URL、微信密钥、原始 env 字段名、
 *    依赖就绪证据/后端标识）；
 * 4. 注入 runtime-info 后健康路由行为不变。
 */

/** 禁止出现在响应里的敏感取值（测试用的哨兵串） */
const SECRETS = {
  databaseUrl: 'postgresql://rm_user:pg-sup3rsecret@127.0.0.1:5432/researcher_manager',
  sessionSecret: 'session-sup3rsecret-a1b2c3d4e5f6',
  aiApiKey: 'sk-ai-sup3rsecret-abcdef0123456789',
  aiBaseUrl: 'https://ai-internal.example.com/secret-gateway',
  wechatAppSecret: 'wechat-sup3rsecret-9876543210',
} as const;

const SENSITIVE_FRAGMENTS: readonly string[] = [
  'sup3rsecret',
  SECRETS.databaseUrl,
  SECRETS.sessionSecret,
  SECRETS.aiApiKey,
  SECRETS.aiBaseUrl,
  SECRETS.wechatAppSecret,
  '127.0.0.1:5432',
  '/secret-gateway',
];

/** 原始 env 的变量名本身也不得成为对外字段 */
const FORBIDDEN_FIELD_NAMES: readonly string[] = [
  'DATABASE_URL',
  'SESSION_SECRET',
  'AI_API_KEY',
  'AI_BASE_URL',
  'AI_MODEL',
  'WECHAT_MINIAPP_APP_SECRET',
  'process.env',
  'processEnv',
];

const defaultEnv = loadEnv({});
const matchingOnEnv = loadEnv({ AI_MATCHING_ENABLED: 'true' });
const aiDisabledEnv = loadEnv({
  AI_PROVIDER: 'disabled',
  AI_MATCHING_ENABLED: 'true',
  DATABASE_URL: SECRETS.databaseUrl,
  SESSION_SECRET: SECRETS.sessionSecret,
  AI_BASE_URL: SECRETS.aiBaseUrl,
  AI_API_KEY: SECRETS.aiApiKey,
});
const httpJsonWithoutMatchingEnv = loadEnv({
  AI_PROVIDER: 'http-json',
  AI_MATCHING_ENABLED: 'false',
  DATABASE_URL: SECRETS.databaseUrl,
  SESSION_SECRET: SECRETS.sessionSecret,
});
const fullEnv = loadEnv({
  NODE_ENV: 'production',
  API_PORT: '8080',
  API_PREFIX: '/api/v2',
  DATABASE_URL: SECRETS.databaseUrl,
  SESSION_SECRET: SECRETS.sessionSecret,
  AI_PROVIDER: 'http-json',
  AI_BASE_URL: SECRETS.aiBaseUrl,
  AI_API_KEY: SECRETS.aiApiKey,
  AI_MODEL: 'gpt-4o-mini',
  AI_MATCHING_ENABLED: 'true',
  WECHAT_MINIAPP_APP_SECRET: SECRETS.wechatAppSecret,
});

/** 开关矩阵：配置取值 → 期望的对外摘要（逐字段全等，证明闭集与取值都正确） */
const toggleMatrix: ReadonlyArray<{ name: string; env: AppEnv; expected: RuntimeInfoPayload }> = [
  {
    name: '默认：无数据库、AI mock、匹配关闭',
    env: defaultEnv,
    expected: {
      nodeEnv: 'development',
      apiPort: 3000,
      apiPrefix: '/api/v1',
      databaseConfigured: false,
      dependencyGate: 'not-required',
      aiProvider: 'mock',
      aiMatchingEnabled: false,
    },
  },
  {
    name: '仅开匹配开关：仍无数据库、供应商 mock',
    env: matchingOnEnv,
    expected: {
      nodeEnv: 'development',
      apiPort: 3000,
      apiPrefix: '/api/v1',
      databaseConfigured: false,
      dependencyGate: 'not-required',
      aiProvider: 'mock',
      aiMatchingEnabled: true,
    },
  },
  {
    name: '有数据库但 AI 供应商 disabled（匹配开关为 true）',
    env: aiDisabledEnv,
    expected: {
      nodeEnv: 'development',
      apiPort: 3000,
      apiPrefix: '/api/v1',
      databaseConfigured: true,
      dependencyGate: 'required',
      aiProvider: 'disabled',
      aiMatchingEnabled: true,
    },
  },
  {
    name: '有数据库 + http-json，但匹配开关关闭',
    env: httpJsonWithoutMatchingEnv,
    expected: {
      nodeEnv: 'development',
      apiPort: 3000,
      apiPrefix: '/api/v1',
      databaseConfigured: true,
      dependencyGate: 'required',
      aiProvider: 'http-json',
      aiMatchingEnabled: false,
    },
  },
  {
    name: 'production / 自定义端口与前缀 / 全部配置齐备',
    env: fullEnv,
    expected: {
      nodeEnv: 'production',
      apiPort: 8080,
      apiPrefix: '/api/v2',
      databaseConfigured: true,
      dependencyGate: 'required',
      aiProvider: 'http-json',
      aiMatchingEnabled: true,
    },
  },
];

const validPayload: RuntimeInfoPayload = new RuntimeInfoService(aiDisabledEnv).getRuntimeInfo();

const startedApps: INestApplication[] = [];

/**
 * 与生产装配同构的测试模块：显式提供 `APP_ENV`，证明依赖解析只靠 `@Inject(APP_ENV)`
 * 令牌，不依赖 `design:paramtypes`（生产与测试行为一致）。
 */
function runtimeInfoAppModule(env: AppEnv): Type<unknown> {
  @Module({
    controllers: [RuntimeInfoController],
    providers: [
      { provide: APP_ENV, useValue: env },
      RuntimeInfoService,
      { provide: APP_INTERCEPTOR, useClass: ApiResponseInterceptor },
      { provide: APP_FILTER, useClass: ApiExceptionFilter },
    ],
  })
  class RuntimeInfoTestModule {}

  return RuntimeInfoTestModule;
}

/** 用测试替身替换服务，验证「字段闭集」的运行期兜底确实会生效（而不是恒真的空检查） */
function runtimeInfoWithService(service: unknown): Type<unknown> {
  @Module({
    controllers: [RuntimeInfoController],
    providers: [
      { provide: RuntimeInfoService, useValue: service },
      { provide: APP_INTERCEPTOR, useClass: ApiResponseInterceptor },
      { provide: APP_FILTER, useClass: ApiExceptionFilter },
    ],
  })
  class RuntimeInfoServiceDoubleModule {}

  return RuntimeInfoServiceDoubleModule;
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

/** 以测试替身启动应用并请求 /runtime-info（用于 fail-closed 用例） */
async function getWithServiceDouble(service: unknown): Promise<HttpResult> {
  const baseUrl = await startApp(runtimeInfoWithService(service));
  return get(baseUrl, '/runtime-info');
}

/** 抹掉随时间变化的字段，其余字段必须逐字节一致 */
function stableHealth(payload: unknown): Record<string, unknown> {
  const {
    uptimeSeconds: _uptime,
    timestamp: _timestamp,
    ...rest
  } = payload as Record<string, unknown>;
  return rest;
}

afterAll(async () => {
  await Promise.all(startedApps.map((app) => app.close()));
});

describe('GET /api/v1/runtime-info 字段闭集与开关矩阵（真实 Nest 应用 + 真实 HTTP）', () => {
  it.each(toggleMatrix)('$name', async ({ env, expected }) => {
    const baseUrl = await startApp(runtimeInfoAppModule(env));
    const { status, text, body } = await get(baseUrl, '/runtime-info');

    expect(status).toBe(200);
    expect(body.error).toBeNull();
    expect(body.meta.requestId).toBeTruthy();
    // 字段闭集：恰好白名单 6 个字段，多一个少一个都会让下面的断言失败
    expect(Object.keys(body.data as Record<string, unknown>).sort()).toEqual(
      [...RUNTIME_INFO_FIELDS].sort(),
    );
    // 取值闭集：逐字段全等，不允许出现任何额外字段
    expect(body.data).toEqual(expected);
    for (const fragment of SENSITIVE_FRAGMENTS) {
      expect(text).not.toContain(fragment);
    }
  });

  it('白名单字段名与对外对象键一一对应（常量本身即契约）', () => {
    expect([...RUNTIME_INFO_FIELDS]).toEqual([
      'nodeEnv',
      'apiPort',
      'apiPrefix',
      'databaseConfigured',
      'dependencyGate',
      'aiProvider',
      'aiMatchingEnabled',
    ]);
    expect(Object.keys(validPayload).sort()).toEqual([...RUNTIME_INFO_FIELDS].sort());
  });

  it('服务由 APP_ENV 令牌构造，字段取值来自已校验配置而不是 process.env', () => {
    expect(new RuntimeInfoService(fullEnv).getRuntimeInfo()).toEqual({
      nodeEnv: 'production',
      apiPort: 8080,
      apiPrefix: '/api/v2',
      databaseConfigured: true,
      dependencyGate: 'required',
      aiProvider: 'http-json',
      aiMatchingEnabled: true,
    });
  });

  it('依赖就绪门禁档位：与启动门禁同一函数，且只回枚举不回证据/后端标识', () => {
    // 档位口径必须与启动门禁完全一致（生产或已配置数据库 ⇒ required），否则运维会看到
    // 一个「看起来没要求」的进程而实际已被门禁约束。
    const matrix: ReadonlyArray<{ env: AppEnv; tier: 'required' | 'not-required' }> = [
      { env: defaultEnv, tier: 'not-required' },
      { env: matchingOnEnv, tier: 'not-required' },
      { env: aiDisabledEnv, tier: 'required' },
      { env: httpJsonWithoutMatchingEnv, tier: 'required' },
      { env: fullEnv, tier: 'required' },
    ];
    for (const { env, tier } of matrix) {
      expect(toRuntimeInfo(env).dependencyGate).toBe(tier);
      expect(toRuntimeInfo(env).dependencyGate).toBe(
        describeDependencyReadinessTier(env.NODE_ENV, Boolean(env.DATABASE_URL)),
      );
    }
    // required 档位也不携带任何证据引用 / 后端标识 / 时间戳
    const serialized = JSON.stringify(toRuntimeInfo(fullEnv));
    expect(serialized).not.toMatch(/evidence|readiness|verifiedAt|checkedAt|postgres|in-memory/iu);
  });
});

describe('敏感配置绝不进入 /runtime-info 响应', () => {
  it('配置了连接串/会话密钥/AI key/AI base URL/微信密钥时，只回布尔与枚举', async () => {
    const baseUrl = await startApp(runtimeInfoAppModule(fullEnv));
    const { status, text, body } = await get(baseUrl, '/runtime-info');

    expect(status).toBe(200);
    for (const fragment of SENSITIVE_FRAGMENTS) {
      expect(text).not.toContain(fragment);
    }
    for (const name of FORBIDDEN_FIELD_NAMES) {
      expect(text).not.toContain(name);
    }
    // AI 侧只回供应商枚举与开关，不回 base URL / key / model；依赖就绪只回档位枚举
    expect(body.data).toEqual({
      nodeEnv: 'production',
      apiPort: 8080,
      apiPrefix: '/api/v2',
      databaseConfigured: true,
      dependencyGate: 'required',
      aiProvider: 'http-json',
      aiMatchingEnabled: true,
    });
  });

  describe('运行期兜底：服务返回不合规形状时 fail-closed', () => {
    beforeEach(() => {
      // 违规日志属于观测行为，静音以保持测试输出可读
      vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('越界字段（模拟误展开整份 env）→ 500，且不回显字段名与取值', async () => {
      const leaked = {
        ...validPayload,
        DATABASE_URL: SECRETS.databaseUrl,
        SESSION_SECRET: SECRETS.sessionSecret,
        AI_API_KEY: SECRETS.aiApiKey,
        AI_BASE_URL: SECRETS.aiBaseUrl,
      };
      const { status, text, body } = await getWithServiceDouble({ getRuntimeInfo: () => leaked });

      expect(status).toBe(500);
      expect(body.data).toBeNull();
      expect(body.error?.code).toBe(ApiErrorCode.InternalError);
      for (const fragment of SENSITIVE_FRAGMENTS) {
        expect(text).not.toContain(fragment);
      }
      for (const name of FORBIDDEN_FIELD_NAMES) {
        expect(text).not.toContain(name);
      }
      expect(text).not.toContain('databaseConfigured');
    });

    it('缺失白名单字段 → 500（残缺输出不会被当成合法精简响应）', async () => {
      const { aiProvider: _omitted, ...missing } = validPayload;
      const { status, body } = await getWithServiceDouble({ getRuntimeInfo: () => missing });

      expect(status).toBe(500);
      expect(body.data).toBeNull();
      expect(body.error?.code).toBe(ApiErrorCode.InternalError);
    });

    it('非对象返回值 → 500，不会把 undefined 渲染成成功响应', async () => {
      const { status, body } = await getWithServiceDouble({ getRuntimeInfo: () => undefined });

      expect(status).toBe(500);
      expect(body.data).toBeNull();
      expect(body.error?.code).toBe(ApiErrorCode.InternalError);
    });
  });
});

describe('取值级脱敏门禁：白名单字段里塞进敏感取值同样 fail-closed', () => {
  beforeEach(() => {
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('真实 HTTP：nodeEnv 被替换成连接串 → 500，响应不回显任何敏感片段', async () => {
    const leaked = {
      ...validPayload,
      nodeEnv: SECRETS.databaseUrl,
    } as unknown as RuntimeInfoPayload;
    const { status, text, body } = await getWithServiceDouble({
      getRuntimeInfo: () => leaked,
    });

    expect(status).toBe(500);
    expect(body.data).toBeNull();
    expect(body.error?.code).toBe(ApiErrorCode.InternalError);
    for (const fragment of SENSITIVE_FRAGMENTS) {
      expect(text).not.toContain(fragment);
    }
    expect(text).not.toContain('databaseConfigured');
  });

  it('真实 HTTP：apiPrefix 被替换成内部文件路径 → 500（字段闭集挡不住取值泄露）', async () => {
    const leaked = {
      ...validPayload,
      apiPrefix: 'D:\\WorkSpace\\ReseacherManager\\services\\api',
    } as unknown as RuntimeInfoPayload;
    const { status, text, body } = await getWithServiceDouble({
      getRuntimeInfo: () => leaked,
    });

    expect(status).toBe(500);
    expect(body.data).toBeNull();
    expect(body.error?.code).toBe(ApiErrorCode.InternalError);
    expect(text).not.toContain('WorkSpace');
    expect(text).not.toContain('ReseacherManager');
  });

  it('控制器单元：取值级命中抛 500，且错误消息不回显取值', () => {
    const controller = new RuntimeInfoController({
      getRuntimeInfo: () =>
        ({ ...validPayload, apiPrefix: SECRETS.databaseUrl }) as unknown as RuntimeInfoPayload,
    } as unknown as RuntimeInfoService);

    let thrown: unknown;
    try {
      controller.getRuntimeInfo();
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(InternalServerErrorException);
    expect((thrown as InternalServerErrorException).getStatus()).toBe(500);
    expect((thrown as Error).message).not.toContain('sup3rsecret');
  });
});

describe('控制器字段闭集兜底（单元行为，与 HTTP 层互为佐证）', () => {
  beforeEach(() => {
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function controllerWith(service: unknown): RuntimeInfoController {
    return new RuntimeInfoController(service as unknown as RuntimeInfoService);
  }

  it('合法输出原样返回：同一对象引用，不复制、不改写任何字段', () => {
    const controller = controllerWith({ getRuntimeInfo: () => validPayload });

    expect(controller.getRuntimeInfo()).toBe(validPayload);
  });

  it('越界字段抛 500', () => {
    const controller = controllerWith({
      getRuntimeInfo: () => ({ ...validPayload, AI_API_KEY: SECRETS.aiApiKey }),
    });

    let thrown: unknown;
    try {
      controller.getRuntimeInfo();
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(InternalServerErrorException);
    expect((thrown as InternalServerErrorException).getStatus()).toBe(500);
    expect((thrown as Error).message).not.toContain(SECRETS.aiApiKey);
  });

  it('checkRuntimeInfoFields 双向检测：越界与缺失都被识别（非恒真的空检查）', () => {
    // 越界字段只能用「非本仓库类型」的形状来构造：RuntimeInfoPayload 是字段闭集，
    // 类型系统本就不允许 extra（这正是生产类型未被放宽的证据）。这里在测试侧用
    // Record<string, unknown> 造出越界形状，再显式收窄回被测签名，验证运行期兜底。
    const withUnexpectedField: Record<string, unknown> = { ...validPayload, extra: 1 };
    expect(checkRuntimeInfoFields(validPayload)).toEqual([]);
    expect(checkRuntimeInfoFields(withUnexpectedField as unknown as RuntimeInfoPayload)).toEqual([
      { kind: 'unexpected', field: 'extra' },
    ]);
    const { apiPort: _port, ...missingPort } = validPayload;
    expect(checkRuntimeInfoFields(missingPort as RuntimeInfoPayload)).toEqual([
      { kind: 'missing', field: 'apiPort' },
    ]);
  });
});

@Module({
  imports: [ConfigModule, HealthModule],
  providers: [
    { provide: APP_INTERCEPTOR, useClass: ApiResponseInterceptor },
    { provide: APP_FILTER, useClass: ApiExceptionFilter },
  ],
})
class HealthBaselineModule {}

@Module({
  imports: [ConfigModule, HealthModule, RuntimeInfoModule],
  providers: [
    { provide: APP_INTERCEPTOR, useClass: ApiResponseInterceptor },
    { provide: APP_FILTER, useClass: ApiExceptionFilter },
  ],
})
class HealthWithRuntimeInfoModule {}

describe('注入 runtime-info 后健康路由保持不变', () => {
  it('新增 RuntimeInfoModule 前后 /health 的字段集合与非时间字段完全一致', async () => {
    const baselineUrl = await startApp(HealthBaselineModule);
    const withRuntimeInfoUrl = await startApp(HealthWithRuntimeInfoModule);

    const baseline = await get(baselineUrl, '/health');
    const current = await get(withRuntimeInfoUrl, '/health');

    expect(baseline.status).toBe(200);
    expect(current.status).toBe(baseline.status);
    expect(current.body.error).toBeNull();
    expect(Object.keys(current.body.data as Record<string, unknown>).sort()).toEqual(
      Object.keys(baseline.body.data as Record<string, unknown>).sort(),
    );
    expect(stableHealth(current.body.data)).toEqual(stableHealth(baseline.body.data));
    expect(checkHealthDataAgainstContract(current.body.data)).toEqual([]);
  });

  it('新增 RuntimeInfoModule 前后 /health/ready 输出完全一致', async () => {
    const baselineUrl = await startApp(HealthBaselineModule);
    const withRuntimeInfoUrl = await startApp(HealthWithRuntimeInfoModule);

    const baseline = await get(baselineUrl, '/health/ready');
    const current = await get(withRuntimeInfoUrl, '/health/ready');

    expect(baseline.status).toBe(200);
    expect(current.status).toBe(baseline.status);
    expect(current.body.data).toEqual(baseline.body.data);
    expect(checkReadinessDataAgainstContract(current.body.data)).toEqual([]);
  });

  it('生产装配（ConfigModule + HealthModule + RuntimeInfoModule）依赖可解析，两个路由都可用', async () => {
    const baseUrl = await startApp(HealthWithRuntimeInfoModule);

    const runtimeInfo = await get(baseUrl, '/runtime-info');
    expect(runtimeInfo.status).toBe(200);
    expect(runtimeInfo.body.error).toBeNull();
    expect(Object.keys(runtimeInfo.body.data as Record<string, unknown>).sort()).toEqual(
      [...RUNTIME_INFO_FIELDS].sort(),
    );
    expect(checkRuntimeInfoFields(runtimeInfo.body.data as RuntimeInfoPayload)).toEqual([]);

    const health = await get(baseUrl, '/health');
    expect(health.status).toBe(200);
    expect(checkHealthDataAgainstContract(health.body.data)).toEqual([]);

    const readiness = await get(baseUrl, '/health/ready');
    expect(readiness.status).toBe(200);
    expect(checkReadinessDataAgainstContract(readiness.body.data)).toEqual([]);
  });
});

import 'reflect-metadata';
import { request } from 'node:http';
import { Logger, Module } from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import { APP_FILTER, APP_INTERCEPTOR, NestFactory } from '@nestjs/core';
import { DataScope, PermissionPoint, Role } from '@rm/shared';
import type { ApiEnvelope } from '@rm/shared';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { ZodError } from 'zod';
import { AppModule } from '../../app.module';
import { ApiExceptionFilter } from '../../common/api-exception.filter';
import { ApiResponseInterceptor } from '../../common/api-response.interceptor';
import { APP_ENV, ConfigModule } from '../../config/config.module';
import { loadEnv } from '../../config/env';
import type { AppEnv } from '../../config/env';
import { AccessControlModule } from '../access-control/access-control.module';
import { AuthModule } from '../auth/auth.module';
import { InMemorySessionStore } from '../auth/session-store.in-memory';
import { RUOYI_AUTHZ_ADAPTER } from '../ruoyi-adapter/ruoyi-adapter.port';
import type { RuoYiAuthzAdapter } from '../ruoyi-adapter/ruoyi-adapter.port';
import {
  SELF_STATISTICS_FIELDS,
  assertDeclaredStatisticsQueryFields,
  parseSelfStatisticsView,
} from './statistics.contract';
import { StatisticsController } from './statistics.controller';
import {
  InMemoryStatisticsCountRepository,
  createAchievementStatisticsRepository,
  createApplicationStatisticsRepository,
  createEducationStatisticsRepository,
  createMatchingStatisticsRepository,
} from './statistics.in-memory-repository';
import {
  ACHIEVEMENT_STATISTICS_REPOSITORY,
  APPLICATION_STATISTICS_REPOSITORY,
  EDUCATION_STATISTICS_REPOSITORY,
  MATCHING_STATISTICS_REPOSITORY,
  StatisticsSource,
} from './statistics.port';
import type { StatisticsCountRepository } from './statistics.port';
import { StatisticsService } from './statistics.service';
import { StatisticsModule } from './statistics.module';

/**
 * 本人统计切片（`GET /me/statistics`）的真实 HTTP 回归：
 *
 * - 成功：200，`data` 恰好是白名单里的四个计数，只统计**服务端会话主体**本人；
 * - 空数据：未预置任何记录时稳定返回四个 0（不是 404/500，也不省略字段）；
 * - 认证 401：无凭证、scheme 不对、会话不存在、会话主体含未登记角色（fail-closed）；
 * - 越权 403：缺权限点（admin）或权限点范围不是 SELF（group_leader）→ 同一个 403，
 *   并断言判定入参全部来自服务端、四个计数端口一次都没被调用；
 * - claims 伪造：自定义头（`x-user-id`/`x-roles`/`x-scope`/`x-group-id`）不进入判定，
 *   查询串声明（`?userId=`/`?roles=`/`?scope=`/`?groupId=`…）一律 400 且不触发任何取数；
 * - 输出白名单与 PII：仓储即便返回对象/记录/个人标识，响应也只有四个整数或稳定错误信封；
 * - 存储异常：端口抛错或返回非法计数（负数/小数/NaN/超上限/类型错误/装错来源）一律 500，
 *   不泄露返回值、异常原文与内部细节；
 * - 既有路由不变：同一 `AppModule` 下 health / runtime-info 行为不变，统计端点默认 401。
 *
 * 说明：测试用真实 Nest 应用 + 真实 HTTP（与其它切片的 controller spec 同构），
 * 只通过 DI 令牌/端口注入测试夹具（会话、计数），不替换任何生产代码路径。
 */

const SESSION_STUDENT_1 = 'session-student-1';
const SESSION_STUDENT_2 = 'session-student-2';
const SESSION_GROUP_LEADER = 'session-leader-1';
const SESSION_ADMIN = 'session-admin-1';
const SESSION_UNKNOWN_ROLE = 'session-unknown-role';

const STUDENT_1 = 'u-student-1';
const STUDENT_2 = 'u-student-2';
const LEADER_1 = 'u-leader-1';
const ADMIN_1 = 'u-admin-1';

/** 本切片的输出白名单：`data` 只允许这四个整数字段 */
type StatisticsCounts = {
  educationRecords: number;
  applications: number;
  achievements: number;
  matchingRequests: number;
};

const startedApps: INestApplication[] = [];

@Module({
  imports: [ConfigModule, StatisticsModule],
  providers: [
    { provide: APP_INTERCEPTOR, useClass: ApiResponseInterceptor },
    { provide: APP_FILTER, useClass: ApiExceptionFilter },
  ],
})
class StatisticsHttpModule {}

/** 四个计数端口的内存基线实例（可显式 seed，用于构造「本人有数据 / 他人有数据」场景） */
interface TestSources {
  readonly education: InMemoryStatisticsCountRepository;
  readonly applications: InMemoryStatisticsCountRepository;
  readonly achievements: InMemoryStatisticsCountRepository;
  readonly matching: InMemoryStatisticsCountRepository;
}

interface TestApp {
  readonly app: INestApplication;
  readonly baseUrl: string;
  readonly store: InMemorySessionStore;
  readonly sources: TestSources;
}

/** 启动真实应用并注入会话夹具（对话与计数都是内存基线的显式 seed，不做隐式全局状态） */
async function startStatisticsApp(
  options: { readonly seedCounts?: boolean } = {},
): Promise<TestApp> {
  const app = await NestFactory.create(StatisticsHttpModule, { logger: false });
  app.setGlobalPrefix('api/v1');
  await app.listen(0, '127.0.0.1');
  startedApps.push(app);

  const store = app.get(InMemorySessionStore);
  store.seed({
    sessionId: SESSION_STUDENT_1,
    subject: { userId: STUDENT_1, roles: [Role.Student] },
  });
  store.seed({
    sessionId: SESSION_STUDENT_2,
    subject: { userId: STUDENT_2, roles: [Role.Student] },
  });
  store.seed({
    sessionId: SESSION_GROUP_LEADER,
    subject: { userId: LEADER_1, roles: [Role.GroupLeader], groupIds: ['g-1'] },
  });
  store.seed({ sessionId: SESSION_ADMIN, subject: { userId: ADMIN_1, roles: [Role.Admin] } });
  // 会话存储里出现未登记角色：主体不可信，必须在认证边界整体拒绝
  store.seed({
    sessionId: SESSION_UNKNOWN_ROLE,
    subject: { userId: 'u-unknown-1', roles: ['guest' as Role] },
  });

  const sources: TestSources = {
    education: app.get<InMemoryStatisticsCountRepository>(EDUCATION_STATISTICS_REPOSITORY),
    applications: app.get<InMemoryStatisticsCountRepository>(APPLICATION_STATISTICS_REPOSITORY),
    achievements: app.get<InMemoryStatisticsCountRepository>(ACHIEVEMENT_STATISTICS_REPOSITORY),
    matching: app.get<InMemoryStatisticsCountRepository>(MATCHING_STATISTICS_REPOSITORY),
  };

  if (options.seedCounts !== false) {
    // 本人有数据；他人也有数据 —— 后者只用于证明「他人计数不会出现在本人响应里」
    sources.education.seed(STUDENT_1, 3);
    sources.applications.seed(STUDENT_1, 2);
    sources.achievements.seed(STUDENT_1, 5);
    sources.matching.seed(STUDENT_1, 1);
    sources.education.seed(STUDENT_2, 999);
    sources.applications.seed(STUDENT_2, 998);
    sources.achievements.seed(STUDENT_2, 997);
    sources.matching.seed(STUDENT_2, 996);
    sources.education.seed(LEADER_1, 111);
    sources.education.seed(ADMIN_1, 222);
  }

  return { app, baseUrl: `${await app.getUrl()}/api/v1`, store, sources };
}

interface HttpResult {
  status: number;
  text: string;
  body: ApiEnvelope<unknown>;
}

/** 每次请求使用独立连接（agent: false），避免 keep-alive 让 app.close() 等待空闲连接 */
function call(
  baseUrl: string,
  path: string,
  options: { headers?: Record<string, string> } = {},
): Promise<HttpResult> {
  return new Promise<HttpResult>((resolve, reject) => {
    const req = request(
      `${baseUrl}${path}`,
      { method: 'GET', agent: false, headers: { ...options.headers } },
      (res) => {
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
      },
    );
    req.on('error', reject);
    req.end();
  });
}

function bearer(sessionId: string): Record<string, string> {
  return { authorization: `Bearer ${sessionId}` };
}

function countsOf(body: ApiEnvelope<unknown>): StatisticsCounts {
  return body.data as StatisticsCounts;
}

/**
 * 响应中「业务内容」部分的文本：去掉 `meta`（`requestId` 是随机 UUID、`generatedAt` 是时间戳）
 * 与 `error.requestId`。泄露断言必须建立在这部分上，否则会被随机标识里的数字误伤。
 */
function contentText(res: HttpResult): string {
  const error = res.body.error;
  return JSON.stringify({
    data: res.body.data,
    error: error
      ? { code: error.code, message: error.message, details: error.details ?? null }
      : null,
  });
}

/** 四个端口的调用监视：用于断言「拒绝发生在任何取数之前」 */
function spyOnCountSources(sources: TestSources) {
  return [
    vi.spyOn(sources.education, 'countByUserId'),
    vi.spyOn(sources.applications, 'countByUserId'),
    vi.spyOn(sources.achievements, 'countByUserId'),
    vi.spyOn(sources.matching, 'countByUserId'),
  ];
}

interface ValidationIssue {
  path: string;
  message: string;
}

function issuesOf(body: ApiEnvelope<unknown>): ValidationIssue[] {
  const details = body.error?.details as { issues?: ValidationIssue[] } | undefined;
  return details?.issues ?? [];
}

/** 捕获并返回 ZodError（用于断言拒绝原因）；其他异常原样抛出，避免掩盖装配问题 */
function captureZodError(action: () => void): ZodError | undefined {
  try {
    action();
    return undefined;
  } catch (error) {
    if (error instanceof ZodError) return error;
    throw error;
  }
}

afterAll(async () => {
  await Promise.all(startedApps.map((app) => app.close()));
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('本人统计：成功路径（真实 HTTP + 统一响应信封）', () => {
  it('学生本人：200，data 恰好是四个计数的白名单，且只统计会话主体本人', async () => {
    const { baseUrl } = await startStatisticsApp();

    const res = await call(baseUrl, '/me/statistics', {
      headers: { ...bearer(SESSION_STUDENT_1), 'x-request-id': 'test-request-1' },
    });

    expect(res.status).toBe(200);
    expect(res.body.error).toBeNull();
    expect(res.body.meta.requestId).toBe('test-request-1');
    expect(typeof res.body.meta.generatedAt).toBe('string');

    const data = countsOf(res.body);
    // 输出白名单：既没有第五个字段，也没有归属/记录内容
    expect(Object.keys(data).sort()).toEqual([...SELF_STATISTICS_FIELDS].sort());
    expect(data).toEqual({
      educationRecords: 3,
      applications: 2,
      achievements: 5,
      matchingRequests: 1,
    });

    // 响应正文不含主体标识，也不含任何敏感字段名（计数之外什么都不回传）
    const content = contentText(res);
    expect(content).not.toContain(STUDENT_1);
    expect(content).not.toContain(STUDENT_2);
    for (const field of ['userId', 'roles', 'scope', 'groupId', 'studentNo', 'phone', 'name']) {
      expect(content).not.toContain(`"${field}"`);
    }
  });

  it('他人计数不参与：本人响应只反映本人（他人 999/998/997/996 不出现）', async () => {
    const { baseUrl } = await startStatisticsApp();

    const res = await call(baseUrl, '/me/statistics', { headers: bearer(SESSION_STUDENT_1) });

    expect(res.status).toBe(200);
    expect(countsOf(res.body)).toEqual({
      educationRecords: 3,
      applications: 2,
      achievements: 5,
      matchingRequests: 1,
    });
    for (const otherValue of ['999', '998', '997', '996']) {
      expect(contentText(res)).not.toContain(otherValue);
    }
  });

  it('空数据稳定返回：未预置任何记录时四个 0，重复请求结果一致', async () => {
    const { baseUrl, sources } = await startStatisticsApp({ seedCounts: false });

    // 基线默认全零：未知主体稳定返回 0（不是 undefined、不是异常）
    expect(sources.education.countByUserId(STUDENT_1)).toBe(0);

    const first = await call(baseUrl, '/me/statistics', { headers: bearer(SESSION_STUDENT_1) });
    const second = await call(baseUrl, '/me/statistics', { headers: bearer(SESSION_STUDENT_1) });

    for (const res of [first, second]) {
      expect(res.status).toBe(200);
      expect(res.body.error).toBeNull();
      expect(countsOf(res.body)).toEqual({
        educationRecords: 0,
        applications: 0,
        achievements: 0,
        matchingRequests: 0,
      });
    }
    // meta 只差 requestId/generatedAt，业务内容逐字节相同
    expect(contentText(first)).toBe(contentText(second));
  });

  it('空查询串（`?`）不算输入：仍然 200 且计数不变', async () => {
    const { baseUrl } = await startStatisticsApp();

    const res = await call(baseUrl, '/me/statistics?', { headers: bearer(SESSION_STUDENT_1) });

    expect(res.status).toBe(200);
    expect(countsOf(res.body).educationRecords).toBe(3);
  });
});

describe('本人统计：认证边界 401（fail-closed）', () => {
  const unauthenticatedCases: ReadonlyArray<{ name: string; headers: Record<string, string> }> = [
    { name: '未携带 Authorization', headers: {} },
    { name: 'scheme 不是 Bearer', headers: { authorization: `Token ${SESSION_STUDENT_1}` } },
    { name: 'Bearer 凭证过短', headers: { authorization: 'Bearer short' } },
    { name: '会话不存在', headers: bearer('session-does-not-exist') },
    { name: '会话主体含未登记角色', headers: bearer(SESSION_UNKNOWN_ROLE) },
  ];

  it.each(unauthenticatedCases)('$name → 401 UNAUTHENTICATED', async ({ headers }) => {
    const { baseUrl } = await startStatisticsApp();

    const res = await call(baseUrl, '/me/statistics', { headers });

    expect(res.status).toBe(401);
    expect(res.body.data).toBeNull();
    expect(res.body.error?.code).toBe('UNAUTHENTICATED');
    // 不区分失败原因，避免给探测者额外信息
    expect(res.body.error?.message).toBe('登录状态无效或已过期，请重新登录');
    expect(contentText(res)).not.toContain(SESSION_UNKNOWN_ROLE);
    expect(contentText(res)).not.toContain('guest');
  });

  it('未认证时即便带了查询串也是 401（认证先于一切输入）', async () => {
    const { baseUrl, sources } = await startStatisticsApp();
    const spies = spyOnCountSources(sources);

    const res = await call(baseUrl, '/me/statistics?userId=u-victim-1');

    expect(res.status).toBe(401);
    expect(res.body.error?.code).toBe('UNAUTHENTICATED');
    for (const spy of spies) {
      expect(spy).not.toHaveBeenCalled();
    }
  });
});

describe('本人统计：越权 403（AuthorizationGuard + 服务端资源判定）', () => {
  it('admin 缺少本人统计所需的权限点：403，且四个计数端口一次都没被调用', async () => {
    const { baseUrl, sources } = await startStatisticsApp();
    const spies = spyOnCountSources(sources);

    const res = await call(baseUrl, '/me/statistics', { headers: bearer(SESSION_ADMIN) });

    expect(res.status).toBe(403);
    expect(res.body.data).toBeNull();
    expect(res.body.error?.code).toBe('FORBIDDEN');
    expect(res.body.error?.message).toBe('无权执行该操作');
    // 授权先于 repository：拒绝时一次取数都不发生
    for (const spy of spies) {
      expect(spy).not.toHaveBeenCalled();
    }
  });

  it('group_leader 有 education:self:read 但默认范围不是 SELF：同一个 403', async () => {
    const { baseUrl, sources } = await startStatisticsApp();
    const spies = spyOnCountSources(sources);

    const res = await call(baseUrl, '/me/statistics', { headers: bearer(SESSION_GROUP_LEADER) });

    expect(res.status).toBe(403);
    expect(res.body.error?.code).toBe('FORBIDDEN');
    expect(contentText(res)).not.toContain('111');
    for (const spy of spies) {
      expect(spy).not.toHaveBeenCalled();
    }
  });

  it('四个来源的判定入参全部来自服务端：权限点是常量、范围恒为 SELF、归属是会话主体', async () => {
    const { app, baseUrl } = await startStatisticsApp();
    const adapter = app.get<RuoYiAuthzAdapter>(RUOYI_AUTHZ_ADAPTER);
    const checkAuthorization = vi.spyOn(adapter, 'checkAuthorization');

    const res = await call(baseUrl, '/me/statistics', { headers: bearer(SESSION_STUDENT_1) });

    expect(res.status).toBe(200);
    expect(checkAuthorization).toHaveBeenCalledTimes(4);
    const calls = checkAuthorization.mock.calls.map(([subject, req]) => ({
      subject,
      permission: req.permission,
      scope: req.scope,
      resourceUserId: req.resourceUserId,
    }));
    // 判定主体与归属都是服务端解析值：客户端没有任何位置可以影响这三个入参
    for (const entry of calls) {
      expect(entry.subject).toEqual({ userId: STUDENT_1, roles: [Role.Student] });
      expect(entry.scope).toBe(DataScope.Self);
      expect(entry.resourceUserId).toBe(STUDENT_1);
    }
    // 四类计数各有自己的门控点（不是「一个权限点放行全部」）
    expect(calls.map((entry) => entry.permission).sort()).toEqual(
      [
        PermissionPoint.AchievementSelfRead,
        PermissionPoint.EducationSelfRead,
        PermissionPoint.MatchingSelfRequest,
        PermissionPoint.MembershipSelfCreate,
      ].sort(),
    );
  });

  it('未授权主体的伪造查询串拿不到字段级反馈：403（不是 400）', async () => {
    const { baseUrl, sources } = await startStatisticsApp();
    const spies = spyOnCountSources(sources);

    const res = await call(baseUrl, '/me/statistics?userId=u-victim-1&scope=GLOBAL', {
      headers: bearer(SESSION_ADMIN),
    });

    expect(res.status).toBe(403);
    expect(res.body.error?.code).toBe('FORBIDDEN');
    // 授权先于查询串闭集校验：连「哪些参数不被接受」都不回给未授权主体
    expect(issuesOf(res.body)).toHaveLength(0);
    for (const spy of spies) {
      expect(spy).not.toHaveBeenCalled();
    }
  });
});

describe('本人统计：claims 伪造不参与判定与取数', () => {
  it('伪造自定义头（x-user-id/x-roles/x-scope/x-group-id）：仍只返回会话主体的计数', async () => {
    const { baseUrl } = await startStatisticsApp();

    const res = await call(baseUrl, '/me/statistics', {
      headers: {
        ...bearer(SESSION_STUDENT_1),
        'x-user-id': STUDENT_2,
        'x-roles': `${Role.SuperAdmin},${Role.SystemAdmin}`,
        'x-scope': DataScope.Global,
        'x-group-id': 'g-1',
      },
    });

    expect(res.status).toBe(200);
    // 计数是 SESSION_STUDENT_1 本人的，而不是伪造头里 u-student-2 的（999/998/997/996）
    expect(countsOf(res.body)).toEqual({
      educationRecords: 3,
      applications: 2,
      achievements: 5,
      matchingRequests: 1,
    });
    expect(contentText(res)).not.toContain('999');
    expect(contentText(res)).not.toContain(STUDENT_2);
  });

  it('伪造查询串声明：400 VALIDATION_FAILED，逐项给出拒绝原因且不发生任何取数', async () => {
    const { baseUrl, sources } = await startStatisticsApp();
    const spies = spyOnCountSources(sources);

    const res = await call(
      baseUrl,
      '/me/statistics?userId=u-victim-1&roles=super_admin&scope=GLOBAL&groupId=g-1&page=1',
      { headers: bearer(SESSION_STUDENT_1) },
    );

    expect(res.status).toBe(400);
    expect(res.body.data).toBeNull();
    expect(res.body.error?.code).toBe('VALIDATION_FAILED');
    const issues = issuesOf(res.body);
    expect(issues.map((issue) => issue.path).sort()).toEqual([
      'groupId',
      'page',
      'roles',
      'scope',
      'userId',
    ]);
    // 服务端独占声明与未声明字段给出可区分的拒绝原因（不是静默忽略）
    for (const name of ['userId', 'roles', 'scope', 'groupId']) {
      expect(
        issues.some((issue) => issue.path === name && issue.message.includes('禁止使用')),
      ).toBe(true);
    }
    expect(issues.some((issue) => issue.path === 'page' && issue.message.includes('不接受'))).toBe(
      true,
    );
    // 输入被拒时同样不取数
    for (const spy of spies) {
      expect(spy).not.toHaveBeenCalled();
    }
    expect(contentText(res)).not.toContain('999');
  });

  it('查询串闭集是空集：声明之外的参数同样被拒绝（含 metrics/role 这类口径参数）', async () => {
    const { baseUrl } = await startStatisticsApp();

    const res = await call(baseUrl, '/me/statistics?metrics=education&role=admin', {
      headers: bearer(SESSION_STUDENT_1),
    });

    expect(res.status).toBe(400);
    expect(res.body.error?.code).toBe('VALIDATION_FAILED');
    expect(
      issuesOf(res.body)
        .map((issue) => issue.path)
        .sort(),
    ).toEqual(['metrics', 'role']);
  });
});

describe('本人统计：输出白名单与 PII（仓储返回值一律不可外发）', () => {
  it('端口返回对象/记录内容/PII → 500，且响应不含任何取值', async () => {
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const { baseUrl, sources } = await startStatisticsApp();
    vi.spyOn(sources.education, 'countByUserId').mockImplementation(
      () =>
        ({
          userId: 'u-victim-9',
          name: '张三',
          studentNo: '2021001999',
          phone: '13800000000',
          records: [{ id: 'rec-1', title: '秘密度假计划' }],
        }) as unknown as number,
    );

    const res = await call(baseUrl, '/me/statistics', { headers: bearer(SESSION_STUDENT_1) });

    expect(res.status).toBe(500);
    expect(res.body.data).toBeNull();
    expect(res.body.error?.code).toBe('INTERNAL_ERROR');
    // 500 只给稳定安全文案：连内部完整性文案与异常原因都不外发
    expect(res.body.error?.message).toBe('服务器内部错误，请稍后重试');
    expect(res.body.meta.requestId).toBeTruthy();
    const content = contentText(res);
    for (const leaked of [
      'u-victim-9',
      '张三',
      '2021001999',
      '13800000000',
      '秘密度假计划',
      'rec-1',
      'educationRecords',
    ]) {
      expect(content).not.toContain(leaked);
    }
  });

  const invalidCounts: ReadonlyArray<{ name: string; value: () => number }> = [
    { name: '负数', value: () => -1 },
    { name: '小数', value: () => 1.5 },
    { name: 'NaN', value: () => Number.NaN },
    { name: 'Infinity', value: () => Number.POSITIVE_INFINITY },
    { name: '超出上限', value: () => 1_000_000_001 },
    { name: '字符串数字', value: () => '5' as unknown as number },
    { name: 'undefined', value: () => undefined as unknown as number },
  ];

  it.each(invalidCounts)(
    '计数非法（$name）→ 500 INTERNAL_ERROR，且不回显该值',
    async ({ value }) => {
      vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
      const { baseUrl, sources } = await startStatisticsApp();
      vi.spyOn(sources.achievements, 'countByUserId').mockImplementation(value);

      const res = await call(baseUrl, '/me/statistics', { headers: bearer(SESSION_STUDENT_1) });

      expect(res.status).toBe(500);
      expect(res.body.data).toBeNull();
      expect(res.body.error?.code).toBe('INTERNAL_ERROR');
      const content = contentText(res);
      for (const leaked of ['-1', '1.5', '1000000001', 'NaN', 'Infinity', '"5"']) {
        expect(content).not.toContain(leaked);
      }
    },
  );

  it('端口装错来源（capabilities.source 与预期不符）→ 500，不返回混合口径的计数', async () => {
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const { baseUrl, sources } = await startStatisticsApp();
    Object.defineProperty(sources.education, 'capabilities', {
      configurable: true,
      value: {
        backend: 'test-miswired',
        source: StatisticsSource.Achievements,
        persistent: false,
        productionReady: false,
      },
    });

    const res = await call(baseUrl, '/me/statistics', { headers: bearer(SESSION_STUDENT_1) });

    expect(res.status).toBe(500);
    expect(res.body.error?.code).toBe('INTERNAL_ERROR');
    expect(res.body.data).toBeNull();
  });
});

describe('本人统计：存储异常一律 500（不泄露内部细节）', () => {
  it('端口抛异常（含敏感原文）→ 500，响应不含错误名、堆栈与原文', async () => {
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const { baseUrl, sources } = await startStatisticsApp();
    vi.spyOn(sources.applications, 'countByUserId').mockImplementation(() => {
      throw new Error('connection refused: userId=u-victim-9 phone=13800000000');
    });

    const res = await call(baseUrl, '/me/statistics', { headers: bearer(SESSION_STUDENT_1) });

    expect(res.status).toBe(500);
    expect(res.body.data).toBeNull();
    expect(res.body.error?.code).toBe('INTERNAL_ERROR');
    expect(res.body.error?.message).toBe('服务器内部错误，请稍后重试');
    const content = contentText(res);
    for (const leaked of ['u-victim-9', '13800000000', 'connection refused', 'Error']) {
      expect(content).not.toContain(leaked);
    }
  });
});

describe('本人统计：装配边界与纯函数门禁', () => {
  it('StatisticsModule 只注册本切片的路由/服务，并把四个计数令牌显式绑到内存基线工厂', () => {
    const providers = (Reflect.getMetadata('providers', StatisticsModule) ?? []) as unknown[];
    const controllers = (Reflect.getMetadata('controllers', StatisticsModule) ?? []) as unknown[];
    const imports = (Reflect.getMetadata('imports', StatisticsModule) ?? []) as unknown[];

    expect(controllers).toEqual([StatisticsController]);
    expect(providers).toContain(StatisticsService);
    // 四个令牌各自绑到一个专属工厂：换绑持久化实现时只改这一处
    expect(providers).toContainEqual({
      provide: EDUCATION_STATISTICS_REPOSITORY,
      useFactory: createEducationStatisticsRepository,
      inject: [APP_ENV],
    });
    expect(providers).toContainEqual({
      provide: APPLICATION_STATISTICS_REPOSITORY,
      useFactory: createApplicationStatisticsRepository,
      inject: [APP_ENV],
    });
    expect(providers).toContainEqual({
      provide: ACHIEVEMENT_STATISTICS_REPOSITORY,
      useFactory: createAchievementStatisticsRepository,
      inject: [APP_ENV],
    });
    expect(providers).toContainEqual({
      provide: MATCHING_STATISTICS_REPOSITORY,
      useFactory: createMatchingStatisticsRepository,
      inject: [APP_ENV],
    });
    // 依赖方向：认证（auth）与授权（access-control）各自只经端口/服务暴露
    expect(imports).toContain(AuthModule);
    expect(imports).toContain(AccessControlModule);
  });

  it('内存基线如实声明非持久化/不可用于生产，并在生产环境拒绝构造（四个来源都拒绝）', () => {
    const developmentEnv = loadEnv({});
    const productionEnv = loadEnv({ NODE_ENV: 'production' });

    const factories: ReadonlyArray<{
      readonly source: StatisticsSource;
      readonly create: (env: AppEnv) => StatisticsCountRepository;
    }> = [
      { source: StatisticsSource.Education, create: createEducationStatisticsRepository },
      { source: StatisticsSource.Applications, create: createApplicationStatisticsRepository },
      { source: StatisticsSource.Achievements, create: createAchievementStatisticsRepository },
      { source: StatisticsSource.Matching, create: createMatchingStatisticsRepository },
    ];

    for (const { source, create } of factories) {
      const repository = create(developmentEnv);
      expect(repository.capabilities).toEqual({
        backend: 'in-memory-baseline',
        source,
        persistent: false,
        productionReady: false,
      });
      expect(repository.countByUserId('u-nobody')).toBe(0);
      // 不用内存冒充生产存储：生产环境直接拒绝构造
      expect(() => create(productionEnv)).toThrow(/生产环境禁止使用内存统计来源/u);
    }
  });

  it('内存基线 seed 只接受合法计数（不制造「只有存储损坏才会出现」的值）', () => {
    const baseline = new InMemoryStatisticsCountRepository(loadEnv({}), StatisticsSource.Education);

    baseline.seed('u-1', 7);
    expect(baseline.countByUserId('u-1')).toBe(7);
    expect(baseline.countByUserId('u-2')).toBe(0);
    expect(() => baseline.seed('', 1)).toThrow(/非空的服务端主体/u);
    expect(() => baseline.seed('u-1', -1)).toThrow(/拒绝非法计数/u);
    expect(() => baseline.seed('u-1', 1.5)).toThrow(/拒绝非法计数/u);
  });

  it('聚合输出白名单是真正的闭集：多出字段即违规（门禁非恒真）', () => {
    const valid = {
      educationRecords: 0,
      applications: 1,
      achievements: 2,
      matchingRequests: 3,
    };
    expect(parseSelfStatisticsView(valid)).toEqual({ ok: true, value: valid });

    const withExtra = parseSelfStatisticsView({ ...valid, userId: 'u-student-1' });
    expect(withExtra.ok).toBe(false);
    if (!withExtra.ok) {
      expect(withExtra.issues).toEqual([{ kind: 'unexpected', path: 'userId' }]);
    }

    const withMissing = parseSelfStatisticsView({ educationRecords: 0 });
    expect(withMissing.ok).toBe(false);

    const withInvalid = parseSelfStatisticsView({ ...valid, applications: -1 });
    expect(withInvalid.ok).toBe(false);
    if (!withInvalid.ok) {
      expect(withInvalid.issues).toEqual([{ kind: 'invalid', path: 'applications' }]);
    }
  });

  it('查询串闭集门禁：无查询不报错，出现任何参数都抛 ZodError（服务端声明可区分）', () => {
    expect(() => assertDeclaredStatisticsQueryFields({})).not.toThrow();
    expect(() => assertDeclaredStatisticsQueryFields(undefined)).not.toThrow();
    expect(() => assertDeclaredStatisticsQueryFields(null)).not.toThrow();

    const forbidden = captureZodError(() => assertDeclaredStatisticsQueryFields({ userId: 'u-1' }));
    expect(forbidden?.issues[0]?.message).toContain('禁止使用查询参数 userId');
    const claim = captureZodError(() => assertDeclaredStatisticsQueryFields({ groupId: 'g-1' }));
    expect(claim?.issues[0]?.message).toContain('禁止使用查询参数 groupId');
    const pagination = captureZodError(() => assertDeclaredStatisticsQueryFields({ page: '1' }));
    expect(pagination?.issues[0]?.message).toContain('不接受查询参数 page');
    const undeclared = captureZodError(() => assertDeclaredStatisticsQueryFields({ foo: '1' }));
    expect(undeclared?.issues[0]?.message).toContain('不接受查询参数 foo');
  });

  it('完整 AppModule：health / runtime-info 行为不变，统计端点默认 401（不预置任何会话）', async () => {
    const app = await NestFactory.create(AppModule, { logger: false });
    app.setGlobalPrefix('api/v1');
    await app.listen(0, '127.0.0.1');
    startedApps.push(app);
    const baseUrl = `${await app.getUrl()}/api/v1`;

    const health = await call(baseUrl, '/health');
    expect(health.status).toBe(200);
    expect(health.body.error).toBeNull();
    expect(health.body.data).toMatchObject({ status: 'ok', prefix: '/api/v1' });

    const runtimeInfo = await call(baseUrl, '/runtime-info');
    expect(runtimeInfo.status).toBe(200);
    expect(Object.keys(runtimeInfo.body.data as Record<string, unknown>).sort()).toEqual([
      'aiMatchingEnabled',
      'aiProvider',
      'apiPort',
      'apiPrefix',
      'databaseConfigured',
      'dependencyGate',
      'nodeEnv',
    ]);

    const statistics = await call(baseUrl, '/me/statistics');
    expect(statistics.status).toBe(401);
    expect(statistics.body.error?.code).toBe('UNAUTHENTICATED');
  });
});

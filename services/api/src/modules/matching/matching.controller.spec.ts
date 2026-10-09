import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { request } from 'node:http';
import { Logger, Module } from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import { APP_FILTER, APP_INTERCEPTOR, NestFactory } from '@nestjs/core';
import {
  AvailablePeriod,
  DataScope,
  Grade,
  GroupStatus,
  MatchingRequestStatus,
  PermissionPoint,
  ProgrammingLevel,
  Role,
  matchingRequestInputSchema,
} from '@rm/shared';
import type { ApiEnvelope } from '@rm/shared';
import {
  AiErrorCode,
  createMockProvider,
  type AiProvider,
  type MatchFeatureBundle,
} from '@rm/ai-adapter';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { AppModule } from '../../app.module';
import { ApiExceptionFilter } from '../../common/api-exception.filter';
import { ApiResponseInterceptor } from '../../common/api-response.interceptor';
import { APP_ENV, ConfigModule } from '../../config/config.module';
import { loadEnv } from '../../config/env';
import type { AppEnv } from '../../config/env';
import { SQL_CONNECTION_FACTORY } from '../../db/ports/sql-executor.port';
import type { SqlConnectionFactory } from '../../db/ports/sql-executor.port';
import { AccessControlModule } from '../access-control/access-control.module';
import { AuthModule } from '../auth/auth.module';
import { InMemorySessionStore } from '../auth/session-store.in-memory';
import { SESSION_STORE } from '../auth/session-subject.port';
import { RUOYI_AUTHZ_ADAPTER } from '../ruoyi-adapter/ruoyi-adapter.port';
import type { RuoYiAuthzAdapter } from '../ruoyi-adapter/ruoyi-adapter.port';
import { MATCHING_REQUEST_INPUT_FIELDS, MATCHING_REQUEST_VIEW_FIELDS } from './matching.contract';
import { MatchingController } from './matching.controller';
import { InMemoryMatchingFeatureSource } from './matching.feature-source.in-memory';
import { InMemoryMatchingRepository } from './matching.in-memory-repository';
import {
  MATCHING_AI_PROVIDER,
  MATCHING_FEATURE_SOURCE,
  MATCHING_REPOSITORY,
} from './matching.port';
import type { MatchingAccessScope, MatchingRequest } from './matching.port';
import { MatchingService } from './matching.service';
import { MatchingModule, createMatchingRepository } from './matching.module';

/**
 * 匹配切片（`/me/matching-requests`）的真实 HTTP 回归：
 *
 * - 成功：发起本人匹配请求（201）与本人列表/状态（200）；归属、状态、快照摘要与版本由服务端
 *   决定，响应只含白名单字段（不含 `userId`、不含快照摘要、不含任何画像原始字段）；
 * - 认证 401：无凭证、scheme 不对、会话不存在、会话主体含未登记角色（fail-closed）；
 * - 输入拒绝 400：未声明字段（客户端 `userId`/`roles`/`scope`/`groupId`/`status`/`recommendations`/
 *   版本/摘要/时间戳一律 400，且给出可区分的拒绝原因）与非法画像版本；
 * - 越权 403：角色没有该权限点或默认范围不是 `SELF`（admin / group_leader），
 *   且授权**先于**字段校验与仓储访问（拒绝时仓储与召回来源零调用）；
 * - claims 伪造：请求体注入归属/角色/范围/小组、自定义头注入 `x-user-id`/`x-roles`/`x-scope`/
 *   `x-group-id`、查询串注入同名字段均不影响主体、判定入参与返回集合；
 * - AI 关闭：走明确的规则降级（`fallbackUsed=true` + 稳定降级码），且模型 provider 不被调用；
 * - AI 输出含个人标识：模型结果被丢弃并明确降级为规则结果，号码不出现在任何响应文本里；
 * - 敏感字段：召回快照带 PII 时无法写入；存储记录里的推荐文本含号码时整条记录 fail-closed（500）；
 * - 状态机：仓储返回非 `pending` 记录（重复处理/被改写）→ 409 `STATE_TRANSITION_INVALID`，
 *   既有结果不被覆盖；未知状态存储记录 → 500；
 * - 既有路由回归：同一 `AppModule` 下 health / runtime-info / education / profile / applications /
 *   achievements / groups 行为不变，且默认装配不预置任何会话（匹配路由同样 401）。
 *
 * 说明：测试用真实 Nest 应用 + 真实 HTTP（与 `achievements.controller.spec.ts` 同构）。
 * 测试模块按 `MatchingModule` 的绑定逐项重建（三个令牌指向同一实现），只把 **provider 与
 * 环境开关**替换成确定值——真实 `MatchingModule` 的装配另有装配回归断言与整机 AppModule 回归。
 */

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

const SESSION_STUDENT_1 = 'session-student-1';
const SESSION_STUDENT_2 = 'session-student-2';
const SESSION_ADMIN_1 = 'session-admin-1';
const SESSION_LEADER_1 = 'session-leader-1';
const SESSION_UNKNOWN_ROLE = 'session-unknown-role';

const GROUP_MATCHED = '11111111-1111-4111-8111-111111111111';
const GROUP_SECOND = '22222222-2222-4222-8222-222222222222';
const GROUP_CLOSED = '44444444-4444-4444-8444-444444444444';

const STUDENT_1 = 'u-student-1';
const STUDENT_2 = 'u-student-2';

/** 已脱敏的最小特征快照：不含姓名、学号、手机号、微信标识，也不含原始经历原文 */
function featureBundle(): MatchFeatureBundle {
  return {
    student: {
      grade: Grade.Junior,
      major: '软件工程',
      skills: ['TypeScript', 'PostgreSQL'],
      programmingLevel: ProgrammingLevel.Intermediate,
      researchInterests: ['机器学习', '数据可视化'],
      intendedFields: ['人工智能'],
      weeklyHours: 12,
      availablePeriods: [AvailablePeriod.Weekend],
      experienceSummary: '参与校级创新项目，负责数据处理',
    },
    candidates: [
      {
        groupId: GROUP_MATCHED,
        name: '机器学习小组',
        researchDirections: ['机器学习', '计算机视觉'],
        requiredSkills: ['TypeScript', 'PyTorch'],
        grades: [Grade.Junior, Grade.Senior],
        minWeeklyHours: 8,
        headcount: 6,
        memberCount: 3,
        status: GroupStatus.Open,
      },
      {
        groupId: GROUP_SECOND,
        name: '数据可视化小组',
        researchDirections: ['数据可视化', '人机交互'],
        requiredSkills: ['TypeScript'],
        minWeeklyHours: 6,
        headcount: 4,
        memberCount: 4,
        status: GroupStatus.Open,
      },
      {
        groupId: GROUP_CLOSED,
        name: '已关闭小组',
        researchDirections: ['机器学习'],
        requiredSkills: ['TypeScript'],
        status: GroupStatus.Closed,
      },
    ],
  };
}

/**
 * 服务端授权边界夹具：主体 + 该主体被授权可见的小组集合。
 *
 * 与 `featureBundle()` 同源（召回产物即服务端授权产物），只在**直接操作仓储夹具**时使用；
 * 走 HTTP 的用例由 service 自行构造边界。
 */
function scopeFor(ownerUserId: string): MatchingAccessScope {
  return {
    ownerUserId,
    authorizedGroupIds: featureBundle().candidates.map((candidate) => candidate.groupId),
  };
}

const startedApps: INestApplication[] = [];

interface MatchingAppOptions {
  readonly aiEnabled?: boolean;
  readonly providerResult?: unknown;
  readonly provider?: AiProvider;
}

/**
 * 按 `MatchingModule` 的绑定重建测试模块（真实 controller/service/guard/端口实现），
 * 只把 AI provider 与环境开关固定成确定值。
 */
function buildMatchingHttpModule(options: MatchingAppOptions = {}) {
  @Module({
    imports: [ConfigModule, AuthModule, AccessControlModule],
    controllers: [MatchingController],
    providers: [
      { provide: APP_INTERCEPTOR, useClass: ApiResponseInterceptor },
      { provide: APP_FILTER, useClass: ApiExceptionFilter },
      MatchingService,
      {
        // 与真实 MatchingModule 同一换绑点：未配置数据库 ⇒ 内存基线；已配置 ⇒ PostgreSQL adapter
        provide: MATCHING_REPOSITORY,
        useFactory: (
          env: AppEnv,
          sqlConnectionFactory: SqlConnectionFactory | undefined,
        ): InMemoryMatchingRepository | ReturnType<typeof createMatchingRepository> =>
          createMatchingRepository(env, sqlConnectionFactory),
        inject: [APP_ENV, { token: SQL_CONNECTION_FACTORY, optional: true }],
      },
      InMemoryMatchingFeatureSource,
      { provide: MATCHING_FEATURE_SOURCE, useExisting: InMemoryMatchingFeatureSource },
      {
        provide: APP_ENV,
        useValue: loadEnv({
          NODE_ENV: 'test',
          AI_MATCHING_ENABLED: options.aiEnabled ? 'true' : 'false',
          AI_PROVIDER: 'mock',
          AI_MODEL: 'test-model',
        }),
      },
      {
        provide: MATCHING_AI_PROVIDER,
        useValue:
          options.provider ??
          createMockProvider(
            options.providerResult === undefined ? {} : { result: options.providerResult },
          ),
      },
    ],
  })
  class MatchingHttpModule {}
  return MatchingHttpModule;
}

interface TestApp {
  readonly app: INestApplication;
  readonly baseUrl: string;
  readonly store: InMemorySessionStore;
  readonly repository: InMemoryMatchingRepository;
  readonly features: InMemoryMatchingFeatureSource;
}

/** 启动真实应用并注入会话夹具（内存基线的显式 seed，不做隐式全局状态） */
async function startMatchingApp(options: MatchingAppOptions = {}): Promise<TestApp> {
  const app = await NestFactory.create(buildMatchingHttpModule(options), { logger: false });
  app.setGlobalPrefix('api/v1');
  await app.listen(0, '127.0.0.1');
  startedApps.push(app);

  const store = app.get<InMemorySessionStore>(SESSION_STORE);
  store.seed({
    sessionId: SESSION_STUDENT_1,
    subject: { userId: STUDENT_1, roles: [Role.Student] },
  });
  store.seed({
    sessionId: SESSION_STUDENT_2,
    subject: { userId: STUDENT_2, roles: [Role.Student] },
  });
  store.seed({ sessionId: SESSION_ADMIN_1, subject: { userId: 'u-admin-1', roles: [Role.Admin] } });
  store.seed({
    sessionId: SESSION_LEADER_1,
    subject: { userId: 'u-leader-1', roles: [Role.GroupLeader], groupIds: ['g-1'] },
  });
  // 会话存储里出现未登记角色：主体不可信，必须在认证边界整体拒绝
  store.seed({
    sessionId: SESSION_UNKNOWN_ROLE,
    subject: { userId: 'u-unknown-1', roles: ['guest' as Role] },
  });

  const features = app.get(InMemoryMatchingFeatureSource);
  features.seed(STUDENT_1, featureBundle());
  features.seed(STUDENT_2, featureBundle());

  return {
    app,
    baseUrl: `${await app.getUrl()}/api/v1`,
    store,
    repository: app.get<InMemoryMatchingRepository>(MATCHING_REPOSITORY),
    features,
  };
}

interface HttpResult {
  status: number;
  text: string;
  body: ApiEnvelope<unknown>;
}

/** 每次请求使用独立连接（agent: false），避免 keep-alive 让 app.close() 等待空闲连接 */
function call(
  baseUrl: string,
  method: 'GET' | 'POST',
  path: string,
  options: { body?: unknown; headers?: Record<string, string> } = {},
): Promise<HttpResult> {
  return new Promise<HttpResult>((resolve, reject) => {
    const payload = options.body === undefined ? undefined : JSON.stringify(options.body);
    const headers: Record<string, string> = { ...options.headers };
    if (payload !== undefined) {
      headers['content-type'] = 'application/json';
      headers['content-length'] = String(Buffer.byteLength(payload));
    }

    const req = request(`${baseUrl}${path}`, { method, agent: false, headers }, (res) => {
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
    if (payload !== undefined) req.write(payload);
    return req.end();
  });
}

function bearer(sessionId: string): Record<string, string> {
  return { authorization: `Bearer ${sessionId}` };
}

interface ValidationIssue {
  path: string;
  message: string;
}

function issuesOf(body: ApiEnvelope<unknown>): ValidationIssue[] {
  const details = body.error?.details as { issues?: ValidationIssue[] } | undefined;
  return details?.issues ?? [];
}

function viewOf(body: ApiEnvelope<unknown>): Record<string, unknown> {
  return body.data as Record<string, unknown>;
}

function recommendationsOf(body: ApiEnvelope<unknown>): Record<string, unknown>[] {
  return (viewOf(body).recommendations ?? []) as Record<string, unknown>[];
}

/** 存储夹具：模拟「存储里已有他人记录 / 被外部改写的记录」 */
function fixtureRequest(overrides: Partial<MatchingRequest> = {}): MatchingRequest {
  const now = '2026-01-01T00:00:00.000Z';
  return {
    id: randomUUID(),
    userId: STUDENT_1,
    status: MatchingRequestStatus.Completed,
    inputSnapshotHash: 'a'.repeat(64),
    recommendations: [
      {
        groupId: GROUP_MATCHED,
        score: 80,
        reason: '你的机器学习兴趣与该组方向一致',
        advice: '建议补充 PyTorch 后联系负责人',
      },
    ],
    modelVersion: 'test-model',
    promptVersion: 'v1',
    fallbackUsed: true,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

afterAll(async () => {
  await Promise.all(startedApps.map((app) => app.close()));
});

describe('匹配：成功路径（真实 HTTP + 统一响应信封）', () => {
  it('学生发起：201、error 为 null、状态与归属由服务端写入、只返回白名单字段', async () => {
    const { baseUrl, repository } = await startMatchingApp();

    const res = await call(baseUrl, 'POST', '/me/matching-requests', {
      headers: bearer(SESSION_STUDENT_1),
      body: { profileVersion: 2 },
    });

    expect(res.status).toBe(201);
    expect(Object.keys(res.body).sort()).toEqual(['data', 'error', 'meta']);
    expect(res.body.error).toBeNull();
    const view = viewOf(res.body);
    expect(Object.keys(view).sort()).toEqual([...MATCHING_REQUEST_VIEW_FIELDS].sort());
    expect(view.id).toMatch(UUID_V4);
    expect(view.status).toBe(MatchingRequestStatus.Completed);
    expect(view.profileVersion).toBe(2);
    // AI 关闭（本用例环境开关为 false）：明确走规则降级
    expect(view.fallbackUsed).toBe(true);
    expect(view.degradationCode).toBe(AiErrorCode.Disabled);
    expect(view.modelVersion).toBe('test-model');

    // 推荐白名单：只含 groupId/score/reason/advice，且只来自开放候选
    const recommendations = recommendationsOf(res.body);
    expect(recommendations.length).toBeGreaterThanOrEqual(1);
    for (const item of recommendations) {
      expect(Object.keys(item).sort()).toEqual(['advice', 'groupId', 'reason', 'score']);
      expect(item.groupId).toMatch(UUID_V4);
      expect(item.groupId).not.toBe(GROUP_CLOSED);
      expect(Number.isInteger(item.score)).toBe(true);
      expect(item.score as number).toBeGreaterThanOrEqual(0);
      expect(item.score as number).toBeLessThanOrEqual(100);
      expect(item.reason).toBeTruthy();
      expect(item.advice).toBeTruthy();
    }

    // 归属与内部处理记录不回传；画像原始字段（专业/技能/经历摘要）不进入任何响应文本
    expect(res.text).not.toContain(STUDENT_1);
    expect(res.text).not.toContain('软件工程');
    expect(res.text).not.toContain('参与校级创新项目');
    const [stored] = await repository.listByUserId(scopeFor(STUDENT_1));
    expect(stored?.inputSnapshotHash).toMatch(/^[0-9a-f]{64}$/u);
    expect(res.text).not.toContain(stored?.inputSnapshotHash ?? 'x');
    expect(stored?.userId).toBe(STUDENT_1);
  });

  it('不带请求体也能发起（画像版本可选）', async () => {
    const { baseUrl } = await startMatchingApp();
    const res = await call(baseUrl, 'POST', '/me/matching-requests', {
      headers: bearer(SESSION_STUDENT_1),
    });
    expect(res.status).toBe(201);
    expect(viewOf(res.body).profileVersion).toBeUndefined();
  });

  it('学生列表：只返回本人的请求与状态，不含他人记录', async () => {
    const { baseUrl, repository } = await startMatchingApp();
    await repository.create(
      fixtureRequest({ userId: STUDENT_2, id: randomUUID() }),
      scopeFor(STUDENT_2),
    );

    const mine = await call(baseUrl, 'POST', '/me/matching-requests', {
      headers: bearer(SESSION_STUDENT_1),
    });
    expect(mine.status).toBe(201);

    const list = await call(baseUrl, 'GET', '/me/matching-requests', {
      headers: bearer(SESSION_STUDENT_1),
    });
    expect(list.status).toBe(200);
    expect(list.body.error).toBeNull();
    const items = list.body.data as Record<string, unknown>[];
    expect(items).toHaveLength(1);
    expect(items[0]?.id).toBe(viewOf(mine.body).id);
    expect(items[0]?.userId).toBeUndefined();
    expect(list.text).not.toContain(STUDENT_2);
    expect(list.text).not.toContain(STUDENT_1);

    // 同学号会话互相隔离
    const others = await call(baseUrl, 'GET', '/me/matching-requests', {
      headers: bearer(SESSION_STUDENT_2),
    });
    expect(others.status).toBe(200);
    expect((others.body.data as Record<string, unknown>[]).map((item) => item.id)).toEqual([
      (await repository.listByUserId(scopeFor(STUDENT_2)))[0]?.id,
    ]);
  });

  it('无召回结果：no_candidate 终态（不是 500，也不是空推荐的成功态）', async () => {
    const { app, baseUrl, features } = await startMatchingApp();
    // 清掉召回结果的最简方式：用未 seed 的主体会话
    app.get<InMemorySessionStore>(SESSION_STORE).seed({
      sessionId: 'session-student-3',
      subject: { userId: 'u-student-3', roles: [Role.Student] },
    });
    expect(features.loadBundle('u-student-3')).toBeUndefined();

    const res = await call(baseUrl, 'POST', '/me/matching-requests', {
      headers: bearer('session-student-3'),
    });
    expect(res.status).toBe(201);
    expect(viewOf(res.body).status).toBe(MatchingRequestStatus.NoCandidate);
    expect(recommendationsOf(res.body)).toEqual([]);
    expect(viewOf(res.body).fallbackUsed).toBe(true);
  });

  it('AI 开启且模型给出合法可解释输出：fallbackUsed=false 且无降级码', async () => {
    const { baseUrl } = await startMatchingApp({
      aiEnabled: true,
      providerResult: {
        recommendations: [
          {
            groupId: GROUP_MATCHED,
            score: 88,
            reason: '你的机器学习兴趣与该组方向一致',
            advice: '建议补充 PyTorch 后联系负责人',
          },
        ],
      },
    });

    const res = await call(baseUrl, 'POST', '/me/matching-requests', {
      headers: bearer(SESSION_STUDENT_1),
    });
    expect(res.status).toBe(201);
    expect(viewOf(res.body).fallbackUsed).toBe(false);
    expect(viewOf(res.body).degradationCode).toBeUndefined();
    expect(recommendationsOf(res.body)).toEqual([
      {
        groupId: GROUP_MATCHED,
        score: 88,
        reason: '你的机器学习兴趣与该组方向一致',
        advice: '建议补充 PyTorch 后联系负责人',
      },
    ]);
  });
});

describe('匹配：认证 401（fail-closed）', () => {
  it('无凭证 / scheme 错误 / 会话不存在 / 未登记角色 一律 401，且不区分原因', async () => {
    const { baseUrl } = await startMatchingApp();

    const cases: (Record<string, string> | undefined)[] = [
      undefined,
      { authorization: 'Token abcdefgh' },
      { authorization: 'Bearer session-does-not-exist' },
      bearer(SESSION_UNKNOWN_ROLE),
    ];
    for (const headers of cases) {
      for (const [method, path] of [
        ['GET', '/me/matching-requests'],
        ['POST', '/me/matching-requests'],
      ] as const) {
        const res = await call(baseUrl, method, path, headers ? { headers } : {});
        expect(res.status).toBe(401);
        expect(res.body.data).toBeNull();
        expect(res.body.error?.code).toBe('UNAUTHENTICATED');
        expect(res.body.error?.message).toBe('登录状态无效或已过期，请重新登录');
      }
    }
  });
});

describe('匹配：输入拒绝 400（闭集，不是静默剥离）', () => {
  it('服务端独占字段逐项 400，且给出可区分的拒绝原因', async () => {
    const { baseUrl, repository } = await startMatchingApp();

    const forbidden: readonly Record<string, unknown>[] = [
      { userId: 'u-victim-1' },
      { roles: [Role.SuperAdmin] },
      { scope: DataScope.Global },
      { groupId: GROUP_MATCHED },
      { groupIds: [GROUP_MATCHED] },
      { status: MatchingRequestStatus.Completed },
      { recommendations: [] },
      { modelVersion: 'gpt-x' },
      { fallbackUsed: false },
      { inputSnapshotHash: 'a'.repeat(64) },
      { student: { grade: 'junior' } },
      { createdAt: '2026-01-01T00:00:00.000Z' },
    ];

    for (const body of forbidden) {
      const res = await call(baseUrl, 'POST', '/me/matching-requests', {
        headers: bearer(SESSION_STUDENT_1),
        body,
      });
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(res.body.data).toBeNull();
      expect(res.body.error?.code).toBe('VALIDATION_FAILED');
      const key = Object.keys(body)[0] ?? '';
      expect(issuesOf(res.body).map((issue) => issue.path)).toContain(key);
      expect(issuesOf(res.body)[0]?.message).toBe(`禁止设置服务端字段 ${key}`);
      expect(res.text).not.toContain('u-victim-1');
    }
    expect(await repository.listByUserId(scopeFor(STUDENT_1))).toHaveLength(0);
  });

  it('非法画像版本与非对象请求体 400', async () => {
    const { baseUrl } = await startMatchingApp();
    for (const body of [
      { profileVersion: 'v2' },
      { profileVersion: 0 },
      { profileVersion: 1.5 },
      { profileVersion: 1_000_001 },
      [],
      null,
      'not-an-object',
    ]) {
      const res = await call(baseUrl, 'POST', '/me/matching-requests', {
        headers: bearer(SESSION_STUDENT_1),
        body,
      });
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(res.body.error?.code).toBe('VALIDATION_FAILED');
    }
  });

  it('未声明但与权限无关的字段同样 400（不是静默忽略）', async () => {
    const { baseUrl } = await startMatchingApp();
    const res = await call(baseUrl, 'POST', '/me/matching-requests', {
      headers: bearer(SESSION_STUDENT_1),
      body: { note: '想找机器学习方向的小组' },
    });
    expect(res.status).toBe(400);
    expect(issuesOf(res.body)[0]?.message).toBe('请求体包含未声明字段 note');
  });
});

describe('匹配：越权 403 与「授权先于一切」', () => {
  it('无该权限点（admin）或默认范围不是 SELF（group_leader）→ 403，且不泄露资源存在性', async () => {
    const { baseUrl, repository } = await startMatchingApp();

    for (const sessionId of [SESSION_ADMIN_1, SESSION_LEADER_1]) {
      const post = await call(baseUrl, 'POST', '/me/matching-requests', {
        headers: bearer(sessionId),
        body: {},
      });
      expect(post.status).toBe(403);
      expect(post.body.error?.code).toBe('FORBIDDEN');
      expect(post.body.error?.message).toBe('无权执行该操作');

      const get = await call(baseUrl, 'GET', '/me/matching-requests', {
        headers: bearer(sessionId),
      });
      expect(get.status).toBe(403);
      expect(get.body.data).toBeNull();
      // 403 不回答「你到底有没有匹配记录」
      expect(get.body.error?.message).toBe('无权执行该操作');
      expect(get.text).not.toContain('u-leader-1');
    }
    expect(await repository.listByUserId(scopeFor('u-admin-1'))).toHaveLength(0);
  });

  it('授权先于仓储访问：403 时仓储的读/写方法一次都不被调用', async () => {
    const { app, baseUrl, repository } = await startMatchingApp();
    const createSpy = vi.spyOn(repository, 'create');
    const saveSpy = vi.spyOn(repository, 'save');
    const listSpy = vi.spyOn(repository, 'listByUserId');
    expect(app.get(MATCHING_REPOSITORY)).toBe(repository);

    const write = await call(baseUrl, 'POST', '/me/matching-requests', {
      headers: bearer(SESSION_LEADER_1),
      body: {},
    });
    const read = await call(baseUrl, 'GET', '/me/matching-requests', {
      headers: bearer(SESSION_ADMIN_1),
    });
    expect(write.status).toBe(403);
    expect(read.status).toBe(403);
    expect(createSpy).not.toHaveBeenCalled();
    expect(saveSpy).not.toHaveBeenCalled();
    expect(listSpy).not.toHaveBeenCalled();
  });

  it('授权与输入校验都先于召回来源访问，且合法请求才真的去召回（正反对照）', async () => {
    const { baseUrl, features } = await startMatchingApp();
    const loadSpy = vi.spyOn(features, 'loadBundle');

    // 无权限主体：403，且连「该主体有没有可召回画像」都不去观察
    const forbidden = await call(baseUrl, 'POST', '/me/matching-requests', {
      headers: bearer(SESSION_LEADER_1),
      body: {},
    });
    expect(forbidden.status).toBe(403);

    // 有权限但输入非法：400，同样不触碰召回来源（校验先于取数）
    const invalid = await call(baseUrl, 'POST', '/me/matching-requests', {
      headers: bearer(SESSION_STUDENT_1),
      body: { userId: 'u-victim-1' },
    });
    expect(invalid.status).toBe(400);

    expect(loadSpy).not.toHaveBeenCalled();

    // 对照组：合法请求确实会按服务端主体访问召回来源（证明上面的「零调用」不是恒真）
    const accepted = await call(baseUrl, 'POST', '/me/matching-requests', {
      headers: bearer(SESSION_STUDENT_1),
      body: {},
    });
    expect(accepted.status).toBe(201);
    expect(loadSpy).toHaveBeenCalledTimes(1);
    expect(loadSpy).toHaveBeenCalledWith(STUDENT_1);
  });

  it('授权先于字段校验：无权限主体的非法请求体得到 403，而不是 400', async () => {
    const { baseUrl } = await startMatchingApp();
    const res = await call(baseUrl, 'POST', '/me/matching-requests', {
      headers: bearer(SESSION_LEADER_1),
      body: { userId: 'u-victim-1', profileVersion: 'v2' },
    });
    expect(res.status).toBe(403);
    expect(res.body.error?.code).toBe('FORBIDDEN');
    expect(res.text).not.toContain('u-victim-1');
  });

  it('判定入参只来自服务端：权限点/范围/资源归属恒为常量与会话主体', async () => {
    const { app, baseUrl } = await startMatchingApp();
    const adapter = app.get<RuoYiAuthzAdapter>(RUOYI_AUTHZ_ADAPTER);
    const checkAuthorization = vi.spyOn(adapter, 'checkAuthorization');

    const res = await call(baseUrl, 'POST', '/me/matching-requests', {
      headers: {
        ...bearer(SESSION_STUDENT_1),
        'x-user-id': 'u-victim-1',
        'x-roles': Role.SuperAdmin,
        'x-scope': DataScope.Global,
        'x-group-id': 'g-forged',
      },
      body: {},
    });

    expect(res.status).toBe(201);
    expect(checkAuthorization).toHaveBeenCalledTimes(1);
    expect(checkAuthorization).toHaveBeenCalledWith(
      { userId: STUDENT_1, roles: [Role.Student] },
      {
        permission: PermissionPoint.MatchingSelfRequest,
        scope: DataScope.Self,
        resourceUserId: STUDENT_1,
      },
    );
    // 伪造的自定义头既没有进入判定入参，也没有进入响应
    expect(checkAuthorization.mock.calls[0]?.[1]).not.toMatchObject({ scope: DataScope.Global });
    expect(res.text).not.toContain('u-victim-1');
    expect(res.text).not.toContain('g-forged');
  });
});

describe('匹配：客户端声明伪造无效（请求体 / 查询串 / 自定义头）', () => {
  it('查询串里的 userId/roles/scope/groupId 不被读取也不被信任', async () => {
    const { baseUrl, repository } = await startMatchingApp();
    await repository.create(
      fixtureRequest({ userId: STUDENT_2, id: randomUUID() }),
      scopeFor(STUDENT_2),
    );

    const res = await call(
      baseUrl,
      'GET',
      `/me/matching-requests?userId=${STUDENT_2}&roles=super_admin&scope=GLOBAL&groupId=${GROUP_MATCHED}`,
      { headers: bearer(SESSION_STUDENT_1) },
    );

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);
    expect(res.text).not.toContain(STUDENT_2);
  });

  it('自定义头伪造归属/角色/范围不能改变返回集合', async () => {
    const { baseUrl } = await startMatchingApp();
    await call(baseUrl, 'POST', '/me/matching-requests', {
      headers: bearer(SESSION_STUDENT_1),
    });

    const plain = await call(baseUrl, 'GET', '/me/matching-requests', {
      headers: bearer(SESSION_STUDENT_2),
    });
    const forged = await call(baseUrl, 'GET', '/me/matching-requests', {
      headers: {
        ...bearer(SESSION_STUDENT_2),
        'x-user-id': STUDENT_1,
        'x-roles': Role.SuperAdmin,
        'x-scope': DataScope.Global,
        'x-group-id': 'g-forged',
      },
    });

    expect(forged.status).toBe(200);
    expect(forged.body.data).toEqual(plain.body.data);
    expect(forged.text).not.toContain(Role.SuperAdmin);
    expect(forged.text).not.toContain(STUDENT_1);
  });

  it('请求体里的归属/角色/范围声明不落库（伪造的归属不是写入目标）', async () => {
    const { baseUrl, repository } = await startMatchingApp();
    const res = await call(baseUrl, 'POST', '/me/matching-requests', {
      headers: {
        ...bearer(SESSION_STUDENT_1),
        'x-user-id': 'u-victim-1',
        'x-roles': Role.SuperAdmin,
      },
      body: { userId: 'u-victim-1', roles: [Role.SuperAdmin], scope: DataScope.Global },
    });

    expect(res.status).toBe(400);
    expect(await repository.listByUserId(scopeFor(STUDENT_1))).toHaveLength(0);
    expect(await repository.listByUserId(scopeFor('u-victim-1'))).toHaveLength(0);
    expect(res.text).not.toContain('u-victim-1');
  });
});

describe('匹配：敏感字段不外泄（快照、模型输出、存储记录三层）', () => {
  it('召回快照带 PII 时无法写入，且错误信息只含字段路径不含字段值', () => {
    const features = new InMemoryMatchingFeatureSource(loadEnv({ NODE_ENV: 'test' }));
    const bundle = featureBundle();
    const tainted = {
      ...bundle,
      student: { ...bundle.student, studentNo: '2023123456', phone: '13800138000' },
    } as unknown as MatchFeatureBundle;

    expect(() => features.seed(STUDENT_1, tainted)).toThrowError(/未脱敏/u);
    let message = '';
    try {
      features.seed(STUDENT_1, tainted);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain('student.studentNo');
    expect(message).not.toContain('2023123456');
    expect(message).not.toContain('13800138000');
    expect(features.loadBundle(STUDENT_1)).toBeUndefined();
  });

  it('模型输出的理由含手机号：丢弃模型结果、明确降级为规则结果，号码不出现在响应里', async () => {
    const { baseUrl } = await startMatchingApp({
      aiEnabled: true,
      providerResult: {
        recommendations: [
          {
            groupId: GROUP_MATCHED,
            score: 88,
            reason: '你的机器学习兴趣与该组方向一致，请联系 13800138000 报名',
            advice: '建议补充 PyTorch 后联系负责人',
          },
        ],
      },
    });

    const res = await call(baseUrl, 'POST', '/me/matching-requests', {
      headers: bearer(SESSION_STUDENT_1),
    });

    expect(res.status).toBe(201);
    expect(viewOf(res.body).fallbackUsed).toBe(true);
    expect(viewOf(res.body).degradationCode).toBe(AiErrorCode.OutputInvalid);
    expect(recommendationsOf(res.body).length).toBeGreaterThanOrEqual(1);
    expect(res.text).not.toContain('13800138000');
    expect(res.text).not.toContain('请联系');
  });

  it('存储记录里的推荐文本含号码 → 500 INTERNAL_ERROR，且不回显号码与原文', async () => {
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const { baseUrl, repository } = await startMatchingApp();
    await repository.create(
      fixtureRequest({
        recommendations: [
          {
            groupId: GROUP_MATCHED,
            score: 70,
            reason: '请联系 13800138000 报名',
            advice: '建议尽快联系负责人',
          },
        ],
      }),
      scopeFor(STUDENT_1),
    );

    const res = await call(baseUrl, 'GET', '/me/matching-requests', {
      headers: bearer(SESSION_STUDENT_1),
    });

    expect(res.status).toBe(500);
    expect(res.body.data).toBeNull();
    expect(res.body.error?.code).toBe('INTERNAL_ERROR');
    expect(res.text).not.toContain('13800138000');
    expect(res.text).not.toContain('建议尽快联系负责人');
  });

  it('输出字段闭集：视图只可能出现在白名单内，归属与快照摘要永不出现', async () => {
    const { baseUrl, repository } = await startMatchingApp();
    const created = await call(baseUrl, 'POST', '/me/matching-requests', {
      headers: bearer(SESSION_STUDENT_1),
      // 显式带上可选字段，使白名单里的 10 个字段全部可达
      body: { profileVersion: 1 },
    });
    expect(created.status).toBe(201);
    expect(Object.keys(viewOf(created.body)).sort()).toEqual(
      [...MATCHING_REQUEST_VIEW_FIELDS].sort(),
    );

    const list = await call(baseUrl, 'GET', '/me/matching-requests', {
      headers: bearer(SESSION_STUDENT_1),
    });
    const whitelist: readonly string[] = MATCHING_REQUEST_VIEW_FIELDS;
    const items = list.body.data as Record<string, unknown>[];
    expect(items.length).toBeGreaterThanOrEqual(1);
    for (const item of items) {
      // 白名单是闭集：未登记字段一旦出现即为契约漂移
      expect(Object.keys(item).filter((key) => !whitelist.includes(key))).toEqual([]);
      expect(item.userId).toBeUndefined();
      expect(item.inputSnapshotHash).toBeUndefined();
      expect(list.text).not.toContain(
        (await repository.findById(String(item.id), scopeFor(STUDENT_1)))?.inputSnapshotHash ?? 'x',
      );
    }
  });
});

describe('匹配：状态机与存储不变量 fail-closed', () => {
  it('仓储返回非 pending 记录（重复处理/被改写）→ 409 STATE_TRANSITION_INVALID，既有结果不被覆盖', async () => {
    const { baseUrl, repository } = await startMatchingApp();
    const existing = fixtureRequest({ status: MatchingRequestStatus.Completed });
    const createSpy = vi
      .spyOn(repository, 'create')
      .mockResolvedValue({ ...existing, status: MatchingRequestStatus.Completed });
    const saveSpy = vi.spyOn(repository, 'save');

    const res = await call(baseUrl, 'POST', '/me/matching-requests', {
      headers: bearer(SESSION_STUDENT_1),
    });

    expect(res.status).toBe(409);
    expect(res.body.data).toBeNull();
    expect(res.body.error?.code).toBe('STATE_TRANSITION_INVALID');
    expect(createSpy).toHaveBeenCalledTimes(1);
    expect(saveSpy).not.toHaveBeenCalled();
    expect(res.text).not.toContain(existing.id);
    expect(res.text).not.toContain('你的机器学习兴趣与该组方向一致');
  });

  it('存储记录状态未登记 → 500；状态与条数矛盾 → 500；都不泄露字段取值', async () => {
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const { baseUrl, repository } = await startMatchingApp();
    const corrupted = await repository.create(
      fixtureRequest({
        status: 'unknown_status' as MatchingRequestStatus,
        recommendations: [
          { groupId: GROUP_MATCHED, score: 42, reason: '受损理由', advice: '受损建议' },
        ],
      }),
      scopeFor(STUDENT_1),
    );

    const res = await call(baseUrl, 'GET', '/me/matching-requests', {
      headers: bearer(SESSION_STUDENT_1),
    });

    expect(res.status).toBe(500);
    expect(res.body.error?.code).toBe('INTERNAL_ERROR');
    expect(res.text).not.toContain('unknown_status');
    expect(res.text).not.toContain('受损理由');
    expect(res.text).not.toContain(corrupted.id);
  });

  it('仓储返回他人归属 → 500，绝不把他人匹配请求当作本人列表输出', async () => {
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const { baseUrl, repository } = await startMatchingApp();
    vi.spyOn(repository, 'listByUserId').mockResolvedValue([
      fixtureRequest({
        userId: STUDENT_2,
        recommendations: [],
        status: MatchingRequestStatus.NoCandidate,
      }),
    ]);

    const res = await call(baseUrl, 'GET', '/me/matching-requests', {
      headers: bearer(SESSION_STUDENT_1),
    });

    expect(res.status).toBe(500);
    expect(res.body.data).toBeNull();
    expect(res.body.error?.code).toBe('INTERNAL_ERROR');
    expect(res.text).not.toContain(STUDENT_2);
  });
});

describe('匹配：切片装配与既有路由回归', () => {
  it('MatchingModule 只注册本切片的路由与服务，并把三个令牌显式绑定', () => {
    const providers = (Reflect.getMetadata('providers', MatchingModule) ?? []) as unknown[];
    const controllers = (Reflect.getMetadata('controllers', MatchingModule) ?? []) as unknown[];
    const moduleImports = (Reflect.getMetadata('imports', MatchingModule) ?? []) as unknown[];

    expect(controllers).toEqual([MatchingController]);
    expect(providers).toContain(MatchingService);
    // 仓储端口由换绑工厂提供（按是否配置 DATABASE_URL 分流），内存基线不再是 provider
    expect(providers).toContainEqual({
      provide: MATCHING_REPOSITORY,
      useFactory: expect.any(Function) as unknown,
      inject: [APP_ENV, { token: SQL_CONNECTION_FACTORY, optional: true }],
    });
    expect(providers).not.toContain(InMemoryMatchingRepository);
    expect(providers).not.toContainEqual({
      provide: MATCHING_REPOSITORY,
      useExisting: InMemoryMatchingRepository,
    });
    expect(providers).toContainEqual({
      provide: MATCHING_FEATURE_SOURCE,
      useExisting: InMemoryMatchingFeatureSource,
    });
    expect(providers).toContainEqual({
      provide: MATCHING_AI_PROVIDER,
      useFactory: expect.any(Function) as unknown,
      inject: [APP_ENV],
    });
    // 依赖方向：认证（auth）与授权（access-control）各自只经端口/服务暴露
    expect(moduleImports).toContain(AuthModule);
    expect(moduleImports).toContain(AccessControlModule);
  });

  it('契约回归：发起接口字段闭集与共享 matchingRequestInputSchema 的键集一致', () => {
    expect([...MATCHING_REQUEST_INPUT_FIELDS].sort()).toEqual(
      Object.keys(matchingRequestInputSchema.shape).sort(),
    );
  });

  it('内存基线如实声明非持久化/未接入真实数据，并在生产环境拒绝构造', () => {
    const developmentEnv = loadEnv({ NODE_ENV: 'development' });
    const productionEnv = loadEnv({ NODE_ENV: 'production' });

    expect(new InMemoryMatchingRepository(developmentEnv).capabilities).toEqual({
      backend: 'in-memory-baseline',
      persistent: false,
      productionReady: false,
    });
    expect(new InMemoryMatchingFeatureSource(developmentEnv).capabilities).toEqual({
      backend: 'in-memory-baseline',
      connectedToDomainData: false,
      productionReady: false,
    });

    expect(() => new InMemoryMatchingRepository(productionEnv)).toThrow(
      /生产环境禁止使用内存匹配仓储/u,
    );
    expect(() => new InMemoryMatchingFeatureSource(productionEnv)).toThrow(
      /生产环境禁止使用内存匹配特征源/u,
    );
  });

  it('内存仓储不把内部引用交给调用方，且拒绝覆盖未知 id 与改写归属', async () => {
    const repository = new InMemoryMatchingRepository(loadEnv({ NODE_ENV: 'development' }));
    const scope = scopeFor(STUDENT_1);
    const stored = await repository.create(
      fixtureRequest({ recommendations: [], status: MatchingRequestStatus.NoCandidate }),
      scope,
    );

    const listed = (await repository.listByUserId(scope))[0] as
      { id: string; status: string } | undefined;
    expect(listed?.id).toBe(stored.id);
    // 副本：外部改写不得影响存储
    if (listed) listed.status = 'tampered';
    expect((await repository.findById(stored.id, scope))?.status).toBe(
      MatchingRequestStatus.NoCandidate,
    );

    await expect(repository.save(fixtureRequest({ id: 'missing-id' }), scope)).rejects.toThrow(
      /不存在/u,
    );
    // 归属不得被改写：他人记录（同 id 属于 STUDENT_1）用另一个服务端主体覆盖写入必须被拒
    const otherScope = scopeFor(STUDENT_2);
    await expect(
      repository.save(fixtureRequest({ id: stored.id, userId: STUDENT_2 }), otherScope),
    ).rejects.toThrow(/归属不一致/u);
    // 服务端主体与记录归属不一致（scope 与记录归属不同）同样在写入前被拒
    await expect(repository.save(fixtureRequest({ id: stored.id }), otherScope)).rejects.toThrow(
      /归属与本次访问的服务端主体不一致/u,
    );
  });

  it('完整 AppModule：既有路由行为不变，匹配路由默认 401', async () => {
    const app = await NestFactory.create(AppModule, { logger: false });
    app.setGlobalPrefix('api/v1');
    await app.listen(0, '127.0.0.1');
    startedApps.push(app);
    const baseUrl = `${await app.getUrl()}/api/v1`;

    const health = await call(baseUrl, 'GET', '/health');
    expect(health.status).toBe(200);
    expect(health.body.error).toBeNull();
    expect(health.body.data).toMatchObject({ status: 'ok', prefix: '/api/v1' });

    const runtimeInfo = await call(baseUrl, 'GET', '/runtime-info');
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

    // 既有切片回归：默认装配不预置任何会话，因此一律 401（而非 500/404）
    for (const path of [
      '/me/education-records',
      '/me/profile',
      '/me/applications',
      '/me/achievements',
      '/groups',
      '/me/matching-requests',
    ]) {
      const res = await call(baseUrl, 'GET', path);
      expect(res.status).toBe(401);
      expect(res.body.error?.code).toBe('UNAUTHENTICATED');
    }

    // 发起路由在默认装配下同样 401，不因缺少会话而 500
    const post = await call(baseUrl, 'POST', '/me/matching-requests');
    expect(post.status).toBe(401);
    expect(post.body.error?.code).toBe('UNAUTHENTICATED');
  });
});

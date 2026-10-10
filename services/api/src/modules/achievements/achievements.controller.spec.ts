import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { request } from 'node:http';
import { Logger, Module } from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import { APP_FILTER, APP_INTERCEPTOR, NestFactory } from '@nestjs/core';
import {
  AchievementType,
  DataScope,
  PermissionPoint,
  ReviewStatus,
  Role,
  achievementInputSchema,
} from '@rm/shared';
import type { ApiEnvelope } from '@rm/shared';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { AppModule } from '../../app.module';
import { ApiExceptionFilter } from '../../common/api-exception.filter';
import { ApiResponseInterceptor } from '../../common/api-response.interceptor';
import { ConfigModule } from '../../config/config.module';
import { loadEnv } from '../../config/env';
import { AccessControlModule } from '../access-control/access-control.module';
import { AuthModule } from '../auth/auth.module';
import { InMemorySessionStore } from '../auth/session-store.in-memory';
import { SESSION_STORE } from '../auth/session-subject.port';
import { RUOYI_AUTHZ_ADAPTER } from '../ruoyi-adapter/ruoyi-adapter.port';
import type { RuoYiAuthzAdapter } from '../ruoyi-adapter/ruoyi-adapter.port';
import { ACHIEVEMENT_INPUT_FIELDS } from './achievements.contract';
import { AchievementsController } from './achievements.controller';
import { InMemoryAchievementRepository } from './achievements.in-memory-repository';
import type { Achievement } from './achievements.port';
import { ACHIEVEMENT_REPOSITORY } from './achievements.port';
import { AchievementsService } from './achievements.service';
import { AchievementsModule, createAchievementRepository } from './achievements.module';

/**
 * 成果切片（`/me/achievements`）的真实 HTTP 回归：
 *
 * - 成功：本人创建 / 本人列表 / 本人单条读取；归属、审核态与时间戳由服务端决定，响应不含 `userId`；
 * - 输入拒绝 400：未知类型枚举、空/超长标题、控制字符、非法取得时间、非 UUID 佐证文件 ID、
 *   说明含身份证号/密钥/长数字标识，以及未声明字段（客户端 `userId`/`roles`/`scope`/`groupId`/
 *   `reviewStatus`/`id`/时间戳一律 400，给出可区分的拒绝原因）；
 * - 认证 401：无凭证、scheme 不对、凭证过短、会话不存在、会话主体含未登记角色（fail-closed）；
 * - 越权 403：角色无该权限点（admin）、角色虽有权限点但范围不是 SELF（group_leader）、
 *   且授权**先于仓储访问**（拒绝时仓储方法零调用）；判定入参只来自服务端（断言端口调用参数）；
 *   单条读取中**他人成果与不存在的成果一律 404**（归属下推到取数，存在性不可探测）；
 * - claims 伪造：请求体注入归属/角色/范围/小组、自定义头注入 `x-user-id`/`x-roles`/`x-scope`/
 *   `x-group-id` 均不影响主体与归属；
 * - fail-closed 500：存储层出现未登记枚举、非法时间戳、他人归属时不得作为正常输出返回，
 *   也不得泄露字段取值；
 * - 既有路由回归：同一 `AppModule` 下 health / runtime-info / education / profile / applications
 *   行为不变，且默认装配不预置任何会话。
 *
 * 说明：测试用真实 Nest 应用 + 真实 HTTP（与 `education-records.controller.spec.ts` 同构），
 * 只通过 DI 令牌/端口注入测试夹具（会话、仓储记录），不替换任何生产代码路径。
 */

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

const SESSION_STUDENT_1 = 'session-student-1';
const SESSION_STUDENT_2 = 'session-student-2';
const SESSION_ADMIN_1 = 'session-admin-1';
const SESSION_LEADER_1 = 'session-leader-1';
const SESSION_UNKNOWN_ROLE = 'session-unknown-role';

/** 合法请求体：归属、审核态、时间戳均由服务端补齐 */
const validCreateBody = {
  type: AchievementType.Paper,
  title: '第一作者论文',
  awardLevel: '校级一等奖',
  description: '论文成果说明',
  achievedAt: '2026-05-01T00:00:00.000Z',
  evidenceFileId: randomUUID(),
};

const startedApps: INestApplication[] = [];

@Module({
  imports: [ConfigModule, AchievementsModule],
  providers: [
    { provide: APP_INTERCEPTOR, useClass: ApiResponseInterceptor },
    { provide: APP_FILTER, useClass: ApiExceptionFilter },
  ],
})
class AchievementsHttpModule {}

interface TestApp {
  readonly app: INestApplication;
  readonly baseUrl: string;
  readonly store: InMemorySessionStore;
  readonly repository: InMemoryAchievementRepository;
}

/** 启动真实应用并注入会话夹具（内存基线的显式 seed，不做隐式全局状态） */
async function startAchievementsApp(): Promise<TestApp> {
  const app = await NestFactory.create(AchievementsHttpModule, { logger: false });
  app.setGlobalPrefix('api/v1');
  await app.listen(0, '127.0.0.1');
  startedApps.push(app);

  const store = app.get<InMemorySessionStore>(SESSION_STORE);
  store.seed({
    sessionId: SESSION_STUDENT_1,
    subject: { userId: 'u-student-1', roles: [Role.Student] },
  });
  store.seed({
    sessionId: SESSION_STUDENT_2,
    subject: { userId: 'u-student-2', roles: [Role.Student] },
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

  return {
    app,
    baseUrl: `${await app.getUrl()}/api/v1`,
    store,
    repository: app.get<InMemoryAchievementRepository>(ACHIEVEMENT_REPOSITORY),
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

/** 测试夹具记录：归属主体由调用方指定，模拟「存储里已存在他人记录」 */
function fixtureAchievement(overrides: Partial<Achievement> = {}): Achievement {
  const now = '2026-01-01T00:00:00.000Z';
  return {
    id: randomUUID(),
    userId: 'u-student-1',
    type: AchievementType.Competition,
    title: '竞赛成果',
    reviewStatus: ReviewStatus.Approved,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

interface ValidationIssue {
  path: string;
  message: string;
}

function issuesOf(body: ApiEnvelope<unknown>): ValidationIssue[] {
  const details = body.error?.details as { issues?: ValidationIssue[] } | undefined;
  return details?.issues ?? [];
}

afterAll(async () => {
  await Promise.all(startedApps.map((app) => app.close()));
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('成果：成功路径（真实 HTTP + 统一响应信封）', () => {
  it('本人创建：201、error 为 null、返回读取视图（不含 userId）、归属与审核态由服务端写入', async () => {
    const { baseUrl, repository } = await startAchievementsApp();

    const res = await call(baseUrl, 'POST', '/me/achievements', {
      headers: { ...bearer(SESSION_STUDENT_1), 'x-request-id': 'test-request-achievement-1' },
      body: validCreateBody,
    });

    expect(res.status).toBe(201);
    expect(res.body.error).toBeNull();
    expect(res.body.meta.requestId).toBe('test-request-achievement-1');

    const data = res.body.data as Record<string, unknown>;
    // 响应字段闭集：没有 userId，也没有审核人/审核意见/审核时间等内部处理字段
    expect(Object.keys(data).sort()).toEqual([
      'achievedAt',
      'awardLevel',
      'createdAt',
      'description',
      'evidenceFileId',
      'id',
      'reviewStatus',
      'title',
      'type',
      'updatedAt',
    ]);
    expect(UUID_V4.test(String(data.id))).toBe(true);
    expect(data).toMatchObject({
      type: AchievementType.Paper,
      title: '第一作者论文',
      awardLevel: '校级一等奖',
      description: '论文成果说明',
      achievedAt: '2026-05-01T00:00:00.000Z',
      evidenceFileId: validCreateBody.evidenceFileId,
      // 学生不能自授权审核态：新建成果一律待审核
      reviewStatus: ReviewStatus.Pending,
    });
    // 归属字段与其取值不出现在任何响应文本里
    expect(res.text).not.toContain('u-student-1');

    const stored = await repository.listByUserId('u-student-1');
    expect(stored).toHaveLength(1);
    expect(stored[0]?.userId).toBe('u-student-1');
    expect(stored[0]?.id).toBe(data.id);
    expect(stored[0]?.reviewStatus).toBe(ReviewStatus.Pending);
  });

  it('本人列表：只返回本人成果，且不泄露他人记录内容；空列表返回 []', async () => {
    const { baseUrl, repository } = await startAchievementsApp();

    const empty = await call(baseUrl, 'GET', '/me/achievements', {
      headers: bearer(SESSION_STUDENT_1),
    });
    expect(empty.status).toBe(200);
    expect(empty.body.error).toBeNull();
    expect(empty.body.data).toEqual([]);

    const mine = await repository.create(fixtureAchievement({ userId: 'u-student-1' }));
    const others = await repository.create(
      fixtureAchievement({ userId: 'u-student-2', title: '他人成果' }),
    );

    const list = await call(baseUrl, 'GET', '/me/achievements', {
      headers: bearer(SESSION_STUDENT_1),
    });
    expect(list.status).toBe(200);
    expect(list.body.error).toBeNull();
    const items = list.body.data as Array<Record<string, unknown>>;
    expect(items).toHaveLength(1);
    expect(items[0]?.id).toBe(mine.id);
    // 无可选字段时视图只输出必填字段（逐字段显式投影）
    expect(Object.keys(items[0] ?? {}).sort()).toEqual([
      'createdAt',
      'id',
      'reviewStatus',
      'title',
      'type',
      'updatedAt',
    ]);
    expect(list.text).not.toContain('他人成果');
    expect(list.text).not.toContain(others.id);
    expect(list.text).not.toContain('u-student-2');
  });

  it('本人单条读取：200、返回读取视图（不含 userId）；他人成果与不存在的成果一律 404', async () => {
    const { baseUrl, repository } = await startAchievementsApp();
    const mine = await repository.create(
      fixtureAchievement({ userId: 'u-student-1', title: '本人成果' }),
    );
    const others = await repository.create(
      fixtureAchievement({ userId: 'u-student-2', title: '他人成果' }),
    );

    const res = await call(baseUrl, 'GET', `/me/achievements/${mine.id}`, {
      headers: { ...bearer(SESSION_STUDENT_1), 'x-request-id': 'test-request-achievement-detail' },
    });

    expect(res.status).toBe(200);
    expect(res.body.error).toBeNull();
    expect(res.body.meta.requestId).toBe('test-request-achievement-detail');
    const data = res.body.data as Record<string, unknown>;
    expect(data.id).toBe(mine.id);
    expect(data.title).toBe('本人成果');
    // 视图字段闭集：没有 userId，也没有审核人/审核意见/审核时间等内部处理字段
    expect(Object.keys(data).sort()).toEqual([
      'createdAt',
      'id',
      'reviewStatus',
      'title',
      'type',
      'updatedAt',
    ]);
    expect(res.text).not.toContain('u-student-1');

    // 他人成果：与「不存在」完全同一响应（归属下推到取数，存在性不可探测）
    const foreign = await call(baseUrl, 'GET', `/me/achievements/${others.id}`, {
      headers: bearer(SESSION_STUDENT_1),
    });
    expect(foreign.status).toBe(404);
    expect(foreign.body.data).toBeNull();
    expect(foreign.body.error?.code).toBe('NOT_FOUND');
    expect(foreign.text).not.toContain('他人成果');
    expect(foreign.text).not.toContain('u-student-2');

    // 不存在的成果：同一 404 口径（不区分「不存在」与「不是你的」）
    const missing = await call(baseUrl, 'GET', `/me/achievements/${randomUUID()}`, {
      headers: bearer(SESSION_STUDENT_1),
    });
    expect(missing.status).toBe(404);
    expect(missing.body.error?.code).toBe('NOT_FOUND');
  });

  it('自定义头里的归属/角色/范围声明不参与任何判定（claims 伪造无效）', async () => {
    const { baseUrl, repository } = await startAchievementsApp();

    const res = await call(baseUrl, 'POST', '/me/achievements', {
      headers: {
        ...bearer(SESSION_STUDENT_1),
        'x-user-id': 'u-victim-1',
        'x-roles': Role.SuperAdmin,
        'x-scope': DataScope.Global,
        'x-group-id': 'g-1',
      },
      body: validCreateBody,
    });

    expect(res.status).toBe(201);
    expect(res.body.error).toBeNull();
    // 归属仍是会话主体，伪造的 x-user-id 既未进入判定也未落库
    await expect(repository.listByUserId('u-student-1')).resolves.toHaveLength(1);
    await expect(repository.listByUserId('u-victim-1')).resolves.toHaveLength(0);
    expect(res.text).not.toContain('u-victim-1');
    expect(res.text).not.toContain(Role.SuperAdmin);
    expect(res.text).not.toContain(DataScope.Global);
  });
});

describe('成果：输入拒绝（400 VALIDATION_FAILED，不落库）', () => {
  const invalidCases: ReadonlyArray<{ name: string; body: unknown }> = [
    { name: '未知 type 枚举', body: { ...validCreateBody, type: 'unknown_type' } },
    { name: '未知 type 枚举（数据库式大写）', body: { ...validCreateBody, type: 'PAPER' } },
    { name: '缺类型', body: { title: '只有标题' } },
    { name: '缺少标题', body: { type: AchievementType.Paper } },
    { name: '标题为空串', body: { ...validCreateBody, title: '' } },
    { name: '标题超长（301 字符）', body: { ...validCreateBody, title: 'x'.repeat(301) } },
    { name: '标题含控制字符', body: { ...validCreateBody, title: '论文\u0007标题' } },
    { name: '获奖级别含控制字符', body: { ...validCreateBody, awardLevel: '一等奖\u0000' } },
    { name: 'achievedAt 非法时间', body: { ...validCreateBody, achievedAt: 'not-a-date' } },
    { name: 'evidenceFileId 非 UUID', body: { ...validCreateBody, evidenceFileId: 'file-1' } },
    {
      name: '说明含身份证号（敏感内容）',
      body: { ...validCreateBody, description: '证件 11010119900307721X' },
    },
    {
      name: '说明含疑似密钥（敏感内容）',
      body: { ...validCreateBody, description: 'api_key: sk-abcdef123456' },
    },
    {
      name: '说明含长数字标识（敏感内容）',
      body: { ...validCreateBody, description: '卡号 6222020200112233445' },
    },
    { name: '请求体是数组', body: ['not', 'an', 'object'] },
    { name: '请求体是空对象', body: {} },
  ];

  it.each(invalidCases)('$name → 400 且不落库', async ({ body }) => {
    const { baseUrl, repository } = await startAchievementsApp();

    const res = await call(baseUrl, 'POST', '/me/achievements', {
      headers: bearer(SESSION_STUDENT_1),
      body,
    });

    expect(res.status).toBe(400);
    expect(res.body.data).toBeNull();
    expect(res.body.error?.code).toBe('VALIDATION_FAILED');
    expect(res.body.error?.requestId).toBeTruthy();
    // 字段级错误（路径 + 消息）；不落库
    expect(issuesOf(res.body).length).toBeGreaterThan(0);
    await expect(repository.listByUserId('u-student-1')).resolves.toHaveLength(0);
  });

  it('客户端提交 userId/roles/scope/groupId/reviewStatus/id/时间戳 一律拒绝，且没有任何成果被写入', async () => {
    const { baseUrl, repository } = await startAchievementsApp();

    const injected: Record<string, unknown> = {
      ...validCreateBody,
      userId: 'u-victim-1',
      roles: [Role.SuperAdmin],
      scope: DataScope.Global,
      groupId: 'g-1',
      reviewStatus: ReviewStatus.Approved,
      id: randomUUID(),
      createdAt: '2026-01-01T00:00:00.000Z',
    };
    const unexpectedKeys = Object.keys(injected)
      .filter((key) => !(ACHIEVEMENT_INPUT_FIELDS as readonly string[]).includes(key))
      .sort();
    expect(unexpectedKeys).toEqual([
      'createdAt',
      'groupId',
      'id',
      'reviewStatus',
      'roles',
      'scope',
      'userId',
    ]);

    const res = await call(baseUrl, 'POST', '/me/achievements', {
      headers: bearer(SESSION_STUDENT_1),
      body: injected,
    });

    expect(res.status).toBe(400);
    expect(res.body.error?.code).toBe('VALIDATION_FAILED');
    const messages = issuesOf(res.body).map((issue) => issue.message);
    for (const key of unexpectedKeys) {
      expect(messages.some((message) => message.includes(key))).toBe(true);
    }
    await expect(repository.listByUserId('u-student-1')).resolves.toHaveLength(0);
    // 伪造的归属没有被采纳为「写入目标」
    await expect(repository.listByUserId('u-victim-1')).resolves.toHaveLength(0);
  });
});

describe('成果：认证边界 401（fail-closed）', () => {
  const unauthenticatedCases: ReadonlyArray<{ name: string; headers: Record<string, string> }> = [
    { name: '未携带 Authorization', headers: {} },
    { name: 'scheme 不是 Bearer', headers: { authorization: `Token ${SESSION_STUDENT_1}` } },
    { name: 'Bearer 凭证过短', headers: { authorization: 'Bearer short' } },
    { name: '会话不存在', headers: bearer('session-does-not-exist') },
    { name: '会话主体含未登记角色', headers: bearer(SESSION_UNKNOWN_ROLE) },
  ];

  it.each(unauthenticatedCases)('$name → 401 UNAUTHENTICATED', async ({ headers }) => {
    const { baseUrl } = await startAchievementsApp();

    const res = await call(baseUrl, 'GET', '/me/achievements', { headers });

    expect(res.status).toBe(401);
    expect(res.body.data).toBeNull();
    expect(res.body.error?.code).toBe('UNAUTHENTICATED');
    // 不区分失败原因，避免给探测者额外信息
    expect(res.body.error?.message).toBe('登录状态无效或已过期，请重新登录');
    expect(res.text).not.toContain(SESSION_UNKNOWN_ROLE);
    expect(res.text).not.toContain('guest');
  });

  it('未认证的写请求同样 401，且不产生成果', async () => {
    const { baseUrl, repository } = await startAchievementsApp();

    const res = await call(baseUrl, 'POST', '/me/achievements', { body: validCreateBody });

    expect(res.status).toBe(401);
    expect(res.body.error?.code).toBe('UNAUTHENTICATED');
    await expect(repository.listByUserId('u-student-1')).resolves.toHaveLength(0);
  });
});

describe('成果：越权 403（AuthorizationGuard + 服务端常量判定入参）', () => {
  it('角色缺少原子权限点：admin 读写成果均 403，且不产生成果', async () => {
    const { baseUrl, repository } = await startAchievementsApp();

    const read = await call(baseUrl, 'GET', '/me/achievements', {
      headers: bearer(SESSION_ADMIN_1),
    });
    expect(read.status).toBe(403);
    expect(read.body.data).toBeNull();
    expect(read.body.error?.code).toBe('FORBIDDEN');
    expect(read.body.error?.message).toBe('无权执行该操作');

    const write = await call(baseUrl, 'POST', '/me/achievements', {
      headers: bearer(SESSION_ADMIN_1),
      body: validCreateBody,
    });
    expect(write.status).toBe(403);
    expect(write.body.error?.code).toBe('FORBIDDEN');
    await expect(repository.listByUserId('u-admin-1')).resolves.toHaveLength(0);
    await expect(repository.listByUserId('u-student-1')).resolves.toHaveLength(0);
  });

  it('角色有权限点但范围不是 SELF：group_leader 读写成 403（不会退化成放行）', async () => {
    const { baseUrl, repository } = await startAchievementsApp();

    const read = await call(baseUrl, 'GET', '/me/achievements', {
      headers: bearer(SESSION_LEADER_1),
    });
    expect(read.status).toBe(403);
    expect(read.body.error?.code).toBe('FORBIDDEN');

    const write = await call(baseUrl, 'POST', '/me/achievements', {
      headers: bearer(SESSION_LEADER_1),
      body: validCreateBody,
    });
    expect(write.status).toBe(403);
    await expect(repository.listByUserId('u-leader-1')).resolves.toHaveLength(0);
  });

  it('授权先于仓储访问：403 时仓储的读写方法一次都不被调用', async () => {
    const { app, baseUrl, repository } = await startAchievementsApp();
    const listSpy = vi.spyOn(repository, 'listByUserId');
    const createSpy = vi.spyOn(repository, 'create');
    const findSpy = vi.spyOn(repository, 'findById');
    // 注意：仓储实例由 DI 提供，这里直接对同一实例打桩，只观察「是否被调用」
    expect(app.get(ACHIEVEMENT_REPOSITORY)).toBe(repository);

    const read = await call(baseUrl, 'GET', '/me/achievements', {
      headers: bearer(SESSION_ADMIN_1),
    });
    expect(read.status).toBe(403);

    const write = await call(baseUrl, 'POST', '/me/achievements', {
      headers: bearer(SESSION_ADMIN_1),
      body: validCreateBody,
    });
    expect(write.status).toBe(403);

    const detail = await call(baseUrl, 'GET', `/me/achievements/${randomUUID()}`, {
      headers: bearer(SESSION_ADMIN_1),
    });
    expect(detail.status).toBe(403);

    expect(listSpy).not.toHaveBeenCalled();
    expect(createSpy).not.toHaveBeenCalled();
    expect(findSpy).not.toHaveBeenCalled();
  });

  it('单条读取：非法 ID → 400（授权通过后才判形状，不进仓储）；admin → 403', async () => {
    const { baseUrl, repository } = await startAchievementsApp();
    const findSpy = vi.spyOn(repository, 'findById');

    const malformed = await call(baseUrl, 'GET', '/me/achievements/not-a-uuid', {
      headers: bearer(SESSION_STUDENT_1),
    });
    expect(malformed.status).toBe(400);
    expect(malformed.body.data).toBeNull();
    expect(malformed.body.error?.code).toBe('VALIDATION_FAILED');
    expect(findSpy).not.toHaveBeenCalled();

    const forbidden = await call(baseUrl, 'GET', `/me/achievements/${randomUUID()}`, {
      headers: bearer(SESSION_ADMIN_1),
    });
    expect(forbidden.status).toBe(403);
    expect(forbidden.body.error?.code).toBe('FORBIDDEN');
    // 越权先于输入校验与任何取数
    expect(findSpy).not.toHaveBeenCalled();
  });

  it('判定入参只来自服务端：单条读取用 achievement:self:read + SELF + 会话主体，与路径 ID 无关', async () => {
    const { app, baseUrl, repository } = await startAchievementsApp();
    const others = await repository.create(
      fixtureAchievement({ userId: 'u-student-2', title: '他人成果' }),
    );
    const adapter = app.get<RuoYiAuthzAdapter>(RUOYI_AUTHZ_ADAPTER);
    const checkAuthorization = vi.spyOn(adapter, 'checkAuthorization');

    const res = await call(baseUrl, 'GET', `/me/achievements/${others.id}?userId=u-victim-1`, {
      headers: {
        ...bearer(SESSION_STUDENT_1),
        'x-user-id': 'u-victim-1',
        'x-roles': Role.SuperAdmin,
        'x-scope': DataScope.Global,
        'x-group-id': 'g-1',
      },
    });

    expect(res.status).toBe(404);
    expect(checkAuthorization).toHaveBeenCalledWith(
      { userId: 'u-student-1', roles: [Role.Student] },
      {
        permission: PermissionPoint.AchievementSelfRead,
        scope: DataScope.Self,
        resourceUserId: 'u-student-1',
      },
    );
    expect(JSON.stringify(checkAuthorization.mock.calls)).not.toContain('u-victim-1');
    expect(res.text).not.toContain('u-victim-1');
    expect(res.text).not.toContain('他人成果');
  });

  it('判定入参只来自服务端：列表用 achievement:self:read + SELF + 会话主体', async () => {
    const { app, baseUrl } = await startAchievementsApp();
    const adapter = app.get<RuoYiAuthzAdapter>(RUOYI_AUTHZ_ADAPTER);
    const checkAuthorization = vi.spyOn(adapter, 'checkAuthorization');

    const res = await call(baseUrl, 'GET', '/me/achievements', {
      headers: bearer(SESSION_STUDENT_1),
    });

    expect(res.status).toBe(200);
    expect(checkAuthorization).toHaveBeenCalledTimes(1);
    expect(checkAuthorization).toHaveBeenCalledWith(
      { userId: 'u-student-1', roles: [Role.Student] },
      {
        permission: PermissionPoint.AchievementSelfRead,
        scope: DataScope.Self,
        resourceUserId: 'u-student-1',
      },
    );
  });

  it('判定入参只来自服务端：创建用 achievement:self:create + SELF + 会话主体，与请求体无关', async () => {
    const { app, baseUrl } = await startAchievementsApp();
    const adapter = app.get<RuoYiAuthzAdapter>(RUOYI_AUTHZ_ADAPTER);
    const checkAuthorization = vi.spyOn(adapter, 'checkAuthorization');

    const res = await call(baseUrl, 'POST', '/me/achievements', {
      headers: {
        ...bearer(SESSION_STUDENT_1),
        'x-user-id': 'u-victim-1',
        'x-roles': Role.SuperAdmin,
        'x-scope': DataScope.Global,
      },
      body: { ...validCreateBody, groupId: 'g-1' },
    });

    // 请求体含服务端独占字段 → 400，但判定已经发生，且入参来自服务端常量与会话主体
    expect(res.status).toBe(400);
    expect(checkAuthorization).toHaveBeenCalledTimes(1);
    expect(checkAuthorization).toHaveBeenCalledWith(
      { userId: 'u-student-1', roles: [Role.Student] },
      {
        permission: PermissionPoint.AchievementSelfCreate,
        scope: DataScope.Self,
        resourceUserId: 'u-student-1',
      },
    );
  });
});

describe('成果：未知枚举与存储异常 fail-closed（不得当正常输出）', () => {
  it('存储记录的 type 为未登记枚举 → 500，且不把未知值/字段取值泄露给调用方', async () => {
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const { baseUrl, repository } = await startAchievementsApp();
    const corrupted = await repository.create(
      fixtureAchievement({
        userId: 'u-student-1',
        type: 'unknown_type' as AchievementType,
        title: '受损成果标题',
      }),
    );

    const list = await call(baseUrl, 'GET', '/me/achievements', {
      headers: bearer(SESSION_STUDENT_1),
    });
    expect(list.status).toBe(500);
    expect(list.body.data).toBeNull();
    expect(list.body.error?.code).toBe('INTERNAL_ERROR');
    expect(list.text).not.toContain('unknown_type');
    expect(list.text).not.toContain('受损成果标题');
    expect(list.text).not.toContain(corrupted.id);
  });

  it('存储记录的 reviewStatus 未登记 → 500；时间戳非法 → 500', async () => {
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const { baseUrl, repository } = await startAchievementsApp();
    await repository.create(
      fixtureAchievement({ userId: 'u-student-1', reviewStatus: 'unknown_review' as ReviewStatus }),
    );
    await repository.create(
      fixtureAchievement({ userId: 'u-student-1', createdAt: '2026-01-01 00:00:00' }),
    );

    const res = await call(baseUrl, 'GET', '/me/achievements', {
      headers: bearer(SESSION_STUDENT_1),
    });

    expect(res.status).toBe(500);
    expect(res.body.error?.code).toBe('INTERNAL_ERROR');
    expect(res.text).not.toContain('unknown_review');
  });

  it('仓储返回他人归属 → 500，绝不把他人成果当作本人列表输出', async () => {
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const { baseUrl, repository } = await startAchievementsApp();
    vi.spyOn(repository, 'listByUserId').mockResolvedValue([
      fixtureAchievement({ userId: 'u-student-2', title: '他人成果' }),
    ]);

    const res = await call(baseUrl, 'GET', '/me/achievements', {
      headers: bearer(SESSION_STUDENT_1),
    });

    expect(res.status).toBe(500);
    expect(res.body.data).toBeNull();
    expect(res.body.error?.code).toBe('INTERNAL_ERROR');
    expect(res.text).not.toContain('他人成果');
    expect(res.text).not.toContain('u-student-2');
  });

  it('单条读取：仓储漏过滤归属（返回他人记录）→ 403 归属二次授权（纵深防御，不当作本人成果返回）', async () => {
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const { baseUrl, repository } = await startAchievementsApp();
    const others = fixtureAchievement({ userId: 'u-student-2', title: '他人成果' });
    vi.spyOn(repository, 'findById').mockResolvedValue(others);

    const res = await call(baseUrl, 'GET', `/me/achievements/${others.id}`, {
      headers: bearer(SESSION_STUDENT_1),
    });

    expect(res.status).toBe(403);
    expect(res.body.data).toBeNull();
    expect(res.body.error?.code).toBe('FORBIDDEN');
    expect(res.text).not.toContain('他人成果');
    expect(res.text).not.toContain('u-student-2');
  });

  it('单条读取：记录损坏（未知枚举）→ 500，且不泄露标题与归属', async () => {
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const { baseUrl, repository } = await startAchievementsApp();
    const corrupted = fixtureAchievement({
      userId: 'u-student-1',
      type: 'unknown_type' as AchievementType,
      title: '受损成果标题',
    });
    vi.spyOn(repository, 'findById').mockResolvedValue(corrupted);

    const res = await call(baseUrl, 'GET', `/me/achievements/${corrupted.id}`, {
      headers: bearer(SESSION_STUDENT_1),
    });

    expect(res.status).toBe(500);
    expect(res.body.data).toBeNull();
    expect(res.body.error?.code).toBe('INTERNAL_ERROR');
    expect(res.text).not.toContain('unknown_type');
    expect(res.text).not.toContain('受损成果标题');
    expect(res.text).not.toContain('u-student-1');
  });

  it('创建回写记录损坏（未知枚举）→ 500，且不泄露标题', async () => {
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const { baseUrl, repository } = await startAchievementsApp();
    vi.spyOn(repository, 'create').mockImplementation(async (record) => ({
      ...record,
      type: 'unknown_type' as AchievementType,
    }));

    const res = await call(baseUrl, 'POST', '/me/achievements', {
      headers: bearer(SESSION_STUDENT_1),
      body: validCreateBody,
    });

    expect(res.status).toBe(500);
    expect(res.body.data).toBeNull();
    expect(res.body.error?.code).toBe('INTERNAL_ERROR');
    expect(res.text).not.toContain('unknown_type');
    expect(res.text).not.toContain('第一作者论文');
  });
});

describe('成果：统一响应信封', () => {
  it('成功与失败的响应都严格是 { data, meta, error }，且互斥', async () => {
    const { baseUrl } = await startAchievementsApp();

    const success = await call(baseUrl, 'POST', '/me/achievements', {
      headers: bearer(SESSION_STUDENT_1),
      body: validCreateBody,
    });
    expect(Object.keys(success.body).sort()).toEqual(['data', 'error', 'meta']);
    expect(success.body.error).toBeNull();
    expect(success.body.data).not.toBeNull();

    const list = await call(baseUrl, 'GET', '/me/achievements', {
      headers: bearer(SESSION_STUDENT_1),
    });
    expect(Object.keys(list.body).sort()).toEqual(['data', 'error', 'meta']);
    expect(list.body.error).toBeNull();

    const failure = await call(baseUrl, 'POST', '/me/achievements', {
      headers: bearer(SESSION_STUDENT_1),
      body: { type: 'unknown_type' },
    });
    expect(Object.keys(failure.body).sort()).toEqual(['data', 'error', 'meta']);
    expect(failure.body.data).toBeNull();
    expect(failure.body.error).not.toBeNull();
    expect(failure.body.error?.requestId).toBeTruthy();
  });
});

describe('切片装配与既有路由回归', () => {
  it('AchievementsModule 只注册本切片的路由与服务，并通过工厂把仓储端口按配置分流', () => {
    const providers = (Reflect.getMetadata('providers', AchievementsModule) ?? []) as unknown[];
    const controllers = (Reflect.getMetadata('controllers', AchievementsModule) ?? []) as unknown[];
    const moduleImports = (Reflect.getMetadata('imports', AchievementsModule) ?? []) as unknown[];

    expect(controllers).toEqual([AchievementsController]);
    expect(providers).toContain(AchievementsService);
    // 换绑点是一个 factory provider（未配置数据库 → 内存基线；已配置 → PostgreSQL 实现），
    // 因此端口令牌与工厂函数都必须出现在 provider 列表里，而内存实现不再是独立 provider。
    expect(providers).toContainEqual(
      expect.objectContaining({
        provide: ACHIEVEMENT_REPOSITORY,
        inject: [expect.any(String), expect.objectContaining({ optional: true })],
      }),
    );
    expect(providers).not.toContain(InMemoryAchievementRepository);
    expect(typeof createAchievementRepository).toBe('function');
    expect(createAchievementRepository.length).toBe(2);
    // 依赖方向：认证（auth）与授权（access-control）各自只经端口/服务暴露
    expect(moduleImports).toContain(AuthModule);
    expect(moduleImports).toContain(AccessControlModule);
  });

  it('契约回归：创建接口字段闭集与共享 achievementInputSchema 的键集一致', () => {
    expect([...ACHIEVEMENT_INPUT_FIELDS].sort()).toEqual(
      Object.keys(achievementInputSchema.shape).sort(),
    );
  });

  it('内存基线如实声明非持久化，并在生产环境拒绝构造（不用内存冒充生产存储）', () => {
    const developmentEnv = loadEnv({});
    const productionEnv = loadEnv({ NODE_ENV: 'production' });

    expect(new InMemoryAchievementRepository(developmentEnv).capabilities).toEqual({
      backend: 'in-memory-baseline',
      persistent: false,
      productionReady: false,
    });
    expect(new InMemorySessionStore(developmentEnv).capabilities).toEqual({
      backend: 'in-memory-baseline',
      persistent: false,
      productionReady: false,
    });

    expect(() => new InMemoryAchievementRepository(productionEnv)).toThrow(
      /生产环境禁止使用内存成果仓储/u,
    );
    expect(() => new InMemorySessionStore(productionEnv)).toThrow(/生产环境禁止使用内存/u);
  });

  it('完整 AppModule：health / runtime-info / education / profile / applications 行为不变，成果默认 401', async () => {
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
    ]) {
      const res = await call(baseUrl, 'GET', path);
      expect(res.status).toBe(401);
      expect(res.body.error?.code).toBe('UNAUTHENTICATED');
    }
  });
});

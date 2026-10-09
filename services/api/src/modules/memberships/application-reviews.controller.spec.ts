import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { request } from 'node:http';
import { Module } from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import { APP_FILTER, APP_INTERCEPTOR, NestFactory } from '@nestjs/core';
import { ApplicationKind, ApplicationStatus, Role } from '@rm/shared';
import type { ApiEnvelope } from '@rm/shared';
import { afterAll, describe, expect, it } from 'vitest';
import { ApiExceptionFilter } from '../../common/api-exception.filter';
import { ApiResponseInterceptor } from '../../common/api-response.interceptor';
import { ConfigModule } from '../../config/config.module';
import { InMemorySessionStore } from '../auth/session-store.in-memory';
import { SESSION_STORE } from '../auth/session-subject.port';
import { ApplicationReviewsController } from './application-reviews.controller';
import { InMemoryApplicationReviewRepository } from './application-reviews.in-memory-repository';
import { APPLICATION_REVIEW_REPOSITORY } from './application-reviews.port';
import type { ApplicationReviewRepository } from './application-reviews.port';
import { ApplicationReviewsService } from './application-reviews.service';
import { ApplicationsController } from './applications.controller';
import { ApplicationsService } from './applications.service';
import {
  createApplicationRepository,
  createApplicationReviewRepository,
  MembershipsModule,
} from './memberships.module';
import type { Application } from './applications.port';

/**
 * 审核端切片的**真实 HTTP 回归**（与申请人端 `applications.controller.spec.ts` 同构）：
 *
 * - 认证 401：无凭证 / scheme 不对 / 会话不存在；
 * - 越权 403：学生（无审核权限）、普通管理员（无审核权限）、负责人访问**本组之外**的申请；
 * - 输入拒绝 400：客户端伪造 `status`/`reviewStatus`/`userId`/`roles`/`scope`/`groupId` 等
 *   服务端字段（留下可观测的拒绝记录且一律不落库），以及未知查询参数；
 * - 归属与范围：列表只返回**服务端范围**内的申请（负责人的他组申请不可见），
 *   单条审核对范围外申请返回 404（与「不存在」不可区分）；
 * - 状态：通过/驳回由服务端写状态机；已终态申请再审 → 409 `STATE_TRANSITION_INVALID`；
 * - 装配：模块同时注册两套控制器/服务/换绑工厂，且审核端令牌**独立**于申请人端。
 *
 * 只通过 DI 令牌注入测试夹具（会话、审核端内存基线的显式 `seed`），不替换任何生产代码路径。
 */

const SESSION_SUPER_ADMIN = 'session-super-admin';
const SESSION_LEADER_OPEN = 'session-leader-open';
const SESSION_LEADER_OTHER = 'session-leader-other';
const SESSION_STUDENT = 'session-student';
const SESSION_ADMIN = 'session-admin';

const GROUP_OPEN = '11111111-1111-4111-8111-111111111111';
const GROUP_OTHER = '22222222-2222-4222-8222-222222222222';

const startedApps: INestApplication[] = [];

@Module({
  imports: [ConfigModule, MembershipsModule],
  providers: [
    { provide: APP_INTERCEPTOR, useClass: ApiResponseInterceptor },
    { provide: APP_FILTER, useClass: ApiExceptionFilter },
  ],
})
class ReviewsHttpModule {}

interface TestApp {
  readonly app: INestApplication;
  readonly baseUrl: string;
  readonly store: InMemorySessionStore;
  readonly reviews: ApplicationReviewRepository & { seed(application: Application): void };
}

async function startReviewsApp(): Promise<TestApp> {
  const app = await NestFactory.create(ReviewsHttpModule, { logger: false });
  app.setGlobalPrefix('api/v1');
  await app.listen(0, '127.0.0.1');
  startedApps.push(app);

  const store = app.get<InMemorySessionStore>(SESSION_STORE);
  // 全局审核者：持有 membership:review:global + GLOBAL
  store.seed({
    sessionId: SESSION_SUPER_ADMIN,
    subject: { userId: 'u-super-1', roles: [Role.SuperAdmin] },
  });
  // 小组负责人：只持有 membership:review:group + GROUP，且只在 GROUP_OPEN 内
  store.seed({
    sessionId: SESSION_LEADER_OPEN,
    subject: { userId: 'u-leader-open', roles: [Role.GroupLeader], groupIds: [GROUP_OPEN] },
  });
  store.seed({
    sessionId: SESSION_LEADER_OTHER,
    subject: { userId: 'u-leader-other', roles: [Role.GroupLeader], groupIds: [GROUP_OTHER] },
  });
  // 无审核权限：学生与普通管理员
  store.seed({
    sessionId: SESSION_STUDENT,
    subject: { userId: 'u-student-1', roles: [Role.Student] },
  });
  store.seed({ sessionId: SESSION_ADMIN, subject: { userId: 'u-admin-1', roles: [Role.Admin] } });

  return {
    app,
    baseUrl: `${await app.getUrl()}/api/v1`,
    store,
    reviews: app.get(APPLICATION_REVIEW_REPOSITORY) as TestApp['reviews'],
  };
}

interface HttpResult {
  status: number;
  text: string;
  body: ApiEnvelope<unknown>;
}

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
    req.end();
  });
}

function bearer(sessionId: string): Record<string, string> {
  return { authorization: `Bearer ${sessionId}` };
}

/** 存储记录夹具：id/groupId 走 UUID（读取契约要求），userId 保持会话基线的安全 ID 形状 */
function reviewRecord(overrides: Partial<Application> = {}): Application {
  const now = '2026-05-01T00:00:00.000Z';
  return {
    id: randomUUID(),
    userId: 'u-student-1',
    groupId: GROUP_OPEN,
    kind: ApplicationKind.Join,
    note: '夹具备注',
    status: ApplicationStatus.Pending,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

afterAll(async () => {
  await Promise.all(startedApps.map((app) => app.close()));
});

describe('审核端 HTTP：认证与授权边界', () => {
  it('无凭证 / scheme 不对 / 会话不存在 → 401', async () => {
    const { baseUrl } = await startReviewsApp();

    for (const path of ['/admin/applications', '/admin/applications/' + randomUUID() + '/review']) {
      const anonymous = await call(baseUrl, path.endsWith('review') ? 'POST' : 'GET', path, {
        body: path.endsWith('review') ? { decision: 'approve' } : undefined,
      });
      expect(anonymous.status).toBe(401);
      expect(anonymous.body.error?.code).toBe('UNAUTHENTICATED');
    }

    const badScheme = await call(baseUrl, 'GET', '/admin/applications', {
      headers: { authorization: 'Basic abc' },
    });
    expect(badScheme.status).toBe(401);

    const unknownSession = await call(baseUrl, 'GET', '/admin/applications', {
      headers: bearer('session-does-not-exist'),
    });
    expect(unknownSession.status).toBe(401);
  });

  it('学生与普通管理员（都无审核权限）→ 403', async () => {
    const { baseUrl } = await startReviewsApp();

    for (const session of [SESSION_STUDENT, SESSION_ADMIN]) {
      const list = await call(baseUrl, 'GET', '/admin/applications', { headers: bearer(session) });
      expect(list.status).toBe(403);
      expect(list.body.error?.code).toBe('FORBIDDEN');
    }
  });

  it('授权先于校验：无权限主体提交非法请求体也只得 403', async () => {
    const { baseUrl } = await startReviewsApp();

    const res = await call(baseUrl, 'POST', `/admin/applications/${randomUUID()}/review`, {
      headers: bearer(SESSION_STUDENT),
      body: { decision: 'nonsense', status: ApplicationStatus.Approved },
    });
    expect(res.status).toBe(403);
  });
});

describe('审核端 HTTP：列表按服务端范围隔离', () => {
  it('负责人只看到本组申请；全局审核者看到全部', async () => {
    const { baseUrl, reviews } = await startReviewsApp();
    const inOpen = reviewRecord({ groupId: GROUP_OPEN, userId: 'u-student-open' });
    const inOther = reviewRecord({ groupId: GROUP_OTHER, userId: 'u-student-other' });
    reviews.seed(inOpen);
    reviews.seed(inOther);

    const leader = await call(baseUrl, 'GET', '/admin/applications', {
      headers: bearer(SESSION_LEADER_OPEN),
    });
    expect(leader.status).toBe(200);
    const leaderIds = (leader.body.data as { id: string }[]).map((row) => row.id);
    expect(leaderIds).toContain(inOpen.id);
    expect(leaderIds).not.toContain(inOther.id);

    const global = await call(baseUrl, 'GET', '/admin/applications', {
      headers: bearer(SESSION_SUPER_ADMIN),
    });
    expect(global.status).toBe(200);
    const globalIds = (global.body.data as { id: string }[]).map((row) => row.id);
    expect(globalIds).toContain(inOpen.id);
    expect(globalIds).toContain(inOther.id);
  });

  it('客户端 groupId 缩小范围：本组内可查，他组 → 403', async () => {
    const { baseUrl, reviews } = await startReviewsApp();
    const inOpen = reviewRecord({ groupId: GROUP_OPEN });
    reviews.seed(inOpen);

    const allowed = await call(baseUrl, 'GET', `/admin/applications?groupId=${GROUP_OPEN}`, {
      headers: bearer(SESSION_LEADER_OPEN),
    });
    expect(allowed.status).toBe(200);

    const denied = await call(baseUrl, 'GET', `/admin/applications?groupId=${GROUP_OTHER}`, {
      headers: bearer(SESSION_LEADER_OPEN),
    });
    expect(denied.status).toBe(403);
  });

  it('未声明的查询参数 → 400', async () => {
    const { baseUrl } = await startReviewsApp();

    const res = await call(baseUrl, 'GET', '/admin/applications?status=pending', {
      headers: bearer(SESSION_LEADER_OPEN),
    });
    expect(res.status).toBe(400);
    expect(res.body.error?.code).toBe('VALIDATION_FAILED');
  });
});

describe('审核端 HTTP：审核动作', () => {
  it('通过：200、统一信封、状态 approved、审核人由服务端写入', async () => {
    const { baseUrl, reviews } = await startReviewsApp();
    const record = reviewRecord({ groupId: GROUP_OPEN });
    reviews.seed(record);

    const res = await call(baseUrl, 'POST', `/admin/applications/${record.id}/review`, {
      headers: bearer(SESSION_LEADER_OPEN),
      body: { decision: 'approve' },
    });

    expect(res.status).toBe(200);
    expect(Object.keys(res.body).sort()).toEqual(['data', 'error', 'meta']);
    expect(res.body.error).toBeNull();
    const data = res.body.data as Record<string, unknown>;
    expect(data.status).toBe(ApplicationStatus.Approved);
    expect(data.reviewedByUserId).toBe('u-leader-open');
    expect(data.applicantUserId).toBe('u-student-1');
    expect(data.groupId).toBe(GROUP_OPEN);
  });

  it('驳回必须带审核意见：缺失 → 400；带上 → 200 且写入意见', async () => {
    const { baseUrl, reviews } = await startReviewsApp();
    const record = reviewRecord({ groupId: GROUP_OPEN });
    reviews.seed(record);

    const missing = await call(baseUrl, 'POST', `/admin/applications/${record.id}/review`, {
      headers: bearer(SESSION_LEADER_OPEN),
      body: { decision: 'reject' },
    });
    expect(missing.status).toBe(400);
    expect(missing.body.error?.code).toBe('VALIDATION_FAILED');
    expect(missing.body.error?.details).toBeTruthy();

    const ok = await call(baseUrl, 'POST', `/admin/applications/${record.id}/review`, {
      headers: bearer(SESSION_LEADER_OPEN),
      body: { decision: 'reject', comment: '材料不完整' },
    });
    expect(ok.status).toBe(200);
    const data = ok.body.data as Record<string, unknown>;
    expect(data.status).toBe(ApplicationStatus.Rejected);
    expect(data.reviewComment).toBe('材料不完整');
  });

  it('客户端伪造服务端字段 → 400 且不改变存储状态', async () => {
    const { baseUrl, reviews } = await startReviewsApp();
    const record = reviewRecord({ groupId: GROUP_OPEN });
    reviews.seed(record);

    const forged = await call(baseUrl, 'POST', `/admin/applications/${record.id}/review`, {
      headers: bearer(SESSION_LEADER_OPEN),
      body: {
        decision: 'approve',
        status: ApplicationStatus.Approved,
        reviewStatus: 'approved',
        userId: 'u-attacker',
        roles: [Role.SuperAdmin],
        scope: 'GLOBAL',
        groupId: GROUP_OTHER,
      },
    });
    expect(forged.status).toBe(400);

    const reread = await call(baseUrl, 'GET', `/admin/applications?groupId=${GROUP_OPEN}`, {
      headers: bearer(SESSION_LEADER_OPEN),
    });
    const row = (reread.body.data as { id: string; status: string }[]).find(
      (item) => item.id === record.id,
    );
    expect(row?.status).toBe(ApplicationStatus.Pending);
  });

  it('范围外的申请 → 404（与「不存在」不可区分）', async () => {
    const { baseUrl, reviews } = await startReviewsApp();
    const other = reviewRecord({ groupId: GROUP_OTHER });
    reviews.seed(other);

    const res = await call(baseUrl, 'POST', `/admin/applications/${other.id}/review`, {
      headers: bearer(SESSION_LEADER_OPEN),
      body: { decision: 'approve' },
    });
    expect(res.status).toBe(404);
  });

  it('已终态申请再审 → 409 STATE_TRANSITION_INVALID', async () => {
    const { baseUrl, reviews } = await startReviewsApp();
    const record = reviewRecord({ groupId: GROUP_OPEN, status: ApplicationStatus.Approved });
    reviews.seed(record);

    const res = await call(baseUrl, 'POST', `/admin/applications/${record.id}/review`, {
      headers: bearer(SESSION_LEADER_OPEN),
      body: { decision: 'approve' },
    });
    expect(res.status).toBe(409);
    expect(res.body.error?.code).toBe('STATE_TRANSITION_INVALID');
  });

  it('路径参数非 UUID → 400，且不落库', async () => {
    const { baseUrl } = await startReviewsApp();

    const res = await call(baseUrl, 'POST', '/admin/applications/not-a-uuid/review', {
      headers: bearer(SESSION_LEADER_OPEN),
      body: { decision: 'approve' },
    });
    expect(res.status).toBe(400);
    expect(res.body.error?.code).toBe('VALIDATION_FAILED');
  });
});

describe('审核端装配', () => {
  it('MembershipsModule 同时注册两套控制器/服务/换绑工厂，审核端令牌独立', () => {
    const providers = (Reflect.getMetadata('providers', MembershipsModule) ?? []) as unknown[];
    const controllers = (Reflect.getMetadata('controllers', MembershipsModule) ?? []) as unknown[];

    expect(controllers).toEqual([ApplicationsController, ApplicationReviewsController]);
    expect(providers).toContain(ApplicationsService);
    expect(providers).toContain(ApplicationReviewsService);
    // 审核端有自己的换绑 factory provider（令牌与申请人端不同）
    expect(providers).toContainEqual(
      expect.objectContaining({
        provide: APPLICATION_REVIEW_REPOSITORY,
        inject: [expect.any(String), expect.objectContaining({ optional: true })],
      }),
    );
    expect(typeof createApplicationReviewRepository).toBe('function');
    expect(createApplicationReviewRepository.length).toBe(2);
    // 申请人端的换绑点未被改动
    expect(typeof createApplicationRepository).toBe('function');
    expect(providers).not.toContain(InMemoryApplicationReviewRepository);
  });

  it('未配置数据库：审核端端口上是内存基线（如实声明非持久）', async () => {
    const { app } = await startReviewsApp();
    const onPort = app.get<ApplicationReviewRepository>(APPLICATION_REVIEW_REPOSITORY);

    expect(onPort).toBeInstanceOf(InMemoryApplicationReviewRepository);
    expect(onPort.capabilities).toEqual({
      backend: 'in-memory-baseline',
      persistent: false,
      productionReady: false,
    });
  });

  it('既有申请人路由不受影响：/me/applications 仍然需要会话', async () => {
    const { baseUrl } = await startReviewsApp();

    const anonymous = await call(baseUrl, 'GET', '/me/applications');
    expect(anonymous.status).toBe(401);

    const student = await call(baseUrl, 'GET', '/me/applications', {
      headers: bearer(SESSION_STUDENT),
    });
    expect(student.status).toBe(200);
  });
});

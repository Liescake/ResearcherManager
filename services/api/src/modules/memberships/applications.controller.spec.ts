import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { request } from 'node:http';
import { ForbiddenException, Logger, Module } from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import { APP_FILTER, APP_INTERCEPTOR, NestFactory } from '@nestjs/core';
import {
  APPLICATION_STATUS_TRANSITIONS,
  APPLICATION_STATUS_VALUES,
  ApplicationKind,
  ApplicationStatus,
  DataScope,
  PermissionPoint,
  Role,
  isApplicationTerminal,
  joinApplicationInputSchema,
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
import type { RuoYiAuthzAdapter } from '../ruoyi-adapter/ruoyi-adapter.port';
import { RUOYI_AUTHZ_ADAPTER } from '../ruoyi-adapter/ruoyi-adapter.port';
import {
  APPLICATION_INITIAL_STATUS,
  APPLICATION_INPUT_FIELDS,
  APPLICATION_SLICE_KIND,
} from './applications.contract';
import { ApplicationsController } from './applications.controller';
import { ApplicationReviewsController } from './application-reviews.controller';
import { APPLICATION_REVIEW_REPOSITORY } from './application-reviews.port';
import { ApplicationReviewsService } from './application-reviews.service';
import { AuthorizationGuard } from '../access-control/authorization-guard';
import { InMemoryApplicationRepository } from './applications.in-memory-repository';
import type { Application, ApplicationRepository } from './applications.port';
import { APPLICATION_REPOSITORY } from './applications.port';
import { ApplicationsService } from './applications.service';
import { createApplicationRepository, MembershipsModule } from './memberships.module';

/**
 * 入组申请切片（`/me/applications`）的真实 HTTP 回归：
 *
 * - 成功：本人创建（201）/ 本人列表（200）/ 本人撤回（200）；归属、类型、初始状态由服务端决定，
 *   响应不含 `userId` 与审核人/审核意见/审核时间；
 * - 输入拒绝 400：未知/缺失/非 UUID 小组、备注越界与控制字符、请求体非对象、未声明字段，
 *   以及**客户端伪造服务端字段**（`status`/`reviewStatus`/`userId`/`roles`/`scope`/`dataScope`/
 *   `groupIds`/`kind`/`decision`…）——伪造项留下可观测的拒绝记录，且一律不落库；
 * - 认证 401：无凭证、scheme 不对、凭证过短、会话不存在、会话主体含未登记角色（fail-closed）；
 * - 越权 403：角色缺该原子权限点（管理员）、跨主体撤回；并断言判定入参只来自**服务端**
 *   （会话主体 + 存储归属 + 常量范围），客户端字段无法影响；
 * - 状态不可由客户端越权：创建恒为 `pending`；撤回只允许 `pending -> withdrawn`，
 *   已终态申请撤回 → 409 `STATE_TRANSITION_INVALID`；同组未终态申请重复提交 → 409 CONFLICT；
 * - fail-closed 500：存储层出现未登记状态枚举/非法时间戳时不得作为正常输出返回，也不泄露取值；
 * - 既有路由回归：同一 `AppModule` 下 health / runtime-info / education / profiles 行为不变，
 *   且默认装配不预置任何会话（新路由默认 401）。
 *
 * 说明：测试用真实 Nest 应用 + 真实 HTTP（与 `education-records.controller.spec.ts` 同构），
 * 只通过 DI 令牌/端口注入测试夹具（会话、仓储记录），不替换任何生产代码路径。
 */

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

const SESSION_STUDENT_1 = 'session-student-1';
const SESSION_STUDENT_2 = 'session-student-2';
const SESSION_LEADER_1 = 'session-leader-1';
const SESSION_ADMIN_1 = 'session-admin-1';
const SESSION_UNKNOWN_ROLE = 'session-unknown-role';

const GROUP_OPEN = '11111111-1111-4111-8111-111111111111';
const GROUP_OTHER = '22222222-2222-4222-8222-222222222222';

/** 合法请求体：目标小组 + 备注；归属、类型、状态、时间戳均由服务端补齐 */
const validCreateBody = { groupId: GROUP_OPEN, note: '希望加入本组做推荐系统方向' };

const startedApps: INestApplication[] = [];

@Module({
  imports: [ConfigModule, MembershipsModule],
  providers: [
    { provide: APP_INTERCEPTOR, useClass: ApiResponseInterceptor },
    { provide: APP_FILTER, useClass: ApiExceptionFilter },
  ],
})
class ApplicationsHttpModule {}

interface TestApp {
  readonly app: INestApplication;
  readonly baseUrl: string;
  readonly store: InMemorySessionStore;
  readonly repository: ApplicationRepositoryFixture;
}

/**
 * 测试夹具（**只服务于本 spec 的调用点**，不是生产代码）：仓储端口现在是异步 + 归属感知的，
 * 夹具把两件事固定下来，断言仍然打在真实端口实例（`APPLICATION_REPOSITORY` 令牌上的实现）上：
 * 1. 写入与取数都必须 `await`（未配置数据库时端口上是内存基线，语义与 PostgreSQL 实现一致）；
 * 2. `findById` 默认按夹具归属主体取数（生产路径必须显式给服务端主体，见 `applications.service.ts`）。
 */
interface ApplicationRepositoryFixture {
  readonly port: ApplicationRepository;
  create(application: Application): Promise<Application>;
  findById(applicationId: string, ownerUserId?: string): Promise<Application | undefined>;
  listByUserId(userId: string): Promise<readonly Application[]>;
}

function fixtureOf(port: ApplicationRepository): ApplicationRepositoryFixture {
  return {
    port,
    create: (application) => port.create(application),
    findById: (applicationId, ownerUserId = 'u-student-1') =>
      port.findById(applicationId, ownerUserId),
    listByUserId: (userId) => port.listByUserId(userId),
  };
}

/** 启动真实应用并注入会话夹具（内存基线的显式 seed，不做隐式全局状态） */
async function startApplicationsApp(): Promise<TestApp> {
  const app = await NestFactory.create(ApplicationsHttpModule, { logger: false });
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
  // 负责人：持有 membership:review:group 与 GROUP 范围，但**没有** membership:self:* 能力
  store.seed({
    sessionId: SESSION_LEADER_1,
    subject: { userId: 'u-leader-1', roles: [Role.GroupLeader], groupIds: [GROUP_OPEN] },
  });
  store.seed({ sessionId: SESSION_ADMIN_1, subject: { userId: 'u-admin-1', roles: [Role.Admin] } });
  // 会话存储里出现未登记角色：主体不可信，必须在认证边界整体拒绝
  store.seed({
    sessionId: SESSION_UNKNOWN_ROLE,
    subject: { userId: 'u-unknown-1', roles: ['guest' as Role] },
  });

  return {
    app,
    baseUrl: `${await app.getUrl()}/api/v1`,
    store,
    repository: fixtureOf(app.get<ApplicationRepository>(APPLICATION_REPOSITORY)),
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
    req.end();
  });
}

function bearer(sessionId: string): Record<string, string> {
  return { authorization: `Bearer ${sessionId}` };
}

/** 测试夹具记录：归属主体由调用方指定，模拟「存储里已存在他人/已终态申请」 */
function fixtureApplication(overrides: Partial<Application> = {}): Application {
  const now = new Date().toISOString();
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

describe('入组申请：成功路径（真实 HTTP + 统一响应信封）', () => {
  it('本人创建：201、error 为 null、返回读取视图（不含 userId）、归属与初始状态由服务端写入', async () => {
    const { app, baseUrl, repository } = await startApplicationsApp();
    const adapter = app.get<RuoYiAuthzAdapter>(RUOYI_AUTHZ_ADAPTER);
    const checkAuthorization = vi.spyOn(adapter, 'checkAuthorization');

    const res = await call(baseUrl, 'POST', '/me/applications', {
      headers: { ...bearer(SESSION_STUDENT_1), 'x-request-id': 'test-request-app-1' },
      body: validCreateBody,
    });

    expect(res.status).toBe(201);
    expect(res.body.error).toBeNull();
    expect(res.body.meta.requestId).toBe('test-request-app-1');

    const data = res.body.data as Record<string, unknown>;
    // 响应字段闭集：没有 userId，也没有任何客户端可回传的归属/审核字段
    expect(Object.keys(data).sort()).toEqual([
      'createdAt',
      'groupId',
      'id',
      'kind',
      'note',
      'status',
      'updatedAt',
    ]);
    expect(UUID_V4.test(String(data.id))).toBe(true);
    expect(data).toMatchObject({
      groupId: GROUP_OPEN,
      kind: ApplicationKind.Join,
      note: '希望加入本组做推荐系统方向',
      // 客户端不能自授权审核态：新建申请一律待审核
      status: ApplicationStatus.Pending,
    });

    const stored = await repository.listByUserId('u-student-1');
    expect(stored).toHaveLength(1);
    expect(stored[0]?.userId).toBe('u-student-1');
    expect(stored[0]?.id).toBe(data.id);
    expect(stored[0]?.status).toBe(ApplicationStatus.Pending);
    expect(stored[0]?.kind).toBe(APPLICATION_SLICE_KIND);

    // 授权确实经适配器端口，且入参是服务端常量 + 会话主体（客户端字段无法影响）
    expect(checkAuthorization).toHaveBeenCalledWith(
      { userId: 'u-student-1', roles: [Role.Student] },
      {
        permission: PermissionPoint.MembershipSelfCreate,
        scope: DataScope.Self,
        resourceUserId: 'u-student-1',
      },
    );
  });

  it('本人列表：只返回本人申请、按创建顺序、且不泄露他人记录与审核内部字段', async () => {
    const { baseUrl, repository } = await startApplicationsApp();
    const mine = await repository.create(
      fixtureApplication({
        userId: 'u-student-1',
        note: '本人备注明文',
        // 审核字段只允许存在于存储与读取契约中，绝不出现在任何响应里
        reviewedByUserId: 'u-admin-9',
        reviewComment: '内部审核意见明文',
        reviewedAt: '2026-01-02T00:00:00.000Z',
        status: ApplicationStatus.Rejected,
      }),
    );
    const secondMine = await repository.create(
      fixtureApplication({ userId: 'u-student-1', groupId: GROUP_OTHER }),
    );
    const others = await repository.create(
      fixtureApplication({ userId: 'u-student-2', note: '他人备注明文' }),
    );

    const res = await call(baseUrl, 'GET', '/me/applications', {
      headers: bearer(SESSION_STUDENT_1),
    });

    expect(res.status).toBe(200);
    expect(res.body.error).toBeNull();
    const items = res.body.data as Array<Record<string, unknown>>;
    expect(items).toHaveLength(2);
    // 创建顺序稳定，便于后续分页实现
    expect(items.map((item) => item.id)).toEqual([mine.id, secondMine.id]);
    expect(Object.keys(items[0] ?? {}).sort()).toEqual([
      'createdAt',
      'groupId',
      'id',
      'kind',
      'note',
      'status',
      'updatedAt',
    ]);
    expect(res.text).not.toContain('他人备注明文');
    expect(res.text).not.toContain(others.id);
    expect(res.text).not.toContain('u-student-1');
    expect(res.text).not.toContain('u-admin-9');
    expect(res.text).not.toContain('内部审核意见明文');
  });

  it('本人撤回：200、状态推进为 withdrawn、更新时间由服务端刷新；再次撤回 409 不再变更状态', async () => {
    const { app, baseUrl, repository } = await startApplicationsApp();
    const created = await repository.create(fixtureApplication({ userId: 'u-student-1' }));
    const adapter = app.get<RuoYiAuthzAdapter>(RUOYI_AUTHZ_ADAPTER);
    const checkAuthorization = vi.spyOn(adapter, 'checkAuthorization');

    const res = await call(baseUrl, 'POST', `/me/applications/${created.id}/withdraw`, {
      headers: bearer(SESSION_STUDENT_1),
    });

    expect(res.status).toBe(200);
    expect(res.body.error).toBeNull();
    const data = res.body.data as Record<string, unknown>;
    expect(data.id).toBe(created.id);
    expect(data.status).toBe(ApplicationStatus.Withdrawn);
    expect(data.updatedAt).not.toBe(created.updatedAt);
    expect((await repository.findById(created.id))?.status).toBe(ApplicationStatus.Withdrawn);

    // 两次 SELF 判定：第一次以会话主体（先于存储访问），第二次以存储归属（纵深防御）
    expect(checkAuthorization).toHaveBeenNthCalledWith(
      1,
      { userId: 'u-student-1', roles: [Role.Student] },
      {
        permission: PermissionPoint.MembershipSelfWithdraw,
        scope: DataScope.Self,
        resourceUserId: 'u-student-1',
      },
    );
    expect(checkAuthorization).toHaveBeenNthCalledWith(
      2,
      { userId: 'u-student-1', roles: [Role.Student] },
      {
        permission: PermissionPoint.MembershipSelfWithdraw,
        scope: DataScope.Self,
        resourceUserId: 'u-student-1',
      },
    );

    const again = await call(baseUrl, 'POST', `/me/applications/${created.id}/withdraw`, {
      headers: bearer(SESSION_STUDENT_1),
    });
    expect(again.status).toBe(409);
    expect(again.body.error?.code).toBe('STATE_TRANSITION_INVALID');
    expect((await repository.findById(created.id))?.status).toBe(ApplicationStatus.Withdrawn);
  });

  it('同一小组未终态申请重复提交：409 CONFLICT，且只落库一条', async () => {
    const { baseUrl, repository } = await startApplicationsApp();

    const first = await call(baseUrl, 'POST', '/me/applications', {
      headers: bearer(SESSION_STUDENT_1),
      body: validCreateBody,
    });
    expect(first.status).toBe(201);

    const duplicated = await call(baseUrl, 'POST', '/me/applications', {
      headers: bearer(SESSION_STUDENT_1),
      body: validCreateBody,
    });

    expect(duplicated.status).toBe(409);
    expect(duplicated.body.data).toBeNull();
    expect(duplicated.body.error?.code).toBe('CONFLICT');
    expect(await repository.listByUserId('u-student-1')).toHaveLength(1);
    // 错误响应不回显既有申请的 ID
    expect(duplicated.text).not.toContain(String((first.body.data as { id: string }).id));
  });

  it('终态申请不占用「未终态唯一」约束：撤回后可以再次提交同组申请', async () => {
    const { baseUrl, repository } = await startApplicationsApp();
    const withdrawn = await repository.create(
      fixtureApplication({ userId: 'u-student-1', status: ApplicationStatus.Withdrawn }),
    );

    const res = await call(baseUrl, 'POST', '/me/applications', {
      headers: bearer(SESSION_STUDENT_1),
      body: validCreateBody,
    });

    expect(res.status).toBe(201);
    expect(await repository.listByUserId('u-student-1')).toHaveLength(2);
    expect((await repository.findById(withdrawn.id))?.status).toBe(ApplicationStatus.Withdrawn);
  });
});

describe('入组申请：输入拒绝（400 VALIDATION_FAILED，不落库）', () => {
  const invalidCases: ReadonlyArray<{ name: string; body: unknown }> = [
    { name: '缺少 groupId', body: { note: '希望加入' } },
    { name: 'groupId 不是 UUID', body: { groupId: 'group-1', note: '希望加入' } },
    { name: 'groupId 类型错误', body: { groupId: 12345, note: '希望加入' } },
    { name: 'note 超出长度上限', body: { groupId: GROUP_OPEN, note: 'x'.repeat(1001) } },
    {
      name: 'note 含控制字符',
      body: { groupId: GROUP_OPEN, note: '希望加入\u0007本组' },
    },
    { name: '未知枚举 kind=leave', body: { ...validCreateBody, kind: 'leave_x' } },
    { name: '请求体是数组', body: ['not', 'an', 'object'] },
    { name: '请求体是空对象', body: {} },
  ];

  it.each(invalidCases)('$name → 400 且不落库', async ({ body }) => {
    const { baseUrl, repository } = await startApplicationsApp();

    const res = await call(baseUrl, 'POST', '/me/applications', {
      headers: bearer(SESSION_STUDENT_1),
      body,
    });

    expect(res.status).toBe(400);
    expect(res.body.data).toBeNull();
    expect(res.body.error?.code).toBe('VALIDATION_FAILED');
    expect(res.body.error?.requestId).toBeTruthy();
    expect(issuesOf(res.body).length).toBeGreaterThan(0);
    expect(await repository.listByUserId('u-student-1')).toHaveLength(0);
  });

  it('客户端伪造审核状态/归属/角色/范围/组声明一律 400，且没有任何记录被写入', async () => {
    const { baseUrl, repository } = await startApplicationsApp();

    const injected: Record<string, unknown> = {
      ...validCreateBody,
      status: ApplicationStatus.Approved,
      reviewStatus: 'approved',
      decision: 'approve',
      userId: 'u-victim-1',
      applicantId: 'u-victim-1',
      ownerUserId: 'u-victim-1',
      roles: [Role.SuperAdmin],
      role: Role.SuperAdmin,
      scope: DataScope.Global,
      dataScope: DataScope.Global,
      groupIds: [GROUP_OTHER],
      permissions: [PermissionPoint.MembershipReviewGlobal],
      kind: ApplicationKind.Leave,
      reviewedByUserId: 'u-victim-1',
      reviewedAt: '2026-01-02T00:00:00.000Z',
      createdAt: '2026-01-01T00:00:00.000Z',
    };
    const unexpectedKeys = Object.keys(injected)
      .filter((key) => !(APPLICATION_INPUT_FIELDS as readonly string[]).includes(key))
      .sort();
    expect(unexpectedKeys).toEqual([
      'applicantId',
      'createdAt',
      'dataScope',
      'decision',
      'groupIds',
      'kind',
      'ownerUserId',
      'permissions',
      'reviewStatus',
      'reviewedAt',
      'reviewedByUserId',
      'role',
      'roles',
      'scope',
      'status',
      'userId',
    ]);

    const res = await call(baseUrl, 'POST', '/me/applications', {
      headers: bearer(SESSION_STUDENT_1),
      body: injected,
    });

    expect(res.status).toBe(400);
    expect(res.body.error?.code).toBe('VALIDATION_FAILED');
    const messages = issuesOf(res.body).map((issue) => issue.message);
    for (const key of unexpectedKeys) {
      expect(messages.some((message) => message.includes(key))).toBe(true);
    }
    expect(await repository.listByUserId('u-student-1')).toHaveLength(0);
    // 伪造的归属没有被采纳为「写入目标」
    expect(await repository.listByUserId('u-victim-1')).toHaveLength(0);
  });

  it('撤回：非法申请 ID → 400；请求体带字段（含 status 声明）→ 400，且状态不变', async () => {
    const { baseUrl, repository } = await startApplicationsApp();
    const created = await repository.create(fixtureApplication({ userId: 'u-student-1' }));

    const malformed = await call(baseUrl, 'POST', '/me/applications/not-a-uuid/withdraw', {
      headers: bearer(SESSION_STUDENT_1),
    });
    expect(malformed.status).toBe(400);
    expect(malformed.body.error?.code).toBe('VALIDATION_FAILED');

    const withBody = await call(baseUrl, 'POST', `/me/applications/${created.id}/withdraw`, {
      headers: bearer(SESSION_STUDENT_1),
      body: { status: ApplicationStatus.Withdrawn, decision: 'approve' },
    });
    expect(withBody.status).toBe(400);
    expect(withBody.body.error?.code).toBe('VALIDATION_FAILED');
    const messages = issuesOf(withBody.body).map((issue) => issue.message);
    expect(messages.some((message) => message.includes('status'))).toBe(true);
    expect(messages.some((message) => message.includes('decision'))).toBe(true);
    expect((await repository.findById(created.id))?.status).toBe(ApplicationStatus.Pending);
  });
});

describe('入组申请：认证边界 401（fail-closed）', () => {
  const unauthenticatedCases: ReadonlyArray<{ name: string; headers: Record<string, string> }> = [
    { name: '未携带 Authorization', headers: {} },
    { name: 'scheme 不是 Bearer', headers: { authorization: `Token ${SESSION_STUDENT_1}` } },
    { name: 'Bearer 凭证过短', headers: { authorization: 'Bearer short' } },
    { name: '会话不存在', headers: bearer('session-does-not-exist') },
    { name: '会话主体含未登记角色', headers: bearer(SESSION_UNKNOWN_ROLE) },
  ];

  it.each(unauthenticatedCases)('$name → 401 UNAUTHENTICATED', async ({ headers }) => {
    const { baseUrl } = await startApplicationsApp();

    const list = await call(baseUrl, 'GET', '/me/applications', { headers });
    expect(list.status).toBe(401);
    expect(list.body.data).toBeNull();
    expect(list.body.error?.code).toBe('UNAUTHENTICATED');
    // 不区分失败原因，避免给探测者额外信息
    expect(list.body.error?.message).toBe('登录状态无效或已过期，请重新登录');
    expect(list.text).not.toContain(SESSION_UNKNOWN_ROLE);
    expect(list.text).not.toContain('guest');

    const withdraw = await call(baseUrl, 'POST', `/me/applications/${randomUUID()}/withdraw`, {
      headers,
    });
    expect(withdraw.status).toBe(401);
    expect(withdraw.body.error?.code).toBe('UNAUTHENTICATED');
  });

  it('未认证的写请求（创建/撤回）同样 401，且不产生记录、不变更既有状态', async () => {
    const { baseUrl, repository } = await startApplicationsApp();
    const created = await repository.create(fixtureApplication({ userId: 'u-student-1' }));

    const create = await call(baseUrl, 'POST', '/me/applications', { body: validCreateBody });
    expect(create.status).toBe(401);
    expect(create.body.error?.code).toBe('UNAUTHENTICATED');
    expect(await repository.listByUserId('u-student-1')).toHaveLength(1);

    const withdraw = await call(baseUrl, 'POST', `/me/applications/${created.id}/withdraw`);
    expect(withdraw.status).toBe(401);
    expect((await repository.findById(created.id))?.status).toBe(ApplicationStatus.Pending);
  });
});

describe('入组申请：越权 403（AuthorizationGuard + 服务端资源判定）', () => {
  it('缺少原子权限点的角色（小组负责人/管理员）读写均 403，且不产生记录', async () => {
    const { baseUrl, repository } = await startApplicationsApp();

    for (const session of [SESSION_LEADER_1, SESSION_ADMIN_1]) {
      const read = await call(baseUrl, 'GET', '/me/applications', {
        headers: bearer(session),
      });
      expect(read.status).toBe(403);
      expect(read.body.data).toBeNull();
      expect(read.body.error?.code).toBe('FORBIDDEN');
      expect(read.body.error?.message).toBe('无权执行该操作');

      const write = await call(baseUrl, 'POST', '/me/applications', {
        headers: bearer(session),
        body: validCreateBody,
      });
      expect(write.status).toBe(403);
      expect(write.body.error?.code).toBe('FORBIDDEN');
    }

    expect(await repository.listByUserId('u-leader-1')).toHaveLength(0);
    expect(await repository.listByUserId('u-admin-1')).toHaveLength(0);
  });

  it('授权先于业务校验：无权限主体的非法请求体也只得到 403（不泄露字段级反馈）', async () => {
    const { baseUrl } = await startApplicationsApp();

    const res = await call(baseUrl, 'POST', '/me/applications', {
      headers: bearer(SESSION_ADMIN_1),
      body: { status: ApplicationStatus.Approved, roles: [Role.SuperAdmin] },
    });

    expect(res.status).toBe(403);
    expect(res.body.error?.code).toBe('FORBIDDEN');
    expect(res.text).not.toContain('VALIDATION_FAILED');
    expect(res.text).not.toContain('status');
  });

  it('跨主体撤回：404（归属下推进仓储谓词，他人记录不出库，与「不存在」不可区分），且不泄露内容', async () => {
    const { app, baseUrl, repository } = await startApplicationsApp();
    const others = await repository.create(
      fixtureApplication({ userId: 'u-student-1', note: '他人申请备注明文' }),
    );
    const adapter = app.get<RuoYiAuthzAdapter>(RUOYI_AUTHZ_ADAPTER);
    const checkAuthorization = vi.spyOn(adapter, 'checkAuthorization');

    const res = await call(baseUrl, 'POST', `/me/applications/${others.id}/withdraw`, {
      headers: bearer(SESSION_STUDENT_2),
    });

    expect(res.status).toBe(404);
    expect(res.body.data).toBeNull();
    expect(res.body.error?.code).toBe('NOT_FOUND');
    // 与「不存在」完全同一文案：申请人无法据此判断该 ID 是否属于他人
    expect(res.body.error?.message).toBe('目标申请不存在或不可见');
    expect(res.text).not.toContain('他人申请备注明文');
    expect(res.text).not.toContain(others.id);
    expect((await repository.findById(others.id))?.status).toBe(ApplicationStatus.Pending);

    // 只有**一次** SELF 判定（以会话主体，先于仓库访问）：归属已在仓库谓词里生效，
    // 服务端不会「先取他人记录、再指望上层复核」——第二次判定只在仓储违约时才触发（见下一组用例）
    expect(checkAuthorization).toHaveBeenCalledTimes(1);
    expect(checkAuthorization).toHaveBeenNthCalledWith(
      1,
      { userId: 'u-student-2', roles: [Role.Student] },
      {
        permission: PermissionPoint.MembershipSelfWithdraw,
        scope: DataScope.Self,
        resourceUserId: 'u-student-2',
      },
    );
  });

  it('不存在的申请 404（与授权拒绝 403 区分开）', async () => {
    const { baseUrl } = await startApplicationsApp();

    const missing = await call(baseUrl, 'POST', `/me/applications/${randomUUID()}/withdraw`, {
      headers: bearer(SESSION_STUDENT_1),
    });

    expect(missing.status).toBe(404);
    expect(missing.body.error?.code).toBe('NOT_FOUND');
  });

  it('管理员撤回他人申请：403（先授权，再判存在性）', async () => {
    const { baseUrl, repository } = await startApplicationsApp();
    const created = await repository.create(fixtureApplication({ userId: 'u-student-1' }));

    const res = await call(baseUrl, 'POST', `/me/applications/${created.id}/withdraw`, {
      headers: bearer(SESSION_ADMIN_1),
    });

    expect(res.status).toBe(403);
    expect(res.body.error?.code).toBe('FORBIDDEN');
    expect((await repository.findById(created.id))?.status).toBe(ApplicationStatus.Pending);
  });
});

/**
 * 纵深防御回归（**故意违约的仓储替身**）：端口契约要求「归属下推进取数」，但 service 不能只依赖
 * 「仓储一定守约」——取到记录后必须再按**存储给出的归属**做一次 SELF 判定。这里只替换仓储，
 * 授权判定仍走真实的 `AuthorizationGuard` + 真实适配器，因此该分支的入参来源是可机器核对的。
 */
describe('入组申请：仓储违约时的纵深防御（403，不回流他人记录）', () => {
  it('仓储返回他人归属的记录：第二次 SELF 判定以**存储归属**为入参并拒绝，403 且不泄露内容', async () => {
    const { app } = await startApplicationsApp();
    const adapter = app.get<RuoYiAuthzAdapter>(RUOYI_AUTHZ_ADAPTER);
    const checkAuthorization = vi.spyOn(adapter, 'checkAuthorization');

    const foreign = fixtureApplication({ userId: 'u-victim-9', note: '他人记录备注明文' });
    const broken: ApplicationRepository = {
      capabilities: { backend: 'broken-test-double', persistent: false, productionReady: false },
      create: async (application) => application,
      // 违约：不按归属过滤，只按资源 ID 返回（内存基线与 PostgreSQL adapter 都不允许）
      findById: async () => ({ ...foreign }),
      listByUserId: async () => [],
      listByUserAndGroup: async () => [],
      save: async (application) => application,
    };
    const service = new ApplicationsService(new AuthorizationGuard(adapter), broken);

    let captured: unknown;
    try {
      await service.withdrawMyApplication(
        { userId: 'u-student-1', roles: [Role.Student] },
        foreign.id,
        undefined,
      );
    } catch (error) {
      captured = error;
    }

    expect(captured).toBeInstanceOf(ForbiddenException);
    expect((captured as ForbiddenException).getStatus()).toBe(403);
    expect((captured as Error).message).not.toContain('他人记录备注明文');
    expect((captured as Error).message).not.toContain('u-victim-9');

    // 两次判定都在端口上：第一次以会话主体（先于仓储访问），第二次以存储归属（纵深防御）
    expect(checkAuthorization).toHaveBeenCalledTimes(2);
    expect(checkAuthorization).toHaveBeenNthCalledWith(
      1,
      { userId: 'u-student-1', roles: [Role.Student] },
      {
        permission: PermissionPoint.MembershipSelfWithdraw,
        scope: DataScope.Self,
        resourceUserId: 'u-student-1',
      },
    );
    expect(checkAuthorization).toHaveBeenNthCalledWith(
      2,
      { userId: 'u-student-1', roles: [Role.Student] },
      {
        permission: PermissionPoint.MembershipSelfWithdraw,
        scope: DataScope.Self,
        resourceUserId: 'u-victim-9',
      },
    );
  });
});

describe('入组申请：状态只能由服务端状态机推进', () => {
  it.each([
    { label: '已撤回', status: ApplicationStatus.Withdrawn },
    { label: '已通过', status: ApplicationStatus.Approved },
    { label: '已完成', status: ApplicationStatus.Completed },
  ])('$label 的申请再撤回 → 409 STATE_TRANSITION_INVALID，状态不变', async ({ status }) => {
    const { baseUrl, repository } = await startApplicationsApp();
    const created = await repository.create(fixtureApplication({ userId: 'u-student-1', status }));

    const res = await call(baseUrl, 'POST', `/me/applications/${created.id}/withdraw`, {
      headers: bearer(SESSION_STUDENT_1),
    });

    expect(res.status).toBe(409);
    expect(res.body.data).toBeNull();
    expect(res.body.error?.code).toBe('STATE_TRANSITION_INVALID');
    expect((await repository.findById(created.id))?.status).toBe(status);
  });

  it('契约回归：pending 是状态机中唯一的初始状态，创建只能落在 pending', async () => {
    // 「没有任何转移指向」的状态即为入口状态：客户端无法把申请推进到入口状态之外
    const targets = new Set(Object.values(APPLICATION_STATUS_TRANSITIONS).flat());
    const initialStatuses = APPLICATION_STATUS_VALUES.filter((status) => !targets.has(status));

    expect(initialStatuses).toEqual([ApplicationStatus.Pending]);
    expect(APPLICATION_INITIAL_STATUS).toBe(ApplicationStatus.Pending);
    expect(isApplicationTerminal(APPLICATION_INITIAL_STATUS)).toBe(false);
    expect(APPLICATION_STATUS_TRANSITIONS[ApplicationStatus.Pending]).toContain(
      ApplicationStatus.Withdrawn,
    );
  });

  it('契约回归：创建接口字段闭集与共享 joinApplicationInputSchema 的键集一致', () => {
    expect([...APPLICATION_INPUT_FIELDS].sort()).toEqual(
      Object.keys(joinApplicationInputSchema.shape).sort(),
    );
  });
});

describe('入组申请：未知枚举 fail-closed（存储层异常不得当正常输出）', () => {
  it('存储记录的 status 为未登记枚举 → 列表/撤回 500，且不把未知值/字段取值泄露给调用方', async () => {
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const { baseUrl, repository } = await startApplicationsApp();
    const corrupted = await repository.create(
      fixtureApplication({
        userId: 'u-student-1',
        status: 'unknown_status' as ApplicationStatus,
        note: '受损记录备注',
      }),
    );

    const list = await call(baseUrl, 'GET', '/me/applications', {
      headers: bearer(SESSION_STUDENT_1),
    });
    expect(list.status).toBe(500);
    expect(list.body.data).toBeNull();
    expect(list.body.error?.code).toBe('INTERNAL_ERROR');
    expect(list.text).not.toContain('unknown_status');
    expect(list.text).not.toContain('受损记录备注');

    const withdraw = await call(baseUrl, 'POST', `/me/applications/${corrupted.id}/withdraw`, {
      headers: bearer(SESSION_STUDENT_1),
    });
    expect(withdraw.status).toBe(500);
    expect(withdraw.body.error?.code).toBe('INTERNAL_ERROR');
    expect(withdraw.text).not.toContain('unknown_status');
  });

  it('存储记录时间戳非法 / 类型未登记 → 500（读取契约包含时间格式与枚举闭集）', async () => {
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const { baseUrl, repository } = await startApplicationsApp();
    await repository.create(
      fixtureApplication({ userId: 'u-student-1', createdAt: '2026-01-01 00:00:00' }),
    );
    await repository.create(
      fixtureApplication({ userId: 'u-student-1', kind: 'leave_x' as ApplicationKind }),
    );

    const res = await call(baseUrl, 'GET', '/me/applications', {
      headers: bearer(SESSION_STUDENT_1),
    });

    expect(res.status).toBe(500);
    expect(res.body.error?.code).toBe('INTERNAL_ERROR');
    expect(res.text).not.toContain('2026-01-01 00:00:00');
    expect(res.text).not.toContain('leave_x');
  });
});

describe('统一响应信封', () => {
  it('成功与失败的响应都严格是 { data, meta, error }，且互斥', async () => {
    const { baseUrl } = await startApplicationsApp();

    const success = await call(baseUrl, 'POST', '/me/applications', {
      headers: bearer(SESSION_STUDENT_1),
      body: validCreateBody,
    });
    expect(Object.keys(success.body).sort()).toEqual(['data', 'error', 'meta']);
    expect(success.body.error).toBeNull();
    expect(success.body.data).not.toBeNull();

    const failure = await call(baseUrl, 'POST', '/me/applications', {
      headers: bearer(SESSION_STUDENT_1),
      body: { groupId: 'not-a-uuid' },
    });
    expect(Object.keys(failure.body).sort()).toEqual(['data', 'error', 'meta']);
    expect(failure.body.data).toBeNull();
    expect(failure.body.error).not.toBeNull();
    expect(failure.body.error?.requestId).toBeTruthy();
  });
});

describe('切片装配与既有路由回归', () => {
  it('MembershipsModule 只注册本切片的控制器与服务，并通过工厂把仓储端口按配置分流', () => {
    const providers = (Reflect.getMetadata('providers', MembershipsModule) ?? []) as unknown[];
    const controllers = (Reflect.getMetadata('controllers', MembershipsModule) ?? []) as unknown[];
    const moduleImports = (Reflect.getMetadata('imports', MembershipsModule) ?? []) as unknown[];

    expect(controllers).toEqual([ApplicationsController, ApplicationReviewsController]);
    expect(providers).toContain(ApplicationsService);
    // 审核端是**同一模块内的独立授权切片**：有自己的服务与**自己的换绑工厂**，
    // 不复用申请人端端口（SELF 归属谓词 vs GROUP/GLOBAL 范围谓词）。
    expect(providers).toContain(ApplicationReviewsService);
    // 换绑点是一个 factory provider（未配置数据库 → 内存基线；已配置 → PostgreSQL 实现），
    // 因此端口令牌与「可选注入执行器工厂」都必须出现在 provider 列表里；
    // 内存实现**不再**是独立 provider（否则生产环境实例化时它自身就会抛错，且会出现两份状态）。
    expect(providers).toContainEqual(
      expect.objectContaining({
        provide: APPLICATION_REPOSITORY,
        inject: [expect.any(String), expect.objectContaining({ optional: true })],
      }),
    );
    expect(providers).not.toContain(InMemoryApplicationRepository);
    expect(typeof createApplicationRepository).toBe('function');
    expect(createApplicationRepository.length).toBe(2);
    // 审核端的换绑工厂同样是 factory provider（独立令牌，独立注入执行器工厂）
    expect(providers).toContainEqual(
      expect.objectContaining({
        provide: APPLICATION_REVIEW_REPOSITORY,
        inject: [expect.any(String), expect.objectContaining({ optional: true })],
      }),
    );
    // 依赖方向：认证（auth）与授权（access-control）各自只经端口/服务暴露
    expect(moduleImports).toContain(AuthModule);
    expect(moduleImports).toContain(AccessControlModule);
  });

  it('未配置数据库：端口上就是内存基线（同一实例，可显式 seed）', async () => {
    const { app } = await startApplicationsApp();

    const onPort = app.get<ApplicationRepository>(APPLICATION_REPOSITORY);
    expect(onPort).toBeInstanceOf(InMemoryApplicationRepository);
    expect(onPort.capabilities).toEqual({
      backend: 'in-memory-baseline',
      persistent: false,
      productionReady: false,
    });
  });

  it('内存基线如实声明非持久化，并在生产环境拒绝构造（不用内存冒充生产存储）', () => {
    const developmentEnv = loadEnv({});
    const productionEnv = loadEnv({ NODE_ENV: 'production' });

    expect(new InMemoryApplicationRepository(developmentEnv).capabilities).toEqual({
      backend: 'in-memory-baseline',
      persistent: false,
      productionReady: false,
    });
    expect(new InMemorySessionStore(developmentEnv).capabilities).toEqual({
      backend: 'in-memory-baseline',
      persistent: false,
      productionReady: false,
    });

    expect(() => new InMemoryApplicationRepository(productionEnv)).toThrow(
      /生产环境禁止使用内存入组申请仓储/u,
    );
    expect(() => new InMemorySessionStore(productionEnv)).toThrow(/生产环境禁止使用内存/u);
  });

  it('完整 AppModule：health / runtime-info / education / profiles 行为不变，入组申请默认 401', async () => {
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
    for (const path of ['/me/education-records', '/me/profile']) {
      const res = await call(baseUrl, 'GET', path);
      expect(res.status).toBe(401);
      expect(res.body.error?.code).toBe('UNAUTHENTICATED');
    }

    const applications = await call(baseUrl, 'GET', '/me/applications');
    expect(applications.status).toBe(401);
    expect(applications.body.error?.code).toBe('UNAUTHENTICATED');
  });
});

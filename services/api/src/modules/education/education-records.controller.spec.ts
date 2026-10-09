import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { request } from 'node:http';
import { Logger, Module } from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import { APP_FILTER, APP_INTERCEPTOR, NestFactory } from '@nestjs/core';
import {
  DataScope,
  EducationStatus,
  EducationType,
  PermissionPoint,
  ReviewStatus,
  Role,
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
import { EDUCATION_RECORD_INPUT_FIELDS } from './education-records.contract';
import { EducationRecordsController } from './education-records.controller';
import { InMemoryEducationRecordRepository } from './education-records.in-memory-repository';
import type { EducationRecord } from './education-records.port';
import { EDUCATION_RECORD_REPOSITORY } from './education-records.port';
import { EducationRecordsService } from './education-records.service';
import { EducationModule, createEducationRecordRepository } from './education.module';

/**
 * 升学记录切片（`/me/education-records`）的真实 HTTP 回归：
 *
 * - 成功：本人创建/列表/单条；归属与审核态由服务端决定，响应不含 `userId`；
 * - 输入拒绝 400：未知枚举、越界年份、已录取缺院校、控制字符、未声明字段（roles/scope/groupId/…）；
 * - 认证 401：无凭证、scheme 不对、会话不存在、会话主体含未登记角色（fail-closed）；
 * - 越权 403：角色无该权限点；**他人记录统一 404**（归属下推到取数，「不存在」与「不是你的」
 *   不可区分，因此资源存在性不可探测）；
 * - fail-closed 500：存储层出现未登记枚举/非法时间戳时不得作为正常输出返回，也不得泄露字段取值；
 * - 既有路由不变：同一 `AppModule` 下 health / runtime-info 行为不变，且默认装配不预置任何会话。
 *
 * 说明：测试用真实 Nest 应用 + 真实 HTTP（与 `health.controller.spec.ts` 同构），
 * 只通过 DI 令牌/端口注入测试夹具（会话、仓储记录），不替换任何生产代码路径。
 */

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

const SESSION_STUDENT_1 = 'session-student-1';
const SESSION_STUDENT_2 = 'session-student-2';
const SESSION_ADMIN_1 = 'session-admin-1';
const SESSION_UNKNOWN_ROLE = 'session-unknown-role';

/** 合法请求体：已录取 + 院校；归属、审核态、时间戳均由服务端补齐 */
const validCreateBody = {
  year: 2026,
  type: EducationType.Postgraduate,
  status: EducationStatus.Admitted,
  institutionOrDestination: '示例大学',
};

const startedApps: INestApplication[] = [];

@Module({
  imports: [ConfigModule, EducationModule],
  providers: [
    { provide: APP_INTERCEPTOR, useClass: ApiResponseInterceptor },
    { provide: APP_FILTER, useClass: ApiExceptionFilter },
  ],
})
class EducationHttpModule {}

interface TestApp {
  readonly app: INestApplication;
  readonly baseUrl: string;
  readonly store: InMemorySessionStore;
  readonly repository: InMemoryEducationRecordRepository;
}

/** 启动真实应用并注入会话夹具（内存基线的显式 seed，不做隐式全局状态） */
async function startEducationApp(): Promise<TestApp> {
  const app = await NestFactory.create(EducationHttpModule, { logger: false });
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
  // 会话存储里出现未登记角色：主体不可信，必须在认证边界整体拒绝
  store.seed({
    sessionId: SESSION_UNKNOWN_ROLE,
    subject: { userId: 'u-unknown-1', roles: ['guest' as Role] },
  });

  return {
    app,
    baseUrl: `${await app.getUrl()}/api/v1`,
    store,
    repository: app.get<InMemoryEducationRecordRepository>(EDUCATION_RECORD_REPOSITORY),
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

/** 测试夹具记录：归属主体由调用方指定，模拟「存储里已存在他人记录」 */
function fixtureRecord(overrides: Partial<EducationRecord> = {}): EducationRecord {
  const now = '2026-01-01T00:00:00.000Z';
  return {
    id: randomUUID(),
    userId: 'u-student-1',
    year: 2026,
    type: EducationType.Postgraduate,
    status: EducationStatus.Admitted,
    institutionOrDestination: '示例大学',
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

describe('升学记录：成功路径（真实 HTTP + 统一响应信封）', () => {
  it('本人创建：201、error 为 null、返回读取视图（不含 userId）、归属由服务端写入', async () => {
    const { baseUrl, repository } = await startEducationApp();

    const res = await call(baseUrl, 'POST', '/me/education-records', {
      headers: { ...bearer(SESSION_STUDENT_1), 'x-request-id': 'test-request-1' },
      body: validCreateBody,
    });

    expect(res.status).toBe(201);
    expect(res.body.error).toBeNull();
    expect(res.body.meta.requestId).toBe('test-request-1');

    const data = res.body.data as Record<string, unknown>;
    // 响应字段闭集：没有 userId，也没有任何客户端可回传的归属字段
    expect(Object.keys(data).sort()).toEqual([
      'createdAt',
      'id',
      'institutionOrDestination',
      'reviewStatus',
      'status',
      'type',
      'updatedAt',
      'year',
    ]);
    expect(UUID_V4.test(String(data.id))).toBe(true);
    expect(data).toMatchObject({
      year: 2026,
      type: EducationType.Postgraduate,
      status: EducationStatus.Admitted,
      institutionOrDestination: '示例大学',
      // 学生不能自授权审核态：新建记录一律待审核
      reviewStatus: ReviewStatus.Pending,
    });

    const stored = await repository.listByUserId('u-student-1');
    expect(stored).toHaveLength(1);
    expect(stored[0]?.userId).toBe('u-student-1');
    expect(stored[0]?.id).toBe(data.id);
  });

  it('本人列表与单条读取：只返回本人记录，且不泄露他人记录内容', async () => {
    const { baseUrl, repository } = await startEducationApp();
    const mine = await repository.create(fixtureRecord({ userId: 'u-student-1' }));
    const others = await repository.create(
      fixtureRecord({ userId: 'u-student-2', institutionOrDestination: '他人大学' }),
    );

    const list = await call(baseUrl, 'GET', '/me/education-records', {
      headers: bearer(SESSION_STUDENT_1),
    });
    expect(list.status).toBe(200);
    expect(list.body.error).toBeNull();
    const items = list.body.data as Array<Record<string, unknown>>;
    expect(items).toHaveLength(1);
    expect(items[0]?.id).toBe(mine.id);
    expect(list.text).not.toContain('他人大学');
    expect(list.text).not.toContain(others.id);

    const detail = await call(baseUrl, 'GET', `/me/education-records/${mine.id}`, {
      headers: bearer(SESSION_STUDENT_1),
    });
    expect(detail.status).toBe(200);
    expect((detail.body.data as Record<string, unknown>).id).toBe(mine.id);
  });
});

describe('升学记录：输入拒绝（400 VALIDATION_FAILED，不落库）', () => {
  const invalidCases: ReadonlyArray<{ name: string; body: unknown }> = [
    { name: '未知 status 枚举', body: { ...validCreateBody, status: 'unknown_status' } },
    { name: '未知 type 枚举', body: { ...validCreateBody, type: 'postgraduate_x' } },
    { name: '年份越界', body: { ...validCreateBody, year: 1999 } },
    { name: '年份类型错误', body: { ...validCreateBody, year: '2026' } },
    {
      name: '已录取但缺院校/去向',
      body: {
        year: validCreateBody.year,
        type: validCreateBody.type,
        status: EducationStatus.Admitted,
      },
    },
    {
      name: '院校含控制字符',
      body: { ...validCreateBody, institutionOrDestination: '示例\u0007大学' },
    },
    { name: '缺少年份', body: { type: validCreateBody.type, status: validCreateBody.status } },
    { name: '请求体是数组', body: ['not', 'an', 'object'] },
    { name: '请求体是空对象', body: {} },
  ];

  it.each(invalidCases)('$name → 400 且不落库', async ({ body }) => {
    const { baseUrl, repository } = await startEducationApp();

    const res = await call(baseUrl, 'POST', '/me/education-records', {
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

  it('客户端提交 roles/scope/groupId/userId/reviewStatus 一律拒绝，且没有任何记录被写入', async () => {
    const { baseUrl, repository } = await startEducationApp();

    const injected: Record<string, unknown> = {
      ...validCreateBody,
      roles: [Role.SuperAdmin],
      scope: DataScope.Global,
      groupId: 'g-1',
      userId: 'u-victim-1',
      reviewStatus: ReviewStatus.Approved,
    };
    const unexpectedKeys = Object.keys(injected)
      .filter((key) => !(EDUCATION_RECORD_INPUT_FIELDS as readonly string[]).includes(key))
      .sort();
    expect(unexpectedKeys).toEqual(['groupId', 'reviewStatus', 'roles', 'scope', 'userId']);

    const res = await call(baseUrl, 'POST', '/me/education-records', {
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

describe('升学记录：认证边界 401（fail-closed）', () => {
  const unauthenticatedCases: ReadonlyArray<{ name: string; headers: Record<string, string> }> = [
    { name: '未携带 Authorization', headers: {} },
    { name: 'scheme 不是 Bearer', headers: { authorization: `Token ${SESSION_STUDENT_1}` } },
    { name: 'Bearer 凭证过短', headers: { authorization: 'Bearer short' } },
    { name: '会话不存在', headers: bearer('session-does-not-exist') },
    { name: '会话主体含未登记角色', headers: bearer(SESSION_UNKNOWN_ROLE) },
  ];

  it.each(unauthenticatedCases)('$name → 401 UNAUTHENTICATED', async ({ headers }) => {
    const { baseUrl } = await startEducationApp();

    const res = await call(baseUrl, 'GET', '/me/education-records', { headers });

    expect(res.status).toBe(401);
    expect(res.body.data).toBeNull();
    expect(res.body.error?.code).toBe('UNAUTHENTICATED');
    // 不区分失败原因，避免给探测者额外信息
    expect(res.body.error?.message).toBe('登录状态无效或已过期，请重新登录');
    expect(res.text).not.toContain(SESSION_UNKNOWN_ROLE);
    expect(res.text).not.toContain('guest');
  });

  it('未认证的写请求同样 401，且不产生记录', async () => {
    const { baseUrl, repository } = await startEducationApp();

    const res = await call(baseUrl, 'POST', '/me/education-records', { body: validCreateBody });

    expect(res.status).toBe(401);
    expect(res.body.error?.code).toBe('UNAUTHENTICATED');
    await expect(repository.listByUserId('u-student-1')).resolves.toHaveLength(0);
  });
});

describe('升学记录：越权与归属隔离（AuthorizationGuard + 服务端资源判定）', () => {
  it('读取他人记录：404（归属下推到取数），不区分「不存在」，也不泄露内容或归属', async () => {
    const { app, baseUrl, repository } = await startEducationApp();
    const others = await repository.create(
      fixtureRecord({ userId: 'u-student-2', institutionOrDestination: '他人大学' }),
    );
    const adapter = app.get<RuoYiAuthzAdapter>(RUOYI_AUTHZ_ADAPTER);
    const checkAuthorization = vi.spyOn(adapter, 'checkAuthorization');

    const res = await call(baseUrl, 'GET', `/me/education-records/${others.id}`, {
      headers: bearer(SESSION_STUDENT_1),
    });

    // 「记录不存在」与「记录存在但不属于该主体」在仓储层不可区分 ⇒ 统一 404：
    // 他人资源的存在性因此不可探测（此前同步实现用 403/404 的差别泄露了存在性）
    expect(res.status).toBe(404);
    expect(res.body.data).toBeNull();
    expect(res.body.error?.code).toBe('NOT_FOUND');
    expect(res.text).not.toContain('u-student-2');
    expect(res.text).not.toContain('他人大学');

    // 判定入参是**服务端会话主体**（不是请求体，也不是存储归属）：客户端无法影响它。
    expect(checkAuthorization).toHaveBeenCalledWith(
      { userId: 'u-student-1', roles: [Role.Student] },
      {
        permission: PermissionPoint.EducationSelfRead,
        scope: DataScope.Self,
        resourceUserId: 'u-student-1',
      },
    );
  });

  it('归属判定是服务端解析值：请求体里的 userId 不会成为判定入参', async () => {
    const { app, baseUrl } = await startEducationApp();
    const adapter = app.get<RuoYiAuthzAdapter>(RUOYI_AUTHZ_ADAPTER);
    const checkAuthorization = vi.spyOn(adapter, 'checkAuthorization');

    // 带伪造归属的单条读取：路径 ID 由请求给出，归属入参仍然只能是会话主体
    const res = await call(
      baseUrl,
      'GET',
      `/me/education-records/${randomUUID()}?userId=u-victim-1`,
      {
        headers: bearer(SESSION_STUDENT_1),
      },
    );

    expect(res.status).toBe(404);
    expect(checkAuthorization).toHaveBeenCalledWith(
      { userId: 'u-student-1', roles: [Role.Student] },
      expect.objectContaining({ resourceUserId: 'u-student-1' }),
    );
    expect(JSON.stringify(checkAuthorization.mock.calls)).not.toContain('u-victim-1');
  });

  it('角色缺少原子权限点：admin 读写升学记录均 403，且不产生记录', async () => {
    const { baseUrl, repository } = await startEducationApp();

    const read = await call(baseUrl, 'GET', '/me/education-records', {
      headers: bearer(SESSION_ADMIN_1),
    });
    expect(read.status).toBe(403);
    expect(read.body.error?.code).toBe('FORBIDDEN');

    const write = await call(baseUrl, 'POST', '/me/education-records', {
      headers: bearer(SESSION_ADMIN_1),
      body: validCreateBody,
    });
    expect(write.status).toBe(403);
    expect(write.body.error?.code).toBe('FORBIDDEN');
    expect(write.body.error?.message).toBe('无权执行该操作');
    await expect(repository.listByUserId('u-admin-1')).resolves.toHaveLength(0);
  });

  it('创建请求的判定入参是服务端主体自己，而不是任何客户端字段', async () => {
    const { app, baseUrl } = await startEducationApp();
    const adapter = app.get<RuoYiAuthzAdapter>(RUOYI_AUTHZ_ADAPTER);
    const checkAuthorization = vi.spyOn(adapter, 'checkAuthorization');

    const res = await call(baseUrl, 'POST', '/me/education-records', {
      headers: bearer(SESSION_STUDENT_1),
      body: validCreateBody,
    });

    expect(res.status).toBe(201);
    expect(checkAuthorization).toHaveBeenCalledWith(
      { userId: 'u-student-1', roles: [Role.Student] },
      {
        permission: PermissionPoint.EducationSelfCreate,
        scope: DataScope.Self,
        resourceUserId: 'u-student-1',
      },
    );
  });

  it('不存在的记录 404、非法 ID 400（ID 形状先判，非法 ID 不进仓储）', async () => {
    const { baseUrl } = await startEducationApp();

    const missing = await call(baseUrl, 'GET', `/me/education-records/${randomUUID()}`, {
      headers: bearer(SESSION_STUDENT_1),
    });
    expect(missing.status).toBe(404);
    expect(missing.body.error?.code).toBe('NOT_FOUND');

    const malformed = await call(baseUrl, 'GET', '/me/education-records/not-a-uuid', {
      headers: bearer(SESSION_STUDENT_1),
    });
    expect(malformed.status).toBe(400);
    expect(malformed.body.error?.code).toBe('VALIDATION_FAILED');
  });
});

describe('升学记录：未知枚举 fail-closed（存储层异常不得当正常输出）', () => {
  it('存储记录的 status 为未登记枚举 → 500，且不把未知值/字段取值泄露给调用方', async () => {
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const { baseUrl, repository } = await startEducationApp();
    const corrupted = await repository.create(
      fixtureRecord({
        userId: 'u-student-1',
        status: 'unknown_status' as EducationStatus,
        institutionOrDestination: '受损记录大学',
      }),
    );

    const list = await call(baseUrl, 'GET', '/me/education-records', {
      headers: bearer(SESSION_STUDENT_1),
    });
    expect(list.status).toBe(500);
    expect(list.body.data).toBeNull();
    expect(list.body.error?.code).toBe('INTERNAL_ERROR');
    expect(list.text).not.toContain('unknown_status');
    expect(list.text).not.toContain('受损记录大学');
    expect(list.text).not.toContain(corrupted.id);

    const detail = await call(baseUrl, 'GET', `/me/education-records/${corrupted.id}`, {
      headers: bearer(SESSION_STUDENT_1),
    });
    expect(detail.status).toBe(500);
    expect(detail.body.error?.code).toBe('INTERNAL_ERROR');
    expect(detail.text).not.toContain('unknown_status');
  });

  it('存储记录时间戳非法 → 500（读取契约包含时间格式）', async () => {
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const { baseUrl, repository } = await startEducationApp();
    await repository.create(
      fixtureRecord({ userId: 'u-student-1', createdAt: '2026-01-01 00:00:00' }),
    );

    const res = await call(baseUrl, 'GET', '/me/education-records', {
      headers: bearer(SESSION_STUDENT_1),
    });

    expect(res.status).toBe(500);
    expect(res.body.error?.code).toBe('INTERNAL_ERROR');
  });
});

describe('切片装配与既有路由不变', () => {
  it('EducationModule 只注册本切片的路由与服务，并通过工厂把仓储端口按配置分流', () => {
    const providers = (Reflect.getMetadata('providers', EducationModule) ?? []) as unknown[];
    const controllers = (Reflect.getMetadata('controllers', EducationModule) ?? []) as unknown[];
    const imports = (Reflect.getMetadata('imports', EducationModule) ?? []) as unknown[];

    expect(controllers).toEqual([EducationRecordsController]);
    expect(providers).toContain(EducationRecordsService);
    // 换绑点是一个 factory provider（未配置数据库 → 内存基线；已配置 → PostgreSQL 实现），
    // 因此端口令牌与工厂函数都必须出现在 provider 列表里，而内存实现不再是独立 provider。
    expect(providers).toContainEqual(
      expect.objectContaining({
        provide: EDUCATION_RECORD_REPOSITORY,
        inject: [expect.any(String), expect.objectContaining({ optional: true })],
      }),
    );
    expect(providers).not.toContain(InMemoryEducationRecordRepository);
    expect(typeof createEducationRecordRepository).toBe('function');
    expect(createEducationRecordRepository.length).toBe(2);
    // 依赖方向：认证（auth）与授权（access-control）各自只经端口/服务暴露
    expect(imports).toContain(AuthModule);
    expect(imports).toContain(AccessControlModule);
  });

  it('未配置数据库：端口上就是内存基线（同一实例，可显式 seed）', async () => {
    const app = await NestFactory.create(EducationHttpModule, { logger: false });
    startedApps.push(app);

    const onPort = app.get<InMemoryEducationRecordRepository>(EDUCATION_RECORD_REPOSITORY);
    expect(onPort).toBeInstanceOf(InMemoryEducationRecordRepository);
    expect(onPort.capabilities).toEqual({
      backend: 'in-memory-baseline',
      persistent: false,
      productionReady: false,
    });
  });

  it('内存基线如实声明非持久化，并在生产环境拒绝构造（不用内存冒充生产存储）', () => {
    const developmentEnv = loadEnv({});
    const productionEnv = loadEnv({ NODE_ENV: 'production' });

    expect(new InMemoryEducationRecordRepository(developmentEnv).capabilities).toEqual({
      backend: 'in-memory-baseline',
      persistent: false,
      productionReady: false,
    });
    expect(new InMemorySessionStore(developmentEnv).capabilities).toEqual({
      backend: 'in-memory-baseline',
      persistent: false,
      productionReady: false,
    });

    expect(() => new InMemoryEducationRecordRepository(productionEnv)).toThrow(
      /生产环境禁止使用内存/u,
    );
    expect(() => new InMemorySessionStore(productionEnv)).toThrow(/生产环境禁止使用内存/u);
  });

  it('完整 AppModule：health / runtime-info 行为不变，升学记录默认 401（不预置任何会话）', async () => {
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

    const education = await call(baseUrl, 'GET', '/me/education-records');
    expect(education.status).toBe(401);
    expect(education.body.error?.code).toBe('UNAUTHENTICATED');
  });
});

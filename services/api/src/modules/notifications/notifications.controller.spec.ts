import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { request } from 'node:http';
import { Module, Logger } from '@nestjs/common';
import type { FactoryProvider, INestApplication } from '@nestjs/common';
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
import { SQL_CONNECTION_FACTORY } from '../../db/ports/sql-executor.port';
import { AccessControlModule } from '../access-control/access-control.module';
import { AuthModule } from '../auth/auth.module';
import { InMemorySessionStore } from '../auth/session-store.in-memory';
import { SESSION_STORE } from '../auth/session-subject.port';
import { RUOYI_AUTHZ_ADAPTER } from '../ruoyi-adapter/ruoyi-adapter.port';
import type { RuoYiAuthzAdapter } from '../ruoyi-adapter/ruoyi-adapter.port';
import {
  NOTIFICATION_QUERY_FIELDS,
  NOTIFICATION_VIEW_FIELDS,
  NOTIFICATION_VIEW_REQUIRED_FIELDS,
  assertDeclaredNotificationQueryFields,
  assertNoNotificationPatchBodyFields,
  markNotificationRead,
  parseNotificationView,
  parseStoredNotification,
} from './notifications.contract';
import type { NotificationView } from './notifications.contract';
import { NotificationsController } from './notifications.controller';
import { InMemoryNotificationRepository } from './notifications.in-memory-repository';
import {
  NOTIFICATION_REPOSITORY,
  NotificationStatus,
  NotificationType,
} from './notifications.port';
import type { Notification } from './notifications.port';
import { NotificationsService } from './notifications.service';
import { NotificationsModule } from './notifications.module';

/**
 * 站内通知切片（`/me/notifications`）的真实 HTTP 回归：
 *
 * - 成功：本人列表（200，`data` 是白名单闭集数组、按创建顺序、只含本人记录）与
 *   标记已读（200，`unread -> read`，只有状态与时间戳变化）；空通知箱稳定返回 `[]`；
 * - 幂等：已读记录再次标记已读仍 200，但不写库、不改写 `readAt`（无第二次状态变化）；
 * - 认证 401：无凭证、scheme 不对、凭证过短、会话不存在、会话主体含未登记角色（fail-closed），
 *   且认证失败时仓储一次都没被调用；
 * - 越权 403：角色缺权限点或默认范围不是 `SELF`（admin / group_leader）→ 同一个 403，
 *   并断言判定入参全部来自服务端（权限点常量 + `SELF` + 会话主体）；
 * - 输入 400：查询串声明（`?userId=`/`?roles=`/`?scope=`/`?groupId=`/`?page=`…）与请求体字段
 *   （`status`/`read`/`readAt`/`userId`/`roles`/`scope`…）一律拒绝，且不触发任何取数；
 *   非 UUID 路径参数在取数之前拒绝；
 * - 统一安全边界 404：`不存在` / `非本人所有` / `归属不可读` 共用同一状态码与**逐字段相同**的
 *   响应体，调用方无法构造存在性探测，且 404 响应不含目标记录的任何字段；
 * - claims 伪造：自定义头（`x-user-id`/`x-roles`/`x-scope`/`x-group-id`）不进入任何判定，
 *   伪造成功也只会得到本人数据或统一 404，不会改变可见范围；
 * - PII 与泄露：他人通知正文/标题/联系方式绝不出现；本人记录正文含身份证号或疑似密钥时
 *   fail-closed（500）且日志只写字段路径、不写取值；
 * - 状态变化与存储异常：未知状态枚举、`read` 缺 `readAt`、`unread` 带 `readAt` 一律 500；
 *   仓储抛异常或返回他人记录时按「500（列表）/ 统一 404（单条）」处理，不泄露内部细节；
 * - 既有路由回归：同一 `AppModule` 下 health / runtime-info 与既有切片路由行为不变，
 *   新路由在默认装配（无会话）下 401。
 *
 * 说明：测试用真实 Nest 应用 + 真实 HTTP（与其它切片的 controller spec 同构），
 * 只通过 DI 令牌/端口注入测试夹具（会话、通知记录），不替换任何生产代码路径。
 */

const SESSION_STUDENT_1 = 'session-student-1';
const SESSION_STUDENT_2 = 'session-student-2';
const SESSION_LEADER_1 = 'session-leader-1';
const SESSION_ADMIN_1 = 'session-admin-1';
const SESSION_UNKNOWN_ROLE = 'session-unknown-role';

const STUDENT_1 = 'u-student-1';
const STUDENT_2 = 'u-student-2';
const LEADER_1 = 'u-leader-1';
const ADMIN_1 = 'u-admin-1';

const UNKNOWN_NOTIFICATION_ID = '99999999-9999-4999-8999-999999999999';

/** 高敏内容：18 位身份证号（含 `id_card` 命中）与疑似密钥（`secret_like` 命中） */
const PII_ID_CARD = '110101199003071234';
const PII_SECRET = 'api_key: sk-abcdefghijkl';
/** 他人通知正文里的联系方式：不在本人响应中出现（他人内容不外发） */
const OTHER_PHONE = '13800000000';

const startedApps: INestApplication[] = [];

/** 输出白名单的字符串视图：用于断言响应里没有白名单之外的键 */
const VIEW_WHITELIST: readonly string[] = NOTIFICATION_VIEW_FIELDS;

@Module({
  imports: [ConfigModule, NotificationsModule],
  providers: [
    { provide: APP_INTERCEPTOR, useClass: ApiResponseInterceptor },
    { provide: APP_FILTER, useClass: ApiExceptionFilter },
  ],
})
class NotificationsHttpModule {}

/** 夹具：三条通知（本人未读 / 本人已读 / 他人未读），ID 由测试显式持有 */
interface SeededNotifications {
  readonly ownUnread: Notification;
  readonly ownRead: Notification;
  readonly otherUnread: Notification;
}

interface TestApp {
  readonly app: INestApplication;
  readonly baseUrl: string;
  readonly store: InMemorySessionStore;
  readonly repository: InMemoryNotificationRepository;
  readonly seeded: SeededNotifications;
}

/** 测试夹具记录：归属主体由调用方指定，模拟「存储里已存在他人/已读通知」 */
function fixtureNotification(overrides: Partial<Notification> = {}): Notification {
  const base: Notification = {
    id: randomUUID(),
    userId: STUDENT_1,
    type: NotificationType.MembershipReview,
    title: '入组申请审核结果',
    body: '你提交的入组申请已通过审核。',
    status: NotificationStatus.Unread,
    createdAt: '2026-01-03T00:00:00.000Z',
    updatedAt: '2026-01-03T00:00:00.000Z',
  };
  return { ...base, ...overrides };
}

/** 夹具内容固定，便于断言顺序、状态与「他人内容不出现」 */
function buildSeededNotifications(): SeededNotifications {
  return {
    ownUnread: fixtureNotification({
      id: '11111111-1111-4111-8111-111111111111',
      type: NotificationType.MembershipReview,
      title: '入组申请已通过',
      body: '你申请的「知识图谱小组」已通过审核。',
      status: NotificationStatus.Unread,
      createdAt: '2026-01-03T00:00:00.000Z',
      updatedAt: '2026-01-03T00:00:00.000Z',
    }),
    ownRead: fixtureNotification({
      id: '22222222-2222-4222-8222-222222222222',
      type: NotificationType.AchievementReview,
      title: '成果审核已通过',
      body: '你提交的成果材料已通过审核。',
      status: NotificationStatus.Read,
      createdAt: '2026-01-02T00:00:00.000Z',
      readAt: '2026-01-02T03:04:05.000Z',
      updatedAt: '2026-01-02T03:04:05.000Z',
    }),
    otherUnread: fixtureNotification({
      id: '33333333-3333-4333-8333-333333333333',
      userId: STUDENT_2,
      type: NotificationType.Announcement,
      title: '他人通知：组内安排',
      body: `组内会议改到周三，联系电话 ${OTHER_PHONE}`,
      status: NotificationStatus.Unread,
      createdAt: '2026-01-04T00:00:00.000Z',
      updatedAt: '2026-01-04T00:00:00.000Z',
    }),
  };
}

/** 启动真实应用并注入会话夹具（内存基线的显式 seed，不做隐式全局状态） */
async function startNotificationsApp(options: { readonly seed?: boolean } = {}): Promise<TestApp> {
  const app = await NestFactory.create(NotificationsHttpModule, { logger: false });
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
  // 负责人：持有 profile:self:* 但默认范围是 GROUP（不是 SELF）
  store.seed({
    sessionId: SESSION_LEADER_1,
    subject: { userId: LEADER_1, roles: [Role.GroupLeader], groupIds: ['g-1'] },
  });
  store.seed({ sessionId: SESSION_ADMIN_1, subject: { userId: ADMIN_1, roles: [Role.Admin] } });
  // 会话存储里出现未登记角色：主体不可信，必须在认证边界整体拒绝
  store.seed({
    sessionId: SESSION_UNKNOWN_ROLE,
    subject: { userId: 'u-unknown-1', roles: ['guest' as Role] },
  });

  // 唯一取用点是端口令牌：内存基线不再是独立 provider（否则会出现「容器实例」与
  // 「端口实例」两份状态，测试往其中一个写、service 却读另一个）
  const repository = app.get<InMemoryNotificationRepository>(NOTIFICATION_REPOSITORY);
  const seeded = buildSeededNotifications();
  if (options.seed !== false) {
    await repository.create(seeded.ownUnread);
    await repository.create(seeded.ownRead);
    await repository.create(seeded.otherUnread);
  }

  return { app, baseUrl: `${await app.getUrl()}/api/v1`, store, repository, seeded };
}

interface HttpResult {
  status: number;
  text: string;
  body: ApiEnvelope<unknown>;
}

/** 每次请求使用独立连接（agent: false），避免 keep-alive 让 app.close() 等待空闲连接 */
function call(
  baseUrl: string,
  method: 'GET' | 'PATCH',
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

function viewsOf(body: ApiEnvelope<unknown>): NotificationView[] {
  return body.data as NotificationView[];
}

/**
 * 响应中「业务内容」部分的文本：去掉 `meta`（`requestId` 是随机 UUID、`generatedAt` 是时间戳）
 * 与 `error.requestId`。泄露与「逐字段相同」的断言必须建立在这部分上，
 * 否则会被随机标识误伤。
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

describe('站内通知：成功路径（真实 HTTP + 统一响应信封）', () => {
  it('学生本人：200，data 是白名单闭集数组，按创建顺序只含本人记录', async () => {
    const { baseUrl, seeded } = await startNotificationsApp();

    const res = await call(baseUrl, 'GET', '/me/notifications', {
      headers: { ...bearer(SESSION_STUDENT_1), 'x-request-id': 'test-request-1' },
    });

    expect(res.status).toBe(200);
    expect(res.body.error).toBeNull();
    expect(res.body.meta.requestId).toBe('test-request-1');
    expect(typeof res.body.meta.generatedAt).toBe('string');

    const views = viewsOf(res.body);
    expect(views.map((view) => view.id)).toEqual([seeded.ownUnread.id, seeded.ownRead.id]);

    for (const view of views) {
      // 输出白名单：每个字段都在白名单内，且必需字段齐全（闭集，无第五类信息）
      expect(Object.keys(view).every((key) => VIEW_WHITELIST.includes(key))).toBe(true);
      for (const field of NOTIFICATION_VIEW_REQUIRED_FIELDS) {
        expect(view).toHaveProperty(field);
      }
    }

    // 未读不带 readAt；已读带服务端 readAt（状态与时间自洽）
    expect(views[0]?.status).toBe(NotificationStatus.Unread);
    expect(views[0]).not.toHaveProperty('readAt');
    expect(views[1]?.status).toBe(NotificationStatus.Read);
    expect(views[1]?.readAt).toBe(seeded.ownRead.readAt);

    // 归属不随响应回传：客户端因此没有任何可回传的归属信息可用于伪造
    const content = contentText(res);
    expect(content).not.toContain(STUDENT_1);
    expect(content).not.toContain(STUDENT_2);
    for (const field of ['userId', 'ownerUserId', 'roles', 'scope', 'groupId']) {
      expect(content).not.toContain(`"${field}"`);
    }
  });

  it('他人通知不外发：标题、正文与他人联系方式不出现在本人响应里', async () => {
    const { baseUrl, seeded } = await startNotificationsApp();

    const res = await call(baseUrl, 'GET', '/me/notifications', {
      headers: bearer(SESSION_STUDENT_1),
    });

    expect(res.status).toBe(200);
    const content = contentText(res);
    for (const leaked of [
      seeded.otherUnread.id,
      seeded.otherUnread.title,
      seeded.otherUnread.body,
      OTHER_PHONE,
      STUDENT_2,
    ]) {
      expect(content).not.toContain(leaked);
    }
    expect(viewsOf(res.body)).toHaveLength(2);
  });

  it('空通知箱：未预置任何记录时稳定返回空数组，重复请求内容一致', async () => {
    const { baseUrl } = await startNotificationsApp({ seed: false });

    const first = await call(baseUrl, 'GET', '/me/notifications', {
      headers: bearer(SESSION_STUDENT_1),
    });
    const second = await call(baseUrl, 'GET', '/me/notifications', {
      headers: bearer(SESSION_STUDENT_1),
    });

    for (const res of [first, second]) {
      expect(res.status).toBe(200);
      expect(res.body.error).toBeNull();
      expect(viewsOf(res.body)).toEqual([]);
    }
    expect(contentText(first)).toBe(contentText(second));
  });

  it('标记已读：200，只有状态与时间戳变化，且变化已落库', async () => {
    const { baseUrl, repository, seeded } = await startNotificationsApp();

    const res = await call(baseUrl, 'PATCH', `/me/notifications/${seeded.ownUnread.id}/read`, {
      headers: bearer(SESSION_STUDENT_1),
    });

    expect(res.status).toBe(200);
    expect(res.body.error).toBeNull();
    const view = res.body.data as NotificationView;
    expect(view.id).toBe(seeded.ownUnread.id);
    expect(view.status).toBe(NotificationStatus.Read);
    expect(typeof view.readAt).toBe('string');
    // 只有状态与时间戳变化：类型、标题、正文、创建时间逐字段沿用
    expect(view.type).toBe(seeded.ownUnread.type);
    expect(view.title).toBe(seeded.ownUnread.title);
    expect(view.body).toBe(seeded.ownUnread.body);
    expect(view.createdAt).toBe(seeded.ownUnread.createdAt);
    expect(view.updatedAt).not.toBe(seeded.ownUnread.updatedAt);

    // 归属仍然只来自服务端会话，且没有出现在响应里
    const stored = await repository.findById(seeded.ownUnread.id, STUDENT_1);
    expect(stored?.userId).toBe(STUDENT_1);
    expect(stored?.status).toBe(NotificationStatus.Read);
    expect(stored?.readAt).toBe(view.readAt);
    expect(contentText(res)).not.toContain(STUDENT_1);

    // 再次读取：列表里该条已是已读（状态变化对后续请求可见）
    const list = await call(baseUrl, 'GET', '/me/notifications', {
      headers: bearer(SESSION_STUDENT_1),
    });
    expect(viewsOf(list.body)[0]?.status).toBe(NotificationStatus.Read);
  });

  it('标记已读幂等：重复请求仍 200，但不再写库、不改写 readAt', async () => {
    const { baseUrl, repository, seeded } = await startNotificationsApp();
    const save = vi.spyOn(repository, 'save');

    const first = await call(baseUrl, 'PATCH', `/me/notifications/${seeded.ownUnread.id}/read`, {
      headers: bearer(SESSION_STUDENT_1),
    });
    expect(first.status).toBe(200);
    expect(save).toHaveBeenCalledTimes(1);
    const readAt = (first.body.data as NotificationView).readAt;
    const updatedAt = (first.body.data as NotificationView).updatedAt;

    const second = await call(baseUrl, 'PATCH', `/me/notifications/${seeded.ownUnread.id}/read`, {
      headers: bearer(SESSION_STUDENT_1),
    });

    expect(second.status).toBe(200);
    expect((second.body.data as NotificationView).status).toBe(NotificationStatus.Read);
    expect((second.body.data as NotificationView).readAt).toBe(readAt);
    // read 是终态：第二次不再产生写入，也没有第二次状态变化
    expect((second.body.data as NotificationView).updatedAt).toBe(updatedAt);
    expect(save).toHaveBeenCalledTimes(1);
  });

  it('标记已读对已读记录同样幂等：直接命中终态，不写库', async () => {
    const { baseUrl, repository, seeded } = await startNotificationsApp();
    const save = vi.spyOn(repository, 'save');

    const res = await call(baseUrl, 'PATCH', `/me/notifications/${seeded.ownRead.id}/read`, {
      headers: bearer(SESSION_STUDENT_1),
    });

    expect(res.status).toBe(200);
    expect((res.body.data as NotificationView).readAt).toBe(seeded.ownRead.readAt);
    expect(save).not.toHaveBeenCalled();
  });

  it('标记已读接受空请求体或无请求体：200 且状态推进', async () => {
    const bodies: ReadonlyArray<{ readonly name: string; readonly body?: unknown }> = [
      { name: '空对象请求体', body: {} },
      { name: '不带请求体', body: undefined },
    ];

    for (const { body } of bodies) {
      const { baseUrl, seeded } = await startNotificationsApp();

      const res = await call(baseUrl, 'PATCH', `/me/notifications/${seeded.ownUnread.id}/read`, {
        headers: bearer(SESSION_STUDENT_1),
        ...(body === undefined ? {} : { body }),
      });

      expect(res.status).toBe(200);
      expect((res.body.data as NotificationView).status).toBe(NotificationStatus.Read);
    }
  });

  it('两条路由的判定入参全部来自服务端：权限点是常量、范围恒为 SELF、归属是会话主体', async () => {
    const { app, baseUrl, seeded } = await startNotificationsApp();
    const adapter = app.get<RuoYiAuthzAdapter>(RUOYI_AUTHZ_ADAPTER);
    const checkAuthorization = vi.spyOn(adapter, 'checkAuthorization');
    const student = { userId: STUDENT_1, roles: [Role.Student] };

    const list = await call(baseUrl, 'GET', '/me/notifications', {
      headers: bearer(SESSION_STUDENT_1),
    });
    expect(list.status).toBe(200);

    const mark = await call(baseUrl, 'PATCH', `/me/notifications/${seeded.ownUnread.id}/read`, {
      headers: bearer(SESSION_STUDENT_1),
    });
    expect(mark.status).toBe(200);

    expect(checkAuthorization).toHaveBeenCalledTimes(2);
    expect(checkAuthorization).toHaveBeenNthCalledWith(1, student, {
      permission: PermissionPoint.ProfileSelfRead,
      scope: DataScope.Self,
      resourceUserId: STUDENT_1,
    });
    expect(checkAuthorization).toHaveBeenNthCalledWith(2, student, {
      permission: PermissionPoint.ProfileSelfUpdate,
      scope: DataScope.Self,
      resourceUserId: STUDENT_1,
    });
  });
});

describe('站内通知：认证边界 401（fail-closed）', () => {
  const unauthenticatedCases: ReadonlyArray<{ name: string; headers: Record<string, string> }> = [
    { name: '未携带 Authorization', headers: {} },
    { name: 'scheme 不是 Bearer', headers: { authorization: `Token ${SESSION_STUDENT_1}` } },
    { name: 'Bearer 凭证过短', headers: { authorization: 'Bearer short' } },
    { name: '会话不存在', headers: bearer('session-does-not-exist') },
    { name: '会话主体含未登记角色', headers: bearer(SESSION_UNKNOWN_ROLE) },
  ];

  it.each(unauthenticatedCases)('$name → 401 UNAUTHENTICATED（列表）', async ({ headers }) => {
    const { baseUrl, repository } = await startNotificationsApp();
    const list = vi.spyOn(repository, 'listByUserId');

    const res = await call(baseUrl, 'GET', '/me/notifications', { headers });

    expect(res.status).toBe(401);
    expect(res.body.data).toBeNull();
    expect(res.body.error?.code).toBe('UNAUTHENTICATED');
    // 不区分失败原因，避免给探测者额外信息
    expect(res.body.error?.message).toBe('登录状态无效或已过期，请重新登录');
    // 认证失败发生在任何取数之前
    expect(list).not.toHaveBeenCalled();
    expect(contentText(res)).not.toContain(SESSION_UNKNOWN_ROLE);
    expect(contentText(res)).not.toContain('guest');
  });

  it.each(unauthenticatedCases)('$name → 401 UNAUTHENTICATED（标记已读）', async ({ headers }) => {
    const { baseUrl, repository, seeded } = await startNotificationsApp();
    const findById = vi.spyOn(repository, 'findById');
    const save = vi.spyOn(repository, 'save');

    const res = await call(baseUrl, 'PATCH', `/me/notifications/${seeded.ownUnread.id}/read`, {
      headers,
    });

    expect(res.status).toBe(401);
    expect(res.body.error?.code).toBe('UNAUTHENTICATED');
    expect(findById).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
    // 未认证不产生任何状态变化
    expect((await repository.findById(seeded.ownUnread.id, STUDENT_1))?.status).toBe(
      NotificationStatus.Unread,
    );
  });

  it('未认证时即便带了查询串/请求体也是 401（认证先于一切输入）', async () => {
    const { baseUrl, repository, seeded } = await startNotificationsApp();
    const list = vi.spyOn(repository, 'listByUserId');
    const findById = vi.spyOn(repository, 'findById');

    const listRes = await call(baseUrl, 'GET', '/me/notifications?userId=u-student-2');
    expect(listRes.status).toBe(401);
    expect(listRes.body.error?.code).toBe('UNAUTHENTICATED');
    expect(list).not.toHaveBeenCalled();

    const markRes = await call(baseUrl, 'PATCH', `/me/notifications/${seeded.ownUnread.id}/read`, {
      body: { status: NotificationStatus.Read },
    });
    expect(markRes.status).toBe(401);
    expect(markRes.body.error?.code).toBe('UNAUTHENTICATED');
    expect(findById).not.toHaveBeenCalled();
  });
});

describe('站内通知：越权 403（AuthorizationGuard + 服务端资源判定）', () => {
  it.each([
    { name: 'admin（范围 ASSIGNED，不是 SELF）', session: SESSION_ADMIN_1 },
    { name: 'group_leader（范围 GROUP，不是 SELF）', session: SESSION_LEADER_1 },
  ])('$name 读取本人通知：403 FORBIDDEN，且仓储一次都没被调用', async ({ session }) => {
    const { baseUrl, repository } = await startNotificationsApp();
    const list = vi.spyOn(repository, 'listByUserId');

    const res = await call(baseUrl, 'GET', '/me/notifications', { headers: bearer(session) });

    expect(res.status).toBe(403);
    expect(res.body.data).toBeNull();
    expect(res.body.error?.code).toBe('FORBIDDEN');
    expect(res.body.error?.message).toBe('无权执行该操作');
    expect(list).not.toHaveBeenCalled();
    // 403 不携带任何资源信息
    const content = contentText(res);
    for (const leaked of [STUDENT_1, OTHER_PHONE, '入组申请已通过', '他人通知']) {
      expect(content).not.toContain(leaked);
    }
  });

  it.each([
    { name: 'admin', session: SESSION_ADMIN_1 },
    { name: 'group_leader', session: SESSION_LEADER_1 },
  ])('$name 标记他人通知已读：403 FORBIDDEN，且不触发取数与写入', async ({ session }) => {
    const { baseUrl, repository, seeded } = await startNotificationsApp();
    const findById = vi.spyOn(repository, 'findById');
    const save = vi.spyOn(repository, 'save');

    const res = await call(baseUrl, 'PATCH', `/me/notifications/${seeded.otherUnread.id}/read`, {
      headers: bearer(session),
    });

    expect(res.status).toBe(403);
    expect(res.body.error?.code).toBe('FORBIDDEN');
    expect(findById).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
    expect((await repository.findById(seeded.otherUnread.id, STUDENT_2))?.status).toBe(
      NotificationStatus.Unread,
    );
  });
});

describe('站内通知：输入拒绝 400（VALIDATION_FAILED，不取数/不落库）', () => {
  it('查询串闭集：列表端点出现任何查询参数都 400，且不触发取数', async () => {
    const cases: ReadonlyArray<{ readonly query: string; readonly expected: string }> = [
      { query: 'userId=u-student-2', expected: '禁止使用查询参数 userId' },
      { query: 'roles=super_admin', expected: '禁止使用查询参数 roles' },
      { query: 'scope=GLOBAL', expected: '禁止使用查询参数 scope' },
      { query: 'groupId=g-1', expected: '禁止使用查询参数 groupId' },
      { query: 'unreadOnly=true', expected: '本端点不接受查询参数 unreadOnly' },
      { query: 'page=1&pageSize=10', expected: '本端点不接受查询参数 page' },
    ];

    for (const { query, expected } of cases) {
      const { baseUrl, repository } = await startNotificationsApp();
      const list = vi.spyOn(repository, 'listByUserId');

      const res = await call(baseUrl, 'GET', `/me/notifications?${query}`, {
        headers: bearer(SESSION_STUDENT_1),
      });

      expect(res.status).toBe(400);
      expect(res.body.data).toBeNull();
      expect(res.body.error?.code).toBe('VALIDATION_FAILED');
      const messages = issuesOf(res.body).map((issue) => issue.message);
      expect(messages.some((message) => message.includes(expected))).toBe(true);
      expect(list).not.toHaveBeenCalled();
    }
  });

  it('查询串闭集：重复参数同样 400（键名违规，不被解析为合法输入）', async () => {
    const { baseUrl } = await startNotificationsApp();

    const res = await call(
      baseUrl,
      'GET',
      '/me/notifications?userId=u-student-1&userId=u-student-2',
      { headers: bearer(SESSION_STUDENT_1) },
    );

    expect(res.status).toBe(400);
    expect(res.body.error?.code).toBe('VALIDATION_FAILED');
  });

  it('空查询串（`?`）不算输入：仍然 200 且返回本人通知', async () => {
    const { baseUrl } = await startNotificationsApp();

    const res = await call(baseUrl, 'GET', '/me/notifications?', {
      headers: bearer(SESSION_STUDENT_1),
    });

    expect(res.status).toBe(200);
    expect(viewsOf(res.body)).toHaveLength(2);
  });

  it('标记已读不接受查询参数：?scope=GLOBAL 一律 400 且不取数', async () => {
    const { baseUrl, repository, seeded } = await startNotificationsApp();
    const findById = vi.spyOn(repository, 'findById');

    const res = await call(
      baseUrl,
      'PATCH',
      `/me/notifications/${seeded.ownUnread.id}/read?scope=GLOBAL`,
      { headers: bearer(SESSION_STUDENT_1) },
    );

    expect(res.status).toBe(400);
    expect(res.body.error?.code).toBe('VALIDATION_FAILED');
    expect(findById).not.toHaveBeenCalled();
    expect((await repository.findById(seeded.ownUnread.id, STUDENT_1))?.status).toBe(
      NotificationStatus.Unread,
    );
  });

  const injectedBodyFields: ReadonlyArray<{ readonly name: string; readonly body: unknown }> = [
    { name: 'status', body: { status: NotificationStatus.Read } },
    { name: 'read', body: { read: true } },
    { name: 'readAt', body: { readAt: '2026-01-05T00:00:00.000Z' } },
    { name: 'userId', body: { userId: STUDENT_2 } },
    { name: 'ownerUserId', body: { ownerUserId: STUDENT_2 } },
    { name: 'roles', body: { roles: [Role.SuperAdmin] } },
    { name: 'scope', body: { scope: DataScope.Global } },
    { name: 'groupId', body: { groupId: 'g-1' } },
    { name: 'title/body 改写', body: { title: '被改写', body: '被改写' } },
  ];

  it.each(injectedBodyFields)(
    '标记已读拒绝请求体字段（$name）：400，不取数、不改状态',
    async ({ body }) => {
      const { baseUrl, repository, seeded } = await startNotificationsApp();
      const findById = vi.spyOn(repository, 'findById');

      const res = await call(baseUrl, 'PATCH', `/me/notifications/${seeded.ownUnread.id}/read`, {
        headers: bearer(SESSION_STUDENT_1),
        body,
      });

      expect(res.status).toBe(400);
      expect(res.body.data).toBeNull();
      expect(res.body.error?.code).toBe('VALIDATION_FAILED');
      expect(issuesOf(res.body).length).toBeGreaterThan(0);
      expect(findById).not.toHaveBeenCalled();
      expect((await repository.findById(seeded.ownUnread.id, STUDENT_1))?.status).toBe(
        NotificationStatus.Unread,
      );
    },
  );

  it('客户端伪造服务端字段的拒绝原因可区分：服务端字段 vs 未声明字段', async () => {
    const { baseUrl, seeded } = await startNotificationsApp();

    const res = await call(baseUrl, 'PATCH', `/me/notifications/${seeded.ownUnread.id}/read`, {
      headers: bearer(SESSION_STUDENT_1),
      body: { status: NotificationStatus.Read, userId: STUDENT_2, title: '被改写' },
    });

    expect(res.status).toBe(400);
    const messages = issuesOf(res.body).map((issue) => issue.message);
    expect(messages).toContain('禁止设置服务端字段 status');
    expect(messages).toContain('禁止设置服务端字段 userId');
    expect(messages).toContain('本端点不接受请求体字段 title');
    // 拒绝原因只给字段名，不回显提交的取值
    expect(contentText(res)).not.toContain(STUDENT_2);
    expect(contentText(res)).not.toContain('被改写');
  });

  it('路径参数闭集：非 UUID 的通知 ID 在取数之前 400', async () => {
    const { baseUrl, repository } = await startNotificationsApp();
    const findById = vi.spyOn(repository, 'findById');

    const res = await call(baseUrl, 'PATCH', '/me/notifications/not-a-uuid/read', {
      headers: bearer(SESSION_STUDENT_1),
    });

    expect(res.status).toBe(400);
    expect(res.body.error?.code).toBe('VALIDATION_FAILED');
    expect(issuesOf(res.body).map((issue) => issue.path)).toContain('notificationId');
    expect(findById).not.toHaveBeenCalled();
  });

  it('请求体不是合法 JSON 对象：400，且不回显请求体片段', async () => {
    const { baseUrl } = await startNotificationsApp();

    const res = await new Promise<HttpResult>((resolve, reject) => {
      const payload = '"read"';
      const req = request(
        `${baseUrl}/me/notifications/11111111-1111-4111-8111-111111111111/read`,
        {
          method: 'PATCH',
          agent: false,
          headers: {
            ...bearer(SESSION_STUDENT_1),
            'content-type': 'application/json',
            'content-length': String(Buffer.byteLength(payload)),
          },
        },
        (httpRes) => {
          let text = '';
          httpRes.setEncoding('utf8');
          httpRes.on('data', (chunk: string) => {
            text += chunk;
          });
          httpRes.on('end', () => {
            resolve({
              status: httpRes.statusCode ?? 0,
              text,
              body: JSON.parse(text) as ApiEnvelope<unknown>,
            });
          });
        },
      );
      req.on('error', reject);
      req.write(payload);
      req.end();
    });

    expect(res.status).toBe(400);
    expect(res.body.error?.code).toBe('VALIDATION_FAILED');
    expect(res.body.error?.message).not.toContain('read');
  });
});

describe('站内通知：越权与不存在统一安全边界（404，逐字段相同）', () => {
  it('不存在 / 非本人所有 / 归属不可读：同一 404 与同一响应体，不泄露目标记录', async () => {
    const { baseUrl, repository, seeded } = await startNotificationsApp();

    const missing = await call(
      baseUrl,
      'PATCH',
      `/me/notifications/${UNKNOWN_NOTIFICATION_ID}/read`,
      {
        headers: bearer(SESSION_STUDENT_1),
      },
    );
    const someoneElse = await call(
      baseUrl,
      'PATCH',
      `/me/notifications/${seeded.otherUnread.id}/read`,
      { headers: bearer(SESSION_STUDENT_1) },
    );

    for (const res of [missing, someoneElse]) {
      expect(res.status).toBe(404);
      expect(res.body.data).toBeNull();
      expect(res.body.error?.code).toBe('NOT_FOUND');
      expect(res.body.error?.message).toBe('目标通知不存在或不可见');
    }
    // 逐字段相同：无法用状态码、错误码、文案或 details 区分「不存在」与「他人的通知」
    expect(contentText(someoneElse)).toBe(contentText(missing));

    // 404 不携带目标记录的任何字段，也不改变它的状态
    const content = contentText(someoneElse);
    for (const leaked of [
      seeded.otherUnread.id,
      seeded.otherUnread.title,
      seeded.otherUnread.body,
      OTHER_PHONE,
      STUDENT_2,
    ]) {
      expect(content).not.toContain(leaked);
    }
    expect((await repository.findById(seeded.otherUnread.id, STUDENT_2))?.status).toBe(
      NotificationStatus.Unread,
    );
  });

  it('他人的通知：另一个学生同样得到同一个 404（不会变成成功）', async () => {
    const { baseUrl, repository, seeded } = await startNotificationsApp();

    const res = await call(baseUrl, 'PATCH', `/me/notifications/${seeded.ownUnread.id}/read`, {
      headers: bearer(SESSION_STUDENT_2),
    });

    expect(res.status).toBe(404);
    expect(res.body.error?.code).toBe('NOT_FOUND');
    expect((await repository.findById(seeded.ownUnread.id, STUDENT_1))?.status).toBe(
      NotificationStatus.Unread,
    );
  });

  it('不可见路径只做一次授权（不按存储归属给出第二个结论），也不触发写入', async () => {
    const { app, baseUrl, repository, seeded } = await startNotificationsApp();
    const adapter = app.get<RuoYiAuthzAdapter>(RUOYI_AUTHZ_ADAPTER);
    const checkAuthorization = vi.spyOn(adapter, 'checkAuthorization');
    const save = vi.spyOn(repository, 'save');

    const res = await call(baseUrl, 'PATCH', `/me/notifications/${seeded.otherUnread.id}/read`, {
      headers: bearer(SESSION_STUDENT_1),
    });

    expect(res.status).toBe(404);
    expect(checkAuthorization).toHaveBeenCalledTimes(1);
    expect(checkAuthorization).toHaveBeenNthCalledWith(
      1,
      { userId: STUDENT_1, roles: [Role.Student] },
      {
        permission: PermissionPoint.ProfileSelfUpdate,
        scope: DataScope.Self,
        resourceUserId: STUDENT_1,
      },
    );
    expect(save).not.toHaveBeenCalled();
  });

  it('仓储返回归属不可读的记录：并入统一 404（不因存储损坏泄露存在性）', async () => {
    const { baseUrl, repository, seeded } = await startNotificationsApp();
    const broken = fixtureNotification({ id: seeded.ownUnread.id });
    vi.spyOn(repository, 'findById').mockResolvedValue({
      ...broken,
      userId: 42 as unknown as string,
    });

    const res = await call(baseUrl, 'PATCH', `/me/notifications/${seeded.ownUnread.id}/read`, {
      headers: bearer(SESSION_STUDENT_1),
    });

    expect(res.status).toBe(404);
    expect(res.body.error?.code).toBe('NOT_FOUND');
    expect(res.body.error?.message).toBe('目标通知不存在或不可见');
  });

  it('仓储把他人记录当作本人记录返回（单条）：同样统一 404，不是 500、不外发内容', async () => {
    const { baseUrl, repository, seeded } = await startNotificationsApp();
    vi.spyOn(repository, 'findById').mockResolvedValue(seeded.otherUnread);

    const res = await call(baseUrl, 'PATCH', `/me/notifications/${seeded.otherUnread.id}/read`, {
      headers: bearer(SESSION_STUDENT_1),
    });

    expect(res.status).toBe(404);
    expect(contentText(res)).not.toContain(seeded.otherUnread.title);
    expect(contentText(res)).not.toContain(OTHER_PHONE);
  });

  it('未注册的更短/更长路由形态不产生新行为：`PATCH .../{id}`（缺 /read）→ 404', async () => {
    const { baseUrl, seeded } = await startNotificationsApp();

    const res = await call(baseUrl, 'PATCH', `/me/notifications/${seeded.ownUnread.id}`, {
      headers: bearer(SESSION_STUDENT_1),
    });

    expect(res.status).toBe(404);
    expect(res.body.error?.code).toBe('NOT_FOUND');
  });
});

describe('站内通知：claims 伪造（客户端声明不进入判定）', () => {
  const forgedHeaders = {
    'x-user-id': STUDENT_2,
    'x-owner-user-id': STUDENT_2,
    'x-roles': 'super_admin,admin',
    'x-scope': 'GLOBAL',
    'x-group-id': 'g-1',
    'x-notification-owner': STUDENT_2,
  };

  it('伪造自定义头不能改变取数主体：列表仍只返回会话主体本人的通知', async () => {
    const { app, baseUrl, seeded } = await startNotificationsApp();
    const adapter = app.get<RuoYiAuthzAdapter>(RUOYI_AUTHZ_ADAPTER);
    const checkAuthorization = vi.spyOn(adapter, 'checkAuthorization');

    const res = await call(baseUrl, 'GET', '/me/notifications', {
      headers: { ...bearer(SESSION_STUDENT_1), ...forgedHeaders },
    });

    expect(res.status).toBe(200);
    expect(viewsOf(res.body).map((view) => view.id)).toEqual([
      seeded.ownUnread.id,
      seeded.ownRead.id,
    ]);
    // 判定入参是会话主体，伪造头没有进入任何一项
    expect(checkAuthorization).toHaveBeenCalledWith(
      { userId: STUDENT_1, roles: [Role.Student] },
      {
        permission: PermissionPoint.ProfileSelfRead,
        scope: DataScope.Self,
        resourceUserId: STUDENT_1,
      },
    );
    expect(contentText(res)).not.toContain(OTHER_PHONE);
  });

  it('伪造自定义头不能越权标记他人通知：仍统一 404，他人记录保持未读', async () => {
    const { baseUrl, repository, seeded } = await startNotificationsApp();

    const res = await call(baseUrl, 'PATCH', `/me/notifications/${seeded.otherUnread.id}/read`, {
      headers: { ...bearer(SESSION_STUDENT_1), ...forgedHeaders },
    });

    expect(res.status).toBe(404);
    expect(res.body.error?.message).toBe('目标通知不存在或不可见');
    expect((await repository.findById(seeded.otherUnread.id, STUDENT_2))?.status).toBe(
      NotificationStatus.Unread,
    );
  });

  it('伪造自定义头也不能让本人标记已读失败（声明不影响本人自身能力）', async () => {
    const { baseUrl, repository, seeded } = await startNotificationsApp();

    const res = await call(baseUrl, 'PATCH', `/me/notifications/${seeded.ownUnread.id}/read`, {
      headers: { ...bearer(SESSION_STUDENT_1), ...forgedHeaders },
    });

    expect(res.status).toBe(200);
    expect((await repository.findById(seeded.ownUnread.id, STUDENT_1))?.status).toBe(
      NotificationStatus.Read,
    );
    expect((await repository.findById(seeded.ownUnread.id, STUDENT_1))?.userId).toBe(STUDENT_1);
  });
});

describe('站内通知：PII 与 fail-closed 500', () => {
  it('本人记录含身份证号：整条 fail-closed 500，响应与日志都不含取值', async () => {
    const errorLog = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const { baseUrl, repository, seeded } = await startNotificationsApp();
    await repository.create(
      fixtureNotification({
        id: '44444444-4444-4444-8444-444444444444',
        title: '身份核验通知',
        body: `请核对身份证号 ${PII_ID_CARD}`,
      }),
    );

    const res = await call(baseUrl, 'GET', '/me/notifications', {
      headers: bearer(SESSION_STUDENT_1),
    });

    expect(res.status).toBe(500);
    expect(res.body.data).toBeNull();
    expect(res.body.error?.code).toBe('INTERNAL_ERROR');
    expect(res.body.error?.message).toBe('服务器内部错误，请稍后重试');
    // fail-closed：整条响应不含 PII 原文，也不含任何通知内容（含同批次的干净记录）
    const content = contentText(res);
    for (const leaked of [PII_ID_CARD, '身份核验通知', seeded.ownUnread.title, STUDENT_1]) {
      expect(content).not.toContain(leaked);
    }
    // 日志只有字段路径与违规类型，没有取值
    const logs = errorLog.mock.calls.flat().join(' ');
    expect(logs).toContain('[notifications]');
    expect(logs).not.toContain(PII_ID_CARD);
    expect(logs).not.toContain('身份核验通知');
  });

  it('本人记录含疑似密钥：标记已读同样 fail-closed 500，且不写入状态', async () => {
    const errorLog = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const { baseUrl, repository } = await startNotificationsApp();
    const poisoned = await repository.create(
      fixtureNotification({
        id: '55555555-5555-4555-8555-555555555555',
        title: '系统凭据提醒',
        body: `请及时更换 ${PII_SECRET}`,
      }),
    );

    const res = await call(baseUrl, 'PATCH', `/me/notifications/${poisoned.id}/read`, {
      headers: bearer(SESSION_STUDENT_1),
    });

    expect(res.status).toBe(500);
    expect(res.body.error?.code).toBe('INTERNAL_ERROR');
    expect(contentText(res)).not.toContain(PII_SECRET);
    expect(contentText(res)).not.toContain('系统凭据提醒');
    // 记录没有被当作已读写入
    expect((await repository.findById(poisoned.id, STUDENT_1))?.status).toBe(
      NotificationStatus.Unread,
    );
    const logs = errorLog.mock.calls.flat().join(' ');
    expect(logs).not.toContain(PII_SECRET);
  });

  it('未知状态枚举、read 缺 readAt、unread 带 readAt 一律 500（不作为合法值外发）', async () => {
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const now = '2026-01-06T00:00:00.000Z';
    const brokenRecords: ReadonlyArray<Notification> = [
      fixtureNotification({ status: 'archived' as NotificationStatus }),
      fixtureNotification({ status: NotificationStatus.Read }),
      fixtureNotification({ status: NotificationStatus.Unread, readAt: now }),
      fixtureNotification({ type: 'unknown_type' as NotificationType }),
      fixtureNotification({ title: '标题', createdAt: 'not-a-timestamp' }),
    ];

    for (const broken of brokenRecords) {
      const { baseUrl, repository } = await startNotificationsApp({ seed: false });
      await repository.create(broken);

      const list = await call(baseUrl, 'GET', '/me/notifications', {
        headers: bearer(SESSION_STUDENT_1),
      });
      expect(list.status).toBe(500);
      expect(list.body.error?.code).toBe('INTERNAL_ERROR');
      expect(contentText(list)).not.toContain(broken.title);

      const mark = await call(baseUrl, 'PATCH', `/me/notifications/${broken.id}/read`, {
        headers: bearer(SESSION_STUDENT_1),
      });
      expect(mark.status).toBe(500);
      expect(mark.body.error?.code).toBe('INTERNAL_ERROR');
    }
  });

  it('仓储返回对象/数组等非记录形态：500，响应不含返回值', async () => {
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const { baseUrl, repository } = await startNotificationsApp();
    vi.spyOn(repository, 'listByUserId').mockResolvedValue([
      {
        id: 'u-victim-9',
        name: '张三',
        studentNo: '2021001999',
        phone: OTHER_PHONE,
      } as unknown as Notification,
    ]);

    const res = await call(baseUrl, 'GET', '/me/notifications', {
      headers: bearer(SESSION_STUDENT_1),
    });

    expect(res.status).toBe(500);
    expect(res.body.data).toBeNull();
    const content = contentText(res);
    for (const leaked of ['u-victim-9', '张三', '2021001999', OTHER_PHONE]) {
      expect(content).not.toContain(leaked);
    }
  });

  it('列表返回归属不一致的记录（仓储未按主体过滤）→ 500，不把他人记录发给调用方', async () => {
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const { baseUrl, repository, seeded } = await startNotificationsApp();
    vi.spyOn(repository, 'listByUserId').mockResolvedValue([seeded.otherUnread]);

    const res = await call(baseUrl, 'GET', '/me/notifications', {
      headers: bearer(SESSION_STUDENT_1),
    });

    expect(res.status).toBe(500);
    expect(res.body.error?.code).toBe('INTERNAL_ERROR');
    expect(contentText(res)).not.toContain(seeded.otherUnread.title);
    expect(contentText(res)).not.toContain(OTHER_PHONE);
  });
});

describe('站内通知：存储异常（仓端口抛错 → 500，不泄露内部细节）', () => {
  it('列表取数抛异常（含敏感原文）→ 500，响应不含错误名、堆栈与原文', async () => {
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const { baseUrl, repository } = await startNotificationsApp();
    vi.spyOn(repository, 'listByUserId').mockRejectedValue(
      new Error(`connection refused: userId=${STUDENT_1} phone=${OTHER_PHONE}`),
    );

    const res = await call(baseUrl, 'GET', '/me/notifications', {
      headers: bearer(SESSION_STUDENT_1),
    });

    expect(res.status).toBe(500);
    expect(res.body.data).toBeNull();
    expect(res.body.error?.code).toBe('INTERNAL_ERROR');
    expect(res.body.error?.message).toBe('服务器内部错误，请稍后重试');
    const content = contentText(res);
    for (const leaked of [STUDENT_1, OTHER_PHONE, 'connection refused', 'Error']) {
      expect(content).not.toContain(leaked);
    }
  });

  it('单条取数抛异常 → 500，且不写入任何状态', async () => {
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const { baseUrl, repository, seeded } = await startNotificationsApp();
    const save = vi.spyOn(repository, 'save');
    const findById = vi
      .spyOn(repository, 'findById')
      .mockRejectedValue(new Error(`redis timeout: notificationId=${seeded.ownUnread.id}`));

    const res = await call(baseUrl, 'PATCH', `/me/notifications/${seeded.ownUnread.id}/read`, {
      headers: bearer(SESSION_STUDENT_1),
    });

    expect(res.status).toBe(500);
    expect(res.body.error?.code).toBe('INTERNAL_ERROR');
    expect(findById).toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
  });

  it('Postgres 状态转移冲突 → 409 STATE_TRANSITION_INVALID，且不泄露仓储错误', async () => {
    const { baseUrl, repository, seeded } = await startNotificationsApp();
    vi.spyOn(repository, 'save').mockRejectedValue({
      code: 'TRANSITION_REJECTED',
      message: 'internal SQL/user detail must not escape',
    });

    const res = await call(baseUrl, 'PATCH', `/me/notifications/${seeded.ownUnread.id}/read`, {
      headers: bearer(SESSION_STUDENT_1),
    });

    expect(res.status).toBe(409);
    expect(res.body.error?.code).toBe('STATE_TRANSITION_INVALID');
    expect(contentText(res)).not.toContain('TRANSITION_REJECTED');
    expect(contentText(res)).not.toContain('internal SQL');
  });

  it('写回抛异常 → 500，状态变化不成立（记录保持未读、无 readAt）', async () => {
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const { baseUrl, repository, seeded } = await startNotificationsApp();
    vi.spyOn(repository, 'save').mockRejectedValue(
      new Error(`write failed: userId=${STUDENT_1} phone=${OTHER_PHONE}`),
    );

    const res = await call(baseUrl, 'PATCH', `/me/notifications/${seeded.ownUnread.id}/read`, {
      headers: bearer(SESSION_STUDENT_1),
    });

    expect(res.status).toBe(500);
    expect(res.body.error?.code).toBe('INTERNAL_ERROR');
    const stored = await repository.findById(seeded.ownUnread.id, STUDENT_1);
    expect(stored?.status).toBe(NotificationStatus.Unread);
    expect(stored).not.toHaveProperty('readAt');
    expect(contentText(res)).not.toContain(OTHER_PHONE);
  });

  it('写回返回被替换的记录（归属变成他人）→ 500，不把替换结果交出去', async () => {
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const { baseUrl, repository, seeded } = await startNotificationsApp();
    vi.spyOn(repository, 'save').mockResolvedValue(seeded.otherUnread);

    const res = await call(baseUrl, 'PATCH', `/me/notifications/${seeded.ownUnread.id}/read`, {
      headers: bearer(SESSION_STUDENT_1),
    });

    expect(res.status).toBe(500);
    expect(res.body.error?.code).toBe('INTERNAL_ERROR');
    expect(contentText(res)).not.toContain(OTHER_PHONE);
  });
});

describe('站内通知：装配边界与纯函数门禁', () => {
  it('NotificationsModule 只注册本切片的路由/服务，并把仓储令牌绑到「按是否配置数据库分流」的工厂', () => {
    const providers = (Reflect.getMetadata('providers', NotificationsModule) ?? []) as unknown[];
    const controllers = (Reflect.getMetadata('controllers', NotificationsModule) ??
      []) as unknown[];
    const imports = (Reflect.getMetadata('imports', NotificationsModule) ?? []) as unknown[];

    expect(controllers).toEqual([NotificationsController]);
    expect(providers).toContain(NotificationsService);
    // 内存基线**不再是独立 provider**：它是实现，不是绑定（否则会有两份状态）
    expect(providers).not.toContain(InMemoryNotificationRepository);
    expect(providers).not.toContainEqual({
      provide: NOTIFICATION_REPOSITORY,
      useExisting: InMemoryNotificationRepository,
    });
    // 换绑只发生在这一个 provider 的工厂里
    const binding = providers.find(
      (provider): provider is FactoryProvider =>
        typeof provider === 'object' &&
        provider !== null &&
        (provider as { provide?: unknown }).provide === NOTIFICATION_REPOSITORY,
    );
    expect(binding).toBeDefined();
    expect(typeof binding?.useFactory).toBe('function');
    // 可选注入执行器工厂：测试装配无需数据库模块
    expect(binding?.inject).toEqual([APP_ENV, { token: SQL_CONNECTION_FACTORY, optional: true }]);
    // 依赖方向：认证（auth）与授权（access-control）各自只经端口/服务暴露
    expect(imports).toContain(AuthModule);
    expect(imports).toContain(AccessControlModule);
  });

  it('内存基线如实声明非持久化/不可用于生产，并在生产环境拒绝构造', async () => {
    const developmentEnv = loadEnv({});
    const productionEnv = loadEnv({ NODE_ENV: 'production' });

    const repository = new InMemoryNotificationRepository(developmentEnv);
    expect(repository.capabilities).toEqual({
      backend: 'in-memory-baseline',
      persistent: false,
      productionReady: false,
    });
    await expect(repository.listByUserId('u-nobody')).resolves.toEqual([]);
    // 不用内存冒充生产存储：生产环境直接拒绝构造
    expect(() => new InMemoryNotificationRepository(productionEnv)).toThrow(
      /生产环境禁止使用内存通知仓储/u,
    );
  });

  it('内存基线只做存储自身的完整性约束：主键唯一、归属不可变、只更新既有记录', async () => {
    const repository = new InMemoryNotificationRepository(loadEnv({}));
    const record = fixtureNotification();
    await repository.create(record);
    await repository.create(fixtureNotification({ userId: STUDENT_2 }));

    await expect(repository.create(record)).rejects.toThrow(/通知 ID 冲突/u);
    await expect(
      repository.save(fixtureNotification({ id: '66666666-6666-4666-8666-666666666666' })),
    ).rejects.toThrow(/通知不存在/u);
    // 归属不可变：拿他人通知的 ID 改写他人数据在存储层被关闭（与数据库实现同语义）
    await expect(
      repository.save(fixtureNotification({ id: record.id, userId: STUDENT_2 })),
    ).rejects.toThrow(/通知归属不符/u);

    // 返回副本：调用方改不动存储内部引用
    const found = await repository.findById(record.id, STUDENT_1);
    expect(found?.title).toBe(record.title);
    // 归属下推进取数：非本人主体取不到本人的记录
    await expect(repository.findById(record.id, STUDENT_2)).resolves.toBeUndefined();
    await expect(repository.listByUserId(STUDENT_1)).resolves.toHaveLength(1);
    await expect(repository.listByUserId(STUDENT_2)).resolves.toHaveLength(1);
    await expect(repository.listByUserId('u-nobody')).resolves.toEqual([]);
  });

  it('输出白名单是真正的闭集：多出字段即违规（门禁非恒真）', () => {
    const valid = {
      id: '11111111-1111-4111-8111-111111111111',
      type: NotificationType.MembershipReview,
      title: '标题',
      body: '正文',
      status: NotificationStatus.Unread,
      createdAt: '2026-01-03T00:00:00.000Z',
      updatedAt: '2026-01-03T00:00:00.000Z',
    };
    expect(parseNotificationView(valid)).toEqual({ ok: true, value: valid });

    const withExtra = parseNotificationView({ ...valid, userId: STUDENT_1 });
    expect(withExtra.ok).toBe(false);
    if (!withExtra.ok) {
      expect(withExtra.issues).toEqual([{ kind: 'unexpected', path: 'userId' }]);
    }

    const withInvalid = parseNotificationView({ ...valid, status: 'archived' });
    expect(withInvalid.ok).toBe(false);
    if (!withInvalid.ok) {
      expect(withInvalid.issues).toEqual([{ kind: 'invalid', path: 'status' }]);
    }

    // 已读必须带 readAt、未读不得带 readAt（不变式在出口同样成立）
    expect(parseNotificationView({ ...valid, status: NotificationStatus.Read }).ok).toBe(false);
    expect(
      parseNotificationView({
        ...valid,
        readAt: '2026-01-03T01:00:00.000Z',
      }).ok,
    ).toBe(false);
  });

  it('存储读取契约：枚举闭集、ISO 时间戳、状态/已读时间不变式与免 PII 文本', () => {
    const validUnread = fixtureNotification();
    expect(parseStoredNotification(validUnread).ok).toBe(true);

    const cases: ReadonlyArray<{ readonly record: unknown; readonly path: string }> = [
      { record: { ...validUnread, status: 'archived' }, path: 'status' },
      { record: { ...validUnread, type: 'unknown_type' }, path: 'type' },
      { record: { ...validUnread, createdAt: '2026/01/03' }, path: 'createdAt' },
      { record: { ...validUnread, userId: '' }, path: 'userId' },
      { record: { ...validUnread, readAt: '2026-01-03T01:00:00.000Z' }, path: 'readAt' },
      { record: { ...validUnread, status: NotificationStatus.Read }, path: 'readAt' },
      { record: { ...validUnread, body: `身份证 ${PII_ID_CARD}` }, path: 'body' },
      { record: { ...validUnread, body: `密钥 ${PII_SECRET}` }, path: 'body' },
    ];

    for (const { record, path } of cases) {
      const parsed = parseStoredNotification(record);
      expect(parsed.ok).toBe(false);
      if (!parsed.ok) {
        expect(parsed.issues.map((issue) => issue.path)).toContain(path);
        // 违规详情只给路径与类型，不给取值
        expect(JSON.stringify(parsed.issues)).not.toContain(PII_ID_CARD);
        expect(JSON.stringify(parsed.issues)).not.toContain(PII_SECRET);
      }
    }
  });

  it('标记已读状态机是纯函数：unread → read 只改状态与时间，read 是终态', () => {
    const unread = fixtureNotification();
    const now = '2026-01-07T08:09:10.000Z';

    const marked = markNotificationRead(unread, now);
    expect(marked.changed).toBe(true);
    expect(marked.record.status).toBe(NotificationStatus.Read);
    expect(marked.record.readAt).toBe(now);
    expect(marked.record.updatedAt).toBe(now);
    expect(marked.record.userId).toBe(unread.userId);
    expect(marked.record.type).toBe(unread.type);
    expect(marked.record.title).toBe(unread.title);
    expect(marked.record.body).toBe(unread.body);
    expect(marked.record.createdAt).toBe(unread.createdAt);
    expect(parseStoredNotification(marked.record).ok).toBe(true);

    const read = { ...unread, status: NotificationStatus.Read, readAt: '2026-01-02T03:04:05.000Z' };
    const again = markNotificationRead(read, now);
    expect(again.changed).toBe(false);
    expect(again.record).toBe(read);
    expect(again.record.readAt).toBe('2026-01-02T03:04:05.000Z');
  });

  it('查询串闭集门禁：无查询不报错，出现任何参数都抛 ZodError（服务端声明可区分）', () => {
    expect(() => assertDeclaredNotificationQueryFields({})).not.toThrow();
    expect(() => assertDeclaredNotificationQueryFields(undefined)).not.toThrow();
    expect(() => assertDeclaredNotificationQueryFields(null)).not.toThrow();
    expect(NOTIFICATION_QUERY_FIELDS).toEqual([]);

    const forbidden = captureZodError(() =>
      assertDeclaredNotificationQueryFields({ userId: 'u-1' }),
    );
    expect(forbidden?.issues[0]?.message).toContain('禁止使用查询参数 userId');
    const claim = captureZodError(() => assertDeclaredNotificationQueryFields({ groupId: 'g-1' }));
    expect(claim?.issues[0]?.message).toContain('禁止使用查询参数 groupId');
    const filter = captureZodError(() =>
      assertDeclaredNotificationQueryFields({ unreadOnly: 'true' }),
    );
    expect(filter?.issues[0]?.message).toContain('不接受查询参数 unreadOnly');
  });

  it('请求体闭集门禁：空体不报错，服务端字段与未声明字段给出可区分的拒绝原因', () => {
    expect(() => assertNoNotificationPatchBodyFields({})).not.toThrow();
    expect(() => assertNoNotificationPatchBodyFields(undefined)).not.toThrow();
    expect(() => assertNoNotificationPatchBodyFields(null)).not.toThrow();

    const serverOwned = captureZodError(() =>
      assertNoNotificationPatchBodyFields({ status: 'read' }),
    );
    expect(serverOwned?.issues[0]?.message).toBe('禁止设置服务端字段 status');
    const ownership = captureZodError(() =>
      assertNoNotificationPatchBodyFields({ userId: STUDENT_2 }),
    );
    expect(ownership?.issues[0]?.message).toBe('禁止设置服务端字段 userId');
    const undeclared = captureZodError(() =>
      assertNoNotificationPatchBodyFields({ title: '被改写' }),
    );
    expect(undeclared?.issues[0]?.message).toBe('本端点不接受请求体字段 title');
  });

  it('完整 AppModule：health / runtime-info 与既有路由行为不变，通知路由默认 401', async () => {
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
      '/me/matching-requests',
      '/me/statistics',
      '/groups',
      '/me/notifications',
    ]) {
      const res = await call(baseUrl, 'GET', path);
      expect(res.status).toBe(401);
      expect(res.body.error?.code).toBe('UNAUTHENTICATED');
    }

    const mark = await call(baseUrl, 'PATCH', `/me/notifications/${UNKNOWN_NOTIFICATION_ID}/read`, {
      body: {},
    });
    expect(mark.status).toBe(401);
    expect(mark.body.error?.code).toBe('UNAUTHENTICATED');
  });
});

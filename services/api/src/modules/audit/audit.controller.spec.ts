import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
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
import { ConfigModule } from '../../config/config.module';
import { loadEnv } from '../../config/env';
import { AccessControlModule } from '../access-control/access-control.module';
import { AuthModule } from '../auth/auth.module';
import { InMemorySessionStore } from '../auth/session-store.in-memory';
import { RUOYI_AUTHZ_ADAPTER } from '../ruoyi-adapter/ruoyi-adapter.port';
import type { RuoYiAuthzAdapter } from '../ruoyi-adapter/ruoyi-adapter.port';
import {
  AUDIT_EVENT_VIEW_FIELDS,
  AUDIT_EVENT_VIEW_REQUIRED_FIELDS,
  AUDIT_QUERY_FIELDS,
  AUDIT_READ_BODY_FIELDS,
  SELF_AUDIT_READ_SUMMARY,
  UNKNOWN_PEER_ADDRESS,
  assertDeclaredAuditQueryFields,
  assertNoAuditReadBodyFields,
  hashPeerAddress,
  parseAuditEventView,
  parseStoredAuditEvent,
  toAuditEventView,
  toAuditRequestContext,
} from './audit.contract';
import type { AuditEventView } from './audit.contract';
import { AuditController } from './audit.controller';
import { InMemoryAuditRepository } from './audit.in-memory-repository';
import {
  AUDIT_EVENT_TYPE_VALUES,
  AUDIT_REPOSITORY,
  AUDIT_RESOURCE_TYPE_VALUES,
  AUDIT_RESULT_VALUES,
  AuditEventType,
  AuditResourceType,
  AuditResult,
} from './audit.port';
import type { AuditEvent } from './audit.port';
import { AuditService } from './audit.service';
import { AuditModule } from './audit.module';

/**
 * 审计切片（`/me/audit-events`）的真实 HTTP 回归：
 *
 * - 成功：本人可查看事件的脱敏摘要（200，`data` 是白名单闭集数组、按追加顺序、只含「主体本人
 *   **且** 标记本人可见」的记录）；「仅管理端可见」与「仅他人所有」的记录不出现在任何响应文本里；
 *   空审计稳定返回 `[]`；
 * - 服务端写入：成功请求自身追加一条 `audit_self_events_read` 事件（「先读后记」），
 *   其主体/结果/时间/关联 ID/网络归属全部由服务端生成——伪造的请求体、查询串与自定义头
 *   （`x-user-id`/`x-actor-user-id`/`x-roles`/`x-scope`/`x-request-id`/`x-forwarded-for`…）
 *   都进不了审计；
 * - 认证 401：无凭证、scheme 不对、凭证过短、会话不存在、会话主体含未登记角色（fail-closed），
 *   且认证失败时既不取数也不写入审计；
 * - 越权 403：角色缺权限点或默认范围不是 `SELF`（admin / group_leader）→ 同一个 403，
 *   且**仓储方法一次都没被调用**（未授权请求没有取数，也没有写入副作用）；
 * - 输入 400：查询串声明（`?actorUserId=`/`?userId=`/`?roles=`/`?scope=`/`?ip=`/`?requestId=`/
 *   `?result=`/`?selfVisible=`/`?page=`…）与请求体字段（`actorUserId`/`result`/`ipHash`/
 *   `requestId`/`selfVisible`/`type`/`summary`…）一律拒绝（服务端字段与未声明字段的拒绝原因可区分），
 *   且不触发取数与写入；未注册的路由/方法形态返回 404，证明只新增了一条 GET 路由；
 * - 统一安全边界 500：他人记录、未标记本人可见的记录、归属不可读或形态非法的记录、
 *   未知枚举与多出字段、明文 IP、摘要含 PII 一律 fail-closed（500），响应与日志都不含取值，
 *   且完整性失败不产生写入；
 * - 存储异常：取数或写入抛异常 → 500，响应不含错误名/堆栈/原文；审计不可用时不返回
 *   「看起来成功但没有审计」的响应；
 * - 既有路由回归：同一 `AppModule` 下 health / runtime-info 与既有切片路由行为不变，
 *   新路由在默认装配（无会话）下 401。
 *
 * 说明：测试用真实 Nest 应用 + 真实 HTTP（与其它切片的 controller spec 同构），
 * 只通过 DI 令牌/端口注入测试夹具（会话、审计记录），不替换任何生产代码路径。
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

/** 高敏内容：18 位身份证号（`id_card` 命中）与疑似密钥（`secret_like` 命中） */
const PII_ID_CARD = '110101199003071234';
const PII_SECRET = 'api_key: sk-abcdefghijkl';
/** 他人审计摘要里的联系方式：不在本人响应中出现（他人内容不外发） */
const OTHER_PHONE = '13800000000';
/** 客户端伪造的网络归属：绝不能变成审计里的对端地址 */
const FORGED_ADDRESS = '203.0.113.7';
/** 客户端伪造的传输层跟踪 ID：只作为响应 meta，不进入审计 */
const FORGED_REQUEST_ID = 'client-trace-00000001';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;

/** 真实 HTTP 下对端必然是回环地址（应用监听 127.0.0.1），两种形态都接受 */
const LOOPBACK_HASHES: readonly string[] = [
  hashPeerAddress('127.0.0.1'),
  hashPeerAddress('::ffff:127.0.0.1'),
];

const startedApps: INestApplication[] = [];

/** 输出白名单的字符串视图：用于断言响应里没有白名单之外的键 */
const VIEW_WHITELIST: readonly string[] = AUDIT_EVENT_VIEW_FIELDS;

@Module({
  imports: [ConfigModule, AuditModule],
  providers: [
    { provide: APP_INTERCEPTOR, useClass: ApiResponseInterceptor },
    { provide: APP_FILTER, useClass: ApiExceptionFilter },
  ],
})
class AuditHttpModule {}

/** 夹具：本人可见三条（成功/成功/被拒绝）、仅管理端可见一条、他人一条 */
interface SeededAuditEvents {
  readonly ownProfileUpdate: AuditEvent;
  readonly ownApplication: AuditEvent;
  readonly ownDenied: AuditEvent;
  readonly ownAdminOnly: AuditEvent;
  readonly otherVisible: AuditEvent;
}

interface TestApp {
  readonly app: INestApplication;
  readonly baseUrl: string;
  readonly store: InMemorySessionStore;
  readonly repository: InMemoryAuditRepository;
  readonly seeded: SeededAuditEvents;
}

/** 测试夹具记录：主体与可见性由调用方指定，模拟「存储里已存在他人/管理端记录」 */
function fixtureEvent(overrides: Partial<AuditEvent> = {}): AuditEvent {
  const base: AuditEvent = {
    id: randomUUID(),
    actorUserId: STUDENT_1,
    type: AuditEventType.ProfileSelfUpdate,
    result: AuditResult.Success,
    resourceType: AuditResourceType.StudentProfile,
    summary: '提交本人画像更新',
    selfVisible: true,
    requestId: randomUUID(),
    ipHash: hashPeerAddress('127.0.0.1'),
    occurredAt: '2026-01-05T00:00:00.000Z',
  };
  return { ...base, ...overrides };
}

/** 夹具内容固定，便于断言顺序、结果闭集与「他人/管理端内容不出现」 */
function buildSeededEvents(): SeededAuditEvents {
  return {
    ownProfileUpdate: fixtureEvent({
      id: '11111111-1111-4111-8111-111111111111',
      type: AuditEventType.ProfileSelfUpdate,
      result: AuditResult.Success,
      resourceType: AuditResourceType.StudentProfile,
      summary: '提交本人画像更新',
      occurredAt: '2026-01-05T00:00:00.000Z',
    }),
    ownApplication: fixtureEvent({
      id: '22222222-2222-4222-8222-222222222222',
      type: AuditEventType.MembershipApply,
      result: AuditResult.Success,
      resourceType: AuditResourceType.Membership,
      summary: '提交入组申请',
      occurredAt: '2026-01-05T01:00:00.000Z',
    }),
    ownDenied: fixtureEvent({
      id: '33333333-3333-4333-8333-333333333333',
      type: AuditEventType.MatchingRequest,
      result: AuditResult.Denied,
      resourceType: AuditResourceType.MatchingRequest,
      summary: '匹配请求未被接受',
      occurredAt: '2026-01-05T02:00:00.000Z',
    }),
    ownAdminOnly: fixtureEvent({
      id: '44444444-4444-4444-8444-444444444444',
      type: AuditEventType.MembershipReview,
      result: AuditResult.Success,
      resourceType: AuditResourceType.Membership,
      summary: '审核本人入组申请（仅管理端可见）',
      selfVisible: false,
      occurredAt: '2026-01-05T03:00:00.000Z',
    }),
    otherVisible: fixtureEvent({
      id: '55555555-5555-4555-8555-555555555555',
      actorUserId: STUDENT_2,
      type: AuditEventType.ProfileSelfUpdate,
      result: AuditResult.Success,
      resourceType: AuditResourceType.StudentProfile,
      summary: `提交本人画像更新，联系电话 ${OTHER_PHONE}`,
      occurredAt: '2026-01-05T04:00:00.000Z',
    }),
  };
}

/** 启动真实应用并注入会话夹具（内存基线的显式 seed，不做隐式全局状态） */
async function startAuditApp(options: { readonly seed?: boolean } = {}): Promise<TestApp> {
  const app = await NestFactory.create(AuditHttpModule, { logger: false });
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

  const repository = app.get(InMemoryAuditRepository);
  const seeded = buildSeededEvents();
  if (options.seed !== false) {
    repository.append(seeded.ownProfileUpdate);
    repository.append(seeded.ownApplication);
    repository.append(seeded.ownDenied);
    repository.append(seeded.ownAdminOnly);
    repository.append(seeded.otherVisible);
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
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
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

function viewsOf(body: ApiEnvelope<unknown>): AuditEventView[] {
  return body.data as AuditEventView[];
}

/**
 * 响应中「业务内容」部分的文本：去掉 `meta`（`requestId` 是随机 UUID 或客户端跟踪 ID、
 * `generatedAt` 是时间戳）与 `error.requestId`。泄露与「逐字段相同」的断言必须建立在这部分上，
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

/** 存储里「本人读取审计摘要」事件（本切片写入的唯一事件类型），按追加顺序 */
function readEventsOf(
  repository: InMemoryAuditRepository,
  actorUserId: string,
): readonly AuditEvent[] {
  return repository
    .listVisibleByActor(actorUserId)
    .filter((event) => event.type === AuditEventType.SelfAuditEventsRead);
}

afterAll(async () => {
  await Promise.all(startedApps.map((app) => app.close()));
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('审计切片：成功路径（真实 HTTP + 统一响应信封）', () => {
  it('学生本人：200，data 是白名单闭集数组，按追加顺序只含本人可查看的事件', async () => {
    const { baseUrl, seeded } = await startAuditApp();

    const res = await call(baseUrl, 'GET', '/me/audit-events', {
      headers: { ...bearer(SESSION_STUDENT_1), 'x-request-id': 'test-request-1' },
    });

    expect(res.status).toBe(200);
    expect(res.body.error).toBeNull();
    expect(res.body.meta.requestId).toBe('test-request-1');
    expect(typeof res.body.meta.generatedAt).toBe('string');

    const views = viewsOf(res.body);
    expect(views.map((view) => view.id)).toEqual([
      seeded.ownProfileUpdate.id,
      seeded.ownApplication.id,
      seeded.ownDenied.id,
    ]);
    // 逐字段投影：类型、结果、资源类型、摘要与时间都等于存储值（未被改写）
    expect(views.map((view) => view.type)).toEqual([
      AuditEventType.ProfileSelfUpdate,
      AuditEventType.MembershipApply,
      AuditEventType.MatchingRequest,
    ]);
    expect(views.map((view) => view.result)).toEqual([
      AuditResult.Success,
      AuditResult.Success,
      AuditResult.Denied,
    ]);
    expect(views[2]?.resourceType).toBe(AuditResourceType.MatchingRequest);
    expect(views[0]?.summary).toBe(seeded.ownProfileUpdate.summary);
    expect(views[0]?.occurredAt).toBe(seeded.ownProfileUpdate.occurredAt);

    for (const view of views) {
      // 输出白名单：每个字段都在白名单内，且必需字段齐全（闭集，无第七类信息）
      expect(Object.keys(view).every((key) => VIEW_WHITELIST.includes(key))).toBe(true);
      for (const field of AUDIT_EVENT_VIEW_REQUIRED_FIELDS) {
        expect(view).toHaveProperty(field);
      }
    }

    // 归属、关联 ID、网络归属哈希与可见性口径都不随响应回传
    const content = contentText(res);
    expect(content).not.toContain(STUDENT_1);
    expect(content).not.toContain(STUDENT_2);
    for (const field of [
      'actorUserId',
      'userId',
      'roles',
      'scope',
      'groupId',
      'requestId',
      'ipHash',
      'selfVisible',
      'resourceId',
    ]) {
      expect(content).not.toContain(`"${field}"`);
    }
  });

  it('仅管理端可见与仅他人所有的记录不出现在本人摘要里（含他人联系方式）', async () => {
    const { baseUrl, seeded } = await startAuditApp();

    const res = await call(baseUrl, 'GET', '/me/audit-events', {
      headers: bearer(SESSION_STUDENT_1),
    });

    expect(res.status).toBe(200);
    const content = contentText(res);
    for (const leaked of [
      seeded.ownAdminOnly.id,
      seeded.ownAdminOnly.summary,
      seeded.otherVisible.id,
      seeded.otherVisible.summary,
      OTHER_PHONE,
      STUDENT_2,
    ]) {
      expect(content).not.toContain(leaked);
    }
    expect(viewsOf(res.body)).toHaveLength(3);
  });

  it('空审计：未预置任何记录时稳定返回空数组，成功请求仍写入一条服务端审计事件', async () => {
    const { baseUrl, repository } = await startAuditApp({ seed: false });

    const first = await call(baseUrl, 'GET', '/me/audit-events', {
      headers: bearer(SESSION_STUDENT_1),
    });
    expect(first.status).toBe(200);
    expect(first.body.error).toBeNull();
    expect(viewsOf(first.body)).toEqual([]);

    // 「读一次审计 = 多一条审计」：空审计的读取同样留痕，但本次响应只反映请求到达前的事件
    const events = readEventsOf(repository, STUDENT_1);
    expect(events).toHaveLength(1);
    expect(events[0]?.actorUserId).toBe(STUDENT_1);

    // 第二次读取能看到第一次的读取事件（追加写对后续请求可见）
    const second = await call(baseUrl, 'GET', '/me/audit-events', {
      headers: bearer(SESSION_STUDENT_1),
    });
    expect(second.status).toBe(200);
    expect(viewsOf(second.body).map((view) => view.type)).toEqual([
      AuditEventType.SelfAuditEventsRead,
    ]);
  });

  it('先读后记：本次响应不含自身事件，下一次读取才可见；既有记录只被追加、从不改写', async () => {
    const { baseUrl, repository, seeded } = await startAuditApp();
    const before: readonly AuditEvent[] = repository.listVisibleByActor(STUDENT_1);

    const first = await call(baseUrl, 'GET', '/me/audit-events', {
      headers: bearer(SESSION_STUDENT_1),
    });
    expect(first.status).toBe(200);
    const firstViews = viewsOf(first.body);
    expect(firstViews.map((view) => view.id)).toEqual([
      seeded.ownProfileUpdate.id,
      seeded.ownApplication.id,
      seeded.ownDenied.id,
    ]);
    expect(firstViews.some((view) => view.type === AuditEventType.SelfAuditEventsRead)).toBe(false);

    // 请求结束后存储里多了一条读取事件，且既有三条逐字段不变
    const afterFirst: readonly AuditEvent[] = repository.listVisibleByActor(STUDENT_1);
    expect(afterFirst).toHaveLength(before.length + 1);
    expect(afterFirst.slice(0, 3)).toEqual([
      seeded.ownProfileUpdate,
      seeded.ownApplication,
      seeded.ownDenied,
    ]);

    const second = await call(baseUrl, 'GET', '/me/audit-events', {
      headers: bearer(SESSION_STUDENT_1),
    });
    const secondViews = viewsOf(second.body);
    expect(secondViews.map((view) => view.id)).toEqual([
      seeded.ownProfileUpdate.id,
      seeded.ownApplication.id,
      seeded.ownDenied.id,
      afterFirst[3]?.id,
    ]);
    expect(secondViews[3]?.type).toBe(AuditEventType.SelfAuditEventsRead);
    expect(secondViews[3]?.result).toBe(AuditResult.Success);
    expect(secondViews[3]?.summary).toBe(SELF_AUDIT_READ_SUMMARY);
  });

  it('审计写入的字段全部由服务端生成：主体、结果、时间、关联 ID、网络归属', async () => {
    const { baseUrl, repository } = await startAuditApp();
    const before = new Date().toISOString();

    const res = await call(baseUrl, 'GET', '/me/audit-events', {
      headers: { ...bearer(SESSION_STUDENT_1), 'x-request-id': FORGED_REQUEST_ID },
    });
    const after = new Date().toISOString();
    expect(res.status).toBe(200);

    const events = readEventsOf(repository, STUDENT_1);
    expect(events).toHaveLength(1);
    const event = events[0];

    // 主体来自服务端会话，不是任何客户端声明
    expect(event?.actorUserId).toBe(STUDENT_1);
    expect(event?.type).toBe(AuditEventType.SelfAuditEventsRead);
    expect(event?.result).toBe(AuditResult.Success);
    expect(event?.resourceType).toBe(AuditResourceType.AuditEvent);
    expect(event?.summary).toBe(SELF_AUDIT_READ_SUMMARY);
    expect(event?.selfVisible).toBe(true);

    // 时间来自服务端时钟（请求到达时间），可被上下界约束
    expect(event?.occurredAt).toMatch(/^\d{4}-\d{2}-\d{2}T/u);
    expect(Number.isFinite(Date.parse(event?.occurredAt ?? ''))).toBe(true);
    expect((event?.occurredAt ?? '') >= before).toBe(true);
    expect((event?.occurredAt ?? '') <= after).toBe(true);

    // 事件 ID 与关联 ID 都是服务端 UUID；客户端提交的跟踪 ID 不进入审计
    expect(event?.id).toMatch(UUID_PATTERN);
    expect(event?.requestId).toMatch(UUID_PATTERN);
    expect(event?.requestId).not.toBe(FORGED_REQUEST_ID);

    // 网络归属是传输层对端地址的哈希（回环地址），不是明文、也不是客户端头
    expect(event?.ipHash).toMatch(SHA256_PATTERN);
    expect(LOOPBACK_HASHES).toContain(event?.ipHash);
    expect('ip' in (event ?? {})).toBe(false);
    expect(JSON.stringify(event)).not.toContain(FORGED_ADDRESS);
  });

  it('IP 不可伪造：伪造转发头不改变 ipHash，明文 IP 不入库也不外发', async () => {
    const { baseUrl, repository } = await startAuditApp();

    const res = await call(baseUrl, 'GET', '/me/audit-events', {
      headers: {
        ...bearer(SESSION_STUDENT_1),
        'x-forwarded-for': FORGED_ADDRESS,
        'x-real-ip': FORGED_ADDRESS,
        'x-ip': FORGED_ADDRESS,
      },
    });

    expect(res.status).toBe(200);
    const event = readEventsOf(repository, STUDENT_1)[0];
    expect(LOOPBACK_HASHES).toContain(event?.ipHash);
    expect(event?.ipHash).not.toBe(hashPeerAddress(FORGED_ADDRESS));
    expect(JSON.stringify(event)).not.toContain(FORGED_ADDRESS);

    const content = contentText(res);
    expect(content).not.toContain(FORGED_ADDRESS);
    expect(content).not.toContain('127.0.0.1');
    expect(content).not.toContain(hashPeerAddress('127.0.0.1'));
  });

  it('requestId 不可伪造：客户端跟踪 ID 只作响应 meta，重复提交不会得到同一个审计关联 ID', async () => {
    const { baseUrl, repository } = await startAuditApp();
    const headers = { ...bearer(SESSION_STUDENT_1), 'x-request-id': FORGED_REQUEST_ID };

    const first = await call(baseUrl, 'GET', '/me/audit-events', { headers });
    const second = await call(baseUrl, 'GET', '/me/audit-events', { headers });

    // 既有传输层行为不变：客户端跟踪 ID 仍只作为响应 meta 回显
    expect(first.body.meta.requestId).toBe(FORGED_REQUEST_ID);
    expect(second.body.meta.requestId).toBe(FORGED_REQUEST_ID);

    const events = readEventsOf(repository, STUDENT_1);
    expect(events).toHaveLength(2);
    for (const event of events) {
      expect(event.requestId).toMatch(UUID_PATTERN);
      expect(event.requestId).not.toBe(FORGED_REQUEST_ID);
    }
    expect(events[0]?.requestId).not.toBe(events[1]?.requestId);
  });

  it('判定入参全部来自服务端：权限点是常量、范围恒为 SELF、归属是会话主体', async () => {
    const { app, baseUrl } = await startAuditApp();
    const adapter = app.get<RuoYiAuthzAdapter>(RUOYI_AUTHZ_ADAPTER);
    const checkAuthorization = vi.spyOn(adapter, 'checkAuthorization');

    const res = await call(baseUrl, 'GET', '/me/audit-events', {
      headers: bearer(SESSION_STUDENT_1),
    });
    expect(res.status).toBe(200);

    expect(checkAuthorization).toHaveBeenCalledTimes(1);
    expect(checkAuthorization).toHaveBeenNthCalledWith(
      1,
      { userId: STUDENT_1, roles: [Role.Student] },
      {
        permission: PermissionPoint.ProfileSelfRead,
        scope: DataScope.Self,
        resourceUserId: STUDENT_1,
      },
    );
  });
});

describe('审计切片：认证边界 401（fail-closed）', () => {
  const unauthenticatedCases: ReadonlyArray<{ name: string; headers: Record<string, string> }> = [
    { name: '未携带 Authorization', headers: {} },
    { name: 'scheme 不是 Bearer', headers: { authorization: `Token ${SESSION_STUDENT_1}` } },
    { name: 'Bearer 凭证过短', headers: { authorization: 'Bearer short' } },
    { name: '会话不存在', headers: bearer('session-does-not-exist') },
    { name: '会话主体含未登记角色', headers: bearer(SESSION_UNKNOWN_ROLE) },
  ];

  it.each(unauthenticatedCases)(
    '$name → 401 UNAUTHENTICATED，且不取数、不写入审计',
    async ({ headers }) => {
      const { baseUrl, repository } = await startAuditApp();
      const list = vi.spyOn(repository, 'listVisibleByActor');
      const append = vi.spyOn(repository, 'append');

      const res = await call(baseUrl, 'GET', '/me/audit-events', { headers });

      expect(res.status).toBe(401);
      expect(res.body.data).toBeNull();
      expect(res.body.error?.code).toBe('UNAUTHENTICATED');
      // 不区分失败原因，避免给探测者额外信息
      expect(res.body.error?.message).toBe('登录状态无效或已过期，请重新登录');
      // 认证失败发生在任何取数与写入之前
      expect(list).not.toHaveBeenCalled();
      expect(append).not.toHaveBeenCalled();
      expect(contentText(res)).not.toContain(SESSION_UNKNOWN_ROLE);
      expect(contentText(res)).not.toContain('guest');
    },
  );

  it('未认证时即便带了查询串/伪造头/请求体也是 401（认证先于一切输入）', async () => {
    const { baseUrl, repository } = await startAuditApp();
    const list = vi.spyOn(repository, 'listVisibleByActor');
    const append = vi.spyOn(repository, 'append');

    const res = await call(baseUrl, 'GET', '/me/audit-events?actorUserId=u-student-2', {
      headers: { 'x-roles': 'super_admin', 'x-scope': 'GLOBAL' },
      body: { result: AuditResult.Success, actorUserId: STUDENT_2 },
    });

    expect(res.status).toBe(401);
    expect(res.body.error?.code).toBe('UNAUTHENTICATED');
    expect(list).not.toHaveBeenCalled();
    expect(append).not.toHaveBeenCalled();
  });
});

describe('审计切片：越权 403（AuthorizationGuard + 服务端资源判定）', () => {
  it.each([
    { name: 'admin（范围 ASSIGNED，不是 SELF）', session: SESSION_ADMIN_1, actor: ADMIN_1 },
    { name: 'group_leader（范围 GROUP，不是 SELF）', session: SESSION_LEADER_1, actor: LEADER_1 },
  ])('$name 读取本人审计摘要：403 FORBIDDEN，不取数、不写入审计', async ({ session, actor }) => {
    const { baseUrl, repository, seeded } = await startAuditApp();
    const list = vi.spyOn(repository, 'listVisibleByActor');
    const append = vi.spyOn(repository, 'append');

    const res = await call(baseUrl, 'GET', '/me/audit-events', {
      headers: bearer(session),
    });

    expect(res.status).toBe(403);
    expect(res.body.data).toBeNull();
    expect(res.body.error?.code).toBe('FORBIDDEN');
    expect(res.body.error?.message).toBe('无权执行该操作');
    // 授权先于一切：既没有取数，也没有审计写入（未授权请求没有写入副作用）
    expect(list).not.toHaveBeenCalled();
    expect(append).not.toHaveBeenCalled();
    // 403 不携带任何资源信息：摘要、归属与他人的联系方式都不出现
    const content = contentText(res);
    for (const leaked of [
      STUDENT_1,
      actor,
      seeded.ownProfileUpdate.summary,
      seeded.otherVisible.summary,
      OTHER_PHONE,
    ]) {
      expect(content).not.toContain(leaked);
    }
  });

  it('越权请求不产生写入：存储里没有该主体的审计事件，也没有新增任何记录', async () => {
    const { baseUrl, repository } = await startAuditApp();
    const before = repository.listVisibleByActor(ADMIN_1);

    const res = await call(baseUrl, 'GET', '/me/audit-events', {
      headers: bearer(SESSION_ADMIN_1),
    });

    expect(res.status).toBe(403);
    expect(before).toEqual([]);
    expect(repository.listVisibleByActor(ADMIN_1)).toEqual([]);
  });
});

describe('审计切片：输入拒绝 400（VALIDATION_FAILED，不取数/不落库）', () => {
  it('查询串闭集：出现任何查询参数都 400，且不触发取数与写入', async () => {
    const cases: ReadonlyArray<{ readonly query: string; readonly expected: string }> = [
      { query: 'actorUserId=u-student-2', expected: '禁止使用查询参数 actorUserId' },
      { query: 'userId=u-student-2', expected: '禁止使用查询参数 userId' },
      { query: 'roles=super_admin', expected: '禁止使用查询参数 roles' },
      { query: 'scope=GLOBAL', expected: '禁止使用查询参数 scope' },
      { query: 'ip=203.0.113.7', expected: '禁止使用查询参数 ip' },
      { query: 'requestId=abc', expected: '禁止使用查询参数 requestId' },
      { query: 'result=success', expected: '禁止使用查询参数 result' },
      { query: 'selfVisible=true', expected: '禁止使用查询参数 selfVisible' },
      { query: 'groupId=g-1', expected: '禁止使用查询参数 groupId' },
      { query: 'page=1&pageSize=10', expected: '本端点不接受查询参数 page' },
    ];

    for (const { query, expected } of cases) {
      const { baseUrl, repository } = await startAuditApp();
      const list = vi.spyOn(repository, 'listVisibleByActor');
      const append = vi.spyOn(repository, 'append');

      const res = await call(baseUrl, 'GET', `/me/audit-events?${query}`, {
        headers: bearer(SESSION_STUDENT_1),
      });

      expect(res.status).toBe(400);
      expect(res.body.data).toBeNull();
      expect(res.body.error?.code).toBe('VALIDATION_FAILED');
      const messages = issuesOf(res.body).map((issue) => issue.message);
      expect(messages.some((message) => message.includes(expected))).toBe(true);
      expect(list).not.toHaveBeenCalled();
      expect(append).not.toHaveBeenCalled();
      // 拒绝原因只给字段名，不回显提交的取值
      expect(contentText(res)).not.toContain('u-student-2');
    }
  });

  it('查询串闭集：重复参数同样 400（键名违规，不被解析为合法输入）', async () => {
    const { baseUrl } = await startAuditApp();

    const res = await call(
      baseUrl,
      'GET',
      '/me/audit-events?actorUserId=u-student-1&actorUserId=u-student-2',
      { headers: bearer(SESSION_STUDENT_1) },
    );

    expect(res.status).toBe(400);
    expect(res.body.error?.code).toBe('VALIDATION_FAILED');
  });

  it('空查询串（`?`）不算输入：仍然 200 且返回本人摘要', async () => {
    const { baseUrl } = await startAuditApp();

    const res = await call(baseUrl, 'GET', '/me/audit-events?', {
      headers: bearer(SESSION_STUDENT_1),
    });

    expect(res.status).toBe(200);
    expect(viewsOf(res.body)).toHaveLength(3);
  });

  const injectedBodyFields: ReadonlyArray<{ readonly name: string; readonly body: unknown }> = [
    { name: 'actorUserId', body: { actorUserId: STUDENT_2 } },
    { name: 'userId', body: { userId: STUDENT_2 } },
    { name: 'roles/scope', body: { roles: [Role.SuperAdmin], scope: DataScope.Global } },
    { name: 'ipHash', body: { ipHash: hashPeerAddress(FORGED_ADDRESS) } },
    { name: 'ip/remoteAddress', body: { ip: FORGED_ADDRESS, remoteAddress: FORGED_ADDRESS } },
    { name: 'requestId', body: { requestId: FORGED_REQUEST_ID } },
    { name: 'result', body: { result: AuditResult.Success } },
    { name: 'selfVisible', body: { selfVisible: true } },
    { name: 'type/summary', body: { type: AuditEventType.MembershipReview, summary: '被改写' } },
    { name: 'occurredAt', body: { occurredAt: '2026-01-01T00:00:00.000Z' } },
  ];

  it.each(injectedBodyFields)(
    '请求体闭集：拒绝服务端字段（$name）：400，且不取数、不写入',
    async ({ body }) => {
      const { baseUrl, repository } = await startAuditApp();
      const list = vi.spyOn(repository, 'listVisibleByActor');
      const append = vi.spyOn(repository, 'append');

      const res = await call(baseUrl, 'GET', '/me/audit-events', {
        headers: bearer(SESSION_STUDENT_1),
        body,
      });

      expect(res.status).toBe(400);
      expect(res.body.data).toBeNull();
      expect(res.body.error?.code).toBe('VALIDATION_FAILED');
      expect(issuesOf(res.body).length).toBeGreaterThan(0);
      expect(list).not.toHaveBeenCalled();
      expect(append).not.toHaveBeenCalled();
    },
  );

  it('客户端伪造服务端字段的拒绝原因可区分：服务端字段 vs 未声明字段', async () => {
    const { baseUrl } = await startAuditApp();

    const res = await call(baseUrl, 'GET', '/me/audit-events', {
      headers: bearer(SESSION_STUDENT_1),
      body: { result: AuditResult.Success, actorUserId: STUDENT_2, note: '被改写' },
    });

    expect(res.status).toBe(400);
    const messages = issuesOf(res.body).map((issue) => issue.message);
    expect(messages).toContain('禁止设置服务端字段 result');
    expect(messages).toContain('禁止设置服务端字段 actorUserId');
    expect(messages).toContain('本端点不接受请求体字段 note');
    expect(contentText(res)).not.toContain(STUDENT_2);
    expect(contentText(res)).not.toContain('被改写');
  });

  it('未注册的路由/方法形态不产生新行为：只新增了一条 GET 路由（其余 404）', async () => {
    const { baseUrl, seeded } = await startAuditApp();

    const shapes: ReadonlyArray<readonly ['GET' | 'POST' | 'PATCH' | 'DELETE', string]> = [
      ['GET', `/me/audit-events/${seeded.ownProfileUpdate.id}`],
      ['GET', '/me/audit-event'],
      ['POST', '/me/audit-events'],
      ['PATCH', '/me/audit-events'],
      ['DELETE', '/me/audit-events'],
    ];

    for (const [method, path] of shapes) {
      const res = await call(baseUrl, method, path, { headers: bearer(SESSION_STUDENT_1) });
      expect(res.status).toBe(404);
      expect(res.body.error?.code).toBe('NOT_FOUND');
    }
  });
});

describe('审计切片：claims 伪造（客户端声明不进入判定、取数与写入）', () => {
  const forgedHeaders = {
    'x-user-id': STUDENT_2,
    'x-actor-user-id': STUDENT_2,
    'x-owner-user-id': STUDENT_2,
    'x-roles': 'super_admin,admin',
    'x-scope': 'GLOBAL',
    'x-group-id': 'g-1',
    'x-ip': FORGED_ADDRESS,
    'x-forwarded-for': FORGED_ADDRESS,
    'x-real-ip': FORGED_ADDRESS,
    'x-request-id': FORGED_REQUEST_ID,
  };

  it('伪造自定义头不能改变取数主体与写入主体：仍只读/只写会话主体本人', async () => {
    const { app, baseUrl, repository, seeded } = await startAuditApp();
    const adapter = app.get<RuoYiAuthzAdapter>(RUOYI_AUTHZ_ADAPTER);
    const checkAuthorization = vi.spyOn(adapter, 'checkAuthorization');

    const res = await call(baseUrl, 'GET', '/me/audit-events', {
      headers: { ...bearer(SESSION_STUDENT_1), ...forgedHeaders },
    });

    expect(res.status).toBe(200);
    expect(viewsOf(res.body).map((view) => view.id)).toEqual([
      seeded.ownProfileUpdate.id,
      seeded.ownApplication.id,
      seeded.ownDenied.id,
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

    // 写入的主体、网络归属与关联 ID 同样不受伪造头影响
    const event = readEventsOf(repository, STUDENT_1)[0];
    expect(event?.actorUserId).toBe(STUDENT_1);
    expect(LOOPBACK_HASHES).toContain(event?.ipHash);
    expect(event?.requestId).not.toBe(FORGED_REQUEST_ID);
    expect(readEventsOf(repository, STUDENT_2)).toHaveLength(0);
  });

  it('伪造头不能拿到他人或仅管理端可见的记录（可见范围只由服务端口径决定）', async () => {
    const { baseUrl, seeded } = await startAuditApp();

    const res = await call(baseUrl, 'GET', '/me/audit-events', {
      headers: { ...bearer(SESSION_STUDENT_1), ...forgedHeaders },
    });

    expect(res.status).toBe(200);
    const content = contentText(res);
    for (const leaked of [
      seeded.otherVisible.id,
      seeded.otherVisible.summary,
      seeded.ownAdminOnly.id,
      seeded.ownAdminOnly.summary,
      OTHER_PHONE,
      STUDENT_2,
      FORGED_ADDRESS,
    ]) {
      expect(content).not.toContain(leaked);
    }
  });

  it('伪造更高角色的声明不能让越权主体通过（admin + 伪造 SELF/超管声明仍是 403）', async () => {
    const { baseUrl, repository } = await startAuditApp();
    const append = vi.spyOn(repository, 'append');

    const res = await call(baseUrl, 'GET', '/me/audit-events', {
      headers: {
        ...bearer(SESSION_ADMIN_1),
        'x-user-id': ADMIN_1,
        'x-roles': 'super_admin',
        'x-scope': 'SELF',
      },
    });

    expect(res.status).toBe(403);
    expect(res.body.error?.code).toBe('FORBIDDEN');
    expect(append).not.toHaveBeenCalled();
  });
});

describe('审计切片：PII 与 fail-closed 500', () => {
  it('本人事件摘要含身份证号：整条 fail-closed 500，响应与日志都不含取值，且不写入审计', async () => {
    const errorLog = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const { baseUrl, repository } = await startAuditApp();
    const append = vi.spyOn(repository, 'append');
    repository.append(
      fixtureEvent({
        id: '66666666-6666-4666-8666-666666666666',
        summary: `证件核验记录 ${PII_ID_CARD}`,
      }),
    );
    append.mockClear();

    const res = await call(baseUrl, 'GET', '/me/audit-events', {
      headers: bearer(SESSION_STUDENT_1),
    });

    expect(res.status).toBe(500);
    expect(res.body.data).toBeNull();
    expect(res.body.error?.code).toBe('INTERNAL_ERROR');
    expect(res.body.error?.message).toBe('服务器内部错误，请稍后重试');
    // fail-closed：整条响应不含 PII 原文，也不含任何摘要（含同批次的干净记录）
    const content = contentText(res);
    for (const leaked of [
      PII_ID_CARD,
      '证件核验记录',
      '提交本人画像更新',
      '提交入组申请',
      STUDENT_1,
    ]) {
      expect(content).not.toContain(leaked);
    }
    // 完整性失败不产生写入（不把损坏数据放大成写入）
    expect(append).not.toHaveBeenCalled();
    // 日志只有字段路径与违规类型，没有取值
    const logs = errorLog.mock.calls.flat().join(' ');
    expect(logs).toContain('[audit]');
    expect(logs).toContain('summary');
    expect(logs).not.toContain(PII_ID_CARD);
    expect(logs).not.toContain('证件核验记录');
  });

  it('摘要含疑似密钥：同样 fail-closed 500，且不外发任何摘要', async () => {
    const errorLog = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const { baseUrl, repository } = await startAuditApp();
    repository.append(
      fixtureEvent({
        id: '77777777-7777-4777-8777-777777777777',
        summary: `凭据变更 ${PII_SECRET}`,
      }),
    );

    const res = await call(baseUrl, 'GET', '/me/audit-events', {
      headers: bearer(SESSION_STUDENT_1),
    });

    expect(res.status).toBe(500);
    expect(res.body.error?.code).toBe('INTERNAL_ERROR');
    expect(contentText(res)).not.toContain(PII_SECRET);
    expect(contentText(res)).not.toContain('凭据变更');
    const logs = errorLog.mock.calls.flat().join(' ');
    expect(logs).not.toContain(PII_SECRET);
  });

  it('未知事件类型/结果/资源类型、非法时间与形态、多出字段一律 500（闭集不作合法值外发）', async () => {
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const brokenRecords: ReadonlyArray<AuditEvent> = [
      fixtureEvent({ type: 'unknown_type' as AuditEventType }),
      fixtureEvent({ result: 'partial' as AuditResult }),
      fixtureEvent({ resourceType: 'unknown_resource' as AuditResourceType }),
      fixtureEvent({ occurredAt: '2026/01/05' }),
      fixtureEvent({ requestId: 'not-a-uuid' }),
      // 明文 IP（数据字典 §4：IP 只存哈希/脱敏）必须是存储损坏，不是「合法原始值」
      fixtureEvent({ ipHash: FORGED_ADDRESS }),
      fixtureEvent({ ipHash: '127.0.0.1' }),
      fixtureEvent({ id: 'not-a-uuid' }),
    ];

    for (const broken of brokenRecords) {
      const { baseUrl, repository } = await startAuditApp({ seed: false });
      repository.append(broken);

      const res = await call(baseUrl, 'GET', '/me/audit-events', {
        headers: bearer(SESSION_STUDENT_1),
      });

      expect(res.status).toBe(500);
      expect(res.body.data).toBeNull();
      expect(res.body.error?.code).toBe('INTERNAL_ERROR');
      expect(contentText(res)).not.toContain(broken.summary);
      expect(contentText(res)).not.toContain(broken.actorUserId);
    }
  });

  it('存储记录多出字段（存储与审计契约漂移）→ 500，且不外发多出的字段', async () => {
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const { baseUrl, repository } = await startAuditApp({ seed: false });
    repository.append({
      ...fixtureEvent({ summary: '提交本人画像更新' }),
      reason: `改前值 ${PII_ID_CARD}`,
    } as AuditEvent);

    const res = await call(baseUrl, 'GET', '/me/audit-events', {
      headers: bearer(SESSION_STUDENT_1),
    });

    expect(res.status).toBe(500);
    expect(res.body.error?.code).toBe('INTERNAL_ERROR');
    expect(contentText(res)).not.toContain(PII_ID_CARD);
    expect(contentText(res)).not.toContain('提交本人画像更新');
  });

  it('仓储返回对象/数组等非记录形态：500，响应不含返回值', async () => {
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const { baseUrl, repository } = await startAuditApp();
    vi.spyOn(repository, 'listVisibleByActor').mockReturnValue([
      {
        id: 'u-victim-9',
        name: '张三',
        studentNo: '2021001999',
        phone: OTHER_PHONE,
      } as unknown as AuditEvent,
    ]);

    const res = await call(baseUrl, 'GET', '/me/audit-events', {
      headers: bearer(SESSION_STUDENT_1),
    });

    expect(res.status).toBe(500);
    expect(res.body.data).toBeNull();
    const content = contentText(res);
    for (const leaked of ['u-victim-9', '张三', '2021001999', OTHER_PHONE]) {
      expect(content).not.toContain(leaked);
    }
  });

  it('仓储返回归属不一致的记录（未按主体过滤）→ 500，不把他人记录发给调用方', async () => {
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const { baseUrl, repository, seeded } = await startAuditApp();
    vi.spyOn(repository, 'listVisibleByActor').mockReturnValue([seeded.otherVisible]);

    const res = await call(baseUrl, 'GET', '/me/audit-events', {
      headers: bearer(SESSION_STUDENT_1),
    });

    expect(res.status).toBe(500);
    expect(res.body.error?.code).toBe('INTERNAL_ERROR');
    expect(contentText(res)).not.toContain(seeded.otherVisible.summary);
    expect(contentText(res)).not.toContain(OTHER_PHONE);
  });

  it('仓储返回主体形态非法的记录（自由文本式主体）→ 500，且不外发该主体与摘要', async () => {
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const { baseUrl, repository } = await startAuditApp({ seed: false });
    vi.spyOn(repository, 'listVisibleByActor').mockReturnValue([
      { ...fixtureEvent({ summary: '提交本人画像更新' }), actorUserId: '张三' },
    ]);

    const res = await call(baseUrl, 'GET', '/me/audit-events', {
      headers: bearer(SESSION_STUDENT_1),
    });

    expect(res.status).toBe(500);
    expect(res.body.error?.code).toBe('INTERNAL_ERROR');
    expect(contentText(res)).not.toContain('张三');
    expect(contentText(res)).not.toContain('提交本人画像更新');
  });

  it('仓储返回未标记本人可见的记录（过滤失效）→ 500：既不静默放行，也不静默丢弃', async () => {
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const { baseUrl, repository, seeded } = await startAuditApp();
    vi.spyOn(repository, 'listVisibleByActor').mockReturnValue([seeded.ownAdminOnly]);

    const res = await call(baseUrl, 'GET', '/me/audit-events', {
      headers: bearer(SESSION_STUDENT_1),
    });

    expect(res.status).toBe(500);
    expect(res.body.error?.code).toBe('INTERNAL_ERROR');
    expect(contentText(res)).not.toContain(seeded.ownAdminOnly.summary);
  });
});

describe('审计切片：存储异常（仓端口抛错 → 500，不泄露内部细节）', () => {
  it('取数抛异常（含敏感原文）→ 500，响应不含错误名、堆栈与原文，且不写入审计', async () => {
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const { baseUrl, repository } = await startAuditApp();
    const append = vi.spyOn(repository, 'append');
    vi.spyOn(repository, 'listVisibleByActor').mockImplementation(() => {
      throw new Error(`connection refused: actorUserId=${STUDENT_1} phone=${OTHER_PHONE}`);
    });

    const res = await call(baseUrl, 'GET', '/me/audit-events', {
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
    // 取数失败时既不返回事件，也不产生写入
    expect(append).not.toHaveBeenCalled();
  });

  it('审计写入抛异常 → 500：审计不可用时不返回「没有审计的成功响应」，也不外发已读取的事件', async () => {
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const { baseUrl, repository, seeded } = await startAuditApp();
    vi.spyOn(repository, 'append').mockImplementation(() => {
      throw new Error(`write failed: actorUserId=${STUDENT_1} phone=${OTHER_PHONE}`);
    });

    const res = await call(baseUrl, 'GET', '/me/audit-events', {
      headers: bearer(SESSION_STUDENT_1),
    });

    expect(res.status).toBe(500);
    expect(res.body.data).toBeNull();
    expect(res.body.error?.code).toBe('INTERNAL_ERROR');
    const content = contentText(res);
    for (const leaked of [seeded.ownProfileUpdate.summary, OTHER_PHONE, 'write failed']) {
      expect(content).not.toContain(leaked);
    }
    // 写入失败不改变存储：既有记录数与内容不变，也没有新的读取事件
    expect(readEventsOf(repository, STUDENT_1)).toHaveLength(0);
    expect(repository.listVisibleByActor(STUDENT_1)).toHaveLength(3);
  });

  it('写入返回被替换的记录（归属变成他人）→ 500，不把替换结果交出去', async () => {
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const { baseUrl, repository, seeded } = await startAuditApp();
    vi.spyOn(repository, 'append').mockReturnValue(seeded.otherVisible);

    const res = await call(baseUrl, 'GET', '/me/audit-events', {
      headers: bearer(SESSION_STUDENT_1),
    });

    expect(res.status).toBe(500);
    expect(res.body.error?.code).toBe('INTERNAL_ERROR');
    expect(contentText(res)).not.toContain(seeded.otherVisible.summary);
    expect(contentText(res)).not.toContain(OTHER_PHONE);
  });

  it('写入返回未标记本人可见的记录 → 500（写回同样复核可见标记）', async () => {
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const { baseUrl, repository, seeded } = await startAuditApp();
    vi.spyOn(repository, 'append').mockReturnValue(seeded.ownAdminOnly);

    const res = await call(baseUrl, 'GET', '/me/audit-events', {
      headers: bearer(SESSION_STUDENT_1),
    });

    expect(res.status).toBe(500);
    expect(res.body.error?.code).toBe('INTERNAL_ERROR');
  });
});

describe('审计切片：装配边界与纯函数门禁', () => {
  it('AuditModule 只注册本切片的路由/服务，并把仓储令牌显式绑到内存基线', () => {
    const providers = (Reflect.getMetadata('providers', AuditModule) ?? []) as unknown[];
    const controllers = (Reflect.getMetadata('controllers', AuditModule) ?? []) as unknown[];
    const imports = (Reflect.getMetadata('imports', AuditModule) ?? []) as unknown[];

    expect(controllers).toEqual([AuditController]);
    expect(providers).toContain(AuditService);
    expect(providers).toContain(InMemoryAuditRepository);
    // 换绑持久化实现时只改这一处
    expect(providers).toContainEqual({
      provide: AUDIT_REPOSITORY,
      useExisting: InMemoryAuditRepository,
    });
    // 依赖方向：认证（auth）与授权（access-control）各自只经端口/服务暴露
    expect(imports).toContain(AuthModule);
    expect(imports).toContain(AccessControlModule);
  });

  it('内存基线如实声明非持久化/不可用于生产，并在生产环境拒绝构造', () => {
    const developmentEnv = loadEnv({});
    const productionEnv = loadEnv({ NODE_ENV: 'production' });

    const repository = new InMemoryAuditRepository(developmentEnv);
    expect(repository.capabilities).toEqual({
      backend: 'in-memory-baseline',
      persistent: false,
      productionReady: false,
    });
    expect(repository.listVisibleByActor('u-nobody')).toEqual([]);
    // 不用内存冒充生产存储：生产环境直接拒绝构造
    expect(() => new InMemoryAuditRepository(productionEnv)).toThrow(
      /生产环境禁止使用内存审计仓储/u,
    );
  });

  it('内存基线只做存储自身的完整性约束：主键唯一、仅追加（无改写入口）、记录不可变、按主体与可见性取数', () => {
    const repository = new InMemoryAuditRepository(loadEnv({}));
    const record = fixtureEvent();
    repository.append(record);
    repository.append(fixtureEvent({ actorUserId: STUDENT_2 }));
    repository.append(fixtureEvent({ selfVisible: false }));

    // 主键冲突属于服务端缺陷，不得静默覆盖既有审计记录
    expect(() => repository.append(record)).toThrow(/审计事件 ID 冲突/u);

    // 仅追加：端口与实现都没有改写/删除入口（审计删除能力不存在）
    for (const forbidden of ['save', 'update', 'delete', 'remove', 'archive']) {
      expect(forbidden in repository).toBe(false);
    }

    // 记录不可变：返回的是冻结副本，调用方无法就地改写已记录的事实
    const found = repository.listVisibleByActor(STUDENT_1)[0];
    expect(found).toBeDefined();
    expect(() => {
      (found as { summary: string }).summary = '被改写';
    }).toThrow(TypeError);
    expect(repository.listVisibleByActor(STUDENT_1)[0]?.summary).toBe(record.summary);

    // 只按「主体本人 + 本人可见」取数：他人记录与仅管理端可见的记录不在本人摘要里
    expect(repository.listVisibleByActor(STUDENT_1)).toHaveLength(1);
    expect(repository.listVisibleByActor(STUDENT_2)).toHaveLength(1);
    expect(repository.listVisibleByActor('u-nobody')).toEqual([]);
  });

  it('输出白名单是真正的闭集：多出字段、非法枚举与缺字段即违规（门禁非恒真）', () => {
    const valid: AuditEventView = {
      id: '11111111-1111-4111-8111-111111111111',
      type: AuditEventType.ProfileSelfUpdate,
      result: AuditResult.Success,
      resourceType: AuditResourceType.StudentProfile,
      summary: '提交本人画像更新',
      occurredAt: '2026-01-05T00:00:00.000Z',
    };
    expect(parseAuditEventView(valid)).toEqual({ ok: true, value: valid });

    const withExtra = parseAuditEventView({ ...valid, ipHash: hashPeerAddress('127.0.0.1') });
    expect(withExtra.ok).toBe(false);
    if (!withExtra.ok) {
      expect(withExtra.issues).toEqual([{ kind: 'unexpected', path: 'ipHash' }]);
    }

    const withInvalid = parseAuditEventView({ ...valid, result: 'partial' });
    expect(withInvalid.ok).toBe(false);
    if (!withInvalid.ok) {
      expect(withInvalid.issues).toEqual([{ kind: 'invalid', path: 'result' }]);
    }

    const { summary: _summary, ...missing } = valid;
    const withoutRequired = parseAuditEventView(missing);
    expect(withoutRequired.ok).toBe(false);
    if (!withoutRequired.ok) {
      expect(withoutRequired.issues).toEqual([{ kind: 'invalid', path: 'summary' }]);
    }

    // 白名单字段集合固定，且出口投影只产出白名单字段
    expect(AUDIT_EVENT_VIEW_FIELDS).toEqual([
      'id',
      'type',
      'result',
      'resourceType',
      'summary',
      'occurredAt',
    ]);
    expect(
      Object.keys(toAuditEventView(parseStoredAuditEventOrThrow(fixtureEvent()))).sort(),
    ).toEqual([...AUDIT_EVENT_VIEW_FIELDS].sort());
  });

  it('存储读取契约：三个枚举闭集、ISO 时间、UUID、ipHash 形态、主体形态与免 PII 摘要', () => {
    const valid = fixtureEvent();
    expect(parseStoredAuditEvent(valid).ok).toBe(true);

    const cases: ReadonlyArray<{ readonly record: unknown; readonly path: string }> = [
      { record: { ...valid, type: 'unknown_type' }, path: 'type' },
      { record: { ...valid, result: 'partial' }, path: 'result' },
      { record: { ...valid, resourceType: 'unknown_resource' }, path: 'resourceType' },
      { record: { ...valid, occurredAt: '2026/01/05' }, path: 'occurredAt' },
      { record: { ...valid, id: 'not-a-uuid' }, path: 'id' },
      { record: { ...valid, requestId: 'not-a-uuid' }, path: 'requestId' },
      { record: { ...valid, ipHash: '127.0.0.1' }, path: 'ipHash' },
      { record: { ...valid, ipHash: '203.0.113.7' }, path: 'ipHash' },
      { record: { ...valid, actorUserId: '张三' }, path: 'actorUserId' },
      { record: { ...valid, actorUserId: '' }, path: 'actorUserId' },
      { record: { ...valid, selfVisible: 'yes' }, path: 'selfVisible' },
      { record: { ...valid, resourceId: 'not-a-uuid' }, path: 'resourceId' },
      { record: { ...valid, summary: '' }, path: 'summary' },
      { record: { ...valid, summary: `证件 ${PII_ID_CARD}` }, path: 'summary' },
      { record: { ...valid, summary: `密钥 ${PII_SECRET}` }, path: 'summary' },
      { record: { ...valid, reason: '改前值' }, path: 'reason' },
    ];

    for (const { record, path } of cases) {
      const parsed = parseStoredAuditEvent(record);
      expect(parsed.ok).toBe(false);
      if (!parsed.ok) {
        expect(parsed.issues.map((issue) => issue.path)).toContain(path);
        // 违规详情只给路径与类型，不给取值
        expect(JSON.stringify(parsed.issues)).not.toContain(PII_ID_CARD);
        expect(JSON.stringify(parsed.issues)).not.toContain(PII_SECRET);
        expect(JSON.stringify(parsed.issues)).not.toContain('张三');
      }
    }
  });

  it('查询串与请求体闭集门禁：无输入不报错，服务端字段与未声明字段给出可区分的拒绝原因', () => {
    expect(AUDIT_QUERY_FIELDS).toEqual([]);
    expect(AUDIT_READ_BODY_FIELDS).toEqual([]);
    expect(() => assertDeclaredAuditQueryFields({})).not.toThrow();
    expect(() => assertDeclaredAuditQueryFields(undefined)).not.toThrow();
    expect(() => assertDeclaredAuditQueryFields(null)).not.toThrow();
    expect(() => assertNoAuditReadBodyFields({})).not.toThrow();
    expect(() => assertNoAuditReadBodyFields(undefined)).not.toThrow();
    expect(() => assertNoAuditReadBodyFields(null)).not.toThrow();
    expect(() => assertNoAuditReadBodyFields('result=success')).not.toThrow();

    const claim = captureZodError(() => assertDeclaredAuditQueryFields({ actorUserId: STUDENT_2 }));
    expect(claim?.issues[0]?.message).toContain('禁止使用查询参数 actorUserId');
    const scope = captureZodError(() => assertDeclaredAuditQueryFields({ scope: 'GLOBAL' }));
    expect(scope?.issues[0]?.message).toContain('禁止使用查询参数 scope');
    const network = captureZodError(() =>
      assertDeclaredAuditQueryFields({ 'x-forwarded-for': FORGED_ADDRESS }),
    );
    expect(network?.issues[0]?.message).toContain('不接受查询参数 x-forwarded-for');
    const filter = captureZodError(() => assertDeclaredAuditQueryFields({ page: '1' }));
    expect(filter?.issues[0]?.message).toContain('不接受查询参数 page');

    const serverOwned = captureZodError(() => assertNoAuditReadBodyFields({ result: 'success' }));
    expect(serverOwned?.issues[0]?.message).toBe('禁止设置服务端字段 result');
    const actor = captureZodError(() => assertNoAuditReadBodyFields({ actorUserId: STUDENT_2 }));
    expect(actor?.issues[0]?.message).toBe('禁止设置服务端字段 actorUserId');
    const ip = captureZodError(() => assertNoAuditReadBodyFields({ ipHash: 'a'.repeat(64) }));
    expect(ip?.issues[0]?.message).toBe('禁止设置服务端字段 ipHash');
    const undeclared = captureZodError(() => assertNoAuditReadBodyFields({ note: '被改写' }));
    expect(undeclared?.issues[0]?.message).toBe('本端点不接受请求体字段 note');
  });

  it('toAuditRequestContext 只取传输层对端地址（不读任何客户端头），hashPeerAddress 只产出 sha256', () => {
    // 只读 socket.remoteAddress：请求头一律不进入上下文
    expect(
      toAuditRequestContext({
        socket: { remoteAddress: '10.0.0.1' },
        headers: { 'x-forwarded-for': FORGED_ADDRESS },
        ip: FORGED_ADDRESS,
        body: { actorUserId: STUDENT_2 },
      }),
    ).toEqual({ peerAddress: '10.0.0.1' });
    expect(
      toAuditRequestContext({ headers: { 'x-forwarded-for': FORGED_ADDRESS }, ip: FORGED_ADDRESS }),
    ).toEqual({});
    expect(toAuditRequestContext({ socket: {} })).toEqual({});
    expect(toAuditRequestContext({ socket: { remoteAddress: 42 } })).toEqual({});
    expect(toAuditRequestContext(undefined)).toEqual({});

    // 只存哈希：明文地址不可从哈希反推，缺失时哈希服务端哨兵值（不接受客户端占位）
    expect(hashPeerAddress('127.0.0.1')).toMatch(SHA256_PATTERN);
    expect(hashPeerAddress()).toBe(hashPeerAddress(UNKNOWN_PEER_ADDRESS));
    expect(hashPeerAddress()).not.toBe(hashPeerAddress('127.0.0.1'));
    expect(hashPeerAddress(FORGED_ADDRESS)).not.toBe(hashPeerAddress('127.0.0.1'));

    // 明文 IP 形态不是合法 ipHash：存储契约直接拒绝
    expect(parseStoredAuditEvent(fixtureEvent({ ipHash: FORGED_ADDRESS })).ok).toBe(false);
  });

  it('事件类型/结果/资源类型闭集：取值集合固定，未知取值一律被读取契约拒绝', () => {
    expect(AUDIT_RESULT_VALUES).toEqual(['success', 'denied', 'failed']);
    expect(AUDIT_EVENT_TYPE_VALUES).toHaveLength(7);
    expect(new Set(AUDIT_EVENT_TYPE_VALUES).size).toBe(AUDIT_EVENT_TYPE_VALUES.length);
    expect(AUDIT_RESOURCE_TYPE_VALUES).toHaveLength(7);
    expect(AUDIT_EVENT_TYPE_VALUES).toContain(AuditEventType.SelfAuditEventsRead);

    // 闭集内的每个取值都是合法存储记录；闭集外一律 500（见上面的 fail-closed 用例）
    for (const type of AUDIT_EVENT_TYPE_VALUES) {
      expect(parseStoredAuditEvent(fixtureEvent({ type })).ok).toBe(true);
    }
    for (const result of AUDIT_RESULT_VALUES) {
      expect(parseStoredAuditEvent(fixtureEvent({ result })).ok).toBe(true);
    }
    for (const resourceType of AUDIT_RESOURCE_TYPE_VALUES) {
      expect(parseStoredAuditEvent(fixtureEvent({ resourceType })).ok).toBe(true);
    }
    expect(parseStoredAuditEvent(fixtureEvent({ type: 'audit_delete' as AuditEventType })).ok).toBe(
      false,
    );
    expect(parseStoredAuditEvent(fixtureEvent({ result: 'deleted' as AuditResult })).ok).toBe(
      false,
    );
  });

  it('完整 AppModule：health / runtime-info 与既有路由行为不变，审计路由默认 401', async () => {
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
      '/me/notifications',
      '/me/audit-events',
      '/groups',
    ]) {
      const res = await call(baseUrl, 'GET', path);
      expect(res.status).toBe(401);
      expect(res.body.error?.code).toBe('UNAUTHENTICATED');
    }
  });
});

/** 读取契约（测试辅助）：把夹具记录断言为合法存储记录，失败即抛，避免静默通过 */
function parseStoredAuditEventOrThrow(record: unknown): AuditEvent {
  const parsed = parseStoredAuditEvent(record);
  if (!parsed.ok) {
    throw new Error(`夹具记录不符合审计读取契约: ${JSON.stringify(parsed.issues)}`);
  }
  return parsed.value;
}

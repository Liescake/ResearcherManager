import 'reflect-metadata';
import { request } from 'node:http';
import { Logger, Module } from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import { APP_FILTER, APP_INTERCEPTOR, NestFactory } from '@nestjs/core';
import {
  DEFAULT_ROLE_PERMISSIONS,
  DataScope,
  PERMISSION_POINT_VALUES,
  PermissionPoint,
  Role,
} from '@rm/shared';
import type { ApiEnvelope } from '@rm/shared';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import type { MockInstance } from 'vitest';
import { ZodError } from 'zod';
import { AppModule } from '../../app.module';
import { ApiExceptionFilter } from '../../common/api-exception.filter';
import { ApiResponseInterceptor } from '../../common/api-response.interceptor';
import { ConfigModule } from '../../config/config.module';
import { APP_ENV } from '../../config/config.module';
import { loadEnv } from '../../config/env';
import { SQL_CONNECTION_FACTORY } from '../../db/ports/sql-executor.port';
import { AccessControlModule } from '../access-control/access-control.module';
import { AuthModule } from '../auth/auth.module';
import { InMemorySessionStore } from '../auth/session-store.in-memory';
import { SESSION_STORE } from '../auth/session-subject.port';
import { RUOYI_AUTHZ_ADAPTER } from '../ruoyi-adapter/ruoyi-adapter.port';
import type { RuoYiAuthzAdapter } from '../ruoyi-adapter/ruoyi-adapter.port';
import {
  COMPLIANCE_QUERY_FIELDS,
  COMPLIANCE_STATUS_BODY_FIELDS,
  COMPLIANCE_STATUS_VIEW_FIELDS,
  COMPLIANCE_STATUS_VIEW_REQUIRED_FIELDS,
  COMPLIANCE_INTEGRITY_MESSAGE,
  FORBIDDEN_COMPLIANCE_BODY_FIELDS,
  FORBIDDEN_COMPLIANCE_QUERY_FIELDS,
  assertDeclaredComplianceBodyFields,
  assertDeclaredComplianceQueryFields,
  complianceStatusViewSchema,
  parseComplianceStatusView,
  parseStoredComplianceRecord,
  toComplianceStatusView,
} from './compliance.contract';
import type { ComplianceStatusView, StoredComplianceRecord } from './compliance.contract';
import { ComplianceController } from './compliance.controller';
import { InMemoryComplianceRepository } from './compliance.in-memory-repository';
import {
  COMPLIANCE_REPOSITORY,
  DATA_RETENTION_STATUS_VALUES,
  EXPORT_AVAILABILITY_STATUS_VALUES,
  PRIVACY_CONSENT_STATUS_VALUES,
  DataRetentionStatus,
  ExportAvailabilityStatus,
  PrivacyConsentStatus,
} from './compliance.port';
import type { ComplianceRecord } from './compliance.port';
import { COMPLIANCE_STATUS_PERMISSION, ComplianceService } from './compliance.service';
import { ComplianceModule } from './compliance.module';

/**
 * 合规切片（`/me/compliance-status`）的真实 HTTP 回归：
 *
 * - 成功：学生本人 200，`data` 恰好是三个状态枚举的白名单
 *   （`privacyConsent` / `dataRetention` / `exportAvailability`），
 *   **不含**归属 `userId`、不含隐私同意原文与政策正文、不含手机号/学号/姓名、
 *   不含内部审核意见与审核人、不含证据文件标识、不含期限与时间戳；
 * - 认证 401：无凭证、scheme 不对、凭证过短、会话不存在、会话主体含未登记角色（fail-closed），
 *   且认证失败时端口一次都不会被调用（带伪造体/查询串/自定义头也仍是 401）；
 * - 越权 403：管理员/负责人/系统管理员/超级管理员的默认范围不是 `SELF` → 同一个 403
 *   （与「存储归属异常」共用文案），且**授权先于输入校验**（非法查询串/请求体同样是 403），
 *   此时读取端口一次都没被调用；
 * - 输入 400：查询串与请求体闭集（`userId`/`roles`/`scope`/`groupId`/`phone`/`consentText`/
 *   `reviewStatus`/`evidenceFileId`/`policyVersion`… 与未声明字段一律拒绝，
 *   服务端字段与未声明字段的拒绝原因可区分，且**不回显提交的取值**）；
 * - claims 伪造：自定义头（`x-user-id`/`x-roles`/`x-scope`/`x-group-id`/`x-consent-text`/
 *   `x-phone`…）不进入判定、归属与输出，判定入参是会话主体 + 服务端常量；
 * - PII 与非法存储 fail-closed 500：未知状态枚举、缺字段、归属不一致、状态与同意/留存不自洽、
 *   被塞入同意原文/手机号/审核与证据字段、仓储抛异常或返回非对象一律 500，
 *   响应与日志只含字段路径、不含取值，且绝不外发切片内部的完整性文案；
 * - 装配边界：`ComplianceModule` 的控制器/服务/令牌绑定、内存基线的能力声明与生产拒绝构造、
 *   读取契约与输出白名单门禁非恒真、权限点 parity、完整 `AppModule` 下既有路由回归。
 *
 * 说明：测试用真实 Nest 应用 + 真实 HTTP（与其它切片的 controller spec 同构），
 * 只通过 DI 令牌/端口注入测试夹具（会话、合规状态记录），不替换任何生产代码路径。
 */

const SESSION_STUDENT_1 = 'session-student-1';
const SESSION_STUDENT_2 = 'session-student-2';
const SESSION_LEADER_1 = 'session-leader-1';
const SESSION_ADMIN_1 = 'session-admin-1';
const SESSION_SYSTEM_ADMIN_1 = 'session-system-admin-1';
const SESSION_SUPER_ADMIN_1 = 'session-super-admin-1';
const SESSION_UNKNOWN_ROLE = 'session-unknown-role';

const STUDENT_1 = 'u-student-1';
const STUDENT_2 = 'u-student-2';
const LEADER_1 = 'u-leader-1';
const ADMIN_1 = 'u-admin-1';
const SYSTEM_ADMIN_1 = 'u-system-admin-1';
const SUPER_ADMIN_1 = 'u-super-admin-1';

/** 高敏内容：18 位身份证号、他人手机号、隐私同意原文、内部审核与证据字段取值 */
const PII_ID_CARD = '110101199003071234';
const OTHER_PHONE = '13800000000';
const CONSENT_TEXT = '本人已阅读并同意《隐私政策》v1.0 全文：我们收集账号与画像信息…';
const POLICY_VERSION = 'v1.0';
const REVIEW_NOTE = '内部审核意见：材料存疑，暂缓';
const REVIEWER_ID = 'u-reviewer-9';
const EVIDENCE_FILE_ID = 'evidence-secret-0001';
const RETENTION_UNTIL = '2030-12-31T00:00:00.000Z';
/** 客户端伪造的传输层跟踪 ID：只作为响应 meta，且必须是合法字符集才被接受 */
const FORGED_REQUEST_ID = 'client-trace-00000001';
const ILLEGAL_REQUEST_ID = 'bad id!';
/**
 * 伪造自定义头的取值：HTTP 头只允许 ASCII 可见字符，因此这里用 ASCII 占位串
 * （同意原文这类中文明文只经查询串/请求体提交，见对应用例）。
 */
const FORGED_CONSENT_HEADER = 'forged-consent-text';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
/** 500 的统一对外文案（切片内部的完整性文案绝不外发） */
const INTERNAL_ERROR_MESSAGE = '服务器内部错误，请稍后重试';

const STUDENT_1_STATUS: ComplianceStatusView = {
  privacyConsent: PrivacyConsentStatus.Granted,
  dataRetention: DataRetentionStatus.WithinRetention,
  exportAvailability: ExportAvailabilityStatus.Available,
};

const STUDENT_2_STATUS: ComplianceStatusView = {
  privacyConsent: PrivacyConsentStatus.NotRecorded,
  dataRetention: DataRetentionStatus.WithinRetention,
  exportAvailability: ExportAvailabilityStatus.Unavailable,
};

const startedApps: INestApplication[] = [];

/** 禁止出现在任何正常响应文本里的高敏与内部形态 */
const LEAK_MARKERS: readonly string[] = [
  STUDENT_1,
  STUDENT_2,
  OTHER_PHONE,
  PII_ID_CARD,
  CONSENT_TEXT,
  POLICY_VERSION,
  REVIEW_NOTE,
  REVIEWER_ID,
  EVIDENCE_FILE_ID,
  RETENTION_UNTIL,
  '"ownerUserId"',
  '"userId"',
  '"phone"',
  '"consentText"',
  '"policyVersion"',
  '"consentedAt"',
  '"reviewStatus"',
  '"reviewNote"',
  '"reviewerId"',
  '"evidenceFileId"',
  '"retentionUntil"',
];

@Module({
  imports: [ConfigModule, ComplianceModule],
  providers: [
    { provide: APP_INTERCEPTOR, useClass: ApiResponseInterceptor },
    { provide: APP_FILTER, useClass: ApiExceptionFilter },
  ],
})
class ComplianceHttpModule {}

interface TestApp {
  readonly app: INestApplication;
  readonly baseUrl: string;
  readonly store: InMemorySessionStore;
  readonly repository: InMemoryComplianceRepository;
}

/** 存储记录夹具：归属与三个状态由调用方指定，模拟「存储里已存在记录」 */
function fixtureComplianceRecord(overrides: Partial<ComplianceRecord> = {}): ComplianceRecord {
  return { ownerUserId: STUDENT_1, ...STUDENT_1_STATUS, ...overrides };
}

/**
 * 直接写入任意形态的记录（含非法存储形态），用于 fail-closed 门禁回归。
 * 内存基线刻意不做读取契约校验：非法记录必须能被出口门禁看见（而不是被静默修正）。
 */
function seedRaw(repository: InMemoryComplianceRepository, record: unknown): void {
  repository.seed(record as ComplianceRecord);
}

/** 启动真实应用并注入会话夹具（内存基线的显式 seed，不做隐式全局状态） */
async function startComplianceApp(options: { readonly seed?: boolean } = {}): Promise<TestApp> {
  const app = await NestFactory.create(ComplianceHttpModule, { logger: false });
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
  // 负责人：持有 profile:self:read 但默认范围是 GROUP（不是 SELF）
  store.seed({
    sessionId: SESSION_LEADER_1,
    subject: { userId: LEADER_1, roles: [Role.GroupLeader], groupIds: ['g-1'] },
  });
  store.seed({ sessionId: SESSION_ADMIN_1, subject: { userId: ADMIN_1, roles: [Role.Admin] } });
  store.seed({
    sessionId: SESSION_SYSTEM_ADMIN_1,
    subject: { userId: SYSTEM_ADMIN_1, roles: [Role.SystemAdmin] },
  });
  store.seed({
    sessionId: SESSION_SUPER_ADMIN_1,
    subject: { userId: SUPER_ADMIN_1, roles: [Role.SuperAdmin] },
  });
  // 会话存储里出现未登记角色：主体不可信，必须在认证边界整体拒绝
  store.seed({
    sessionId: SESSION_UNKNOWN_ROLE,
    subject: { userId: 'u-unknown-1', roles: ['guest' as Role] },
  });

  const repository = app.get<InMemoryComplianceRepository>(COMPLIANCE_REPOSITORY);
  if (options.seed !== false) {
    repository.seed(fixtureComplianceRecord());
    repository.seed(fixtureComplianceRecord({ ownerUserId: STUDENT_2, ...STUDENT_2_STATUS }));
  }

  return { app, baseUrl: `${await app.getUrl()}/api/v1`, store, repository };
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

function viewOf(body: ApiEnvelope<unknown>): ComplianceStatusView {
  return body.data as ComplianceStatusView;
}

/**
 * 响应中「业务内容」部分的文本：去掉 `meta`（`requestId` 是随机 UUID 或客户端跟踪 ID、
 * `generatedAt` 是时间戳）与 `error.requestId`。
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

/** 断言一段正常响应内容里没有高敏与内部形态的任何一种 */
function expectNoLeak(content: string): void {
  for (const marker of LEAK_MARKERS) {
    expect(content).not.toContain(marker);
  }
}

interface PortSpies {
  readonly find: MockInstance;
}

function spyOnPorts(app: TestApp): PortSpies {
  return { find: vi.spyOn(app.repository, 'findByUserId') };
}

/** 认证/授权/输入拒绝路径的硬要求：读取端口一次都不被调用 */
function expectNoPortCalls(spies: PortSpies): void {
  expect(spies.find).not.toHaveBeenCalled();
}

afterAll(async () => {
  await Promise.all(startedApps.map((app) => app.close()));
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('合规划片：成功路径（真实 HTTP + 统一响应信封）', () => {
  it('学生本人：200、error 为 null、data 恰好是三个状态枚举的白名单', async () => {
    const app = await startComplianceApp();

    const res = await call(app.baseUrl, 'GET', '/me/compliance-status', {
      headers: { ...bearer(SESSION_STUDENT_1), 'x-request-id': 'test-request-1' },
    });

    expect(res.status).toBe(200);
    expect(res.body.error).toBeNull();
    expect(res.body.meta.requestId).toBe('test-request-1');
    expect(typeof res.body.meta.generatedAt).toBe('string');

    const view = viewOf(res.body);
    expect(view).toEqual(STUDENT_1_STATUS);

    // 输出白名单：每个字段都在白名单内，必需字段齐全（闭集，无第四类信息）
    const viewWhitelist: readonly string[] = COMPLIANCE_STATUS_VIEW_FIELDS;
    expect(Object.keys(view).every((key) => viewWhitelist.includes(key))).toBe(true);
    for (const field of COMPLIANCE_STATUS_VIEW_REQUIRED_FIELDS) {
      expect(view).toHaveProperty(field);
    }
    expect(Object.keys(view)).toHaveLength(COMPLIANCE_STATUS_VIEW_FIELDS.length);

    // 每个取值都在服务端闭集内（不是「碰巧等于夹具」）
    expect(PRIVACY_CONSENT_STATUS_VALUES).toContain(view.privacyConsent);
    expect(DATA_RETENTION_STATUS_VALUES).toContain(view.dataRetention);
    expect(EXPORT_AVAILABILITY_STATUS_VALUES).toContain(view.exportAvailability);

    // 归属、同意原文、联系方式与内部审核/证据字段都不随响应回传
    const content = contentText(res);
    expectNoLeak(content);
    expect(content).not.toContain('ownerUserId');
    expect(content).not.toContain(COMPLIANCE_INTEGRITY_MESSAGE);
  });

  it('服务端只接受合法字符集的跟踪 ID，非法形态由服务端替换为 UUID', async () => {
    const app = await startComplianceApp();

    const res = await call(app.baseUrl, 'GET', '/me/compliance-status', {
      headers: { ...bearer(SESSION_STUDENT_1), 'x-request-id': ILLEGAL_REQUEST_ID },
    });

    expect(res.status).toBe(200);
    expect(res.body.meta.requestId).toMatch(UUID_PATTERN);
    expect(contentText(res)).not.toContain(ILLEGAL_REQUEST_ID);
  });

  it('他人登录时只看到自己的状态（按服务端主体取数，端口没有「按客户端主体取数」的入口）', async () => {
    const app = await startComplianceApp();

    const res = await call(app.baseUrl, 'GET', '/me/compliance-status', {
      headers: bearer(SESSION_STUDENT_2),
    });

    expect(res.status).toBe(200);
    expect(viewOf(res.body)).toEqual(STUDENT_2_STATUS);
    // 另一主体的状态取值不出现（引号参与匹配，避免被 `unavailable` 里的子串误伤）
    const content = contentText(res);
    expect(content).not.toContain(`"${PrivacyConsentStatus.Granted}"`);
    expect(content).not.toContain(`"${ExportAvailabilityStatus.Available}"`);
    expect(content).not.toContain(STUDENT_1);
  });

  it('只读语义：读取只调用一次端口、不产生写入副作用，重复请求结果稳定', async () => {
    const app = await startComplianceApp();
    const spies = spyOnPorts(app);

    const first = await call(app.baseUrl, 'GET', '/me/compliance-status', {
      headers: bearer(SESSION_STUDENT_1),
    });
    const second = await call(app.baseUrl, 'GET', '/me/compliance-status', {
      headers: bearer(SESSION_STUDENT_1),
    });

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(viewOf(first.body)).toEqual(viewOf(second.body));
    expect(spies.find).toHaveBeenCalledTimes(2);
    expect(spies.find).toHaveBeenCalledWith(STUDENT_1);

    // 本切片没有写入入口（`seed` 只存在于内存基线的开发/测试装配，端口上没有）
    for (const forbidden of ['create', 'save', 'update', 'upsert', 'delete', 'remove', 'archive']) {
      expect(forbidden in app.repository).toBe(false);
    }
  });

  it('空查询串（`?`）不算输入：200 且状态不变', async () => {
    const app = await startComplianceApp();

    const res = await call(app.baseUrl, 'GET', '/me/compliance-status?', {
      headers: bearer(SESSION_STUDENT_1),
    });

    expect(res.status).toBe(200);
    expect(viewOf(res.body)).toEqual(STUDENT_1_STATUS);
  });

  it('未注册的路由/方法形态不产生新行为：只新增 GET 一条路由（其余 404）', async () => {
    const app = await startComplianceApp();

    const shapes: ReadonlyArray<readonly ['GET' | 'POST' | 'PATCH' | 'DELETE', string]> = [
      ['GET', '/me/compliance-status/history'],
      ['POST', '/me/compliance-status'],
      ['PATCH', '/me/compliance-status'],
      ['DELETE', '/me/compliance-status'],
      ['GET', '/me/compliance'],
    ];

    for (const [method, path] of shapes) {
      const res = await call(app.baseUrl, method, path, { headers: bearer(SESSION_STUDENT_1) });
      expect(res.status, `${method} ${path}`).toBe(404);
      expect(res.body.error?.code).toBe('NOT_FOUND');
    }
  });
});

describe('合规划片：认证边界 401（fail-closed）', () => {
  const unauthenticatedCases: ReadonlyArray<{ name: string; headers: Record<string, string> }> = [
    { name: '未携带 Authorization', headers: {} },
    { name: 'scheme 不是 Bearer', headers: { authorization: `Token ${SESSION_STUDENT_1}` } },
    { name: 'Bearer 凭证过短', headers: { authorization: 'Bearer short' } },
    { name: '会话不存在', headers: bearer('session-does-not-exist') },
    { name: '会话主体含未登记角色', headers: bearer(SESSION_UNKNOWN_ROLE) },
  ];

  it.each(unauthenticatedCases)(
    '$name → 401 UNAUTHENTICATED，且端口一次都不被调用',
    async ({ headers }) => {
      const app = await startComplianceApp();
      const spies = spyOnPorts(app);

      const res = await call(app.baseUrl, 'GET', '/me/compliance-status', { headers });

      expect(res.status).toBe(401);
      expect(res.body.data).toBeNull();
      expect(res.body.error?.code).toBe('UNAUTHENTICATED');
      // 不区分失败原因，避免给探测者额外信息
      expect(res.body.error?.message).toBe('登录状态无效或已过期，请重新登录');
      expectNoPortCalls(spies);
      expect(contentText(res)).not.toContain(SESSION_UNKNOWN_ROLE);
      expect(contentText(res)).not.toContain('guest');
    },
  );

  it('未认证时即便带了伪造查询串/请求体/伪造头也是 401（认证先于一切输入）', async () => {
    const app = await startComplianceApp();
    const spies = spyOnPorts(app);

    const res = await call(
      app.baseUrl,
      'GET',
      `/me/compliance-status?userId=${STUDENT_2}&phone=${OTHER_PHONE}`,
      {
        headers: {
          'x-user-id': STUDENT_2,
          'x-roles': 'super_admin',
          'x-scope': 'GLOBAL',
          'x-consent-text': FORGED_CONSENT_HEADER,
          'x-phone': OTHER_PHONE,
        },
        body: {
          userId: STUDENT_2,
          roles: [Role.SuperAdmin],
          scope: DataScope.Global,
          consentText: CONSENT_TEXT,
        },
      },
    );

    expect(res.status).toBe(401);
    expect(res.body.error?.code).toBe('UNAUTHENTICATED');
    expectNoPortCalls(spies);
    const content = contentText(res);
    for (const leaked of [STUDENT_2, OTHER_PHONE, CONSENT_TEXT, 'super_admin', 'GLOBAL']) {
      expect(content).not.toContain(leaked);
    }
  });
});

describe('合规划片：越权 403（AuthorizationGuard + 服务端常量判定入参）', () => {
  const unauthorizedCases = [
    { name: 'admin（范围 ASSIGNED，不是 SELF）', session: SESSION_ADMIN_1, actor: ADMIN_1 },
    {
      name: 'system_admin（范围 SYSTEM，不是 SELF）',
      session: SESSION_SYSTEM_ADMIN_1,
      actor: SYSTEM_ADMIN_1,
    },
    {
      name: 'super_admin（范围 GLOBAL，不是 SELF）',
      session: SESSION_SUPER_ADMIN_1,
      actor: SUPER_ADMIN_1,
    },
    { name: 'group_leader（范围 GROUP，不是 SELF）', session: SESSION_LEADER_1, actor: LEADER_1 },
  ];

  it.each(unauthorizedCases)(
    '$name 读取本人合规状态：403 FORBIDDEN，端口一次都不被调用',
    async ({ session, actor }) => {
      const app = await startComplianceApp();
      const spies = spyOnPorts(app);

      const res = await call(app.baseUrl, 'GET', '/me/compliance-status', {
        headers: bearer(session),
      });

      expect(res.status).toBe(403);
      expect(res.body.data).toBeNull();
      expect(res.body.error?.code).toBe('FORBIDDEN');
      // 与「存储归属异常」共用同一文案，调用方无法据此区分内部原因
      expect(res.body.error?.message).toBe('无权执行该操作');
      expectNoPortCalls(spies);

      const content = contentText(res);
      for (const leaked of [
        STUDENT_1,
        actor,
        PrivacyConsentStatus.Granted,
        COMPLIANCE_INTEGRITY_MESSAGE,
      ]) {
        expect(content).not.toContain(leaked);
      }
      expectNoLeak(content);
    },
  );

  it('授权先于输入校验：越权主体即使带非法查询串/请求体也是 403，且不取数', async () => {
    const app = await startComplianceApp();
    const spies = spyOnPorts(app);

    const shapes: ReadonlyArray<{
      readonly path: string;
      readonly body?: unknown;
    }> = [
      { path: '/me/compliance-status' },
      { path: `/me/compliance-status?userId=${STUDENT_2}` },
      { path: '/me/compliance-status', body: { userId: STUDENT_2, roles: [Role.SuperAdmin] } },
      { path: '/me/compliance-status', body: { consentText: CONSENT_TEXT } },
      { path: `/me/compliance-status?status=available`, body: { note: '被改写' } },
    ];

    for (const shape of shapes) {
      const res = await call(app.baseUrl, 'GET', shape.path, {
        headers: bearer(SESSION_ADMIN_1),
        ...(shape.body === undefined ? {} : { body: shape.body }),
      });

      // 403 而不是 400：未授权主体拿不到任何字段级反馈
      expect(res.status, shape.path).toBe(403);
      expect(res.body.error?.code).toBe('FORBIDDEN');
      expect(contentText(res)).not.toContain(STUDENT_2);
    }

    expectNoPortCalls(spies);
  });

  it('越权请求不产生任何读取痕迹：该主体在存储里没有记录，也不会被查询', async () => {
    const app = await startComplianceApp();
    const spies = spyOnPorts(app);

    const res = await call(app.baseUrl, 'GET', '/me/compliance-status', {
      headers: bearer(SESSION_ADMIN_1),
    });

    expect(res.status).toBe(403);
    expect(spies.find).not.toHaveBeenCalled();
    await expect(app.repository.findByUserId(ADMIN_1)).resolves.toBeUndefined();
    await expect(app.repository.findByUserId(STUDENT_1)).resolves.toEqual(
      fixtureComplianceRecord(),
    );
  });
});

describe('合规划片：输入拒绝 400（查询串与请求体闭集，不取数）', () => {
  const queryCases: ReadonlyArray<{
    readonly name: string;
    readonly query: string;
    readonly expected: string;
    readonly leaked?: string;
  }> = [
    {
      name: 'userId（越权声明归属）',
      query: `userId=${STUDENT_2}`,
      expected: '禁止使用查询参数 userId',
      leaked: STUDENT_2,
    },
    {
      name: 'roles（伪造角色）',
      query: 'roles=super_admin',
      expected: '禁止使用查询参数 roles',
      leaked: 'super_admin',
    },
    {
      name: 'scope（伪造范围）',
      query: 'scope=GLOBAL',
      expected: '禁止使用查询参数 scope',
      leaked: 'GLOBAL',
    },
    {
      name: 'groupId（伪造组归属）',
      query: 'groupId=g-1',
      expected: '禁止使用查询参数 groupId',
      leaked: 'g-1',
    },
    {
      name: 'phone（联系方式）',
      query: `phone=${OTHER_PHONE}`,
      expected: '禁止使用查询参数 phone',
      leaked: OTHER_PHONE,
    },
    {
      name: 'consentText（同意原文）',
      query: `consentText=${encodeURIComponent(CONSENT_TEXT)}`,
      expected: '禁止使用查询参数 consentText',
      leaked: CONSENT_TEXT,
    },
    {
      name: 'policyVersion（政策版本）',
      query: `policyVersion=${POLICY_VERSION}`,
      expected: '禁止使用查询参数 policyVersion',
      leaked: POLICY_VERSION,
    },
    {
      name: 'reviewStatus（内部审核态）',
      query: 'reviewStatus=approved',
      expected: '禁止使用查询参数 reviewStatus',
      leaked: 'approved',
    },
    {
      name: 'evidenceFileId（证据文件指针）',
      query: `evidenceFileId=${EVIDENCE_FILE_ID}`,
      expected: '禁止使用查询参数 evidenceFileId',
      leaked: EVIDENCE_FILE_ID,
    },
    {
      name: 'status（服务端状态）',
      query: 'status=available',
      expected: '禁止使用查询参数 status',
      leaked: 'available',
    },
    {
      name: 'page（未声明参数）',
      query: 'page=1&pageSize=10',
      expected: '本端点不接受查询参数 page',
    },
  ];

  it.each(queryCases)(
    '查询串闭集（$name）：400，不取数且不回显取值',
    async ({ query, expected, leaked }) => {
      const app = await startComplianceApp();
      const spies = spyOnPorts(app);

      const res = await call(app.baseUrl, 'GET', `/me/compliance-status?${query}`, {
        headers: bearer(SESSION_STUDENT_1),
      });

      expect(res.status).toBe(400);
      expect(res.body.data).toBeNull();
      expect(res.body.error?.code).toBe('VALIDATION_FAILED');
      const messages = issuesOf(res.body).map((issue) => issue.message);
      expect(messages.some((message) => message.includes(expected))).toBe(true);
      expectNoPortCalls(spies);
      if (leaked !== undefined) expect(contentText(res)).not.toContain(leaked);
    },
  );

  const bodyCases: ReadonlyArray<{
    readonly name: string;
    readonly body: unknown;
    readonly expected: string;
    readonly leaked?: string;
  }> = [
    {
      name: 'userId',
      body: { userId: STUDENT_2 },
      expected: '禁止设置服务端字段 userId',
      leaked: STUDENT_2,
    },
    {
      name: 'ownerUserId',
      body: { ownerUserId: STUDENT_2 },
      expected: '禁止设置服务端字段 ownerUserId',
      leaked: STUDENT_2,
    },
    {
      name: 'roles/scope',
      body: { roles: [Role.SuperAdmin], scope: DataScope.Global },
      expected: '禁止设置服务端字段 roles',
      leaked: 'super_admin',
    },
    {
      name: 'groupId',
      body: { groupId: 'g-1' },
      expected: '禁止设置服务端字段 groupId',
      leaked: 'g-1',
    },
    {
      name: 'privacyConsent（服务端状态）',
      body: { privacyConsent: PrivacyConsentStatus.Granted },
      expected: '禁止设置服务端字段 privacyConsent',
      leaked: PrivacyConsentStatus.Granted,
    },
    {
      name: 'exportAvailability（服务端状态）',
      body: { exportAvailability: ExportAvailabilityStatus.Available },
      expected: '禁止设置服务端字段 exportAvailability',
      leaked: ExportAvailabilityStatus.Available,
    },
    {
      name: 'phone',
      body: { phone: OTHER_PHONE },
      expected: '禁止设置服务端字段 phone',
      leaked: OTHER_PHONE,
    },
    {
      name: 'consentText',
      body: { consentText: CONSENT_TEXT },
      expected: '禁止设置服务端字段 consentText',
      leaked: CONSENT_TEXT,
    },
    {
      name: 'reviewNote',
      body: { reviewNote: REVIEW_NOTE },
      expected: '禁止设置服务端字段 reviewNote',
      leaked: REVIEW_NOTE,
    },
    {
      name: 'evidenceFileId',
      body: { evidenceFileId: EVIDENCE_FILE_ID },
      expected: '禁止设置服务端字段 evidenceFileId',
      leaked: EVIDENCE_FILE_ID,
    },
    {
      name: 'note（未声明字段）',
      body: { note: '被改写' },
      expected: '请求体包含未声明字段 note',
      leaked: '被改写',
    },
  ];

  it.each(bodyCases)(
    '请求体闭集（$name）：400，不取数且不回显取值',
    async ({ body, expected, leaked }) => {
      const app = await startComplianceApp();
      const spies = spyOnPorts(app);

      const res = await call(app.baseUrl, 'GET', '/me/compliance-status', {
        headers: bearer(SESSION_STUDENT_1),
        body,
      });

      expect(res.status).toBe(400);
      expect(res.body.data).toBeNull();
      expect(res.body.error?.code).toBe('VALIDATION_FAILED');
      const messages = issuesOf(res.body).map((issue) => issue.message);
      expect(messages.some((message) => message.includes(expected))).toBe(true);
      expectNoPortCalls(spies);
      if (leaked !== undefined) expect(contentText(res)).not.toContain(leaked);
    },
  );

  it('一次提交多个服务端字段/未声明字段时逐项给出可区分的拒绝原因', async () => {
    const app = await startComplianceApp();
    const spies = spyOnPorts(app);

    const res = await call(app.baseUrl, 'GET', '/me/compliance-status', {
      headers: bearer(SESSION_STUDENT_1),
      body: { userId: STUDENT_2, consentText: CONSENT_TEXT, note: '被改写' },
    });

    expect(res.status).toBe(400);
    const messages = issuesOf(res.body).map((issue) => issue.message);
    expect(messages).toContain('禁止设置服务端字段 userId（身份、授权与合规事实只来自服务端）');
    expect(messages).toContain(
      '禁止设置服务端字段 consentText（身份、授权与合规事实只来自服务端）',
    );
    expect(messages).toContain('请求体包含未声明字段 note');
    expectNoPortCalls(spies);
  });

  it('重复查询参数同样 400（键名违规，不被解析为合法输入）', async () => {
    const app = await startComplianceApp();

    const res = await call(app.baseUrl, 'GET', '/me/compliance-status?userId=u-a&userId=u-b', {
      headers: bearer(SESSION_STUDENT_1),
    });

    expect(res.status).toBe(400);
    expect(res.body.error?.code).toBe('VALIDATION_FAILED');
  });

  it('标量 JSON 请求体（非对象）→ 400：解析失败不回显请求体片段，也不触达端口', async () => {
    const app = await startComplianceApp();
    const spies = spyOnPorts(app);

    const res = await call(app.baseUrl, 'GET', '/me/compliance-status', {
      headers: bearer(SESSION_STUDENT_1),
      body: `userId=${STUDENT_2}`,
    });

    expect(res.status).toBe(400);
    expect(res.body.error?.code).toBe('VALIDATION_FAILED');
    expect(contentText(res)).not.toContain(`userId=${STUDENT_2}`);
    expectNoPortCalls(spies);
  });
});

describe('合规划片：claims 伪造（客户端声明不进入判定、归属与输出）', () => {
  const forgedHeaders = {
    'x-user-id': STUDENT_2,
    'x-actor-user-id': STUDENT_2,
    'x-owner-user-id': STUDENT_2,
    'x-roles': 'super_admin,admin',
    'x-scope': 'GLOBAL',
    'x-group-id': 'g-1',
    'x-consent-text': FORGED_CONSENT_HEADER,
    'x-privacy-consent': PrivacyConsentStatus.Withdrawn,
    'x-export-availability': ExportAvailabilityStatus.Unavailable,
    'x-phone': OTHER_PHONE,
    'x-review-status': 'approved',
    'x-evidence-file-id': EVIDENCE_FILE_ID,
    'x-request-id': FORGED_REQUEST_ID,
  };

  it('伪造自定义头不能改变主体、判定入参与输出：判定入参是会话主体 + 服务端常量', async () => {
    const app = await startComplianceApp();
    const adapter = app.app.get<RuoYiAuthzAdapter>(RUOYI_AUTHZ_ADAPTER);
    const checkAuthorization = vi.spyOn(adapter, 'checkAuthorization');

    const res = await call(app.baseUrl, 'GET', '/me/compliance-status', {
      headers: { ...bearer(SESSION_STUDENT_1), ...forgedHeaders },
    });

    expect(res.status).toBe(200);
    expect(viewOf(res.body)).toEqual(STUDENT_1_STATUS);
    // 单点门控：每次请求只判定一次
    expect(checkAuthorization).toHaveBeenCalledTimes(1);
    expect(checkAuthorization).toHaveBeenCalledWith(
      { userId: STUDENT_1, roles: [Role.Student] },
      {
        permission: COMPLIANCE_STATUS_PERMISSION,
        scope: DataScope.Self,
        resourceUserId: STUDENT_1,
      },
    );

    const content = contentText(res);
    for (const leaked of [
      STUDENT_2,
      FORGED_CONSENT_HEADER,
      OTHER_PHONE,
      EVIDENCE_FILE_ID,
      'super_admin',
      'GLOBAL',
      'g-1',
      'approved',
    ]) {
      expect(content).not.toContain(leaked);
    }
    expectNoLeak(content);
  });

  it('伪造更高角色的声明不能让越权主体通过（admin + 伪造 SELF/超管声明仍是 403）', async () => {
    const app = await startComplianceApp();
    const spies = spyOnPorts(app);

    const res = await call(app.baseUrl, 'GET', '/me/compliance-status', {
      headers: {
        ...bearer(SESSION_ADMIN_1),
        'x-user-id': ADMIN_1,
        'x-roles': 'super_admin',
        'x-scope': 'SELF',
      },
      body: { scope: DataScope.Self, userId: ADMIN_1 },
    });

    expect(res.status).toBe(403);
    expect(res.body.error?.code).toBe('FORBIDDEN');
    expectNoPortCalls(spies);
  });

  it('带伪造头的请求一旦触碰输入闭集仍被 400 拒绝，且不改变任何状态', async () => {
    const app = await startComplianceApp();
    const spies = spyOnPorts(app);

    const res = await call(app.baseUrl, 'GET', `/me/compliance-status?phone=${OTHER_PHONE}`, {
      headers: { ...bearer(SESSION_STUDENT_1), ...forgedHeaders },
    });

    expect(res.status).toBe(400);
    expect(res.body.error?.code).toBe('VALIDATION_FAILED');
    expectNoPortCalls(spies);
    await expect(app.repository.findByUserId(STUDENT_1)).resolves.toEqual(
      fixtureComplianceRecord(),
    );
  });
});

describe('合规划片：PII 与非法存储 fail-closed 500', () => {
  const illegalStatusCases: ReadonlyArray<{ name: string; record: unknown }> = [
    { name: '未知同意状态', record: { ...fixtureComplianceRecord(), privacyConsent: 'maybe' } },
    { name: '未知保留状态', record: { ...fixtureComplianceRecord(), dataRetention: 'forever' } },
    {
      name: '未知导出可用性',
      record: { ...fixtureComplianceRecord(), exportAvailability: 'sometimes' },
    },
    { name: '同意状态为 null', record: { ...fixtureComplianceRecord(), privacyConsent: null } },
    { name: '缺字段（无导出可用性）', record: { ownerUserId: STUDENT_1 } },
    {
      name: '状态不自洽（同意已撤回却声明导出可用）',
      record: {
        ...fixtureComplianceRecord(),
        privacyConsent: PrivacyConsentStatus.Withdrawn,
        exportAvailability: ExportAvailabilityStatus.Available,
      },
    },
    {
      name: '状态不自洽（保留期已过却声明导出可用）',
      record: {
        ...fixtureComplianceRecord(),
        dataRetention: DataRetentionStatus.Expired,
        exportAvailability: ExportAvailabilityStatus.Available,
      },
    },
    {
      name: '状态不自洽（尚未记录同意却声明导出可用）',
      record: {
        ...fixtureComplianceRecord(),
        privacyConsent: PrivacyConsentStatus.NotRecorded,
        exportAvailability: ExportAvailabilityStatus.Available,
      },
    },
    { name: '归属形态非法（姓名）', record: { ...fixtureComplianceRecord(), ownerUserId: '张三' } },
    { name: '归属为空串', record: { ...fixtureComplianceRecord(), ownerUserId: '' } },
    { name: '记录不是对象（null）', record: null },
    { name: '记录不是对象（数组）', record: [fixtureComplianceRecord()] },
    { name: '记录不是对象（字符串）', record: PrivacyConsentStatus.Granted },
  ];

  it.each(illegalStatusCases)(
    '$name → 500 INTERNAL_ERROR，且不外发取值与内部文案',
    async ({ record }) => {
      const errorLog = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
      const app = await startComplianceApp();
      // 非法记录不能靠 seed 注入（归属形态非法的记录会落到别的键上），
      // 直接让端口返回它：这正是「存储被篡改/损坏」要覆盖的路径。
      vi.spyOn(app.repository, 'findByUserId').mockImplementation(
        async () => record as ComplianceRecord,
      );

      const res = await call(app.baseUrl, 'GET', '/me/compliance-status', {
        headers: bearer(SESSION_STUDENT_1),
      });

      expect(res.status).toBe(500);
      expect(res.body.data).toBeNull();
      expect(res.body.error?.code).toBe('INTERNAL_ERROR');
      expect(res.body.error?.message).toBe(INTERNAL_ERROR_MESSAGE);

      const content = contentText(res);
      expect(content).not.toContain(COMPLIANCE_INTEGRITY_MESSAGE);
      expect(content).not.toContain('maybe');
      expect(content).not.toContain('forever');
      expect(content).not.toContain('sometimes');
      expectNoLeak(content);

      // 日志只写字段路径与违规类型，不写取值
      const logs = errorLog.mock.calls.flat().join(' ');
      expect(logs).toContain('[compliance]');
      expect(logs).not.toContain('maybe');
      expect(logs).not.toContain('forever');
      expect(logs).not.toContain('sometimes');
      expect(logs).not.toContain(COMPLIANCE_INTEGRITY_MESSAGE);
    },
  );

  it('存储被塞入同意原文/手机号/审核与证据字段 → 500：既不外发也不写日志', async () => {
    const errorLog = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const app = await startComplianceApp();

    seedRaw(app.repository, {
      ...fixtureComplianceRecord(),
      consentText: CONSENT_TEXT,
      policyVersion: POLICY_VERSION,
      consentedAt: RETENTION_UNTIL,
      phone: OTHER_PHONE,
      idCard: PII_ID_CARD,
      reviewStatus: 'approved',
      reviewNote: REVIEW_NOTE,
      reviewerId: REVIEWER_ID,
      evidenceFileId: EVIDENCE_FILE_ID,
      retentionUntil: RETENTION_UNTIL,
    });

    const res = await call(app.baseUrl, 'GET', '/me/compliance-status', {
      headers: bearer(SESSION_STUDENT_1),
    });

    expect(res.status).toBe(500);
    expect(res.body.error?.code).toBe('INTERNAL_ERROR');
    expect(res.body.error?.message).toBe(INTERNAL_ERROR_MESSAGE);

    const content = contentText(res);
    for (const secret of [
      CONSENT_TEXT,
      POLICY_VERSION,
      OTHER_PHONE,
      PII_ID_CARD,
      REVIEW_NOTE,
      REVIEWER_ID,
      EVIDENCE_FILE_ID,
      RETENTION_UNTIL,
      'approved',
    ]) {
      expect(content).not.toContain(secret);
    }

    const logs = errorLog.mock.calls.flat().join(' ');
    for (const secret of [
      CONSENT_TEXT,
      OTHER_PHONE,
      PII_ID_CARD,
      REVIEW_NOTE,
      REVIEWER_ID,
      EVIDENCE_FILE_ID,
      RETENTION_UNTIL,
    ]) {
      expect(logs).not.toContain(secret);
    }
    // 日志给出的是字段路径（可排错），不是取值
    expect(logs).toContain('[compliance]');
    expect(logs).toContain('存储记录违反读取契约');
  });

  it('主体没有合规记录 → 500（fail-closed），绝不凭空给出状态，也不是 404', async () => {
    const errorLog = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const app = await startComplianceApp({ seed: false });
    const spies = spyOnPorts(app);

    const res = await call(app.baseUrl, 'GET', '/me/compliance-status', {
      headers: bearer(SESSION_STUDENT_1),
    });

    expect(res.status).toBe(500);
    expect(res.body.error?.code).toBe('INTERNAL_ERROR');
    expect(res.body.error?.message).toBe(INTERNAL_ERROR_MESSAGE);
    expect(res.body.error?.message).not.toBe('目标资源不存在或不可见');
    expect(spies.find).toHaveBeenCalledTimes(1);
    expect(contentText(res)).not.toContain(COMPLIANCE_INTEGRITY_MESSAGE);
    // 未找到事实的失败原因只进日志
    expect(errorLog.mock.calls.flat().join(' ')).toContain('[compliance]');
  });

  it('仓储返回他人记录（未按主体过滤）→ 500，且他人标识不外发', async () => {
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const app = await startComplianceApp();
    vi.spyOn(app.repository, 'findByUserId').mockImplementation(async () =>
      fixtureComplianceRecord({ ownerUserId: STUDENT_2, ...STUDENT_2_STATUS }),
    );

    const res = await call(app.baseUrl, 'GET', '/me/compliance-status', {
      headers: bearer(SESSION_STUDENT_1),
    });

    expect(res.status).toBe(500);
    expect(res.body.error?.code).toBe('INTERNAL_ERROR');
    const content = contentText(res);
    expect(content).not.toContain(STUDENT_2);
    expect(content).not.toContain(STUDENT_1);
    expect(content).not.toContain(COMPLIANCE_INTEGRITY_MESSAGE);
  });

  it('仓储抛异常（含敏感原文）→ 500，响应不含错误名/堆栈/原文', async () => {
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const app = await startComplianceApp();
    vi.spyOn(app.repository, 'findByUserId').mockImplementation(async () => {
      throw new Error(
        `connection refused: ownerUserId=${STUDENT_1} phone=${OTHER_PHONE} consentText=${CONSENT_TEXT}`,
      );
    });

    const res = await call(app.baseUrl, 'GET', '/me/compliance-status', {
      headers: bearer(SESSION_STUDENT_1),
    });

    expect(res.status).toBe(500);
    expect(res.body.data).toBeNull();
    expect(res.body.error?.code).toBe('INTERNAL_ERROR');
    expect(res.body.error?.message).toBe(INTERNAL_ERROR_MESSAGE);

    const content = contentText(res);
    for (const leaked of [
      STUDENT_1,
      OTHER_PHONE,
      CONSENT_TEXT,
      'connection refused',
      'Error',
      'stack',
    ]) {
      expect(content).not.toContain(leaked);
    }
  });

  it('仓储返回非对象/缺字段（null、数组、字符串、空对象）→ 500', async () => {
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

    const shapes: ReadonlyArray<unknown> = [null, [], 'granted', {}, 42, true];

    for (const shape of shapes) {
      const app = await startComplianceApp();
      vi.spyOn(app.repository, 'findByUserId').mockImplementation(
        async () => shape as ComplianceRecord,
      );

      const res = await call(app.baseUrl, 'GET', '/me/compliance-status', {
        headers: bearer(SESSION_STUDENT_1),
      });

      expect(res.status).toBe(500);
      expect(res.body.error?.code).toBe('INTERNAL_ERROR');
      expect(contentText(res)).not.toContain(COMPLIANCE_INTEGRITY_MESSAGE);
    }
  });
});

describe('合规划片：装配边界与纯函数门禁', () => {
  it('ComplianceModule 只注册本切片的路由/服务，并按「是否配置数据库」换绑端口（未配置 ⇒ 内存基线）', () => {
    const providers = (Reflect.getMetadata('providers', ComplianceModule) ?? []) as unknown[];
    const controllers = (Reflect.getMetadata('controllers', ComplianceModule) ?? []) as unknown[];
    const imports = (Reflect.getMetadata('imports', ComplianceModule) ?? []) as unknown[];

    expect(controllers).toEqual([ComplianceController]);
    expect(providers).toContain(ComplianceService);
    // 内存基线**不再**是独立 provider：端口是唯一取用点，容器里不会出现两份状态
    expect(providers).not.toContain(InMemoryComplianceRepository);
    // 换绑持久化实现时只改这一处（工厂 provider：按 DATABASE_URL 分流，延迟建连）
    expect(providers).toContainEqual({
      provide: COMPLIANCE_REPOSITORY,
      useFactory: expect.any(Function) as unknown,
      inject: [APP_ENV, { token: SQL_CONNECTION_FACTORY, optional: true }],
    });
    // 依赖方向：认证（auth）与授权（access-control）各自只经端口/服务暴露
    expect(imports).toContain(AuthModule);
    expect(imports).toContain(AccessControlModule);
  });

  it('未配置数据库时令牌解析到内存基线（同一实例，且服务从端口取数）', async () => {
    const app = await startComplianceApp({ seed: false });
    const bound = app.app.get<InMemoryComplianceRepository>(COMPLIANCE_REPOSITORY);
    expect(bound).toBeInstanceOf(InMemoryComplianceRepository);
    // 端口是唯一取用点：容器里不存在第二份内存基线实例
    expect(app.app.get<InMemoryComplianceRepository>(COMPLIANCE_REPOSITORY)).toBe(bound);
  });

  it('内存基线如实声明非持久化/不可用于生产，并在生产环境拒绝构造', async () => {
    const developmentEnv = loadEnv({});
    const productionEnv = loadEnv({ NODE_ENV: 'production' });

    const repository = new InMemoryComplianceRepository(developmentEnv);
    expect(repository.capabilities).toEqual({
      backend: 'in-memory-baseline',
      persistent: false,
      productionReady: false,
    });
    await expect(repository.findByUserId('u-nobody')).resolves.toBeUndefined();
    expect(() => new InMemoryComplianceRepository(productionEnv)).toThrow(
      /生产环境禁止使用内存合规仓储/u,
    );
  });

  it('内存仓储：只读、按主体取数、返回副本、未预置任何主体', async () => {
    const repository = new InMemoryComplianceRepository(loadEnv({}));

    // 默认不预置任何账号：未 seed 时任何主体都查不到记录（由 service 按 fail-closed 处理）
    await expect(repository.findByUserId(STUDENT_1)).resolves.toBeUndefined();

    const record = fixtureComplianceRecord();
    repository.seed(record);
    await expect(repository.findByUserId(STUDENT_1)).resolves.toEqual(record);
    await expect(repository.findByUserId(STUDENT_2)).resolves.toBeUndefined();

    // 端口/实例上没有写入口：API 无法经由读取路径改写合规事实
    for (const forbidden of ['create', 'save', 'update', 'upsert', 'delete', 'remove', 'archive']) {
      expect(forbidden in repository).toBe(false);
    }

    // 返回副本：调用方无法就地改写已存储的记录（每次读取都是新对象）
    const returned = await repository.findByUserId(STUDENT_1);
    expect(returned).toBeDefined();
    (returned as { privacyConsent: string }).privacyConsent = 'tampered';
    await expect(repository.findByUserId(STUDENT_1)).resolves.toMatchObject({
      privacyConsent: PrivacyConsentStatus.Granted,
    });
    expect(await repository.findByUserId(STUDENT_1)).not.toBe(returned);
  });

  it('输出白名单是真正的闭集：多出字段、非法枚举与缺字段即违规（门禁非恒真）', () => {
    const valid: ComplianceStatusView = { ...STUDENT_1_STATUS };
    expect(parseComplianceStatusView(valid)).toEqual({ ok: true, value: valid });

    const withOwner = parseComplianceStatusView({ ...valid, ownerUserId: STUDENT_1 });
    expect(withOwner.ok).toBe(false);
    if (!withOwner.ok) {
      expect(withOwner.issues).toEqual([{ kind: 'unexpected', path: 'ownerUserId' }]);
    }

    const withSecrets = parseComplianceStatusView({
      ...valid,
      consentText: CONSENT_TEXT,
      phone: OTHER_PHONE,
      reviewStatus: 'approved',
      evidenceFileId: EVIDENCE_FILE_ID,
    });
    expect(withSecrets.ok).toBe(false);
    if (!withSecrets.ok) {
      expect(withSecrets.issues.map((issue) => issue.path)).toEqual([
        'consentText',
        'phone',
        'reviewStatus',
        'evidenceFileId',
      ]);
      // 违规详情只给路径与类型，不给取值
      expect(JSON.stringify(withSecrets.issues)).not.toContain(CONSENT_TEXT);
      expect(JSON.stringify(withSecrets.issues)).not.toContain(OTHER_PHONE);
    }

    const withInvalidStatus = parseComplianceStatusView({ ...valid, privacyConsent: 'unknown' });
    expect(withInvalidStatus.ok).toBe(false);
    if (!withInvalidStatus.ok) {
      expect(withInvalidStatus.issues).toEqual([{ kind: 'invalid', path: 'privacyConsent' }]);
    }

    const { exportAvailability: _exportAvailability, ...missing } = valid;
    const withoutRequired = parseComplianceStatusView(missing);
    expect(withoutRequired.ok).toBe(false);
    if (!withoutRequired.ok) {
      expect(withoutRequired.issues).toEqual([{ kind: 'invalid', path: 'exportAvailability' }]);
    }

    // 白名单字段集合固定，且出口投影只产出白名单字段
    expect(COMPLIANCE_STATUS_VIEW_FIELDS).toEqual([
      'privacyConsent',
      'dataRetention',
      'exportAvailability',
    ]);
    expect(Object.keys(complianceStatusViewSchema.shape).sort()).toEqual(
      [...COMPLIANCE_STATUS_VIEW_FIELDS].sort(),
    );
    const stored = parseStoredComplianceRecordOrThrow(fixtureComplianceRecord());
    expect(Object.keys(toComplianceStatusView(stored)).sort()).toEqual(
      [...COMPLIANCE_STATUS_VIEW_FIELDS].sort(),
    );
  });

  it('存储读取契约：字段闭集、枚举闭集、主体形态与状态自洽（闭集内的合法组合仍全部可读）', () => {
    expect(parseStoredComplianceRecord(fixtureComplianceRecord()).ok).toBe(true);
    // 不可用的导出在任意同意/留存组合下都合法（`unavailable` 不由这两个字段反推）
    for (const consent of PRIVACY_CONSENT_STATUS_VALUES) {
      expect(
        parseStoredComplianceRecord({
          ownerUserId: STUDENT_1,
          privacyConsent: consent,
          dataRetention: DataRetentionStatus.WithinRetention,
          exportAvailability: ExportAvailabilityStatus.Unavailable,
        }).ok,
      ).toBe(true);
    }
    for (const retention of DATA_RETENTION_STATUS_VALUES) {
      expect(
        parseStoredComplianceRecord({
          ownerUserId: STUDENT_1,
          privacyConsent: PrivacyConsentStatus.Granted,
          dataRetention: retention,
          exportAvailability: ExportAvailabilityStatus.Unavailable,
        }).ok,
      ).toBe(true);
    }
    // 导出可用的两种闭集取值在「已同意 + 保留期内」下合法（证明门禁非恒假）
    for (const availability of EXPORT_AVAILABILITY_STATUS_VALUES) {
      expect(
        parseStoredComplianceRecord({
          ownerUserId: STUDENT_1,
          privacyConsent: PrivacyConsentStatus.Granted,
          dataRetention: DataRetentionStatus.WithinRetention,
          exportAvailability: availability,
        }).ok,
      ).toBe(true);
    }

    const valid = fixtureComplianceRecord();
    const cases: ReadonlyArray<{ readonly record: unknown; readonly path: string }> = [
      { record: { ...valid, privacyConsent: 'unknown' }, path: 'privacyConsent' },
      { record: { ...valid, privacyConsent: undefined }, path: 'privacyConsent' },
      { record: { ...valid, dataRetention: 'unknown' }, path: 'dataRetention' },
      { record: { ...valid, exportAvailability: 'maybe' }, path: 'exportAvailability' },
      { record: { ...valid, exportAvailability: undefined }, path: 'exportAvailability' },
      { record: { ...valid, ownerUserId: '张三' }, path: 'ownerUserId' },
      { record: { ...valid, ownerUserId: '' }, path: 'ownerUserId' },
      { record: { ...valid, reviewStatus: 'approved' }, path: 'reviewStatus' },
      { record: { ...valid, reviewNote: REVIEW_NOTE }, path: 'reviewNote' },
      { record: { ...valid, reviewerId: REVIEWER_ID }, path: 'reviewerId' },
      { record: { ...valid, evidenceFileId: EVIDENCE_FILE_ID }, path: 'evidenceFileId' },
      { record: { ...valid, consentText: CONSENT_TEXT }, path: 'consentText' },
      { record: { ...valid, policyVersion: POLICY_VERSION }, path: 'policyVersion' },
      { record: { ...valid, consentedAt: RETENTION_UNTIL }, path: 'consentedAt' },
      { record: { ...valid, retentionUntil: RETENTION_UNTIL }, path: 'retentionUntil' },
      { record: { ...valid, phone: OTHER_PHONE }, path: 'phone' },
      { record: null, path: '(root)' },
      { record: [], path: '(root)' },
      { record: 'granted', path: '(root)' },
      // 状态不自洽：同意未生效或保留期已过时不得声明导出可用
      { record: { ...valid, privacyConsent: 'withdrawn' }, path: 'exportAvailability' },
      { record: { ...valid, privacyConsent: 'not-recorded' }, path: 'exportAvailability' },
      { record: { ...valid, dataRetention: 'expired' }, path: 'exportAvailability' },
    ];

    for (const { record, path } of cases) {
      const parsed = parseStoredComplianceRecord(record);
      expect(parsed.ok, path).toBe(false);
      if (!parsed.ok) {
        expect(parsed.issues.map((issue) => issue.path)).toContain(path);
        // 违规详情只给路径与类型，不给取值
        const issues = JSON.stringify(parsed.issues);
        for (const secret of [
          CONSENT_TEXT,
          POLICY_VERSION,
          OTHER_PHONE,
          PII_ID_CARD,
          REVIEW_NOTE,
          REVIEWER_ID,
          EVIDENCE_FILE_ID,
          RETENTION_UNTIL,
          '张三',
          'approved',
        ]) {
          expect(issues).not.toContain(secret);
        }
      }
    }
  });

  it('输入闭集门禁：无输入不报错，服务端字段与未声明字段给出可区分的拒绝原因', () => {
    expect(COMPLIANCE_QUERY_FIELDS).toEqual([]);
    expect(COMPLIANCE_STATUS_BODY_FIELDS).toEqual([]);
    // 声明闭集与服务端独占清单不重叠（不存在「声明了又禁止」的自相矛盾）
    for (const declared of COMPLIANCE_QUERY_FIELDS) {
      expect(FORBIDDEN_COMPLIANCE_QUERY_FIELDS).not.toContain(declared);
    }
    for (const declared of COMPLIANCE_STATUS_BODY_FIELDS) {
      expect(FORBIDDEN_COMPLIANCE_BODY_FIELDS).not.toContain(declared);
    }

    for (const input of [undefined, null, {}, []]) {
      expect(() => assertDeclaredComplianceQueryFields(input)).not.toThrow();
      expect(() => assertDeclaredComplianceBodyFields(input)).not.toThrow();
    }
    // 标量不是「对象上多出的字段」：由字段级/解析层判定，不在本门禁的职责内
    expect(() => assertDeclaredComplianceQueryFields('userId=u-a')).not.toThrow();
    expect(() => assertDeclaredComplianceBodyFields('userId=u-a')).not.toThrow();

    const serverOwned = captureZodError(() =>
      assertDeclaredComplianceQueryFields({ userId: STUDENT_2 }),
    );
    expect(serverOwned?.issues[0]?.message).toBe(
      '禁止使用查询参数 userId（身份、授权与合规事实只来自服务端）',
    );
    expect(serverOwned?.issues[0]?.path).toEqual(['userId']);
    expect(JSON.stringify(serverOwned?.issues)).not.toContain(STUDENT_2);

    const bodyServerOwned = captureZodError(() =>
      assertDeclaredComplianceBodyFields({ consentText: CONSENT_TEXT }),
    );
    expect(bodyServerOwned?.issues[0]?.message).toBe(
      '禁止设置服务端字段 consentText（身份、授权与合规事实只来自服务端）',
    );
    expect(JSON.stringify(bodyServerOwned?.issues)).not.toContain(CONSENT_TEXT);

    const undeclared = captureZodError(() =>
      assertDeclaredComplianceBodyFields({ note: '被改写' }),
    );
    expect(undeclared?.issues[0]?.message).toBe('请求体包含未声明字段 note');

    const queryUndeclared = captureZodError(() =>
      assertDeclaredComplianceQueryFields({ page: '1' }),
    );
    expect(queryUndeclared?.issues[0]?.message).toBe('本端点不接受查询参数 page');
  });

  it('状态枚举与权限点 parity：闭集不重复、只用目录内已有 self 权限点（不新增权限点）', () => {
    for (const values of [
      PRIVACY_CONSENT_STATUS_VALUES,
      DATA_RETENTION_STATUS_VALUES,
      EXPORT_AVAILABILITY_STATUS_VALUES,
    ]) {
      expect(values.length).toBeGreaterThan(0);
      expect(new Set(values).size).toBe(values.length);
    }

    expect(PERMISSION_POINT_VALUES).toContain(COMPLIANCE_STATUS_PERMISSION);
    expect(COMPLIANCE_STATUS_PERMISSION).toBe(PermissionPoint.ProfileSelfRead);
    // 学生默认持有该本人权限点：证明闭集目录内的本人合规状态读取仍可被授权
    expect(DEFAULT_ROLE_PERMISSIONS[Role.Student]).toContain(COMPLIANCE_STATUS_PERMISSION);
  });

  it('完整 AppModule：health / runtime-info 与既有路由行为不变，合规路由默认 401', async () => {
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
      '/me/notifications',
      '/me/audit-events',
      '/me/exports',
      '/me/compliance-status',
      '/groups',
    ]) {
      const res = await call(baseUrl, 'GET', path);
      expect(res.status, path).toBe(401);
      expect(res.body.error?.code).toBe('UNAUTHENTICATED');
    }

    // 默认装配的内存合规仓储为空：认证先于取数，因此是 401 而不是 500
    const compliance = await call(baseUrl, 'GET', '/me/compliance-status');
    expect(compliance.status).toBe(401);
    expect(compliance.body.error?.code).toBe('UNAUTHENTICATED');
  });
});

/** 读取契约（测试辅助）：把夹具记录断言为合法存储记录，失败即抛，避免静默通过 */
function parseStoredComplianceRecordOrThrow(record: unknown): StoredComplianceRecord {
  const parsed = parseStoredComplianceRecord(record);
  if (!parsed.ok) {
    throw new Error(`夹具记录不符合合规读取契约: ${JSON.stringify(parsed.issues)}`);
  }
  return parsed.value;
}

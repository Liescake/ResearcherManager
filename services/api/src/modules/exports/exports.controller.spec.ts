import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
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
import { loadEnv } from '../../config/env';
import type { SqlExecutor } from '../../db/ports/sql-executor.port';
import { AccessControlModule } from '../access-control/access-control.module';
import { AuthModule } from '../auth/auth.module';
import { InMemorySessionStore } from '../auth/session-store.in-memory';
import { SESSION_STORE } from '../auth/session-subject.port';
import { RUOYI_AUTHZ_ADAPTER } from '../ruoyi-adapter/ruoyi-adapter.port';
import type { RuoYiAuthzAdapter } from '../ruoyi-adapter/ruoyi-adapter.port';
import {
  IN_MEMORY_EXPORT_STORAGE_PREFIX,
  InMemoryExportArtifactStore,
} from './exports.artifact-store.in-memory';
import {
  EXPORTABLE_FIELDS,
  EXPORTABLE_FIELD_NAME_VALUES,
  EXPORT_DOWNLOAD_TTL_MS,
  EXPORT_MAX_FIELD_COUNT,
  EXPORT_QUERY_FIELDS,
  EXPORT_REQUEST_INTEGRITY_MESSAGE,
  EXPORT_REQUEST_INPUT_FIELDS,
  EXPORT_REQUEST_VIEW_FIELDS,
  EXPORT_REQUEST_VIEW_REQUIRED_FIELDS,
  assertDeclaredExportQueryFields,
  assertDeclaredExportRequestFields,
  exportRequestInputSchema,
  parseExportRequestView,
  parseStoredExportRequest,
  readArtifactId,
  resolveExportFields,
  toExportRequestView,
} from './exports.contract';
import type { ExportRequestView, StoredExportRequest } from './exports.contract';
import { ExportsController } from './exports.controller';
import { InMemoryExportRepository } from './exports.in-memory-repository';
import {
  EXPORT_ARTIFACT_STORE,
  EXPORT_REPOSITORY,
  EXPORT_RESOURCE_VALUES,
  EXPORT_STATUS_VALUES,
  EXPORT_TRANSITION_REJECTED,
  ExportResource,
  ExportStatus,
  isExportTransitionRejection,
} from './exports.port';
import type { ExportRequest } from './exports.port';
import {
  PostgresExportRepository,
  PostgresExportRepositoryError,
} from './exports.postgres-repository';
import {
  EXPORT_ENTRY_PERMISSION,
  EXPORT_RESOURCE_READ_PERMISSIONS,
  ExportsService,
} from './exports.service';
import { ExportsModule } from './exports.module';
import {
  EXPORT_ENTRY_STATUS,
  EXPORT_STATUS_TRANSITIONS,
  EXPORT_TERMINAL_STATUSES,
  assertExportTransition,
  canTransitionExport,
  isExportProcessable,
  isExportTerminal,
  nextExportStatuses,
} from './exports.state-machine';

/**
 * 导出切片（`/me/exports`）的真实 HTTP 回归：
 *
 * - 成功：学生创建本人导出请求（201）与本人列表/状态（200）；资源与字段只来自**服务端白名单**，
 *   归属、请求 ID、产物句柄与时间戳全部由服务端写入；视图是白名单闭集，**不含**归属、
 *   产物句柄、文件名、路径、下载地址与任何存储 key；
 * - 认证 401：无凭证、scheme 不对、凭证过短、会话不存在、会话主体含未登记角色（fail-closed），
 *   且认证失败时两个端口一次都不会被调用（带伪造体/查询串/自定义头也仍是 401）；
 * - 越权 403：管理员/负责人/系统管理员/超级管理员的默认范围不是 `SELF` → 同一个 403
 *   （与「数据损坏」共用文案），且**授权先于字段级校验**（空体、非法资源同样是 403），
 *   此时仓储与产物存储一次都没被调用；
 * - 输入 400：请求体与查询串闭集（`userId`/`roles`/`scope`/`groupId`/`status`/`fileUrl`/`path`/
 *   `fileName`/`storageKey`/`artifactId`/`ownerUserId`/`createdAt`… 与未声明字段一律拒绝，
 *   服务端字段与未声明字段的拒绝原因可区分，且**不回显提交的取值**）、资源闭集、字段白名单闭集；
 * - claims 伪造：自定义头（`x-user-id`/`x-roles`/`x-scope`/`x-group-id`/`x-status`/`x-file-url`/
 *   `x-path`…）不进入判定、归属、状态与输出；
 * - 状态机：成功 `pending -> completed`；产物生成失败或产物存储返回非法句柄 → `failed` 终态
 *   （201，不是 500）；仓储返回非 `pending` 记录 → 409 `STATE_TRANSITION_INVALID`
 *   且不产生任何产物副作用；数据库 adapter 的条件写入被并发拒绝
 *   （端口标记 `EXPORT_TRANSITION_REJECTED`）→ **同一个** 409，不是 500；写回未如实持久化 → 500；
 * - PII 与 fail-closed 500：存储记录字段里出现证件号/密钥/路径、多出字段、归属不一致、
 *   状态与产物不自洽、未知枚举一律 500，响应与日志只含字段路径、不含取值；
 * - 存储异常：仓储取数/写入抛异常 → 500，不含错误名、堆栈与原文，也不返回
 *   「看起来成功但没有记录」的响应；**唯一例外**是上面那条端口标记的并发冲突（409，
 *   且拒绝判定只读结构化 `code`，不解析消息，因此 SQL / 归属 / 路径 / PII 都不影响判定）；
 * - 装配边界：`ExportsModule` 的控制器/服务/令牌绑定、两个内存基线的能力声明与生产拒绝构造、
 *   白名单与权限点映射的 parity、完整 `AppModule` 下既有路由回归。
 *
 * 说明：测试用真实 Nest 应用 + 真实 HTTP（与其它切片的 controller spec 同构），
 * 只通过 DI 令牌/端口注入测试夹具（会话、导出记录），不替换任何生产代码路径。
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

/** 高敏内容：18 位身份证号（`id_card` 命中）与疑似密钥（`secret_like` 命中） */
const PII_ID_CARD = '110101199003071234';
const PII_SECRET = 'api_key: sk-abcdefghijkl';
/** 他人联系方式：不在任何响应中出现 */
const OTHER_PHONE = '13800000000';
/** 客户端伪造的产物位置与句柄：绝不能出现在任何响应里 */
const FORGED_PATH = '/var/exports/u-student-2/secret-export.csv';
const FORGED_FILE_URL = 'https://files.example.com/exports/secret-export.csv';
const FORGED_STORAGE_KEY = 's3://internal-bucket/exports/secret-export.csv';
const FORGED_FILE_NAME = 'secret-export.csv';
const FORGED_ARTIFACT_ID = '99999999-9999-4999-8999-999999999999';
/** 伪造的**下载签名**地址：客户端提交它必须被拒，且绝不回显（签名即取件能力） */
const FORGED_DOWNLOAD_URL =
  'https://files.example.com/exports/secret-export.csv?X-Amz-Signature=deadbeefcafe&Expires=1999999999';
/** 伪造的**对象存储句柄**（含桶与凭据式引用）：同样是服务端独占，不得由客户端声明 */
const FORGED_STORAGE_HANDLE = 'arn:aws:s3:::internal-bucket/exports/secret-export.csv';
/** 客户端伪造的传输层跟踪 ID：只作为响应 meta，不进入存储 */
const FORGED_REQUEST_ID = 'client-trace-00000001';
/**
 * 客户端伪造的**服务端有效期**（远期）：有效期是服务端独占事实，请求体/查询串里出现它
 * 必须 400 且不回显；存储里的有效期必须仍然是服务端签发的值。
 */
const FORGED_EXPIRES_AT = '2099-12-31T23:59:59.000Z';

/**
 * 服务端有效期夹具（未来 1 小时）：种子记录默认**有效**。
 *
 * 相对当前时刻派生而不是硬编码日期：有效期是「相对服务端当前时钟」的性质，
 * 硬编码的未来日期会在某天变成过去，让成功用例悄悄变成过期用例。
 */
function futureExpiry(offsetMs = 3_600_000): string {
  return new Date(Date.now() + offsetMs).toISOString();
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
/** 500 的统一对外文案（内部完整性文案绝不外发） */
const INTERNAL_ERROR_MESSAGE = '服务器内部错误，请稍后重试';

const startedApps: INestApplication[] = [];

/** 输出白名单的字符串视图：用于断言响应里没有白名单之外的键 */
const VIEW_WHITELIST: readonly string[] = EXPORT_REQUEST_VIEW_FIELDS;

/** 禁止出现在任何正常响应文本里的「产物位置 / 内部存储」形态 */
const STORAGE_LEAK_MARKERS: readonly string[] = [
  FORGED_PATH,
  FORGED_FILE_URL,
  FORGED_STORAGE_KEY,
  FORGED_FILE_NAME,
  FORGED_ARTIFACT_ID,
  IN_MEMORY_EXPORT_STORAGE_PREFIX,
  '"fileUrl"',
  '"storageKey"',
  '"artifactId"',
  '"fileName"',
  '.csv',
];

@Module({
  imports: [ConfigModule, ExportsModule],
  providers: [
    { provide: APP_INTERCEPTOR, useClass: ApiResponseInterceptor },
    { provide: APP_FILTER, useClass: ApiExceptionFilter },
  ],
})
class ExportsHttpModule {}

/** 夹具：本人三条（pending/completed/failed）与他人一条 */
interface SeededExports {
  readonly ownPending: ExportRequest;
  readonly ownCompleted: ExportRequest;
  readonly ownFailed: ExportRequest;
  readonly otherCompleted: ExportRequest;
}

interface TestApp {
  readonly app: INestApplication;
  readonly baseUrl: string;
  readonly store: InMemorySessionStore;
  readonly repository: InMemoryExportRepository;
  readonly artifacts: InMemoryExportArtifactStore;
  readonly seeded: SeededExports;
}

/** 服务端白名单全集（缺省导出范围） */
function profileFields(): string[] {
  return [...EXPORTABLE_FIELDS[ExportResource.Profile]];
}

/** 存储记录夹具：主体、状态、字段与句柄由调用方指定，模拟「存储里已存在记录」 */
function fixtureExportRequest(overrides: Partial<ExportRequest> = {}): ExportRequest {
  const base: ExportRequest = {
    id: randomUUID(),
    ownerUserId: STUDENT_1,
    resource: ExportResource.Profile,
    fields: profileFields(),
    status: ExportStatus.Completed,
    artifactId: randomUUID(),
    // 种子记录默认带**服务端签发的未来有效期**：下载成功路径必须真的在有效期内
    expiresAt: futureExpiry(),
    createdAt: '2026-01-06T00:00:00.000Z',
    updatedAt: '2026-01-06T00:00:05.000Z',
  };
  return { ...base, ...overrides };
}

/**
 * 极简 SQL 替身：按调用顺序返回预设结果，**不连数据库**。
 *
 * 用它把**真实 adapter** 的写回路径跑到「条件写入命中 0 行 + 诊断有行」这一格，
 * 于是测试里那个并发拒绝错误是由生产代码产出的（不是手搓一个带同名字段的对象），
 * 「adapter 拒绝 → service / controller 契约」这条链因此是端到端的。
 */
function conditionalWriteMissExecutor(): SqlExecutor {
  const responses: ReadonlyArray<{ rows: readonly unknown[]; rowCount: number }> = [
    { rows: [], rowCount: 0 },
    { rows: [{ status: ExportStatus.Completed }], rowCount: 1 },
  ];
  let index = 0;
  return {
    capabilities: { backend: 'postgres-test-double', persistent: true, productionReady: false },
    query: <Row = Record<string, unknown>>() => {
      const next = responses[Math.min(index, responses.length - 1)] ?? { rows: [], rowCount: 0 };
      index += 1;
      return Promise.resolve(next as { rows: readonly Row[]; rowCount: number });
    },
  };
}

/** 在真实 adapter 代码路径上拿到一次「并发推进被条件写入拒绝」的错误 */
async function adapterTransitionRejection(): Promise<PostgresExportRepositoryError> {
  const record = fixtureExportRequest({
    id: '77777777-7777-4777-8777-777777777777',
    // 存储 ID 域要求规范小写形 UUID（会话基线 `u-student-1` 不满足，属另一条已登记前置）
    ownerUserId: '11111111-1111-4111-8111-111111111111',
    status: ExportStatus.Failed,
    artifactId: undefined,
  });

  let captured: unknown;
  try {
    await new PostgresExportRepository(conditionalWriteMissExecutor()).save(record);
  } catch (error) {
    captured = error;
  }
  expect(captured).toBeInstanceOf(PostgresExportRepositoryError);
  return captured as PostgresExportRepositoryError;
}

/** 夹具内容固定，便于断言顺序、状态闭集与「他人内容不出现」 */
function buildSeededExports(): SeededExports {
  return {
    ownPending: fixtureExportRequest({
      id: '11111111-1111-4111-8111-111111111111',
      resource: ExportResource.Profile,
      fields: profileFields(),
      status: ExportStatus.Pending,
      artifactId: undefined,
      createdAt: '2026-01-06T00:00:00.000Z',
      updatedAt: '2026-01-06T00:00:00.000Z',
    }),
    ownCompleted: fixtureExportRequest({
      id: '22222222-2222-4222-8222-222222222222',
      resource: ExportResource.Achievement,
      fields: [...EXPORTABLE_FIELDS[ExportResource.Achievement]],
      status: ExportStatus.Completed,
      artifactId: '33333333-3333-4333-8333-333333333333',
      createdAt: '2026-01-06T01:00:00.000Z',
      updatedAt: '2026-01-06T01:00:03.000Z',
    }),
    ownFailed: fixtureExportRequest({
      id: '44444444-4444-4444-8444-444444444444',
      resource: ExportResource.Education,
      fields: [...EXPORTABLE_FIELDS[ExportResource.Education]],
      status: ExportStatus.Failed,
      artifactId: undefined,
      createdAt: '2026-01-06T02:00:00.000Z',
      updatedAt: '2026-01-06T02:00:01.000Z',
    }),
    otherCompleted: fixtureExportRequest({
      id: '55555555-5555-4555-8555-555555555555',
      ownerUserId: STUDENT_2,
      resource: ExportResource.Statistics,
      fields: [...EXPORTABLE_FIELDS[ExportResource.Statistics]],
      status: ExportStatus.Completed,
      artifactId: '66666666-6666-4666-8666-666666666666',
      createdAt: '2026-01-06T03:00:00.000Z',
      updatedAt: '2026-01-06T03:00:04.000Z',
    }),
  };
}

/** 启动真实应用并注入会话夹具（内存基线的显式 seed，不做隐式全局状态） */
async function startExportsApp(options: { readonly seed?: boolean } = {}): Promise<TestApp> {
  const app = await NestFactory.create(ExportsHttpModule, { logger: false });
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

  // 换绑后 `InMemoryExportRepository` 不再是 provider：内存实现只能从端口令牌取回
  // （否则容器里会同时存在一个「被端口使用」与一个「只被测试使用」的实例）
  const repository = app.get<InMemoryExportRepository>(EXPORT_REPOSITORY);
  const artifacts = app.get(InMemoryExportArtifactStore);
  const seeded = buildSeededExports();
  if (options.seed !== false) {
    await repository.create(seeded.ownPending);
    await repository.create(seeded.ownCompleted);
    await repository.create(seeded.ownFailed);
    await repository.create(seeded.otherCompleted);
  }

  return { app, baseUrl: `${await app.getUrl()}/api/v1`, store, repository, artifacts, seeded };
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

function viewsOf(body: ApiEnvelope<unknown>): ExportRequestView[] {
  return body.data as ExportRequestView[];
}

function viewOf(body: ApiEnvelope<unknown>): ExportRequestView {
  return body.data as ExportRequestView;
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

/** 断言一段正常响应内容里没有「产物位置 / 内部存储」的任何形态 */
function expectNoStorageLeak(content: string): void {
  for (const marker of STORAGE_LEAK_MARKERS) {
    expect(content).not.toContain(marker);
  }
}

interface PortSpies {
  readonly create: MockInstance;
  readonly list: MockInstance;
  readonly store: MockInstance;
}

function spyOnPorts(app: TestApp): PortSpies {
  return {
    create: vi.spyOn(app.repository, 'create'),
    list: vi.spyOn(app.repository, 'listByOwnerId'),
    store: vi.spyOn(app.artifacts, 'store'),
  };
}

/** 授权/认证/输入拒绝路径的硬要求：两个端口的方法一次都不被调用 */
function expectNoPortCalls(spies: PortSpies): void {
  expect(spies.create).not.toHaveBeenCalled();
  expect(spies.list).not.toHaveBeenCalled();
  expect(spies.store).not.toHaveBeenCalled();
}

afterAll(async () => {
  await Promise.all(startedApps.map((app) => app.close()));
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('导出切片：成功路径（真实 HTTP + 统一响应信封）', () => {
  it('学生创建本人画像导出：201、error 为 null、状态由服务端状态机写入、只返回白名单字段', async () => {
    const app = await startExportsApp();
    const before = new Date().toISOString();

    const res = await call(app.baseUrl, 'POST', '/me/exports', {
      headers: { ...bearer(SESSION_STUDENT_1), 'x-request-id': 'test-request-1' },
      body: { resource: ExportResource.Profile },
    });
    const after = new Date().toISOString();

    expect(res.status).toBe(201);
    expect(res.body.error).toBeNull();
    expect(res.body.meta.requestId).toBe('test-request-1');
    expect(typeof res.body.meta.generatedAt).toBe('string');

    const view = viewOf(res.body);
    expect(view.id).toMatch(UUID_PATTERN);
    expect(view.resource).toBe(ExportResource.Profile);
    expect(view.fields).toEqual(profileFields());
    expect(view.status).toBe(ExportStatus.Completed);

    // 输出白名单：每个字段都在白名单内，且必需字段齐全（闭集，无第七类信息）
    expect(Object.keys(view).every((key) => VIEW_WHITELIST.includes(key))).toBe(true);
    for (const field of EXPORT_REQUEST_VIEW_REQUIRED_FIELDS) {
      expect(view).toHaveProperty(field);
    }

    // 时间戳来自服务端时钟，且请求内推进（createdAt <= updatedAt）
    expect(Number.isFinite(Date.parse(view.createdAt))).toBe(true);
    expect(view.createdAt >= before).toBe(true);
    expect(view.updatedAt <= after).toBe(true);
    expect(view.createdAt <= view.updatedAt).toBe(true);

    // 归属、产物句柄、**服务端有效期**与产物位置都不随响应回传（有效期是服务端判定用的事实）
    const content = contentText(res);
    for (const field of ['ownerUserId', 'userId', 'roles', 'scope', 'groupId', 'expiresAt']) {
      expect(content).not.toContain(`"${field}"`);
    }
    expect(content).not.toContain(STUDENT_1);
    expectNoStorageLeak(content);

    // 存储事实：落库结论是 completed，句柄只存在服务端
    const stored = await app.repository.listByOwnerId(STUDENT_1);
    expect(stored).toHaveLength(4);
    const saved = stored[stored.length - 1];
    expect(saved?.id).toBe(view.id);
    expect(saved?.status).toBe(ExportStatus.Completed);
    expect(saved?.ownerUserId).toBe(STUDENT_1);
    expect(saved?.fields).toEqual(profileFields());
    expect(saved?.artifactId).toMatch(UUID_PATTERN);
    // **服务端签发有效期**：恰好是 createdAt + 服务端 TTL（UTC 绝对时刻），
    // 且请求体/查询串里的任何客户端取值都不参与（伪造值已在闭集门禁处 400）
    expect(saved?.expiresAt).toBeDefined();
    expect(saved?.expiresAt).toBe(
      new Date(Date.parse(String(saved?.createdAt)) + EXPORT_DOWNLOAD_TTL_MS).toISOString(),
    );
    expect(saved?.expiresAt).not.toBe(FORGED_EXPIRES_AT);
    expect(Date.parse(String(saved?.expiresAt))).toBeGreaterThan(
      Date.parse(String(saved?.createdAt)),
    );
    // 有效期不在响应里回显（也不作为响应头）
    expect(res.text).not.toContain(String(saved?.expiresAt));

    const descriptor = app.artifacts.findArtifactDescriptor(saved?.artifactId ?? '');
    expect(descriptor).toBeDefined();
    expect(descriptor?.ownerUserId).toBe(STUDENT_1);
    expect(descriptor?.resource).toBe(ExportResource.Profile);
    expect(descriptor?.fields).toEqual(profileFields());
    // 内部存储键是服务端事实：它派生自句柄，且从未出现在响应里
    expect(descriptor?.storageKey).toContain(IN_MEMORY_EXPORT_STORAGE_PREFIX);
    expect(descriptor?.storageKey).toContain(saved?.artifactId ?? 'no-artifact');
    expect(content).not.toContain(descriptor?.storageKey ?? 'no-storage-key');
  });

  it('fields 缺省即服务端白名单全集；显式声明时按首次出现去重且顺序稳定', async () => {
    const app = await startExportsApp();

    const statistics = await call(app.baseUrl, 'POST', '/me/exports', {
      headers: bearer(SESSION_STUDENT_1),
      body: { resource: ExportResource.Statistics },
    });
    expect(statistics.status).toBe(201);
    expect(viewOf(statistics.body).fields).toEqual([
      ...EXPORTABLE_FIELDS[ExportResource.Statistics],
    ]);
    expect(viewOf(statistics.body).status).toBe(ExportStatus.Completed);

    const achievements = await call(app.baseUrl, 'POST', '/me/exports', {
      headers: bearer(SESSION_STUDENT_1),
      body: { resource: ExportResource.Achievement, fields: ['title', 'awardLevel', 'title'] },
    });
    expect(achievements.status).toBe(201);
    expect(viewOf(achievements.body).fields).toEqual(['title', 'awardLevel']);

    const education = await call(app.baseUrl, 'POST', '/me/exports', {
      headers: bearer(SESSION_STUDENT_1),
      body: {
        resource: ExportResource.Education,
        fields: ['status', 'year', 'institutionOrDestination'],
      },
    });
    expect(education.status).toBe(201);
    // 资源字段名 `status`（升学状态）合法：它不是请求体顶层的导出任务状态
    expect(viewOf(education.body).fields).toEqual(['status', 'year', 'institutionOrDestination']);
  });

  it('每次创建都产生新的请求 ID 与新的产物句柄，既有记录从不被改写', async () => {
    const app = await startExportsApp();
    const before = await app.repository.listByOwnerId(STUDENT_1);

    const first = await call(app.baseUrl, 'POST', '/me/exports', {
      headers: bearer(SESSION_STUDENT_1),
      body: { resource: ExportResource.Profile },
    });
    const second = await call(app.baseUrl, 'POST', '/me/exports', {
      headers: bearer(SESSION_STUDENT_1),
      body: { resource: ExportResource.Profile },
    });

    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(viewOf(first.body).id).not.toBe(viewOf(second.body).id);

    const after = await app.repository.listByOwnerId(STUDENT_1);
    expect(after).toHaveLength(before.length + 2);
    // 既有夹具逐字段不变（导出请求只追加、结论不被覆盖）
    expect(after.slice(0, before.length)).toEqual([...before]);

    const firstStored = after[after.length - 2];
    const secondStored = after[after.length - 1];
    expect(firstStored?.artifactId).toMatch(UUID_PATTERN);
    expect(secondStored?.artifactId).toMatch(UUID_PATTERN);
    expect(firstStored?.artifactId).not.toBe(secondStored?.artifactId);
  });

  it('列表：200、只含本人记录、按创建顺序、逐字段白名单且不含他人记录', async () => {
    const app = await startExportsApp();
    const { seeded } = app;

    const res = await call(app.baseUrl, 'GET', '/me/exports', {
      headers: bearer(SESSION_STUDENT_1),
    });

    expect(res.status).toBe(200);
    expect(res.body.error).toBeNull();

    const views = viewsOf(res.body);
    expect(views.map((view) => view.id)).toEqual([
      seeded.ownPending.id,
      seeded.ownCompleted.id,
      seeded.ownFailed.id,
    ]);
    expect(views.map((view) => view.status)).toEqual([
      ExportStatus.Pending,
      ExportStatus.Completed,
      ExportStatus.Failed,
    ]);
    expect(views.map((view) => view.resource)).toEqual([
      ExportResource.Profile,
      ExportResource.Achievement,
      ExportResource.Education,
    ]);

    for (const view of views) {
      expect(Object.keys(view).every((key) => VIEW_WHITELIST.includes(key))).toBe(true);
      for (const field of EXPORT_REQUEST_VIEW_REQUIRED_FIELDS) {
        expect(view).toHaveProperty(field);
      }
    }

    // 他人记录与任何产物形态都不出现在响应里
    const content = contentText(res);
    for (const leaked of [
      seeded.otherCompleted.id,
      seeded.otherCompleted.artifactId ?? '',
      STUDENT_2,
      OTHER_PHONE,
    ]) {
      expect(content).not.toContain(leaked);
    }
    expectNoStorageLeak(content);
  });

  it('列表：本人无记录时稳定返回空数组，读取不产生写入副作用', async () => {
    const app = await startExportsApp({ seed: false });
    const spies = spyOnPorts(app);

    const res = await call(app.baseUrl, 'GET', '/me/exports', {
      headers: bearer(SESSION_STUDENT_1),
    });

    expect(res.status).toBe(200);
    expect(res.body.error).toBeNull();
    expect(viewsOf(res.body)).toEqual([]);
    // 导出请求只在 POST 创建：读取不产生任何写入
    expect(spies.list).toHaveBeenCalledTimes(1);
    expect(spies.create).not.toHaveBeenCalled();
    expect(spies.store).not.toHaveBeenCalled();
  });

  it('他人登录时只看得到自己的记录（列表按服务端主体取数）', async () => {
    const app = await startExportsApp();

    const res = await call(app.baseUrl, 'GET', '/me/exports', {
      headers: bearer(SESSION_STUDENT_2),
    });

    expect(res.status).toBe(200);
    expect(viewsOf(res.body).map((view) => view.id)).toEqual([app.seeded.otherCompleted.id]);
    const content = contentText(res);
    for (const leaked of [app.seeded.ownPending.id, app.seeded.ownCompleted.id, STUDENT_1]) {
      expect(content).not.toContain(leaked);
    }
  });
});

describe('导出切片：认证边界 401（fail-closed）', () => {
  const unauthenticatedCases: ReadonlyArray<{ name: string; headers: Record<string, string> }> = [
    { name: '未携带 Authorization', headers: {} },
    { name: 'scheme 不是 Bearer', headers: { authorization: `Token ${SESSION_STUDENT_1}` } },
    { name: 'Bearer 凭证过短', headers: { authorization: 'Bearer short' } },
    { name: '会话不存在', headers: bearer('session-does-not-exist') },
    { name: '会话主体含未登记角色', headers: bearer(SESSION_UNKNOWN_ROLE) },
  ];

  it.each(unauthenticatedCases)(
    '$name → 401 UNAUTHENTICATED，且两个端口一次都不被调用',
    async ({ headers }) => {
      const app = await startExportsApp();
      const spies = spyOnPorts(app);

      const list = await call(app.baseUrl, 'GET', '/me/exports', { headers });
      const create = await call(app.baseUrl, 'POST', '/me/exports', {
        headers,
        body: { resource: ExportResource.Profile },
      });

      for (const res of [list, create]) {
        expect(res.status).toBe(401);
        expect(res.body.data).toBeNull();
        expect(res.body.error?.code).toBe('UNAUTHENTICATED');
        // 不区分失败原因，避免给探测者额外信息
        expect(res.body.error?.message).toBe('登录状态无效或已过期，请重新登录');
      }

      expectNoPortCalls(spies);
      expect(contentText(create)).not.toContain(SESSION_UNKNOWN_ROLE);
      expect(contentText(create)).not.toContain('guest');
    },
  );

  it('未认证时即便带了伪造体/查询串/伪造头也是 401（认证先于一切输入）', async () => {
    const app = await startExportsApp();
    const spies = spyOnPorts(app);

    const res = await call(
      app.baseUrl,
      'POST',
      `/me/exports?status=completed&userId=${STUDENT_2}`,
      {
        headers: {
          'x-user-id': STUDENT_2,
          'x-roles': 'super_admin',
          'x-scope': 'GLOBAL',
          'x-file-url': FORGED_FILE_URL,
          'x-path': FORGED_PATH,
        },
        body: {
          resource: ExportResource.Profile,
          userId: STUDENT_2,
          status: ExportStatus.Completed,
          fileUrl: FORGED_FILE_URL,
          path: FORGED_PATH,
        },
      },
    );

    expect(res.status).toBe(401);
    expect(res.body.error?.code).toBe('UNAUTHENTICATED');
    expectNoPortCalls(spies);
    const content = contentText(res);
    for (const leaked of [STUDENT_2, FORGED_FILE_URL, FORGED_PATH, 'super_admin']) {
      expect(content).not.toContain(leaked);
    }
  });
});

describe('导出切片：越权 403（AuthorizationGuard + 服务端资源判定）', () => {
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
    '$name 创建/列表本人导出请求：403 FORBIDDEN，两个端口一次都不被调用',
    async ({ session, actor }) => {
      const app = await startExportsApp();
      const spies = spyOnPorts(app);

      const list = await call(app.baseUrl, 'GET', '/me/exports', { headers: bearer(session) });
      const create = await call(app.baseUrl, 'POST', '/me/exports', {
        headers: bearer(session),
        body: { resource: ExportResource.Profile },
      });

      for (const res of [list, create]) {
        expect(res.status).toBe(403);
        expect(res.body.data).toBeNull();
        expect(res.body.error?.code).toBe('FORBIDDEN');
        // 与「存储归属异常」共用同一文案，调用方无法据此区分内部原因
        expect(res.body.error?.message).toBe('无权执行该操作');
        expectNoStorageLeak(contentText(res));
      }

      expectNoPortCalls(spies);

      const content = contentText(create);
      for (const leaked of [STUDENT_1, actor, ExportResource.Profile, ExportStatus.Completed]) {
        expect(content).not.toContain(leaked);
      }
    },
  );

  it('授权先于字段级校验：越权主体即使不带请求体/带非法资源/带伪造字段也是 403', async () => {
    const app = await startExportsApp();
    const spies = spyOnPorts(app);

    const shapes: ReadonlyArray<unknown> = [
      undefined,
      {},
      { resource: 'users' },
      { resource: ExportResource.Profile, status: ExportStatus.Completed },
      { resource: ExportResource.Profile, path: FORGED_PATH },
      { userId: STUDENT_2, roles: [Role.SuperAdmin], scope: DataScope.Global },
    ];

    for (const body of shapes) {
      const res = await call(app.baseUrl, 'POST', '/me/exports', {
        headers: bearer(SESSION_ADMIN_1),
        ...(body === undefined ? {} : { body }),
      });

      // 403 而不是 400：未授权主体拿不到任何字段级反馈
      expect(res.status).toBe(403);
      expect(res.body.error?.code).toBe('FORBIDDEN');
    }

    expectNoPortCalls(spies);
  });

  it('越权请求不产生写入：存储里没有该主体的任何导出请求', async () => {
    const app = await startExportsApp();
    const before = await app.repository.listByOwnerId(ADMIN_1);

    const res = await call(app.baseUrl, 'POST', '/me/exports', {
      headers: bearer(SESSION_ADMIN_1),
      body: { resource: ExportResource.Profile },
    });

    expect(res.status).toBe(403);
    expect(before).toEqual([]);
    expect(await app.repository.listByOwnerId(ADMIN_1)).toEqual([]);
  });
});

describe('导出切片：输入拒绝 400（VALIDATION_FAILED，不取数/不落库）', () => {
  const injectedBodyFields: ReadonlyArray<{
    readonly name: string;
    readonly body: unknown;
    readonly expected: string;
    readonly leaked?: string;
  }> = [
    {
      name: 'userId',
      body: { resource: ExportResource.Profile, userId: STUDENT_2 },
      expected: '禁止设置服务端字段 userId',
      leaked: STUDENT_2,
    },
    {
      name: 'ownerUserId',
      body: { resource: ExportResource.Profile, ownerUserId: STUDENT_2 },
      expected: '禁止设置服务端字段 ownerUserId',
      leaked: STUDENT_2,
    },
    {
      name: 'roles/scope',
      body: {
        resource: ExportResource.Profile,
        roles: [Role.SuperAdmin],
        scope: DataScope.Global,
      },
      expected: '禁止设置服务端字段 roles',
      leaked: 'super_admin',
    },
    {
      name: 'groupId',
      body: { resource: ExportResource.Profile, groupId: 'g-1' },
      expected: '禁止设置服务端字段 groupId',
      leaked: 'g-1',
    },
    {
      name: 'status',
      body: { resource: ExportResource.Profile, status: ExportStatus.Completed },
      expected: '禁止设置服务端字段 status',
      leaked: ExportStatus.Completed,
    },
    {
      name: 'fileUrl',
      body: { resource: ExportResource.Profile, fileUrl: FORGED_FILE_URL },
      expected: '禁止设置服务端字段 fileUrl',
      leaked: FORGED_FILE_URL,
    },
    {
      name: 'path',
      body: { resource: ExportResource.Profile, path: FORGED_PATH },
      expected: '禁止设置服务端字段 path',
      leaked: FORGED_PATH,
    },
    {
      name: 'fileName',
      body: { resource: ExportResource.Profile, fileName: FORGED_FILE_NAME },
      expected: '禁止设置服务端字段 fileName',
      leaked: FORGED_FILE_NAME,
    },
    {
      name: 'storageKey',
      body: { resource: ExportResource.Profile, storageKey: FORGED_STORAGE_KEY },
      expected: '禁止设置服务端字段 storageKey',
      leaked: FORGED_STORAGE_KEY,
    },
    {
      name: 'downloadUrl（含下载签名）',
      body: { resource: ExportResource.Profile, downloadUrl: FORGED_DOWNLOAD_URL },
      expected: '禁止设置服务端字段 downloadUrl',
      leaked: FORGED_DOWNLOAD_URL,
    },
    {
      name: 'storageHandle（对象存储句柄）',
      body: { resource: ExportResource.Profile, storageHandle: FORGED_STORAGE_HANDLE },
      expected: '禁止设置服务端字段 storageHandle',
      leaked: FORGED_STORAGE_HANDLE,
    },
    {
      name: 'artifactId',
      body: { resource: ExportResource.Profile, artifactId: FORGED_ARTIFACT_ID },
      expected: '禁止设置服务端字段 artifactId',
      leaked: FORGED_ARTIFACT_ID,
    },
    {
      name: 'createdAt',
      body: { resource: ExportResource.Profile, createdAt: '2026-01-01T00:00:00.000Z' },
      expected: '禁止设置服务端字段 createdAt',
      leaked: '2026-01-01T00:00:00.000Z',
    },
    {
      name: 'expiresAt（有效期只由服务端签发）',
      body: { resource: ExportResource.Profile, expiresAt: FORGED_EXPIRES_AT },
      expected: '禁止设置服务端字段 expiresAt',
      leaked: FORGED_EXPIRES_AT,
    },
    {
      name: 'rows（导出内容）',
      body: { resource: ExportResource.Profile, rows: [PII_SECRET] },
      expected: '禁止设置服务端字段 rows',
      leaked: PII_SECRET,
    },
    {
      name: 'note（未声明字段）',
      body: { resource: ExportResource.Profile, note: '被改写' },
      expected: '请求体包含未声明字段 note',
      leaked: '被改写',
    },
  ];

  it.each(injectedBodyFields)(
    '请求体闭集：拒绝服务端字段（$name）：400，且不取数、不生成产物、不回显取值',
    async ({ body, expected, leaked }) => {
      const app = await startExportsApp();
      const spies = spyOnPorts(app);

      const res = await call(app.baseUrl, 'POST', '/me/exports', {
        headers: bearer(SESSION_STUDENT_1),
        body,
      });

      expect(res.status).toBe(400);
      expect(res.body.data).toBeNull();
      expect(res.body.error?.code).toBe('VALIDATION_FAILED');
      const messages = issuesOf(res.body).map((issue) => issue.message);
      expect(messages).toContain(expected);
      expectNoPortCalls(spies);
      // 拒绝原因只给字段名，不回显提交的取值
      if (leaked !== undefined) expect(contentText(res)).not.toContain(leaked);
    },
  );

  it('请求体闭集：一次提交多个服务端字段时逐项给出可区分的拒绝原因', async () => {
    const app = await startExportsApp();
    const spies = spyOnPorts(app);

    const res = await call(app.baseUrl, 'POST', '/me/exports', {
      headers: bearer(SESSION_STUDENT_1),
      body: {
        resource: ExportResource.Profile,
        userId: STUDENT_2,
        status: ExportStatus.Completed,
        path: FORGED_PATH,
        note: '被改写',
      },
    });

    expect(res.status).toBe(400);
    const messages = issuesOf(res.body).map((issue) => issue.message);
    expect(messages).toContain('禁止设置服务端字段 userId');
    expect(messages).toContain('禁止设置服务端字段 status');
    expect(messages).toContain('禁止设置服务端字段 path');
    expect(messages).toContain('请求体包含未声明字段 note');
    expectNoPortCalls(spies);
  });

  it('查询串闭集：GET/POST 出现任何查询参数都 400，且不取数、不生成产物', async () => {
    const cases: ReadonlyArray<{
      readonly query: string;
      readonly expected: string;
      readonly leaked?: string;
    }> = [
      { query: 'status=completed', expected: '禁止使用查询参数 status', leaked: 'completed' },
      { query: `userId=${STUDENT_2}`, expected: '禁止使用查询参数 userId', leaked: STUDENT_2 },
      { query: 'roles=super_admin', expected: '禁止使用查询参数 roles', leaked: 'super_admin' },
      { query: 'scope=GLOBAL', expected: '禁止使用查询参数 scope', leaked: 'GLOBAL' },
      { query: 'groupId=g-1', expected: '禁止使用查询参数 groupId', leaked: 'g-1' },
      {
        query: `fileUrl=${encodeURIComponent(FORGED_FILE_URL)}`,
        expected: '禁止使用查询参数 fileUrl',
        leaked: FORGED_FILE_URL,
      },
      {
        query: `path=${encodeURIComponent(FORGED_PATH)}`,
        expected: '禁止使用查询参数 path',
        leaked: FORGED_PATH,
      },
      {
        query: `artifactId=${FORGED_ARTIFACT_ID}`,
        expected: '禁止使用查询参数 artifactId',
        leaked: FORGED_ARTIFACT_ID,
      },
      {
        query: `downloadUrl=${encodeURIComponent(FORGED_DOWNLOAD_URL)}`,
        expected: '禁止使用查询参数 downloadUrl',
        leaked: FORGED_DOWNLOAD_URL,
      },
      {
        query: `storageHandle=${encodeURIComponent(FORGED_STORAGE_HANDLE)}`,
        expected: '禁止使用查询参数 storageHandle',
        leaked: FORGED_STORAGE_HANDLE,
      },
      {
        query: `expiresAt=${encodeURIComponent(FORGED_EXPIRES_AT)}`,
        expected: '禁止使用查询参数 expiresAt',
        leaked: FORGED_EXPIRES_AT,
      },
      { query: 'page=1&pageSize=10', expected: '本端点不接受查询参数 page' },
    ];

    for (const { query, expected, leaked } of cases) {
      const app = await startExportsApp();
      const spies = spyOnPorts(app);

      const list = await call(app.baseUrl, 'GET', `/me/exports?${query}`, {
        headers: bearer(SESSION_STUDENT_1),
      });
      const create = await call(app.baseUrl, 'POST', `/me/exports?${query}`, {
        headers: bearer(SESSION_STUDENT_1),
        body: { resource: ExportResource.Profile },
      });

      for (const res of [list, create]) {
        expect(res.status).toBe(400);
        expect(res.body.data).toBeNull();
        expect(res.body.error?.code).toBe('VALIDATION_FAILED');
        const messages = issuesOf(res.body).map((issue) => issue.message);
        expect(messages.some((message) => message.includes(expected))).toBe(true);
        if (leaked !== undefined) expect(contentText(res)).not.toContain(leaked);
      }

      expectNoPortCalls(spies);
    }
  });

  it('查询串闭集：重复参数同样 400（键名违规，不被解析为合法输入）', async () => {
    const app = await startExportsApp();

    const res = await call(app.baseUrl, 'GET', '/me/exports?status=completed&status=pending', {
      headers: bearer(SESSION_STUDENT_1),
    });

    expect(res.status).toBe(400);
    expect(res.body.error?.code).toBe('VALIDATION_FAILED');
  });

  it('空查询串（`?`）不算输入：列表 200、创建 201', async () => {
    const app = await startExportsApp();

    const list = await call(app.baseUrl, 'GET', '/me/exports?', {
      headers: bearer(SESSION_STUDENT_1),
    });
    const create = await call(app.baseUrl, 'POST', '/me/exports?', {
      headers: bearer(SESSION_STUDENT_1),
      body: { resource: ExportResource.Education },
    });

    expect(list.status).toBe(200);
    expect(viewsOf(list.body)).toHaveLength(3);
    expect(create.status).toBe(201);
    expect(viewOf(create.body).status).toBe(ExportStatus.Completed);
  });

  const resourceCases: ReadonlyArray<{
    readonly name: string;
    readonly body: unknown;
    readonly expected: string;
    readonly leaked?: string;
  }> = [
    { name: '缺省 resource', body: {}, expected: '必须声明导出资源' },
    {
      name: '未登记资源',
      body: { resource: 'users' },
      expected: '导出资源不在服务端白名单内',
      leaked: 'users',
    },
    {
      name: '通配/权限式资源',
      body: { resource: 'export:profile:create' },
      expected: '导出资源不在服务端白名单内',
      leaked: 'export:profile:create',
    },
    {
      name: '带路径的资源',
      body: { resource: FORGED_PATH },
      expected: '导出资源不在服务端白名单内',
      leaked: FORGED_PATH,
    },
    {
      name: 'PII 作为资源',
      body: { resource: PII_ID_CARD },
      expected: '导出资源不在服务端白名单内',
      leaked: PII_ID_CARD,
    },
    { name: '非字符串资源', body: { resource: 42 }, expected: '导出资源必须是字符串' },
    { name: 'null 资源', body: { resource: null }, expected: '导出资源必须是字符串' },
    { name: '数组请求体', body: [], expected: 'Expected object' },
  ];

  it.each(resourceCases)(
    '资源闭集（$name）：400，且不取数、不生成产物、不回显取值',
    async ({ body, expected, leaked }) => {
      const app = await startExportsApp();
      const spies = spyOnPorts(app);

      const res = await call(app.baseUrl, 'POST', '/me/exports', {
        headers: bearer(SESSION_STUDENT_1),
        body,
      });

      expect(res.status).toBe(400);
      expect(res.body.data).toBeNull();
      expect(res.body.error?.code).toBe('VALIDATION_FAILED');
      const messages = issuesOf(res.body).map((issue) => issue.message);
      expect(messages.some((message) => message.includes(expected))).toBe(true);
      if (leaked !== undefined) expect(contentText(res)).not.toContain(leaked);
      expectNoPortCalls(spies);
    },
  );

  it('标量 JSON 请求体（非对象）→ 400：解析失败不回显请求体片段，也不触达端口', async () => {
    const app = await startExportsApp({ seed: false });
    const spies = spyOnPorts(app);

    const res = await call(app.baseUrl, 'POST', '/me/exports', {
      headers: bearer(SESSION_STUDENT_1),
      body: `resource=${ExportResource.Profile}`,
    });

    // 请求体不是对象：由 JSON 严格解析（或字段级 schema）拒绝，均为 400
    expect(res.status).toBe(400);
    expect(res.body.data).toBeNull();
    expect(res.body.error?.code).toBe('VALIDATION_FAILED');
    // 解析错误消息不回显原始请求体片段
    expect(contentText(res)).not.toContain(`resource=${ExportResource.Profile}`);
    expectNoPortCalls(spies);
  });

  const fieldCases: ReadonlyArray<{
    readonly name: string;
    readonly fields: unknown;
    readonly expected: string;
    readonly leaked?: string;
  }> = [
    {
      name: '高敏画像字段（name 不在白名单）',
      fields: ['name'],
      expected: '导出字段不在资源 profile 的服务端白名单内',
      leaked: 'name',
    },
    {
      name: '证件号作为字段名',
      fields: [PII_ID_CARD],
      expected: '导出字段不在资源 profile 的服务端白名单内',
      leaked: PII_ID_CARD,
    },
    {
      name: '路径作为字段名',
      fields: [FORGED_PATH],
      expected: '导出字段不在资源 profile 的服务端白名单内',
      leaked: FORGED_PATH,
    },
    {
      name: '别的资源的字段（越资源）',
      fields: ['educationRecords'],
      expected: '导出字段不在资源 profile 的服务端白名单内',
      leaked: 'educationRecords',
    },
    { name: '空字段数组', fields: [], expected: '导出字段至少 1 项' },
    {
      name: '字段数超上限',
      fields: [
        ...profileFields(),
        'title',
        'awardLevel',
        'description',
        'achievedAt',
        'reviewStatus',
        'year',
        'institutionOrDestination',
      ],
      expected: `导出字段最多 ${EXPORT_MAX_FIELD_COUNT} 项`,
    },
    { name: '非字符串字段名', fields: [42], expected: 'Expected string' },
    { name: '字段不是数组', fields: 'title', expected: 'Expected array' },
  ];

  it.each(fieldCases)(
    '字段白名单闭集（$name）：400，且不取数、不生成产物、不回显取值',
    async ({ fields, expected, leaked }) => {
      const app = await startExportsApp();
      const spies = spyOnPorts(app);

      const res = await call(app.baseUrl, 'POST', '/me/exports', {
        headers: bearer(SESSION_STUDENT_1),
        body: { resource: ExportResource.Profile, fields },
      });

      expect(res.status).toBe(400);
      expect(res.body.data).toBeNull();
      expect(res.body.error?.code).toBe('VALIDATION_FAILED');
      const messages = issuesOf(res.body).map((issue) => issue.message);
      expect(messages.some((message) => message.includes(expected))).toBe(true);
      if (leaked !== undefined) {
        // 拒绝原因只给字段下标，不回显被拒绝的字段取值
        expect(messages.some((message) => message.includes(leaked))).toBe(false);
        expect(contentText(res)).not.toContain(leaked);
      }
      expectNoPortCalls(spies);
    },
  );

  it('未注册的路由/方法形态不产生新行为：只新增 GET/POST 两条路由（其余 404）', async () => {
    const app = await startExportsApp();

    const shapes: ReadonlyArray<readonly ['GET' | 'POST' | 'PATCH' | 'DELETE', string]> = [
      ['GET', `/me/exports/${app.seeded.ownCompleted.id}`],
      ['GET', '/me/export'],
      ['PATCH', '/me/exports'],
      ['DELETE', '/me/exports'],
      ['POST', '/me/exports/download'],
    ];

    for (const [method, path] of shapes) {
      const res = await call(app.baseUrl, method, path, { headers: bearer(SESSION_STUDENT_1) });
      expect(res.status).toBe(404);
      expect(res.body.error?.code).toBe('NOT_FOUND');
    }
  });
});

describe('导出切片：claims 伪造（客户端声明不进入判定、归属、状态与输出）', () => {
  const forgedHeaders = {
    'x-user-id': STUDENT_2,
    'x-actor-user-id': STUDENT_2,
    'x-owner-user-id': STUDENT_2,
    'x-roles': 'super_admin,admin',
    'x-scope': 'GLOBAL',
    'x-group-id': 'g-1',
    'x-status': ExportStatus.Completed,
    'x-artifact-id': FORGED_ARTIFACT_ID,
    'x-file-url': FORGED_FILE_URL,
    'x-path': FORGED_PATH,
    'x-request-id': FORGED_REQUEST_ID,
  };

  it('伪造自定义头不能改变归属、状态、判定入参与产物句柄：仍只写会话主体本人', async () => {
    const app = await startExportsApp();
    const adapter = app.app.get<RuoYiAuthzAdapter>(RUOYI_AUTHZ_ADAPTER);
    const checkAuthorization = vi.spyOn(adapter, 'checkAuthorization');

    const res = await call(app.baseUrl, 'POST', '/me/exports', {
      headers: { ...bearer(SESSION_STUDENT_1), ...forgedHeaders },
      body: { resource: ExportResource.Profile },
    });

    expect(res.status).toBe(201);
    const view = viewOf(res.body);
    expect(view.resource).toBe(ExportResource.Profile);
    expect(view.status).toBe(ExportStatus.Completed);

    // 判定入参是会话主体与**服务端常量**；伪造头没有进入任何一项
    expect(checkAuthorization).toHaveBeenCalledWith(
      { userId: STUDENT_1, roles: [Role.Student] },
      {
        permission: EXPORT_ENTRY_PERMISSION,
        scope: DataScope.Self,
        resourceUserId: STUDENT_1,
      },
    );
    for (const authCall of checkAuthorization.mock.calls) {
      expect(authCall[0]).toEqual({ userId: STUDENT_1, roles: [Role.Student] });
      expect(authCall[1].scope).toBe(DataScope.Self);
      expect(authCall[1].resourceUserId).toBe(STUDENT_1);
    }

    // 写入的主体与产物句柄不受伪造头影响
    const stored = await app.repository.listByOwnerId(STUDENT_1);
    const saved = stored[stored.length - 1];
    expect(saved?.ownerUserId).toBe(STUDENT_1);
    expect(saved?.artifactId).not.toBe(FORGED_ARTIFACT_ID);
    expect(await app.repository.listByOwnerId(STUDENT_2)).toHaveLength(1);

    const content = contentText(res);
    for (const leaked of [
      STUDENT_2,
      FORGED_ARTIFACT_ID,
      FORGED_FILE_URL,
      FORGED_PATH,
      'super_admin',
      'GLOBAL',
      'g-1',
    ]) {
      expect(content).not.toContain(leaked);
    }
    expectNoStorageLeak(content);
  });

  it('伪造头不能改变列表可见范围：仍只返回会话主体本人记录', async () => {
    const app = await startExportsApp();
    const { seeded } = app;

    const res = await call(app.baseUrl, 'GET', '/me/exports', {
      headers: { ...bearer(SESSION_STUDENT_1), ...forgedHeaders },
    });

    expect(res.status).toBe(200);
    expect(viewsOf(res.body).map((view) => view.id)).toEqual([
      seeded.ownPending.id,
      seeded.ownCompleted.id,
      seeded.ownFailed.id,
    ]);

    const content = contentText(res);
    for (const leaked of [seeded.otherCompleted.id, STUDENT_2, FORGED_ARTIFACT_ID, FORGED_PATH]) {
      expect(content).not.toContain(leaked);
    }
  });

  it('伪造更高角色的声明不能让越权主体通过（admin + 伪造 SELF/超管声明仍是 403）', async () => {
    const app = await startExportsApp();
    const spies = spyOnPorts(app);

    const res = await call(app.baseUrl, 'POST', '/me/exports', {
      headers: {
        ...bearer(SESSION_ADMIN_1),
        'x-user-id': ADMIN_1,
        'x-roles': 'super_admin',
        'x-scope': 'SELF',
      },
      body: { resource: ExportResource.Profile, scope: DataScope.Self, userId: ADMIN_1 },
    });

    expect(res.status).toBe(403);
    expect(res.body.error?.code).toBe('FORBIDDEN');
    expectNoPortCalls(spies);
  });
});

describe('导出切片：状态机（pending → completed / failed）', () => {
  it('成功：仓储 create 收到入口态 pending，save 收到终态 completed，入口记录不带产物句柄', async () => {
    const app = await startExportsApp();
    const create = vi.spyOn(app.repository, 'create');
    const save = vi.spyOn(app.repository, 'save');

    const res = await call(app.baseUrl, 'POST', '/me/exports', {
      headers: bearer(SESSION_STUDENT_1),
      body: { resource: ExportResource.Profile },
    });

    expect(res.status).toBe(201);
    expect(viewOf(res.body).status).toBe(ExportStatus.Completed);

    expect(create).toHaveBeenCalledTimes(1);
    const created = create.mock.calls[0]?.[0];
    expect(created?.status).toBe(EXPORT_ENTRY_STATUS);
    expect(created?.status).toBe(ExportStatus.Pending);
    expect(created?.artifactId).toBeUndefined();
    expect(created?.ownerUserId).toBe(STUDENT_1);
    expect(created?.fields).toEqual(profileFields());

    expect(save).toHaveBeenCalledTimes(1);
    const saved = save.mock.calls[0]?.[0];
    expect(saved?.status).toBe(ExportStatus.Completed);
    expect(saved?.artifactId).toMatch(UUID_PATTERN);
    expect(saved?.id).toBe(created?.id);
    expect(saved?.ownerUserId).toBe(STUDENT_1);
  });

  it('产物生成失败（产物存储抛异常）→ 201 + failed 终态：不 500、不落库句柄、不外发内部原文', async () => {
    const errorLog = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const app = await startExportsApp();
    vi.spyOn(app.artifacts, 'store').mockImplementation(() => {
      throw new Error(
        `ENOSPC: no space left on device, open '${FORGED_PATH}' phone=${OTHER_PHONE}`,
      );
    });

    const res = await call(app.baseUrl, 'POST', '/me/exports', {
      headers: bearer(SESSION_STUDENT_1),
      body: { resource: ExportResource.Profile },
    });

    expect(res.status).toBe(201);
    expect(res.body.error).toBeNull();
    expect(viewOf(res.body).status).toBe(ExportStatus.Failed);

    // 记录收敛到 failed 终态，且不带任何产物句柄
    const stored = await app.repository.listByOwnerId(STUDENT_1);
    const saved = stored[stored.length - 1];
    expect(saved?.status).toBe(ExportStatus.Failed);
    expect(saved?.artifactId).toBeUndefined();

    const content = contentText(res);
    for (const leaked of [
      'ENOSPC',
      'no space left',
      FORGED_PATH,
      OTHER_PHONE,
      FORGED_FILE_NAME,
      IN_MEMORY_EXPORT_STORAGE_PREFIX,
    ]) {
      expect(content).not.toContain(leaked);
    }
    expectNoStorageLeak(content);

    // 日志只写错误名与稳定前缀，不写内部原文
    const logs = errorLog.mock.calls.flat().join(' ');
    expect(logs).toContain('[exports]');
    expect(logs).not.toContain('ENOSPC');
    expect(logs).not.toContain(FORGED_PATH);
    expect(logs).not.toContain(OTHER_PHONE);
  });

  it('产物存储返回非法句柄 → failed 终态：非法返回值既不落库也不外发', async () => {
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const app = await startExportsApp();
    const store = vi.spyOn(app.artifacts, 'store');

    const badRefs: ReadonlyArray<unknown> = [
      { artifactId: 'not-a-uuid' },
      { artifactId: FORGED_ARTIFACT_ID, storageKey: FORGED_STORAGE_KEY },
      {},
      undefined,
      null,
      [FORGED_ARTIFACT_ID],
      'memory-export-artifacts/secret',
    ];

    for (const ref of badRefs) {
      store.mockReturnValue(ref as never);

      const res = await call(app.baseUrl, 'POST', '/me/exports', {
        headers: bearer(SESSION_STUDENT_1),
        body: { resource: ExportResource.Profile },
      });

      expect(res.status).toBe(201);
      expect(viewOf(res.body).status).toBe(ExportStatus.Failed);

      const content = contentText(res);
      expect(content).not.toContain('not-a-uuid');
      expect(content).not.toContain(FORGED_STORAGE_KEY);
      expect(content).not.toContain(FORGED_ARTIFACT_ID);
      expectNoStorageLeak(content);
    }

    // 七次创建全部收敛为 failed，且没有任何一条带上产物句柄
    const stored = await app.repository.listByOwnerId(STUDENT_1);
    expect(stored).toHaveLength(3 + badRefs.length);
    for (const record of stored.slice(3)) {
      expect(record.status).toBe(ExportStatus.Failed);
      expect(record.artifactId).toBeUndefined();
    }
  });

  it('仓储返回非 pending 记录（重复处理/数据被改写）→ 409 STATE_TRANSITION_INVALID，且不产生产物副作用', async () => {
    const app = await startExportsApp();
    const store = vi.spyOn(app.artifacts, 'store');
    const save = vi.spyOn(app.repository, 'save');
    // 模拟「记录已经是 completed 却被再次推进」：状态机必须拦截，绝不覆盖既有结论
    vi.spyOn(app.repository, 'create').mockImplementation(async (record) => ({
      ...record,
      status: ExportStatus.Completed,
      artifactId: FORGED_ARTIFACT_ID,
      fields: [...record.fields],
    }));

    const res = await call(app.baseUrl, 'POST', '/me/exports', {
      headers: bearer(SESSION_STUDENT_1),
      body: { resource: ExportResource.Profile },
    });

    expect(res.status).toBe(409);
    expect(res.body.data).toBeNull();
    expect(res.body.error?.code).toBe('STATE_TRANSITION_INVALID');
    // 状态机门禁先于产物副作用与落库
    expect(store).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
  });

  it('adapter 条件写入被并发拒绝 → 409 STATE_TRANSITION_INVALID（不是 500），且不外泄 SQL/归属/路径/PII', async () => {
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const app = await startExportsApp({ seed: false });

    // 真实的 adapter 拒绝对象：端口标记必须可判定（service 只按结构化 code 映射）
    const rejection = await adapterTransitionRejection();
    expect(rejection.code).toBe(EXPORT_TRANSITION_REJECTED);
    expect(isExportTransitionRejection(rejection)).toBe(true);

    vi.spyOn(app.repository, 'save').mockImplementation(() => {
      throw rejection;
    });

    const res = await call(app.baseUrl, 'POST', '/me/exports', {
      headers: bearer(SESSION_STUDENT_1),
      body: { resource: ExportResource.Profile },
    });

    expect(res.status).toBe(409);
    expect(res.body.data).toBeNull();
    expect(res.body.error?.code).toBe('STATE_TRANSITION_INVALID');
    // 对外是状态机的安全文案（与状态机门禁路径同一个出口），不是 adapter 的错误消息
    expect(res.body.error?.message).toBe('export request 不允许从 pending 转移到 completed');

    const content = contentText(res);
    for (const leaked of [
      rejection.message,
      'PostgresExportRepositoryError',
      EXPORT_TRANSITION_REJECTED,
      'export_jobs',
      'requester_id',
      'UPDATE',
      'SELECT',
      STUDENT_1,
      STUDENT_2,
      FORGED_PATH,
      FORGED_FILE_URL,
      FORGED_STORAGE_KEY,
      PII_ID_CARD,
      PII_SECRET,
      OTHER_PHONE,
    ]) {
      expect(content, leaked).not.toContain(leaked);
    }
    expectNoStorageLeak(content);

    // 入口记录仍是 pending：结论未落库，不得谎报为 completed / failed
    expect((await app.repository.listByOwnerId(STUDENT_1)).map((record) => record.status)).toEqual([
      ExportStatus.Pending,
    ]);
  });

  it('存储层其它失败码（NOT_FOUND / OWNER_VIOLATION / EXECUTOR_FAILURE）继续 500：409 映射不是整体降级', async () => {
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

    const failures = [
      new PostgresExportRepositoryError(
        'NOT_FOUND',
        `导出请求不存在（或不属于该主体）: owner=${STUDENT_1} path=${FORGED_PATH}`,
        ['id'],
      ),
      new PostgresExportRepositoryError(
        'OWNER_VIOLATION',
        `写回记录的归属与请求主体不一致: requester_id=${STUDENT_1}`,
        ['requester_id'],
      ),
      new PostgresExportRepositoryError(
        'EXECUTOR_FAILURE',
        `connect ECONNREFUSED 10.0.0.9:5432 ${FORGED_STORAGE_KEY} s3://internal-bucket`,
        ['executor'],
      ),
    ];

    for (const failure of failures) {
      expect(isExportTransitionRejection(failure), failure.code).toBe(false);

      const app = await startExportsApp({ seed: false });
      vi.spyOn(app.repository, 'save').mockImplementation(() => {
        throw failure;
      });

      const res = await call(app.baseUrl, 'POST', '/me/exports', {
        headers: bearer(SESSION_STUDENT_1),
        body: { resource: ExportResource.Profile },
      });

      expect(res.status, failure.code).toBe(500);
      expect(res.body.data).toBeNull();
      expect(res.body.error?.code).toBe('INTERNAL_ERROR');
      expect(res.body.error?.message).toBe(INTERNAL_ERROR_MESSAGE);

      const content = contentText(res);
      for (const leaked of [
        failure.message,
        failure.code,
        'PostgresExportRepositoryError',
        STUDENT_1,
        FORGED_PATH,
        FORGED_STORAGE_KEY,
        'requester_id',
        'export_jobs',
      ]) {
        expect(content, `${failure.code}:${leaked}`).not.toContain(leaked);
      }
    }
  });

  it('仓储写回未如实持久化结论（状态未推进 / 句柄被替换或丢失）→ 500 完整性失败', async () => {
    const errorLog = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

    const cases: ReadonlyArray<{
      readonly name: string;
      readonly save: (record: ExportRequest) => ExportRequest;
    }> = [
      {
        name: '状态未推进',
        save: (record) => ({ ...record, status: ExportStatus.Pending, artifactId: undefined }),
      },
      { name: '句柄被替换', save: (record) => ({ ...record, artifactId: randomUUID() }) },
      { name: '句柄未落库', save: (record) => ({ ...record, artifactId: undefined }) },
    ];

    for (const { name, save } of cases) {
      const app = await startExportsApp();
      vi.spyOn(app.repository, 'save').mockImplementation(async (record) => ({
        ...save(record),
        fields: [...record.fields],
      }));

      const res = await call(app.baseUrl, 'POST', '/me/exports', {
        headers: bearer(SESSION_STUDENT_1),
        body: { resource: ExportResource.Profile },
      });

      expect(res.status, name).toBe(500);
      expect(res.body.data).toBeNull();
      expect(res.body.error?.code).toBe('INTERNAL_ERROR');
      // 500 一律使用统一对外文案，内部完整性文案不外发
      expect(res.body.error?.message).toBe(INTERNAL_ERROR_MESSAGE);
      expect(JSON.stringify(res.body)).not.toContain(EXPORT_REQUEST_INTEGRITY_MESSAGE);
      expect(contentText(res)).not.toContain(STUDENT_1);
    }

    const logs = errorLog.mock.calls.flat().join(' ');
    expect(logs).toContain('[exports]');
  });

  it('状态机闭集与终态不可再转移（纯函数门禁非恒真）', () => {
    expect(EXPORT_STATUS_VALUES).toEqual(['pending', 'completed', 'failed']);
    expect(EXPORT_ENTRY_STATUS).toBe(ExportStatus.Pending);
    expect(EXPORT_TERMINAL_STATUSES).toEqual([ExportStatus.Completed, ExportStatus.Failed]);
    expect(EXPORT_STATUS_TRANSITIONS).toEqual({
      [ExportStatus.Pending]: [ExportStatus.Completed, ExportStatus.Failed],
      [ExportStatus.Completed]: [],
      [ExportStatus.Failed]: [],
    });

    expect(canTransitionExport(ExportStatus.Pending, ExportStatus.Completed)).toBe(true);
    expect(canTransitionExport(ExportStatus.Pending, ExportStatus.Failed)).toBe(true);
    // 入口不可自环、终态不可回退、终态之间不可互转
    expect(canTransitionExport(ExportStatus.Pending, ExportStatus.Pending)).toBe(false);
    expect(canTransitionExport(ExportStatus.Completed, ExportStatus.Failed)).toBe(false);
    expect(canTransitionExport(ExportStatus.Failed, ExportStatus.Completed)).toBe(false);
    expect(canTransitionExport(ExportStatus.Completed, ExportStatus.Pending)).toBe(false);

    expect(nextExportStatuses(ExportStatus.Pending)).toEqual([
      ExportStatus.Completed,
      ExportStatus.Failed,
    ]);
    expect(nextExportStatuses(ExportStatus.Completed)).toEqual([]);
    expect(isExportTerminal(ExportStatus.Completed)).toBe(true);
    expect(isExportTerminal(ExportStatus.Failed)).toBe(true);
    expect(isExportTerminal(ExportStatus.Pending)).toBe(false);
    expect(isExportProcessable(ExportStatus.Pending)).toBe(true);
    expect(isExportProcessable(ExportStatus.Completed)).toBe(false);

    expect(() =>
      assertExportTransition(ExportStatus.Pending, ExportStatus.Completed),
    ).not.toThrow();

    // 非法转移（入口自环、终态回退、终态互转、终态自环）必须真正被拦截为
    // STATE_TRANSITION_INVALID，而不是静默通过（门禁非恒真）
    const illegalTransitions: ReadonlyArray<readonly [ExportStatus, ExportStatus]> = [
      [ExportStatus.Pending, ExportStatus.Pending],
      [ExportStatus.Completed, ExportStatus.Pending],
      [ExportStatus.Completed, ExportStatus.Failed],
      [ExportStatus.Completed, ExportStatus.Completed],
      [ExportStatus.Failed, ExportStatus.Pending],
      [ExportStatus.Failed, ExportStatus.Completed],
      [ExportStatus.Failed, ExportStatus.Failed],
    ];
    for (const [from, to] of illegalTransitions) {
      expect(canTransitionExport(from, to), `${from} -> ${to}`).toBe(false);
      let caught: unknown;
      try {
        assertExportTransition(from, to);
      } catch (error) {
        caught = error;
      }
      expect((caught as { code?: string } | undefined)?.code, `${from} -> ${to}`).toBe(
        'STATE_TRANSITION_INVALID',
      );
    }
  });
});

describe('导出切片：PII 与 fail-closed 500', () => {
  it('存储字段里出现证件号（不在白名单）→ 500：响应与日志都不含取值', async () => {
    const errorLog = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const app = await startExportsApp({ seed: false });
    await app.repository.create(
      fixtureExportRequest({
        id: '77777777-7777-4777-8777-777777777777',
        fields: [PII_ID_CARD],
        status: ExportStatus.Pending,
        artifactId: undefined,
      }),
    );

    const res = await call(app.baseUrl, 'GET', '/me/exports', {
      headers: bearer(SESSION_STUDENT_1),
    });

    expect(res.status).toBe(500);
    expect(res.body.data).toBeNull();
    expect(res.body.error?.code).toBe('INTERNAL_ERROR');
    expect(res.body.error?.message).toBe(INTERNAL_ERROR_MESSAGE);

    const content = contentText(res);
    for (const leaked of [PII_ID_CARD, STUDENT_1]) {
      expect(content).not.toContain(leaked);
    }

    // 日志只有字段路径与违规类型，没有取值
    const logs = errorLog.mock.calls.flat().join(' ');
    expect(logs).toContain('[exports]');
    expect(logs).toContain('fields');
    expect(logs).not.toContain(PII_ID_CARD);
  });

  it('存储记录多出字段（fileUrl/path/storageKey）→ 500：不外发多出的字段与取值', async () => {
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const app = await startExportsApp({ seed: false });
    await app.repository.create({
      ...fixtureExportRequest({ status: ExportStatus.Completed }),
      fileUrl: FORGED_FILE_URL,
      path: FORGED_PATH,
      storageKey: FORGED_STORAGE_KEY,
    } as ExportRequest);

    const res = await call(app.baseUrl, 'GET', '/me/exports', {
      headers: bearer(SESSION_STUDENT_1),
    });

    expect(res.status).toBe(500);
    expect(res.body.error?.code).toBe('INTERNAL_ERROR');
    const content = contentText(res);
    expect(content).not.toContain(FORGED_FILE_URL);
    expect(content).not.toContain(FORGED_PATH);
    expect(content).not.toContain(FORGED_STORAGE_KEY);
    expectNoStorageLeak(content);
  });

  it('仓储返回归属不一致的记录（未按主体过滤）→ 500：不把他人记录发给调用方', async () => {
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const app = await startExportsApp();
    vi.spyOn(app.repository, 'listByOwnerId').mockResolvedValue([app.seeded.otherCompleted]);

    const res = await call(app.baseUrl, 'GET', '/me/exports', {
      headers: bearer(SESSION_STUDENT_1),
    });

    expect(res.status).toBe(500);
    expect(res.body.error?.code).toBe('INTERNAL_ERROR');
    const content = contentText(res);
    expect(content).not.toContain(app.seeded.otherCompleted.id);
    expect(content).not.toContain(STUDENT_2);
    expect(content).not.toContain(app.seeded.otherCompleted.artifactId ?? 'no-artifact');
  });

  it('状态与产物句柄不自洽（completed 无产物 / 非 completed 带产物）→ 500', async () => {
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

    const broken: ReadonlyArray<Partial<ExportRequest>> = [
      { status: ExportStatus.Completed, artifactId: undefined },
      { status: ExportStatus.Pending, artifactId: FORGED_ARTIFACT_ID },
      { status: ExportStatus.Failed, artifactId: FORGED_ARTIFACT_ID },
    ];

    for (const overrides of broken) {
      const app = await startExportsApp({ seed: false });
      await app.repository.create(fixtureExportRequest(overrides));

      const res = await call(app.baseUrl, 'GET', '/me/exports', {
        headers: bearer(SESSION_STUDENT_1),
      });

      expect(res.status).toBe(500);
      expect(res.body.error?.code).toBe('INTERNAL_ERROR');
      expect(contentText(res)).not.toContain(FORGED_ARTIFACT_ID);
    }
  });

  it('未知资源/状态枚举、非法时间与非法归属一律 500（闭集不作合法值外发）', async () => {
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

    const broken: ReadonlyArray<ExportRequest> = [
      fixtureExportRequest({ resource: 'users' as ExportResource }),
      fixtureExportRequest({ status: 'unknown' as ExportStatus }),
      fixtureExportRequest({ createdAt: '2026/01/06' }),
      fixtureExportRequest({ updatedAt: 'not-a-time' }),
      fixtureExportRequest({ id: 'not-a-uuid' }),
      fixtureExportRequest({ ownerUserId: '张三' }),
      fixtureExportRequest({ fields: [] }),
      fixtureExportRequest({ fields: ['createdAt', 'createdAt'] }),
    ];

    for (const record of broken) {
      const app = await startExportsApp({ seed: false });
      // 直接由仓储返回损坏记录（归属形态非法的一条不会被「按主体取数」命中，
      // 必须这样构造才能让出口的 fail-closed 门禁看见它）
      vi.spyOn(app.repository, 'listByOwnerId').mockResolvedValue([record]);

      const res = await call(app.baseUrl, 'GET', '/me/exports', {
        headers: bearer(SESSION_STUDENT_1),
      });

      expect(res.status).toBe(500);
      expect(res.body.data).toBeNull();
      expect(res.body.error?.code).toBe('INTERNAL_ERROR');
      const content = contentText(res);
      expect(content).not.toContain(record.id);
      expect(content).not.toContain('张三');
      expect(content).not.toContain('not-a-uuid');
      expect(content).not.toContain('2026/01/06');
    }
  });

  it('仓储返回非记录形态（对象/数组/标量）→ 500：响应不含返回值', async () => {
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const app = await startExportsApp();
    const list = vi.spyOn(app.repository, 'listByOwnerId');

    const shapes: ReadonlyArray<unknown[]> = [
      [{ name: '张三', phone: OTHER_PHONE, path: FORGED_PATH }],
      [[app.seeded.ownCompleted]],
      ['u-student-1'],
      [null],
    ];

    for (const shape of shapes) {
      list.mockReturnValue(shape as never);

      const res = await call(app.baseUrl, 'GET', '/me/exports', {
        headers: bearer(SESSION_STUDENT_1),
      });

      expect(res.status).toBe(500);
      expect(res.body.data).toBeNull();
      const content = contentText(res);
      for (const leaked of [
        '张三',
        OTHER_PHONE,
        FORGED_PATH,
        STUDENT_1,
        app.seeded.ownCompleted.id,
      ]) {
        expect(content).not.toContain(leaked);
      }
    }
  });

  it('产物存储的内部存储键与句柄只留在服务端：创建与列表响应都不含内部形态', async () => {
    const app = await startExportsApp();

    const create = await call(app.baseUrl, 'POST', '/me/exports', {
      headers: bearer(SESSION_STUDENT_1),
      body: { resource: ExportResource.Achievement },
    });
    const list = await call(app.baseUrl, 'GET', '/me/exports', {
      headers: bearer(SESSION_STUDENT_1),
    });

    expect(create.status).toBe(201);
    expect(list.status).toBe(200);

    const stored = await app.repository.listByOwnerId(STUDENT_1);
    const created = stored[stored.length - 1];
    const descriptor = app.artifacts.findArtifactDescriptor(created?.artifactId ?? '');
    expect(descriptor).toBeDefined();

    for (const res of [create, list]) {
      const content = contentText(res);
      expectNoStorageLeak(content);
      expect(content).not.toContain(descriptor?.storageKey ?? 'no-storage-key');
      expect(content).not.toContain(created?.artifactId ?? 'no-artifact');
      expect(content).not.toContain(IN_MEMORY_EXPORT_STORAGE_PREFIX);
    }
  });
});

describe('导出切片：存储异常（仓储端口抛错 → 500，不泄露内部细节）', () => {
  it('入口写回被替换（他人归属/别的资源/别的字段/别的主键）→ 500，且不生成任何产物', async () => {
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

    const replacements: ReadonlyArray<Partial<ExportRequest>> = [
      { ownerUserId: STUDENT_2 },
      {
        resource: ExportResource.Achievement,
        fields: [...EXPORTABLE_FIELDS[ExportResource.Achievement]],
      },
      { fields: ['title'] },
      { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' },
    ];

    for (const replacement of replacements) {
      const app = await startExportsApp({ seed: false });
      const store = vi.spyOn(app.artifacts, 'store');
      const save = vi.spyOn(app.repository, 'save');
      vi.spyOn(app.repository, 'create').mockImplementation(async (record) => ({
        ...record,
        ...replacement,
        fields: replacement.fields ? [...replacement.fields] : [...record.fields],
      }));

      const res = await call(app.baseUrl, 'POST', '/me/exports', {
        headers: bearer(SESSION_STUDENT_1),
        body: { resource: ExportResource.Profile },
      });

      expect(res.status).toBe(500);
      expect(res.body.data).toBeNull();
      expect(res.body.error?.code).toBe('INTERNAL_ERROR');
      expect(res.body.error?.message).toBe(INTERNAL_ERROR_MESSAGE);
      // 身份/范围被替换时不得为他人或别的导出范围产出服务端产物
      expect(store).not.toHaveBeenCalled();
      expect(save).not.toHaveBeenCalled();
      const content = contentText(res);
      for (const leaked of [STUDENT_2, STUDENT_1, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa']) {
        expect(content).not.toContain(leaked);
      }
    }
  });

  it('create 抛异常（含敏感原文）→ 500，响应不含错误名/堆栈/原文，且不生成产物', async () => {
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const app = await startExportsApp({ seed: false });
    const store = vi.spyOn(app.artifacts, 'store');
    vi.spyOn(app.repository, 'create').mockImplementation(() => {
      throw new Error(
        `connection refused: ownerUserId=${STUDENT_1} phone=${OTHER_PHONE} path=${FORGED_PATH}`,
      );
    });

    const res = await call(app.baseUrl, 'POST', '/me/exports', {
      headers: bearer(SESSION_STUDENT_1),
      body: { resource: ExportResource.Profile },
    });

    expect(res.status).toBe(500);
    expect(res.body.data).toBeNull();
    expect(res.body.error?.code).toBe('INTERNAL_ERROR');
    expect(res.body.error?.message).toBe(INTERNAL_ERROR_MESSAGE);

    const content = contentText(res);
    for (const leaked of [
      STUDENT_1,
      OTHER_PHONE,
      FORGED_PATH,
      'connection refused',
      'Error',
      'stack',
    ]) {
      expect(content).not.toContain(leaked);
    }
    // 落库失败时不产生产物（不留下没有任何记录指向的产物）
    expect(store).not.toHaveBeenCalled();
  });

  it('save 抛异常 → 500：不返回「看起来成功但没有记录」的响应', async () => {
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const app = await startExportsApp({ seed: false });
    vi.spyOn(app.repository, 'save').mockImplementation(() => {
      throw new Error(`write failed: ownerUserId=${STUDENT_1} storageKey=${FORGED_STORAGE_KEY}`);
    });

    const res = await call(app.baseUrl, 'POST', '/me/exports', {
      headers: bearer(SESSION_STUDENT_1),
      body: { resource: ExportResource.Profile },
    });

    expect(res.status).toBe(500);
    expect(res.body.data).toBeNull();
    expect(res.body.error?.code).toBe('INTERNAL_ERROR');
    const content = contentText(res);
    for (const leaked of ['write failed', STUDENT_1, FORGED_STORAGE_KEY, ExportStatus.Completed]) {
      expect(content).not.toContain(leaked);
    }
    // 入口记录仍是 pending（结论未落库），不得谎报为 completed
    expect((await app.repository.listByOwnerId(STUDENT_1)).map((record) => record.status)).toEqual([
      ExportStatus.Pending,
    ]);
  });

  it('listByOwnerId 抛异常 → 500，且不返回任何记录', async () => {
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const app = await startExportsApp();
    vi.spyOn(app.repository, 'listByOwnerId').mockImplementation(() => {
      throw new Error(`read failed: ownerUserId=${STUDENT_1} phone=${OTHER_PHONE}`);
    });

    const res = await call(app.baseUrl, 'GET', '/me/exports', {
      headers: bearer(SESSION_STUDENT_1),
    });

    expect(res.status).toBe(500);
    expect(res.body.data).toBeNull();
    expect(res.body.error?.code).toBe('INTERNAL_ERROR');
    const content = contentText(res);
    for (const leaked of [STUDENT_1, OTHER_PHONE, 'read failed', 'Error']) {
      expect(content).not.toContain(leaked);
    }
  });
});

describe('导出切片：装配边界与纯函数门禁', () => {
  it('ExportsModule 只注册本切片的路由/服务：仓储令牌走换绑工厂，产物令牌绑非生产内存基线', () => {
    const providers = (Reflect.getMetadata('providers', ExportsModule) ?? []) as unknown[];
    const controllers = (Reflect.getMetadata('controllers', ExportsModule) ?? []) as unknown[];
    const imports = (Reflect.getMetadata('imports', ExportsModule) ?? []) as unknown[];

    expect(controllers).toEqual([ExportsController]);
    expect(providers).toContain(ExportsService);
    expect(providers).toContain(InMemoryExportArtifactStore);
    // 仓储令牌由工厂换绑（按 DATABASE_URL 分流）：既不再 `useExisting` 内存实现，
    // 也不再把内存实现本身留在 provider 列表里（否则容器里会出现两份互不相干的状态）
    expect(providers).not.toContain(InMemoryExportRepository);
    const repositoryProvider = providers.find(
      (provider): provider is { provide: unknown; useFactory: unknown } =>
        typeof provider === 'object' &&
        provider !== null &&
        (provider as { provide?: unknown }).provide === EXPORT_REPOSITORY,
    );
    expect(typeof repositoryProvider?.useFactory).toBe('function');
    // 产物存储仍是显式 useExisting：真实产物存储（对象存储/临时文件区）不在本切片
    expect(providers).toContainEqual({
      provide: EXPORT_ARTIFACT_STORE,
      useExisting: InMemoryExportArtifactStore,
    });
    // 依赖方向：认证（auth）与授权（access-control）各自只经端口/服务暴露
    expect(imports).toContain(AuthModule);
    expect(imports).toContain(AccessControlModule);
  });

  it('未配置数据库时：仓储令牌解析到内存基线；产物令牌与其保持 useExisting 语义', async () => {
    const app = await startExportsApp({ seed: false });
    expect(app.app.get(EXPORT_REPOSITORY)).toBeInstanceOf(InMemoryExportRepository);
    expect(app.app.get(EXPORT_ARTIFACT_STORE)).toBe(app.app.get(InMemoryExportArtifactStore));
  });

  it('两个内存基线如实声明非持久化/不可用于生产，并在生产环境拒绝构造', async () => {
    const developmentEnv = loadEnv({});
    const productionEnv = loadEnv({ NODE_ENV: 'production' });

    const repository = new InMemoryExportRepository(developmentEnv);
    expect(repository.capabilities).toEqual({
      backend: 'in-memory-baseline',
      persistent: false,
      productionReady: false,
    });
    await expect(repository.listByOwnerId('u-nobody')).resolves.toEqual([]);
    expect(() => new InMemoryExportRepository(productionEnv)).toThrow(
      /生产环境禁止使用内存导出仓储/u,
    );

    const artifacts = new InMemoryExportArtifactStore(developmentEnv);
    expect(artifacts.capabilities).toEqual({
      backend: 'in-memory-baseline',
      persistent: false,
      productionReady: false,
    });
    expect(() => new InMemoryExportArtifactStore(productionEnv)).toThrow(
      /生产环境禁止使用内存导出产物存储/u,
    );
  });

  it('内存仓储：主键唯一、未知 ID 不可更新、归属与有效期不可改写、按主体取数、无删除入口、返回副本', async () => {
    const repository = new InMemoryExportRepository(loadEnv({}));
    const record = fixtureExportRequest();
    await repository.create(record);
    await repository.create(fixtureExportRequest({ ownerUserId: STUDENT_2 }));

    // 主键冲突属于服务端缺陷，不得静默覆盖既有导出请求
    await expect(repository.create(record)).rejects.toThrow(/导出请求 ID 冲突/u);

    // 覆盖写入未知 id 不得退化成插入
    await expect(repository.save(fixtureExportRequest({ id: randomUUID() }))).rejects.toThrow(
      /导出请求不存在，无法更新/u,
    );

    // 归属不得在更新中被改写
    await expect(
      repository.save(fixtureExportRequest({ id: record.id, ownerUserId: STUDENT_2 })),
    ).rejects.toThrow(/导出请求归属不一致/u);

    // **服务端有效期不得在写回中被改写**（续期 / 清空都被拒绝）：
    // 与数据库 adapter 的 `expires_at` 不可变列 + 写回逐列复核同语义，
    // 否则「把已过期的交付物续期回可下载状态」会成为一条静默可达的路径
    await expect(
      repository.save({ ...record, expiresAt: futureExpiry(7_200_000) }),
    ).rejects.toThrow(/有效期不可改写/u);

    // 本切片没有删除/归档能力
    for (const forbidden of ['update', 'delete', 'remove', 'archive', 'softDelete']) {
      expect(forbidden in repository).toBe(false);
    }

    // 只按服务端主体取数
    await expect(repository.listByOwnerId(STUDENT_1)).resolves.toHaveLength(1);
    await expect(repository.listByOwnerId(STUDENT_2)).resolves.toHaveLength(1);
    await expect(repository.listByOwnerId('u-nobody')).resolves.toEqual([]);

    // 返回副本：调用方无法就地改写已存储的记录与字段数组
    const returned = (await repository.listByOwnerId(STUDENT_1))[0];
    expect(returned).toBeDefined();
    (returned as { status: ExportStatus }).status = ExportStatus.Failed;
    (returned?.fields as unknown as string[]).push('title');
    const again = (await repository.listByOwnerId(STUDENT_1))[0];
    expect(again?.status).toBe(ExportStatus.Completed);
    expect(again?.fields).toEqual(profileFields());
  });

  it('内存产物存储：只回不透明句柄、内部存储键不外发、描述不可变', () => {
    const artifacts = new InMemoryExportArtifactStore(loadEnv({}));
    const ref = artifacts.store({
      exportRequestId: '11111111-1111-4111-8111-111111111111',
      ownerUserId: STUDENT_1,
      resource: ExportResource.Profile,
      fields: profileFields(),
    });

    // 返回值只有不透明句柄：不含路径、URL、存储键或文件名
    expect(Object.keys(ref)).toEqual(['artifactId']);
    expect(ref.artifactId).toMatch(UUID_PATTERN);
    expect(JSON.stringify(ref)).not.toContain(IN_MEMORY_EXPORT_STORAGE_PREFIX);
    expect(JSON.stringify(ref)).not.toContain('.csv');

    const descriptor = artifacts.findArtifactDescriptor(ref.artifactId);
    expect(descriptor?.storageKey).toBe(
      `${IN_MEMORY_EXPORT_STORAGE_PREFIX}${STUDENT_1}/${ref.artifactId}.csv`,
    );
    expect(descriptor?.fields).toEqual(profileFields());
    expect(artifacts.findArtifactDescriptor('not-a-uuid')).toBeUndefined();

    // 返回副本：调用方无法就地改写已存储的产物描述
    (descriptor?.fields as unknown as string[]).push('title');
    expect(artifacts.findArtifactDescriptor(ref.artifactId)?.fields).toEqual(profileFields());
  });

  it('输出白名单是真正的闭集：多出字段、非法枚举与缺字段即违规（门禁非恒真）', () => {
    const valid: ExportRequestView = {
      id: '11111111-1111-4111-8111-111111111111',
      resource: ExportResource.Profile,
      fields: ['grade', 'major'],
      status: ExportStatus.Completed,
      createdAt: '2026-01-06T00:00:00.000Z',
      updatedAt: '2026-01-06T00:00:05.000Z',
    };
    expect(parseExportRequestView(valid)).toEqual({ ok: true, value: valid });

    const withArtifact = parseExportRequestView({ ...valid, artifactId: FORGED_ARTIFACT_ID });
    expect(withArtifact.ok).toBe(false);
    if (!withArtifact.ok) {
      expect(withArtifact.issues).toEqual([{ kind: 'unexpected', path: 'artifactId' }]);
    }

    const withLocation = parseExportRequestView({
      ...valid,
      fileUrl: FORGED_FILE_URL,
      path: FORGED_PATH,
      storageKey: FORGED_STORAGE_KEY,
    });
    expect(withLocation.ok).toBe(false);
    if (!withLocation.ok) {
      expect(withLocation.issues.map((issue) => issue.path)).toEqual([
        'fileUrl',
        'path',
        'storageKey',
      ]);
    }

    const withInvalidStatus = parseExportRequestView({ ...valid, status: 'unknown' });
    expect(withInvalidStatus.ok).toBe(false);
    if (!withInvalidStatus.ok) {
      expect(withInvalidStatus.issues).toEqual([{ kind: 'invalid', path: 'status' }]);
    }

    const withUnknownField = parseExportRequestView({ ...valid, fields: ['phone'] });
    expect(withUnknownField.ok).toBe(false);
    if (!withUnknownField.ok) {
      expect(withUnknownField.issues).toEqual([{ kind: 'invalid', path: 'fields.0' }]);
    }

    const { updatedAt: _updatedAt, ...missing } = valid;
    const withoutRequired = parseExportRequestView(missing);
    expect(withoutRequired.ok).toBe(false);
    if (!withoutRequired.ok) {
      expect(withoutRequired.issues).toEqual([{ kind: 'invalid', path: 'updatedAt' }]);
    }

    // 白名单字段集合固定，且出口投影只产出白名单字段
    expect(EXPORT_REQUEST_VIEW_FIELDS).toEqual([
      'id',
      'resource',
      'fields',
      'status',
      'createdAt',
      'updatedAt',
    ]);
    const stored = parseStoredExportRequestOrThrow(fixtureExportRequest());
    expect(Object.keys(toExportRequestView(stored)).sort()).toEqual(
      [...EXPORT_REQUEST_VIEW_FIELDS].sort(),
    );
  });

  it('存储读取契约：枚举闭集、字段白名单子集与去重、状态与产物自洽、ISO 时间、字段闭集', () => {
    const valid = fixtureExportRequest();
    expect(parseStoredExportRequest(valid).ok).toBe(true);

    const cases: ReadonlyArray<{ readonly record: unknown; readonly path: string }> = [
      { record: { ...valid, resource: 'users' }, path: 'resource' },
      { record: { ...valid, status: 'unknown' }, path: 'status' },
      { record: { ...valid, fields: [] }, path: 'fields' },
      { record: { ...valid, fields: [PII_ID_CARD] }, path: 'fields' },
      { record: { ...valid, fields: [FORGED_PATH] }, path: 'fields' },
      { record: { ...valid, fields: ['createdAt', 'createdAt'] }, path: 'fields' },
      { record: { ...valid, status: 'pending' }, path: 'artifactId' },
      { record: { ...valid, artifactId: undefined, status: 'completed' }, path: 'artifactId' },
      { record: { ...valid, artifactId: 'not-a-uuid' }, path: 'artifactId' },
      { record: { ...valid, createdAt: '2026/01/06' }, path: 'createdAt' },
      { record: { ...valid, updatedAt: 'not-a-time' }, path: 'updatedAt' },
      { record: { ...valid, id: 'not-a-uuid' }, path: 'id' },
      { record: { ...valid, ownerUserId: '张三' }, path: 'ownerUserId' },
      { record: { ...valid, ownerUserId: '' }, path: 'ownerUserId' },
      { record: { ...valid, fileUrl: FORGED_FILE_URL }, path: 'fileUrl' },
      { record: { ...valid, path: FORGED_PATH }, path: 'path' },
      { record: { ...valid, storageKey: FORGED_STORAGE_KEY }, path: 'storageKey' },
      { record: { ...valid, fileName: FORGED_FILE_NAME }, path: 'fileName' },
      // 服务端有效期：非法形态属于存储被写坏 ⇒ 读取契约违规（fail-closed 500）；
      // 注意**缺省不是违规**（见下面的显式断言）：缺省是「没有服务端有效期」的合法存储形态，
      // 由下载边界统一 404，而不是把记录判成损坏（那会泄露「记录存在但缺字段」）
      { record: { ...valid, expiresAt: '2026/01/07' }, path: 'expiresAt' },
      { record: { ...valid, expiresAt: 'not-a-time' }, path: 'expiresAt' },
      { record: { ...valid, expiresAt: '2026-01-07' }, path: 'expiresAt' },
      { record: { ...valid, expiresAt: '2026-01-07T00:00:00.000+08:00' }, path: 'expiresAt' },
      { record: { ...valid, expiresAt: 1767744000000 }, path: 'expiresAt' },
      { record: { ...valid, expiresAt: null }, path: 'expiresAt' },
      { record: { ...valid, expiresAt: '' }, path: 'expiresAt' },
    ];

    for (const { record, path } of cases) {
      const parsed = parseStoredExportRequest(record);
      expect(parsed.ok, path).toBe(false);
      if (!parsed.ok) {
        expect(parsed.issues.map((issue) => issue.path)).toContain(path);
        // 违规详情只给路径与类型，不给取值
        const issues = JSON.stringify(parsed.issues);
        expect(issues).not.toContain(PII_ID_CARD);
        expect(issues).not.toContain(FORGED_PATH);
        expect(issues).not.toContain(FORGED_STORAGE_KEY);
        expect(issues).not.toContain('张三');
      }
    }

    // 闭集内的每个资源与状态都能构成合法记录（证明门禁不是恒假）
    for (const resource of EXPORT_RESOURCE_VALUES) {
      expect(
        parseStoredExportRequest(
          fixtureExportRequest({ resource, fields: [...EXPORTABLE_FIELDS[resource]] }),
        ).ok,
      ).toBe(true);
    }
    for (const status of EXPORT_STATUS_VALUES) {
      expect(
        parseStoredExportRequest(
          fixtureExportRequest({
            status,
            artifactId: status === ExportStatus.Completed ? FORGED_ARTIFACT_ID : undefined,
          }),
        ).ok,
      ).toBe(true);
    }

    // 有效期是**可选**字段：缺省（存储 NULL / 本迁移之前的历史行）仍然是合法记录，
    // 由下载边界 fail-closed；把它判成违规会让拒绝从稳定的 404 变成 500。
    const { expiresAt: _expiresAt, ...withoutExpiry } = fixtureExportRequest();
    expect(parseStoredExportRequest(withoutExpiry).ok).toBe(true);
    // 合法未来时刻同样是合法记录
    expect(
      parseStoredExportRequest(fixtureExportRequest({ expiresAt: FORGED_EXPIRES_AT })).ok,
    ).toBe(true);
  });

  it('请求体/查询串闭集门禁：无输入不报错，服务端字段与未声明字段给出可区分的拒绝原因', () => {
    expect(EXPORT_QUERY_FIELDS).toEqual([]);
    expect(EXPORT_REQUEST_INPUT_FIELDS).toEqual(['resource', 'fields']);

    expect(() => assertDeclaredExportRequestFields({ resource: 'profile' })).not.toThrow();
    expect(() => assertDeclaredExportRequestFields(undefined)).not.toThrow();
    expect(() => assertDeclaredExportRequestFields(null)).not.toThrow();
    expect(() => assertDeclaredExportRequestFields([])).not.toThrow();
    expect(() => assertDeclaredExportRequestFields('resource=profile')).not.toThrow();
    expect(() => assertDeclaredExportQueryFields({})).not.toThrow();
    expect(() => assertDeclaredExportQueryFields(undefined)).not.toThrow();
    expect(() => assertDeclaredExportQueryFields(null)).not.toThrow();

    const serverOwned = captureZodError(() =>
      assertDeclaredExportRequestFields({ resource: 'profile', status: 'completed' }),
    );
    expect(serverOwned?.issues[0]?.message).toBe('禁止设置服务端字段 status');
    expect(serverOwned?.issues[0]?.path).toEqual(['status']);

    const filePath = captureZodError(() =>
      assertDeclaredExportRequestFields({ resource: 'profile', path: FORGED_PATH }),
    );
    expect(filePath?.issues[0]?.message).toBe('禁止设置服务端字段 path');
    // 键名是服务端字段名，取值（路径）不回显
    expect(JSON.stringify(filePath?.issues)).not.toContain(FORGED_PATH);

    const undeclared = captureZodError(() =>
      assertDeclaredExportRequestFields({ resource: 'profile', note: '被改写' }),
    );
    expect(undeclared?.issues[0]?.message).toBe('请求体包含未声明字段 note');

    const queryStatus = captureZodError(() =>
      assertDeclaredExportQueryFields({ status: 'completed' }),
    );
    expect(queryStatus?.issues[0]?.message).toContain('禁止使用查询参数 status');
    const queryPath = captureZodError(() => assertDeclaredExportQueryFields({ path: FORGED_PATH }));
    expect(queryPath?.issues[0]?.message).toContain('禁止使用查询参数 path');
    expect(JSON.stringify(queryPath?.issues)).not.toContain(FORGED_PATH);
    const queryPage = captureZodError(() => assertDeclaredExportQueryFields({ page: '1' }));
    expect(queryPage?.issues[0]?.message).toBe('本端点不接受查询参数 page');

    // 输入 schema 的字段闭集与声明清单一致（不另起第二套字段）
    expect(Object.keys(exportRequestInputSchema.shape).sort()).toEqual(
      [...EXPORT_REQUEST_INPUT_FIELDS].sort(),
    );
  });

  it('资源与字段白名单闭集、权限点映射与共享目录的 parity（不新增权限点）', () => {
    expect(EXPORT_RESOURCE_VALUES).toEqual(['profile', 'achievement', 'education', 'statistics']);
    expect(new Set(EXPORT_RESOURCE_VALUES).size).toBe(EXPORT_RESOURCE_VALUES.length);

    // 字段并集与逐资源白名单一致（跨资源的同名字段只算一次）
    const union = EXPORT_RESOURCE_VALUES.flatMap((resource) => [...EXPORTABLE_FIELDS[resource]]);
    expect([...new Set(union)].sort()).toEqual([...EXPORTABLE_FIELD_NAME_VALUES].sort());
    expect(EXPORT_MAX_FIELD_COUNT).toBe(
      Math.max(...EXPORT_RESOURCE_VALUES.map((resource) => EXPORTABLE_FIELDS[resource].length)),
    );

    // 高敏与内部字段不在任何资源的白名单里
    for (const forbidden of [
      'name',
      'studentNo',
      'phone',
      'privacyConsent',
      'evidenceFileId',
      'userId',
      'ownerUserId',
      'artifactId',
      'fileUrl',
      'path',
      'downloadUrl',
      'signedUrl',
      'storageKey',
      'storageHandle',
    ]) {
      expect(EXPORTABLE_FIELD_NAME_VALUES).not.toContain(forbidden);
    }

    // 资源 → 权限点映射完整，且只用闭集目录里已有的 self 权限点（不新增权限点）
    for (const resource of EXPORT_RESOURCE_VALUES) {
      const permissions = EXPORT_RESOURCE_READ_PERMISSIONS[resource];
      expect(permissions.length).toBeGreaterThan(0);
      for (const permission of permissions) {
        expect(PERMISSION_POINT_VALUES).toContain(permission);
        // 学生默认持有这些本人权限点：证明闭集目录内的本人导出仍可被授权
        expect(DEFAULT_ROLE_PERMISSIONS[Role.Student]).toContain(permission);
      }
    }
    expect(PERMISSION_POINT_VALUES).toContain(EXPORT_ENTRY_PERMISSION);
    expect(DEFAULT_ROLE_PERMISSIONS[Role.Student]).toContain(EXPORT_ENTRY_PERMISSION);
    // `statistics` 与统计切片同口径：四类本人读取点全部通过
    expect(EXPORT_RESOURCE_READ_PERMISSIONS[ExportResource.Statistics]).toEqual([
      PermissionPoint.EducationSelfRead,
      PermissionPoint.MembershipSelfCreate,
      PermissionPoint.AchievementSelfRead,
      PermissionPoint.MatchingSelfRequest,
    ]);

    // 字段归一化：缺省 = 白名单全集；显式声明去重；白名单之外抛错且不回显取值
    expect(resolveExportFields(ExportResource.Profile, undefined)).toEqual(profileFields());
    expect(resolveExportFields(ExportResource.Profile, ['grade', 'grade', 'major'])).toEqual([
      'grade',
      'major',
    ]);
    const unknownField = (() => {
      try {
        resolveExportFields(ExportResource.Profile, ['grade', PII_ID_CARD]);
        return undefined;
      } catch (error) {
        return error instanceof ZodError ? error : undefined;
      }
    })();
    expect(unknownField?.issues[0]?.path).toEqual(['fields', 1]);
    expect(unknownField?.issues[0]?.message).toContain('不在资源 profile 的服务端白名单内');
    expect(JSON.stringify(unknownField?.issues)).not.toContain(PII_ID_CARD);

    // 产物句柄读取：只有单一 UUID 的闭集对象合法
    expect(readArtifactId({ artifactId: FORGED_ARTIFACT_ID })).toBe(FORGED_ARTIFACT_ID);
    for (const bad of [
      {},
      { artifactId: 'not-a-uuid' },
      { artifactId: FORGED_ARTIFACT_ID, storageKey: FORGED_STORAGE_KEY },
      [FORGED_ARTIFACT_ID],
      null,
      undefined,
      'artifactId',
    ]) {
      expect(readArtifactId(bad)).toBeUndefined();
    }
  });

  it('完整 AppModule：health / runtime-info 与既有路由行为不变，导出路由默认 401', async () => {
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
      '/groups',
    ]) {
      const res = await call(baseUrl, 'GET', path);
      expect(res.status).toBe(401);
      expect(res.body.error?.code).toBe('UNAUTHENTICATED');
    }

    const create = await call(baseUrl, 'POST', '/me/exports', {
      body: { resource: ExportResource.Profile },
    });
    expect(create.status).toBe(401);
    expect(create.body.error?.code).toBe('UNAUTHENTICATED');
  });
});

/** 读取契约（测试辅助）：把夹具记录断言为合法存储记录，失败即抛，避免静默通过 */
function parseStoredExportRequestOrThrow(record: unknown): StoredExportRequest {
  const parsed = parseStoredExportRequest(record);
  if (!parsed.ok) {
    throw new Error(`夹具记录不符合导出读取契约: ${JSON.stringify(parsed.issues)}`);
  }
  return parsed.value;
}

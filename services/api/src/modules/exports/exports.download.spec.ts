import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { request } from 'node:http';
import { resolve } from 'node:path';
import { Module } from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import { APP_FILTER, APP_INTERCEPTOR, NestFactory } from '@nestjs/core';
import { DataScope, Role } from '@rm/shared';
import type { ApiEnvelope } from '@rm/shared';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import type { MockInstance } from 'vitest';
import { ApiExceptionFilter } from '../../common/api-exception.filter';
import { ApiResponseInterceptor } from '../../common/api-response.interceptor';
import { ConfigModule } from '../../config/config.module';
import { loadEnv } from '../../config/env';
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
  EXPORT_DOWNLOAD_AUDIT_DIGEST_PATTERN,
  EXPORT_DOWNLOAD_AUDIT_FIELDS,
  EXPORT_DOWNLOAD_CACHE_CONTROL,
  EXPORT_DOWNLOAD_CONTENT_TYPE,
  EXPORT_DOWNLOAD_FILENAME_PREFIX,
  EXPORT_DOWNLOAD_MAX_BYTES,
  EXPORT_DOWNLOAD_NOSNIFF,
  EXPORT_DOWNLOAD_QUERY_FIELDS,
  EXPORT_DOWNLOAD_RESPONSE_HEADER_NAMES,
  EXPORT_DOWNLOAD_TTL_MS,
  EXPORT_DOWNLOAD_UNAVAILABLE_MESSAGE,
  EXPORT_QUERY_FIELDS,
  FORBIDDEN_EXPORT_DOWNLOAD_AUDIT_FIELDS,
  assertSafeExportDownloadFilename,
  assertSafeExportDownloadHeaderValue,
  buildExportDownloadDisposition,
  buildExportDownloadFilename,
  digestExportId,
  exportDownloadAuditEntrySchema,
  exportExpiresAtFrom,
  isExportDownloadExpired,
  parseExportDownloadAuditEntry,
} from './exports.contract';
import { InMemoryExportDownloadAuditSink } from './exports.download-audit.in-memory';
import { InMemoryExportRepository } from './exports.in-memory-repository';
import { ExportsModule } from './exports.module';
import {
  EXPORT_DOWNLOAD_AUDIT,
  EXPORT_REPOSITORY,
  ExportDownloadAuditResult,
  ExportResource,
  ExportStatus,
} from './exports.port';
import type { ExportRequest } from './exports.port';
import { EXPORT_ENTRY_PERMISSION, EXPORT_RESOURCE_READ_PERMISSIONS } from './exports.service';

/**
 * 导出下载切片（`GET /me/exports/:exportId/download`）的**真实 HTTP 回归 + 契约单测**。
 *
 * 覆盖用户要求的全部安全口径：
 * - 本人 `completed` **成功**：200、原始字节（不是 JSON 信封）、固定 `Content-Type` /
 *   `Content-Disposition` 文件名 / `Content-Length` / `no-store` / `nosniff`，且响应里没有
 *   存储 key、路径、产物句柄、归属；
 * - **统一安全拒绝（404 + 同一文案）**：不存在 / 跨主体 / `pending` / `failed` / 产物缺失 /
 *   空产物 / **已过期** / **无服务端有效期**，八种情形的状态码、错误码与文案完全一致
 *   （逐字节比较），不泄露存在性、状态与「是否已过期」；
 * - **服务端有效期**：TTL 是服务端常量（24 小时）、由 epoch 毫秒派生为 UTC 绝对时刻；
 *   有效当且仅当当前时刻**严格早于**有效期（边界时刻即判过期）；缺省 / 非法形态一律 fail-closed；
 *   有效期**不在任何响应里回显**（既不进响应体，也不生成 `Expires` 类报头）；
 * - **fail-closed（500）**：产物读取故障、内容超限、内容形态非法、存储记录违约、仓储取数故障、
 *   审计留痕失败；对外只有统一内部错误，不带原始错误文本；
 * - 伪造输入：查询参数（`userId` / `ownerUserId` / `artifactId` / `fileUrl` / `path` / `status` /
 *   `fileName`）一律 400 且不回显取值；自定义头（`x-user-id` / `x-roles` / `x-artifact-id` /
 *   `x-file-url` / `x-path` / `x-request-id`）不进入归属、判定、响应头与留痕；
 * - 认证 / 授权：无凭证 401、越权 403，且**拒绝路径上一次端口调用都没有**（仓储、产物存储、
 *   审计出口都未被触达）；资源级判定使用**记录里的服务端资源**映射的权限点；
 * - 产物存储最小读能力：只有内容字节（类型层面没有 key / 路径 / URL），返回副本，
 *   未知句柄 `undefined`，生产环境拒绝构造；
 * - 留痕脱敏：恰好 `requestId` / `exportIdDigest` / `result` 三个字段，摘要为 sha256 前 32 位、
 *   不含原始导出 ID，留痕里没有产物位置、内容、归属或请求侧输入；
 * - 仓储单条取数（内存基线）：归属是取数条件本身，他人 / 不存在的 ID 都返回 `undefined`，
 *   且端口面不存在不带归属条件的读取入口。
 *
 * 测试用真实 Nest 应用 + 真实 HTTP（与其它切片的 controller spec 同构），只通过 DI 令牌注入
 * 测试夹具（会话 / 产物），不替换任何生产代码路径。
 */

const SESSION_STUDENT_1 = 'session-student-1';
const SESSION_STUDENT_2 = 'session-student-2';
const SESSION_LEADER_1 = 'session-leader-1';

const STUDENT_1 = 'u-student-1';
const STUDENT_2 = 'u-student-2';
const LEADER_1 = 'u-leader-1';

/** 夹具记录 ID（固定，便于断言顺序与「他人 ID 不可用」） */
const OWN_COMPLETED_ID = '11111111-1111-4111-8111-111111111111';
const OWN_PENDING_ID = '22222222-2222-4222-8222-222222222222';
const OWN_FAILED_ID = '33333333-3333-4333-8333-333333333333';
const OWN_NO_ARTIFACT_ID = '44444444-4444-4444-8444-444444444444';
const OTHER_COMPLETED_ID = '55555555-5555-4555-8555-555555555555';
const OWN_ACHIEVEMENT_ID = '66666666-6666-4666-8666-666666666666';
/** 已过期的 completed（产物真实存在、状态合法，但有效期已过） */
const OWN_EXPIRED_ID = '88888888-8888-4888-8888-888888888888';
/** 没有服务端有效期（存储 NULL / 历史行）的 completed */
const OWN_NO_EXPIRY_ID = '99999999-9999-4999-8999-999999999998';
/** 完全不存在于任何主体的导出 ID */
const UNKNOWN_ID = '77777777-7777-4777-8777-777777777777';

/** 客户端伪造值：必须被拒绝、被忽略，且绝不出现在响应或留痕里 */
const FORGED_ARTIFACT_ID = '99999999-9999-4999-8999-999999999999';
const FORGED_PATH = '/var/exports/u-student-2/secret-export.csv';
const FORGED_FILE_URL = 'https://files.example.com/exports/secret-export.csv';
const FORGED_STORAGE_KEY = 's3://internal-bucket/exports/secret-export.csv';
const FORGED_REQUEST_ID = 'client-trace-00000001';
const PII_ID_CARD = '110101199003071234';
/** 客户端伪造的有效期（过去 / 未来两种形态都不得影响判定） */
const FORGED_EXPIRES_FUTURE = '2099-12-31T23:59:59.000Z';
const FORGED_EXPIRES_PAST = '2000-01-01T00:00:00.000Z';

/**
 * 未来有效期：默认夹具（仍然可下载）。
 *
 * 刻意用**相对当前时刻**的取值而不是硬编码日期：有效期是「相对于服务端当前时钟」的性质，
 * 硬编码的「未来日期」会在某天变成过去，从而让成功用例悄悄变成过期用例（测试自身过期）。
 */
function futureExpiry(offsetMs = 3_600_000): string {
  return new Date(Date.now() + offsetMs).toISOString();
}

/** 已过期（严格早于当前时刻）的有效期 */
function pastExpiry(offsetMs = 60_000): string {
  return new Date(Date.now() - offsetMs).toISOString();
}

/** 去掉服务端有效期：模拟存储 `NULL` / 本迁移之前写入的历史行 */
function withoutExpiry(record: ExportRequest): ExportRequest {
  const copy: { expiresAt?: string } = { ...record };
  delete copy.expiresAt;
  return copy as ExportRequest;
}

/** 禁止出现在任何下载响应里的「产物位置 / 内部存储」形态 */
const STORAGE_LEAK_MARKERS: readonly string[] = [
  FORGED_ARTIFACT_ID,
  FORGED_PATH,
  FORGED_FILE_URL,
  FORGED_STORAGE_KEY,
  PII_ID_CARD,
  IN_MEMORY_EXPORT_STORAGE_PREFIX,
  '"artifactId"',
  '"storageKey"',
  '"fileUrl"',
  '"bytes"',
];

@Module({
  imports: [ConfigModule, ExportsModule],
  providers: [
    { provide: APP_INTERCEPTOR, useClass: ApiResponseInterceptor },
    { provide: APP_FILTER, useClass: ApiExceptionFilter },
  ],
})
class ExportsDownloadHttpModule {}

interface SeededExports {
  readonly ownCompleted: ExportRequest;
  readonly ownPending: ExportRequest;
  readonly ownFailed: ExportRequest;
  readonly ownCompletedWithoutArtifact: ExportRequest;
  readonly otherCompleted: ExportRequest;
  readonly ownCompletedAchievement: ExportRequest;
  /** 已完成、产物真实存在，但服务端有效期已过 */
  readonly ownExpired: ExportRequest;
  /** 已完成、产物真实存在，但存储里没有服务端有效期（NULL） */
  readonly ownWithoutExpiry: ExportRequest;
}

interface TestApp {
  readonly app: INestApplication;
  readonly baseUrl: string;
  readonly sessions: InMemorySessionStore;
  readonly repository: InMemoryExportRepository;
  readonly artifacts: InMemoryExportArtifactStore;
  readonly audit: InMemoryExportDownloadAuditSink;
  readonly seeded: SeededExports;
}

const startedApps: INestApplication[] = [];

function profileFields(): string[] {
  return [...EXPORTABLE_FIELDS[ExportResource.Profile]];
}

function achievementFields(): string[] {
  return [...EXPORTABLE_FIELDS[ExportResource.Achievement]];
}

/** 夹具记录：主体、状态、字段与句柄由调用方指定 */
function fixtureExportRequest(overrides: Partial<ExportRequest> = {}): ExportRequest {
  const base: ExportRequest = {
    id: randomUUID(),
    ownerUserId: STUDENT_1,
    resource: ExportResource.Profile,
    fields: profileFields(),
    status: ExportStatus.Completed,
    artifactId: randomUUID(),
    // 默认**有效**（未来 1 小时）：成功路径的夹具必须真的在有效期内，
    // 否则「过期拒绝」会把所有成功用例一起拒掉，测不出任何区分度
    expiresAt: futureExpiry(),
    createdAt: '2026-01-06T00:00:00.000Z',
    updatedAt: '2026-01-06T00:00:05.000Z',
  };
  return { ...base, ...overrides };
}

/**
 * 种子数据：产物的 `artifactId` 由**真实产物存储**生成（因此成功路径读的是真实内容），
 * 待 / 失败 / 缺产物 / **已过期** / **无有效期** 各类记录则刻意覆盖各自的分支。
 * 已过期与无有效期两条记录都带**真实存在的产物**，因此它们的拒绝只可能来自有效期判定，
 * 而不是「产物读不到」。
 */
async function seedExports(
  repository: InMemoryExportRepository,
  artifacts: InMemoryExportArtifactStore,
  seed: boolean,
): Promise<SeededExports> {
  const ownArtifact = artifacts.store({
    exportRequestId: OWN_COMPLETED_ID,
    ownerUserId: STUDENT_1,
    resource: ExportResource.Profile,
    fields: profileFields(),
  });
  const achievementArtifact = artifacts.store({
    exportRequestId: OWN_ACHIEVEMENT_ID,
    ownerUserId: STUDENT_1,
    resource: ExportResource.Achievement,
    fields: achievementFields(),
  });
  const otherArtifact = artifacts.store({
    exportRequestId: OTHER_COMPLETED_ID,
    ownerUserId: STUDENT_2,
    resource: ExportResource.Profile,
    fields: profileFields(),
  });
  const expiredArtifact = artifacts.store({
    exportRequestId: OWN_EXPIRED_ID,
    ownerUserId: STUDENT_1,
    resource: ExportResource.Profile,
    fields: profileFields(),
  });
  const noExpiryArtifact = artifacts.store({
    exportRequestId: OWN_NO_EXPIRY_ID,
    ownerUserId: STUDENT_1,
    resource: ExportResource.Profile,
    fields: profileFields(),
  });

  const seeded: SeededExports = {
    ownCompleted: fixtureExportRequest({
      id: OWN_COMPLETED_ID,
      artifactId: ownArtifact.artifactId,
      createdAt: '2026-01-06T00:00:00.000Z',
      updatedAt: '2026-01-06T00:00:01.000Z',
    }),
    ownPending: fixtureExportRequest({
      id: OWN_PENDING_ID,
      status: ExportStatus.Pending,
      artifactId: undefined,
    }),
    ownFailed: fixtureExportRequest({
      id: OWN_FAILED_ID,
      status: ExportStatus.Failed,
      artifactId: undefined,
    }),
    // completed 却指向一个**服务端并不存在**的产物句柄：产物缺失分支
    ownCompletedWithoutArtifact: fixtureExportRequest({
      id: OWN_NO_ARTIFACT_ID,
      artifactId: randomUUID(),
    }),
    otherCompleted: fixtureExportRequest({
      id: OTHER_COMPLETED_ID,
      ownerUserId: STUDENT_2,
      artifactId: otherArtifact.artifactId,
    }),
    ownCompletedAchievement: fixtureExportRequest({
      id: OWN_ACHIEVEMENT_ID,
      resource: ExportResource.Achievement,
      fields: achievementFields(),
      artifactId: achievementArtifact.artifactId,
    }),
    // 已过期：状态与产物都合法，只有服务端有效期落在过去
    ownExpired: fixtureExportRequest({
      id: OWN_EXPIRED_ID,
      artifactId: expiredArtifact.artifactId,
      expiresAt: pastExpiry(),
    }),
    // 无服务端有效期：字段缺省（存储 `NULL` 的领域形）⇒ fail-closed
    ownWithoutExpiry: withoutExpiry(
      fixtureExportRequest({ id: OWN_NO_EXPIRY_ID, artifactId: noExpiryArtifact.artifactId }),
    ),
  };

  if (seed) {
    for (const record of Object.values(seeded)) {
      await repository.create(record);
    }
  }
  return seeded;
}

async function startDownloadApp(options: { readonly seed?: boolean } = {}): Promise<TestApp> {
  const app = await NestFactory.create(ExportsDownloadHttpModule, { logger: false });
  app.setGlobalPrefix('api/v1');
  await app.listen(0, '127.0.0.1');
  startedApps.push(app);

  const sessions = app.get<InMemorySessionStore>(SESSION_STORE);
  sessions.seed({
    sessionId: SESSION_STUDENT_1,
    subject: { userId: STUDENT_1, roles: [Role.Student] },
  });
  sessions.seed({
    sessionId: SESSION_STUDENT_2,
    subject: { userId: STUDENT_2, roles: [Role.Student] },
  });
  // 负责人：持有 profile:self:read，但默认范围是 GROUP（不是 SELF）
  sessions.seed({
    sessionId: SESSION_LEADER_1,
    subject: { userId: LEADER_1, roles: [Role.GroupLeader], groupIds: ['g-1'] },
  });

  const repository = app.get<InMemoryExportRepository>(EXPORT_REPOSITORY);
  const artifacts = app.get(InMemoryExportArtifactStore);
  const audit = app.get(InMemoryExportDownloadAuditSink);
  const seeded = await seedExports(repository, artifacts, options.seed !== false);

  return {
    app,
    baseUrl: `${await app.getUrl()}/api/v1`,
    sessions,
    repository,
    artifacts,
    audit,
    seeded,
  };
}

interface RawResult {
  readonly status: number;
  readonly headers: Record<string, string | string[] | undefined>;
  readonly body: Buffer;
  readonly text: string;
}

/** 原始 HTTP 调用：保留下载响应的**字节**（JSON 解析会破坏二进制断言） */
function rawCall(
  baseUrl: string,
  method: 'GET' | 'POST',
  path: string,
  options: { readonly headers?: Record<string, string>; readonly body?: unknown } = {},
): Promise<RawResult> {
  return new Promise<RawResult>((resolve, reject) => {
    const payload = options.body === undefined ? undefined : JSON.stringify(options.body);
    const headers: Record<string, string> = { ...options.headers };
    if (payload !== undefined) {
      headers['content-type'] = 'application/json';
      headers['content-length'] = String(Buffer.byteLength(payload));
    }
    const req = request(`${baseUrl}${path}`, { method, agent: false, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => {
        const body = Buffer.concat(chunks);
        resolve({
          status: res.statusCode ?? 0,
          headers: res.headers,
          body,
          text: body.toString('utf8'),
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

function envelopeOf(res: RawResult): ApiEnvelope<unknown> {
  return JSON.parse(res.text) as ApiEnvelope<unknown>;
}

/** 响应里「业务内容」部分的文本：去掉随机 `meta`，用于逐字节比较与泄漏断言 */
function contentOf(res: RawResult): string {
  const body = envelopeOf(res);
  const error = body.error;
  return JSON.stringify({
    data: body.data,
    error: error
      ? { code: error.code, message: error.message, details: error.details ?? null }
      : null,
  });
}

function downloadPath(exportId: string, query = ''): string {
  return `/me/exports/${exportId}/download${query}`;
}

/** 统一安全拒绝的完整断言：状态码 / 错误码 / 文案 / 不发出下载头 */
function expectUniformRejection(res: RawResult): string {
  expect(res.status).toBe(404);
  const body = envelopeOf(res);
  expect(body.error?.code).toBe('NOT_FOUND');
  expect(body.error?.message).toBe(EXPORT_DOWNLOAD_UNAVAILABLE_MESSAGE);
  expect(res.headers['content-disposition']).toBeUndefined();
  expect(res.headers['content-type']).toContain('application/json');
  const content = contentOf(res);
  for (const marker of STORAGE_LEAK_MARKERS) {
    expect(content).not.toContain(marker);
  }
  return content;
}

/** fail-closed 的完整断言：500 / 统一内部错误 / 不发出下载头 / 不泄露内部细节 */
function expectFailClosed(res: RawResult, forbidden: readonly string[] = []): string {
  expect(res.status).toBe(500);
  const body = envelopeOf(res);
  expect(body.error?.code).toBe('INTERNAL_ERROR');
  expect(res.headers['content-disposition']).toBeUndefined();
  const content = contentOf(res);
  for (const marker of [...STORAGE_LEAK_MARKERS, ...forbidden]) {
    expect(content).not.toContain(marker);
  }
  for (const leak of ['Error', 'EXECUTOR_FAILURE', 'INVALID_ROW', 'stack', 'at ']) {
    expect(content).not.toContain(leak);
  }
  return content;
}

interface DownloadPortSpies {
  readonly findById: MockInstance;
  readonly read: MockInstance;
  readonly audit: MockInstance;
}

function spyOnDownloadPorts(app: TestApp): DownloadPortSpies {
  return {
    findById: vi.spyOn(app.repository, 'findByIdForOwner'),
    read: vi.spyOn(app.artifacts, 'read'),
    audit: vi.spyOn(app.audit, 'record'),
  };
}

/** 认证 / 授权拒绝路径的硬要求：三个端口的方法一次都不被调用 */
function expectNoPortCalls(spies: DownloadPortSpies): void {
  expect(spies.findById).not.toHaveBeenCalled();
  expect(spies.read).not.toHaveBeenCalled();
  expect(spies.audit).not.toHaveBeenCalled();
}

afterAll(async () => {
  await Promise.all(startedApps.map((app) => app.close()));
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('导出下载：成功路径（本人 completed，真实字节 + 固定安全响应头）', () => {
  it('200 交付原始字节：固定 Content-Type / attachment 文件名 / Content-Length / no-store / nosniff', async () => {
    const app = await startDownloadApp();

    const res = await rawCall(app.baseUrl, 'GET', downloadPath(OWN_COMPLETED_ID), {
      headers: bearer(SESSION_STUDENT_1),
    });

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe(EXPORT_DOWNLOAD_CONTENT_TYPE);
    expect(res.headers['content-disposition']).toBe(
      `attachment; filename="${buildExportDownloadFilename(OWN_COMPLETED_ID)}"`,
    );
    expect(res.headers['content-length']).toBe(String(res.body.byteLength));
    expect(res.headers['cache-control']).toBe(EXPORT_DOWNLOAD_CACHE_CONTROL);
    expect(res.headers['x-content-type-options']).toBe(EXPORT_DOWNLOAD_NOSNIFF);
    // 文件名由服务端摘要派生：固定前缀 + 固定后缀，且不含原始导出 ID
    const fileName = buildExportDownloadFilename(OWN_COMPLETED_ID);
    expect(fileName.startsWith(EXPORT_DOWNLOAD_FILENAME_PREFIX)).toBe(true);
    expect(fileName.endsWith('.csv')).toBe(true);
    expect(fileName).not.toContain(OWN_COMPLETED_ID);

    // 原始内容（不是 JSON 信封），且内容里没有任何内部存储形态
    expect(res.body.byteLength).toBeGreaterThan(0);
    expect(res.text.startsWith('field')).toBe(true);
    expect(res.text).not.toContain('"data"');
    for (const marker of STORAGE_LEAK_MARKERS) {
      expect(res.text).not.toContain(marker);
    }
    // **服务端有效期不外发**：既没有报头，也没有出现在响应体里
    // （到期时刻是服务端判定用的事实；调用方只需要知道「现在能不能取」）
    const seededExpiry = app.seeded.ownCompleted.expiresAt;
    expect(seededExpiry).toBeDefined();
    expect(res.headers['expires']).toBeUndefined();
    expect(res.headers['expires-at']).toBeUndefined();
    expect(res.headers['x-expires-at']).toBeUndefined();
    expect(res.text).not.toContain('expiresAt');
    expect(res.text).not.toContain(String(seededExpiry));
    // 内部存储键与产物句柄都只存在于服务端内存里
    expect(res.text).not.toContain(app.seeded.ownCompleted.artifactId ?? 'no-artifact');
    expect(
      app.artifacts.findArtifactDescriptor(app.seeded.ownCompleted.artifactId ?? ''),
    ).toBeDefined();

    // 留痕恰好一条 success，且只有脱敏三元组
    const entries = app.audit.entries();
    expect(entries).toHaveLength(1);
    expect(entries[0]?.result).toBe(ExportDownloadAuditResult.Success);
    expect(entries[0]?.exportIdDigest).toBe(digestExportId(OWN_COMPLETED_ID));
    expect(Object.keys(entries[0] ?? {}).sort()).toEqual([...EXPORT_DOWNLOAD_AUDIT_FIELDS].sort());
  });

  it('内容长度恰好等于硬上限时仍可下载（上限是「大于」才拒绝）', async () => {
    const app = await startDownloadApp();
    vi.spyOn(app.artifacts, 'read').mockResolvedValue({
      bytes: new Uint8Array(EXPORT_DOWNLOAD_MAX_BYTES),
    });

    const res = await rawCall(app.baseUrl, 'GET', downloadPath(OWN_COMPLETED_ID), {
      headers: bearer(SESSION_STUDENT_1),
    });

    expect(res.status).toBe(200);
    expect(res.body.byteLength).toBe(EXPORT_DOWNLOAD_MAX_BYTES);
    expect(res.headers['content-length']).toBe(String(EXPORT_DOWNLOAD_MAX_BYTES));
  });

  it('另一主体下载自己的 completed 导出同样成功（拒绝不是「一律 404」）', async () => {
    const app = await startDownloadApp();

    const res = await rawCall(app.baseUrl, 'GET', downloadPath(OTHER_COMPLETED_ID), {
      headers: bearer(SESSION_STUDENT_2),
    });

    expect(res.status).toBe(200);
    expect(res.headers['content-disposition']).toBe(
      `attachment; filename="${buildExportDownloadFilename(OTHER_COMPLETED_ID)}"`,
    );
  });

  it('资源级判定使用记录里的服务端资源映射的权限点（入口 + 资源各一次）', async () => {
    const app = await startDownloadApp();
    const adapter = app.app.get<RuoYiAuthzAdapter>(RUOYI_AUTHZ_ADAPTER);
    const checkAuthorization = vi.spyOn(adapter, 'checkAuthorization');

    const res = await rawCall(app.baseUrl, 'GET', downloadPath(OWN_ACHIEVEMENT_ID), {
      headers: bearer(SESSION_STUDENT_1),
    });

    expect(res.status).toBe(200);
    const subject = { userId: STUDENT_1, roles: [Role.Student] };
    expect(checkAuthorization).toHaveBeenCalledWith(subject, {
      permission: EXPORT_ENTRY_PERMISSION,
      scope: DataScope.Self,
      resourceUserId: STUDENT_1,
    });
    expect(checkAuthorization).toHaveBeenCalledWith(subject, {
      permission: EXPORT_RESOURCE_READ_PERMISSIONS[ExportResource.Achievement][0],
      scope: DataScope.Self,
      resourceUserId: STUDENT_1,
    });
    expect(checkAuthorization).toHaveBeenCalledTimes(2);
  });
});

describe('导出下载：统一安全拒绝（不存在 / 跨主体 / 未完成 / 产物缺失 / 已过期 / 无有效期）', () => {
  it('八种情形状态码、错误码与文案逐字节一致，且不发出任何下载头', async () => {
    const app = await startDownloadApp();
    const headers = bearer(SESSION_STUDENT_1);

    const cases: readonly RawResult[] = [
      // 不存在
      await rawCall(app.baseUrl, 'GET', downloadPath(UNKNOWN_ID), { headers }),
      // 形态非法（非 UUID）
      await rawCall(app.baseUrl, 'GET', downloadPath('not-a-uuid'), { headers }),
      // 跨主体（该记录属于 STUDENT_2）
      await rawCall(app.baseUrl, 'GET', downloadPath(OTHER_COMPLETED_ID), { headers }),
      // 未完成：pending
      await rawCall(app.baseUrl, 'GET', downloadPath(OWN_PENDING_ID), { headers }),
      // 未完成：failed
      await rawCall(app.baseUrl, 'GET', downloadPath(OWN_FAILED_ID), { headers }),
      // 产物缺失（completed 但存储里没有该句柄）
      await rawCall(app.baseUrl, 'GET', downloadPath(OWN_NO_ARTIFACT_ID), { headers }),
      // **已过期**（状态 completed、产物真实存在，只有服务端有效期落在过去）
      await rawCall(app.baseUrl, 'GET', downloadPath(OWN_EXPIRED_ID), { headers }),
      // **无服务端有效期**（存储 NULL / 历史行的领域形）⇒ fail-closed，不是「永不过期」
      await rawCall(app.baseUrl, 'GET', downloadPath(OWN_NO_EXPIRY_ID), { headers }),
    ];

    const contents = cases.map((res) => expectUniformRejection(res));
    // 逐字节一致：拒绝本身不泄露「有没有这条导出、它是什么状态、它是否已过期」
    for (const content of contents) {
      expect(content).toBe(contents[0]);
    }

    // 每一次尝试都留痕为同一个结果码（审计同样不泄露原因：过期与缺失、跨主体同码）
    const entries = app.audit.entries();
    expect(entries).toHaveLength(cases.length);
    for (const entry of entries) {
      expect(entry.result).toBe(ExportDownloadAuditResult.Unavailable);
    }
  });

  it('已过期 / 无有效期在产物读取之前就被拒绝：产物存储一次都不被调用', async () => {
    const app = await startDownloadApp();
    const spies = spyOnDownloadPorts(app);

    expectUniformRejection(
      await rawCall(app.baseUrl, 'GET', downloadPath(OWN_EXPIRED_ID), {
        headers: bearer(SESSION_STUDENT_1),
      }),
    );
    expectUniformRejection(
      await rawCall(app.baseUrl, 'GET', downloadPath(OWN_NO_EXPIRY_ID), {
        headers: bearer(SESSION_STUDENT_1),
      }),
    );

    // 过期判定只依赖服务端记录与服务端时钟：不需要读产物，也就不会因为「读到了内容」而产生
    // 任何可观测差异（产物存储与资源级授权都不该被触达）
    expect(spies.read).not.toHaveBeenCalled();
    expect(spies.findById).toHaveBeenCalledTimes(2);
    expect(spies.audit).toHaveBeenCalledTimes(2);
  });

  it('跨主体请求使用本人的凭证也无法拿到他人导出：与「不存在」完全同形', async () => {
    const app = await startDownloadApp();

    const forged = await rawCall(app.baseUrl, 'GET', downloadPath(OWN_COMPLETED_ID), {
      headers: bearer(SESSION_STUDENT_2),
    });
    const unknown = await rawCall(app.baseUrl, 'GET', downloadPath(UNKNOWN_ID), {
      headers: bearer(SESSION_STUDENT_2),
    });

    expect(expectUniformRejection(forged)).toBe(expectUniformRejection(unknown));
    // 他人导出从未被取到：仓储调用带的是**请求主体**自己的归属
    expect(forged.text).not.toContain(STUDENT_1);
  });

  it('未完成导出的拒绝发生在资源级判定之前（只有入口一次判定）', async () => {
    const app = await startDownloadApp();
    const adapter = app.app.get<RuoYiAuthzAdapter>(RUOYI_AUTHZ_ADAPTER);
    const checkAuthorization = vi.spyOn(adapter, 'checkAuthorization');

    const res = await rawCall(app.baseUrl, 'GET', downloadPath(OWN_PENDING_ID), {
      headers: bearer(SESSION_STUDENT_1),
    });

    expectUniformRejection(res);
    expect(checkAuthorization).toHaveBeenCalledTimes(1);
  });

  it('路径参数里的编码穿越 / 伪造片段同样收敛到统一拒绝，且不回显路径', async () => {
    const app = await startDownloadApp();

    for (const forgedId of [
      '..%2F..%2Fetc%2Fpasswd',
      '%2Fvar%2Fexports%2Fu-student-2%2Fsecret-export.csv',
      `..%2F${OWN_COMPLETED_ID}`,
      `${OWN_COMPLETED_ID}%00.csv`,
    ]) {
      const res = await rawCall(app.baseUrl, 'GET', downloadPath(forgedId), {
        headers: bearer(SESSION_STUDENT_1),
      });
      expectUniformRejection(res);
      expect(res.text).not.toContain('passwd');
      expect(res.text).not.toContain('secret-export');
      expect(res.headers['content-disposition']).toBeUndefined();
    }
  });

  it('请求体不是本端点的输入：伪造 body 里的产物句柄 / 路径一律被忽略', async () => {
    const app = await startDownloadApp();

    const res = await rawCall(app.baseUrl, 'GET', downloadPath(OWN_COMPLETED_ID), {
      headers: bearer(SESSION_STUDENT_1),
      body: {
        artifactId: FORGED_ARTIFACT_ID,
        fileUrl: FORGED_FILE_URL,
        path: FORGED_PATH,
        ownerUserId: STUDENT_2,
        userId: STUDENT_2,
      },
    });

    expect(res.status).toBe(200);
    expect(res.headers['content-disposition']).toBe(
      `attachment; filename="${buildExportDownloadFilename(OWN_COMPLETED_ID)}"`,
    );
    for (const marker of STORAGE_LEAK_MARKERS) {
      expect(res.text).not.toContain(marker);
    }
    // 响应头也由全局层补齐：下载路由并没有绕过统一响应面
    expect(typeof res.headers['x-request-id']).toBe('string');
  });
});

describe('导出下载：认证与授权（拒绝路径不触达任何端口）', () => {
  it('无凭证 / 无效会话 / scheme 错误 → 401，且三个端口一次都不被调用', async () => {
    const app = await startDownloadApp();
    const spies = spyOnDownloadPorts(app);

    const unauthenticatedCases: readonly Record<string, string>[] = [
      {},
      { authorization: 'Bearer does-not-exist' },
      { authorization: 'Basic abc' },
      { authorization: 'Bearer ' },
    ];
    for (const headers of unauthenticatedCases) {
      const res = await rawCall(app.baseUrl, 'GET', downloadPath(OWN_COMPLETED_ID), { headers });
      expect(res.status).toBe(401);
      expect(envelopeOf(res).error?.code).toBe('UNAUTHENTICATED');
      expect(res.headers['content-disposition']).toBeUndefined();
    }
    expectNoPortCalls(spies);
  });

  it('入口范围不是 SELF（负责人）→ 403，且三个端口一次都不被调用', async () => {
    const app = await startDownloadApp();
    const spies = spyOnDownloadPorts(app);

    const res = await rawCall(app.baseUrl, 'GET', downloadPath(OWN_COMPLETED_ID), {
      headers: bearer(SESSION_LEADER_1),
    });

    expect(res.status).toBe(403);
    expect(envelopeOf(res).error?.code).toBe('FORBIDDEN');
    expect(res.headers['content-disposition']).toBeUndefined();
    expectNoPortCalls(spies);
  });
});

describe('导出下载：fail-closed（产物故障 / 超限 / 记录违约 / 留痕失败）', () => {
  it('产物读取故障 → 500，不外发原始错误文本，且不产生字节', async () => {
    const app = await startDownloadApp();
    vi.spyOn(app.artifacts, 'read').mockRejectedValue(
      new Error(
        `read failed: ${IN_MEMORY_EXPORT_STORAGE_PREFIX}${FORGED_PATH} token=${FORGED_STORAGE_KEY}`,
      ),
    );

    const res = await rawCall(app.baseUrl, 'GET', downloadPath(OWN_COMPLETED_ID), {
      headers: bearer(SESSION_STUDENT_1),
    });

    expectFailClosed(res, ['read failed', FORGED_STORAGE_KEY]);
    expect(app.audit.entries()[0]?.result).toBe(ExportDownloadAuditResult.Failed);
  });

  it('内容超过硬上限 → 500（不截断、不分片），且不发出任何字节', async () => {
    const app = await startDownloadApp();
    vi.spyOn(app.artifacts, 'read').mockResolvedValue({
      bytes: new Uint8Array(EXPORT_DOWNLOAD_MAX_BYTES + 1),
    });

    const res = await rawCall(app.baseUrl, 'GET', downloadPath(OWN_COMPLETED_ID), {
      headers: bearer(SESSION_STUDENT_1),
    });

    expectFailClosed(res);
    expect(app.audit.entries()[0]?.result).toBe(ExportDownloadAuditResult.Failed);
  });

  it('产物内容形态非法（非字节）→ 500', async () => {
    const app = await startDownloadApp();
    vi.spyOn(app.artifacts, 'read').mockResolvedValue({
      bytes: 'not-bytes' as unknown as Uint8Array,
    });

    const res = await rawCall(app.baseUrl, 'GET', downloadPath(OWN_COMPLETED_ID), {
      headers: bearer(SESSION_STUDENT_1),
    });

    expectFailClosed(res);
  });

  it('空产物视为「没有可交付内容」→ 与缺失同一拒绝（不是 200 空文件）', async () => {
    const app = await startDownloadApp();
    vi.spyOn(app.artifacts, 'read').mockResolvedValue({ bytes: new Uint8Array(0) });

    const res = await rawCall(app.baseUrl, 'GET', downloadPath(OWN_COMPLETED_ID), {
      headers: bearer(SESSION_STUDENT_1),
    });

    expectUniformRejection(res);
    expect(app.audit.entries()[0]?.result).toBe(ExportDownloadAuditResult.Unavailable);
  });

  it('仓储取数故障 → 500（不伪装成「不存在」）', async () => {
    const app = await startDownloadApp();
    vi.spyOn(app.repository, 'findByIdForOwner').mockRejectedValue(
      new Error(`EXECUTOR_FAILURE select from export_jobs where requester_id=${STUDENT_2}`),
    );

    const res = await rawCall(app.baseUrl, 'GET', downloadPath(OWN_COMPLETED_ID), {
      headers: bearer(SESSION_STUDENT_1),
    });

    expectFailClosed(res, [STUDENT_2, 'select from']);
    expect(app.audit.entries()[0]?.result).toBe(ExportDownloadAuditResult.Failed);
  });

  it('存储记录违约（completed 却无产物句柄 / 未知状态）→ 500', async () => {
    const app = await startDownloadApp({ seed: false });

    // 违约记录：completed 但没有产物句柄（读取契约要求两者自洽）
    await app.repository.create(
      fixtureExportRequest({ id: OWN_COMPLETED_ID, artifactId: undefined }),
    );
    const first = await rawCall(app.baseUrl, 'GET', downloadPath(OWN_COMPLETED_ID), {
      headers: bearer(SESSION_STUDENT_1),
    });
    expectFailClosed(first);

    // 未知状态取值：属于存储损坏，不得当作合法状态外发
    await app.repository.create({
      ...fixtureExportRequest({ id: OWN_PENDING_ID }),
      status: 'unknown-status' as ExportStatus,
    });
    const second = await rawCall(app.baseUrl, 'GET', downloadPath(OWN_PENDING_ID), {
      headers: bearer(SESSION_STUDENT_1),
    });
    expectFailClosed(second);
  });

  it('存储记录归属与会话主体不一致 → 500（纵深防御：仓储过滤不作为安全边界）', async () => {
    const app = await startDownloadApp();
    vi.spyOn(app.repository, 'findByIdForOwner').mockResolvedValue(
      fixtureExportRequest({ id: OWN_COMPLETED_ID, ownerUserId: STUDENT_2 }),
    );

    const res = await rawCall(app.baseUrl, 'GET', downloadPath(OWN_COMPLETED_ID), {
      headers: bearer(SESSION_STUDENT_1),
    });

    expectFailClosed(res);
  });

  it('留痕失败 → 500：绝不返回「看起来成功但没有留痕」的下载', async () => {
    const app = await startDownloadApp();
    vi.spyOn(app.audit, 'record').mockRejectedValue(new Error(`audit sink ${FORGED_STORAGE_KEY}`));

    const res = await rawCall(app.baseUrl, 'GET', downloadPath(OWN_COMPLETED_ID), {
      headers: bearer(SESSION_STUDENT_1),
    });

    expectFailClosed(res, [FORGED_STORAGE_KEY]);
  });
});

describe('导出下载：伪造输入（查询串与自定义头）', () => {
  it('任何查询参数一律 400，且不回显提交的取值', async () => {
    const app = await startDownloadApp();

    const cases: readonly (readonly [string, string])[] = [
      ['userId', STUDENT_2],
      ['ownerUserId', STUDENT_2],
      ['artifactId', FORGED_ARTIFACT_ID],
      ['fileUrl', FORGED_FILE_URL],
      ['path', FORGED_PATH],
      ['storageKey', FORGED_STORAGE_KEY],
      ['status', ExportStatus.Completed],
      ['fileName', 'secret.csv'],
      // 有效期是服务端独占事实：伪造「很久以后才过期」或「已经过期」都必须 400
      ['expiresAt', FORGED_EXPIRES_FUTURE],
    ];

    for (const [key, value] of cases) {
      const res = await rawCall(
        app.baseUrl,
        'GET',
        downloadPath(OWN_COMPLETED_ID, `?${key}=${encodeURIComponent(value)}`),
        { headers: bearer(SESSION_STUDENT_1) },
      );
      expect(res.status).toBe(400);
      expect(envelopeOf(res).error?.code).toBe('VALIDATION_FAILED');
      expect(res.headers['content-disposition']).toBeUndefined();
      expect(res.text).not.toContain(value);
      expect(res.text).not.toContain(key === 'path' ? FORGED_PATH : value);
    }
    // 400 早于任何取数：没有产物读取、也没有留痕
    expect(app.audit.entries()).toHaveLength(0);
  });

  it('伪造自定义头不影响归属、判定、响应头与留痕', async () => {
    const app = await startDownloadApp();
    const adapter = app.app.get<RuoYiAuthzAdapter>(RUOYI_AUTHZ_ADAPTER);
    const checkAuthorization = vi.spyOn(adapter, 'checkAuthorization');

    const res = await rawCall(app.baseUrl, 'GET', downloadPath(OWN_COMPLETED_ID), {
      headers: {
        ...bearer(SESSION_STUDENT_1),
        'x-user-id': STUDENT_2,
        'x-owner-user-id': STUDENT_2,
        'x-roles': 'super_admin',
        'x-scope': 'GLOBAL',
        'x-artifact-id': FORGED_ARTIFACT_ID,
        'x-file-url': FORGED_FILE_URL,
        'x-path': FORGED_PATH,
        'x-storage-key': FORGED_STORAGE_KEY,
        'x-filename': 'evil-secret-export.csv',
        'x-request-id': FORGED_REQUEST_ID,
        // 伪造「有效期」（把到期时刻推到很远）不得改变判定：有效期只来自服务端记录
        'x-expires-at': FORGED_EXPIRES_FUTURE,
        'expires-at': FORGED_EXPIRES_PAST,
      },
    });

    expect(res.status).toBe(200);
    expect(res.headers['content-disposition']).toBe(
      `attachment; filename="${buildExportDownloadFilename(OWN_COMPLETED_ID)}"`,
    );
    // 文件名只来自服务端摘要：伪造的 x-filename 既没被采用，也没有把 CRLF / 路径带进响应头
    expect(res.headers['content-disposition']).not.toContain('evil-secret-export');
    expect(String(res.headers['content-disposition'])).not.toMatch(/[\r\n]/u);
    expect(res.headers['x-injected']).toBeUndefined();
    for (const marker of STORAGE_LEAK_MARKERS) {
      expect(res.text).not.toContain(marker);
    }
    // 伪造的有效期既没有缩短有效期（否则这里会是 404）、也没有被回显，
    // 更没有变成任何表示「有效期」的响应头
    expect(res.text).not.toContain(FORGED_EXPIRES_FUTURE);
    expect(res.text).not.toContain(FORGED_EXPIRES_PAST);
    expect(res.headers['expires']).toBeUndefined();
    expect(res.headers['x-expires-at']).toBeUndefined();
    // 判定入参只有会话主体与**服务端常量**
    for (const authCall of checkAuthorization.mock.calls) {
      expect(authCall[0]).toEqual({ userId: STUDENT_1, roles: [Role.Student] });
      expect(authCall[1].scope).toBe(DataScope.Self);
      expect(authCall[1].resourceUserId).toBe(STUDENT_1);
    }
    // 留痕里的 requestId 是**服务端生成**的 UUID，不是客户端提交的跟踪 ID
    const entry = app.audit.entries()[0];
    expect(entry?.requestId).not.toBe(FORGED_REQUEST_ID);
    expect(entry?.requestId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u,
    );
  });

  it('留痕只记脱敏三元组：不含导出 ID 原值、产物句柄、存储位置、内容与归属', async () => {
    const app = await startDownloadApp();

    await rawCall(app.baseUrl, 'GET', downloadPath(OWN_COMPLETED_ID), {
      headers: bearer(SESSION_STUDENT_1),
    });
    await rawCall(app.baseUrl, 'GET', downloadPath(OWN_PENDING_ID), {
      headers: bearer(SESSION_STUDENT_1),
    });

    const serialized = JSON.stringify(app.audit.entries());
    expect(serialized).not.toContain(OWN_COMPLETED_ID);
    expect(serialized).not.toContain(OWN_PENDING_ID);
    expect(serialized).not.toContain(app.seeded.ownCompleted.artifactId ?? 'no-artifact');
    for (const marker of [
      IN_MEMORY_EXPORT_STORAGE_PREFIX,
      FORGED_PATH,
      FORGED_FILE_URL,
      FORGED_STORAGE_KEY,
      PII_ID_CARD,
      STUDENT_1,
      'college',
      '"bytes"',
      '"content"',
    ]) {
      expect(serialized).not.toContain(marker);
    }
    for (const entry of app.audit.entries()) {
      expect(Object.keys(entry).sort()).toEqual(['exportIdDigest', 'requestId', 'result']);
      expect(entry.exportIdDigest).toMatch(EXPORT_DOWNLOAD_AUDIT_DIGEST_PATTERN);
    }
  });
});

describe('导出下载：服务端有效期契约（纯函数 · UTC 绝对时刻 · fail-closed）', () => {
  /** 固定样本：全部显式给出，避免把「当前时刻」混进契约断言的期望值 */
  const BASE_MS = Date.parse('2026-10-10T00:00:00.000Z');

  it('TTL 是服务端常量：24 小时，且由 epoch 毫秒派生出 UTC（Z 结尾）绝对时刻', () => {
    expect(EXPORT_DOWNLOAD_TTL_MS).toBe(24 * 60 * 60 * 1000);
    const expiresAt = exportExpiresAtFrom(BASE_MS);
    expect(expiresAt).toBe('2026-10-11T00:00:00.000Z');
    // 形态固定：UTC 绝对时刻（Z 结尾、带毫秒），因此与运行机器的时区 / 夏令时无关
    expect(expiresAt.endsWith('Z')).toBe(true);
    expect(expiresAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u);
    // 纯 epoch 毫秒运算：epoch 0 派生出的就是 1970-01-02T00:00:00.000Z（+24h），
    // 没有任何本地时区 / 夏令时参与
    expect(exportExpiresAtFrom(0)).toBe('1970-01-02T00:00:00.000Z');
    expect(Date.parse(exportExpiresAtFrom(BASE_MS)) - BASE_MS).toBe(EXPORT_DOWNLOAD_TTL_MS);
  });

  it('有效当且仅当当前时刻严格早于有效期：边界时刻即判过期（半开区间）', () => {
    const expiresAt = '2026-10-11T00:00:00.000Z';
    const expiresAtMs = Date.parse(expiresAt);

    expect(isExportDownloadExpired(expiresAt, expiresAtMs - 1)).toBe(false);
    // 边界：`now == expiresAt` ⇒ 已过期（不存在「到期后还能取走一次」的窗口）
    expect(isExportDownloadExpired(expiresAt, expiresAtMs)).toBe(true);
    expect(isExportDownloadExpired(expiresAt, expiresAtMs + 1)).toBe(true);
    // 过期很久同样是过期
    expect(isExportDownloadExpired(expiresAt, expiresAtMs + 400 * 86_400_000)).toBe(true);
  });

  it('fail-closed：缺省 / 非法形态 / 非字符串一律判为不可下载（绝不解释成「永不过期」）', () => {
    const nowMs = BASE_MS;
    for (const invalid of [
      undefined,
      null,
      '',
      'not-a-date',
      '2026/10/11',
      '2026-10-11', // 无时间部分
      '2026-10-11T00:00:00', // 无毫秒 / 无时区
      '2026-11-11T00:00:00.000+08:00', // 带偏移：只接受 UTC 形
      '2026-10-11T00:00:00.000z', // 小写 z 不是契约形
      1767186000000,
      {},
      [],
      true,
    ]) {
      expect(isExportDownloadExpired(invalid, nowMs)).toBe(true);
    }
    // 合法未来时刻是唯一放行形态（小数秒可选，因此无毫秒的 UTC 形同样合法）
    expect(isExportDownloadExpired('2026-10-11T00:00:00.000Z', nowMs)).toBe(false);
    expect(isExportDownloadExpired('2026-10-11T00:00:00Z', nowMs)).toBe(false);
  });

  it('时区无关：同一瞬时点的不同**本地**日期写法不改变判定（比较的是绝对时刻）', () => {
    // 2026-10-11T00:00:00.000Z 在 UTC+8 是 08:00；判定只看瞬时点，不受宿主时区影响
    const expiresAt = '2026-10-11T00:00:00.000Z';
    expect(isExportDownloadExpired(expiresAt, Date.parse('2026-10-10T23:59:59.999Z'))).toBe(false);
    expect(isExportDownloadExpired(expiresAt, Date.parse('2026-10-11T00:00:00.000Z'))).toBe(true);
  });
});

describe('导出下载：响应头与文件名契约（纯函数）', () => {
  it('文件名由服务端摘要派生：固定字母表、确定性、不含原始导出 ID', () => {
    const first = buildExportDownloadFilename(OWN_COMPLETED_ID);
    expect(first).toBe(buildExportDownloadFilename(OWN_COMPLETED_ID));
    expect(first).not.toBe(buildExportDownloadFilename(OWN_PENDING_ID));
    expect(first).toMatch(/^rm-export-[0-9a-f]{16}\.csv$/u);
    expect(first).not.toContain(OWN_COMPLETED_ID);
    expect(assertSafeExportDownloadFilename(first)).toBe(first);
  });

  it('文件名门禁拒绝 CRLF、路径分隔符、引号、上溯片段与超长取值', () => {
    for (const unsafe of [
      '../../etc/passwd.csv',
      'dir/file.csv',
      'dir\\file.csv',
      'a"b.csv',
      'a\r\nb.csv',
      'a\nb.csv',
      'a\u0000b.csv',
      `${'a'.repeat(80)}.csv`,
      '',
      '.csv',
      'file.txt',
    ]) {
      expect(() => assertSafeExportDownloadFilename(unsafe)).toThrow();
    }
  });

  it('头取值门禁只接受可打印 ASCII（拒绝 CR / LF / NUL / 超长 / 非 ASCII）', () => {
    expect(assertSafeExportDownloadHeaderValue('content-type', EXPORT_DOWNLOAD_CONTENT_TYPE)).toBe(
      EXPORT_DOWNLOAD_CONTENT_TYPE,
    );
    for (const unsafe of [
      'text/csv\r\nX-Injected: 1',
      'text/csv\nX-Injected: 1',
      'text/csv\u0000',
      'text/csv; charset=utf-8中文',
      'a'.repeat(256),
      '',
    ]) {
      expect(() => assertSafeExportDownloadHeaderValue('content-type', unsafe)).toThrow();
    }
    // 错误消息只写头名，不写取值
    try {
      assertSafeExportDownloadHeaderValue('content-disposition', 'attachment\r\nX: 1');
      expect.unreachable('应当抛错');
    } catch (error) {
      expect((error as Error).message).toContain('content-disposition');
      expect((error as Error).message).not.toContain('attachment');
    }
  });

  it('Content-Disposition 固定为 attachment，且注入尝试在组装阶段被拒绝', () => {
    expect(buildExportDownloadDisposition('rm-export-0123456789abcdef.csv')).toBe(
      'attachment; filename="rm-export-0123456789abcdef.csv"',
    );
    for (const unsafe of ['a".csv', 'a\r\nb.csv', '../a.csv', 'a/b.csv']) {
      expect(() => buildExportDownloadDisposition(unsafe)).toThrow();
    }
  });

  it('响应头清单恰好五个，且不含位置 / 凭据类头', () => {
    expect([...EXPORT_DOWNLOAD_RESPONSE_HEADER_NAMES]).toEqual([
      'content-type',
      'content-disposition',
      'content-length',
      'cache-control',
      'x-content-type-options',
    ]);
    for (const forbidden of [
      'location',
      'set-cookie',
      'content-encoding',
      'content-range',
      'authorization',
    ]) {
      expect(EXPORT_DOWNLOAD_RESPONSE_HEADER_NAMES as readonly string[]).not.toContain(forbidden);
    }
    // 固定的内容类型是可判定为「数据」的类型，绝不是可被浏览器解释的 HTML / SVG / JS
    expect(EXPORT_DOWNLOAD_CONTENT_TYPE.startsWith('text/csv')).toBe(true);
    expect(EXPORT_DOWNLOAD_CONTENT_TYPE).not.toContain('html');
    expect(EXPORT_DOWNLOAD_CONTENT_TYPE).not.toContain('javascript');
    expect(EXPORT_DOWNLOAD_CONTENT_TYPE).not.toContain('svg');
  });

  it('下载端点的查询参数闭集与写入/列表口径一致：空集（任何参数都走 400 出口）', () => {
    expect([...EXPORT_DOWNLOAD_QUERY_FIELDS]).toEqual([]);
    expect([...EXPORT_DOWNLOAD_QUERY_FIELDS]).toEqual([...EXPORT_QUERY_FIELDS]);
  });
});

describe('导出下载：审计条目契约（脱敏）', () => {
  const validEntry = {
    requestId: randomUUID(),
    exportIdDigest: digestExportId('some-export-id'),
    result: ExportDownloadAuditResult.Success,
  };

  it('摘要为 sha256 前 32 位十六进制：确定性、单向、非字符串按空串处理', () => {
    expect(validEntry.exportIdDigest).toMatch(EXPORT_DOWNLOAD_AUDIT_DIGEST_PATTERN);
    expect(digestExportId('abc')).toBe(digestExportId('abc'));
    expect(digestExportId('abc')).not.toBe(digestExportId('abd'));
    expect(digestExportId('abc')).not.toContain('abc');
    expect(digestExportId(undefined)).toBe(digestExportId(''));
    expect(digestExportId({ leaked: 'x' } as unknown)).toBe(digestExportId(''));
  });

  it('严格契约恰好接受三个字段', () => {
    expect(Object.keys(exportDownloadAuditEntrySchema.shape).sort()).toEqual(
      [...EXPORT_DOWNLOAD_AUDIT_FIELDS].sort(),
    );
    const parsed = parseExportDownloadAuditEntry(validEntry);
    expect(parsed.ok).toBe(true);
    expect(parsed.ok && parsed.value).toEqual(validEntry);
  });

  it('任何多余字段（产物位置 / 内容 / 归属 / 请求侧输入）都被拒绝，且不回显取值', () => {
    for (const extra of FORBIDDEN_EXPORT_DOWNLOAD_AUDIT_FIELDS) {
      const parsed = parseExportDownloadAuditEntry({
        ...validEntry,
        [extra]: `LEAK-${PII_ID_CARD}`,
      });
      expect(parsed.ok).toBe(false);
      if (!parsed.ok) {
        expect(
          parsed.issues.some((issue) => issue.path === extra && issue.kind === 'unexpected'),
        ).toBe(true);
        expect(JSON.stringify(parsed.issues)).not.toContain('LEAK');
      }
    }
    // 白名单与禁止清单零交集（机器可判定）
    const declared = new Set<string>(EXPORT_DOWNLOAD_AUDIT_FIELDS);
    for (const forbidden of FORBIDDEN_EXPORT_DOWNLOAD_AUDIT_FIELDS) {
      expect(declared.has(forbidden)).toBe(false);
    }
  });

  it('非法摘要 / 未登记结果码 / 缺字段一律拒绝', () => {
    for (const entry of [
      { ...validEntry, exportIdDigest: 'md5:abc' },
      { ...validEntry, exportIdDigest: validEntry.exportIdDigest.toUpperCase() },
      { ...validEntry, result: 'ok' },
      { ...validEntry, requestId: 'not-a-uuid' },
      { exportIdDigest: validEntry.exportIdDigest, result: validEntry.result },
      { ...validEntry, result: undefined },
    ]) {
      expect(parseExportDownloadAuditEntry(entry).ok).toBe(false);
    }
  });

  it('内存审计出口按严格契约校验：违约条目拒绝写入（不是静默剥离）', async () => {
    const sink = new InMemoryExportDownloadAuditSink(loadEnv({ NODE_ENV: 'test' }));
    await sink.record(validEntry);
    expect(sink.entries()).toHaveLength(1);

    await expect(
      sink.record({ ...validEntry, storageKey: FORGED_STORAGE_KEY } as never),
    ).rejects.toThrow();
    expect(sink.entries()).toHaveLength(1);
    // 返回副本：调用方无法就地改写已写入的留痕
    expect(sink.entries()).not.toBe(sink.entries());
  });
});

describe('导出下载：产物存储最小读能力（内存基线）', () => {
  it('read 只回内容字节：命中返回副本，未知句柄返回 undefined，且不含位置信息', async () => {
    const artifacts = new InMemoryExportArtifactStore(loadEnv({ NODE_ENV: 'test' }));
    const ref = artifacts.store({
      exportRequestId: OWN_COMPLETED_ID,
      ownerUserId: STUDENT_1,
      resource: ExportResource.Profile,
      fields: ['college', 'major'],
    });

    const content = await artifacts.read(ref.artifactId);
    expect(content).toBeDefined();
    expect(Object.keys(content ?? {})).toEqual(['bytes']);
    const bytes = content?.bytes ?? new Uint8Array();
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(bytes.byteLength).toBe(artifacts.findArtifactDescriptor(ref.artifactId)?.byteSize);
    // 内容只由服务端字段白名单派生：没有归属、没有存储键、没有路径
    const text = Buffer.from(bytes).toString('utf8');
    expect(text).toContain('college');
    for (const marker of [
      STUDENT_1,
      IN_MEMORY_EXPORT_STORAGE_PREFIX,
      ref.artifactId,
      FORGED_PATH,
    ]) {
      expect(text).not.toContain(marker);
    }

    // 返回副本：调用方改写字节不会污染基线内部内容
    bytes[0] = 0;
    const reread = await artifacts.read(ref.artifactId);
    expect(reread?.bytes[0]).not.toBe(0);

    await expect(artifacts.read(randomUUID())).resolves.toBeUndefined();
  });

  it('生产环境拒绝构造内存产物存储与内存审计出口', () => {
    const production = loadEnv({ NODE_ENV: 'production' });
    expect(() => new InMemoryExportArtifactStore(production)).toThrow();
    expect(() => new InMemoryExportDownloadAuditSink(production)).toThrow();
  });

  it('装配层：端口令牌与内存基线指向同一个实例（换绑点唯一）', async () => {
    const app = await startDownloadApp();
    expect(app.app.get(EXPORT_DOWNLOAD_AUDIT)).toBe(app.audit);
    expect(app.app.get(EXPORT_REPOSITORY)).toBe(app.repository);
  });

  it('端口源码层面：读能力的返回类型只装内容字节，装不下 key / 路径 / URL / 文件名', () => {
    const source = readFileSync(
      resolve(process.cwd(), 'src/modules/exports/exports.port.ts'),
      'utf8',
    );
    // 读能力的返回类型恰好只有 bytes
    const contentBlock = source.slice(
      source.indexOf('export interface ExportArtifactContent {'),
      source.indexOf('export interface ExportArtifactStoreCapabilities {'),
    );
    expect(contentBlock).toContain('readonly bytes: Uint8Array;');
    for (const forbidden of [
      'storageKey',
      'storagePath',
      'filePath',
      'fileName',
      'downloadUrl',
      'signedUrl',
      'objectKey',
      'url',
    ]) {
      expect(contentBlock).not.toContain(forbidden);
    }
    // 端口方法面：store + read，且 read 返回「内容 | undefined」，没有写回 / 删除 / 位置方法
    expect(source).toContain(
      'read(artifactId: string): Promise<ExportArtifactContent | undefined>;',
    );
    for (const forbidden of ['delete', 'remove', 'signedUrl', 'getPath', 'getUrl']) {
      expect(source).not.toContain(`${forbidden}(`);
    }
  });
});

describe('导出下载：仓储单条取数的归属隔离（内存基线）', () => {
  async function seededRepository(): Promise<InMemoryExportRepository> {
    const repository = new InMemoryExportRepository(loadEnv({ NODE_ENV: 'test' }));
    await repository.create(fixtureExportRequest({ id: OWN_COMPLETED_ID }));
    await repository.create(
      fixtureExportRequest({ id: OTHER_COMPLETED_ID, ownerUserId: STUDENT_2 }),
    );
    return repository;
  }

  it('findByIdForOwner 只返回「本人 + 该 ID」的记录', async () => {
    const repository = await seededRepository();

    const mine = await repository.findByIdForOwner(OWN_COMPLETED_ID, STUDENT_1);
    expect(mine?.id).toBe(OWN_COMPLETED_ID);
    expect(mine?.ownerUserId).toBe(STUDENT_1);
  });

  it('他人 ID 与不存在的 ID 返回同一个 undefined（不可区分，不泄露存在性）', async () => {
    const repository = await seededRepository();

    await expect(
      repository.findByIdForOwner(OTHER_COMPLETED_ID, STUDENT_1),
    ).resolves.toBeUndefined();
    await expect(repository.findByIdForOwner(UNKNOWN_ID, STUDENT_1)).resolves.toBeUndefined();
    // 反方向同样成立：本人不能借自己的 ID 去取他人记录
    await expect(repository.findByIdForOwner(OWN_COMPLETED_ID, STUDENT_2)).resolves.toBeUndefined();
  });

  it('返回副本：调用方就地改写字段不会污染仓储内部记录', async () => {
    const repository = await seededRepository();

    const record = await repository.findByIdForOwner(OWN_COMPLETED_ID, STUDENT_1);
    expect(record).toBeDefined();
    const mutable = record as unknown as { fields: string[] };
    mutable.fields.push(FORGED_PATH);

    const reread = await repository.findByIdForOwner(OWN_COMPLETED_ID, STUDENT_1);
    expect(reread?.fields).not.toContain(FORGED_PATH);
  });

  it('端口面没有「不带归属条件的单条读取」入口', () => {
    const repository = new InMemoryExportRepository(
      loadEnv({ NODE_ENV: 'test' }),
    ) as unknown as Record<string, unknown>;
    for (const present of ['create', 'save', 'listByOwnerId', 'findByIdForOwner']) {
      expect(typeof repository[present]).toBe('function');
    }
    for (const forbidden of ['findById', 'findByOwner', 'findAll', 'query', 'delete', 'upsert']) {
      expect(repository[forbidden]).toBeUndefined();
    }
  });

  it('内存基线不得改写服务端有效期（与数据库 adapter 的不可变列同语义）', async () => {
    const repository = new InMemoryExportRepository(loadEnv({ NODE_ENV: 'test' }));
    const stored = fixtureExportRequest({ id: OWN_COMPLETED_ID });
    expect(stored.expiresAt).toBeDefined();
    await repository.create(stored);

    // 1) 续期（把过期时间往后推）被拒绝：否则「已过期的交付物」能被静默救回可下载状态
    await expect(
      repository.save({ ...stored, expiresAt: futureExpiry(7_200_000) }),
    ).rejects.toThrow(/有效期不可改写/u);

    // 2) 清空有效期（模拟「记为永不过期」）同样被拒绝
    await expect(repository.save(withoutExpiry(stored))).rejects.toThrow(/有效期不可改写/u);

    // 3) 有效期不变时，正常的写回（状态推进）仍然成功，且存储里的有效期逐字节不变
    const saved = await repository.save({ ...stored, status: ExportStatus.Completed });
    expect(saved.expiresAt).toBe(stored.expiresAt);
    const reread = await repository.findByIdForOwner(OWN_COMPLETED_ID, STUDENT_1);
    expect(reread?.expiresAt).toBe(stored.expiresAt);
  });
});

import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { request } from 'node:http';
import { dirname, join, resolve } from 'node:path';
import { Module } from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import { APP_FILTER, APP_INTERCEPTOR, NestFactory } from '@nestjs/core';
import { Role } from '@rm/shared';
import type { ApiEnvelope } from '@rm/shared';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import type { MockInstance } from 'vitest';
import { ZodError } from 'zod';
import { ApiExceptionFilter } from '../../common/api-exception.filter';
import { ApiResponseInterceptor } from '../../common/api-response.interceptor';
import { ConfigModule } from '../../config/config.module';
import { loadEnv } from '../../config/env';
import { InMemorySessionStore } from '../auth/session-store.in-memory';
import { SESSION_STORE } from '../auth/session-subject.port';
import { InMemoryExportArtifactStore } from './exports.artifact-store.in-memory';
import {
  EXPORTABLE_FIELDS,
  EXPORT_AUDIT_DIGEST_PATTERN,
  EXPORT_REQUEST_VIEW_FIELDS,
  EXPORT_REVOCATION_AUDIT_FIELDS,
  EXPORT_REVOCATION_QUERY_FIELDS,
  EXPORT_REVOCATION_REQUEST_FIELDS,
  EXPORT_REVOCATION_UNAVAILABLE_MESSAGE,
  EXPORT_VIEW_REVOKED_STATUS,
  EXPORT_VIEW_STATUS_VALUES,
  ExportRevocationVerdict,
  FORBIDDEN_EXPORT_REVOCATION_AUDIT_FIELDS,
  FORBIDDEN_EXPORT_REVOCATION_REQUEST_FIELDS,
  assertDeclaredExportRevocationRequestFields,
  classifyExportRevocation,
  digestExportId,
  digestRequesterId,
  exportRequestViewSchema,
  exportRevocationAuditEntrySchema,
  exportRevokeIdSchema,
  parseExportRevocationAuditEntry,
  parseExportRequestView,
  parseStoredExportRequest,
  toExportRequestView,
} from './exports.contract';
import type { ExportRequestView } from './exports.contract';
import { InMemoryExportDownloadAuditSink } from './exports.download-audit.in-memory';
import { InMemoryExportRepository } from './exports.in-memory-repository';
import { ExportsModule } from './exports.module';
import {
  EXPORT_ARTIFACT_STORE,
  EXPORT_ARTIFACT_STORE_FORBIDDEN_METHODS,
  EXPORT_DOWNLOAD_AUDIT,
  EXPORT_REPOSITORY,
  EXPORT_REVOCATION_AUDIT,
  EXPORT_REVOCATION_CLEANUP_BOUNDARY,
  EXPORT_REVOCATION_OUTCOME_VALUES,
  ExportResource,
  ExportRevocationAuditResult,
  ExportRevocationOutcome,
  ExportStatus,
} from './exports.port';
import type { ExportRequest } from './exports.port';
import {
  POSTGRES_EXPORT_COLUMNS,
  POSTGRES_EXPORT_REVOKE_COLUMNS,
} from './exports.postgres-repository';
import { InMemoryExportRevocationAuditSink } from './exports.revocation-audit.in-memory';

/**
 * 导出撤销切片（`POST /me/exports/:exportId/revoke`）的**真实 HTTP 回归 + 仓储 / 契约单测**。
 *
 * 覆盖用户确认的全部口径：
 * - **归属只来自服务端会话**：`userId` / `ownerId` / `artifactId` / `path` / `status` /
 *   `revokedAt` 之类客户端字段在请求体里一律 400（服务端字段与未声明字段可区分、不回显取值），
 *   查询串里一律 400，自定义头一律不进入判定；跨主体与「不存在」收敛到**同一个 404**；
 * - **可撤销闭集**：`pending` / `completed` 可撤销（写 `revoked_at`）；`failed` 与**已过期**
 *   一律统一拒绝；**已撤销重复请求幂等**（200，且既有撤销时刻逐字节不变）；
 * - **撤销后下载立即失效**：与「不存在」**逐字节同形**的 404（下载回归见
 *   `exports.download.spec.ts` 的撤销回归块）；列表对该主体呈现 `revoked`，且**不暴露**
 *   产物句柄 / 路径 / 存储 key / 撤销时刻；
 * - **不物理删除、不同步清理产物**：撤销路径对产物存储的调用次数恒为 0，
 *   产物存储端口上没有任何删除 / 清理方法（能力边界 `EXPORT_REVOCATION_CLEANUP_BOUNDARY`）；
 * - **条件更新**：`WHERE id + 归属 + 可撤销前驱 + revoked_at IS NULL`，
 *   `SET` **只有** `revoked_at` / `updated_at`（不覆盖 `created_at` / `expires_at` /
 *   `artifact_id` / `status` 错误终态）；并发撤销 / 完成时撤销事实**优先**；
 * - **留痕脱敏**：恰好 `requestId` / `exportIdDigest` / `requesterDigest` / `result` 四个字段，
 *   结果闭集 `success` / `duplicate` / `unavailable`；**不记 body**、PII、路径、storage key、
 *   产物句柄、secret 或任何原值标识；
 * - **内存 / PostgreSQL 一致**：同一组入参在两种实现上给出同一组结论（显式列、参数化 SQL、
 *   归属条件、条件更新）。
 *
 * 测试用真实 Nest 应用 + 真实 HTTP（与其它切片的 controller spec 同构），只通过 DI 令牌注入
 * 测试夹具（会话 / 导出记录 / 产物），不替换任何生产代码路径。
 */

const SESSION_STUDENT_1 = 'session-student-1';
const SESSION_STUDENT_2 = 'session-student-2';
const SESSION_LEADER_1 = 'session-leader-1';

const STUDENT_1 = 'u-student-1';
const STUDENT_2 = 'u-student-2';
const LEADER_1 = 'u-leader-1';

const OWN_PENDING_ID = '11111111-1111-4111-8111-111111111111';
const OWN_COMPLETED_ID = '22222222-2222-4222-8222-222222222222';
const OWN_FAILED_ID = '33333333-3333-4333-8333-333333333333';
const OTHER_COMPLETED_ID = '55555555-5555-4555-8555-555555555555';
const OWN_EXPIRED_ID = '88888888-8888-4888-8888-888888888888';
const UNKNOWN_ID = '77777777-7777-4777-8777-777777777777';

/** 客户端伪造值：必须被拒绝或忽略，且绝不出现在响应或留痕里 */
const FORGED_ARTIFACT_ID = '99999999-9999-4999-8999-999999999999';
const FORGED_PATH = '/var/exports/u-student-2/secret-export.csv';
const FORGED_FILE_URL = 'https://files.example.com/exports/secret-export.csv';
const FORGED_STORAGE_KEY = 's3://internal-bucket/exports/secret-export.csv';
const FORGED_REQUEST_ID = 'client-trace-00000001';
const FORGED_REVOKED_AT = '2099-12-31T23:59:59.000Z';
const PII_ID_CARD = '110101199003071234';
const FORGED_NOTE = 'please revoke';

/** 未来 / 过去有效期（相对服务端当前时钟派生，避免测试自身随日期过期） */
function futureExpiry(offsetMs = 3_600_000): string {
  return new Date(Date.now() + offsetMs).toISOString();
}
function pastExpiry(offsetMs = 60_000): string {
  return new Date(Date.now() - offsetMs).toISOString();
}

/** 从当前工作目录向上寻找仓库根（含 pnpm-workspace.yaml），避免依赖 cwd 具体层级 */
function findRepoRoot(start: string): string {
  let current = resolve(start);
  for (let depth = 0; depth < 8; depth += 1) {
    if (existsSync(join(current, 'pnpm-workspace.yaml'))) {
      return current;
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  throw new Error('未找到仓库根目录（缺少 pnpm-workspace.yaml）');
}

/** 禁止出现在任何正常响应文本里的「产物位置 / 内部存储 / 原值标识」形态 */
const STORAGE_LEAK_MARKERS: readonly string[] = [
  FORGED_PATH,
  FORGED_FILE_URL,
  FORGED_STORAGE_KEY,
  FORGED_ARTIFACT_ID,
  PII_ID_CARD,
  '"artifactId"',
  '"storageKey"',
  '"fileUrl"',
  '"revokedAt"',
  '"ownerUserId"',
  'memory-export-artifacts/',
];

@Module({
  imports: [ConfigModule, ExportsModule],
  providers: [
    { provide: APP_INTERCEPTOR, useClass: ApiResponseInterceptor },
    { provide: APP_FILTER, useClass: ApiExceptionFilter },
  ],
})
class ExportsRevokeHttpModule {}

interface SeededExports {
  readonly ownPending: ExportRequest;
  readonly ownCompleted: ExportRequest;
  readonly ownFailed: ExportRequest;
  readonly ownExpired: ExportRequest;
  readonly otherCompleted: ExportRequest;
}

interface TestApp {
  readonly app: INestApplication;
  readonly baseUrl: string;
  readonly sessions: InMemorySessionStore;
  readonly repository: InMemoryExportRepository;
  readonly artifacts: InMemoryExportArtifactStore;
  readonly revocationAudit: InMemoryExportRevocationAuditSink;
  readonly downloadAudit: InMemoryExportDownloadAuditSink;
  readonly seeded: SeededExports;
}

const startedApps: INestApplication[] = [];

function profileFields(): string[] {
  return [...EXPORTABLE_FIELDS[ExportResource.Profile]];
}

function fixtureExportRequest(overrides: Partial<ExportRequest> = {}): ExportRequest {
  const base: ExportRequest = {
    id: randomUUID(),
    ownerUserId: STUDENT_1,
    resource: ExportResource.Profile,
    fields: profileFields(),
    status: ExportStatus.Completed,
    artifactId: randomUUID(),
    expiresAt: futureExpiry(),
    createdAt: '2026-01-06T00:00:00.000Z',
    updatedAt: '2026-01-06T00:00:05.000Z',
  };
  return { ...base, ...overrides };
}

/**
 * 种子：本人 `pending` / `completed` / `failed` / **已过期 completed** 与他人一条。
 * `completed` 与「已过期」两条都挂**真实存在的产物**，因此它们的下载拒绝只可能来自
 * 状态 / 有效期 / 撤销判定，而不是「产物读不到」。
 */
async function seedExports(
  repository: InMemoryExportRepository,
  artifacts: InMemoryExportArtifactStore,
): Promise<SeededExports> {
  const ownArtifact = artifacts.store({
    exportRequestId: OWN_COMPLETED_ID,
    ownerUserId: STUDENT_1,
    resource: ExportResource.Profile,
    fields: profileFields(),
  });
  const expiredArtifact = artifacts.store({
    exportRequestId: OWN_EXPIRED_ID,
    ownerUserId: STUDENT_1,
    resource: ExportResource.Profile,
    fields: profileFields(),
  });
  const otherArtifact = artifacts.store({
    exportRequestId: OTHER_COMPLETED_ID,
    ownerUserId: STUDENT_2,
    resource: ExportResource.Profile,
    fields: profileFields(),
  });

  const seeded: SeededExports = {
    ownPending: fixtureExportRequest({
      id: OWN_PENDING_ID,
      status: ExportStatus.Pending,
      artifactId: undefined,
    }),
    ownCompleted: fixtureExportRequest({
      id: OWN_COMPLETED_ID,
      artifactId: ownArtifact.artifactId,
    }),
    ownFailed: fixtureExportRequest({
      id: OWN_FAILED_ID,
      status: ExportStatus.Failed,
      artifactId: undefined,
    }),
    ownExpired: fixtureExportRequest({
      id: OWN_EXPIRED_ID,
      artifactId: expiredArtifact.artifactId,
      expiresAt: pastExpiry(),
    }),
    otherCompleted: fixtureExportRequest({
      id: OTHER_COMPLETED_ID,
      ownerUserId: STUDENT_2,
      artifactId: otherArtifact.artifactId,
    }),
  };

  for (const record of Object.values(seeded)) {
    await repository.create(record);
  }
  return seeded;
}

async function startRevokeApp(): Promise<TestApp> {
  const app = await NestFactory.create(ExportsRevokeHttpModule, { logger: false });
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
  const revocationAudit = app.get<InMemoryExportRevocationAuditSink>(EXPORT_REVOCATION_AUDIT);
  const downloadAudit = app.get<InMemoryExportDownloadAuditSink>(EXPORT_DOWNLOAD_AUDIT);
  const seeded = await seedExports(repository, artifacts);

  return {
    app,
    baseUrl: `${await app.getUrl()}/api/v1`,
    sessions,
    repository,
    artifacts,
    revocationAudit,
    downloadAudit,
    seeded,
  };
}

interface HttpResult {
  readonly status: number;
  readonly text: string;
  readonly body: ApiEnvelope<unknown>;
}

function call(
  baseUrl: string,
  method: 'GET' | 'POST',
  path: string,
  options: { readonly headers?: Record<string, string>; readonly body?: unknown } = {},
): Promise<HttpResult> {
  return new Promise<HttpResult>((resolvePromise, reject) => {
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
        resolvePromise({
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

/**
 * 下载响应**不是** JSON 信封（它交付原始字节），因此不能复用 `call`：这里只取状态码与
 * 响应体文本，不做 JSON 解析。
 */
function downloadCall(
  baseUrl: string,
  exportId: string,
  sessionId: string,
): Promise<{ readonly status: number; readonly text: string }> {
  return new Promise((resolvePromise, reject) => {
    const req = request(
      `${baseUrl}/me/exports/${exportId}/download`,
      { method: 'GET', agent: false, headers: bearer(sessionId) },
      (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => {
          text += chunk;
        });
        res.on('end', () => {
          resolvePromise({ status: res.statusCode ?? 0, text });
        });
      },
    );
    req.on('error', reject);
    req.end();
  });
}

function bearer(sessionId: string): Record<string, string> {
  return { authorization: `Bearer ${sessionId}` };
}

function revokePath(exportId: string, query = ''): string {
  return `/me/exports/${exportId}/revoke${query}`;
}

function viewOf(body: ApiEnvelope<unknown>): ExportRequestView {
  return body.data as ExportRequestView;
}

function viewsOf(body: ApiEnvelope<unknown>): ExportRequestView[] {
  return body.data as ExportRequestView[];
}

/** 响应中「业务内容」部分的文本：去掉随机 `meta`，用于逐字节比较与泄漏断言 */
function contentOf(res: HttpResult): string {
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

/** 统一安全拒绝的完整断言（404 + 同一文案 + 无存储 / 标识泄漏） */
function expectUniformRevocationRejection(res: HttpResult): string {
  expect(res.status).toBe(404);
  expect(res.body.error?.code).toBe('NOT_FOUND');
  expect(res.body.error?.message).toBe(EXPORT_REVOCATION_UNAVAILABLE_MESSAGE);
  expect(res.body.data).toBeNull();
  const content = contentOf(res);
  for (const marker of STORAGE_LEAK_MARKERS) {
    expect(content).not.toContain(marker);
  }
  for (const leaked of [STUDENT_1, STUDENT_2, OWN_PENDING_ID, FORGED_PATH, PII_ID_CARD]) {
    expect(content).not.toContain(leaked);
  }
  return content;
}

/** 断言一段正常响应内容里没有「产物位置 / 内部存储」的任何形态 */
function expectNoStorageLeak(content: string): void {
  for (const marker of STORAGE_LEAK_MARKERS) {
    expect(content).not.toContain(marker);
  }
}

/** 视图是既有白名单闭集：字段一个都不新增（撤销只让 `status` 多一个派生取值） */
function expectViewWhitelist(view: ExportRequestView): void {
  expect(Object.keys(view).sort()).toEqual([...EXPORT_REQUEST_VIEW_FIELDS].sort());
  const parsed = parseExportRequestView(view);
  expect(parsed.ok).toBe(true);
}

interface RevokePortSpies {
  readonly findById: MockInstance;
  readonly revoke: MockInstance;
  readonly audit: MockInstance;
  readonly artifactStore: MockInstance;
  readonly artifactRead: MockInstance;
  readonly downloadAudit: MockInstance;
}

function spyOnPorts(app: TestApp): RevokePortSpies {
  return {
    findById: vi.spyOn(app.repository, 'findByIdForOwner'),
    revoke: vi.spyOn(app.repository, 'revokeForOwner'),
    audit: vi.spyOn(app.revocationAudit, 'record'),
    artifactStore: vi.spyOn(app.artifacts, 'store'),
    artifactRead: vi.spyOn(app.artifacts, 'read'),
    downloadAudit: vi.spyOn(app.downloadAudit, 'record'),
  };
}

/** 认证 / 授权拒绝路径的硬要求：所有端口方法一次都不被调用 */
function expectNoPortCalls(spies: RevokePortSpies): void {
  expect(spies.findById).not.toHaveBeenCalled();
  expect(spies.revoke).not.toHaveBeenCalled();
  expect(spies.audit).not.toHaveBeenCalled();
  expect(spies.artifactStore).not.toHaveBeenCalled();
  expect(spies.artifactRead).not.toHaveBeenCalled();
  expect(spies.downloadAudit).not.toHaveBeenCalled();
}

afterAll(async () => {
  await Promise.all(startedApps.map((app) => app.close()));
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('导出撤销：成功路径（真实 HTTP + 统一响应信封）', () => {
  it('撤销本人 pending：200、状态派生为 revoked、留痕 success，且记录与产物都保留', async () => {
    const app = await startRevokeApp();
    const spies = spyOnPorts(app);

    const res = await call(app.baseUrl, 'POST', revokePath(OWN_PENDING_ID), {
      headers: bearer(SESSION_STUDENT_1),
    });

    expect(res.status).toBe(200);
    expect(res.body.error).toBeNull();
    const view = viewOf(res.body);
    expectViewWhitelist(view);
    expect(view.id).toBe(OWN_PENDING_ID);
    expect(view.status).toBe(EXPORT_VIEW_REVOKED_STATUS);

    // 存储事实：撤销时刻已落库、状态**没有被改写**、记录仍然存在（不物理删除）
    const stored = await app.repository.findByIdForOwner(OWN_PENDING_ID, STUDENT_1);
    expect(stored?.revokedAt).toBeDefined();
    expect(stored?.status).toBe(ExportStatus.Pending);
    // 撤销时刻同时成为服务端时钟写入的 updated_at（同一次时钟读数）
    expect(stored?.updatedAt).toBe(stored?.revokedAt);

    // 撤销**不碰**产物存储（既不清产物，也不读产物）
    expect(spies.artifactStore).not.toHaveBeenCalled();
    expect(spies.artifactRead).not.toHaveBeenCalled();
    // 撤销也不写下载留痕（两条留痕是独立的最小事实集）
    expect(app.downloadAudit.entries()).toHaveLength(0);

    // 留痕：恰好四字段、结果 success、两个摘要都是 sha256 前 32 位（不含任何原值）
    const entries = app.revocationAudit.entries();
    expect(entries).toHaveLength(1);
    expect(entries[0]?.result).toBe(ExportRevocationAuditResult.Success);
    expect(entries[0]?.exportIdDigest).toBe(digestExportId(OWN_PENDING_ID));
    expect(entries[0]?.requesterDigest).toBe(digestRequesterId(STUDENT_1));
    expect(entries[0]?.exportIdDigest).toMatch(EXPORT_AUDIT_DIGEST_PATTERN);
    expect(Object.keys(entries[0] ?? {}).sort()).toEqual(
      [...EXPORT_REVOCATION_AUDIT_FIELDS].sort(),
    );
    const auditText = JSON.stringify(entries);
    for (const leaked of [
      STUDENT_1,
      OWN_PENDING_ID,
      FORGED_ARTIFACT_ID,
      FORGED_PATH,
      FORGED_STORAGE_KEY,
      FORGED_FILE_URL,
      PII_ID_CARD,
      FORGED_NOTE,
    ]) {
      expect(auditText).not.toContain(leaked);
    }
    for (const marker of STORAGE_LEAK_MARKERS) {
      expect(auditText).not.toContain(marker);
    }
  });

  it('撤销本人 completed：200；产物既没有被清理（仍可读），下载也立即统一 404', async () => {
    const app = await startRevokeApp();

    // 撤销前：本人可以下载（证明产物真实存在、判定链正常）
    const before = await downloadCall(app.baseUrl, OWN_COMPLETED_ID, SESSION_STUDENT_1);
    expect(before.status).toBe(200);

    const res = await call(app.baseUrl, 'POST', revokePath(OWN_COMPLETED_ID), {
      headers: bearer(SESSION_STUDENT_1),
    });
    expect(res.status).toBe(200);
    expect(viewOf(res.body).status).toBe(EXPORT_VIEW_REVOKED_STATUS);

    const stored = await app.repository.findByIdForOwner(OWN_COMPLETED_ID, STUDENT_1);
    expect(stored?.status).toBe(ExportStatus.Completed);
    expect(stored?.revokedAt).toBeDefined();
    // 不物理删除、不同步清理：产物句柄仍在，产物内容仍可读
    const artifactId = stored?.artifactId ?? '';
    expect(artifactId).not.toBe('');
    const content = await app.artifacts.read(artifactId);
    expect(content?.bytes.byteLength).toBeGreaterThan(0);

    // 撤销后下载立即统一 404，且与「不存在」逐字节同形
    const revoked = await call(app.baseUrl, 'GET', `/me/exports/${OWN_COMPLETED_ID}/download`, {
      headers: bearer(SESSION_STUDENT_1),
    });
    const unknown = await call(app.baseUrl, 'GET', `/me/exports/${UNKNOWN_ID}/download`, {
      headers: bearer(SESSION_STUDENT_1),
    });
    expect(revoked.status).toBe(404);
    expect(contentOf(revoked)).toBe(contentOf(unknown));
  });
  it('列表对该主体呈现 revoked，且视图仍是既有闭集（不含撤销时刻 / 产物句柄 / 路径）', async () => {
    const app = await startRevokeApp();
    await call(app.baseUrl, 'POST', revokePath(OWN_COMPLETED_ID), {
      headers: bearer(SESSION_STUDENT_1),
    });

    const res = await call(app.baseUrl, 'GET', '/me/exports', {
      headers: bearer(SESSION_STUDENT_1),
    });
    expect(res.status).toBe(200);
    const views = viewsOf(res.body);
    const byId = new Map(views.map((view) => [view.id, view]));
    expect(byId.get(OWN_COMPLETED_ID)?.status).toBe(EXPORT_VIEW_REVOKED_STATUS);
    // 未撤销的记录状态不变
    expect(byId.get(OWN_PENDING_ID)?.status).toBe(ExportStatus.Pending);
    expect(byId.get(OWN_FAILED_ID)?.status).toBe(ExportStatus.Failed);
    // 撤销只影响本人：他人记录不被撤销，也不出现在本人列表里
    expect(byId.has(OTHER_COMPLETED_ID)).toBe(false);
    for (const view of views) {
      expectViewWhitelist(view);
    }
    const other = await app.repository.findByIdForOwner(OTHER_COMPLETED_ID, STUDENT_2);
    expect(other?.revokedAt).toBeUndefined();
    expectNoStorageLeak(contentOf(res));
  });
});

describe('导出撤销：幂等（重复请求不改写既有事实）', () => {
  it('重复撤销：每次都 200 且响应逐字节同形，撤销时刻不变，留痕第二次是 duplicate', async () => {
    const app = await startRevokeApp();

    const first = await call(app.baseUrl, 'POST', revokePath(OWN_COMPLETED_ID), {
      headers: bearer(SESSION_STUDENT_1),
    });
    expect(first.status).toBe(200);
    const firstStored = await app.repository.findByIdForOwner(OWN_COMPLETED_ID, STUDENT_1);

    const second = await call(app.baseUrl, 'POST', revokePath(OWN_COMPLETED_ID), {
      headers: bearer(SESSION_STUDENT_1),
    });
    const third = await call(app.baseUrl, 'POST', revokePath(OWN_COMPLETED_ID), {
      headers: bearer(SESSION_STUDENT_1),
    });

    expect(second.status).toBe(200);
    expect(third.status).toBe(200);
    expect(contentOf(second)).toBe(contentOf(first));
    expect(contentOf(third)).toBe(contentOf(first));

    // 撤销是**单调**事实：既有撤销时刻逐字节不变，状态 / 产物句柄 / 有效期也不被改写
    const after = await app.repository.findByIdForOwner(OWN_COMPLETED_ID, STUDENT_1);
    expect(after?.revokedAt).toBe(firstStored?.revokedAt);
    expect(after?.status).toBe(firstStored?.status);
    expect(after?.artifactId).toBe(firstStored?.artifactId);
    expect(after?.expiresAt).toBe(firstStored?.expiresAt);

    expect(app.revocationAudit.entries().map((entry) => entry.result)).toEqual([
      ExportRevocationAuditResult.Success,
      ExportRevocationAuditResult.Duplicate,
      ExportRevocationAuditResult.Duplicate,
    ]);
  });

  it('已经撤销**且已过期**的记录：仍按幂等成功返回（撤销判定优先于过期判定）', async () => {
    const app = await startRevokeApp();
    // 第一次：正常撤销（记录仍在有效期内）
    const first = await call(app.baseUrl, 'POST', revokePath(OWN_COMPLETED_ID), {
      headers: bearer(SESSION_STUDENT_1),
    });
    expect(first.status).toBe(200);
    const stored = await app.repository.findByIdForOwner(OWN_COMPLETED_ID, STUDENT_1);
    expect(stored?.revokedAt).toBeDefined();

    // 把服务端时钟推到有效期**之后**（记录此刻已过期）：判定顺序必须让「已撤销」优先，
    // 否则「撤销一条早已过期的记录」会从幂等成功漂移成统一拒绝 —— 撤销是单调事实，
    // 历史结论不能因为时间流逝而让重复请求换一个出口。
    const expiresAtMs = Date.parse(stored?.expiresAt ?? '');
    expect(Number.isFinite(expiresAtMs)).toBe(true);
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(expiresAtMs + 60_000);

    const res = await call(app.baseUrl, 'POST', revokePath(OWN_COMPLETED_ID), {
      headers: bearer(SESSION_STUDENT_1),
    });
    nowSpy.mockRestore();

    expect(res.status).toBe(200);
    expect(viewOf(res.body).status).toBe(EXPORT_VIEW_REVOKED_STATUS);
    expect(app.revocationAudit.entries().at(-1)?.result).toBe(
      ExportRevocationAuditResult.Duplicate,
    );
    // 撤销时刻没有被第二次请求改写
    const after = await app.repository.findByIdForOwner(OWN_COMPLETED_ID, STUDENT_1);
    expect(after?.revokedAt).toBe(stored?.revokedAt);
  });
});

describe('导出撤销：不可撤销与统一安全拒绝（404）', () => {
  it('failed 结论不可撤销：统一 404、留痕 unavailable，且不产生任何写入', async () => {
    const app = await startRevokeApp();
    const before = await app.repository.findByIdForOwner(OWN_FAILED_ID, STUDENT_1);

    const res = await call(app.baseUrl, 'POST', revokePath(OWN_FAILED_ID), {
      headers: bearer(SESSION_STUDENT_1),
    });
    expectUniformRevocationRejection(res);

    const after = await app.repository.findByIdForOwner(OWN_FAILED_ID, STUDENT_1);
    expect(after).toEqual(before);
    expect(after?.revokedAt).toBeUndefined();
    expect(app.revocationAudit.entries().map((entry) => entry.result)).toEqual([
      ExportRevocationAuditResult.Unavailable,
    ]);
  });

  it('已过期的 completed 不可撤销：统一 404、不写 revoked_at、不触达产物存储', async () => {
    const app = await startRevokeApp();
    const spies = spyOnPorts(app);

    const res = await call(app.baseUrl, 'POST', revokePath(OWN_EXPIRED_ID), {
      headers: bearer(SESSION_STUDENT_1),
    });
    expectUniformRevocationRejection(res);

    const after = await app.repository.findByIdForOwner(OWN_EXPIRED_ID, STUDENT_1);
    expect(after?.revokedAt).toBeUndefined();
    expect(spies.artifactStore).not.toHaveBeenCalled();
    expect(spies.artifactRead).not.toHaveBeenCalled();
    expect(app.revocationAudit.entries().at(-1)?.result).toBe(
      ExportRevocationAuditResult.Unavailable,
    );
  });

  it('不存在 / 跨主体 / 非法形态：三种情形与「他人记录」完全同形（同一个 404 出口）', async () => {
    const app = await startRevokeApp();

    const unknown = await call(app.baseUrl, 'POST', revokePath(UNKNOWN_ID), {
      headers: bearer(SESSION_STUDENT_1),
    });
    // 用**自己的**凭证去撤销**他人**的记录：拿不到任何区分信息
    const crossSubject = await call(app.baseUrl, 'POST', revokePath(OTHER_COMPLETED_ID), {
      headers: bearer(SESSION_STUDENT_1),
    });
    // 同样地，用**他人的**凭证去撤销**他人**的记录是允许的（那是他自己的记录）
    const ownOfOther = await call(app.baseUrl, 'POST', revokePath(OTHER_COMPLETED_ID), {
      headers: bearer(SESSION_STUDENT_2),
    });
    const malformed = await call(app.baseUrl, 'POST', revokePath('not-a-uuid'), {
      headers: bearer(SESSION_STUDENT_1),
    });
    const traversalAttempt = await call(
      app.baseUrl,
      'POST',
      `/me/exports/${encodeURIComponent('../../etc/passwd')}/revoke`,
      { headers: bearer(SESSION_STUDENT_1) },
    );

    const unknownContent = expectUniformRevocationRejection(unknown);
    expect(contentOf(crossSubject)).toBe(unknownContent);
    expect(contentOf(malformed)).toBe(unknownContent);
    expect(contentOf(traversalAttempt)).toBe(unknownContent);
    expect(ownOfOther.status).toBe(200);
    expect(viewOf(ownOfOther.body).status).toBe(EXPORT_VIEW_REVOKED_STATUS);

    // 他人的记录没有被跨主体撤销影响：由本人自己的那次请求撤销
    const other = await app.repository.findByIdForOwner(OTHER_COMPLETED_ID, STUDENT_2);
    expect(other?.revokedAt).toBeDefined();
  });
});

describe('导出撤销：客户端字段与伪造输入（服务端独占事实）', () => {
  const forbiddenBodyFields: ReadonlyArray<readonly [string, unknown]> = [
    ['userId', STUDENT_2],
    ['ownerId', STUDENT_2],
    ['ownerUserId', STUDENT_2],
    ['artifactId', FORGED_ARTIFACT_ID],
    ['path', FORGED_PATH],
    ['filePath', FORGED_PATH],
    ['fileUrl', FORGED_FILE_URL],
    ['storageKey', FORGED_STORAGE_KEY],
    ['status', ExportStatus.Completed],
    ['revokedAt', FORGED_REVOKED_AT],
    ['expiresAt', FORGED_REVOKED_AT],
    ['roles', ['super_admin']],
    ['scope', 'GLOBAL'],
    ['groupId', 'g-1'],
  ];

  it('请求体闭集为空集：任何服务端字段都 400（原因可区分、不回显取值），且不触达端口', async () => {
    for (const [field, value] of forbiddenBodyFields) {
      const app = await startRevokeApp();
      const spies = spyOnPorts(app);

      const res = await call(app.baseUrl, 'POST', revokePath(OWN_PENDING_ID), {
        headers: bearer(SESSION_STUDENT_1),
        body: { [field]: value },
      });

      expect(res.status).toBe(400);
      expect(res.body.error?.code).toBe('VALIDATION_FAILED');
      const issues = issuesOf(res.body);
      expect(issues.some((issue) => issue.path === field)).toBe(true);
      expect(issues.some((issue) => issue.message.includes('禁止设置服务端字段'))).toBe(true);
      // 拒绝**不回显**提交的取值
      const content = contentOf(res);
      if (typeof value === 'string') {
        expect(content).not.toContain(value);
      }
      expectNoPortCalls(spies);
    }
    // 请求体闭集本身是空集（撤销的每一个入参都来自服务端）
    expect([...EXPORT_REVOCATION_REQUEST_FIELDS]).toEqual([]);
  });

  it('未声明字段与「服务端字段」可区分：前者按未声明拒绝', async () => {
    const app = await startRevokeApp();
    const res = await call(app.baseUrl, 'POST', revokePath(OWN_PENDING_ID), {
      headers: bearer(SESSION_STUDENT_1),
      body: { note: FORGED_NOTE },
    });
    expect(res.status).toBe(400);
    const issues = issuesOf(res.body);
    expect(issues.some((issue) => issue.message.includes('请求体包含未声明字段'))).toBe(true);
    expect(contentOf(res)).not.toContain(FORGED_NOTE);
  });

  it('查询串闭集为空集：任何查询参数都 400（不回显取值），且不触达端口', async () => {
    const queries: readonly string[] = [
      '?userId=u-student-2',
      '?ownerUserId=u-student-2',
      '?artifactId=99999999-9999-4999-8999-999999999999',
      '?path=%2Fvar%2Fexports%2Fsecret.csv',
      '?status=revoked',
      '?revokedAt=2099-12-31T23%3A59%3A59.000Z',
      '?limit=1',
    ];
    for (const query of queries) {
      const app = await startRevokeApp();
      const spies = spyOnPorts(app);
      const res = await call(app.baseUrl, 'POST', revokePath(OWN_PENDING_ID, query), {
        headers: bearer(SESSION_STUDENT_1),
      });
      expect(res.status).toBe(400);
      expect(issuesOf(res.body).length).toBeGreaterThan(0);
      expectNoPortCalls(spies);
    }
    expect([...EXPORT_REVOCATION_QUERY_FIELDS]).toEqual([]);
  });

  it('伪造自定义头不进入判定：仍只撤销会话主体本人的记录，且不影响他人记录', async () => {
    const app = await startRevokeApp();
    const forgedHeaders = {
      'x-user-id': STUDENT_2,
      'x-owner-user-id': STUDENT_2,
      'x-roles': 'super_admin,admin',
      'x-scope': 'GLOBAL',
      'x-group-id': 'g-1',
      'x-status': ExportStatus.Completed,
      'x-artifact-id': FORGED_ARTIFACT_ID,
      'x-file-url': FORGED_FILE_URL,
      'x-path': FORGED_PATH,
      'x-revoked-at': FORGED_REVOKED_AT,
      'x-request-id': FORGED_REQUEST_ID,
      'x-idempotency-key': 'forged-key',
    };

    const res = await call(app.baseUrl, 'POST', revokePath(OWN_COMPLETED_ID), {
      headers: { ...bearer(SESSION_STUDENT_1), ...forgedHeaders },
    });

    expect(res.status).toBe(200);
    expect(viewOf(res.body).status).toBe(EXPORT_VIEW_REVOKED_STATUS);
    // 撤销的是**本人**那条记录，他人记录一条都没被撤销
    const mine = await app.repository.findByIdForOwner(OWN_COMPLETED_ID, STUDENT_1);
    const other = await app.repository.findByIdForOwner(OTHER_COMPLETED_ID, STUDENT_2);
    expect(mine?.revokedAt).toBeDefined();
    expect(other?.revokedAt).toBeUndefined();
    // 伪造的撤销时刻没有进入存储
    expect(mine?.revokedAt).not.toBe(FORGED_REVOKED_AT);
    // 留痕里的 requestId 是**服务端**生成的 UUID，不是客户端跟踪 ID
    const entry = app.revocationAudit.entries()[0];
    expect(entry?.requestId).not.toBe(FORGED_REQUEST_ID);
    expect(entry?.requestId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u,
    );
    const content = contentOf(res);
    for (const leaked of [STUDENT_2, FORGED_ARTIFACT_ID, FORGED_PATH, FORGED_REQUEST_ID]) {
      expect(content).not.toContain(leaked);
    }
  });

  it('认证 401 / 越权 403：拒绝路径上一次端口调用都没有', async () => {
    const cases: ReadonlyArray<
      readonly [string, Record<string, string> | undefined, number, string]
    > = [
      ['无凭证', undefined, 401, 'UNAUTHENTICATED'],
      ['未知会话', { authorization: 'Bearer unknown-session' }, 401, 'UNAUTHENTICATED'],
      ['非 SELF 范围（负责人）', bearer(SESSION_LEADER_1), 403, 'FORBIDDEN'],
    ];

    for (const [name, headers, status, code] of cases) {
      const app = await startRevokeApp();
      const spies = spyOnPorts(app);
      const res = await call(app.baseUrl, 'POST', revokePath(OWN_PENDING_ID), {
        ...(headers === undefined ? {} : { headers }),
        body: { userId: STUDENT_2, artifactId: FORGED_ARTIFACT_ID },
      });
      expect(`${name}:${String(res.status)}:${String(res.body.error?.code)}`).toBe(
        `${name}:${String(status)}:${code}`,
      );
      expectNoPortCalls(spies);
      // 未被授权 / 未认证主体没有留下任何撤销事实
      const stored = await app.repository.findByIdForOwner(OWN_PENDING_ID, STUDENT_1);
      expect(stored?.revokedAt).toBeUndefined();
    }
  });
});

describe('导出撤销：fail-closed（500）与脱敏留痕', () => {
  it('仓储取数故障 → 500，不外发原始错误文本，且留痕仍记 unavailable', async () => {
    const app = await startRevokeApp();
    vi.spyOn(app.repository, 'findByIdForOwner').mockRejectedValue(
      new Error('connect ECONNREFUSED 127.0.0.1:55432 password=secret'),
    );

    const res = await call(app.baseUrl, 'POST', revokePath(OWN_PENDING_ID), {
      headers: bearer(SESSION_STUDENT_1),
    });
    expect(res.status).toBe(500);
    expect(res.body.error?.code).toBe('INTERNAL_ERROR');
    const content = contentOf(res);
    for (const leaked of ['ECONNREFUSED', 'password', 'secret', '127.0.0.1', 'Error']) {
      expect(content).not.toContain(leaked);
    }
    expect(app.revocationAudit.entries().at(-1)?.result).toBe(
      ExportRevocationAuditResult.Unavailable,
    );
  });

  it('撤销写入故障 → 500，且不发出「看起来成功」的响应', async () => {
    const app = await startRevokeApp();
    vi.spyOn(app.repository, 'revokeForOwner').mockRejectedValue(new Error('EXECUTOR_FAILURE'));

    const res = await call(app.baseUrl, 'POST', revokePath(OWN_PENDING_ID), {
      headers: bearer(SESSION_STUDENT_1),
    });
    expect(res.status).toBe(500);
    expect(res.body.error?.code).toBe('INTERNAL_ERROR');
    expect(res.body.error?.message ?? '').not.toContain('完整性');
    const stored = await app.repository.findByIdForOwner(OWN_PENDING_ID, STUDENT_1);
    expect(stored?.revokedAt).toBeUndefined();
  });

  it('留痕失败 → 500（不做「没有留痕的撤销成功」），但撤销时刻已经落库且重复请求幂等', async () => {
    const app = await startRevokeApp();
    const record = vi
      .spyOn(app.revocationAudit, 'record')
      .mockRejectedValueOnce(new Error('audit unavailable'));

    const res = await call(app.baseUrl, 'POST', revokePath(OWN_PENDING_ID), {
      headers: bearer(SESSION_STUDENT_1),
    });
    expect(res.status).toBe(500);
    expect(record).toHaveBeenCalledTimes(1);
    const stored = await app.repository.findByIdForOwner(OWN_PENDING_ID, STUDENT_1);
    expect(stored?.revokedAt).toBeDefined();

    // 重试：撤销时刻不变（单调事实），落进 duplicate 分支（幂等成功）
    const retry = await call(app.baseUrl, 'POST', revokePath(OWN_PENDING_ID), {
      headers: bearer(SESSION_STUDENT_1),
    });
    expect(retry.status).toBe(200);
    expect(app.revocationAudit.entries().at(-1)?.result).toBe(
      ExportRevocationAuditResult.Duplicate,
    );
  });

  it('撤销留痕条目契约是严格闭集：多出字段（body / PII / 路径 / key / 原值标识）一律拒绝', async () => {
    expect(exportRevocationAuditEntrySchema.safeParse({}).success).toBe(false);
    const valid = {
      requestId: randomUUID(),
      exportIdDigest: digestExportId(OWN_PENDING_ID),
      requesterDigest: digestRequesterId(STUDENT_1),
      result: ExportRevocationAuditResult.Success,
    };
    expect(exportRevocationAuditEntrySchema.safeParse(valid).success).toBe(true);

    for (const extra of [
      'body',
      'requestBody',
      'content',
      'bytes',
      'payload',
      'artifactId',
      'storageKey',
      'objectKey',
      'path',
      'filePath',
      'fileUrl',
      'downloadUrl',
      'signedUrl',
      'fileName',
      'ownerUserId',
      'requesterId',
      'requesterUserId',
      'userId',
      'subjectId',
      'sessionId',
      'session',
      'roles',
      'scope',
      'secret',
      'token',
      'authorization',
      'headers',
      'ip',
      'userAgent',
      'status',
      'state',
      'revokedAt',
      'expiresAt',
      'resource',
      'fields',
      'error',
    ]) {
      const parsed = parseExportRevocationAuditEntry({ ...valid, [extra]: 'leak' });
      expect(parsed.ok).toBe(false);
      if (!parsed.ok) {
        // 只给字段路径与违规类型，不回显取值
        expect(parsed.issues.some((issue) => issue.path === extra)).toBe(true);
        expect(JSON.stringify(parsed.issues)).not.toContain('leak');
      }
      expect(FORBIDDEN_EXPORT_REVOCATION_AUDIT_FIELDS).toContain(extra);
    }

    // 摘要形态与结果码是闭集：非法取值一律拒绝
    expect(parseExportRevocationAuditEntry({ ...valid, exportIdDigest: OWN_PENDING_ID }).ok).toBe(
      false,
    );
    expect(parseExportRevocationAuditEntry({ ...valid, requesterDigest: 'sha256:zz' }).ok).toBe(
      false,
    );
    expect(parseExportRevocationAuditEntry({ ...valid, result: 'failed' }).ok).toBe(false);
    expect([...EXPORT_REVOCATION_AUDIT_FIELDS]).toEqual([
      'requestId',
      'exportIdDigest',
      'requesterDigest',
      'result',
    ]);
    expect([...EXPORT_VIEW_STATUS_VALUES]).toEqual([
      ExportStatus.Pending,
      ExportStatus.Completed,
      ExportStatus.Failed,
      EXPORT_VIEW_REVOKED_STATUS,
    ]);
  });
});

describe('导出撤销：能力边界（不删除、不清产物、不新增权限点）', () => {
  it('产物存储端口上没有删除 / 清理能力，撤销路径对它的调用次数恒为 0', async () => {
    const app = await startRevokeApp();
    const spies = spyOnPorts(app);

    // 撤销三条不同形态的记录（pending / completed / failed）：产物存储一次都不被调用
    for (const id of [OWN_PENDING_ID, OWN_COMPLETED_ID, OWN_FAILED_ID]) {
      await call(app.baseUrl, 'POST', revokePath(id), { headers: bearer(SESSION_STUDENT_1) });
    }
    expect(spies.artifactStore).not.toHaveBeenCalled();
    expect(spies.artifactRead).not.toHaveBeenCalled();

    // 端口面：产物存储**没有**任何删除 / 清理入口（能力边界可机器判定）
    const store = app.artifacts as unknown as Record<string, unknown>;
    for (const method of EXPORT_ARTIFACT_STORE_FORBIDDEN_METHODS) {
      expect(store[method]).toBeUndefined();
    }
    // 仓储端口同样没有删除 / 归档入口
    const repository = app.repository as unknown as Record<string, unknown>;
    for (const method of ['delete', 'remove', 'archive', 'purge', 'truncate', 'upsert']) {
      expect(repository[method]).toBeUndefined();
    }

    expect(EXPORT_REVOCATION_CLEANUP_BOUNDARY).toEqual({
      artifactStoreCalls: 0,
      deletesRecord: false,
      cleansArtifact: false,
      deferredTo: 'async-artifact-cleanup',
    });
    // 结论闭集可机器判定（内存基线与数据库 adapter 共用同一组取值）
    expect([...EXPORT_REVOCATION_OUTCOME_VALUES]).toEqual([
      ExportRevocationOutcome.Revoked,
      ExportRevocationOutcome.AlreadyRevoked,
      ExportRevocationOutcome.NotRevocable,
    ]);
  });

  it('装配边界：撤销审计令牌与内存基线指向同一实例，且生产环境拒绝构造', async () => {
    const app = await startRevokeApp();
    const viaToken = app.app.get<InMemoryExportRevocationAuditSink>(EXPORT_REVOCATION_AUDIT);
    expect(viaToken).toBe(app.revocationAudit);
    void (await app.app.resolve(EXPORT_ARTIFACT_STORE));

    // 生产环境拒绝构造（内存基线不得承担生产留痕职责）
    expect(
      () => new InMemoryExportRevocationAuditSink(loadEnv({ NODE_ENV: 'production' })),
    ).toThrow(/生产环境禁止使用内存撤销审计出口/u);
    // 能力声明如实：非持久、不可用于生产
    expect(app.revocationAudit.capabilities).toEqual({
      backend: 'in-memory-baseline',
      persistent: false,
      productionReady: false,
    });
  });

  it('撤销不新增权限点：入口仍是 profile:self:read + SELF（与创建 / 列表 / 下载同一门控）', async () => {
    const app = await startRevokeApp();
    const res = await call(app.baseUrl, 'POST', revokePath(OWN_PENDING_ID), {
      headers: bearer(SESSION_LEADER_1),
    });
    // 负责人持有 profile:self:read 但默认范围是 GROUP：不是 500、也不是 200，而是同一个 403
    expect(res.status).toBe(403);
    expect(res.body.error?.code).toBe('FORBIDDEN');
  });
});

describe('导出撤销：内存基线与文档口径一致（同集输入 → 同集结论）', () => {
  /** 内存基线工厂：`NODE_ENV=test` 才允许构造（生产拒绝） */
  function baseline(): InMemoryExportRepository {
    return new InMemoryExportRepository(loadEnv({ NODE_ENV: 'test' }));
  }

  it('结论闭集逐格对齐：pending / completed 可撤销、重复幂等、failed 不可撤销、他人与不存在不可区分', async () => {
    const repository = baseline();
    const owner = 'u-student-1';
    const other = 'u-student-2';
    const pendingId = randomUUID();
    const completedId = randomUUID();
    const failedId = randomUUID();
    const otherId = randomUUID();
    await repository.create(
      fixtureExportRequest({
        id: pendingId,
        ownerUserId: owner,
        status: ExportStatus.Pending,
        artifactId: undefined,
      }),
    );
    await repository.create(fixtureExportRequest({ id: completedId, ownerUserId: owner }));
    await repository.create(
      fixtureExportRequest({
        id: failedId,
        ownerUserId: owner,
        status: ExportStatus.Failed,
        artifactId: undefined,
      }),
    );
    await repository.create(fixtureExportRequest({ id: otherId, ownerUserId: other }));

    const revokedAt = new Date().toISOString();
    const pending = await repository.revokeForOwner(pendingId, owner, revokedAt);
    expect(pending?.outcome).toBe(ExportRevocationOutcome.Revoked);
    expect(pending?.record.status).toBe(ExportStatus.Pending);
    expect(pending?.record.revokedAt).toBe(revokedAt);
    expect(pending?.record.updatedAt).toBe(revokedAt);

    const completed = await repository.revokeForOwner(completedId, owner, revokedAt);
    expect(completed?.outcome).toBe(ExportRevocationOutcome.Revoked);
    // 撤销不改写状态与产物句柄（completed 仍是 completed，只是被取回交付能力）
    expect(completed?.record.status).toBe(ExportStatus.Completed);
    expect(completed?.record.artifactId).toBeDefined();

    const repeat = await repository.revokeForOwner(pendingId, owner, new Date().toISOString());
    expect(repeat?.outcome).toBe(ExportRevocationOutcome.AlreadyRevoked);
    expect(repeat?.record.revokedAt).toBe(revokedAt);

    const failed = await repository.revokeForOwner(failedId, owner, revokedAt);
    expect(failed?.outcome).toBe(ExportRevocationOutcome.NotRevocable);
    expect(failed?.record.revokedAt).toBeUndefined();

    // 跨主体与不存在都返回 undefined（两者不可区分，也不泄露存在性）
    await expect(repository.revokeForOwner(completedId, other, revokedAt)).resolves.toBeUndefined();
    await expect(
      repository.revokeForOwner(randomUUID(), owner, revokedAt),
    ).resolves.toBeUndefined();
    // 他人的记录没有被跨主体请求改动
    expect((await repository.findByIdForOwner(otherId, other))?.revokedAt).toBeUndefined();
    // 记录仍然存在（不物理删除）
    expect(await repository.findByIdForOwner(completedId, owner)).toBeDefined();
  });

  it('撤销事实单调：创建不得携带撤销时刻，写回不得清空或改写它', async () => {
    const repository = baseline();
    const owner = 'u-student-1';
    const id = randomUUID();
    const record = fixtureExportRequest({
      id,
      ownerUserId: owner,
      status: ExportStatus.Pending,
      artifactId: undefined,
    });

    // 1) 创建路径不接受撤销时刻（「一出生就已被取回」是一条没有发生过的事实）
    await expect(
      repository.create({ ...record, revokedAt: new Date().toISOString() }),
    ).rejects.toThrow(/创建路径不接受撤销时刻/u);

    await repository.create(record);
    const revokedAt = new Date().toISOString();
    await repository.revokeForOwner(id, owner, revokedAt);

    // 2) 写回不得把已有的撤销时刻换成别的值（用明显不同的时刻，避免与毫秒截断撞车）
    const stored = await repository.findByIdForOwner(id, owner);
    await expect(
      repository.save({
        ...(stored as ExportRequest),
        revokedAt: new Date(Date.parse(revokedAt) + 60_000).toISOString(),
      }),
    ).rejects.toThrow(/撤销时刻不可改写/u);

    // 3) 写回**不得清空**撤销事实（并发完成的快照往往是在撤销之前读到的）
    const completed = await repository.save({
      ...record,
      status: ExportStatus.Completed,
      artifactId: randomUUID(),
    });
    expect(completed.revokedAt).toBe(revokedAt);
    expect(completed.status).toBe(ExportStatus.Completed);
  });
});

describe('导出撤销：纯函数与公开契约（含迁移边界）', () => {
  const now = Date.parse('2026-06-01T00:00:00.000Z');
  const future = '2026-07-01T00:00:00.000Z';
  const past = '2026-05-02T00:00:00.000Z';
  const repoRoot = findRepoRoot(process.cwd());

  it('可撤销判定：pending / completed 可撤销；failed 与已过期不可撤销；已撤销优先（幂等）', () => {
    expect(classifyExportRevocation({ status: ExportStatus.Pending, expiresAt: future }, now)).toBe(
      ExportRevocationVerdict.Revocable,
    );
    expect(
      classifyExportRevocation({ status: ExportStatus.Completed, expiresAt: future }, now),
    ).toBe(ExportRevocationVerdict.Revocable);
    expect(classifyExportRevocation({ status: ExportStatus.Failed, expiresAt: future }, now)).toBe(
      ExportRevocationVerdict.Unavailable,
    );
    expect(classifyExportRevocation({ status: ExportStatus.Completed, expiresAt: past }, now)).toBe(
      ExportRevocationVerdict.Unavailable,
    );
    // 缺省有效期 = fail-closed（与下载同一条口径：绝不解释成「永不过期」）
    expect(classifyExportRevocation({ status: ExportStatus.Completed }, now)).toBe(
      ExportRevocationVerdict.Unavailable,
    );
    // 已撤销优先：即使已过期 / 已失败，重复请求仍是幂等成功
    expect(
      classifyExportRevocation(
        { status: ExportStatus.Completed, expiresAt: past, revokedAt: past },
        now,
      ),
    ).toBe(ExportRevocationVerdict.AlreadyRevoked);
    expect(
      classifyExportRevocation(
        { status: ExportStatus.Failed, expiresAt: future, revokedAt: past },
        now,
      ),
    ).toBe(ExportRevocationVerdict.AlreadyRevoked);
    // 边界时刻判为过期（半开区间）
    expect(
      classifyExportRevocation(
        { status: ExportStatus.Completed, expiresAt: new Date(now).toISOString() },
        now,
      ),
    ).toBe(ExportRevocationVerdict.Unavailable);
  });

  it('视图契约：撤销时刻派生为 revoked 状态，且视图字段一个都不新增', () => {
    const completed = fixtureExportRequest({ id: OWN_COMPLETED_ID });
    const parsed = parseStoredExportRequest(completed);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(toExportRequestView(parsed.value).status).toBe(ExportStatus.Completed);

    const revoked = parseStoredExportRequest({ ...completed, revokedAt: past });
    expect(revoked.ok).toBe(true);
    if (!revoked.ok) return;
    const view = toExportRequestView(revoked.value);
    expect(view.status).toBe(EXPORT_VIEW_REVOKED_STATUS);
    // 视图仍然是既有闭集：不含归属 / 产物句柄 / 有效期 / 撤销时刻
    expect(Object.keys(view).sort()).toEqual([...EXPORT_REQUEST_VIEW_FIELDS].sort());
    expect(exportRequestViewSchema.safeParse(view).success).toBe(true);
    expect(exportRequestViewSchema.safeParse({ ...view, revokedAt: past }).success).toBe(false);
    expect(exportRequestViewSchema.safeParse({ ...view, ownerUserId: STUDENT_1 }).success).toBe(
      false,
    );
    expect(exportRequestViewSchema.safeParse({ ...view, status: 'deleted' }).success).toBe(false);
  });

  it('读取契约：撤销时刻必须是 UTC ISO；`failed` 结论不得携带撤销时刻', () => {
    const failed = fixtureExportRequest({
      id: OWN_FAILED_ID,
      status: ExportStatus.Failed,
      artifactId: undefined,
    });
    const withRevocation = parseStoredExportRequest({ ...failed, revokedAt: past });
    expect(withRevocation.ok).toBe(false);
    if (!withRevocation.ok) {
      expect(withRevocation.issues.some((issue) => issue.path === 'revokedAt')).toBe(true);
    }
    // 非 UTC ISO / 本地时间形态一律拒绝
    for (const bad of ['2026-05-01 00:00:00', '2026-05-01T00:00:00+08:00', 'yesterday', 42, null]) {
      expect(parseStoredExportRequest({ ...fixtureExportRequest(), revokedAt: bad }).ok).toBe(
        false,
      );
    }
    // 合法形态（UTC Z）通过，且 `pending` / `completed` 都可以携带撤销时刻
    for (const status of [ExportStatus.Pending, ExportStatus.Completed]) {
      const job = fixtureExportRequest({
        status,
        ...(status === ExportStatus.Pending ? { artifactId: undefined } : {}),
      });
      expect(parseStoredExportRequest({ ...job, revokedAt: past }).ok).toBe(true);
    }
  });

  it('撤销请求体闭集门禁：无输入 / 非对象体不报错，服务端字段与未声明字段原因可区分', () => {
    for (const body of [undefined, null, {}, 'text', 42, []]) {
      expect(() => assertDeclaredExportRevocationRequestFields(body)).not.toThrow();
    }
    const forbidden = [
      'userId',
      'ownerId',
      'ownerUserId',
      'artifactId',
      'path',
      'filePath',
      'fileUrl',
      'storageKey',
      'status',
      'revokedAt',
      'revoked_at',
      'revocation',
      'revoke',
      'expiresAt',
      'createdAt',
    ];
    for (const key of forbidden) {
      let captured: unknown;
      try {
        assertDeclaredExportRevocationRequestFields({ [key]: 'value' });
      } catch (error) {
        captured = error;
      }
      expect(captured).toBeInstanceOf(ZodError);
      const error = captured as ZodError;
      expect(error.issues[0]?.path).toEqual([key]);
      expect(error.issues[0]?.message).toContain('禁止设置服务端字段');
      expect(FORBIDDEN_EXPORT_REVOCATION_REQUEST_FIELDS).toContain(key);
    }
    // 未声明字段：可区分的原因，且回显的只有**键名**
    let unknownField: unknown;
    try {
      assertDeclaredExportRevocationRequestFields({ whatever: 'secret-value' });
    } catch (error) {
      unknownField = error;
    }
    expect(unknownField).toBeInstanceOf(ZodError);
    expect((unknownField as ZodError).issues[0]?.message).toContain('请求体包含未声明字段');
    expect(JSON.stringify((unknownField as ZodError).issues)).not.toContain('secret-value');
  });

  it('路径参数契约与摘要口径：UUID 形态、单向摘要、两个摘要同一套前缀', () => {
    expect(exportRevokeIdSchema.safeParse(OWN_PENDING_ID).success).toBe(true);
    for (const bad of ['', 'not-a-uuid', 42, null, '../../etc/passwd']) {
      expect(exportRevokeIdSchema.safeParse(bad).success).toBe(false);
    }
    expect(digestExportId(OWN_PENDING_ID)).toMatch(EXPORT_AUDIT_DIGEST_PATTERN);
    expect(digestRequesterId(STUDENT_1)).toMatch(EXPORT_AUDIT_DIGEST_PATTERN);
    // 确定性 + 单向：非字符串按空串处理，长度固定，原值不出现
    expect(digestRequesterId(STUDENT_1)).toBe(digestRequesterId(STUDENT_1));
    expect(digestRequesterId(STUDENT_1)).not.toBe(digestRequesterId(STUDENT_2));
    expect(digestRequesterId(STUDENT_1)).not.toContain(STUDENT_1);
    expect(digestRequesterId(undefined)).toBe(digestRequesterId(''));
    expect(digestExportId(OWN_PENDING_ID).slice(0, 7)).toBe('sha256:');
  });

  it('迁移 0016：真的加出 revoked_at 列与两条约束，且不改写 0013 已钉住的 CHECK', () => {
    const migration = readFileSync(
      resolve(repoRoot, 'db', 'migrations', '0016_export_jobs_revocation.sql'),
      'utf8',
    );
    // 真的加列（不是只在注释里声明），且类型是 timestamptz、可空、无 DEFAULT
    const addColumn = /ADD\s+COLUMN\s+IF\s+NOT\s+EXISTS\s+revoked_at[^;]*/iu.exec(migration)?.[0];
    expect(addColumn).toBeDefined();
    expect(addColumn).toMatch(/revoked_at\s+timestamptz/iu);
    expect(addColumn).not.toMatch(/\bNOT\s+NULL\b/iu);
    expect(addColumn).not.toMatch(/\bDEFAULT\b/iu);
    // 两条必要约束：撤销只落在可撤销结论上 + 撤销时刻不早于创建时刻
    expect(migration).toContain('ADD CONSTRAINT export_jobs_revoked_at_matches_status');
    expect(migration).toMatch(
      /CHECK \(revoked_at IS NULL OR status IN \('pending', 'completed'\)\)/u,
    );
    expect(migration).toContain('ADD CONSTRAINT export_jobs_revoked_at_after_created_at');
    expect(migration).toMatch(/CHECK \(revoked_at IS NULL OR revoked_at >= created_at\)/u);
    // 0013 的两条 CHECK 逐字不变（撤销不是第四个 status 取值）
    for (const pinned of ['export_jobs_status_check', 'export_jobs_artifact_matches_status']) {
      expect(migration).not.toMatch(
        new RegExp(`(?:ADD|DROP)\\s+CONSTRAINT\\s+(?:IF\\s+EXISTS\\s+)?${pinned}\\b`, 'iu'),
      );
    }
    // 加列迁移不建表、不建索引；回滚方式登记在头部（可被集成测试提取后演练）
    expect(migration).not.toMatch(/CREATE\s+TABLE\b/iu);
    expect(migration).not.toMatch(/CREATE\s+(?:UNIQUE\s+)?INDEX\b/iu);
    expect(migration).toMatch(
      /ALTER\s+TABLE\s+export_jobs\s+DROP\s+COLUMN\s+IF\s+EXISTS\s+revoked_at/iu,
    );
    // 迁移头部字段齐备（CN 分节与 lint 口径一致）
    for (const header of ['-- migration:', '-- description:', '-- reversible:']) {
      expect(migration).toContain(header);
    }
    // 列清单与迁移列名一致 + 撤销声明为「不进公开视图」
    expect([...POSTGRES_EXPORT_REVOKE_COLUMNS]).toEqual(['revoked_at', 'updated_at']);
    expect([...POSTGRES_EXPORT_COLUMNS]).toContain('revoked_at');
  });
});

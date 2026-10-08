import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AiErrorCode } from '@rm/ai-adapter';
import {
  MATCHING_REQUEST_ENTRY_STATUS,
  MATCHING_REQUEST_STATUS_VALUES,
  MatchingRequestStatus,
} from '@rm/shared';
import type { MatchingRecommendationItem } from '@rm/shared';
import type {
  PersistenceCapabilities,
  SqlExecutor,
  SqlQueryResult,
} from '../../db/ports/sql-executor.port';
import {
  MATCHING_REQUEST_VIEW_FIELDS,
  parseStoredMatchingRequest,
  toMatchingRequestView,
} from './matching.contract';
import { InMemoryMatchingRepository } from './matching.in-memory-repository';
import {
  MATCHING_REPOSITORY_BACKEND_POSTGRES,
  MATCHING_REPOSITORY_STORAGE_ID_DOMAIN,
} from './matching.port';
import type {
  AsyncMatchingRepository,
  MatchingAccessScope,
  MatchingRepository,
  MatchingRepositoryCapabilities,
  MatchingRequest,
} from './matching.port';
import {
  POSTGRES_MATCHING_AI_BOUNDARY_COLUMNS,
  POSTGRES_MATCHING_BOOKKEEPING_COLUMNS,
  POSTGRES_MATCHING_COLUMN_FIELDS,
  POSTGRES_MATCHING_COLUMNS,
  POSTGRES_MATCHING_FIELD_COLUMNS,
  POSTGRES_MATCHING_FORBIDDEN_SQL_KEYWORDS,
  POSTGRES_MATCHING_IMMUTABLE_COLUMNS,
  POSTGRES_MATCHING_INTERNAL_COLUMNS,
  POSTGRES_MATCHING_INTERNAL_SCORE_COLUMNS,
  POSTGRES_MATCHING_OWNER_COLUMNS,
  POSTGRES_MATCHING_PII_COLUMNS,
  POSTGRES_MATCHING_REQUEST_FIELDS,
  POSTGRES_MATCHING_REPOSITORY_CAPABILITIES,
  POSTGRES_MATCHING_REPOSITORY_VERIFICATION_STEPS,
  POSTGRES_MATCHING_REVIEW_COLUMNS,
  POSTGRES_MATCHING_TABLE,
  POSTGRES_MATCHING_VIEW_EXCLUDED_COLUMNS,
  POSTGRES_MATCHING_WRITABLE_STATEMENTS,
  PostgresMatchingRepository,
  PostgresMatchingRepositoryError,
  assertMatchingAccessScope,
  assertMatchingInternalColumnsAbsent,
  assertMatchingViewExclusion,
  assertPostgresMatchingRepositoryCapabilities,
  findMatchingInternalColumnOverlaps,
  findMatchingViewExclusionLeaks,
} from './matching.postgres-repository';

/**
 * 匹配记录（`ai_match_records`）的 PostgreSQL 仓储 adapter 的**离线**验收
 * （不连数据库、不引驱动）。
 *
 * 覆盖用户要求的补充安全契约测试与交付边界：
 * - **能力与交付边界**：`persistent = true` / `productionReady = false`（未真实驱动验证前严禁
 *   生产）、`ai_match_records` 尚未落草案 / 迁移、adapter 未被装配到 `MatchingModule`、
 *   不引驱动 / ORM、同步端口未被改成异步、内存 provider 未被切换；
 * - **参数化 SQL 与固定标识符**：值只出现在参数里，SQL 文本只由模块常量构成；语句只可能是
 *   `INSERT` / `UPDATE` / `SELECT`；`UPDATE` 的 `SET` 列不含不可变列（`id` / `user_id` /
 *   `created_at`）；
 * - **SQL 注入**：主体、记录 ID 与小组标识的注入载荷要么只进参数、要么在进入 SQL 之前被拒绝
 *   （拒绝路径**一个 SQL 都不执行**）；
 * - **严格行契约 / 未知列 / 字段污染**：未登记列、缺列、未知状态、未知降级码、推荐条目里的
 *   未登记键、超长推荐列表一律 fail-closed；
 * - **状态与降级结果闭集**：四个状态只接受闭集；`completed` 必须有推荐、其余状态必须为空；
 *   非降级结果不得携带降级码；
 * - **服务端 subject 归属边界**：归属下推进 SQL，他人记录既不出库也不得回流；覆盖写入未命中
 *   统一为 `UPDATE_MISSING`（不区分「不存在」与「不是你的」）；记录身份与创建时间不可改写；
 * - **group 授权边界**：记录里的推荐一旦出现服务端已授权集合之外的小组（他人小组），读 / 写
 *   都 fail-closed，且**不静默过滤**；空集合不等于「不过滤」；
 * - **AI 输入最小化 / 去标识化**：只接受脱敏输入的 sha256 摘要，原始特征 / 提示词 / 模型 payload
 *   既不能写入也不能读出；
 * - **公开结果不泄露**：返回记录不含 snake_case 列名，公开视图不含 `userId`、快照摘要、原始模型
 *   payload、PII、内部评分与审核字段；所有失败路径的错误信息与 `issues` 只含字段路径与违规类型；
 *   执行器异常收敛为不含原始文本的 `EXECUTOR_FAILURE`。
 */

/** 从当前工作目录向上寻找仓库根（含 pnpm-workspace.yaml） */
function findRepoRoot(start: string): string {
  let current = resolve(start);
  for (let depth = 0; depth < 8; depth += 1) {
    if (existsSync(join(current, 'pnpm-workspace.yaml'))) {
      return current;
    }
    const parent = dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }
  throw new Error('未找到仓库根目录（缺少 pnpm-workspace.yaml）');
}

const REPO_ROOT = findRepoRoot(process.cwd());
const MATCHING_DIR = resolve(process.cwd(), 'src', 'modules', 'matching');
const ADAPTER_PATH = resolve(MATCHING_DIR, 'matching.postgres-repository.ts');
const PORT_PATH = resolve(MATCHING_DIR, 'matching.port.ts');
const MODULE_PATH = resolve(MATCHING_DIR, 'matching.module.ts');
const IN_MEMORY_PATH = resolve(MATCHING_DIR, 'matching.in-memory-repository.ts');
const ADAPTER_CLASS = 'PostgresMatchingRepository';
const ADAPTER_MODULE = 'matching.postgres-repository';

interface RecordedCall {
  readonly sql: string;
  readonly parameters: readonly unknown[] | undefined;
}

/**
 * 记录型假执行器：只记录 SQL 与参数、按预设顺序返回结果，不连数据库。
 *
 * 能力声明刻意写成「postgres + persistent」：adapter 会拒绝非持久后端（内存替身），
 * 因此替身必须如实声明自己代表的是持久化 PostgreSQL。
 */
class RecordingExecutor implements SqlExecutor {
  capabilities: PersistenceCapabilities = {
    backend: 'postgres-test-double',
    persistent: true,
    productionReady: false,
  };

  readonly calls: RecordedCall[] = [];
  private readonly responses: unknown[];

  constructor(responses: unknown[] = []) {
    this.responses = [...responses];
  }

  query<Row = Record<string, unknown>>(
    sql: string,
    parameters?: readonly unknown[],
  ): Promise<SqlQueryResult<Row>> {
    this.calls.push({ sql, parameters });
    const next = (
      this.responses.length > 0 ? this.responses.shift() : { rows: [], rowCount: 0 }
    ) as SqlQueryResult<Row>;
    return Promise.resolve(next);
  }
}

/** 抛出型执行器：用于验证「驱动异常不把原始错误文本带出去」 */
class ThrowingExecutor implements SqlExecutor {
  capabilities: PersistenceCapabilities = {
    backend: 'postgres-test-double',
    persistent: true,
    productionReady: false,
  };

  constructor(private readonly failure: unknown) {}

  query<Row = Record<string, unknown>>(
    _sql: string,
    _parameters?: readonly unknown[],
  ): Promise<SqlQueryResult<Row>> {
    return Promise.reject(this.failure);
  }
}

const REQUEST_ID = '11111111-1111-4111-8111-111111111111';
/** 含十六进制字母的记录 ID：用于验证「规范小写形」约束（纯数字 ID 无法体现大小写差异） */
const HEX_REQUEST_ID = 'a1b2c3d4-e5f6-4789-8abc-def012345679';
const OTHER_REQUEST_ID = '33333333-3333-4333-8333-333333333333';
const OWNER_ID = '22222222-2222-4222-8222-222222222222';
const OTHER_OWNER_ID = '44444444-4444-4444-8444-444444444444';
/** 含十六进制字母的 UUID：用于验证「规范小写形」约束（纯数字 UUID 无法体现大小写差异） */
const HEX_OWNER_ID = 'a1b2c3d4-e5f6-4789-8abc-def012345678';
const HEX_OWNER_UPPER = 'A1B2C3D4-E5F6-4789-8ABC-DEF012345678';
const GROUP_ID = '55555555-5555-4555-8555-555555555555';
/** 含十六进制字母的小组 ID：同样用于「规范小写形」约束 */
const HEX_GROUP_ID = 'a1b2c3d4-e5f6-4789-8abc-def012345670';
const OTHER_GROUP_ID = '66666666-6666-4666-8666-666666666666';
const NIL_UUID = '00000000-0000-0000-0000-000000000000';
/** 会话基线的安全 ID 形：合法读取契约形态，但**不在**存储 ID 域内 */
const SESSION_SUBJECT = 'u-student-1';
const HASH = 'a1'.repeat(32);
const ISO = '2026-01-02T03:04:05.000Z';
const LATER = '2026-01-02T04:05:06.000Z';

/** 注入载荷：只允许出现在参数里，绝不允许出现在 SQL 文本或错误信息里 */
const INJECTION = "x'); DROP TABLE ai_match_records; --";
/** 推荐理由 / 建议原文：用户可读，但绝不允许出现在错误信息与日志里 */
const REASON_TEXT = '与你的意向方向数据要素流通一致；已具备要求技能 TypeScript';
const ADVICE_TEXT = '建议先与负责人沟通例会时间，并补齐缺失技能';
/** 提示词与模型原始 payload：属内部处理记录，绝不允许外发（写入时也不允许夹带） */
const PROMPT_TEXT = 'system: 你是匹配助手，请只输出 JSON';
const RAW_PAYLOAD = '{"recommendations":[{"groupId":"leaked","rawScore":99}]}';
/** 画像原始字段名与联系方式：绝不允许外发 */
const PHONE = '13800138000';
const STUDENT_NO = '2023010101';
const FULL_NAME = '张三';
/** 内部评分明细与审核字段：绝不允许外发 */
const INTERNAL_SCORE_DETAIL = 'direction*45+skill*25=88';
const REVIEW_NOTE = '内部审核意见：推荐结果存疑，需复核';

/** 服务端授权边界：主体 + 已授权小组集合（本集合**不含** OTHER_GROUP_ID） */
const SCOPE: MatchingAccessScope = { ownerUserId: OWNER_ID, authorizedGroupIds: [GROUP_ID] };

const RECOMMENDATION: MatchingRecommendationItem = {
  groupId: GROUP_ID,
  score: 88,
  reason: REASON_TEXT,
  advice: ADVICE_TEXT,
};

/** 入口记录（`pending`）：推荐必须为空，降级码尚未产生 */
const PENDING: MatchingRequest = {
  id: REQUEST_ID,
  userId: OWNER_ID,
  status: MATCHING_REQUEST_ENTRY_STATUS,
  profileVersion: 3,
  inputSnapshotHash: HASH,
  recommendations: [],
  modelVersion: 'rule-fallback-v1',
  promptVersion: 'match-prompt-v1',
  fallbackUsed: true,
  createdAt: ISO,
  updatedAt: ISO,
};

/** 规则降级终态：`fallbackUsed = true` 且携带闭集内的降级码 */
const COMPLETED_FALLBACK: MatchingRequest = {
  ...PENDING,
  status: MatchingRequestStatus.Completed,
  recommendations: [RECOMMENDATION],
  degradationCode: AiErrorCode.Disabled,
  updatedAt: LATER,
};

/** 模型成功终态：`fallbackUsed = false`，因此**不得**携带降级码 */
const COMPLETED_AI: MatchingRequest = {
  ...PENDING,
  id: OTHER_REQUEST_ID,
  status: MatchingRequestStatus.Completed,
  recommendations: [RECOMMENDATION],
  fallbackUsed: false,
  modelVersion: 'ds-v4.1-flash',
};

/** 数据库行（snake_case）：默认与给定记录等价 */
function rowFromRecord(
  record: MatchingRequest,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: record.id,
    user_id: record.userId,
    status: record.status,
    profile_version: record.profileVersion ?? null,
    input_snapshot_hash: record.inputSnapshotHash,
    recommendations: record.recommendations.map((item) => ({ ...item })),
    model_version: record.modelVersion,
    prompt_version: record.promptVersion,
    fallback_used: record.fallbackUsed,
    degradation_code: record.degradationCode ?? null,
    created_at: new Date(record.createdAt),
    updated_at: new Date(record.updatedAt),
    ...overrides,
  };
}

/** 移除某一列，用于「缺列」用例 */
function withoutRowColumn(record: MatchingRequest, column: string): Record<string, unknown> {
  const row = rowFromRecord(record);
  delete row[column];
  return row;
}

/** 用给定响应构造 adapter（响应按调用顺序消费） */
function repoWith(...responses: unknown[]): {
  repository: PostgresMatchingRepository;
  executor: RecordingExecutor;
} {
  const executor = new RecordingExecutor(responses);
  return { repository: new PostgresMatchingRepository(executor), executor };
}

async function captureRepoError(
  run: () => Promise<unknown>,
): Promise<PostgresMatchingRepositoryError> {
  let captured: unknown;
  try {
    await run();
  } catch (error) {
    captured = error;
  }
  expect(captured).toBeInstanceOf(PostgresMatchingRepositoryError);
  return captured as PostgresMatchingRepositoryError;
}

function captureSyncError(run: () => unknown): PostgresMatchingRepositoryError {
  let captured: unknown;
  try {
    run();
  } catch (error) {
    captured = error;
  }
  expect(captured).toBeInstanceOf(PostgresMatchingRepositoryError);
  return captured as PostgresMatchingRepositoryError;
}

/**
 * 断言 `issues` 里存在指向某个字段路径的违规（`issues` 的形状是 `字段路径(违规类型)`，
 * 违规类型取决于 zod 的 issue code，因此只固定「指向哪个字段」，不把违规类型写死；
 * adapter 自有的判定只给出裸字段路径，因此裸路径同样算命中）。
 */
function expectIssueOn(error: PostgresMatchingRepositoryError, path: string): void {
  expect(error.issues.some((issue) => issue === path || issue.startsWith(`${path}(`))).toBe(true);
}

/** SQL 里出现的占位符序号（去重升序），用于断言「占位符数量 === 参数数量」 */
function placeholderIndexes(sql: string): number[] {
  return [...new Set([...sql.matchAll(/\$(\d+)/gu)].map((match) => Number(match[1])))].sort(
    (left, right) => left - right,
  );
}

/** 投一次调用并拿到它记录的 SQL / 参数（调用序列里第 n 条） */
function callAt(executor: RecordingExecutor, index: number): RecordedCall | undefined {
  return executor.calls[index];
}

/** 单词边界命中（避免 `id` 命中 `user_id`、`version` 命中 `profile_version` 之类） */
function containsWord(sql: string, word: string): boolean {
  return new RegExp(`\\b${word}\\b`, 'u').test(sql);
}

/**
 * 语句卫生：只由模块常量与 `$n` 占位符构成。
 *
 * 没有单引号 / 双引号 ⇒ 语句里不存在字符串字面量（因此没有「值 → SQL 文本」的注入面）；
 * 没有分号 / `--` ⇒ 不存在语句拼接与注释截断；没有 `*` ⇒ 始终显式列清单；
 * 占位符从 `$1` 连续编号 ⇒ 数量与参数一一对应。
 */
function expectParameterizedSql(sql: string): void {
  expect(sql).not.toContain("'");
  expect(sql).not.toContain('"');
  expect(sql).not.toContain(';');
  expect(sql).not.toContain('--');
  expect(sql).not.toContain('*');
  for (const keyword of POSTGRES_MATCHING_FORBIDDEN_SQL_KEYWORDS) {
    expect(containsWord(sql, keyword)).toBe(false);
  }
  expect(
    POSTGRES_MATCHING_WRITABLE_STATEMENTS.some((statement) => containsWord(sql, statement)),
  ).toBe(true);
  const placeholders = placeholderIndexes(sql);
  expect(placeholders.length).toBeGreaterThan(0);
  for (const [offset, value] of placeholders.entries()) {
    expect(value).toBe(offset + 1);
  }
}

/** camelCase 期望值：用于证明「列 → 字段」只有 `user_id → userId` 一处非同名映射 */
function camelCase(column: string): string {
  return column.replace(/_([a-z0-9])/gu, (_match, char: string) => char.toUpperCase());
}

/** 失败路径的信息卫生断言：错误信息与 issues 都不含任何取值 */
function expectNoValueLeak(error: PostgresMatchingRepositoryError): void {
  const text = `${error.message} ${error.issues.join(' ')}`;
  for (const forbidden of [
    REQUEST_ID,
    OTHER_REQUEST_ID,
    OWNER_ID,
    OTHER_OWNER_ID,
    HEX_OWNER_ID,
    HEX_OWNER_UPPER,
    GROUP_ID,
    OTHER_GROUP_ID,
    NIL_UUID,
    SESSION_SUBJECT,
    INJECTION,
    REASON_TEXT,
    ADVICE_TEXT,
    PROMPT_TEXT,
    RAW_PAYLOAD,
    PHONE,
    STUDENT_NO,
    FULL_NAME,
    INTERNAL_SCORE_DETAIL,
    REVIEW_NOTE,
  ]) {
    expect(text).not.toContain(forbidden);
  }
  // 冒号与等号意味着「键=值」形态的回显（issues 只允许 `字段路径(违规类型)`）
  expect(error.issues.every((issue) => !issue.includes(':') && !issue.includes('='))).toBe(true);
}

/** 从源码里抽取 import / require 的模块说明符 */
function moduleSpecifiersOf(source: string): string[] {
  return [
    ...source.matchAll(/from\s+['"]([^'"]+)['"]/gu),
    ...source.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/gu),
  ].map((match) => match[1] ?? '');
}

/** 读取仓库内文件（相对 services/api） */
function readApiFile(relative: string): string {
  return readFileSync(resolve(process.cwd(), relative), 'utf8');
}

describe('PostgreSQL 匹配仓储：能力声明、字段闭集与交付边界', () => {
  it('能力声明恰好是 postgres / persistent=true / productionReady=false，且被冻结', () => {
    expect(POSTGRES_MATCHING_REPOSITORY_CAPABILITIES).toEqual({
      backend: 'postgres',
      persistent: true,
      productionReady: false,
    });
    expect(MATCHING_REPOSITORY_BACKEND_POSTGRES).toBe('postgres');
    expect(Object.isFrozen(POSTGRES_MATCHING_REPOSITORY_CAPABILITIES)).toBe(true);
  });

  it('验证清单覆盖「驱动 → 集成 → 草案转迁移 → 异步端口 → UUID 收敛 → 内部列复核 → 才可声明生产」', () => {
    expect(POSTGRES_MATCHING_REPOSITORY_VERIFICATION_STEPS).toEqual([
      'driver-dependency-evaluated',
      'integration-tests-against-real-postgres',
      'ai-match-records-schema-draft-created-and-promoted-to-migration',
      'matching-repository-port-migrated-to-async',
      'session-subject-and-recommendation-group-ids-converged-to-uuid',
      'internal-columns-not-projected-verified-against-real-queries',
      'production-ready-capability-flipped-with-evidence',
    ]);
  });

  it('自检放行当前声明，但拒绝「未验证就声称生产可用」', () => {
    expect(() => assertPostgresMatchingRepositoryCapabilities()).not.toThrow();

    const promoted = captureSyncError(() =>
      assertPostgresMatchingRepositoryCapabilities({
        backend: 'postgres',
        persistent: true,
        productionReady: true,
      }),
    );
    expect(promoted.code).toBe('CAPABILITY_MISDECLARED');
    expect(promoted.message).toContain('不得声称生产可用');
    expect(promoted.issues).toContain('productionReady');
    expectNoValueLeak(promoted);

    const nonPersistent = captureSyncError(() =>
      assertPostgresMatchingRepositoryCapabilities({
        backend: 'postgres',
        persistent: false,
        productionReady: false,
      }),
    );
    expect(nonPersistent.issues).toContain('persistent');

    for (const backend of ['mysql', 'postgres-draft', 'in-memory-baseline', '']) {
      const misdeclared = captureSyncError(() =>
        assertPostgresMatchingRepositoryCapabilities({
          backend,
          persistent: true,
          productionReady: false,
        }),
      );
      expect(misdeclared.issues).toContain('backend');
    }
  });

  it('表名是字段字典里的 ai_match_records，且列清单与读取契约字段构成双射', () => {
    expect(POSTGRES_MATCHING_TABLE).toBe('ai_match_records');
    expect(MATCHING_REPOSITORY_STORAGE_ID_DOMAIN).toBe('uuid');

    expect(Object.keys(POSTGRES_MATCHING_COLUMN_FIELDS)).toEqual([...POSTGRES_MATCHING_COLUMNS]);
    expect(Object.keys(POSTGRES_MATCHING_FIELD_COLUMNS)).toEqual([
      ...POSTGRES_MATCHING_REQUEST_FIELDS,
    ]);
    expect(Object.keys(POSTGRES_MATCHING_FIELD_COLUMNS)).toHaveLength(
      POSTGRES_MATCHING_COLUMNS.length,
    );
    expect(POSTGRES_MATCHING_COLUMNS.every((column) => /^[a-z][a-z0-9_]*$/u.test(column))).toBe(
      true,
    );

    // 列名一律映射到它的驼峰形（端口把归属命名为 userId，而不是 ownerUserId：
    // 因此本 adapter 只有 user_id 这一处需要显式声明，且它与驼峰形一致）
    for (const column of POSTGRES_MATCHING_COLUMNS) {
      expect(POSTGRES_MATCHING_COLUMN_FIELDS[column]).toBe(camelCase(column));
    }
    expect(POSTGRES_MATCHING_COLUMN_FIELDS.user_id).toBe('userId');
    expect(POSTGRES_MATCHING_FIELD_COLUMNS.userId).toBe('user_id');
  });

  it('归属列、不可变列与存储记录字段闭集都有明确清单', () => {
    expect(POSTGRES_MATCHING_OWNER_COLUMNS).toEqual(['user_id']);
    expect(POSTGRES_MATCHING_IMMUTABLE_COLUMNS).toEqual(['id', 'user_id', 'created_at']);
    for (const column of POSTGRES_MATCHING_IMMUTABLE_COLUMNS) {
      expect(POSTGRES_MATCHING_COLUMNS).toContain(column);
    }
    expect(POSTGRES_MATCHING_REQUEST_FIELDS).toContain('userId');
    expect(POSTGRES_MATCHING_REQUEST_FIELDS).toContain('inputSnapshotHash');
    // 入口态常量来自共享状态机，adapter 不另抄一份字面量
    expect(MATCHING_REQUEST_ENTRY_STATUS).toBe(MatchingRequestStatus.Pending);
    expect(PENDING.status).toBe(MATCHING_REQUEST_ENTRY_STATUS);
    // 归属与快照摘要都在存储记录上（service 需要归属复核），但不进入公开视图
    expect(MATCHING_REQUEST_VIEW_FIELDS).not.toContain('userId');
    expect(MATCHING_REQUEST_VIEW_FIELDS).not.toContain('inputSnapshotHash');
  });

  it('内部列 = AI 边界 + PII + 内部评分 + 审核 + 簿记，且与列清单零交集', () => {
    expect([...POSTGRES_MATCHING_INTERNAL_COLUMNS]).toEqual([
      ...POSTGRES_MATCHING_AI_BOUNDARY_COLUMNS,
      ...POSTGRES_MATCHING_PII_COLUMNS,
      ...POSTGRES_MATCHING_INTERNAL_SCORE_COLUMNS,
      ...POSTGRES_MATCHING_REVIEW_COLUMNS,
      ...POSTGRES_MATCHING_BOOKKEEPING_COLUMNS,
    ]);
    expect(findMatchingInternalColumnOverlaps()).toEqual([]);
    expect(() => assertMatchingInternalColumnsAbsent()).not.toThrow();

    // 探针：一旦内部列被写进列清单，加载期自检与探针都会 fail-closed
    for (const leak of [
      ['internal_score'],
      ['review_status'],
      ['raw_response'],
      ['phone'],
      ['model_payload'],
    ]) {
      expect(findMatchingInternalColumnOverlaps(leak)).toEqual(leak);
      const error = captureSyncError(() => assertMatchingInternalColumnsAbsent(leak));
      expect(error.code).toBe('CAPABILITY_MISDECLARED');
      expect(error.issues).toEqual(leak);
      expectNoValueLeak(error);
    }
  });

  it('公开输出裁剪列覆盖归属、快照摘要与全部内部列，且不含公开视图字段', () => {
    for (const column of [
      'user_id',
      'input_snapshot_hash',
      ...POSTGRES_MATCHING_INTERNAL_COLUMNS,
    ]) {
      expect(POSTGRES_MATCHING_VIEW_EXCLUDED_COLUMNS).toContain(column);
    }
    expect(findMatchingViewExclusionLeaks(MATCHING_REQUEST_VIEW_FIELDS)).toEqual([]);
    expect(() => assertMatchingViewExclusion(MATCHING_REQUEST_VIEW_FIELDS)).not.toThrow();

    // 探针：把归属 / 快照摘要 / 原始 payload / PII / 内部评分 / 审核字段写进视图白名单即泄漏
    for (const [probe, expected] of [
      [['status', 'userId'], ['userId']],
      [['inputSnapshotHash'], ['inputSnapshotHash']],
      [['internalScore'], ['internalScore']],
      [['reviewNote'], ['reviewNote']],
      [['rawResponse'], ['rawResponse']],
      [['phone'], ['phone']],
      [['modelPayload'], ['modelPayload']],
      [['user_id'], ['user_id']],
    ] as const) {
      const leaks = findMatchingViewExclusionLeaks(probe);
      expect(leaks).toEqual([...expected]);
      const error = captureSyncError(() => assertMatchingViewExclusion(probe));
      expect(error.code).toBe('CAPABILITY_MISDECLARED');
      expectNoValueLeak(error);
    }
  });

  it('端口已新增并存的异步契约与后端标识，同步端口签名一字未改', () => {
    const source = readFileSync(PORT_PATH, 'utf8');
    expect(source).toContain('export interface AsyncMatchingRepository {');
    expect(source).toContain('export const MATCHING_REPOSITORY_BACKEND_POSTGRES');
    expect(source).toContain('export const MATCHING_REPOSITORY_STORAGE_ID_DOMAIN');
    expect(source).toContain('export interface MatchingAccessScope {');

    // 同步端口（当前运行时绑定）不得被改成异步
    const syncPort = source.slice(
      source.indexOf('export interface MatchingRepository {'),
      source.indexOf('export interface AsyncMatchingRepository {'),
    );
    expect(syncPort).not.toContain(': Promise');
    expect(syncPort).toContain('create(request: MatchingRequest): MatchingRequest;');
    expect(syncPort).toContain('listByUserId(userId: string): readonly MatchingRequest[];');

    // 异步契约：四个方法都要求携带服务端授权边界
    const asyncPort = source.slice(source.indexOf('export interface AsyncMatchingRepository {'));
    expect(asyncPort).toContain('create(request: MatchingRequest, scope: MatchingAccessScope)');
    expect(asyncPort).toContain('save(request: MatchingRequest, scope: MatchingAccessScope)');
    expect(asyncPort).toContain(
      'findById(requestId: string, scope: MatchingAccessScope): Promise<MatchingRequest | undefined>;',
    );
    expect(asyncPort).toContain('listByUserId(scope: MatchingAccessScope)');
    expect(asyncPort).toContain('Promise<MatchingRequest>');
    expect(asyncPort).toContain('Promise<MatchingRequest | undefined>');
    expect(asyncPort).toContain('Promise<readonly MatchingRequest[]>');
  });

  it('adapter 的公开面覆盖能力、验证清单、列清单、内部列与裁剪事实（供上层与运维机器判定）', () => {
    const source = readFileSync(ADAPTER_PATH, 'utf8');
    for (const exported of [
      'POSTGRES_MATCHING_TABLE',
      'POSTGRES_MATCHING_COLUMNS',
      'POSTGRES_MATCHING_COLUMN_FIELDS',
      'POSTGRES_MATCHING_FIELD_COLUMNS',
      'POSTGRES_MATCHING_REQUEST_FIELDS',
      'POSTGRES_MATCHING_OWNER_COLUMNS',
      'POSTGRES_MATCHING_IMMUTABLE_COLUMNS',
      'POSTGRES_MATCHING_AI_BOUNDARY_COLUMNS',
      'POSTGRES_MATCHING_PII_COLUMNS',
      'POSTGRES_MATCHING_INTERNAL_SCORE_COLUMNS',
      'POSTGRES_MATCHING_REVIEW_COLUMNS',
      'POSTGRES_MATCHING_BOOKKEEPING_COLUMNS',
      'POSTGRES_MATCHING_INTERNAL_COLUMNS',
      'POSTGRES_MATCHING_VIEW_EXCLUDED_COLUMNS',
      'POSTGRES_MATCHING_WRITABLE_STATEMENTS',
      'POSTGRES_MATCHING_FORBIDDEN_SQL_KEYWORDS',
      'POSTGRES_MATCHING_REPOSITORY_CAPABILITIES',
      'POSTGRES_MATCHING_REPOSITORY_VERIFICATION_STEPS',
    ]) {
      expect(source).toContain(`export const ${exported}`);
    }
    expect(source).toContain(`export class ${ADAPTER_CLASS}`);
    expect(source).toContain(`export class ${ADAPTER_CLASS}Error`);
    expect(source).toContain('export function assertPostgresMatchingRepositoryCapabilities');
    expect(source).toContain('export function assertMatchingAccessScope');
    expect(source).toContain('export function findMatchingViewExclusionLeaks');
    expect(source).toContain('export function assertMatchingViewExclusion');
    expect(source).toContain('export function findMatchingInternalColumnOverlaps');
    expect(source).toContain('export function assertMatchingInternalColumnsAbsent');
    expect(source).toContain('export function assertPostgresMatchingSql');
    expect(source).toContain('export type PostgresMatchingRepositoryErrorCode');

    // 语句模板：四条，且首个关键字分别是 INSERT / UPDATE / SELECT
    const templates = [...source.matchAll(/const (\w+_SQL) = `(\w+)/gu)].map(
      (match) => `${match[1] ?? ''}:${match[2] ?? ''}`,
    );
    expect(templates).toEqual([
      'INSERT_SQL:INSERT',
      'UPDATE_SQL:UPDATE',
      'SELECT_BY_ID_FOR_OWNER_SQL:SELECT',
      'SELECT_BY_OWNER_SQL:SELECT',
    ]);

    // 反引号里的 SQL 文本（真正会被执行的内容）不得出现任何被禁关键字与内部列
    const sqlTexts = [...source.matchAll(/const \w+_SQL = `([^`]*)`/gu)].map(
      (match) => match[1] ?? '',
    );
    expect(sqlTexts).toHaveLength(4);
    for (const sql of sqlTexts) {
      for (const keyword of POSTGRES_MATCHING_FORBIDDEN_SQL_KEYWORDS) {
        expect(containsWord(sql, keyword)).toBe(false);
      }
      for (const internal of POSTGRES_MATCHING_INTERNAL_COLUMNS) {
        expect(containsWord(sql, internal)).toBe(false);
      }
    }
  });
});

describe('PostgreSQL 匹配仓储：构造与调用 fail-closed', () => {
  it('没有执行器 / 执行器缺 query / 缺能力声明 → 构造即拒绝，且不执行任何 SQL', () => {
    const cases: readonly unknown[] = [
      undefined,
      null,
      'postgres://user:pass@host/db',
      {},
      { query: () => Promise.resolve({ rows: [], rowCount: 0 }) },
      { query: () => Promise.resolve({ rows: [], rowCount: 0 }), capabilities: null },
      { query: () => Promise.resolve({ rows: [], rowCount: 0 }), capabilities: {} },
    ];
    for (const executor of cases) {
      const error = captureSyncError(
        () => new PostgresMatchingRepository(executor as unknown as SqlExecutor),
      );
      expect(error.code).toBe('EXECUTOR_UNAVAILABLE');
      expectNoValueLeak(error);
    }

    const executor = new RecordingExecutor([{ rows: [rowFromRecord(PENDING)], rowCount: 1 }]);
    new PostgresMatchingRepository(executor);
    expect(executor.calls).toHaveLength(0);
  });

  it('执行器声明的后端不是 PostgreSQL → 拒绝（不得把 adapter 挂到其他存储上）', () => {
    for (const backend of ['sqlite', 'in-memory-baseline', 'mysql', 'sqlserver']) {
      const executor = new RecordingExecutor();
      executor.capabilities = { backend, persistent: true, productionReady: true };
      const error = captureSyncError(() => new PostgresMatchingRepository(executor));
      expect(error.code).toBe('EXECUTOR_NOT_POSTGRES');
      expect(executor.calls).toHaveLength(0);
      expectNoValueLeak(error);
    }
  });

  it('执行器声明为非持久后端（内存替身）→ 拒绝', () => {
    const executor = new RecordingExecutor();
    executor.capabilities = {
      backend: 'postgres-test-double',
      persistent: false,
      productionReady: false,
    };
    const error = captureSyncError(() => new PostgresMatchingRepository(executor));
    expect(error.code).toBe('EXECUTOR_NOT_PERSISTENT');
    expect(executor.calls).toHaveLength(0);
    expectNoValueLeak(error);
  });

  it('构造后执行器被降级为非持久 → 下一次调用 fail-closed，且不再访问 SQL', async () => {
    const { repository, executor } = repoWith({
      rows: [rowFromRecord(COMPLETED_FALLBACK)],
      rowCount: 1,
    });
    executor.capabilities = {
      backend: 'postgres-test-double',
      persistent: false,
      productionReady: false,
    };
    const error = await captureRepoError(() => repository.findById(COMPLETED_FALLBACK.id, SCOPE));
    expect(error.code).toBe('EXECUTOR_NOT_PERSISTENT');
    expect(executor.calls).toHaveLength(0);
    expectNoValueLeak(error);
  });

  it('构造后能力声明被改写为「生产可用」→ 每次调用都 fail-closed（自检不被绕过）', async () => {
    const { repository, executor } = repoWith({
      rows: [rowFromRecord(PENDING)],
      rowCount: 1,
    });
    (repository as { capabilities: MatchingRepositoryCapabilities }).capabilities = {
      backend: 'postgres',
      persistent: true,
      productionReady: true,
    };

    const error = await captureRepoError(() => repository.listByUserId(SCOPE));
    expect(error.code).toBe('CAPABILITY_MISDECLARED');
    expect(error.message).toContain('不得声称生产可用');
    expect(executor.calls).toHaveLength(0);
    expectNoValueLeak(error);
  });

  it('执行结果形状非法（非对象 / 缺 rows 数组）→ INVALID_ROW，不静默当成「无记录」', async () => {
    for (const response of [null, 'rows', { rowCount: 0 }, { rows: null }, { rows: {} }]) {
      const { repository } = repoWith(response);
      const error = await captureRepoError(() => repository.listByUserId(SCOPE));
      expect(error.code).toBe('INVALID_ROW');
      expectNoValueLeak(error);
    }
  });

  it('执行器异常（含同步抛出）收敛为 EXECUTOR_FAILURE：原始文本与 cause 都不外发', async () => {
    const failure = new Error(`connect failed: postgres://user:${PHONE}@host/${RAW_PAYLOAD}`);
    for (const executor of [new ThrowingExecutor(failure), new ThrowingExecutor(INJECTION)]) {
      const repository = new PostgresMatchingRepository(executor);
      const error = await captureRepoError(() => repository.listByUserId(SCOPE));
      expect(error.code).toBe('EXECUTOR_FAILURE');
      expect(error.message).not.toContain(PHONE);
      expect(error.message).not.toContain(RAW_PAYLOAD);
      expect(error.message).not.toContain(INJECTION);
      expect((error as { cause?: unknown }).cause).toBeUndefined();
      expectNoValueLeak(error);
    }
  });

  it('实现的是异步仓储契约（Promise 语义），且不是 Nest provider', () => {
    const { repository } = repoWith({ rows: [rowFromRecord(PENDING)], rowCount: 1 });
    const adapter: AsyncMatchingRepository = repository;
    expect(adapter.capabilities).toEqual(POSTGRES_MATCHING_REPOSITORY_CAPABILITIES);
    expect(repository.create(PENDING, SCOPE)).toBeInstanceOf(Promise);

    const source = readFileSync(ADAPTER_PATH, 'utf8');
    expect(source).not.toMatch(/@Injectable\s*\(/u);
    expect(source).not.toMatch(/@Inject\s*\(/u);
    expect(source).not.toContain('Symbol(');
  });
});

describe('PostgreSQL 匹配仓储：参数化 SQL、固定标识符与显式字段映射', () => {
  it('写入入口记录使用占位符绑定：SQL 只由常量与 $n 组成，参数按列顺序传入', async () => {
    const { repository, executor } = repoWith({
      rows: [rowFromRecord(PENDING)],
      rowCount: 1,
    });

    const created = await repository.create(PENDING, SCOPE);

    const call = callAt(executor, 0);
    const sql = call?.sql ?? '';
    expect(sql).toContain(`INSERT INTO ${POSTGRES_MATCHING_TABLE} (`);
    expect(sql).toContain('ON CONFLICT (id) DO NOTHING');
    expect(sql).toContain('RETURNING');
    expect(sql).toContain(POSTGRES_MATCHING_COLUMNS.join(', '));
    expect(sql).not.toContain('SELECT *');
    expect(placeholderIndexes(sql)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    expect(call?.parameters).toHaveLength(POSTGRES_MATCHING_COLUMNS.length);
    expect(call?.parameters).toEqual([
      PENDING.id,
      PENDING.userId,
      PENDING.status,
      PENDING.profileVersion,
      PENDING.inputSnapshotHash,
      '[]',
      PENDING.modelVersion,
      PENDING.promptVersion,
      true,
      null,
      PENDING.createdAt,
      PENDING.updatedAt,
    ]);

    // 领域对象的值只出现在参数里；SQL 文本里一个都不出现
    for (const value of [PENDING.id, PENDING.userId, PENDING.modelVersion]) {
      expect(sql).not.toContain(String(value));
    }
    expect(created).toEqual(PENDING);
    expect(created).not.toHaveProperty('user_id');
    expect(created).not.toHaveProperty('input_snapshot_hash');
    expectParameterizedSql(sql);
  });

  it('推荐结果以 JSON 文本按四字段白名单序列化绑定（不依赖驱动隐式编码，也不夹带多余键）', async () => {
    const { repository, executor } = repoWith({
      rows: [rowFromRecord(COMPLETED_FALLBACK)],
      rowCount: 1,
    });

    const saved = await repository.save(COMPLETED_FALLBACK, SCOPE);

    const call = callAt(executor, 0);
    const serialized = call?.parameters?.[5];
    expect(typeof serialized).toBe('string');
    expect(JSON.parse(serialized as string)).toEqual([
      {
        groupId: RECOMMENDATION.groupId,
        score: RECOMMENDATION.score,
        reason: RECOMMENDATION.reason,
        advice: RECOMMENDATION.advice,
      },
    ]);
    expect(call?.sql).toContain('recommendations = $6::jsonb');
    expect(saved).toEqual(COMPLETED_FALLBACK);
    // 非降级结果不得携带降级码；降级结果必须原样保留闭集内的降级码
    expect(saved.degradationCode).toBe(AiErrorCode.Disabled);
    expect(
      POSTGRES_MATCHING_AI_BOUNDARY_COLUMNS.some((column) => containsWord(call?.sql ?? '', column)),
    ).toBe(false);
  });

  it('覆盖写入把归属下推进 SQL，且 SET 列不含不可变列（id / user_id / created_at）', async () => {
    const { repository, executor } = repoWith({
      rows: [rowFromRecord(COMPLETED_FALLBACK)],
      rowCount: 1,
    });

    await repository.save(COMPLETED_FALLBACK, SCOPE);

    const call = callAt(executor, 0);
    const sql = call?.sql ?? '';
    expect(sql).toContain(`UPDATE ${POSTGRES_MATCHING_TABLE} SET`);
    expect(sql).toContain('WHERE id = $1::uuid AND user_id = $2::uuid');
    // SET 子句里不得出现任何不可变列（身份与创建时间只能由 INSERT 写入）
    const setClause = sql.slice(sql.indexOf('SET') + 3, sql.indexOf('WHERE'));
    for (const column of POSTGRES_MATCHING_IMMUTABLE_COLUMNS) {
      expect(new RegExp(`\\b${column}\\s*=`, 'u').test(setClause)).toBe(false);
    }
    expect(setClause).toContain('updated_at = $11::timestamptz');
    expect(placeholderIndexes(sql)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    expect(call?.parameters).toEqual([
      COMPLETED_FALLBACK.id,
      COMPLETED_FALLBACK.userId,
      COMPLETED_FALLBACK.status,
      COMPLETED_FALLBACK.profileVersion,
      COMPLETED_FALLBACK.inputSnapshotHash,
      JSON.stringify([
        {
          groupId: RECOMMENDATION.groupId,
          score: RECOMMENDATION.score,
          reason: RECOMMENDATION.reason,
          advice: RECOMMENDATION.advice,
        },
      ]),
      COMPLETED_FALLBACK.modelVersion,
      COMPLETED_FALLBACK.promptVersion,
      COMPLETED_FALLBACK.fallbackUsed,
      COMPLETED_FALLBACK.degradationCode,
      COMPLETED_FALLBACK.updatedAt,
    ]);
    expectParameterizedSql(sql);
  });

  it('单条取数把归属下推进 SQL；列表取数只按主体绑定且排序下推', async () => {
    const { repository, executor } = repoWith(
      { rows: [rowFromRecord(COMPLETED_FALLBACK)], rowCount: 1 },
      { rows: [rowFromRecord(COMPLETED_FALLBACK)], rowCount: 1 },
    );

    const found = await repository.findById(COMPLETED_FALLBACK.id, SCOPE);
    const listed = await repository.listByUserId(SCOPE);

    expect(found).toEqual(COMPLETED_FALLBACK);
    expect(listed).toEqual([COMPLETED_FALLBACK]);

    const byId = callAt(executor, 0);
    expect(byId?.sql).toContain(`FROM ${POSTGRES_MATCHING_TABLE}`);
    expect(byId?.sql).toContain('WHERE id = $1::uuid AND user_id = $2::uuid');
    expect(byId?.parameters).toEqual([COMPLETED_FALLBACK.id, OWNER_ID]);
    expect(placeholderIndexes(byId?.sql ?? '')).toEqual([1, 2]);

    const byOwner = callAt(executor, 1);
    expect(byOwner?.sql).toContain('WHERE user_id = $1::uuid');
    expect(byOwner?.sql).toContain('ORDER BY created_at ASC, id ASC');
    expect(byOwner?.parameters).toEqual([OWNER_ID]);
    expect(placeholderIndexes(byOwner?.sql ?? '')).toEqual([1]);

    for (const call of executor.calls) {
      expectParameterizedSql(call.sql);
      expect(call.sql).toContain(POSTGRES_MATCHING_COLUMNS.join(', '));
      expect(call.sql).not.toContain('SELECT *');
      expect(placeholderIndexes(call.sql)).toHaveLength(call.parameters?.length ?? 0);
    }
  });

  it('四条语句的 SQL 文本里不出现任何存储侧内部列（原始 payload / PII / 内部评分 / 审核）', async () => {
    const { repository, executor } = repoWith(
      { rows: [rowFromRecord(PENDING)], rowCount: 1 },
      { rows: [rowFromRecord(COMPLETED_FALLBACK)], rowCount: 1 },
      { rows: [rowFromRecord(COMPLETED_FALLBACK)], rowCount: 1 },
      { rows: [rowFromRecord(COMPLETED_FALLBACK)], rowCount: 1 },
    );

    await repository.create(PENDING, SCOPE);
    await repository.save(COMPLETED_FALLBACK, SCOPE);
    await repository.findById(COMPLETED_FALLBACK.id, SCOPE);
    await repository.listByUserId(SCOPE);

    expect(executor.calls).toHaveLength(4);
    for (const call of executor.calls) {
      for (const internal of POSTGRES_MATCHING_INTERNAL_COLUMNS) {
        expect(containsWord(call.sql, internal)).toBe(false);
      }
      expect(call.sql).not.toContain('*');
    }
  });

  it('每次调用都返回新对象（不把数据库行或驱动持有的数组交给调用方）', async () => {
    const driverRecommendations = [{ ...RECOMMENDATION }];
    const { repository } = repoWith(
      {
        rows: [rowFromRecord(COMPLETED_FALLBACK, { recommendations: driverRecommendations })],
        rowCount: 1,
      },
      {
        rows: [rowFromRecord(COMPLETED_FALLBACK, { recommendations: driverRecommendations })],
        rowCount: 1,
      },
    );

    const first = await repository.findById(COMPLETED_FALLBACK.id, SCOPE);
    const second = await repository.findById(COMPLETED_FALLBACK.id, SCOPE);

    expect(first).not.toBe(second);
    expect(first?.recommendations).not.toBe(second?.recommendations);
    expect(first?.recommendations[0]).not.toBe(driverRecommendations[0]);
    expect(first).toEqual(second);
  });
});

describe('PostgreSQL 匹配仓储：SQL 注入防线与授权边界形状', () => {
  it('文本字段里的注入载荷只进参数，SQL 文本与正常输入逐字节相同', async () => {
    const benign = new RecordingExecutor([
      { rows: [rowFromRecord(COMPLETED_FALLBACK)], rowCount: 1 },
    ]);
    const malicious = new RecordingExecutor([
      { rows: [rowFromRecord(COMPLETED_FALLBACK)], rowCount: 1 },
    ]);

    await new PostgresMatchingRepository(benign).save(COMPLETED_FALLBACK, SCOPE);
    await new PostgresMatchingRepository(malicious).save(
      {
        ...COMPLETED_FALLBACK,
        recommendations: [{ ...RECOMMENDATION, reason: INJECTION, advice: INJECTION }],
      },
      SCOPE,
    );

    const maliciousCall = malicious.calls[0];
    expect(maliciousCall?.sql).toEqual(benign.calls[0]?.sql);
    expect(maliciousCall?.sql).not.toContain('DROP TABLE');
    expect(maliciousCall?.sql).not.toContain('--');
    const bound = JSON.parse(String(maliciousCall?.parameters?.[5])) as readonly {
      readonly reason: string;
    }[];
    expect(bound[0]?.reason).toBe(INJECTION);
  });

  it('记录 ID / 主体 / 小组标识不是规范 UUID 时在进入 SQL 之前就被拒绝', async () => {
    const { repository, executor } = repoWith();

    for (const requestId of [
      `${REQUEST_ID}' OR 1=1 --`,
      "1' OR '1'='1",
      HEX_REQUEST_ID.toUpperCase(),
      REQUEST_ID.replace(/-/gu, ''),
      NIL_UUID,
      SESSION_SUBJECT,
      '',
    ]) {
      const error = await captureRepoError(() => repository.findById(requestId, SCOPE));
      expect(error.code).toBe('INVALID_RECORD_ID');
      expectNoValueLeak(error);
    }

    for (const ownerUserId of [
      `${OWNER_ID}' OR 1=1 --`,
      HEX_OWNER_UPPER,
      NIL_UUID,
      SESSION_SUBJECT,
      '',
      42,
    ] as readonly unknown[]) {
      const error = await captureRepoError(() =>
        repository.listByUserId({
          ownerUserId,
          authorizedGroupIds: [],
        } as unknown as MatchingAccessScope),
      );
      expect(error.code).toBe('INVALID_SUBJECT');
      expectNoValueLeak(error);
    }

    for (const groupId of [`${GROUP_ID}' OR 1=1 --`, HEX_GROUP_ID.toUpperCase(), NIL_UUID, 'g-1']) {
      const error = await captureRepoError(() =>
        repository.listByUserId({ ownerUserId: OWNER_ID, authorizedGroupIds: [groupId] }),
      );
      expect(error.code).toBe('INVALID_SCOPE');
      expectIssueOn(error, 'authorizedGroupIds.0');
      expectNoValueLeak(error);
    }

    // 拒绝路径一个 SQL 都不执行
    expect(executor.calls).toHaveLength(0);
  });

  it('授权边界形状异常（非对象 / 缺主体 / 非数组 / 闭集外字段）→ 拒绝且不访问数据库', async () => {
    const { repository, executor } = repoWith();

    for (const scope of [
      null,
      'scope',
      [],
      {},
      { ownerUserId: OWNER_ID },
      { ownerUserId: OWNER_ID, authorizedGroupIds: 'g-1' },
      { ownerUserId: OWNER_ID, authorizedGroupIds: [123] },
      { ownerUserId: OWNER_ID, authorizedGroupIds: [], roles: ['admin'] },
      { ownerUserId: OWNER_ID, authorizedGroupIds: [], scope: 'GLOBAL' },
    ]) {
      const error = await captureRepoError(() =>
        repository.listByUserId(
          scope as unknown as Parameters<PostgresMatchingRepository['listByUserId']>[0],
        ),
      );
      expect(['INVALID_SCOPE', 'INVALID_SUBJECT']).toContain(error.code);
      expectNoValueLeak(error);
    }
    expect(executor.calls).toHaveLength(0);
  });

  it('授权边界校验按集合语义去重，并给出只含路径的结果', () => {
    expect(assertMatchingAccessScope(SCOPE)).toEqual({
      ownerUserId: OWNER_ID,
      authorizedGroupIds: [GROUP_ID],
    });
    expect(
      assertMatchingAccessScope({
        ownerUserId: HEX_OWNER_ID,
        authorizedGroupIds: [GROUP_ID, GROUP_ID, OTHER_GROUP_ID],
      }),
    ).toEqual({
      ownerUserId: HEX_OWNER_ID,
      authorizedGroupIds: [GROUP_ID, OTHER_GROUP_ID],
    });

    const extra = captureSyncError(() =>
      assertMatchingAccessScope({
        ownerUserId: OWNER_ID,
        authorizedGroupIds: [],
        dataScope: 'SELF',
      } as unknown as MatchingAccessScope),
    );
    expect(extra.code).toBe('INVALID_SCOPE');
    expect(extra.issues).toEqual(['dataScope(unexpected)']);
    expectNoValueLeak(extra);
  });

  it('表名与列清单只由模块常量构成，且都是裸标识符', () => {
    expect(POSTGRES_MATCHING_WRITABLE_STATEMENTS).toEqual(['INSERT', 'UPDATE', 'SELECT']);
    expect(POSTGRES_MATCHING_FORBIDDEN_SQL_KEYWORDS).toContain('DELETE');
    expect(POSTGRES_MATCHING_FORBIDDEN_SQL_KEYWORDS).toContain('DROP');
    expect(POSTGRES_MATCHING_FORBIDDEN_SQL_KEYWORDS).not.toContain('UPDATE');
    expect(POSTGRES_MATCHING_FORBIDDEN_SQL_KEYWORDS).not.toContain('SELECT');
  });
});

describe('PostgreSQL 匹配仓储：严格行契约、未知列与字段污染', () => {
  it('数据库返回未登记列 → 整行拒绝（不静默丢弃，也不带进结果）', async () => {
    for (const extra of [
      { raw_response: RAW_PAYLOAD },
      { model_payload: RAW_PAYLOAD },
      { prompt_text: PROMPT_TEXT },
      { internal_score: 99 },
      { review_status: 'approved' },
      { phone: PHONE },
      { student_no: STUDENT_NO },
      { name: FULL_NAME },
      { deleted_at: null },
      { idempotency_key: 'idem-1' },
    ]) {
      const { repository } = repoWith({ rows: [rowFromRecord(PENDING, extra)], rowCount: 1 });
      const error = await captureRepoError(() => repository.listByUserId(SCOPE));
      expect(error.code).toBe('INVALID_ROW');
      const [column] = Object.keys(extra);
      expect(error.issues.join(',')).toContain(`${column}(unexpected)`);
      expectNoValueLeak(error);
    }
  });

  it('缺列同样 fail-closed（PG 对 SELECT 列表中的列一定返回键，缺键说明驱动或 SQL 被改动）', async () => {
    for (const column of POSTGRES_MATCHING_COLUMNS) {
      const { repository } = repoWith({
        rows: [withoutRowColumn(PENDING, column)],
        rowCount: 1,
      });
      const error = await captureRepoError(() => repository.listByUserId(SCOPE));
      expect(error.code).toBe('INVALID_ROW');
      expectIssueOn(error, column);
    }
  });

  it('推荐条目里的未登记键（原始模型 payload / 内部评分）→ 拒绝而不是静默丢弃', async () => {
    for (const polluted of [
      { ...RECOMMENDATION, rawScore: 99 },
      { ...RECOMMENDATION, modelReasoning: 'internal' },
      { ...RECOMMENDATION, internalScore: 99 },
      { ...RECOMMENDATION, reviewNote: REVIEW_NOTE },
    ]) {
      const { repository, executor } = repoWith({
        rows: [rowFromRecord(COMPLETED_FALLBACK, { recommendations: [polluted] })],
        rowCount: 1,
      });
      const error = await captureRepoError(() => repository.listByUserId(SCOPE));
      expect(error.code).toBe('INVALID_ROW');
      const extraKey = Object.keys(polluted).find(
        (key) => !['groupId', 'score', 'reason', 'advice'].includes(key),
      );
      expect(error.issues.join(',')).toContain(`recommendations.0.${extraKey}(unexpected)`);
      expectNoValueLeak(error);
      expect(executor.calls).toHaveLength(1);
    }
  });

  it('推荐列表形状非法（超长 / 非数组 / 空值 / 不可解析的 jsonb 文本）→ 拒绝', async () => {
    const tooMany = [RECOMMENDATION, RECOMMENDATION, RECOMMENDATION, RECOMMENDATION].map(
      (item, index) => ({ ...item, groupId: `55555555-5555-4555-8555-55555555555${index}` }),
    );
    for (const recommendations of [
      tooMany,
      'not-an-array',
      null,
      { groupId: GROUP_ID },
      '{not-json',
      42,
    ]) {
      const { repository } = repoWith({
        rows: [rowFromRecord(COMPLETED_FALLBACK, { recommendations })],
        rowCount: 1,
      });
      const error = await captureRepoError(() => repository.listByUserId(SCOPE));
      expect(error.code).toBe('INVALID_ROW');
      expectNoValueLeak(error);
    }
  });

  it('jsonb 推荐结果以文本返回时由 adapter 自己解析（往返等价），且条目顺序不被重排', async () => {
    const second = {
      ...RECOMMENDATION,
      groupId: OTHER_GROUP_ID,
      score: 70,
      reason: '方向标签重合有限，该组方向为科研伦理',
    };
    const { repository } = repoWith({
      rows: [
        rowFromRecord(COMPLETED_FALLBACK, {
          recommendations: JSON.stringify([RECOMMENDATION, second]),
        }),
      ],
      rowCount: 1,
    });

    const listed = await repository.listByUserId({
      ownerUserId: OWNER_ID,
      authorizedGroupIds: [GROUP_ID, OTHER_GROUP_ID],
    });
    expect(listed[0]?.recommendations.map((item) => item.groupId)).toEqual([
      GROUP_ID,
      OTHER_GROUP_ID,
    ]);
  });

  it('非法枚举 / 坏摘要 / 坏时间戳 / 坏形状一律拒绝（未知取值不得当作合法值输出）', async () => {
    const poisoned = [
      rowFromRecord(PENDING, { status: 'archived' }),
      rowFromRecord(PENDING, { status: 'OPEN' }),
      rowFromRecord(PENDING, { status: null }),
      rowFromRecord(PENDING, { degradation_code: 'AI_UNKNOWN_CODE' }),
      rowFromRecord(PENDING, { degradation_code: 7 }),
      rowFromRecord(PENDING, { input_snapshot_hash: HASH.toUpperCase() }),
      rowFromRecord(PENDING, { input_snapshot_hash: HASH.slice(0, 63) }),
      rowFromRecord(PENDING, { input_snapshot_hash: null }),
      rowFromRecord(PENDING, { profile_version: 0 }),
      rowFromRecord(PENDING, { profile_version: 1.5 }),
      rowFromRecord(PENDING, { profile_version: '3' }),
      rowFromRecord(PENDING, { fallback_used: 'true' }),
      rowFromRecord(PENDING, { fallback_used: null }),
      rowFromRecord(PENDING, { id: 'nope' }),
      rowFromRecord(PENDING, { user_id: 'nope' }),
      rowFromRecord(PENDING, { model_version: '' }),
      rowFromRecord(PENDING, { model_version: 'x'.repeat(65) }),
      rowFromRecord(PENDING, { prompt_version: null }),
      rowFromRecord(PENDING, { created_at: 'not-a-date' }),
      rowFromRecord(PENDING, { created_at: '2026-13-45T99:99:99Z' }),
      rowFromRecord(PENDING, { updated_at: null }),
    ];

    for (const row of poisoned) {
      const { repository } = repoWith({ rows: [row], rowCount: 1 });
      const error = await captureRepoError(() => repository.listByUserId(SCOPE));
      expect(error.code).toBe('INVALID_ROW');
      expectNoValueLeak(error);
    }
  });

  it('行内的归属必须落在存储 ID 域（规范小写、非空 UUID）', async () => {
    for (const user_id of [HEX_OWNER_UPPER, NIL_UUID, SESSION_SUBJECT, '']) {
      const { repository } = repoWith({
        rows: [rowFromRecord(PENDING, { user_id })],
        rowCount: 1,
      });
      const error = await captureRepoError(() => repository.listByUserId(SCOPE));
      expect(error.code).toBe('INVALID_ROW');
      expectIssueOn(error, 'user_id');
    }
    // 规范小写形（含十六进制字母）可往返
    const { repository } = repoWith({
      rows: [rowFromRecord({ ...PENDING, userId: HEX_OWNER_ID })],
      rowCount: 1,
    });
    const listed = await repository.listByUserId({
      ownerUserId: HEX_OWNER_ID,
      authorizedGroupIds: [],
    });
    expect(listed[0]?.userId).toBe(HEX_OWNER_ID);
  });

  it('写路径字段污染（内部 / 服务端独占字段）→ INVALID_RECORD，且不写库', async () => {
    const { repository, executor } = repoWith();

    for (const polluted of [
      { ...PENDING, modelPayload: RAW_PAYLOAD },
      { ...PENDING, rawResponse: RAW_PAYLOAD },
      { ...PENDING, promptText: PROMPT_TEXT },
      { ...PENDING, features: { grade: '大二' } },
      { ...PENDING, internalScore: 99 },
      { ...PENDING, reviewStatus: 'approved' },
      { ...PENDING, ownerUserId: OTHER_OWNER_ID },
      { ...PENDING, roles: ['admin'] },
      { ...PENDING, scope: 'GLOBAL' },
      { ...PENDING, userId2: OTHER_OWNER_ID },
    ]) {
      const error = await captureRepoError(() => repository.create(polluted, SCOPE));
      expect(error.code).toBe('INVALID_RECORD');
      const [extraKey] = Object.keys(polluted).filter((key) => !(key in PENDING));
      expect(error.issues.join(',')).toContain(`${extraKey}(unexpected)`);
      expectNoValueLeak(error);
    }
    expect(executor.calls).toHaveLength(0);
  });
});

describe('PostgreSQL 匹配仓储：状态与降级结果闭集', () => {
  it('四个状态闭集全部可往返（completed 携带推荐、其余为空）', async () => {
    const records: readonly MatchingRequest[] = [
      PENDING,
      COMPLETED_FALLBACK,
      {
        ...PENDING,
        status: MatchingRequestStatus.NoCandidate,
        degradationCode: AiErrorCode.NoCandidate,
      },
      {
        ...PENDING,
        status: MatchingRequestStatus.Failed,
        degradationCode: AiErrorCode.ProviderError,
      },
      COMPLETED_AI,
    ];
    expect(MATCHING_REQUEST_STATUS_VALUES).toHaveLength(4);

    const { repository, executor } = repoWith(
      ...records.map((record) => ({ rows: [rowFromRecord(record)], rowCount: 1 })),
    );
    for (const record of records) {
      const scope =
        record.recommendations.length > 0
          ? SCOPE
          : { ownerUserId: OWNER_ID, authorizedGroupIds: [] };
      const found = await repository.findById(record.id, scope);
      expect(found).toEqual(record);
    }
    expect(executor.calls).toHaveLength(records.length);
  });

  it('状态与条数必须自洽：completed 无推荐 / 非 completed 带推荐都拒绝', async () => {
    const inconsistent = [
      rowFromRecord({ ...COMPLETED_FALLBACK, recommendations: [] }),
      rowFromRecord({ ...PENDING, recommendations: [RECOMMENDATION] }),
      rowFromRecord({
        ...PENDING,
        status: MatchingRequestStatus.NoCandidate,
        recommendations: [RECOMMENDATION],
      }),
      rowFromRecord({
        ...PENDING,
        status: MatchingRequestStatus.Failed,
        recommendations: [RECOMMENDATION],
      }),
    ];
    for (const row of inconsistent) {
      const { repository } = repoWith({ rows: [row], rowCount: 1 });
      const error = await captureRepoError(() => repository.listByUserId(SCOPE));
      expect(error.code).toBe('INVALID_ROW');
      expect(error.issues.join(',')).toContain('recommendations');
      expectNoValueLeak(error);
    }
  });

  it('降级结果自洽：非降级结果不得携带降级码（降级结果可以为空，入口态就是如此）', async () => {
    const inconsistent = rowFromRecord({
      ...COMPLETED_AI,
      recommendations: [RECOMMENDATION],
      degradationCode: AiErrorCode.ProviderError,
    });
    const { repository } = repoWith({ rows: [inconsistent], rowCount: 1 });
    const error = await captureRepoError(() => repository.listByUserId(SCOPE));
    expect(error.code).toBe('INVALID_ROW');
    expect(error.issues).toContain('degradationCode');
    expectNoValueLeak(error);

    // 入口态合法：fallbackUsed = true 且没有降级码
    const { repository: entryRepo } = repoWith({ rows: [rowFromRecord(PENDING)], rowCount: 1 });
    await expect(entryRepo.listByUserId(SCOPE)).resolves.toEqual([PENDING]);

    // 同一条不变量在写路径同样生效：模型成功（未降级）的结果不得携带降级码
    const { repository: writeRepo, executor } = repoWith();
    const writeError = await captureRepoError(() =>
      writeRepo.save({ ...COMPLETED_AI, degradationCode: AiErrorCode.Disabled }, SCOPE),
    );
    expect(writeError.code).toBe('INVALID_RECORD');
    expect(writeError.issues).toContain('degradationCode');
    expectNoValueLeak(writeError);
    expect(executor.calls).toHaveLength(0);
  });

  it('同一条记录的推荐结果出现重复小组 → 拒绝（上游已禁止重复推荐）', async () => {
    const { repository } = repoWith({
      rows: [
        rowFromRecord(COMPLETED_FALLBACK, {
          recommendations: [RECOMMENDATION, { ...RECOMMENDATION }],
        }),
      ],
      rowCount: 1,
    });
    const error = await captureRepoError(() => repository.listByUserId(SCOPE));
    expect(error.code).toBe('INVALID_ROW');
    expect(error.issues).toContain('recommendations.1.groupId');
    expectNoValueLeak(error);
  });

  it('create 只接受入口态：终态记录必须在进入 SQL 之前被拒绝', async () => {
    const { repository, executor } = repoWith();
    for (const terminal of [
      {
        ...PENDING,
        status: MatchingRequestStatus.Completed,
        recommendations: [RECOMMENDATION],
      },
      {
        ...PENDING,
        status: MatchingRequestStatus.NoCandidate,
        degradationCode: AiErrorCode.NoCandidate,
      },
      {
        ...PENDING,
        status: MatchingRequestStatus.Failed,
        degradationCode: AiErrorCode.ProviderError,
      },
    ]) {
      const error = await captureRepoError(() => repository.create(terminal, SCOPE));
      expect(error.code).toBe('INVALID_RECORD');
      expect(error.issues).toContain('status');
      expectNoValueLeak(error);
    }
    expect(executor.calls).toHaveLength(0);
  });
});

describe('PostgreSQL 匹配仓储：服务端 subject 归属边界与更新语义', () => {
  it('归属下推进 SQL：取数参数只含服务端主体，返回他人记录即 OWNER_VIOLATION', async () => {
    const { repository, executor } = repoWith({
      rows: [rowFromRecord(COMPLETED_FALLBACK, { user_id: OTHER_OWNER_ID })],
      rowCount: 1,
    });

    const error = await captureRepoError(() => repository.findById(REQUEST_ID, SCOPE));
    expect(error.code).toBe('OWNER_VIOLATION');
    expectIssueOn(error, 'user_id');
    expect(error.message).not.toContain(OTHER_OWNER_ID);
    expect(error.message).not.toContain(OWNER_ID);
    expectNoValueLeak(error);
    expect(callAt(executor, 0)?.parameters).toEqual([REQUEST_ID, OWNER_ID]);
  });

  it('列表里混入他人记录 → OWNER_VIOLATION（整批 fail-closed，不静默过滤也不返回）', async () => {
    const { repository } = repoWith({
      rows: [
        rowFromRecord(PENDING),
        rowFromRecord({ ...COMPLETED_FALLBACK, id: OTHER_REQUEST_ID, userId: OTHER_OWNER_ID }),
      ],
      rowCount: 2,
    });

    const error = await captureRepoError(() => repository.listByUserId(SCOPE));
    expect(error.code).toBe('OWNER_VIOLATION');
    expectNoValueLeak(error);
  });

  it('返回记录的主键与请求不一致 → IDENTITY_MISMATCH（他人记录不得冒充命中）', async () => {
    const { repository } = repoWith({
      rows: [rowFromRecord(COMPLETED_FALLBACK, { id: OTHER_REQUEST_ID })],
      rowCount: 1,
    });

    const error = await captureRepoError(() => repository.findById(REQUEST_ID, SCOPE));
    expect(error.code).toBe('IDENTITY_MISMATCH');
    expectIssueOn(error, 'id');
    expect(error.message).not.toContain(OTHER_REQUEST_ID);
    expectNoValueLeak(error);
  });

  it('单条取数返回多行 / 列表出现重复主键 → RESULT_SET_VIOLATION', async () => {
    const multi = repoWith({
      rows: [rowFromRecord(COMPLETED_FALLBACK), rowFromRecord(COMPLETED_FALLBACK)],
      rowCount: 2,
    });
    const multiError = await captureRepoError(() => multi.repository.findById(REQUEST_ID, SCOPE));
    expect(multiError.code).toBe('RESULT_SET_VIOLATION');
    expectNoValueLeak(multiError);

    const duplicated = repoWith({
      rows: [rowFromRecord(PENDING), rowFromRecord(PENDING)],
      rowCount: 2,
    });
    const duplicateError = await captureRepoError(() => duplicated.repository.listByUserId(SCOPE));
    expect(duplicateError.code).toBe('RESULT_SET_VIOLATION');
    expectNoValueLeak(duplicateError);
  });

  it('未命中返回 undefined、空列表返回 []（不抛错、也不是空对象）', async () => {
    const { repository, executor } = repoWith({ rows: [], rowCount: 0 }, { rows: [], rowCount: 0 });
    await expect(repository.findById(REQUEST_ID, SCOPE)).resolves.toBeUndefined();
    await expect(repository.listByUserId(SCOPE)).resolves.toEqual([]);
    expect(executor.calls).toHaveLength(2);
  });

  it('写入归属必须等于授权边界主体：不一致时在进入 SQL 之前拒绝', async () => {
    const { repository, executor } = repoWith();
    const createError = await captureRepoError(() =>
      repository.create({ ...PENDING, userId: OTHER_OWNER_ID }, SCOPE),
    );
    expect(createError.code).toBe('OWNER_VIOLATION');
    expectNoValueLeak(createError);

    const saveError = await captureRepoError(() =>
      repository.save({ ...COMPLETED_FALLBACK, userId: OTHER_OWNER_ID }, SCOPE),
    );
    expect(saveError.code).toBe('OWNER_VIOLATION');
    expectNoValueLeak(saveError);

    expect(executor.calls).toHaveLength(0);
  });

  it('写入未返回行 → create 抛 CONFLICT（不静默覆盖）、save 抛 UPDATE_MISSING', async () => {
    const conflict = repoWith({ rows: [], rowCount: 0 });
    const conflictError = await captureRepoError(() => conflict.repository.create(PENDING, SCOPE));
    expect(conflictError.code).toBe('CONFLICT');
    expect(conflictError.message).not.toContain(REQUEST_ID);
    expectNoValueLeak(conflictError);

    const missing = repoWith({ rows: [], rowCount: 0 });
    const missingError = await captureRepoError(() =>
      missing.repository.save(COMPLETED_FALLBACK, SCOPE),
    );
    expect(missingError.code).toBe('UPDATE_MISSING');
    expect(missingError.message).toContain('不区分原因');
    expectNoValueLeak(missingError);
  });

  it('写入返回多行 → RESULT_SET_VIOLATION', async () => {
    const duplicated = repoWith(
      { rows: [rowFromRecord(PENDING), rowFromRecord(PENDING)], rowCount: 2 },
      { rows: [rowFromRecord(COMPLETED_FALLBACK), rowFromRecord(COMPLETED_FALLBACK)], rowCount: 2 },
    );
    const createError = await captureRepoError(() => duplicated.repository.create(PENDING, SCOPE));
    expect(createError.code).toBe('RESULT_SET_VIOLATION');

    const saveError = await captureRepoError(() =>
      duplicated.repository.save(COMPLETED_FALLBACK, SCOPE),
    );
    expect(saveError.code).toBe('RESULT_SET_VIOLATION');
    expectNoValueLeak(saveError);
  });

  it('写入回流的人记录 / 被改写的归属 → OWNER_VIOLATION', async () => {
    const createOwner = repoWith({
      rows: [rowFromRecord(PENDING, { user_id: OTHER_OWNER_ID })],
      rowCount: 1,
    });
    const createError = await captureRepoError(() => createOwner.repository.create(PENDING, SCOPE));
    expect(createError.code).toBe('OWNER_VIOLATION');

    const saveOwner = repoWith({
      rows: [rowFromRecord(COMPLETED_FALLBACK, { user_id: OTHER_OWNER_ID })],
      rowCount: 1,
    });
    const saveError = await captureRepoError(() =>
      saveOwner.repository.save(COMPLETED_FALLBACK, SCOPE),
    );
    expect(saveError.code).toBe('OWNER_VIOLATION');
    expectNoValueLeak(saveError);
  });

  it('写入回流的主键与请求不一致 → IDENTITY_MISMATCH', async () => {
    const { repository } = repoWith({
      rows: [rowFromRecord(PENDING, { id: OTHER_REQUEST_ID })],
      rowCount: 1,
    });
    const error = await captureRepoError(() => repository.create(PENDING, SCOPE));
    expect(error.code).toBe('IDENTITY_MISMATCH');
    expectNoValueLeak(error);
  });

  it('覆盖写入不得改写创建时间：返回行创建时间与请求不一致 → IDENTITY_MISMATCH', async () => {
    const { repository, executor } = repoWith({
      rows: [rowFromRecord(COMPLETED_FALLBACK, { created_at: new Date(LATER) })],
      rowCount: 1,
    });
    const error = await captureRepoError(() => repository.save(COMPLETED_FALLBACK, SCOPE));
    expect(error.code).toBe('IDENTITY_MISMATCH');
    expect(error.issues).toContain('created_at');
    expectNoValueLeak(error);
    // 覆盖写入语句本身也不在 SET 里改写创建时间
    expect(callAt(executor, 0)?.sql).not.toMatch(/created_at\s*=/u);
  });

  it('写入记录的空 UUID / 非 UUID 主键与归属在进入 SQL 前拒绝', async () => {
    const { repository, executor } = repoWith();
    for (const [field, value] of [
      ['id', NIL_UUID],
      ['id', HEX_REQUEST_ID.toUpperCase()],
      ['id', SESSION_SUBJECT],
      ['userId', NIL_UUID],
      ['userId', HEX_OWNER_UPPER],
      ['userId', SESSION_SUBJECT],
    ] as const) {
      const error = await captureRepoError(() =>
        repository.create({ ...PENDING, [field]: value }, SCOPE),
      );
      expect(error.code).toBe('INVALID_RECORD');
      expectIssueOn(error, field);
      expectNoValueLeak(error);
    }
    expect(executor.calls).toHaveLength(0);
  });

  it('写入不改动调用方传入的记录对象（无共享可变状态：入参可冻结）', async () => {
    const { repository } = repoWith({ rows: [rowFromRecord(PENDING)], rowCount: 1 });
    const request = Object.freeze({ ...PENDING, recommendations: Object.freeze([]) });

    await expect(repository.create(request as unknown as MatchingRequest, SCOPE)).resolves.toEqual(
      PENDING,
    );
  });
});

describe('PostgreSQL 匹配仓储：group 授权边界（他人小组既不得落库也不得出库）', () => {
  it('读取时推荐结果出现授权集合之外的小组 → GROUP_SCOPE_VIOLATION（不静默过滤）', async () => {
    const foreign = { ...RECOMMENDATION, groupId: OTHER_GROUP_ID };
    const { repository } = repoWith({
      rows: [rowFromRecord(COMPLETED_FALLBACK, { recommendations: [foreign] })],
      rowCount: 1,
    });

    const error = await captureRepoError(() => repository.listByUserId(SCOPE));
    expect(error.code).toBe('GROUP_SCOPE_VIOLATION');
    expect(error.issues).toEqual(['recommendations.0.groupId']);
    expect(error.message).not.toContain(OTHER_GROUP_ID);
    expect(error.message).not.toContain(GROUP_ID);
    expectNoValueLeak(error);
  });

  it('空授权集合不等于「不过滤」：绑定空集合后任何推荐都判越权', async () => {
    const { repository } = repoWith({
      rows: [rowFromRecord(COMPLETED_FALLBACK)],
      rowCount: 1,
    });
    const error = await captureRepoError(() =>
      repository.listByUserId({ ownerUserId: OWNER_ID, authorizedGroupIds: [] }),
    );
    expect(error.code).toBe('GROUP_SCOPE_VIOLATION');
    expectNoValueLeak(error);
  });

  it('单条取数同样复核小组授权边界（多条推荐里只要有一条越权即 fail-closed）', async () => {
    const second = {
      ...RECOMMENDATION,
      groupId: OTHER_GROUP_ID,
      score: 70,
      reason: '方向标签重合有限，该组方向为科研伦理',
    };
    const { repository } = repoWith({
      rows: [rowFromRecord(COMPLETED_FALLBACK, { recommendations: [RECOMMENDATION, second] })],
      rowCount: 1,
    });
    const error = await captureRepoError(() => repository.findById(REQUEST_ID, SCOPE));
    expect(error.code).toBe('GROUP_SCOPE_VIOLATION');
    expect(error.issues).toEqual(['recommendations.1.groupId']);
    expectNoValueLeak(error);
  });

  it('写入时推荐结果出现授权集合之外的小组 → 进入 SQL 之前即拒绝（无副作用）', async () => {
    const { repository, executor } = repoWith();
    const foreign = { ...RECOMMENDATION, groupId: OTHER_GROUP_ID };

    const error = await captureRepoError(() =>
      repository.save({ ...COMPLETED_FALLBACK, recommendations: [foreign] }, SCOPE),
    );
    expect(error.code).toBe('GROUP_SCOPE_VIOLATION');
    expect(error.issues).toEqual(['recommendations.0.groupId']);
    expectNoValueLeak(error);
    expect(executor.calls).toHaveLength(0);
  });

  it('授权集合内的所有小组都可往返（边界内不误报）', async () => {
    const second = {
      ...RECOMMENDATION,
      groupId: OTHER_GROUP_ID,
      score: 70,
      reason: '方向标签重合有限，该组方向为科研伦理',
    };
    const wideScope: MatchingAccessScope = {
      ownerUserId: OWNER_ID,
      authorizedGroupIds: [GROUP_ID, OTHER_GROUP_ID],
    };
    const { repository } = repoWith({
      rows: [rowFromRecord(COMPLETED_FALLBACK, { recommendations: [RECOMMENDATION, second] })],
      rowCount: 1,
    });

    const found = await repository.findById(REQUEST_ID, wideScope);
    expect(found?.recommendations.map((item) => item.groupId)).toEqual([GROUP_ID, OTHER_GROUP_ID]);
  });
});

describe('PostgreSQL 匹配仓储：AI 输入最小化、去标识化与公开结果不泄露', () => {
  it('只接受脱敏输入的 sha256 摘要：原始特征 / 提示词 / 模型 payload 既不能写入也不能读出', async () => {
    // AI 边界列不在列清单里，因此不进 SELECT / INSERT / UPDATE / RETURNING
    for (const column of POSTGRES_MATCHING_AI_BOUNDARY_COLUMNS) {
      expect(POSTGRES_MATCHING_COLUMNS).not.toContain(column);
      expect(POSTGRES_MATCHING_REQUEST_FIELDS).not.toContain(column);
    }
    expect(POSTGRES_MATCHING_AI_BOUNDARY_COLUMNS).toContain('raw_response');
    expect(POSTGRES_MATCHING_AI_BOUNDARY_COLUMNS).toContain('prompt_text');
    expect(POSTGRES_MATCHING_AI_BOUNDARY_COLUMNS).toContain('student_features');

    // 摘要本身必须是 64 位小写十六进制（原文根本到不了 storage 层）
    const { repository, executor } = repoWith({ rows: [rowFromRecord(PENDING)], rowCount: 1 });
    await repository.create(PENDING, SCOPE);
    const call = callAt(executor, 0);
    expect(call?.parameters?.[4]).toBe(HASH);
    const serializedParameters = JSON.stringify(call?.parameters);
    expect(serializedParameters).not.toMatch(
      /"(?:student|candidates|features|featureBundle|prompt|promptText|rawResponse|modelPayload)"/u,
    );

    for (const inputSnapshotHash of [
      'plain-text-snapshot',
      HASH.toUpperCase(),
      HASH.slice(0, 63),
      `${HASH}0`,
      '',
    ]) {
      const error = await captureRepoError(() =>
        repository.create({ ...PENDING, inputSnapshotHash }, SCOPE),
      );
      expect(error.code).toBe('INVALID_RECORD');
      expectNoValueLeak(error);
    }
  });

  it('推荐理由 / 建议里的个人标识与长数字标识由读取契约兜底拒绝（模型或规则文本都不得带出 PII）', async () => {
    for (const reason of [
      `请联系我 ${PHONE}`,
      '证件号 11010119900307123X',
      '卡号 1234567890123456',
      'token = abcdefgh1234',
    ]) {
      const { repository } = repoWith({
        rows: [
          rowFromRecord(COMPLETED_FALLBACK, {
            recommendations: [{ ...RECOMMENDATION, reason }],
          }),
        ],
        rowCount: 1,
      });
      const error = await captureRepoError(() => repository.listByUserId(SCOPE));
      expect(error.code).toBe('INVALID_ROW');
      expectNoValueLeak(error);
    }
  });

  it('存储记录承载归属，但对外视图不含 userId、快照摘要与任何内部字段', async () => {
    const { repository } = repoWith({
      rows: [rowFromRecord(COMPLETED_FALLBACK)],
      rowCount: 1,
    });
    const record = await repository.findById(REQUEST_ID, SCOPE);

    // 存储记录承载归属（service 需要它做归属复核），键名全是驼峰形
    expect(record?.userId).toBe(OWNER_ID);
    expect(Object.keys(record ?? {}).every((key) => !key.includes('_'))).toBe(true);
    for (const internal of POSTGRES_MATCHING_INTERNAL_COLUMNS) {
      expect(Object.keys(record ?? {})).not.toContain(internal);
    }

    const parsed = parseStoredMatchingRequest(record);
    if (!parsed.ok) {
      throw new Error('存储记录未通过共享读取契约');
    }
    const view = toMatchingRequestView(parsed.value);

    expect(Object.keys(view)).toEqual([...MATCHING_REQUEST_VIEW_FIELDS]);
    expect(view).not.toHaveProperty('userId');
    expect(view).not.toHaveProperty('inputSnapshotHash');
    const serialized = JSON.stringify(view);
    expect(serialized).not.toContain(OWNER_ID);
    expect(serialized).not.toContain(HASH);
    expect(serialized).not.toContain(PROMPT_TEXT);
    expect(serialized).not.toContain(RAW_PAYLOAD);
    for (const internal of POSTGRES_MATCHING_INTERNAL_COLUMNS) {
      expect(serialized).not.toContain(`"${camelCase(internal)}"`);
    }
    // 公开视图只保留四条白名单字段的推荐条目
    expect(Object.keys(view.recommendations[0] ?? {})).toEqual([
      'groupId',
      'score',
      'reason',
      'advice',
    ]);
  });

  it('所有失败路径的错误信息与 issues 都不含任何取值', async () => {
    const { repository } = repoWith();
    const cases: readonly (() => Promise<unknown>)[] = [
      () => repository.findById(INJECTION, SCOPE),
      () => repository.findById(REQUEST_ID, { ownerUserId: INJECTION, authorizedGroupIds: [] }),
      () => repository.listByUserId({ ownerUserId: OWNER_ID, authorizedGroupIds: [PHONE] }),
      () => repository.create({ ...PENDING, userId: OTHER_OWNER_ID }, SCOPE),
      () =>
        repository.save(
          {
            ...COMPLETED_FALLBACK,
            recommendations: [{ ...RECOMMENDATION, groupId: OTHER_GROUP_ID }],
          },
          SCOPE,
        ),
      () =>
        repository.create(
          { ...PENDING, modelPayload: RAW_PAYLOAD } as unknown as MatchingRequest,
          SCOPE,
        ),
    ];

    for (const run of cases) {
      const error = await captureRepoError(run);
      expectNoValueLeak(error);
    }
  });

  it('回归：内存基线与 adapter 的公开记录字段闭集一致（同一份领域契约）', async () => {
    const memory: MatchingRepository = new InMemoryMatchingRepository({
      NODE_ENV: 'test',
    } as unknown as ConstructorParameters<typeof InMemoryMatchingRepository>[0]);
    const inMemory = memory.create(PENDING);

    const { repository } = repoWith({ rows: [rowFromRecord(PENDING)], rowCount: 1 });
    const persisted = await repository.create(PENDING, SCOPE);

    expect(Object.keys(persisted).sort()).toEqual(Object.keys(inMemory).sort());
    expect(persisted).toEqual(inMemory);
  });
});

describe('PostgreSQL 匹配仓储：未装配、无驱动依赖、与 schema 边界对齐', () => {
  it('MatchingModule 仍只绑定内存基线（本 adapter 未被装配）', () => {
    const content = readFileSync(MODULE_PATH, 'utf8');

    expect(content).not.toContain(ADAPTER_CLASS);
    expect(content).not.toContain(ADAPTER_MODULE);
    expect(content).toContain('InMemoryMatchingRepository');
    expect(content).toContain(
      '{ provide: MATCHING_REPOSITORY, useExisting: InMemoryMatchingRepository }',
    );
  });

  it('持久化登记、数据库模块与启动装配都不引用本 adapter（端口登记表仍按令牌判定）', () => {
    for (const relative of [
      join('src', 'db', 'persistence-bindings.ts'),
      join('src', 'db', 'database.module.ts'),
      join('src', 'db', 'ports', 'sql-executor.port.ts'),
      join('src', 'modules', 'matching', 'matching.port.ts'),
      join('src', 'app.module.ts'),
      join('src', 'startup-assembly.spec.ts'),
    ]) {
      const content = readApiFile(relative);
      expect(content).not.toContain(ADAPTER_CLASS);
      expect(content).not.toMatch(
        /(?:from\s+['"][^'"]*matching\.postgres-repository['"]|require\(\s*['"][^'"]*matching\.postgres-repository['"]\s*\))/u,
      );
    }
    // 登记表里匹配端口仍按令牌登记，且没有把 adapter 类名写进任何绑定
    const bindings = readApiFile(join('src', 'db', 'persistence-bindings.ts'));
    expect(bindings).toContain('MATCHING_REPOSITORY');
    expect(bindings).toContain('匹配记录存储');
  });

  it('内存基线仍是同步契约的实现者（本切片不改动它，也不切换内存 provider）', () => {
    const source = readFileSync(IN_MEMORY_PATH, 'utf8');
    expect(source).toContain('implements MatchingRepository');
    expect(source).not.toContain(ADAPTER_CLASS);
    expect(source).not.toContain(ADAPTER_MODULE);
    expect(source).toContain('persistent: false');
    expect(source).toContain('productionReady: false');

    const memory: MatchingRepository = new InMemoryMatchingRepository({
      NODE_ENV: 'test',
    } as unknown as ConstructorParameters<typeof InMemoryMatchingRepository>[0]);
    expect(memory.capabilities).toEqual({
      backend: 'in-memory-baseline',
      persistent: false,
      productionReady: false,
    });
    expect(memory.create(PENDING)).toEqual(PENDING);
    expect(memory.findById(REQUEST_ID)).toEqual(PENDING);
    expect(memory.listByUserId(OWNER_ID)).toEqual([PENDING]);
  });

  it('adapter 不引入任何数据库驱动 / ORM 依赖（依赖面是固定的六个说明符）', () => {
    const source = readFileSync(ADAPTER_PATH, 'utf8');
    const forbidden = new Set([
      'pg',
      'pg-pool',
      'pg-promise',
      'node-postgres',
      'postgres',
      'postgres.js',
      'slonik',
      'prisma',
      '@prisma/client',
      'typeorm',
      'kysely',
      'drizzle-orm',
      'drizzle-kit',
      'sequelize',
      '@mikro-orm/core',
      '@nestjs/common',
    ]);
    const specifiers = moduleSpecifiersOf(source);

    expect(specifiers.length).toBeGreaterThan(0);
    for (const specifier of specifiers) {
      expect(forbidden.has(specifier)).toBe(false);
    }
    expect(new Set(specifiers)).toEqual(
      new Set([
        'zod',
        '@rm/shared',
        '@rm/ai-adapter',
        '../../db/ports/sql-executor.port',
        './matching.contract',
        './matching.port',
      ]),
    );
  });

  it('工作区依赖里没有 pg / ORM 包', () => {
    for (const relative of [join('services', 'api', 'package.json'), 'package.json']) {
      const manifest = JSON.parse(readFileSync(join(REPO_ROOT, relative), 'utf8')) as {
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
      };
      const names = [
        ...Object.keys(manifest.dependencies ?? {}),
        ...Object.keys(manifest.devDependencies ?? {}),
      ];
      for (const name of names) {
        expect(
          /^(?:pg|pg-pool|pg-promise|postgres|prisma|@prisma\/client|typeorm|kysely|drizzle-orm|sequelize|@mikro-orm\/core)$/u.test(
            name,
          ),
        ).toBe(false);
      }
    }
  });

  it('ai_match_records 尚未转为迁移或草案：与 productionReady=false 及验证清单第 3 项配对', () => {
    const bootstrap = readFileSync(
      join(REPO_ROOT, 'db', 'migrations', '0001_bootstrap.sql'),
      'utf8',
    );
    // 占位清单里已经登记该表（因此本 adapter 的表名不是凭空发明）
    expect(bootstrap).toContain(POSTGRES_MATCHING_TABLE);

    const draftDir = join(REPO_ROOT, 'db', 'schema-drafts');
    expect(readdirSync(draftDir).some((file) => file.includes(POSTGRES_MATCHING_TABLE))).toBe(
      false,
    );
    const migrationDir = join(REPO_ROOT, 'db', 'migrations');
    expect(readdirSync(migrationDir).some((file) => file.includes(POSTGRES_MATCHING_TABLE))).toBe(
      false,
    );
    expect(POSTGRES_MATCHING_REPOSITORY_VERIFICATION_STEPS).toContain(
      'ai-match-records-schema-draft-created-and-promoted-to-migration',
    );
    expect(POSTGRES_MATCHING_REPOSITORY_CAPABILITIES.productionReady).toBe(false);
  });

  it('表名与列清单与字段级数据字典对齐（input_snapshot_hash / recommendations / 版本 / 降级）', () => {
    const dictionary = readFileSync(join(REPO_ROOT, 'docs', 'P1-字段级数据字典.md'), 'utf8');
    const line = dictionary
      .split(/\r?\n/u)
      .filter((entry) => entry.includes(POSTGRES_MATCHING_TABLE));
    expect(line.length).toBeGreaterThan(0);

    for (const column of [
      'input_snapshot_hash',
      'recommendations',
      'model_version',
      'prompt_version',
      'fallback_used',
    ]) {
      expect(POSTGRES_MATCHING_COLUMNS).toContain(column);
      expect(dictionary).toContain(column);
    }
    // 字典明确要求「不存原文」：本 adapter 只存摘要，且内部列清单覆盖原文类字段
    expect(dictionary).toContain('不存原文');
    expect(POSTGRES_MATCHING_AI_BOUNDARY_COLUMNS.length).toBeGreaterThan(0);
    expect(POSTGRES_MATCHING_PII_COLUMNS.length).toBeGreaterThan(0);
    expect(POSTGRES_MATCHING_INTERNAL_SCORE_COLUMNS.length).toBeGreaterThan(0);
    expect(POSTGRES_MATCHING_REVIEW_COLUMNS.length).toBeGreaterThan(0);
    expect(POSTGRES_MATCHING_BOOKKEEPING_COLUMNS.length).toBeGreaterThan(0);
  });
});

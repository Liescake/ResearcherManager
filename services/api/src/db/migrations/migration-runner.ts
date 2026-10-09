import {
  collectMigrationDeploymentCandidates,
  evaluateMigrationDeploymentGuard,
  MIGRATION_DEPLOYMENT_SOURCE_DIRECTORY,
  type MigrationDeploymentCandidate,
  type MigrationDeploymentGuardReport,
  type MigrationDeploymentViolation,
} from './migration-deployment-guard';
import {
  describeMigrationFile,
  MIGRATION_FILE_PATTERN,
  type MigrationApplication,
  type MigrationDescriptor,
} from './migration-boundary';
import { redactPostgresErrorText } from '../postgres/postgres-error';

/**
 * 迁移运行入口（**复用迁移部署守卫**，不含驱动）。
 *
 * ## 为什么不能「直接按文件名顺序执行 SQL」
 * `migration-deployment-guard.ts` 已经把「什么可以部署」判成机器可判定的事实：命名 / 顺序 /
 * 草案拒收 / 危险非事务 DDL / 未参数化动态标识符 / 校验和 / 与已应用记录的前缀关系。
 * 本模块是那套判定**唯一的执行侧**：
 * 1. 先采集候选（磁盘事实）与已应用记录（数据库事实）；
 * 2. 跑部署守卫；**不通过就一个 SQL 都不执行**（fail-closed，绝不「先跑几条试试」）；
 * 3. 只执行守卫给出的 `executionOrder`（= 待执行集合按版本升序），不重排、不漏跑；
 * 4. 每条迁移在**单个事务**内执行，并把 `schema_migrations` 记录写进同一个事务 ——
 *    中途失败既不留下半成品 schema，也不留下「已应用」记录。
 *
 * ## 全新数据库：先 bootstrap，再读应用版本
 * 记账表 `schema_migrations` 由 `0001` 建立，所以空库里第 1 步读到的就是「空集合」而不是错误；
 * 于是 `0001` 作为第一个待执行版本进入守卫的执行顺序，在守卫放行后由它自己的事务建表并记账，
 * 之后才谈得上「读取应用版本」。运行入口不自行建表、不跳过守卫、也不把「读失败」当成空库。
 *
 * ## 事务边界如何保证
 * 迁移文件按规范自带 `BEGIN;` / `COMMIT;`（守卫强制）。本模块把这两条**独立成行的**语句
 * 摘掉，改用执行器的 `transaction()` 提供事务，从而能把记账 INSERT 放进同一事务。
 * 若 BEGIN/COMMIT 不是独立成行（例如写成一行 `BEGIN; ... COMMIT;`），摘除会因为语义不确定而
 * 拒绝执行 —— 宁可拒绝，也不猜。
 *
 * ## 边界事实
 * - 本模块**不 import 任何驱动**：数据库能力由 `MigrationDatabasePort` 注入
 *   （真实实现在 `db/postgres/postgres-migration-database.ts`）；
 * - 判定用的是**文件原文**（守卫的校验和 / 事务包络 / DDL 规则都按原文判定），
 *   执行的是摘掉事务包裹后的等价文本；两者都会被记入报告以便核对；
 * - 错误信息只含版本号 / 文件名 / 违规码，不含连接串与口令（驱动层错误已另行脱敏）。
 */

/** 运行契约身份：版本变化意味着执行语义变化 */
export const MIGRATION_RUNNER_CONTRACT = {
  id: 'migration-runner',
  version: 1,
  /** 执行必须先通过这一份守卫契约 */
  deploymentGuardContract: 'migration-deployment-guard@1',
  /** 每条迁移一个事务，记账写入同一事务 */
  atomicity: 'single-transaction-per-migration',
  /** 禁止草案与危险非事务 DDL（由守卫判定） */
  rejectsDrafts: true,
} as const;

export type MigrationRunnerErrorCode =
  | 'RUN_GUARD_REJECTED'
  | 'RUN_TRANSACTION_BOUNDARY_UNSUPPORTED'
  | 'RUN_CANDIDATE_MISSING'
  | 'RUN_APPLY_FAILED'
  | 'RUN_APPLIED_READ_FAILED';

export interface MigrationRunnerErrorIssue {
  readonly code: string;
  readonly detail: string;
}

export class MigrationRunnerError extends Error {
  readonly code: MigrationRunnerErrorCode;
  readonly issues: readonly MigrationRunnerErrorIssue[];

  constructor(
    code: MigrationRunnerErrorCode,
    message: string,
    issues: readonly MigrationRunnerErrorIssue[] = [],
  ) {
    super(message);
    this.name = 'MigrationRunnerError';
    this.code = code;
    this.issues = [...issues];
  }
}

/**
 * 数据库端口：只暴露运行迁移需要的两件事（读已应用记录、原子应用一条迁移）。
 *
 * ## 「全新数据库」是正常状态，不是读取失败
 * 记账表 `schema_migrations` 由迁移 `0001` 建立，所以**空的数据库里这张表本来就不存在**。
 * `loadApplied()` 必须把这种情形如实表达为**空集合**（= 没有任何已应用迁移），
 * 否则会出现死锁：读应用版本要有表 → 有表要执行 `0001` → 执行 `0001` 要先读版本。
 *
 * 除「记账表尚未建立」以外的任何读取失败（连接、权限、超时、行契约不合法）都必须抛出：
 * 运行入口会把它收敛成 `RUN_APPLIED_READ_FAILED`（细节已脱敏）。
 *
 * **建表只允许走守卫**：实现不得在读取路径上顺手建表，`schema_migrations` 只能由守卫放行的
 * `0001` 在自己的事务内建立 —— 否则「哪些 DDL 可以部署」就有了绕过守卫的第二个入口。
 */
export interface MigrationDatabasePort {
  /** 已应用记录（版本升序）。**记账表尚未建立（全新数据库）时返回空集合**，不抛错。 */
  loadApplied(): Promise<readonly MigrationApplication[]>;
  /**
   * 在**单个事务**内执行 `statement` 并写入 `schema_migrations` 记录。
   * 实现必须保证：任一失败即整体回滚（既无半成品 schema，也无「已应用」记录）。
   */
  applyAtomically(input: {
    readonly descriptor: MigrationDescriptor;
    readonly statement: string;
    readonly appliedBy: string;
  }): Promise<{ readonly executionMs: number }>;
}

export interface RunMigrationsOptions {
  /** 部署环境（守卫只接受 development / test / staging / production） */
  readonly environment: string;
  /** 迁移目录**绝对路径**（仓库相对来源仍固定为 `db/migrations`，由守卫判定） */
  readonly sourceDirectory: string;
  readonly database: MigrationDatabasePort;
  /** 记入 `schema_migrations.applied_by` 的执行者标识 */
  readonly appliedBy: string;
  /** 执行器声明的执行顺序（可选；必须等于守卫给出的待执行集合） */
  readonly deploymentOrder?: readonly string[];
  /** 只判定不执行（dry-run）：返回将要执行的版本，不碰数据库的写路径 */
  readonly dryRun?: boolean;
}

export interface ExecutedMigration {
  readonly version: string;
  readonly fileName: string;
  readonly checksum: string;
  readonly executionMs: number;
}

export interface MigrationRunReport {
  readonly ok: true;
  readonly environment: string;
  readonly dryRun: boolean;
  readonly executed: readonly ExecutedMigration[];
  /** 守卫判定的待执行版本（升序） */
  readonly pendingVersions: readonly string[];
  readonly executionOrder: readonly string[];
  readonly appliedBefore: readonly string[];
  readonly appliedAfter: readonly string[];
  readonly guard: MigrationDeploymentGuardReport;
}

const STANDALONE_BEGIN = /^[ \t]*BEGIN[ \t]*;[ \t]*$/gmu;
const STANDALONE_COMMIT = /^[ \t]*COMMIT[ \t]*;[ \t]*$/gmu;

function matches(pattern: RegExp, content: string): RegExpMatchArray[] {
  const scoped = new RegExp(pattern.source, pattern.flags);
  return [...content.matchAll(scoped)];
}

/**
 * 摘掉迁移文件自带的 `BEGIN;` / `COMMIT;`（必须各自独立成行、各出现一次、且顺序正确）。
 *
 * @throws MigrationRunnerError 边界形状不确定时拒绝（绝不猜测事务位置）
 */
export function stripTransactionBoundary(content: string): string {
  const begins = matches(STANDALONE_BEGIN, content);
  const commits = matches(STANDALONE_COMMIT, content);
  const begin = begins[0];
  const commit = commits[0];

  if (
    begins.length !== 1 ||
    commits.length !== 1 ||
    begin === undefined ||
    commit === undefined ||
    (begin.index ?? 0) > (commit.index ?? 0)
  ) {
    throw new MigrationRunnerError(
      'RUN_TRANSACTION_BOUNDARY_UNSUPPORTED',
      '迁移的 BEGIN/COMMIT 必须各自独立成行且 BEGIN 在 COMMIT 之前：形状不确定时拒绝执行',
      [{ code: 'transaction-envelope', detail: `BEGIN=${begins.length} COMMIT=${commits.length}` }],
    );
  }

  const beginIndex = begin.index ?? 0;
  const commitIndex = commit.index ?? 0;
  const stripped =
    content.slice(0, beginIndex) +
    content.slice(beginIndex + begin[0].length, commitIndex) +
    content.slice(commitIndex + commit[0].length);

  if (
    matches(STANDALONE_BEGIN, stripped).length > 0 ||
    matches(STANDALONE_COMMIT, stripped).length > 0
  ) {
    throw new MigrationRunnerError(
      'RUN_TRANSACTION_BOUNDARY_UNSUPPORTED',
      '摘除事务包裹后仍存在独立的 BEGIN/COMMIT：迁移包含多段事务，拒绝执行',
    );
  }
  return stripped;
}

/** 文件名 → 版本号（守卫已保证命名合法；此处只取前 4 位） */
export function versionOfMigrationFile(fileName: string): string | undefined {
  return MIGRATION_FILE_PATTERN.exec(fileName)?.[1];
}

function guardViolationToIssue(violation: MigrationDeploymentViolation): MigrationRunnerErrorIssue {
  return { code: violation.code, detail: `${violation.subject}: ${violation.detail}` };
}

/**
 * 执行迁移（**部署守卫先行**）。
 *
 * @throws MigrationRunnerError 守卫拒绝、候选缺失、事务边界不确定或某条迁移执行失败
 */
export async function runMigrations(options: RunMigrationsOptions): Promise<MigrationRunReport> {
  const candidates = collectMigrationDeploymentCandidates(options.sourceDirectory);
  // 全新数据库在这里得到空集合（记账表尚未由 0001 建立），因此 `0001` 会作为第一个待执行版本
  // 进入守卫的执行顺序；「读不出来」才 fail-closed（见 readApplied）。
  const appliedBefore = await readApplied(options.database, 'before');

  const guard = evaluateMigrationDeploymentGuard({
    environment: options.environment,
    sourceDirectory: MIGRATION_DEPLOYMENT_SOURCE_DIRECTORY,
    candidates,
    applied: appliedBefore,
    ...(options.deploymentOrder !== undefined ? { deploymentOrder: options.deploymentOrder } : {}),
  });

  if (!guard.ok) {
    throw new MigrationRunnerError(
      'RUN_GUARD_REJECTED',
      `迁移部署守卫拒绝执行（${guard.violations.length} 项）：未执行任何 SQL`,
      guard.violations.map(guardViolationToIssue),
    );
  }

  const dryRun = options.dryRun === true;
  const executed: ExecutedMigration[] = [];

  if (!dryRun) {
    const byVersion = new Map<string, MigrationDeploymentCandidate>();
    for (const candidate of candidates) {
      const version = versionOfMigrationFile(candidate.fileName);
      if (version !== undefined) {
        byVersion.set(version, candidate);
      }
    }

    for (const version of guard.executionOrder) {
      const candidate = byVersion.get(version);
      if (candidate === undefined) {
        throw new MigrationRunnerError(
          'RUN_CANDIDATE_MISSING',
          `守卫要求执行版本 ${version}，但候选集合里找不到对应文件：拒绝跳过该版本`,
          [{ code: 'candidate', detail: version }],
        );
      }
      const descriptor: MigrationDescriptor = describeMigrationFile(
        candidate.fileName,
        candidate.content,
      );
      const statement = stripTransactionBoundary(candidate.content);

      let executionMs: number;
      try {
        const applied = await options.database.applyAtomically({
          descriptor,
          statement,
          appliedBy: options.appliedBy,
        });
        executionMs = applied.executionMs;
      } catch (error) {
        throw new MigrationRunnerError(
          'RUN_APPLY_FAILED',
          `迁移 ${version}（${candidate.fileName}）执行失败：事务已回滚，该版本未记录为已应用`,
          [{ code: 'apply', detail: `${version}: ${describeFailure(error)}` }],
        );
      }

      executed.push({
        version,
        fileName: candidate.fileName,
        checksum: descriptor.checksum,
        executionMs,
      });
    }
  }

  const appliedAfter = dryRun ? appliedBefore : await readApplied(options.database, 'after');

  return {
    ok: true,
    environment: options.environment,
    dryRun,
    executed,
    pendingVersions: guard.pendingVersions,
    executionOrder: guard.executionOrder,
    appliedBefore: appliedBefore.map((item) => item.version),
    appliedAfter: appliedAfter.map((item) => item.version),
    guard,
  };
}

/** 只回答「已应用 / 待执行」的状态（不写库）：供 CLI `--status` 与 attest 取证使用 */
export interface MigrationStatusReport {
  readonly applied: readonly string[];
  readonly pending: readonly string[];
  readonly upToDate: boolean;
  readonly guard: MigrationDeploymentGuardReport;
}

export async function loadMigrationStatus(
  options: Omit<RunMigrationsOptions, 'dryRun'>,
): Promise<MigrationStatusReport> {
  const candidates = collectMigrationDeploymentCandidates(options.sourceDirectory);
  const applied = await readApplied(options.database, 'status');
  const guard = evaluateMigrationDeploymentGuard({
    environment: options.environment,
    sourceDirectory: MIGRATION_DEPLOYMENT_SOURCE_DIRECTORY,
    candidates,
    applied,
    ...(options.deploymentOrder !== undefined ? { deploymentOrder: options.deploymentOrder } : {}),
  });
  return {
    applied: applied.map((item) => item.version),
    pending: guard.pendingVersions,
    upToDate: guard.pendingVersions.length === 0,
    guard,
  };
}

/**
 * 失败摘要：驱动层的脱敏消息可以透传，其余只保留错误名（避免把栈/连接信息带回）。
 *
 * 若异常自身带有 `issues`（执行器契约里只放 SQLSTATE、后果名、参数槽序号这类**结构性**描述），
 * 则把其中的 `code` 一并带上：SQLSTATE 是可外发的诊断事实（见 `postgres-error.ts`），
 * 丢掉它会让「权限不足 / 表不存在 / 约束冲突」在上层无法区分。`issues` 不是数组就忽略，
 * 绝不去回读驱动原文。
 */
function describeFailure(error: unknown): string {
  const message = error instanceof Error ? error.message : '';
  const name = error instanceof Error ? error.name : typeof error;
  const codes = readErrorIssueCodes(error);
  const suffix = codes.length === 0 ? '' : ` [${codes.join(', ')}]`;
  return `${name}: ${redactPostgresErrorText(message)}${suffix}`;
}

/** 读取已脱敏的结构性错误码（只取 `code`；形状不可信时返回空数组） */
function readErrorIssueCodes(error: unknown): string[] {
  if (typeof error !== 'object' || error === null) {
    return [];
  }
  const issues = (error as { issues?: unknown }).issues;
  if (!Array.isArray(issues)) {
    return [];
  }
  return issues
    .map((issue) =>
      typeof issue === 'object' && issue !== null ? (issue as { code?: unknown }).code : undefined,
    )
    .filter((code): code is string => typeof code === 'string' && code !== '')
    .map((code) => redactPostgresErrorText(code));
}

/** 读取失败发生在哪一步：只影响消息措辞，不改变 fail-closed 语义 */
export type AppliedReadStage = 'before' | 'after' | 'status';

/**
 * 读取已应用记录：**读不出来就是状态未知**，一律 fail-closed。
 *
 * 「全新数据库」不在这里处理：那是端口层的正常返回值（空集合），不是异常。
 * 这里只保证「真的读失败」不会退化成一个看起来正常的空快照 —— 那会让守卫在状态未知的
 * 情况下放行迁移，是最危险的失败模式。细节先经 `postgres-error.ts` 脱敏再进入错误项，
 * 因此连接串 / 口令 / 行取值不会随错误外发。
 *
 * @throws MigrationRunnerError `RUN_APPLIED_READ_FAILED`
 */
async function readApplied(
  database: MigrationDatabasePort,
  stage: AppliedReadStage,
): Promise<readonly MigrationApplication[]> {
  try {
    return await database.loadApplied();
  } catch (error) {
    const message =
      stage === 'before'
        ? '无法读取 schema_migrations（迁移状态未知）：未执行任何 SQL'
        : stage === 'after'
          ? '迁移执行后无法重新读取 schema_migrations：拒绝在状态未知时报告成功'
          : '无法读取 schema_migrations（迁移状态未知）：拒绝在状态未知时报告已同步';
    throw new MigrationRunnerError('RUN_APPLIED_READ_FAILED', message, [
      { code: 'applied-read', detail: `${stage}: ${describeFailure(error)}` },
    ]);
  }
}

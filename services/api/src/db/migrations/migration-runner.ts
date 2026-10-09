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

/** 数据库端口：只暴露运行迁移需要的两件事（读已应用记录、原子应用一条迁移） */
export interface MigrationDatabasePort {
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
  const appliedBefore = await options.database.loadApplied();

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

  let appliedAfter: readonly MigrationApplication[];
  try {
    appliedAfter = dryRun ? appliedBefore : await options.database.loadApplied();
  } catch {
    throw new MigrationRunnerError(
      'RUN_APPLIED_READ_FAILED',
      '迁移执行后无法重新读取 schema_migrations：拒绝在状态未知时报告成功',
    );
  }

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
  const applied = await options.database.loadApplied();
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

/** 失败摘要：驱动层的脱敏消息可以透传，其余只保留错误名（避免把栈/连接信息带回） */
function describeFailure(error: unknown): string {
  const message = error instanceof Error ? error.message : '';
  const name = error instanceof Error ? error.name : typeof error;
  return `${name}: ${redactPostgresErrorText(message)}`;
}

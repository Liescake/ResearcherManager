import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { loadEnv } from '../../config/env';
import { DatabaseConfigError, resolveDatabaseConfig } from '../config/database-config';
import {
  createPostgresConnection,
  toPostgresPoolProfile,
  UNATTESTED_POSTGRES_CAPABILITIES,
} from '../postgres/postgres-executor';
import { createPostgresMigrationDatabase } from '../postgres/postgres-migration-database';
import { MIGRATION_DEPLOYMENT_ENVIRONMENTS } from './migration-deployment-guard';
import { loadMigrationStatus, runMigrations } from './migration-runner';

/**
 * 迁移 CLI（`pnpm db:migrate` / `pnpm db:migrate:status`）。
 *
 * ## 退出码（与仓库的工具链门禁同一口径）
 * - `0`：成功（dry-run / status 也算成功）；
 * - `1`：守卫拒绝或某条迁移执行失败（**没有**任何 SQL 被提交）；
 * - `2`：前置条件未满足（未配置 `DATABASE_URL`、环境名非法、目录不可读）—— 属运维/配置问题，
 *   与「迁移内容不合规」区分开。
 *
 * ## 安全边界
 * - 使用**未 attest 的核心连接**（`createPostgresConnection`）：迁移入口不属于应用生产执行器，
 *   它只在部署窗口由运维显式调用；业务 adapter 必须使用受 attest 约束的工厂；
 * - 输出里只有版本号 / 文件名 / 校验和 / 耗时，**不含**连接串、主机、口令；
 * - 迁移执行前必须通过 `migration-deployment-guard`（草案、危险非事务 DDL、未参数化动态标识符、
 *   校验和与已应用顺序都在那里判定）。
 */

/**
 * 默认迁移目录：从 `start` 向上找到仓库根（`pnpm-workspace.yaml`）后取 `<repo>/db/migrations`。
 *
 * 不用 `__dirname`：CLI 既可能以 CommonJS 构建产物运行，也可能在测试里以 ESM 直接 import，
 * 而 `__dirname` 在 ESM 下不存在。向上查找仓库根在两种形态下都成立，也避免「cwd 不同 ⇒
 * 静默枚举到空目录」这种最危险的失败模式（空候选集会被守卫拒绝，而不是「什么都没做地成功」）。
 */
export function resolveMigrationsDirectory(start: string = process.cwd()): string {
  let current = resolve(start);
  for (let depth = 0; depth < 8; depth += 1) {
    if (existsSync(join(current, 'pnpm-workspace.yaml'))) {
      return join(current, 'db', 'migrations');
    }
    const parent = resolve(current, '..');
    if (parent === current) {
      break;
    }
    current = parent;
  }
  throw new Error(
    '未找到仓库根目录（缺少 pnpm-workspace.yaml）：请用 DATABASE_MIGRATIONS_DIR 显式指定迁移目录',
  );
}

export interface MigrationCliOptions {
  readonly statusOnly: boolean;
  readonly dryRun: boolean;
  readonly help: boolean;
  readonly environment?: string;
  readonly appliedBy: string;
  readonly sourceDirectory: string;
  /** 非法的命令行参数（存在时直接按用法错误处理） */
  readonly errors: readonly string[];
}

/** 解析命令行；不读环境变量（由调用方注入），便于测试 */
export function parseMigrationCliArgs(
  argv: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): MigrationCliOptions {
  let statusOnly = false;
  let dryRun = false;
  let help = false;
  let environment: string | undefined;
  let appliedBy = env['DATABASE_MIGRATION_APPLIED_BY']?.trim() ?? '';
  const errors: string[] = [];

  for (const raw of argv) {
    const arg = raw.trim();
    if (arg === '--status') {
      statusOnly = true;
      continue;
    }
    if (arg === '--dry-run') {
      dryRun = true;
      continue;
    }
    if (arg === '--help' || arg === '-h') {
      help = true;
      continue;
    }
    if (arg.startsWith('--environment=')) {
      environment = arg.slice('--environment='.length).trim();
      continue;
    }
    if (arg.startsWith('--applied-by=')) {
      appliedBy = arg.slice('--applied-by='.length).trim();
      continue;
    }
    if (arg.startsWith('--source-dir=')) {
      errors.push('--source-dir 不允许覆盖：迁移来源固定为 db/migrations');
      continue;
    }
    errors.push(`无法识别的参数: ${arg}`);
  }

  if (appliedBy === '') {
    appliedBy = 'dsh-db-migrate';
  }

  const sourceDirectory =
    env['DATABASE_MIGRATIONS_DIR']?.trim() !== undefined &&
    env['DATABASE_MIGRATIONS_DIR']?.trim() !== ''
      ? (env['DATABASE_MIGRATIONS_DIR'] as string).trim()
      : resolveMigrationsDirectory();

  return {
    statusOnly,
    dryRun,
    help,
    appliedBy,
    sourceDirectory,
    errors,
    ...(environment !== undefined ? { environment } : {}),
  };
}

export const MIGRATION_CLI_USAGE = [
  '用法: node dist/db/migrations/run-migrations.js [--status] [--dry-run] [--environment=<env>] [--applied-by=<id>]',
  '',
  '  --status              只报告已应用 / 待执行版本，不写库',
  '  --dry-run             先过部署守卫并给出待执行集合，但不执行 SQL',
  '  --environment=<env>   部署环境（development / test / staging / production，默认取 NODE_ENV）',
  '  --applied-by=<id>     记入 schema_migrations.applied_by（默认 dsh-db-migrate）',
  '',
  '前置: DATABASE_URL 必须指向**非生产**目标库；生产执行需按 README 的发布流程进行。',
].join('\n');

/** 只输出可安全写日志的字段（版本 / 文件 / 校验和 / 耗时） */
function describeReport(report: unknown): unknown {
  return report;
}

/**
 * CLI 主入口。返回退出码（0 / 1 / 2），不调用 `process.exit`，便于测试直接断言。
 */
export async function main(
  argv: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): Promise<number> {
  const parsed = parseMigrationCliArgs(argv, env);
  if (parsed.help) {
    console.log(MIGRATION_CLI_USAGE);
    return 0;
  }
  if (parsed.errors.length > 0) {
    console.error(JSON.stringify({ ok: false, reason: 'usage', errors: parsed.errors }, null, 2));
    console.error(MIGRATION_CLI_USAGE);
    return 2;
  }

  const environment = parsed.environment ?? env['NODE_ENV'] ?? 'development';
  if (!(MIGRATION_DEPLOYMENT_ENVIRONMENTS as readonly string[]).includes(environment)) {
    console.error(
      JSON.stringify(
        {
          ok: false,
          reason: 'environment-unknown',
          allowed: [...MIGRATION_DEPLOYMENT_ENVIRONMENTS],
        },
        null,
        2,
      ),
    );
    return 2;
  }

  let appEnv;
  try {
    appEnv = loadEnv(env);
  } catch (error) {
    console.error(
      JSON.stringify(
        { ok: false, reason: 'env-invalid', detail: error instanceof Error ? error.message : '' },
        null,
        2,
      ),
    );
    return 2;
  }

  let resolution;
  try {
    // 迁移入口的 application_name 独立：便于 DBA 在 pg_stat_activity 里区分发布窗口与在线流量
    resolution = resolveDatabaseConfig(
      { ...appEnv, NODE_ENV: environment },
      { defaultApplicationName: 'researcher-manager-migrate' },
    );
  } catch (error) {
    const code = error instanceof DatabaseConfigError ? error.code : 'DATABASE_CONFIG_INVALID';
    console.error(JSON.stringify({ ok: false, reason: code }, null, 2));
    return 2;
  }

  if (resolution.status !== 'configured') {
    console.error(JSON.stringify({ ok: false, reason: 'database-not-configured' }, null, 2));
    return 2;
  }

  const connection = createPostgresConnection({
    profile: toPostgresPoolProfile(resolution.config),
    capabilities: UNATTESTED_POSTGRES_CAPABILITIES,
  });
  const database = createPostgresMigrationDatabase(connection);

  try {
    if (parsed.statusOnly) {
      const status = await loadMigrationStatus({
        environment,
        sourceDirectory: parsed.sourceDirectory,
        database,
        appliedBy: parsed.appliedBy,
      });
      console.log(
        JSON.stringify(
          {
            ok: status.guard.ok,
            mode: 'status',
            environment,
            applied: status.applied,
            pending: status.pending,
            upToDate: status.upToDate,
            violations: status.guard.violations.map((item) => item.code),
          },
          null,
          2,
        ),
      );
      return status.guard.ok ? 0 : 1;
    }

    const report = await runMigrations({
      environment,
      sourceDirectory: parsed.sourceDirectory,
      database,
      appliedBy: parsed.appliedBy,
      dryRun: parsed.dryRun,
    });
    console.log(
      JSON.stringify(
        {
          ok: true,
          mode: parsed.dryRun ? 'dry-run' : 'apply',
          environment,
          executed: describeReport(report.executed),
          pendingVersions: report.pendingVersions,
          appliedBefore: report.appliedBefore,
          appliedAfter: report.appliedAfter,
        },
        null,
        2,
      ),
    );
    return 0;
  } catch (error) {
    const name = error instanceof Error ? error.name : typeof error;
    const code =
      typeof (error as { code?: unknown }).code === 'string'
        ? (error as { code: string }).code
        : 'MIGRATION_RUN_FAILED';
    const violations =
      error instanceof Error && 'violations' in error
        ? ((error as { violations: readonly { code: string }[] }).violations ?? []).map(
            (item) => item.code,
          )
        : undefined;
    console.error(
      JSON.stringify(
        {
          ok: false,
          reason: code,
          error: name,
          ...(violations === undefined ? {} : { violations }),
        },
        null,
        2,
      ),
    );
    return 1;
  } finally {
    await connection.close().catch(() => undefined);
  }
}

/* istanbul ignore next -- CLI 入口只在直接执行时触发，测试直接调用 main() */
const isDirectRun =
  typeof require !== 'undefined' && typeof module !== 'undefined' && require.main === module;
if (isDirectRun) {
  void main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    },
  );
}

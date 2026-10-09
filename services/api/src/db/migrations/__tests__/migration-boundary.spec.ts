import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  assertMigrationPlanRunnable,
  assertMigrationSequence,
  computeMigrationChecksum,
  describeMigrationFile,
  MigrationBoundaryError,
  planMigrationRun,
  readMigrationDirectory,
  type MigrationDescriptor,
} from '../migration-boundary';

/** 从当前工作目录向上寻找仓库根（含 pnpm-workspace.yaml），避免依赖 cwd 具体层级 */
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

const VALID_MIGRATION = [
  '-- migration: 0001_bootstrap',
  '-- description: 建立迁移记录表',
  '-- reversible: 是（DROP TABLE schema_migrations）',
  '-- owner: P3 基础工程',
  '',
  'BEGIN;',
  'CREATE TABLE IF NOT EXISTS schema_migrations (version text PRIMARY KEY);',
  'COMMIT;',
].join('\n');

function captureMigrationError(run: () => unknown): MigrationBoundaryError {
  try {
    run();
  } catch (error) {
    if (error instanceof MigrationBoundaryError) {
      return error;
    }
    throw error;
  }
  throw new Error('期望抛出 MigrationBoundaryError，但未抛出');
}

function descriptor(version: string, checksum = `checksum-${version}`): MigrationDescriptor {
  return {
    fileName: `${version}_demo.sql`,
    version,
    name: 'demo',
    checksum,
    reversible: true,
  };
}

describe('describeMigrationFile：命名、头部与事务边界', () => {
  it('解析出序号、名称、可逆性与头部字段', () => {
    const parsed = describeMigrationFile('0001_bootstrap.sql', VALID_MIGRATION);
    expect(parsed).toMatchObject({
      fileName: '0001_bootstrap.sql',
      version: '0001',
      name: 'bootstrap',
      reversible: true,
      description: '建立迁移记录表',
      owner: 'P3 基础工程',
    });
    expect(parsed.checksum).toBe(computeMigrationChecksum(VALID_MIGRATION));
  });

  it('reversible: 否 解析为 false，且缺失该字段直接判错', () => {
    const irreversible = VALID_MIGRATION.replace(
      '-- reversible: 是（DROP TABLE schema_migrations）',
      '-- reversible: 否（需人工恢复）',
    );
    expect(describeMigrationFile('0002_demo.sql', irreversible).reversible).toBe(false);

    const missingField = VALID_MIGRATION.replace(
      '-- reversible: 是（DROP TABLE schema_migrations）\n',
      '',
    );
    expect(
      captureMigrationError(() => describeMigrationFile('0001_bootstrap.sql', missingField)).code,
    ).toBe('MIGRATION_HEADER_FIELD_MISSING');
  });

  it('文件名不符合 NNNN_snake_case.sql 时判错', () => {
    for (const fileName of [
      'bootstrap.sql',
      '0001-Bootstrap.sql',
      '0001_bootstrap.SQL',
      '1_bootstrap.sql',
    ]) {
      expect(
        captureMigrationError(() => describeMigrationFile(fileName, VALID_MIGRATION)).code,
      ).toBe('MIGRATION_FILE_NAME_INVALID');
    }
  });

  it('BEGIN/COMMIT 不配对时判错', () => {
    const unbalanced = VALID_MIGRATION.replace('COMMIT;', '');
    expect(
      captureMigrationError(() => describeMigrationFile('0001_bootstrap.sql', unbalanced)).code,
    ).toBe('MIGRATION_TRANSACTION_UNBALANCED');
  });

  it('校验和按 LF 归一化：CRLF 检出与 LF 得到同一哈希', () => {
    const lf = VALID_MIGRATION;
    const crlf = VALID_MIGRATION.replace(/\n/gu, '\r\n');
    expect(computeMigrationChecksum(crlf)).toBe(computeMigrationChecksum(lf));
  });
});

describe('assertMigrationSequence：序号唯一且递增', () => {
  it('序号重复时判错', () => {
    expect(
      captureMigrationError(() => assertMigrationSequence([descriptor('0001'), descriptor('0001')]))
        .code,
    ).toBe('MIGRATION_VERSION_DUPLICATE');
  });

  it('序号不递增时判错', () => {
    expect(
      captureMigrationError(() => assertMigrationSequence([descriptor('0002'), descriptor('0001')]))
        .code,
    ).toBe('MIGRATION_ORDER_INVALID');
  });

  it('升序且唯一的序列通过', () => {
    expect(assertMigrationSequence([descriptor('0001'), descriptor('0002')])).toHaveLength(2);
  });
});

describe('readMigrationDirectory：与仓库真实迁移对齐', () => {
  it('读取 db/migrations 并通过命名、头部与顺序校验', () => {
    const repoRoot = findRepoRoot(process.cwd());
    const descriptors = readMigrationDirectory(join(repoRoot, 'db', 'migrations'));

    expect(descriptors.map((item) => item.fileName)).toEqual([
      '0001_bootstrap.sql',
      '0002_education_records.sql',
      '0003_join_applications.sql',
      '0004_achievements.sql',
      '0005_ai_match_records.sql',
      '0006_sessions.sql',
      '0007_student_profiles.sql',
      '0008_achievements_constraints.sql',
      '0009_audit_logs.sql',
      '0010_notifications.sql',
      '0011_research_groups.sql',
      '0012_user_compliance.sql',
      '0013_export_jobs.sql',
      '0014_ai_match_records_guards.sql',
    ]);
    expect(descriptors.map((item) => item.version)).toEqual([
      '0001',
      '0002',
      '0003',
      '0004',
      '0005',
      '0006',
      '0007',
      '0008',
      '0009',
      '0010',
      '0011',
      '0012',
      '0013',
      '0014',
    ]);
    // 全部迁移都必须是「可回滚」：建表迁移由 DROP TABLE IF EXISTS 恢复，约束迁移由
    // ALTER TABLE ... DROP CONSTRAINT IF EXISTS 恢复
    expect(descriptors.map((item) => item.reversible)).toEqual([
      true,
      true,
      true,
      true,
      true,
      true,
      true,
      true,
      true,
      true,
      true,
      true,
      true,
      true,
    ]);
    // 与 CI 静态门禁同源：文件内容必须真的可解析
    expect(
      readFileSync(join(repoRoot, 'db', 'migrations', '0001_bootstrap.sql'), 'utf8'),
    ).toContain('schema_migrations');
    // 本人统计切片依赖的四张来源表必须真的由迁移建出来（不是只在注释里登记）
    for (const [file, table] of [
      ['0002_education_records.sql', 'education_records'],
      ['0003_join_applications.sql', 'join_applications'],
      ['0004_achievements.sql', 'achievements'],
      ['0005_ai_match_records.sql', 'ai_match_records'],
      ['0006_sessions.sql', 'sessions'],
      ['0007_student_profiles.sql', 'student_profiles'],
      ['0009_audit_logs.sql', 'audit_logs'],
      ['0010_notifications.sql', 'notifications'],
      ['0011_research_groups.sql', 'research_groups'],
      ['0012_user_compliance.sql', 'user_compliance'],
      ['0013_export_jobs.sql', 'export_jobs'],
    ] as const) {
      expect(readFileSync(join(repoRoot, 'db', 'migrations', file), 'utf8')).toMatch(
        new RegExp(`CREATE\\s+TABLE\\s+IF\\s+NOT\\s+EXISTS\\s+${table}\\s*\\(`, 'u'),
      );
    }

    // 0014 同属**约束补齐**（不建表）：它必须真的给 0005 建出的 ai_match_records 加约束
    const matchingConstraintMigration = readFileSync(
      join(repoRoot, 'db', 'migrations', '0014_ai_match_records_guards.sql'),
      'utf8',
    );
    expect(matchingConstraintMigration).toMatch(/ALTER\s+TABLE\s+ai_match_records\b/iu);
    for (const constraint of [
      'ai_match_records_id_not_nil',
      'ai_match_records_user_id_not_nil',
      'ai_match_records_recommendations_is_array',
      'ai_match_records_recommendations_max_items',
    ]) {
      expect(matchingConstraintMigration).toContain(`ADD CONSTRAINT ${constraint}`);
    }
    expect(matchingConstraintMigration).not.toMatch(/CREATE\s+TABLE\b/iu);
    expect(matchingConstraintMigration).not.toMatch(/CREATE\s+(?:UNIQUE\s+)?INDEX\b/iu);

    // 0008 是**约束补齐**（不建表）：它必须真的给 0004 建出的表加约束，而不是只在注释里声明
    const constraintMigration = readFileSync(
      join(repoRoot, 'db', 'migrations', '0008_achievements_constraints.sql'),
      'utf8',
    );
    expect(constraintMigration).toMatch(/ALTER\s+TABLE\s+achievements\b/iu);
    for (const constraint of ['achievements_title_length', 'achievements_owner_not_nil']) {
      expect(constraintMigration).toContain(`ADD CONSTRAINT ${constraint}`);
    }
    // 约束迁移不得顺手建表 / 建索引（一份迁移只做一件事，索引已由 0004 建立）
    expect(constraintMigration).not.toMatch(/CREATE\s+TABLE\b/iu);
    expect(constraintMigration).not.toMatch(/CREATE\s+(?:UNIQUE\s+)?INDEX\b/iu);
  });
});

describe('planMigrationRun：待执行计划与不可变性判定', () => {
  const available = [descriptor('0001'), descriptor('0002')];

  it('未应用的迁移进入 pending', () => {
    const plan = planMigrationRun({ applied: [], available });
    expect(plan.pending.map((item) => item.version)).toEqual(['0001', '0002']);
    expect(plan.upToDate).toBe(false);
  });

  it('全部已应用且校验和一致时 upToDate', () => {
    const plan = planMigrationRun({
      applied: [
        { version: '0001', name: 'demo', checksum: 'checksum-0001' },
        { version: '0002', name: 'demo', checksum: 'checksum-0002' },
      ],
      available,
    });
    expect(plan.upToDate).toBe(true);
    expect(plan.pending).toEqual([]);
    expect(plan.checksumMismatches).toEqual([]);
    expect(plan.unknownApplied).toEqual([]);
  });

  it('已应用迁移内容被改写时报告校验和不一致，并在执行前 fail-closed', () => {
    const plan = planMigrationRun({
      applied: [{ version: '0001', name: 'demo', checksum: 'old-checksum' }],
      available,
    });
    expect(plan.checksumMismatches).toEqual([
      {
        version: '0001',
        fileName: '0001_demo.sql',
        appliedChecksum: 'old-checksum',
        availableChecksum: 'checksum-0001',
      },
    ]);
    expect(captureMigrationError(() => assertMigrationPlanRunnable(plan)).code).toBe(
      'MIGRATION_CHECKSUM_MISMATCH',
    );
  });

  it('数据库版本领先于代码时报告 unknownApplied，并在执行前 fail-closed', () => {
    const plan = planMigrationRun({
      applied: [{ version: '0009', name: 'future', checksum: 'checksum-0009' }],
      available,
    });
    expect(plan.unknownApplied.map((item) => item.version)).toEqual(['0009']);
    expect(captureMigrationError(() => assertMigrationPlanRunnable(plan)).code).toBe(
      'MIGRATION_APPLIED_UNKNOWN',
    );
  });

  it('计划可执行时不抛错', () => {
    expect(() =>
      assertMigrationPlanRunnable(planMigrationRun({ applied: [], available })),
    ).not.toThrow();
  });
});

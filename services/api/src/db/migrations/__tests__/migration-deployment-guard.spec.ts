import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { computeMigrationChecksum, type MigrationApplication } from '../migration-boundary';
import {
  analyzeTransactionEnvelope,
  assertMigrationDeploymentGuard,
  collectMigrationDeploymentCandidates,
  collectNonTransactionalDdlRules,
  collectUnparameterizedDynamicIdentifiers,
  DRAFT_ONLY_HEADER_FIELDS,
  evaluateMigrationDeploymentGuard,
  isEmptyStatementBody,
  isRegisteredDeploymentSource,
  MIGRATION_DEPLOYMENT_ENVIRONMENTS,
  MIGRATION_DEPLOYMENT_GUARD_CONTRACT,
  MIGRATION_DEPLOYMENT_SOURCE_DIRECTORY,
  MIGRATION_DRAFT_SOURCE_DIRECTORY,
  MigrationDeploymentGuardError,
  normalizeRepositoryPath,
  stripSqlComments,
  UNPARAMETERIZED_DYNAMIC_IDENTIFIER_RULE_IDS,
  type MigrationDeploymentGuardInput,
  type MigrationDeploymentCandidate,
} from '../migration-deployment-guard';

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
const MIGRATIONS_DIR = join(REPO_ROOT, 'db', 'migrations');
const DRAFTS_DIR = join(REPO_ROOT, 'db', 'schema-drafts');

const SAFE_BODY = 'CREATE TABLE IF NOT EXISTS demo_table (id uuid PRIMARY KEY);';

/** 生成一份合规迁移（头部字段齐全、显式事务、命名与头部一致） */
function migrationSql(version: string, name: string, body: string = SAFE_BODY): string {
  return [
    `-- migration: ${version}_${name}`,
    '-- description: 测试用迁移',
    '-- reversible: 是（DROP TABLE demo_table）',
    '-- owner: 测试',
    '',
    'BEGIN;',
    '',
    body,
    '',
    'COMMIT;',
  ].join('\n');
}

function candidate(
  fileName: string,
  content: string,
  overrides: Partial<MigrationDeploymentCandidate> = {},
): MigrationDeploymentCandidate {
  return {
    fileName,
    relativePath: `${MIGRATION_DEPLOYMENT_SOURCE_DIRECTORY}/${fileName}`,
    source: 'migration-directory',
    content,
    checksum: computeMigrationChecksum(content),
    ...overrides,
  };
}

function guardInput(
  overrides: Partial<MigrationDeploymentGuardInput> = {},
): MigrationDeploymentGuardInput {
  return {
    environment: 'test',
    sourceDirectory: MIGRATION_DEPLOYMENT_SOURCE_DIRECTORY,
    candidates: [candidate('0001_bootstrap.sql', migrationSql('0001', 'bootstrap'))],
    applied: [],
    ...overrides,
  };
}

function codesOf(input: MigrationDeploymentGuardInput): readonly string[] {
  return evaluateMigrationDeploymentGuard(input).violations.map((item) => item.code);
}

function boundaryCodesOf(input: MigrationDeploymentGuardInput): readonly (string | undefined)[] {
  return evaluateMigrationDeploymentGuard(input)
    .violations.filter((item) => item.code === 'DEPLOY_MIGRATION_BOUNDARY_VIOLATION')
    .map((item) => item.boundaryCode);
}

// ---------------------------------------------------------------------------
// 契约身份与真实仓库数据
// ---------------------------------------------------------------------------

describe('部署守卫契约：身份与来源目录', () => {
  it('契约常量固定部署来源、草案目录、校验和口径与不可改写语义', () => {
    expect(MIGRATION_DEPLOYMENT_GUARD_CONTRACT).toEqual({
      id: 'migration-deployment-guard',
      version: 1,
      sourceDirectory: 'db/migrations',
      draftDirectory: 'db/schema-drafts',
      checksum: 'sha256-lf-normalized',
      immutableAfterApply: true,
      requireTransactionBoundary: true,
    });
    expect(MIGRATION_DEPLOYMENT_SOURCE_DIRECTORY).toBe('db/migrations');
    expect(MIGRATION_DRAFT_SOURCE_DIRECTORY).toBe('db/schema-drafts');
    expect(MIGRATION_DEPLOYMENT_ENVIRONMENTS).toEqual([
      'development',
      'test',
      'staging',
      'production',
    ]);
    expect(UNPARAMETERIZED_DYNAMIC_IDENTIFIER_RULE_IDS).toEqual([
      'template-placeholder',
      'execute-concatenation',
      'format-string-interpolation',
    ]);
    expect(DRAFT_ONLY_HEADER_FIELDS).toEqual(['-- draft:', '-- target-table:', '-- status:']);
  });

  it('只有 db/migrations 是登记来源；反斜杠写法归一化后同样被接受', () => {
    expect(isRegisteredDeploymentSource('db/migrations')).toBe(true);
    expect(isRegisteredDeploymentSource('db\\migrations')).toBe(true);
    expect(isRegisteredDeploymentSource(' db/migrations ')).toBe(true);
    expect(isRegisteredDeploymentSource('db/schema-drafts')).toBe(false);
    expect(isRegisteredDeploymentSource('')).toBe(false);
    expect(normalizeRepositoryPath('db\\migrations\\0001_bootstrap.sql')).toBe(
      'db/migrations/0001_bootstrap.sql',
    );
  });

  it('真实 db/migrations 通过：采集候选、判定为可执行且给出升序执行顺序', () => {
    const REAL_MIGRATIONS = [
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
      '0015_export_jobs_expiry.sql',
      '0016_export_jobs_revocation.sql',
    ];
    const candidates = collectMigrationDeploymentCandidates(MIGRATIONS_DIR);
    expect(candidates.map((item) => item.fileName)).toEqual(REAL_MIGRATIONS);
    expect(candidates[0]?.source).toBe('migration-directory');
    expect(candidates[0]?.relativePath).toBe('db/migrations/0001_bootstrap.sql');
    expect(candidates[0]?.checksum).toBe(computeMigrationChecksum(candidates[0]?.content ?? ''));

    const report = evaluateMigrationDeploymentGuard(
      guardInput({ environment: 'production', candidates }),
    );
    expect(report.violations).toEqual([]);
    expect(report.ok).toBe(true);
    expect(report.checkedFiles).toEqual(REAL_MIGRATIONS);
    expect(report.pendingVersions).toEqual([
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
      '0015',
      '0016',
    ]);
    expect(report.executionOrder).toEqual([
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
      '0015',
      '0016',
    ]);
  });

  it('真实 db/schema-drafts 作为部署来源被整体拒绝（草案永不部署）', () => {
    const candidates = collectMigrationDeploymentCandidates(
      DRAFTS_DIR,
      MIGRATION_DRAFT_SOURCE_DIRECTORY,
    );
    // 期望集合**由目录实际内容推导**：公开仓库必须带小组草案，但不写死「本地、不入公开仓库」
    // 的合规草案文件名，也不允许漏读任何一份已存在的草案（否则「整体拒绝」会因漏读而失效）。
    const draftsOnDisk = readdirSync(DRAFTS_DIR)
      .filter((name) => name.endsWith('.draft.sql'))
      .sort();
    expect(draftsOnDisk).toContain('0001_research_groups.draft.sql');
    expect(candidates.length).toBeGreaterThan(0);
    expect(candidates.map((item) => item.fileName).sort()).toEqual(draftsOnDisk);
    expect(candidates.every((item) => item.source === 'schema-draft-directory')).toBe(true);
    expect(candidates[0]?.source).toBe('schema-draft-directory');

    const report = evaluateMigrationDeploymentGuard(
      guardInput({
        environment: 'staging',
        sourceDirectory: MIGRATION_DRAFT_SOURCE_DIRECTORY,
        candidates,
      }),
    );
    expect(report.ok).toBe(false);
    const codes = report.violations.map((item) => item.code);
    expect(codes).toContain('DEPLOY_SOURCE_NOT_MIGRATION_DIRECTORY');
    expect(codes).toContain('DEPLOY_SCHEMA_DRAFT_REJECTED');
    expect(codes).toContain('DEPLOY_FILE_PATH_ESCAPES_SOURCE');
  });

  it('守卫模块只依赖 node 内置与同目录模块：不引入数据库驱动、不连接数据库', () => {
    const source = readFileSync(
      join(
        REPO_ROOT,
        'services',
        'api',
        'src',
        'db',
        'migrations',
        'migration-deployment-guard.ts',
      ),
      'utf8',
    );
    const specifiers = [
      // 跨行 import { ... } from '...' 也要覆盖（`[^;]*?` 阻止跨语句误配）
      ...source.matchAll(/^\s*import\b[^;]*?\bfrom\s*['"]([^'"]+)['"]/gmu),
      ...source.matchAll(/^\s*import\s+['"]([^'"]+)['"]/gmu),
    ].map((match) => match[1] ?? '');
    expect(specifiers.slice().sort()).toEqual([
      './migration-boundary',
      './schema-draft',
      'node:fs',
      'node:path',
    ]);
    expect(source).not.toMatch(/\bfrom\s+['"](?:pg|pg-pool|postgres|typeorm|@prisma)/u);
    expect(source).not.toMatch(/\bcreateConnection\b|\bnew\s+Pool\b|\bDATABASE_URL\b/u);
  });
});

// ---------------------------------------------------------------------------
// 基线合成输入
// ---------------------------------------------------------------------------

describe('合成输入基线：模板本身必须通过', () => {
  it('合规候选、合规环境与来源全部通过', () => {
    const report = evaluateMigrationDeploymentGuard(guardInput());
    expect(report).toEqual({
      ok: true,
      violations: [],
      checkedFiles: ['0001_bootstrap.sql'],
      pendingVersions: ['0001'],
      executionOrder: ['0001'],
    });
  });

  it('空候选集拒绝（枚举口径指错不得静默放行）', () => {
    expect(codesOf(guardInput({ candidates: [] }))).toEqual(['DEPLOY_CANDIDATE_SET_EMPTY']);
  });

  it('未知环境拒绝；四个登记环境放行', () => {
    expect(codesOf(guardInput({ environment: 'prod' }))).toEqual(['DEPLOY_ENVIRONMENT_UNKNOWN']);
    expect(codesOf(guardInput({ environment: '' }))).toEqual(['DEPLOY_ENVIRONMENT_UNKNOWN']);
    for (const environment of MIGRATION_DEPLOYMENT_ENVIRONMENTS) {
      expect(codesOf(guardInput({ environment }))).toEqual([]);
    }
  });
});

// ---------------------------------------------------------------------------
// 规则 1：命名、头部、顺序、唯一版本
// ---------------------------------------------------------------------------

describe('规则 1：命名 / 头部 / 顺序 / 唯一版本（复用 migration-boundary 口径）', () => {
  it.each(['bootstrap.sql', '0001-Bootstrap.sql', '1_bootstrap.sql', '0001_bootstrap.SQL'])(
    '文件名 %s 不合规 → DEPLOY_MIGRATION_BOUNDARY_VIOLATION(MIGRATION_FILE_NAME_INVALID)',
    (fileName) => {
      const input = guardInput({
        candidates: [candidate(fileName, migrationSql('0001', 'bootstrap'))],
      });
      const report = evaluateMigrationDeploymentGuard(input);
      expect(report.ok).toBe(false);
      expect(report.violations.map((item) => item.code)).toContain(
        'DEPLOY_MIGRATION_BOUNDARY_VIOLATION',
      );
      expect(
        report.violations.find((item) => item.code === 'DEPLOY_MIGRATION_BOUNDARY_VIOLATION')
          ?.boundaryCode,
      ).toBe('MIGRATION_FILE_NAME_INVALID');
    },
  );

  it('头部缺字段 → MIGRATION_HEADER_FIELD_MISSING', () => {
    const missing = migrationSql('0001', 'bootstrap').replace(
      '-- reversible: 是（DROP TABLE demo_table）\n',
      '',
    );
    expect(
      boundaryCodesOf(guardInput({ candidates: [candidate('0001_bootstrap.sql', missing)] })),
    ).toEqual(['MIGRATION_HEADER_FIELD_MISSING']);
  });

  it('BEGIN/COMMIT 不配对 → MIGRATION_TRANSACTION_UNBALANCED', () => {
    const unbalanced = migrationSql('0001', 'bootstrap').replace('COMMIT;', '');
    expect(
      boundaryCodesOf(guardInput({ candidates: [candidate('0001_bootstrap.sql', unbalanced)] })),
    ).toEqual(['MIGRATION_TRANSACTION_UNBALANCED']);
  });

  it('头部 -- migration: 与文件名不一致 → DEPLOY_HEADER_NAME_MISMATCH', () => {
    const mismatched = migrationSql('0001', 'bootstrap').replace(
      '-- migration: 0001_bootstrap',
      '-- migration: 0001_something_else',
    );
    expect(
      codesOf(guardInput({ candidates: [candidate('0001_bootstrap.sql', mismatched)] })),
    ).toContain('DEPLOY_HEADER_NAME_MISMATCH');
  });

  it('版本重复 → MIGRATION_VERSION_DUPLICATE（解析不完整时不再做计划判定）', () => {
    const input = guardInput({
      candidates: [
        candidate('0001_alpha.sql', migrationSql('0001', 'alpha')),
        candidate('0001_beta.sql', migrationSql('0001', 'beta')),
      ],
      applied: [{ version: '0009', name: 'future', checksum: 'x' }],
    });
    const report = evaluateMigrationDeploymentGuard(input);
    expect(report.ok).toBe(false);
    expect(boundaryCodesOf(input)).toEqual(['MIGRATION_VERSION_DUPLICATE']);
    // 解析不完整 → 不产生「已应用版本未知」这类误导性违规
    expect(report.violations.map((item) => item.code)).not.toContain(
      'DEPLOY_APPLIED_VERSION_UNKNOWN',
    );
    expect(report.pendingVersions).toEqual(['0001', '0001']);
  });

  it('执行器声明的执行顺序必须等于「待执行集合按版本升序」', () => {
    const candidates = [
      candidate('0001_alpha.sql', migrationSql('0001', 'alpha')),
      candidate('0002_beta.sql', migrationSql('0002', 'beta')),
    ];
    expect(codesOf(guardInput({ candidates, deploymentOrder: ['0001', '0002'] }))).toEqual([]);
    expect(codesOf(guardInput({ candidates, deploymentOrder: ['0002', '0001'] }))).toContain(
      'DEPLOY_EXECUTION_ORDER_MISMATCH',
    );
    // 漏跑一个版本同样是顺序不符
    expect(codesOf(guardInput({ candidates, deploymentOrder: ['0001'] }))).toContain(
      'DEPLOY_EXECUTION_ORDER_MISMATCH',
    );
  });
});

// ---------------------------------------------------------------------------
// 规则 2：拒绝 schema draft 误部署
// ---------------------------------------------------------------------------

describe('规则 2：拒绝 schema draft 误部署', () => {
  it('*.draft.sql 放进 db/migrations → 只判草案误部署，不再叠加边界噪音', () => {
    const draft = [
      '-- draft: 0001_demo',
      '-- description: 草案',
      '-- target-table: demo_table',
      '-- status: 未应用（草案）',
      '',
      'BEGIN;',
      'CREATE TABLE IF NOT EXISTS demo_table (id uuid PRIMARY KEY);',
      'COMMIT;',
    ].join('\n');
    const input = guardInput({
      candidates: [candidate('0001_research_groups.draft.sql', draft)],
    });
    expect(codesOf(input)).toEqual(['DEPLOY_SCHEMA_DRAFT_REJECTED']);
  });

  it('草案专属头部字段出现在迁移头部 → DEPLOY_DRAFT_HEADER_IN_MIGRATION', () => {
    const smuggled = migrationSql('0002', 'users').replace(
      '-- description: 测试用迁移',
      '-- target-table: users\n-- status: 未应用（草案）',
    );
    expect(codesOf(guardInput({ candidates: [candidate('0002_users.sql', smuggled)] }))).toContain(
      'DEPLOY_DRAFT_HEADER_IN_MIGRATION',
    );
  });

  it('内联 / 未知来源的候选一律拒绝部署', () => {
    for (const source of ['inline', 'unknown'] as const) {
      const input = guardInput({
        candidates: [
          candidate('0001_bootstrap.sql', migrationSql('0001', 'bootstrap'), { source }),
        ],
      });
      expect(codesOf(input)).toContain('DEPLOY_SOURCE_NOT_MIGRATION_DIRECTORY');
    }
  });

  it.each([
    '/abs/db/migrations/0001_bootstrap.sql',
    'db/migrations/nested/0001_bootstrap.sql',
    '../outside/0001_bootstrap.sql',
    'db/migrations/../db/migrations/0001_bootstrap.sql',
  ])('候选路径 %s 逃出登记来源 → DEPLOY_FILE_PATH_ESCAPES_SOURCE', (relativePath) => {
    const input = guardInput({
      candidates: [
        candidate('0001_bootstrap.sql', migrationSql('0001', 'bootstrap'), { relativePath }),
      ],
    });
    expect(codesOf(input)).toContain('DEPLOY_FILE_PATH_ESCAPES_SOURCE');
  });

  it('Windows 反斜杠路径归一化后不算逃逸', () => {
    const input = guardInput({
      candidates: [
        candidate('0001_bootstrap.sql', migrationSql('0001', 'bootstrap'), {
          relativePath: 'db\\migrations\\0001_bootstrap.sql',
        }),
      ],
    });
    expect(codesOf(input)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 规则 3：危险非事务 DDL 与事务原子性
// ---------------------------------------------------------------------------

describe('规则 3：拒绝危险非事务 DDL', () => {
  it.each([
    ['CREATE INDEX CONCURRENTLY', 'CREATE INDEX CONCURRENTLY idx_demo ON demo_table (id);'],
    ['DROP INDEX CONCURRENTLY', 'DROP INDEX CONCURRENTLY idx_demo;'],
    ['REINDEX CONCURRENTLY', 'REINDEX TABLE CONCURRENTLY demo_table;'],
    ['VACUUM', 'VACUUM FULL demo_table;'],
    ['CLUSTER', 'CLUSTER demo_table USING idx_demo;'],
    ['CREATE DATABASE', 'CREATE DATABASE other_db;'],
    ['DROP DATABASE', 'DROP DATABASE other_db;'],
    ['CREATE TABLESPACE', "CREATE TABLESPACE ts_demo LOCATION '/srv/pg/ts_demo';"],
    ['DROP TABLESPACE', 'DROP TABLESPACE ts_demo;'],
    ['ALTER SYSTEM', "ALTER SYSTEM SET work_mem = '64MB';"],
    ['ALTER TYPE ... ADD VALUE', "ALTER TYPE demo_status ADD VALUE 'paused';"],
    ['CREATE SUBSCRIPTION', "CREATE SUBSCRIPTION sub_demo CONNECTION 'host=db';"],
    ['DROP SUBSCRIPTION', 'DROP SUBSCRIPTION sub_demo;'],
  ])('%s 出现在迁移里 → DEPLOY_NON_TRANSACTIONAL_DDL', (statement, body) => {
    const content = migrationSql('0002', 'demo', body);
    expect(collectNonTransactionalDdlRules(content).map((rule) => rule.statement)).toContain(
      statement,
    );
    const report = evaluateMigrationDeploymentGuard(
      guardInput({ candidates: [candidate('0002_demo.sql', content)] }),
    );
    const violation = report.violations.find(
      (item) => item.code === 'DEPLOY_NON_TRANSACTIONAL_DDL',
    );
    expect(violation?.detail).toContain(statement);
  });

  it('注释里提到的危险语句不触发；安全等价写法放行', () => {
    const commented = [
      '-- migration: 0002_demo',
      '-- description: 说明',
      '-- reversible: 否',
      '',
      'BEGIN;',
      '-- 注意：本迁移不使用 CREATE INDEX CONCURRENTLY，也不使用 VACUUM',
      'CREATE INDEX IF NOT EXISTS idx_demo ON demo_table (id);',
      'COMMIT;',
    ].join('\n');
    expect(collectNonTransactionalDdlRules(commented)).toEqual([]);
    expect(codesOf(guardInput({ candidates: [candidate('0002_demo.sql', commented)] }))).toEqual(
      [],
    );
  });

  it('字符串字面量里的语句名（COMMENT ON）不触发', () => {
    const content = migrationSql(
      '0002_demo',
      'demo',
      "COMMENT ON TABLE demo_table IS '禁止执行 DROP DATABASE';",
    );
    expect(collectNonTransactionalDdlRules(content)).toEqual([]);
  });
});

describe('规则 3：事务原子性（显式边界 / 单段事务 / 块内无遗漏）', () => {
  const noTransaction = [
    '-- migration: 0002_demo',
    '-- description: 无事务迁移',
    '-- reversible: 否（需人工恢复）',
    '',
    'CREATE TABLE IF NOT EXISTS demo_table (id uuid PRIMARY KEY);',
  ].join('\n');

  it('缺少显式 BEGIN/COMMIT → DEPLOY_TRANSACTION_BOUNDARY_REQUIRED（默认要求）', () => {
    const input = guardInput({ candidates: [candidate('0002_demo.sql', noTransaction)] });
    expect(codesOf(input)).toContain('DEPLOY_TRANSACTION_BOUNDARY_REQUIRED');
    expect(
      codesOf(
        guardInput({
          candidates: [candidate('0002_demo.sql', noTransaction)],
          requireTransactionBoundary: false,
        }),
      ),
    ).not.toContain('DEPLOY_TRANSACTION_BOUNDARY_REQUIRED');
  });

  it('多段事务 → DEPLOY_MULTIPLE_TRANSACTIONS', () => {
    const content = [
      '-- migration: 0002_demo',
      '-- description: 两段事务',
      '-- reversible: 否',
      '',
      'BEGIN;',
      'CREATE TABLE IF NOT EXISTS demo_table (id uuid PRIMARY KEY);',
      'COMMIT;',
      'BEGIN;',
      'CREATE INDEX IF NOT EXISTS idx_demo ON demo_table (id);',
      'COMMIT;',
    ].join('\n');
    const envelope = analyzeTransactionEnvelope(content);
    expect(envelope).toMatchObject({
      beginCount: 2,
      commitCount: 2,
      hasExplicitTransaction: true,
      multipleTransactions: true,
      statementsOutside: false,
    });
    expect(codesOf(guardInput({ candidates: [candidate('0002_demo.sql', content)] }))).toContain(
      'DEPLOY_MULTIPLE_TRANSACTIONS',
    );
  });

  it('事务块之外仍有语句 → DEPLOY_STATEMENT_OUTSIDE_TRANSACTION', () => {
    const content = [
      '-- migration: 0002_demo',
      '-- description: 块外语句',
      '-- reversible: 否',
      '',
      'SET search_path = public;',
      'BEGIN;',
      'CREATE TABLE IF NOT EXISTS demo_table (id uuid PRIMARY KEY);',
      'COMMIT;',
    ].join('\n');
    expect(analyzeTransactionEnvelope(content).statementsOutside).toBe(true);
    expect(codesOf(guardInput({ candidates: [candidate('0002_demo.sql', content)] }))).toContain(
      'DEPLOY_STATEMENT_OUTSIDE_TRANSACTION',
    );
  });

  it('空迁移（只有注释）→ DEPLOY_FILE_EMPTY', () => {
    const content = ['-- migration: 0002_demo', '-- description: 空', '-- reversible: 否'].join(
      '\n',
    );
    expect(isEmptyStatementBody(content)).toBe(true);
    expect(isEmptyStatementBody(migrationSql('0001', 'bootstrap'))).toBe(false);
    expect(codesOf(guardInput({ candidates: [candidate('0002_demo.sql', content)] }))).toContain(
      'DEPLOY_FILE_EMPTY',
    );
  });
});

// ---------------------------------------------------------------------------
// 规则 4：未参数化动态标识符
// ---------------------------------------------------------------------------

describe('规则 4：拒绝未参数化动态标识符', () => {
  it.each([
    ['template-placeholder', "EXECUTE 'DROP TABLE ${tableName}';"],
    ['execute-concatenation', "EXECUTE 'DROP TABLE ' || target_name;"],
    ['execute-concatenation', "EXECUTE IMMEDIATE 'DROP TABLE ' || target_name;"],
    ['format-string-interpolation', "EXECUTE format('DROP TABLE %s', target_name);"],
  ])('%s 由 %s 触发', (rule, body) => {
    const content = migrationSql('0002', 'demo', body);
    expect(
      collectUnparameterizedDynamicIdentifiers(content).map((finding) => finding.rule),
    ).toContain(rule);
    expect(codesOf(guardInput({ candidates: [candidate('0002_demo.sql', content)] }))).toContain(
      'DEPLOY_UNPARAMETERIZED_DYNAMIC_IDENTIFIER',
    );
  });

  it('DO $$ ... $$ 块内的动态 SQL 同样被扫描（注释剥离不破坏块内容）', () => {
    const body = ['DO $$', 'BEGIN', "  EXECUTE 'DROP TABLE ' || tablename;", 'END', '$$;'].join(
      '\n',
    );
    const content = migrationSql('0002', 'demo', body);
    expect(stripSqlComments(content)).toContain("EXECUTE 'DROP TABLE ' || tablename;");
    expect(
      collectUnparameterizedDynamicIdentifiers(content).map((finding) => finding.rule),
    ).toContain('execute-concatenation');
  });

  it.each([
    "EXECUTE format('DROP TABLE %I', target_name);",
    "EXECUTE 'DROP TABLE ' || quote_ident(target_name);",
    "EXECUTE 'SET search_path = public';",
    "PERFORM format('%L', 'x');",
  ])('参数化写法放行: %s', (body) => {
    const content = migrationSql('0002', 'demo', body);
    expect(collectUnparameterizedDynamicIdentifiers(content)).toEqual([]);
  });

  it('注释里的动态 SQL 示例不触发', () => {
    const content = migrationSql('0002', 'demo', SAFE_BODY).replace(
      '-- owner: 测试',
      "-- owner: 测试\n-- 反例：EXECUTE 'DROP TABLE ' || tablename;",
    );
    expect(collectUnparameterizedDynamicIdentifiers(content)).toEqual([]);
  });

  it('违规片段被截断，不把整份 SQL 塞进报告', () => {
    const body = `EXECUTE 'DROP TABLE ' || target_name_with_a_very_long_identifier_that_keeps_going;`;
    const findings = collectUnparameterizedDynamicIdentifiers(migrationSql('0002', 'demo', body));
    expect(findings).toHaveLength(1);
    expect(findings[0]?.snippet.length).toBeLessThanOrEqual(61);
    expect(findings[0]?.snippet).not.toContain('\n');
  });
});

// ---------------------------------------------------------------------------
// 规则 5：校验和与来源边界
// ---------------------------------------------------------------------------

describe('规则 5：校验和与已应用记录比对', () => {
  const available = [
    candidate('0001_bootstrap.sql', migrationSql('0001', 'bootstrap')),
    candidate('0002_demo.sql', migrationSql('0002', 'demo')),
  ];

  function appliedOf(...indexes: readonly number[]): readonly MigrationApplication[] {
    return indexes.map((index) => {
      const item = available[index];
      if (item === undefined) {
        throw new Error(`测试前置失败：候选 ${index} 不存在`);
      }
      return { version: item.fileName.slice(0, 4), name: 'demo', checksum: item.checksum };
    });
  }

  it('声明校验和与重算结果不一致（或不是 64 位小写十六进制）→ DEPLOY_CHECKSUM_UNVERIFIED', () => {
    for (const checksum of ['deadbeef', 'A'.repeat(64), computeMigrationChecksum('tampered')]) {
      expect(
        codesOf(
          guardInput({
            candidates: [
              candidate('0001_bootstrap.sql', migrationSql('0001', 'bootstrap'), { checksum }),
            ],
          }),
        ),
      ).toContain('DEPLOY_CHECKSUM_UNVERIFIED');
    }
  });

  it('已应用内容被改写 → DEPLOY_CHECKSUM_MISMATCH（按版本定位）', () => {
    const report = evaluateMigrationDeploymentGuard(
      guardInput({
        candidates: available,
        applied: [{ version: '0001', name: 'bootstrap', checksum: 'old-checksum' }],
      }),
    );
    const mismatch = report.violations.find((item) => item.code === 'DEPLOY_CHECKSUM_MISMATCH');
    expect(mismatch?.subject).toBe('0001');
    expect(mismatch?.detail).toContain('0001_bootstrap.sql');
  });

  it('数据库里存在代码里没有的版本 → DEPLOY_APPLIED_VERSION_UNKNOWN', () => {
    const report = evaluateMigrationDeploymentGuard(
      guardInput({
        candidates: available,
        applied: [{ version: '0009', name: 'future', checksum: 'x' }],
      }),
    );
    expect(
      report.violations.find((item) => item.code === 'DEPLOY_APPLIED_VERSION_UNKNOWN')?.subject,
    ).toBe('0009');
  });

  it('已应用版本不是可用序列的前缀 → DEPLOY_APPLIED_ORDER_INVALID', () => {
    const report = evaluateMigrationDeploymentGuard(
      guardInput({ candidates: available, applied: appliedOf(1) }),
    );
    const violation = report.violations.find(
      (item) => item.code === 'DEPLOY_APPLIED_ORDER_INVALID',
    );
    expect(violation?.subject).toBe('0002');
    expect(report.pendingVersions).toEqual(['0001']);
  });

  it('全部已应用且校验和一致 → 通过且 pending 为空', () => {
    const report = evaluateMigrationDeploymentGuard(
      guardInput({ candidates: available, applied: appliedOf(0, 1) }),
    );
    expect(report.violations).toEqual([]);
    expect(report.ok).toBe(true);
    expect(report.pendingVersions).toEqual([]);
    expect(report.executionOrder).toEqual([]);
  });

  it('部分已应用 → pending 只含未应用版本，且执行顺序按版本升序', () => {
    const report = evaluateMigrationDeploymentGuard(
      guardInput({ candidates: available, applied: appliedOf(0) }),
    );
    expect(report.pendingVersions).toEqual(['0002']);
    expect(report.executionOrder).toEqual(['0002']);
    expect(report.checkedFiles).toEqual(['0001_bootstrap.sql', '0002_demo.sql']);
  });
});

// ---------------------------------------------------------------------------
// 断言版
// ---------------------------------------------------------------------------

describe('assertMigrationDeploymentGuard：抛出可定位且不含机密的错误', () => {
  it('违规时抛 MigrationDeploymentGuardError，列出全部主体与代码', () => {
    let captured: unknown;
    try {
      assertMigrationDeploymentGuard(
        guardInput({
          environment: 'prod',
          candidates: [
            candidate(
              '0002_demo.sql',
              migrationSql(
                '0002',
                'demo',
                'CREATE INDEX CONCURRENTLY idx_demo ON demo_table (id);',
              ),
              { relativePath: '/tmp/0002_demo.sql' },
            ),
          ],
        }),
      );
    } catch (error) {
      captured = error;
    }
    expect(captured).toBeInstanceOf(MigrationDeploymentGuardError);
    const guardError = captured as MigrationDeploymentGuardError;
    const codes = guardError.violations.map((item) => item.code);
    expect(codes).toEqual(
      expect.arrayContaining([
        'DEPLOY_ENVIRONMENT_UNKNOWN',
        'DEPLOY_FILE_PATH_ESCAPES_SOURCE',
        'DEPLOY_NON_TRANSACTIONAL_DDL',
      ]),
    );
    expect(guardError.message).toContain('0002_demo.sql[DEPLOY_NON_TRANSACTIONAL_DDL]');
    expect(guardError.message).not.toContain('://');
    expect(guardError.message).not.toContain('@');
  });

  it('通过时返回报告，不抛错', () => {
    const report = assertMigrationDeploymentGuard(guardInput({ environment: 'production' }));
    expect(report.ok).toBe(true);
    expect(report.executionOrder).toEqual(['0001']);
  });
});

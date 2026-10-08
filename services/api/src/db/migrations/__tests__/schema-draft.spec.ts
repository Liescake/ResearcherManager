import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  collectSchemaDraftViolations,
  describeSchemaDraftFile,
  readSchemaDraftDirectory,
  SchemaDraftError,
} from '../schema-draft';

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

const VALID_DRAFT = [
  '-- draft: 0001_demo',
  '-- description: 演示草案',
  '-- target-table: demo_table',
  '-- status: 未应用（草案）',
  '-- owner: 测试',
  '',
  'BEGIN;',
  '',
  'CREATE TABLE IF NOT EXISTS demo_table (',
  '  id         uuid PRIMARY KEY,',
  '  name       varchar(100) NOT NULL,',
  '  created_at timestamptz NOT NULL DEFAULT now(),',
  '  updated_at timestamptz NOT NULL DEFAULT now(),',
  '  deleted_at timestamptz',
  ');',
  '',
  'COMMIT;',
].join('\n');

describe('schema 草案规则：与 db/schema-drafts 的真实文件对齐', () => {
  it('读取 db/schema-drafts 并通过全部静态规则', () => {
    const repoRoot = findRepoRoot(process.cwd());
    const drafts = readSchemaDraftDirectory(join(repoRoot, 'db', 'schema-drafts'));

    expect(drafts.map((item) => item.fileName)).toEqual(['0001_research_groups.draft.sql']);
    expect(drafts[0]).toMatchObject({
      version: '0001',
      name: 'research_groups',
      targetTable: 'research_groups',
      // 草案永远不代表「已应用」
      applied: false,
    });
    expect(drafts[0]?.checksum).toMatch(/^[0-9a-f]{64}$/u);
  });

  it('合规草案没有违规项', () => {
    expect(collectSchemaDraftViolations('0001_demo.draft.sql', VALID_DRAFT)).toEqual([]);
    expect(describeSchemaDraftFile('0001_demo.draft.sql', VALID_DRAFT)).toMatchObject({
      targetTable: 'demo_table',
      applied: false,
    });
  });

  it('缺少 .draft 后缀或命名不合规时判违规', () => {
    expect(collectSchemaDraftViolations('0001_demo.sql', VALID_DRAFT)).toEqual([
      'SCHEMA_DRAFT_FILE_NAME_INVALID',
    ]);
  });

  it('缺少必填头部字段、事务不配对时判违规', () => {
    const missingStatus = VALID_DRAFT.replace('-- status: 未应用（草案）\n', '');
    expect(collectSchemaDraftViolations('0001_demo.draft.sql', missingStatus)).toContain(
      'SCHEMA_DRAFT_HEADER_FIELD_MISSING',
    );

    const unbalanced = VALID_DRAFT.replace('COMMIT;', '');
    expect(collectSchemaDraftViolations('0001_demo.draft.sql', unbalanced)).toContain(
      'SCHEMA_DRAFT_TRANSACTION_UNBALANCED',
    );
  });

  it('缺少 IF NOT EXISTS、UUID 主键或审计时间列时判违规', () => {
    const noIfNotExists = VALID_DRAFT.replace(
      'CREATE TABLE IF NOT EXISTS demo_table (',
      'CREATE TABLE demo_table (',
    );
    expect(collectSchemaDraftViolations('0001_demo.draft.sql', noIfNotExists)).toContain(
      'SCHEMA_DRAFT_MISSING_IF_NOT_EXISTS',
    );

    const noUuidPk = VALID_DRAFT.replace('id         uuid PRIMARY KEY,', 'id         bigserial PRIMARY KEY,');
    expect(collectSchemaDraftViolations('0001_demo.draft.sql', noUuidPk)).toContain(
      'SCHEMA_DRAFT_MISSING_UUID_PRIMARY_KEY',
    );

    const noTimestamps = VALID_DRAFT.replace(
      /  created_at timestamptz NOT NULL DEFAULT now\(\),\n  updated_at timestamptz NOT NULL DEFAULT now\(\),\n/u,
      '',
    );
    expect(collectSchemaDraftViolations('0001_demo.draft.sql', noTimestamps)).toContain(
      'SCHEMA_DRAFT_MISSING_AUDIT_TIMESTAMPS',
    );
  });

  it('无时区 timestamp 判违规，注释里的示例文本不触发', () => {
    const naive = VALID_DRAFT.replace(
      'created_at timestamptz NOT NULL DEFAULT now()',
      'created_at timestamp NOT NULL DEFAULT now()',
    );
    expect(collectSchemaDraftViolations('0001_demo.draft.sql', naive)).toContain(
      'SCHEMA_DRAFT_NAIVE_TIMESTAMP',
    );

    const commentOnly = VALID_DRAFT.replace(
      '-- owner: 测试',
      '-- owner: 测试\n-- 注意：不要使用 timestamp（无时区）列',
    );
    expect(collectSchemaDraftViolations('0001_demo.draft.sql', commentOnly)).not.toContain(
      'SCHEMA_DRAFT_NAIVE_TIMESTAMP',
    );
  });

  it('高敏感字段（手机号等）禁止明文索引', () => {
    const plaintextIndex = `${VALID_DRAFT.replace('COMMIT;', '')}
CREATE UNIQUE INDEX IF NOT EXISTS uq_demo_phone ON demo_table (phone);
COMMIT;`;
    expect(collectSchemaDraftViolations('0001_demo.draft.sql', plaintextIndex)).toContain(
      'SCHEMA_DRAFT_PLAINTEXT_SENSITIVE_INDEX',
    );

    const hashIndex = plaintextIndex.replace('(phone)', '(phone_hash)');
    expect(collectSchemaDraftViolations('0001_demo.draft.sql', hashIndex)).not.toContain(
      'SCHEMA_DRAFT_PLAINTEXT_SENSITIVE_INDEX',
    );
  });

  it('target-table 与建表语句不一致时判违规', () => {
    const mismatched = VALID_DRAFT.replace(
      '-- target-table: demo_table',
      '-- target-table: other_table',
    );
    expect(collectSchemaDraftViolations('0001_demo.draft.sql', mismatched)).toContain(
      'SCHEMA_DRAFT_TARGET_TABLE_MISMATCH',
    );
  });

  it('describeSchemaDraftFile 违规时抛 SchemaDraftError 并携带全部违规码', () => {
    let captured: unknown;
    try {
      describeSchemaDraftFile('0001_demo.draft.sql', '-- draft: 0001_demo\nBEGIN;');
    } catch (error) {
      captured = error;
    }
    expect(captured).toBeInstanceOf(SchemaDraftError);
    const draftError = captured as SchemaDraftError;
    expect(draftError.draftViolations).toContain('SCHEMA_DRAFT_HEADER_FIELD_MISSING');
    expect(draftError.message).toContain('0001_demo.draft.sql');
  });
});

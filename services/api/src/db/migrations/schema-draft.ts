import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { computeMigrationChecksum, hasBalancedTransaction } from './migration-boundary';

/**
 * schema 草案边界（**未应用的 SQL 草案**，不是迁移）。
 *
 * 为什么单独一层：ORM / 迁移工具选型尚未完成（docs/P2-开源复用评估.md §1），而
 * `db/migrations/` 的迁移一旦合并即不可修改。因此业务表的 DDL 先以「草案」形式放在
 * `db/schema-drafts/`：
 * - 草案**不进入** `db/migrations/`，`pnpm verify:migrations` 不扫描它，任何 runner 也不得执行它；
 * - 草案通过本模块的静态规则校验（命名、头部字段、事务边界、UUID 主键、timestamptz、
 *   高敏感字段禁止明文索引）；
 * - 选型完成并评审后，草案按 `db/migrations/README.md` 的规范转成 `NNNN_*.sql` 迁移。
 *
 * 本模块只读文件、不连接数据库、不执行 SQL。
 */

/** 草案文件名：`NNNN_snake_case.draft.sql`（`.draft` 后缀是「未应用」的显式标记） */
export const SCHEMA_DRAFT_FILE_PATTERN = /^(\d{4})_([a-z0-9]+(?:_[a-z0-9]+)*)\.draft\.sql$/u;

export const SCHEMA_DRAFT_REQUIRED_HEADER_FIELDS = [
  '-- draft:',
  '-- description:',
  '-- target-table:',
  '-- status:',
] as const;

/** 高敏感字段名（docs/P1-字段级数据字典.md）：只允许存应用层加密值或不可逆 hash，禁止明文索引 */
export const SENSITIVE_COLUMN_PATTERN =
  /^(phone|mobile|student_number|student_no|id_card|id_number|email|wechat_openid|wechat_unionid)$/u;

export type SchemaDraftViolationCode =
  | 'SCHEMA_DRAFT_FILE_NAME_INVALID'
  | 'SCHEMA_DRAFT_HEADER_FIELD_MISSING'
  | 'SCHEMA_DRAFT_TRANSACTION_UNBALANCED'
  | 'SCHEMA_DRAFT_MISSING_IF_NOT_EXISTS'
  | 'SCHEMA_DRAFT_TARGET_TABLE_MISMATCH'
  | 'SCHEMA_DRAFT_MISSING_UUID_PRIMARY_KEY'
  | 'SCHEMA_DRAFT_NAIVE_TIMESTAMP'
  | 'SCHEMA_DRAFT_MISSING_AUDIT_TIMESTAMPS'
  | 'SCHEMA_DRAFT_PLAINTEXT_SENSITIVE_INDEX';

export class SchemaDraftError extends Error {
  readonly draftViolations: readonly SchemaDraftViolationCode[];

  constructor(fileName: string, violations: readonly SchemaDraftViolationCode[]) {
    super(`schema 草案不合规: ${fileName} → ${violations.join(', ')}`);
    this.name = 'SchemaDraftError';
    this.draftViolations = violations;
  }
}

export interface SchemaDraftDescriptor {
  readonly fileName: string;
  readonly version: string;
  readonly name: string;
  readonly targetTable: string;
  readonly checksum: string;
  /** 恒为 false：草案永远不代表「已应用」 */
  readonly applied: false;
}

function headerValue(content: string, field: string): string | undefined {
  for (const line of content.split('\n').slice(0, 12)) {
    const trimmed = line.trim();
    if (trimmed.startsWith(field)) {
      return trimmed.slice(field.length).trim();
    }
  }
  return undefined;
}

/** 去掉 SQL 注释行，避免注释里的示例文本触发规则（例如注释里写 `timestamp`） */
function stripCommentLines(content: string): string {
  return content
    .split('\n')
    .filter((line) => !line.trim().startsWith('--'))
    .join('\n');
}

/**
 * 收集草案违规项（不抛错，便于一次报告全部问题）。
 * 返回空数组表示草案合规。
 */
export function collectSchemaDraftViolations(
  fileName: string,
  content: string,
): readonly SchemaDraftViolationCode[] {
  const violations: SchemaDraftViolationCode[] = [];
  const match = SCHEMA_DRAFT_FILE_PATTERN.exec(fileName);
  if (match === null) {
    return ['SCHEMA_DRAFT_FILE_NAME_INVALID'];
  }

  for (const field of SCHEMA_DRAFT_REQUIRED_HEADER_FIELDS) {
    if (headerValue(content, field) === undefined) {
      violations.push('SCHEMA_DRAFT_HEADER_FIELD_MISSING');
    }
  }
  if (!hasBalancedTransaction(content)) {
    violations.push('SCHEMA_DRAFT_TRANSACTION_UNBALANCED');
  }

  const body = stripCommentLines(content);
  if (!/CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS/iu.test(body)) {
    violations.push('SCHEMA_DRAFT_MISSING_IF_NOT_EXISTS');
  }

  const targetTable = headerValue(content, '-- target-table:');
  if (targetTable === undefined || !/^[a-z][a-z0-9_]*$/u.test(targetTable)) {
    violations.push('SCHEMA_DRAFT_TARGET_TABLE_MISMATCH');
  } else if (
    !new RegExp(`CREATE\\s+TABLE\\s+IF\\s+NOT\\s+EXISTS\\s+${targetTable}\\s*\\(`, 'iu').test(body)
  ) {
    violations.push('SCHEMA_DRAFT_TARGET_TABLE_MISMATCH');
  }

  if (!/\bid\s+uuid\s+PRIMARY\s+KEY\b/iu.test(body)) {
    violations.push('SCHEMA_DRAFT_MISSING_UUID_PRIMARY_KEY');
  }

  // 时间列统一 timestamptz；`timestamp`（无时区）与 `timestamp without time zone` 一律不允许
  if (/\btimestamp\b(?!\s+with\s+time\s+zone)/iu.test(body)) {
    violations.push('SCHEMA_DRAFT_NAIVE_TIMESTAMP');
  }

  if (!/\bcreated_at\b/iu.test(body) || !/\bupdated_at\b/iu.test(body)) {
    violations.push('SCHEMA_DRAFT_MISSING_AUDIT_TIMESTAMPS');
  }

  if (/DROP\s+TABLE(?!\s+IF\s+EXISTS)/iu.test(body)) {
    violations.push('SCHEMA_DRAFT_MISSING_IF_NOT_EXISTS');
  }

  // 高敏感字段禁止明文索引：索引列名命中敏感名单且不是 *_hash 时判违规
  const indexPattern = /CREATE\s+(?:UNIQUE\s+)?INDEX\s+[^\n;]*?\(([^)]*)\)/giu;
  for (const indexMatch of body.matchAll(indexPattern)) {
    const columns = (indexMatch[1] ?? '')
      .split(',')
      .map((column) => column.trim().replace(/["`]/gu, '').toLowerCase());
    for (const column of columns) {
      if (SENSITIVE_COLUMN_PATTERN.test(column)) {
        violations.push('SCHEMA_DRAFT_PLAINTEXT_SENSITIVE_INDEX');
      }
    }
  }

  return [...new Set(violations)];
}

/**
 * 解析并校验单个草案文件。
 *
 * @throws SchemaDraftError 草案不合规（消息里列出全部违规码）
 */
export function describeSchemaDraftFile(
  fileName: string,
  content: string,
): SchemaDraftDescriptor {
  const violations = collectSchemaDraftViolations(fileName, content);
  if (violations.length > 0) {
    throw new SchemaDraftError(fileName, violations);
  }
  const match = SCHEMA_DRAFT_FILE_PATTERN.exec(fileName);
  return {
    fileName,
    version: match?.[1] ?? '',
    name: match?.[2] ?? '',
    targetTable: headerValue(content, '-- target-table:') ?? '',
    checksum: computeMigrationChecksum(content),
    applied: false,
  };
}

/** 读取草案目录（跳过 README 与点文件），按文件名升序返回 */
export function readSchemaDraftDirectory(directory: string): readonly SchemaDraftDescriptor[] {
  const fileNames = readdirSync(directory)
    .filter((entry) => entry !== 'README.md' && !entry.startsWith('.'))
    .sort((left, right) => left.localeCompare(right));
  return fileNames.map((fileName) =>
    describeSchemaDraftFile(fileName, readFileSync(join(directory, fileName), 'utf8')),
  );
}

import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * 迁移边界（**schema 迁移的共享契约**，不含迁移执行器）。
 *
 * 与 `scripts/db-migrations-lint.mjs`（CI 静态门禁）配套：这里提供运行期需要的同一套规则，
 * 并额外承担「不可变性」语义 —— 校验和。`db/migrations/0001_bootstrap.sql` 建立的
 * `schema_migrations(version, name, checksum, applied_at, applied_by, execution_ms)` 正是本模块
 * 产出的数据形状；已应用迁移的内容一旦变化，校验和必须对不上并**人工处理**，不得静默重写。
 *
 * 边界事实：
 * - 只读文件、只做静态解析，**不连接数据库、不执行 SQL**；
 * - 校验和按 LF 归一化后计算，避免 Windows CRLF 检出导致同一份迁移在不同机器上哈希不同；
 * - 本模块不决定「用哪个迁移工具」（Prisma / TypeORM / 纯 SQL runner 尚未选型），
 *   只固定文件命名、头部字段、事务边界与顺序/校验和判定。
 */

/** 迁移文件名：`NNNN_snake_case.sql` */
export const MIGRATION_FILE_PATTERN = /^(\d{4})_([a-z0-9]+(?:_[a-z0-9]+)*)\.sql$/u;

/** 迁移文件头部必须包含的注释字段（与 db/migrations/README.md 一致） */
export const MIGRATION_REQUIRED_HEADER_FIELDS = [
  '-- migration:',
  '-- description:',
  '-- reversible:',
] as const;

export type MigrationBoundaryErrorCode =
  | 'MIGRATION_FILE_NAME_INVALID'
  | 'MIGRATION_HEADER_FIELD_MISSING'
  | 'MIGRATION_TRANSACTION_UNBALANCED'
  | 'MIGRATION_VERSION_DUPLICATE'
  | 'MIGRATION_ORDER_INVALID'
  | 'MIGRATION_CHECKSUM_MISMATCH'
  | 'MIGRATION_APPLIED_UNKNOWN';

export class MigrationBoundaryError extends Error {
  readonly code: MigrationBoundaryErrorCode;

  constructor(code: MigrationBoundaryErrorCode, message: string) {
    super(message);
    this.name = 'MigrationBoundaryError';
    this.code = code;
  }
}

export interface MigrationHeader {
  readonly migration?: string;
  readonly description?: string;
  /** 头部 `reversible` 解析结果：`是/yes/true` → true，`否/no/false` → false，其余 undefined */
  readonly reversible?: boolean;
  readonly owner?: string;
}

export interface MigrationDescriptor {
  readonly fileName: string;
  /** 4 位序号（字符串，保证前导零） */
  readonly version: string;
  readonly name: string;
  /** 归一化内容的 sha256（十六进制） */
  readonly checksum: string;
  readonly reversible: boolean;
  readonly description?: string;
  readonly owner?: string;
}

/** 已应用记录（`schema_migrations` 行） */
export interface MigrationApplication {
  readonly version: string;
  readonly name: string;
  readonly checksum: string;
  readonly appliedAt?: string;
}

export interface MigrationChecksumMismatch {
  readonly version: string;
  readonly fileName: string;
  readonly appliedChecksum: string;
  readonly availableChecksum: string;
}

export interface MigrationPlan {
  readonly pending: readonly MigrationDescriptor[];
  readonly upToDate: boolean;
  /** 已应用迁移的内容被改写：必须人工处理，禁止自动覆盖 */
  readonly checksumMismatches: readonly MigrationChecksumMismatch[];
  /** 数据库里有、代码里没有的版本：说明代码回退到了旧版本，必须人工处理 */
  readonly unknownApplied: readonly MigrationApplication[];
}

/** 归一化换行后再算校验和：同一份迁移在 CRLF / LF 检出下必须得到同一哈希 */
export function computeMigrationChecksum(sql: string): string {
  return createHash('sha256').update(sql.replace(/\r\n/gu, '\n'), 'utf8').digest('hex');
}

function readHeaderLine(content: string, field: string): string | undefined {
  for (const line of content.split('\n').slice(0, 12)) {
    const trimmed = line.trim();
    if (trimmed.startsWith(field)) {
      return trimmed.slice(field.length).trim();
    }
  }
  return undefined;
}

/** 解析头部注释字段；缺失字段不算错误（由 `describeMigrationFile` 统一判定） */
export function parseMigrationHeader(content: string): MigrationHeader {
  const reversibleRaw = readHeaderLine(content, '-- reversible:')?.toLowerCase();
  let reversible: boolean | undefined;
  if (reversibleRaw !== undefined) {
    if (/^(是|yes|true|y)/u.test(reversibleRaw)) {
      reversible = true;
    } else if (/^(否|no|false|n)/u.test(reversibleRaw)) {
      reversible = false;
    }
  }
  return {
    ...(readHeaderLine(content, '-- migration:') !== undefined
      ? { migration: readHeaderLine(content, '-- migration:') }
      : {}),
    ...(readHeaderLine(content, '-- description:') !== undefined
      ? { description: readHeaderLine(content, '-- description:') }
      : {}),
    ...(reversible !== undefined ? { reversible } : {}),
    ...(readHeaderLine(content, '-- owner:') !== undefined
      ? { owner: readHeaderLine(content, '-- owner:') }
      : {}),
  };
}

/** 事务边界：BEGIN 与 COMMIT 必须同时出现或同时不出现（与 CI 门禁同规则） */
export function hasBalancedTransaction(content: string): boolean {
  const hasBegin = /(^|\n)\s*BEGIN;/iu.test(content);
  const hasCommit = /(^|\n)\s*COMMIT;/iu.test(content);
  return hasBegin === hasCommit;
}

/**
 * 解析并校验单个迁移文件。
 *
 * @throws MigrationBoundaryError 文件名、头部字段或事务边界不合规
 */
export function describeMigrationFile(fileName: string, content: string): MigrationDescriptor {
  const match = MIGRATION_FILE_PATTERN.exec(fileName);
  if (match === null) {
    throw new MigrationBoundaryError(
      'MIGRATION_FILE_NAME_INVALID',
      `迁移文件名不符合 NNNN_snake_case.sql 规范: ${fileName}`,
    );
  }
  const version = match[1] ?? '';
  const name = match[2] ?? '';

  for (const field of MIGRATION_REQUIRED_HEADER_FIELDS) {
    if (readHeaderLine(content, field) === undefined) {
      throw new MigrationBoundaryError(
        'MIGRATION_HEADER_FIELD_MISSING',
        `${fileName} 头部缺少注释字段: ${field}`,
      );
    }
  }

  if (!hasBalancedTransaction(content)) {
    throw new MigrationBoundaryError(
      'MIGRATION_TRANSACTION_UNBALANCED',
      `${fileName} 事务边界不配对（BEGIN/COMMIT 必须同时出现或同时不出现）`,
    );
  }

  const header = parseMigrationHeader(content);
  return {
    fileName,
    version,
    name,
    checksum: computeMigrationChecksum(content),
    reversible: header.reversible ?? false,
    ...(header.description !== undefined ? { description: header.description } : {}),
    ...(header.owner !== undefined ? { owner: header.owner } : {}),
  };
}

/**
 * 顺序与唯一性判定：序号唯一且严格递增。
 * 调用方应传入按文件名升序排列的描述符（`readMigrationDirectory` 已保证）。
 */
export function assertMigrationSequence(
  descriptors: readonly MigrationDescriptor[],
): readonly MigrationDescriptor[] {
  const seen = new Map<string, string>();
  let previousVersion = '';
  for (const descriptor of descriptors) {
    const existing = seen.get(descriptor.version);
    if (existing !== undefined) {
      throw new MigrationBoundaryError(
        'MIGRATION_VERSION_DUPLICATE',
        `迁移序号重复: ${descriptor.version} 同时出现在 ${existing} 与 ${descriptor.fileName}`,
      );
    }
    if (previousVersion !== '' && descriptor.version <= previousVersion) {
      throw new MigrationBoundaryError(
        'MIGRATION_ORDER_INVALID',
        `迁移顺序非法: ${descriptor.fileName} 出现在 ${previousVersion} 之后但序号不递增`,
      );
    }
    seen.set(descriptor.version, descriptor.fileName);
    previousVersion = descriptor.version;
  }
  return descriptors;
}

/** 读取迁移目录：跳过 README 与点文件，按文件名升序返回并完成顺序校验 */
export function readMigrationDirectory(directory: string): readonly MigrationDescriptor[] {
  const fileNames = readdirSync(directory)
    .filter((entry) => entry !== 'README.md' && !entry.startsWith('.'))
    .sort((left, right) => left.localeCompare(right));
  const descriptors = fileNames.map((fileName) =>
    describeMigrationFile(fileName, readFileSync(join(directory, fileName), 'utf8')),
  );
  return assertMigrationSequence(descriptors);
}

/**
 * 计算待执行计划（纯函数，不连接数据库）。
 * 计划只做判定，**不决定**是否执行；`assertMigrationPlanRunnable` 是执行前的 fail-closed 断言。
 */
export function planMigrationRun(input: {
  readonly applied: readonly MigrationApplication[];
  readonly available: readonly MigrationDescriptor[];
}): MigrationPlan {
  const availableByVersion = new Map(input.available.map((item) => [item.version, item]));
  const appliedByVersion = new Map(input.applied.map((item) => [item.version, item]));

  const pending = input.available.filter((item) => !appliedByVersion.has(item.version));

  const checksumMismatches: MigrationChecksumMismatch[] = [];
  for (const application of input.applied) {
    const available = availableByVersion.get(application.version);
    if (available !== undefined && available.checksum !== application.checksum) {
      checksumMismatches.push({
        version: application.version,
        fileName: available.fileName,
        appliedChecksum: application.checksum,
        availableChecksum: available.checksum,
      });
    }
  }

  const unknownApplied = input.applied.filter((item) => !availableByVersion.has(item.version));

  return {
    pending,
    upToDate: pending.length === 0,
    checksumMismatches,
    unknownApplied,
  };
}

/**
 * 执行前断言：校验和不一致或存在「库里有、代码里没有」的版本时必须人工处理，
 * 禁止自动重写迁移或自动回退。
 */
export function assertMigrationPlanRunnable(plan: MigrationPlan): void {
  if (plan.checksumMismatches.length > 0) {
    const detail = plan.checksumMismatches
      .map((item) => `${item.version}(${item.fileName})`)
      .join(', ');
    throw new MigrationBoundaryError(
      'MIGRATION_CHECKSUM_MISMATCH',
      `已应用迁移的内容与当前文件不一致，必须人工处理: ${detail}`,
    );
  }
  if (plan.unknownApplied.length > 0) {
    const detail = plan.unknownApplied.map((item) => item.version).join(', ');
    throw new MigrationBoundaryError(
      'MIGRATION_APPLIED_UNKNOWN',
      `数据库中存在代码里没有的迁移版本（可能回退到旧版本），必须人工处理: ${detail}`,
    );
  }
}

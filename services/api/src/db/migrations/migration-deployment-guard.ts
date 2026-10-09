import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  assertMigrationSequence,
  computeMigrationChecksum,
  describeMigrationFile,
  MigrationBoundaryError,
  planMigrationRun,
  type MigrationApplication,
  type MigrationBoundaryErrorCode,
  type MigrationDescriptor,
} from './migration-boundary';
import { SCHEMA_DRAFT_FILE_PATTERN } from './schema-draft';

/**
 * 迁移部署守卫契约（**部署前的 fail-closed 闸门**，不含迁移执行器）。
 *
 * ## 与 `migration-boundary.ts` / `schema-draft.ts` 的分工
 * - `migration-boundary.ts` 回答「单个迁移文件本身合规吗、已应用集合还能不能往前进」；
 * - `schema-draft.ts` 回答「草案文件本身合规吗」（草案是**未应用**的 SQL，永不部署）；
 * - 本模块回答**部署动作本身**：`(来源目录, 候选文件集, 执行器声明的执行顺序, 数据库已应用记录)`
 *   这四份输入放在一起是否允许部署。任何一项不满足即拒绝，并把全部违规一次性列出。
 *
 * ## 契约内容（机器可判定，逐条有对应违规码）
 * 1. **命名 / 顺序 / 唯一版本**：候选文件必须符合 `NNNN_snake_case.sql`、头部字段齐全、
 *    `-- migration:` 与文件名一致、序号唯一且严格递增（直接复用 `describeMigrationFile` 与
 *    `assertMigrationSequence`，不另立一套规则）；执行器声明的执行顺序必须等于「按版本升序的
 *    待执行集合」，不得重排、不得漏跑。
 * 2. **拒绝草案误部署**：`*.draft.sql`、来自 `db/schema-drafts` 的来源、以及文件头部出现草案专属字段
 *    （`-- draft:` / `-- target-table:` / `-- status:`）的 `.sql` 一律拒绝 —— 草案转迁移必须经过
 *    选型评审并按迁移规范重写，不能原样改后缀就部署。
 * 3. **拒绝危险非事务 DDL**：`CREATE/DROP INDEX CONCURRENTLY`、`VACUUM`、`CLUSTER`、
 *    `CREATE/DROP DATABASE`、`CREATE/DROP TABLESPACE`、`ALTER SYSTEM`、`ALTER TYPE ... ADD VALUE`、
 *    `CREATE/DROP SUBSCRIPTION`（这些语句无法在事务块内执行，会破坏迁移的原子性与可回滚性），
 *    以及「显式事务边界缺失 / 出现多段事务 / 事务块之外还有语句」三种原子性破坏。
 * 4. **拒绝未参数化动态标识符**：SQL 模板占位符（`${...}` / `#{...}` / `{{...}}`）、
 *    `EXECUTE` 语句文本用 `||` 拼接（除非同一语句里用了 `quote_ident` / `quote_literal`）、
 *    `format(...)` 里使用 `%s`（标识符必须 `%I`、字面量必须 `%L`）。
 * 5. **校验和与来源边界**：候选必须来自登记的部署来源目录 `db/migrations`，相对路径必须是
 *    `db/migrations/<文件名>`（不得绝对路径、不得 `..` 逃逸）；候选集不得为空（来源目录指错时
 *    枚举出空集合也必须拒绝）；候选声明的校验和必须等于按 LF 归一化重算的 sha256（否则来源不可信）；
 *    与已应用记录比对时，内容被改写判 `DEPLOY_CHECKSUM_MISMATCH`、库里有代码里没有的版本判
 *    `DEPLOY_APPLIED_VERSION_UNKNOWN`、已应用顺序不是可用序列前缀判 `DEPLOY_APPLIED_ORDER_INVALID`。
 *
 * ## 边界事实
 * - 只读文件、只做静态解析，**不连接数据库、不执行 SQL、不引入任何数据库驱动**；
 * - 判定完全由传入的事实决定：`evaluateMigrationDeploymentGuard` 是纯函数（不读环境变量、
 *   不读磁盘、不写日志），便于穷举组合；`collectMigrationDeploymentCandidates` 只负责把磁盘事实
 *   采集出来（与 `readMigrationDirectory` 同口径：跳过 README 与点文件）；
 * - 违规信息只包含文件名 / 版本 / 行内片段，**不包含连接串、口令或业务字段取值**（本层根本不接触）。
 */

/** 唯一登记的部署来源目录（仓库相对、posix） */
export const MIGRATION_DEPLOYMENT_SOURCE_DIRECTORY = 'db/migrations';

/** 草案目录：只允许静态校验，永不允许进入部署集合 */
export const MIGRATION_DRAFT_SOURCE_DIRECTORY = 'db/schema-drafts';

/** 允许的部署环境（未知环境一律 fail-closed，不猜测） */
export const MIGRATION_DEPLOYMENT_ENVIRONMENTS = [
  'development',
  'test',
  'staging',
  'production',
] as const;

export type MigrationDeploymentEnvironment = (typeof MIGRATION_DEPLOYMENT_ENVIRONMENTS)[number];

/** 契约身份：版本变化意味着规则集合变化，调用方据此判断是否需要重新评审 */
export const MIGRATION_DEPLOYMENT_GUARD_CONTRACT = {
  id: 'migration-deployment-guard',
  version: 1,
  sourceDirectory: MIGRATION_DEPLOYMENT_SOURCE_DIRECTORY,
  draftDirectory: MIGRATION_DRAFT_SOURCE_DIRECTORY,
  /** 校验和口径：CRLF 归一化为 LF 后取 sha256（与 migration-boundary 同源） */
  checksum: 'sha256-lf-normalized',
  /** 已应用迁移不可改写：校验和不一致必须人工处理 */
  immutableAfterApply: true,
  /** 每个迁移必须自带显式 BEGIN/COMMIT 事务边界 */
  requireTransactionBoundary: true,
} as const;

/** 候选 SQL 的来源种类：只有 `migration-directory` 允许部署 */
export type MigrationDeploymentSource =
  'migration-directory' | 'schema-draft-directory' | 'inline' | 'unknown';

export type MigrationDeploymentViolationCode =
  | 'DEPLOY_ENVIRONMENT_UNKNOWN'
  | 'DEPLOY_CANDIDATE_SET_EMPTY'
  | 'DEPLOY_SOURCE_NOT_MIGRATION_DIRECTORY'
  | 'DEPLOY_FILE_PATH_ESCAPES_SOURCE'
  | 'DEPLOY_SCHEMA_DRAFT_REJECTED'
  | 'DEPLOY_DRAFT_HEADER_IN_MIGRATION'
  | 'DEPLOY_MIGRATION_BOUNDARY_VIOLATION'
  | 'DEPLOY_HEADER_NAME_MISMATCH'
  | 'DEPLOY_TRANSACTION_BOUNDARY_REQUIRED'
  | 'DEPLOY_MULTIPLE_TRANSACTIONS'
  | 'DEPLOY_STATEMENT_OUTSIDE_TRANSACTION'
  | 'DEPLOY_FILE_EMPTY'
  | 'DEPLOY_NON_TRANSACTIONAL_DDL'
  | 'DEPLOY_UNPARAMETERIZED_DYNAMIC_IDENTIFIER'
  | 'DEPLOY_CHECKSUM_UNVERIFIED'
  | 'DEPLOY_CHECKSUM_MISMATCH'
  | 'DEPLOY_APPLIED_VERSION_UNKNOWN'
  | 'DEPLOY_APPLIED_ORDER_INVALID'
  | 'DEPLOY_EXECUTION_ORDER_MISMATCH';

export interface MigrationDeploymentViolation {
  readonly code: MigrationDeploymentViolationCode;
  /** 违规主体：文件名（解析前）或版本（解析后） */
  readonly subject: string;
  readonly detail: string;
  /** 由 `migration-boundary` 解析抛出时附带原始错误码，便于定位到具体规则 */
  readonly boundaryCode?: MigrationBoundaryErrorCode;
}

export interface MigrationDeploymentCandidate {
  readonly fileName: string;
  /** 仓库相对 posix 路径，例如 `db/migrations/0001_bootstrap.sql` */
  readonly relativePath: string;
  readonly source: MigrationDeploymentSource;
  /** SQL 原文（只读；本模块不执行它） */
  readonly content: string;
  /** 执行器打算写进 `schema_migrations.checksum` 的值（必须等于重算结果） */
  readonly checksum: string;
}

export interface MigrationDeploymentGuardInput {
  readonly environment: string;
  readonly sourceDirectory: string;
  readonly candidates: readonly MigrationDeploymentCandidate[];
  /** 数据库侧已应用记录（只读；本模块不查询它） */
  readonly applied: readonly MigrationApplication[];
  /**
   * 执行器声明要执行的版本顺序（**待执行**集合，按版本升序）。
   * 省略表示「按版本升序执行」，报告里给出 `executionOrder` 供执行器照办。
   */
  readonly deploymentOrder?: readonly string[];
  /** 是否要求显式事务边界（默认 true；关闭仅用于规则自检，不用于生产部署） */
  readonly requireTransactionBoundary?: boolean;
}

export interface MigrationDeploymentGuardReport {
  readonly ok: boolean;
  readonly violations: readonly MigrationDeploymentViolation[];
  /** 被检候选的文件名（升序，含被拒绝的） */
  readonly checkedFiles: readonly string[];
  /** 待执行版本（升序）；存在违规时不得据此执行 */
  readonly pendingVersions: readonly string[];
  /** 执行器应采用的执行顺序（等于 `deploymentOrder` 时应一致） */
  readonly executionOrder: readonly string[];
}

/** 部署守卫失败：携带全部违规项，供启动日志与测试断言 */
export class MigrationDeploymentGuardError extends Error {
  readonly violations: readonly MigrationDeploymentViolation[];

  constructor(violations: readonly MigrationDeploymentViolation[]) {
    const summary = violations.map((item) => `${item.subject}[${item.code}]`).join(', ');
    super(`迁移部署守卫拒绝部署（${violations.length} 项）: ${summary}`);
    this.name = 'MigrationDeploymentGuardError';
    this.violations = violations;
  }
}

// ---------------------------------------------------------------------------
// SQL 静态扫描辅助（只做文本处理，不解析执行）
// ---------------------------------------------------------------------------

/**
 * 去掉 SQL 注释（行注释与块注释），保留字符串字面量与 `$tag$...$tag$` 块内容。
 *
 * 目的：注释里出现的说明文本（例如「不要使用 CREATE INDEX CONCURRENTLY」）不得触发规则，
 * 而 `DO $$ ... EXECUTE ... $$` 里的动态 SQL 必须被扫描到。
 */
export function stripSqlComments(content: string): string {
  let output = '';
  let index = 0;
  let inSingleQuote = false;
  let dollarTag: string | undefined;
  while (index < content.length) {
    const char = content[index] ?? '';
    if (dollarTag !== undefined) {
      if (content.startsWith(dollarTag, index)) {
        output += dollarTag;
        index += dollarTag.length;
        dollarTag = undefined;
        continue;
      }
      output += char;
      index += 1;
      continue;
    }
    if (inSingleQuote) {
      if (char === "'") {
        if (content[index + 1] === "'") {
          output += "''";
          index += 2;
          continue;
        }
        inSingleQuote = false;
        output += char;
        index += 1;
        continue;
      }
      output += char;
      index += 1;
      continue;
    }
    if (char === "'") {
      inSingleQuote = true;
      output += char;
      index += 1;
      continue;
    }
    if (char === '$') {
      const tag = /^\$[A-Za-z_0-9]*\$/u.exec(content.slice(index));
      if (tag !== null) {
        dollarTag = tag[0];
        output += dollarTag;
        index += dollarTag.length;
        continue;
      }
    }
    if (char === '-' && content[index + 1] === '-') {
      while (index < content.length && content[index] !== '\n') {
        index += 1;
      }
      continue;
    }
    if (char === '/' && content[index + 1] === '*') {
      const end = content.indexOf('*/', index + 2);
      index = end === -1 ? content.length : end + 2;
      continue;
    }
    output += char;
    index += 1;
  }
  return output;
}

/** 语句是否「什么都不做」：去掉注释与空白后为空 */
export function isEmptyStatementBody(content: string): boolean {
  return stripSqlComments(content).replace(/\s/gu, '').length === 0;
}

function collapseWhitespace(value: string): string {
  return value.replace(/\s+/gu, ' ').trim();
}

function truncate(value: string, maxLength = 60): string {
  const collapsed = collapseWhitespace(value);
  return collapsed.length <= maxLength ? collapsed : `${collapsed.slice(0, maxLength)}…`;
}

// ---------------------------------------------------------------------------
// 规则 3：危险非事务 DDL 与事务原子性
// ---------------------------------------------------------------------------

export interface NonTransactionalDdlRule {
  /** 语句名（人类可读，用于违规定位） */
  readonly statement: string;
  /** 语句起始锚定：只认「文本开头 / 换行 / 分号」之后的第一条语句，避免字符串字面量里的同名文本误报 */
  readonly pattern: RegExp;
  readonly reason: string;
}

/**
 * 危险非事务 DDL 规则表。
 *
 * 这些语句在 PostgreSQL 中**不能在事务块内执行**（或必须与其它语句分属不同事务），迁移自带的
 * `BEGIN/COMMIT` 要么直接报错、要么失去原子性 —— 因此不允许出现在迁移里。
 */
export const NON_TRANSACTIONAL_DDL_RULES: readonly NonTransactionalDdlRule[] = [
  {
    statement: 'CREATE INDEX CONCURRENTLY',
    pattern: /(?:^|[;\n])\s*CREATE\s+(?:UNIQUE\s+)?INDEX\s+CONCURRENTLY\b/iu,
    reason: '并发建索引不能在事务块内执行：请拆成独立运维步骤，不要放进迁移',
  },
  {
    statement: 'DROP INDEX CONCURRENTLY',
    pattern: /(?:^|[;\n])\s*DROP\s+INDEX\s+CONCURRENTLY\b/iu,
    reason: '并发删索引不能在事务块内执行',
  },
  {
    statement: 'REINDEX CONCURRENTLY',
    pattern: /(?:^|[;\n])\s*REINDEX\b[^;\n]*\bCONCURRENTLY\b/iu,
    reason: 'REINDEX CONCURRENTLY 不能在事务块内执行',
  },
  {
    statement: 'VACUUM',
    pattern: /(?:^|[;\n])\s*VACUUM\b/iu,
    reason: 'VACUUM 不能在事务块内执行',
  },
  {
    statement: 'CLUSTER',
    pattern: /(?:^|[;\n])\s*CLUSTER\b/iu,
    reason: 'CLUSTER 不能在事务块内执行',
  },
  {
    statement: 'CREATE DATABASE',
    pattern: /(?:^|[;\n])\s*CREATE\s+DATABASE\b/iu,
    reason: 'CREATE DATABASE 不能在事务块内执行',
  },
  {
    statement: 'DROP DATABASE',
    pattern: /(?:^|[;\n])\s*DROP\s+DATABASE\b/iu,
    reason: 'DROP DATABASE 不能在事务块内执行，且属于不可回滚的破坏性操作',
  },
  {
    statement: 'CREATE TABLESPACE',
    pattern: /(?:^|[;\n])\s*CREATE\s+TABLESPACE\b/iu,
    reason: 'CREATE TABLESPACE 不能在事务块内执行',
  },
  {
    statement: 'DROP TABLESPACE',
    pattern: /(?:^|[;\n])\s*DROP\s+TABLESPACE\b/iu,
    reason: 'DROP TABLESPACE 不能在事务块内执行',
  },
  {
    statement: 'ALTER SYSTEM',
    pattern: /(?:^|[;\n])\s*ALTER\s+SYSTEM\b/iu,
    reason: 'ALTER SYSTEM 不能在事务块内执行，且影响实例级配置',
  },
  {
    statement: 'ALTER TYPE ... ADD VALUE',
    pattern: /(?:^|[;\n])\s*ALTER\s+TYPE\b[^;\n]*\bADD\s+VALUE\b/iu,
    reason: '枚举值新增与使用必须分属不同事务：迁移里既改又用会在同一事务内失效',
  },
  {
    statement: 'CREATE SUBSCRIPTION',
    pattern: /(?:^|[;\n])\s*CREATE\s+SUBSCRIPTION\b/iu,
    reason: 'CREATE SUBSCRIPTION 不能在事务块内执行',
  },
  {
    statement: 'DROP SUBSCRIPTION',
    pattern: /(?:^|[;\n])\s*DROP\s+SUBSCRIPTION\b/iu,
    reason: 'DROP SUBSCRIPTION 不能在事务块内执行',
  },
];

/** 命中全部危险非事务 DDL 规则（对注释剥离后的文本判定） */
export function collectNonTransactionalDdlRules(
  content: string,
): readonly NonTransactionalDdlRule[] {
  const body = stripSqlComments(content);
  return NON_TRANSACTIONAL_DDL_RULES.filter((rule) => rule.pattern.test(body));
}

export interface TransactionEnvelope {
  readonly beginCount: number;
  readonly commitCount: number;
  /** 同时出现 BEGIN 与 COMMIT */
  readonly hasExplicitTransaction: boolean;
  /** 出现多段事务（多个 BEGIN 或多个 COMMIT） */
  readonly multipleTransactions: boolean;
  /** 事务块之外仍有语句（BEGIN 之前或 COMMIT 之后） */
  readonly statementsOutside: boolean;
}

/** 事务包络分析：只认注释剥离后的文本，统计 BEGIN/COMMIT 并检查块外语句 */
export function analyzeTransactionEnvelope(content: string): TransactionEnvelope {
  const body = stripSqlComments(content);
  const begins = [...body.matchAll(/\bBEGIN\s*;/giu)];
  const commits = [...body.matchAll(/\bCOMMIT\s*;/giu)];
  const firstBegin = begins[0];
  const lastCommit = commits[commits.length - 1];

  let statementsOutside = false;
  if (firstBegin !== undefined && lastCommit !== undefined) {
    const before = body.slice(0, firstBegin.index ?? 0).replace(/\s/gu, '');
    const after = body.slice((lastCommit.index ?? 0) + lastCommit[0].length).replace(/\s/gu, '');
    statementsOutside = before.length > 0 || after.length > 0;
  }

  return {
    beginCount: begins.length,
    commitCount: commits.length,
    hasExplicitTransaction: begins.length > 0 && commits.length > 0,
    multipleTransactions: begins.length > 1 || commits.length > 1,
    statementsOutside,
  };
}

// ---------------------------------------------------------------------------
// 规则 4：未参数化动态标识符
// ---------------------------------------------------------------------------

export const UNPARAMETERIZED_DYNAMIC_IDENTIFIER_RULE_IDS = [
  'template-placeholder',
  'execute-concatenation',
  'format-string-interpolation',
] as const;

export type UnparameterizedDynamicIdentifierRuleId =
  (typeof UNPARAMETERIZED_DYNAMIC_IDENTIFIER_RULE_IDS)[number];

export interface DynamicIdentifierFinding {
  readonly rule: UnparameterizedDynamicIdentifierRuleId;
  /** 截断后的违规片段（不含连接串/口令这类机密） */
  readonly snippet: string;
}

const TEMPLATE_PLACEHOLDER_PATTERN = /\$\{|#\{|\{\{/u;
/** 安全引用函数：出现即认为标识符已参数化，不判违规 */
const SAFE_QUOTING_PATTERN = /\b(?:quote_ident|quote_literal|quote_nullable)\s*\(/iu;

/** 从 `(` 或 `$tag$` 起点取到配对的 `)`（忽略字符串字面量与块内容） */
function balancedParenSlice(text: string, openIndex: number): string {
  let depth = 0;
  let index = openIndex;
  while (index < text.length) {
    const char = text[index] ?? '';
    if (char === "'") {
      index += 1;
      while (index < text.length) {
        if (text[index] === "'") {
          if (text[index + 1] === "'") {
            index += 2;
            continue;
          }
          index += 1;
          break;
        }
        index += 1;
      }
      continue;
    }
    if (char === '$') {
      const tag = /^\$[A-Za-z_0-9]*\$/u.exec(text.slice(index));
      if (tag !== null) {
        const end = text.indexOf(tag[0], index + tag[0].length);
        index = end === -1 ? text.length : end + tag[0].length;
        continue;
      }
    }
    if (char === '(') {
      depth += 1;
    } else if (char === ')') {
      depth -= 1;
      if (depth === 0) {
        return text.slice(openIndex, index + 1);
      }
    }
    index += 1;
  }
  return text.slice(openIndex);
}

/** 从指定位置取到本语句结束（下一个分号或文本结尾） */
function statementSlice(text: string, startIndex: number): string {
  const end = text.indexOf(';', startIndex);
  return end === -1 ? text.slice(startIndex) : text.slice(startIndex, end);
}

/**
 * 收集未参数化动态标识符的违规点（不抛错，便于一次报告全部问题）。
 * 只做文本判定：不解析 PL/pgSQL，也不执行任何 SQL。
 */
export function collectUnparameterizedDynamicIdentifiers(
  content: string,
): readonly DynamicIdentifierFinding[] {
  const body = stripSqlComments(content);
  const findings: DynamicIdentifierFinding[] = [];

  const template = TEMPLATE_PLACEHOLDER_PATTERN.exec(body);
  if (template !== null) {
    findings.push({ rule: 'template-placeholder', snippet: truncate(template[0]) });
  }

  for (const match of body.matchAll(/\bEXECUTE\s+(?:IMMEDIATE\s+)?/giu)) {
    const slice = statementSlice(body, (match.index ?? 0) + match[0].length);
    if (!slice.includes('||') || SAFE_QUOTING_PATTERN.test(slice)) {
      continue;
    }
    findings.push({
      rule: 'execute-concatenation',
      snippet: truncate(`EXECUTE ${slice}`),
    });
  }

  for (const match of body.matchAll(/\bformat\s*\(/giu)) {
    const openIndex = (match.index ?? 0) + match[0].length - 1;
    const slice = balancedParenSlice(body, openIndex);
    if (!/%s/u.test(slice) || SAFE_QUOTING_PATTERN.test(slice)) {
      continue;
    }
    findings.push({ rule: 'format-string-interpolation', snippet: truncate(`format${slice}`) });
  }

  return findings;
}

// ---------------------------------------------------------------------------
// 规则 1/2/5：路径、草案、校验和与计划判定
// ---------------------------------------------------------------------------

/** 路径归一化为 posix（Windows 反斜杠不得绕过来源边界比对） */
export function normalizeRepositoryPath(value: string): string {
  return value.replace(/\\/gu, '/');
}

/** 是否为唯一登记的部署来源目录 */
export function isRegisteredDeploymentSource(sourceDirectory: string): boolean {
  return normalizeRepositoryPath(sourceDirectory.trim()) === MIGRATION_DEPLOYMENT_SOURCE_DIRECTORY;
}

/** 草案头部字段：出现在迁移头部即为「草案被改后缀直接部署」的强信号 */
export const DRAFT_ONLY_HEADER_FIELDS = ['-- draft:', '-- target-table:', '-- status:'] as const;

function hasHeaderField(content: string, field: string): boolean {
  for (const line of content.split('\n').slice(0, 12)) {
    if (line.trim().startsWith(field)) {
      return true;
    }
  }
  return false;
}

function violation(
  code: MigrationDeploymentViolationCode,
  subject: string,
  detail: string,
  boundaryCode?: MigrationBoundaryErrorCode,
): MigrationDeploymentViolation {
  return boundaryCode === undefined
    ? { code, subject, detail }
    : { code, subject, detail, boundaryCode };
}

function sameOrder(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

/**
 * 纯函数判定：把「环境 + 来源目录 + 候选文件集 + 执行器声明的执行顺序 + 已应用记录」
 * 判成违规清单。不读磁盘、不读环境变量、不建连接，便于在测试里穷举。
 */
export function evaluateMigrationDeploymentGuard(
  input: MigrationDeploymentGuardInput,
): MigrationDeploymentGuardReport {
  const violations: MigrationDeploymentViolation[] = [];
  const checkedFiles = input.candidates
    .map((candidate) => candidate.fileName)
    .slice()
    .sort((left, right) => left.localeCompare(right));

  // ---- 环境：未知环境一律拒绝（不猜测调用方意图） ----
  const environment = input.environment.trim();
  if (!(MIGRATION_DEPLOYMENT_ENVIRONMENTS as readonly string[]).includes(environment)) {
    violations.push(
      violation(
        'DEPLOY_ENVIRONMENT_UNKNOWN',
        environment === '' ? '(空)' : environment,
        `部署环境必须是 ${MIGRATION_DEPLOYMENT_ENVIRONMENTS.join(' / ')} 之一：未知环境无法确定守卫强度`,
      ),
    );
  }

  // ---- 候选集不得为空：来源目录指错会枚举出空集合，放行等于「部署成功但什么都没做」 ----
  if (input.candidates.length === 0) {
    violations.push(
      violation(
        'DEPLOY_CANDIDATE_SET_EMPTY',
        input.sourceDirectory,
        `候选集合为空：无法确认 ${MIGRATION_DEPLOYMENT_SOURCE_DIRECTORY} 是否真的枚举到了迁移文件`,
      ),
    );
  }

  // ---- 规则 5a：来源目录边界 ----
  if (!isRegisteredDeploymentSource(input.sourceDirectory)) {
    violations.push(
      violation(
        'DEPLOY_SOURCE_NOT_MIGRATION_DIRECTORY',
        input.sourceDirectory,
        `部署来源必须是 ${MIGRATION_DEPLOYMENT_SOURCE_DIRECTORY}：其它目录（尤其 ${MIGRATION_DRAFT_SOURCE_DIRECTORY}）与内联 SQL 都不得部署`,
      ),
    );
  }

  const descriptors: MigrationDescriptor[] = [];
  let parseComplete = true;

  for (const candidate of input.candidates) {
    const subject = candidate.fileName;
    const relativePath = normalizeRepositoryPath(candidate.relativePath);
    const expectedRelativePath = `${MIGRATION_DEPLOYMENT_SOURCE_DIRECTORY}/${candidate.fileName}`;

    // ---- 规则 5b：路径不得逃出登记来源（绝对路径 / .. / 目录不符） ----
    const escapesSource =
      relativePath !== expectedRelativePath ||
      relativePath.startsWith('/') ||
      /^[A-Za-z]:/u.test(relativePath) ||
      relativePath.split('/').includes('..') ||
      relativePath.includes('\0');
    if (escapesSource) {
      violations.push(
        violation(
          'DEPLOY_FILE_PATH_ESCAPES_SOURCE',
          subject,
          `候选路径 ${relativePath} 不等于 ${expectedRelativePath}：迁移只能来自登记的来源目录内的文件`,
        ),
      );
    }

    // ---- 规则 2a：草案（名字 / 来源 / 目录）一律拒绝 ----
    const fromDraftDirectory =
      candidate.source === 'schema-draft-directory' ||
      relativePath.startsWith(`${MIGRATION_DRAFT_SOURCE_DIRECTORY}/`);
    if (SCHEMA_DRAFT_FILE_PATTERN.test(candidate.fileName) || fromDraftDirectory) {
      violations.push(
        violation(
          'DEPLOY_SCHEMA_DRAFT_REJECTED',
          subject,
          '草案（*.draft.sql / db/schema-drafts）永远不部署：转迁移必须先完成选型评审并按迁移规范重写',
        ),
      );
      parseComplete = false;
      continue;
    }

    // ---- 规则 5c：来源种类只能是迁移目录 ----
    if (candidate.source !== 'migration-directory') {
      violations.push(
        violation(
          'DEPLOY_SOURCE_NOT_MIGRATION_DIRECTORY',
          subject,
          `候选来源种类为 ${candidate.source}：只有 'migration-directory' 允许部署`,
        ),
      );
      parseComplete = false;
    }

    // ---- 规则 2b：迁移头部出现草案专属字段 ----
    const draftFields = DRAFT_ONLY_HEADER_FIELDS.filter((field) =>
      hasHeaderField(candidate.content, field),
    );
    if (draftFields.length > 0) {
      violations.push(
        violation(
          'DEPLOY_DRAFT_HEADER_IN_MIGRATION',
          subject,
          `头部出现草案专属字段 ${draftFields.join(' ')}：疑似草案改后缀直接部署`,
        ),
      );
    }

    // ---- 规则 5d：校验和来源可信（声明值必须等于按 LF 归一化重算的 sha256） ----
    const computedChecksum = computeMigrationChecksum(candidate.content);
    if (!/^[0-9a-f]{64}$/u.test(candidate.checksum) || candidate.checksum !== computedChecksum) {
      violations.push(
        violation(
          'DEPLOY_CHECKSUM_UNVERIFIED',
          subject,
          '声明的校验和与按 LF 归一化重算的 sha256 不一致（或不是 64 位小写十六进制）：来源不可信',
        ),
      );
    }

    // ---- 空迁移：静默「成功」但什么都没做 ----
    if (isEmptyStatementBody(candidate.content)) {
      violations.push(
        violation(
          'DEPLOY_FILE_EMPTY',
          subject,
          '去掉注释与空白后没有任何语句：空迁移不得进入部署集合',
        ),
      );
    }

    // ---- 规则 1：命名 / 头部 / 事务配对（复用 migration-boundary，不另立规则） ----
    let descriptor: MigrationDescriptor;
    try {
      descriptor = describeMigrationFile(candidate.fileName, candidate.content);
    } catch (error) {
      if (error instanceof MigrationBoundaryError) {
        violations.push(
          violation('DEPLOY_MIGRATION_BOUNDARY_VIOLATION', subject, error.message, error.code),
        );
        parseComplete = false;
        continue;
      }
      throw error;
    }

    // ---- 规则 1b：头部 `-- migration:` 必须与文件名一致 ----
    const headerValue = readHeaderValue(candidate.content, '-- migration:');
    const expectedHeaderValue = `${descriptor.version}_${descriptor.name}`;
    if (headerValue !== expectedHeaderValue) {
      violations.push(
        violation(
          'DEPLOY_HEADER_NAME_MISMATCH',
          subject,
          `头部 -- migration: 为 ${headerValue ?? '(缺失)'}，与文件名推导的 ${expectedHeaderValue} 不一致`,
        ),
      );
    }

    // ---- 规则 3：事务包络（显式边界、单段事务、块内无遗漏） ----
    const envelope = analyzeTransactionEnvelope(candidate.content);
    const requireTransactionBoundary = input.requireTransactionBoundary ?? true;
    if (requireTransactionBoundary && !envelope.hasExplicitTransaction) {
      violations.push(
        violation(
          'DEPLOY_TRANSACTION_BOUNDARY_REQUIRED',
          subject,
          '缺少显式 BEGIN/COMMIT：迁移必须整体处于一个事务内，否则失败会留下半成品',
        ),
      );
    }
    if (envelope.multipleTransactions) {
      violations.push(
        violation(
          'DEPLOY_MULTIPLE_TRANSACTIONS',
          subject,
          `出现 ${envelope.beginCount} 个 BEGIN / ${envelope.commitCount} 个 COMMIT：一份迁移只能是单段事务`,
        ),
      );
    }
    if (envelope.statementsOutside) {
      violations.push(
        violation(
          'DEPLOY_STATEMENT_OUTSIDE_TRANSACTION',
          subject,
          'BEGIN 之前或 COMMIT 之后仍有语句：该部分不在事务保护内',
        ),
      );
    }

    // ---- 规则 3b：危险非事务 DDL ----
    for (const rule of collectNonTransactionalDdlRules(candidate.content)) {
      violations.push(
        violation('DEPLOY_NON_TRANSACTIONAL_DDL', subject, `${rule.statement}：${rule.reason}`),
      );
    }

    // ---- 规则 4：未参数化动态标识符 ----
    for (const finding of collectUnparameterizedDynamicIdentifiers(candidate.content)) {
      violations.push(
        violation(
          'DEPLOY_UNPARAMETERIZED_DYNAMIC_IDENTIFIER',
          subject,
          `${finding.rule} → ${finding.snippet}：标识符必须参数化（EXECUTE ... USING / quote_ident / %I）`,
        ),
      );
    }

    descriptors.push(descriptor);
  }

  // ---- 规则 1c：序号唯一且严格递增 ----
  const ordered = descriptors
    .slice()
    .sort((left, right) => left.fileName.localeCompare(right.fileName));
  try {
    assertMigrationSequence(ordered);
  } catch (error) {
    if (error instanceof MigrationBoundaryError) {
      parseComplete = false;
      violations.push(
        violation(
          'DEPLOY_MIGRATION_BOUNDARY_VIOLATION',
          error.code === 'MIGRATION_VERSION_DUPLICATE' ? 'migration-sequence' : 'migration-order',
          error.message,
          error.code,
        ),
      );
    } else {
      throw error;
    }
  }

  // ---- 规则 5e/5f：与已应用记录比对（解析不完整时不做计划判定，避免误报） ----
  let pendingVersions: readonly string[] = ordered.map((item) => item.version);
  if (parseComplete) {
    const plan = planMigrationRun({ applied: input.applied, available: ordered });
    pendingVersions = plan.pending.map((item) => item.version);

    for (const mismatch of plan.checksumMismatches) {
      violations.push(
        violation(
          'DEPLOY_CHECKSUM_MISMATCH',
          mismatch.version,
          `已应用内容与当前文件不一致（${mismatch.fileName}）：applied=${mismatch.appliedChecksum} available=${mismatch.availableChecksum}，必须人工处理`,
        ),
      );
    }
    for (const unknown of plan.unknownApplied) {
      violations.push(
        violation(
          'DEPLOY_APPLIED_VERSION_UNKNOWN',
          unknown.version,
          '数据库中存在代码里没有的迁移版本（代码回退或迁移文件被删除）：必须人工处理',
        ),
      );
    }

    // 已应用版本必须是可用序列的前缀：否则说明应用顺序被打乱（例如 0002 已应用而 0001 未应用）
    const availableVersions = ordered.map((item) => item.version);
    const appliedVersions = new Set(input.applied.map((item) => item.version));
    for (const [index, version] of availableVersions.entries()) {
      const applied = appliedVersions.has(version);
      const previousApplied =
        index === 0 || appliedVersions.has(availableVersions[index - 1] ?? '');
      if (applied && !previousApplied) {
        violations.push(
          violation(
            'DEPLOY_APPLIED_ORDER_INVALID',
            version,
            '已应用版本不是可用序列的前缀（前一个版本尚未应用）：迁移必须按版本顺序推进',
          ),
        );
      }
    }
  }

  // ---- 规则 1d：执行器声明的执行顺序必须等于「待执行集合按版本升序」 ----
  const executionOrder = [...pendingVersions];
  if (input.deploymentOrder !== undefined && !sameOrder(input.deploymentOrder, executionOrder)) {
    violations.push(
      violation(
        'DEPLOY_EXECUTION_ORDER_MISMATCH',
        'deployment-order',
        `声明的执行顺序 [${input.deploymentOrder.join(', ')}] 不等于按版本升序的待执行集合 [${executionOrder.join(', ')}]`,
      ),
    );
  }

  return {
    ok: violations.length === 0,
    violations,
    checkedFiles,
    pendingVersions,
    executionOrder,
  };
}

/** 读取头部字段原始值（与 migration-boundary 的读取口径一致：只扫前 12 行） */
function readHeaderValue(content: string, field: string): string | undefined {
  for (const line of content.split('\n').slice(0, 12)) {
    const trimmed = line.trim();
    if (trimmed.startsWith(field)) {
      return trimmed.slice(field.length).trim();
    }
  }
  return undefined;
}

/** 断言部署守卫成立，失败即抛 `MigrationDeploymentGuardError` */
export function assertMigrationDeploymentGuard(
  input: MigrationDeploymentGuardInput,
): MigrationDeploymentGuardReport {
  const report = evaluateMigrationDeploymentGuard(input);
  if (!report.ok) {
    throw new MigrationDeploymentGuardError(report.violations);
  }
  return report;
}

/**
 * 采集磁盘事实：把目录下的迁移候选读成 `(fileName, relativePath, source, content, checksum)`。
 *
 * 口径与 `readMigrationDirectory` 一致（跳过 `README.md` 与点文件），但**不做命名过滤** ——
 * 非法文件与 `*.draft.sql` 必须进入候选集并被守卫判违规，而不是被静默跳过。
 * 只读文件，不连接数据库。
 */
export function collectMigrationDeploymentCandidates(
  directory: string,
  sourceDirectory: string = MIGRATION_DEPLOYMENT_SOURCE_DIRECTORY,
): readonly MigrationDeploymentCandidate[] {
  const normalizedSource = normalizeRepositoryPath(sourceDirectory);
  const source: MigrationDeploymentSource =
    normalizedSource === MIGRATION_DEPLOYMENT_SOURCE_DIRECTORY
      ? 'migration-directory'
      : normalizedSource === MIGRATION_DRAFT_SOURCE_DIRECTORY
        ? 'schema-draft-directory'
        : 'unknown';

  return readdirSync(directory)
    .filter((entry) => entry !== 'README.md' && !entry.startsWith('.'))
    .sort((left, right) => left.localeCompare(right))
    .map((fileName) => {
      const content = readFileSync(join(directory, fileName), 'utf8');
      return {
        fileName,
        relativePath: `${normalizedSource}/${fileName}`,
        source,
        content,
        checksum: computeMigrationChecksum(content),
      };
    });
}

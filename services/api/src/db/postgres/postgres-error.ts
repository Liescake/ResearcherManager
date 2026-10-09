/**
 * PostgreSQL 执行器的**统一错误脱敏**（驱动无关：只读 `unknown` 的结构，不 import 任何驱动）。
 *
 * ## 为什么需要它
 * `pg` 抛出的错误对象会带上 `message` / `detail` / `hint` / `where` / `query` 等字段：
 * - `message` 可能包含连接串（TLS / 主机解析失败时）；
 * - `detail` / `where` 可能包含**行的取值**（唯一约束冲突报 `<value> already exists`）；
 * - `query` 是完整 SQL 文本（可能带业务表结构信息）。
 *
 * 驱动的原始错误会冒泡到 API 的 500 路径与日志，因此本模块把「什么可以外发」固定下来：
 * - **可外发**：SQLSTATE（`code`）、`severity`、`routine`、以及 `schema` / `table` / `column` /
 *   `constraint` 这类**结构名**（用于定位，不含取值）；
 * - **不外发**：`detail` / `hint` / `where` / `query` / `file` / `line` / `position`，以及任何
 *   命中连接串、口令与已登记机密片段的内容 —— 一律不进入本模块产出的对象。
 *
 * ## 边界事实
 * - 纯函数：不读环境变量、不建连接、不写日志；
 * - `description` 会再做一次机密擦除（连接串、`password=` 键值、调用方登记的秘密片段），并截断长度；
 * - 本模块**不依赖** `@rm/shared`，执行器可以在任何装配（含迁移 CLI）里复用。
 */

export type PostgresExecutorErrorCode =
  | 'EXECUTOR_NOT_CONFIGURED'
  | 'EXECUTOR_CONNECT_FAILED'
  | 'EXECUTOR_PARAMETER_SLOT_MISMATCH'
  | 'EXECUTOR_QUERY_FAILED'
  | 'EXECUTOR_TRANSACTION_FAILED'
  | 'EXECUTOR_TRANSACTION_NESTED'
  | 'EXECUTOR_TRANSACTION_ESCAPED'
  | 'EXECUTOR_CLOSED'
  | 'EXECUTOR_RESULT_INVALID';

export interface PostgresExecutorErrorIssue {
  readonly code: string;
  readonly detail: string;
}

/**
 * 执行器错误。
 *
 * `issues` 只承载**代码与结构性描述**（SQLSTATE、后果名、参数槽序号等），
 * 绝不承载连接串、口令、SQL 文本或字段取值。
 */
export class PostgresExecutorError extends Error {
  readonly code: PostgresExecutorErrorCode;
  readonly issues: readonly PostgresExecutorErrorIssue[];

  constructor(
    code: PostgresExecutorErrorCode,
    message: string,
    issues: readonly PostgresExecutorErrorIssue[] = [],
  ) {
    super(message);
    this.name = 'PostgresExecutorError';
    this.code = code;
    this.issues = [...issues];
  }
}

/** 已经过脱敏、可以安全写日志 / 冒泡的错误摘要 */
export interface RedactedPostgresError {
  /** SQLSTATE（例如 `23505`）；驱动未给出时省略 */
  readonly sqlState?: string;
  readonly severity?: string;
  readonly routine?: string;
  /** 结构名（schema / table / column / constraint）：用于定位，不含取值 */
  readonly schema?: string;
  readonly table?: string;
  readonly column?: string;
  readonly constraint?: string;
  /** 已擦除机密并截断的短描述 */
  readonly description: string;
}

const MAX_DESCRIPTION_LENGTH = 240;

/** 连接串里的 user:password 段与查询串里的口令键值：与 `database-config.ts` 同一口径 */
const URL_CREDENTIALS_PATTERN = /([a-zA-Z][a-zA-Z0-9+.-]*:\/\/)[^@/\s]*@/gu;
const PASSWORD_KEY_PATTERN = /([?&\s](?:password|pwd|sslpassword)=)[^&#\s]*/giu;

function readString(source: Record<string, unknown>, key: string): string | undefined {
  const value = source[key];
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

/**
 * 擦除机密片段与连接串凭据，并截断长度。
 * 对不可解析的输入也安全：只做字符串替换，不回显原文以外的结构。
 */
export function redactPostgresErrorText(text: string, secrets: readonly string[] = []): string {
  let output = text
    .replace(URL_CREDENTIALS_PATTERN, '$1***@')
    .replace(PASSWORD_KEY_PATTERN, '$1***');
  for (const secret of secrets) {
    if (secret.trim() === '') {
      continue;
    }
    output = output.split(secret).join('***');
  }
  const collapsed = output.replace(/\s+/gu, ' ').trim();
  return collapsed.length <= MAX_DESCRIPTION_LENGTH
    ? collapsed
    : `${collapsed.slice(0, MAX_DESCRIPTION_LENGTH)}…`;
}

function readOwnString(source: Record<string, unknown>, key: string): string | undefined {
  const value = source[key];
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

/**
 * 把任意驱动异常收敛为**可外发的脱敏摘要**。
 * 未识别形状（非对象 / 无 message）时退化为通用描述，绝不 `String(error)` 原样外发。
 */
export function redactPostgresError(
  error: unknown,
  secrets: readonly string[] = [],
): RedactedPostgresError {
  const record: Record<string, unknown> =
    typeof error === 'object' && error !== null ? (error as Record<string, unknown>) : {};
  const sqlState = readString(record, 'code');
  const severity = readString(record, 'severity');
  const routine = readString(record, 'routine');
  const schema = readString(record, 'schema');
  const table = readString(record, 'table');
  const column = readString(record, 'column');
  const constraint = readString(record, 'constraint');

  const rawMessage =
    readOwnString(record, 'message') ??
    (typeof error === 'string' ? error : undefined) ??
    '数据库驱动抛出未识别错误';

  return {
    ...(sqlState !== undefined ? { sqlState } : {}),
    ...(severity !== undefined ? { severity } : {}),
    ...(routine !== undefined ? { routine } : {}),
    ...(schema !== undefined ? { schema } : {}),
    ...(table !== undefined ? { table } : {}),
    ...(column !== undefined ? { column } : {}),
    ...(constraint !== undefined ? { constraint } : {}),
    description: redactPostgresErrorText(rawMessage, secrets),
  };
}

/** 摘要 → 违规项（只暴露 SQLSTATE 与结构名，`description` 已脱敏） */
export function describeRedactedError(error: RedactedPostgresError): PostgresExecutorErrorIssue {
  const parts = [
    error.sqlState === undefined ? undefined : `sqlstate=${error.sqlState}`,
    error.routine === undefined ? undefined : `routine=${error.routine}`,
    error.constraint === undefined ? undefined : `constraint=${error.constraint}`,
    error.table === undefined ? undefined : `table=${error.table}`,
    error.column === undefined ? undefined : `column=${error.column}`,
  ].filter((part): part is string => part !== undefined);
  return {
    code: error.sqlState ?? 'DRIVER_ERROR',
    detail: parts.length === 0 ? error.description : parts.join(' '),
  };
}

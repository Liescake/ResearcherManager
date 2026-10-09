/**
 * SQL 参数槽静态检查（**驱动无关**，只做文本解析，不执行 SQL）。
 *
 * ## 为什么需要它
 * 生产执行器要求「值一律走占位符绑定」，但「SQL 里有几个参数位」与「调用方传了几个参数」
 * 是两件事：`query('SELECT ... WHERE a = $1 AND b = $2', [x])` 在多数驱动上只会静默把
 * `$2` 当 NULL，或者干脆报一个与真实原因无关的错。更危险的是 `$3` 与 `$1` 混用导致的
 * 参数错位 —— 那种错误在数据上表现为「读到了别人的行」，而不是报错。
 *
 * 因此本模块把「参数位」变成可机器判定的事实：
 * - 占位符只认 `$1`、`$2`…（PostgreSQL 的绑定口径），`${...}` 模板串与 `$tag$` 块不被误认；
 * - 字符串字面量、行注释、块注释与双引号标识符里的 `$n` 一律不算占位符；
 * - 参数位必须**从 1 开始连续**、**不重复**，且数量必须等于传入参数个数。
 *
 * ## 边界事实
 * - 纯文本处理：不 import 任何驱动、不建连接、不执行 SQL、不读环境变量；
 * - 错误信息只含**占位符序号与个数**，不含 SQL 文本与参数取值（SQL 文本可能来自业务模板，
 *   参数取值属于业务数据）。
 */

/** 违规代码：每一条都对应一类可机器判定的「参数绑定不可信」 */
export type SqlParameterSlotIssueCode =
  | 'PARAMETER_SLOT_INVALID'
  | 'PARAMETER_SLOT_DUPLICATE'
  | 'PARAMETER_SLOT_GAP'
  | 'PARAMETER_COUNT_MISMATCH'
  | 'PARAMETER_LIST_INVALID';

export interface SqlParameterSlotIssue {
  readonly code: SqlParameterSlotIssueCode;
  /** 只含占位符序号 / 个数这类结构性事实，不含 SQL 文本与参数取值 */
  readonly detail: string;
}

/** 参数槽检查失败：fail-closed，宁可拒绝也不把值绑到错误的槽位 */
export class SqlParameterSlotError extends Error {
  readonly issues: readonly SqlParameterSlotIssue[];

  constructor(issues: readonly SqlParameterSlotIssue[]) {
    const summary = issues.map((issue) => issue.code).join(', ');
    super(`SQL 参数槽检查失败（${issues.length} 项）: ${summary}`);
    this.name = 'SqlParameterSlotError';
    this.issues = [...issues];
  }
}

export interface SqlParameterSlotReport {
  /** 出现的占位符序号（去重升序） */
  readonly slots: readonly number[];
  /** 占位符出现总次数（重复出现会被计数多次） */
  readonly occurrences: number;
  /** 出现多于一次的序号 */
  readonly duplicates: readonly number[];
  /** 从 1 开始连续（`slots === [1..N]` 且无重复） */
  readonly contiguous: boolean;
}

/**
 * 扫描 SQL 文本，取出绑定占位符序号。
 *
 * 跳过：行注释（`--`）、块注释（`/* *\/`）、单引号字符串（含 `''` 转义）、双引号标识符、
 * `$tag$...$tag$` 块，以及 `${...}` / `$identifier` 这类非数字占位符。
 */
export function inspectSqlParameterSlots(sql: string): SqlParameterSlotReport {
  const counts = new Map<number, number>();
  let index = 0;
  let inSingleQuote = false;
  let inDoubleQuote = false;
  let dollarTag: string | undefined;

  while (index < sql.length) {
    const char = sql[index] ?? '';

    if (dollarTag !== undefined) {
      if (sql.startsWith(dollarTag, index)) {
        index += dollarTag.length;
        dollarTag = undefined;
        continue;
      }
      index += 1;
      continue;
    }

    if (inSingleQuote) {
      if (char === "'") {
        if (sql[index + 1] === "'") {
          index += 2;
          continue;
        }
        inSingleQuote = false;
      }
      index += 1;
      continue;
    }

    if (inDoubleQuote) {
      if (char === '"') {
        if (sql[index + 1] === '"') {
          index += 2;
          continue;
        }
        inDoubleQuote = false;
      }
      index += 1;
      continue;
    }

    if (char === "'") {
      inSingleQuote = true;
      index += 1;
      continue;
    }
    if (char === '"') {
      inDoubleQuote = true;
      index += 1;
      continue;
    }
    if (char === '$') {
      // `$tag$` 块：标签为空或合法标识符
      const blockTag = /^\$[A-Za-z_][A-Za-z0-9_]*\$|^\$\$/u.exec(sql.slice(index));
      if (blockTag !== null) {
        dollarTag = blockTag[0];
        index += dollarTag.length;
        continue;
      }
      const slot = /^\$(\d+)/u.exec(sql.slice(index));
      if (slot !== null) {
        const value = Number(slot[1]);
        counts.set(value, (counts.get(value) ?? 0) + 1);
        index += slot[0].length;
        continue;
      }
      index += 1;
      continue;
    }
    if (char === '-' && sql[index + 1] === '-') {
      while (index < sql.length && sql[index] !== '\n') {
        index += 1;
      }
      continue;
    }
    if (char === '/' && sql[index + 1] === '*') {
      const end = sql.indexOf('*/', index + 2);
      index = end === -1 ? sql.length : end + 2;
      continue;
    }
    index += 1;
  }

  const slots = [...counts.keys()].sort((left, right) => left - right);
  const duplicates = slots.filter((slot) => (counts.get(slot) ?? 0) > 1);
  const occurrences = [...counts.values()].reduce((total, value) => total + value, 0);
  const contiguous =
    duplicates.length === 0 &&
    slots.length > 0 &&
    slots.every((slot, position) => slot === position + 1);

  return { slots, occurrences, duplicates, contiguous };
}

/**
 * 断言：SQL 的参数位与传入参数**严格配对**。
 *
 * - 无占位符且无参数：放行（例如 `SELECT 1`）；
 * - 出现 `$0`：`PARAMETER_SLOT_INVALID`（PG 绑定从 1 开始）；
 * - 序号重复：`PARAMETER_SLOT_DUPLICATE`；
 * - 序号不连续（缺号）：`PARAMETER_SLOT_GAP`；
 * - 占位符数量 ≠ 参数个数：`PARAMETER_COUNT_MISMATCH`。
 *
 * 任一不满足即抛 `SqlParameterSlotError`，**不把值绑到不确定的槽位**。
 */
export function assertQueryParameterSlots(
  sql: string,
  parameters: readonly unknown[] | undefined,
): void {
  if (typeof sql !== 'string') {
    throw new SqlParameterSlotError([
      { code: 'PARAMETER_SLOT_INVALID', detail: 'SQL 必须是字符串' },
    ]);
  }
  const values = parameters ?? [];
  if (!Array.isArray(values)) {
    throw new SqlParameterSlotError([
      { code: 'PARAMETER_LIST_INVALID', detail: '参数必须是数组（或省略）' },
    ]);
  }

  const report = inspectSqlParameterSlots(sql);
  const issues: SqlParameterSlotIssue[] = [];

  if (report.slots.some((slot) => slot < 1)) {
    issues.push({
      code: 'PARAMETER_SLOT_INVALID',
      detail: '占位符序号必须从 $1 开始（$0 不是合法绑定槽位）',
    });
  }
  if (report.duplicates.length > 0) {
    issues.push({
      code: 'PARAMETER_SLOT_DUPLICATE',
      detail: `占位符序号重复出现：${report.duplicates.join(', ')}`,
    });
  }
  if (report.slots.length > 0 && report.duplicates.length === 0 && !report.contiguous) {
    issues.push({
      code: 'PARAMETER_SLOT_GAP',
      detail: `占位符序号不连续：出现 [${report.slots.join(', ')}]`,
    });
  }
  if (report.slots.length !== values.length) {
    issues.push({
      code: 'PARAMETER_COUNT_MISMATCH',
      detail: `SQL 声明 ${report.slots.length} 个参数槽，实际传入 ${values.length} 个参数`,
    });
  }

  if (issues.length > 0) {
    throw new SqlParameterSlotError(issues);
  }
}

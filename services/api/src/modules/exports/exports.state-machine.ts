import { StateTransitionError } from '@rm/shared';
import { ExportStatus } from './exports.port';

/**
 * 导出请求状态机（本切片的三态最小闭集）：
 * `pending -> completed | failed`，终态不可再转移。
 *
 * 与 docs/P2-权限目录与状态机.md §3/§4 的记录风格一致，但导出任务的状态机**尚未进入共享包**：
 * 它是本切片的服务端契约（入口 `pending`、终态 `completed`/`failed`），
 * 在权限目录与数据字典把 `export_requests` 状态固化后再上移到 `@rm/shared`（后续版本项）。
 *
 * 后端白名单校验，客户端按钮状态不构成控制：
 * - 唯一的入口状态是 `pending`（服务端常量，客户端提交同名字段一律 400，
 *   见 `exports.contract.ts` 的请求体闭集）；
 * - 处理对调用方是**一次请求内完成**的，因此 `pending` 只允许推进到终态；
 * - 终态不可再转移：一条导出请求的结论一旦落库就不再被覆盖
 *   （重复处理同一请求必须被拦截为 409 `STATE_TRANSITION_INVALID`，
 *   而不是静默改写历史结论）。
 */

/** 唯一入口状态：创建时由服务端写入 */
export const EXPORT_ENTRY_STATUS = ExportStatus.Pending;

export const EXPORT_STATUS_TRANSITIONS: Record<ExportStatus, readonly ExportStatus[]> = {
  [ExportStatus.Pending]: [ExportStatus.Completed, ExportStatus.Failed],
  [ExportStatus.Completed]: [],
  [ExportStatus.Failed]: [],
};

/** 终态集合：到达后不允许再变化，也不允许再次处理 */
export const EXPORT_TERMINAL_STATUSES: readonly ExportStatus[] = [
  ExportStatus.Completed,
  ExportStatus.Failed,
];

export function canTransitionExport(from: ExportStatus, to: ExportStatus): boolean {
  return EXPORT_STATUS_TRANSITIONS[from].includes(to);
}

export function nextExportStatuses(from: ExportStatus): readonly ExportStatus[] {
  return EXPORT_STATUS_TRANSITIONS[from];
}

/** 非法转移抛出业务错误，由 API 层映射为 409 `STATE_TRANSITION_INVALID` */
export function assertExportTransition(from: ExportStatus, to: ExportStatus): void {
  if (!canTransitionExport(from, to)) {
    throw new StateTransitionError('export request', from, to);
  }
}

export function isExportTerminal(status: ExportStatus): boolean {
  return EXPORT_TERMINAL_STATUSES.includes(status);
}

/** 只有待处理状态可以进入处理流程；重复处理必须被拦截 */
export function isExportProcessable(status: ExportStatus): boolean {
  return status === EXPORT_ENTRY_STATUS;
}

/**
 * **可撤销前驱集合**（本人撤销切片，服务端常量，唯一事实来源）。
 *
 * 重要：撤销（`revokeMyExportRequest`）**不是**一次状态机转移 —— 它是与状态机**正交**的服务端
 * 事实（写 `revoked_at`，不改 `status`、不改 `artifact_id`，见 `db/migrations/0016_export_jobs_revocation.sql`）。
 * 因此下面这个集合刻意**不出现在** `EXPORT_STATUS_TRANSITIONS` 里：把它写成一条「转移到 revoked」
 * 的边会让一条并不存在的第四个状态进入状态机闭集，也会让「撤销」看起来像一次结论推进。
 *
 * 它存在的原因只有一个：撤销的**条件更新**需要一个稳定的前驱谓词
 * （内存基线与数据库 adapter 必须完全一致），而「哪些结论允许被撤销」是服务端规则：
 * - `pending`：可撤销（还没产出交付物，撤销即取消受理）；
 * - `completed`：可撤销（交付物已生成，撤销即取回交付能力）；
 * - `failed`：**不可撤销**（失败结论没有任何可交付内容，撤销它只会凭空改写历史结论）。
 *
 * 与 SQL 的关系：数据库 adapter 把本集合作为参数绑定进
 * `WHERE status::text = ANY($n::text[])`，迁移 `0016` 的 CHECK
 * `export_jobs_revoked_at_matches_status` 是同一条规则的**存储层镜像**（列级闭集字面量）。
 * `expired`（已过期）**不在**这里：过期是相对当前时刻的性质，由 service 的撤销边界判定
 * （与下载边界共用 `isExportDownloadExpired`），不得下沉到存储层约束。
 */
export const EXPORT_REVOCABLE_STATUSES: readonly ExportStatus[] = [
  ExportStatus.Pending,
  ExportStatus.Completed,
];

/** 该结论是否允许被本人撤销（唯一的判定位点，内存基线与数据库 adapter 共用） */
export function isExportRevocableStatus(status: ExportStatus): boolean {
  return EXPORT_REVOCABLE_STATUSES.includes(status);
}

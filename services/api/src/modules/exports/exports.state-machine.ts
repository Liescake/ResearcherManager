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

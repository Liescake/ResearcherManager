import { MatchingRequestStatus } from '../enums/status';
import { StateTransitionError } from '../errors';

/**
 * 匹配请求状态机（ai_match_records）。
 *
 * 后端白名单校验，前端按钮状态不构成控制：
 * - 唯一的入口状态是 `pending`（服务端常量，客户端提交同名状态一律 400）；
 * - 处理过程对调用方是**一次请求内完成**的，因此 `pending` 只允许推进到终态；
 * - 三个终态都不可再转移：一条匹配请求的推荐结果一旦落库就不再被覆盖
 *   （重复处理同一请求必须被拦截，而不是静默改写历史结果）；
 * - `completed` / `no_candidate` / `failed` 的语义边界见 `enums/status.ts`
 *   `MatchingRequestStatus`：只有 `completed` 才保证携带 1—3 条推荐。
 */

/** 唯一入口状态：创建时由服务端写入 */
export const MATCHING_REQUEST_ENTRY_STATUS = MatchingRequestStatus.Pending;

export const MATCHING_REQUEST_STATUS_TRANSITIONS: Record<
  MatchingRequestStatus,
  readonly MatchingRequestStatus[]
> = {
  [MatchingRequestStatus.Pending]: [
    MatchingRequestStatus.Completed,
    MatchingRequestStatus.NoCandidate,
    MatchingRequestStatus.Failed,
  ],
  [MatchingRequestStatus.Completed]: [],
  [MatchingRequestStatus.NoCandidate]: [],
  [MatchingRequestStatus.Failed]: [],
};

/** 终态集合：到达后不允许再变化，也不允许再次处理 */
export const MATCHING_REQUEST_TERMINAL_STATUSES: readonly MatchingRequestStatus[] = [
  MatchingRequestStatus.Completed,
  MatchingRequestStatus.NoCandidate,
  MatchingRequestStatus.Failed,
];

export function canTransitionMatchingRequest(
  from: MatchingRequestStatus,
  to: MatchingRequestStatus,
): boolean {
  return MATCHING_REQUEST_STATUS_TRANSITIONS[from].includes(to);
}

export function nextMatchingRequestStatuses(
  from: MatchingRequestStatus,
): readonly MatchingRequestStatus[] {
  return MATCHING_REQUEST_STATUS_TRANSITIONS[from];
}

/** 非法转移抛出业务错误，由 API 层映射为 STATE_TRANSITION_INVALID（409） */
export function assertMatchingRequestTransition(
  from: MatchingRequestStatus,
  to: MatchingRequestStatus,
): void {
  if (!canTransitionMatchingRequest(from, to)) {
    throw new StateTransitionError('matching request', from, to);
  }
}

export function isMatchingRequestTerminal(status: MatchingRequestStatus): boolean {
  return MATCHING_REQUEST_TERMINAL_STATUSES.includes(status);
}

/** 只有待处理状态可以进入处理流程；重复处理必须被拦截 */
export function isMatchingRequestProcessable(status: MatchingRequestStatus): boolean {
  return status === MATCHING_REQUEST_ENTRY_STATUS;
}

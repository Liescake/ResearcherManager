/**
 * 全局常量：API 前缀、分页上限、幂等与请求头名称、AI 匹配取值范围。
 * 这些值必须与 docs/P2-API契约基线.md 保持一致。
 */

export const API_PREFIX = '/api/v1';

export const DEFAULT_PAGE_SIZE = 20;
export const MAX_PAGE_SIZE = 100;

export const REQUEST_ID_HEADER = 'x-request-id';
export const IDEMPOTENCY_HEADER = 'idempotency-key';

/** 匹配结果：1—3 个小组、0—100 分 */
export const MATCHING_MIN_RECOMMENDATIONS = 1;
export const MATCHING_MAX_RECOMMENDATIONS = 3;
export const MATCHING_SCORE_MIN = 0;
export const MATCHING_SCORE_MAX = 100;

/** 单条理由与建议的最大长度，防止模型输出无界文本 */
export const MATCHING_REASON_MAX_LENGTH = 500;
export const MATCHING_SUGGESTION_MAX_LENGTH = 500;

/** 管理员代改必须填写理由，长度下限与 P1 数据字典一致 */
export const ADMIN_CORRECTION_REASON_MIN_LENGTH = 10;
export const ADMIN_CORRECTION_REASON_MAX_LENGTH = 500;

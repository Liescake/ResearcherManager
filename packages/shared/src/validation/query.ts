import { z } from 'zod';
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from '../constants';

/** 列表查询统一分页：服务端强制上限，避免一次拉全表 */
export const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(DEFAULT_PAGE_SIZE),
});

export type Pagination = z.infer<typeof paginationSchema>;

export const SortOrder = {
  Asc: 'asc',
  Desc: 'desc',
} as const;
export type SortOrder = (typeof SortOrder)[keyof typeof SortOrder];
export const SORT_ORDER_VALUES = [SortOrder.Asc, SortOrder.Desc] as const;

/**
 * 排序白名单：只允许排序字段表内的字段，防止通过排序构造注入或越权探测。
 */
export function sortSchema<T extends readonly [string, ...string[]]>(allowedFields: T) {
  return z.object({
    sortBy: z.enum(allowedFields).optional(),
    sortOrder: z.enum(SORT_ORDER_VALUES).default(SortOrder.Desc),
  });
}

/** 关键词搜索：限制长度，禁止控制字符 */
export const keywordSchema = z.string().trim().max(50, '关键词长度不能超过 50').optional();

export interface Paginated<T> {
  items: T[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

/** 统一分页包装：totalPages 由服务端计算，前端不重复推导 */
export function paginate<T>(
  items: readonly T[],
  total: number,
  pagination: Pagination,
): Paginated<T> {
  const totalPages = total === 0 ? 0 : Math.ceil(total / pagination.pageSize);
  return {
    items: [...items],
    page: pagination.page,
    pageSize: pagination.pageSize,
    total,
    totalPages,
  };
}

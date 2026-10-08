/**
 * 受控枚举工具：统一使用「常量对象 + 联合类型 + 值数组 + 类型守卫」模式，
 * 避免散落的字符串字面量驱动授权或状态判断。
 */

export type ValueOf<T extends Record<string, string>> = T[keyof T];

/** 生成运行时类型守卫；未知值一律判为非该枚举成员（默认拒绝）。 */
export function createValueGuard<T extends string>(
  values: readonly T[],
): (value: unknown) => value is T {
  const allowed = new Set<string>(values);
  return (value: unknown): value is T => typeof value === 'string' && allowed.has(value);
}

/** 生成本地化标签查询函数，未知值返回占位符而不是抛错，避免展示层崩溃。 */
export function createLabelLookup<T extends string>(
  labels: Record<T, string>,
  fallback = '未知',
): (value: T) => string {
  return (value: T): string => labels[value] ?? fallback;
}

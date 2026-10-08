import { z } from 'zod';

/**
 * 统计切片的**聚合输出白名单**（读取契约）与**查询串闭集**。
 *
 * 输出白名单：`GET /me/statistics` 的 `data` **只允许**四个整数字段
 * （`educationRecords` / `applications` / `achievements` / `matchingRequests`），
 * 它们是服务端主体本人名下四类记录的**条数**。白名单是 `.strict()` 的：出现第五个字段
 * 即判为契约漂移，由 service 按服务端缺陷 500 处理，绝不外发。
 * 因为端口只返回计数、视图逐字段显式赋值、出口再校验一次，响应在结构上不可能携带
 * 记录内容、主键、归属、姓名/学号/手机号等 PII —— 这不是「记得别带」，而是可断言的闭集。
 *
 * 查询串闭集：本端点**不声明任何查询参数**。查询串里的 `userId`/`roles`/`scope`/`groupId`
 * 等授权声明（claims）不是「被忽略的输入」，而是明确不被接受的输入：出现即 400
 * `VALIDATION_FAILED`（服务端独占字段与未声明字段给出可区分的拒绝原因），
 * 因此不存在「靠查询串改口径」的路径，也不需要靠后端「恰好没读它」来保证安全。
 *
 * 计数合法性：计数必须是 `0..STATISTICS_COUNT_MAX` 的安全整数。负数/小数/NaN/Infinity/
 * 超上限（含仓储返回对象、字符串等类型错误）一律视为存储层缺陷 → 500，
 * 不允许把未定义口径的数字当作统计结果返回给调用方（与其它切片的读取契约同构）。
 */

/** 单个来源计数的上限：防御仓储返回无界数值/被污染的数值，并使响应形状可预期 */
export const STATISTICS_COUNT_MAX = 1_000_000_000;

/** 聚合输出白名单：字段即契约，顺序用于文档与回归断言 */
export const SELF_STATISTICS_FIELDS = [
  'educationRecords',
  'applications',
  'achievements',
  'matchingRequests',
] as const;

/** 单个计数的读取契约 */
export const statisticsCountSchema = z
  .number()
  .int('计数必须是整数')
  .min(0, '计数不能为负数')
  .max(STATISTICS_COUNT_MAX, '计数超出上限');

/** 聚合视图的读取契约：白名单闭集（`.strict()` 使「多出字段」成为可检测的违规） */
export const selfStatisticsSchema = z
  .object({
    educationRecords: statisticsCountSchema,
    applications: statisticsCountSchema,
    achievements: statisticsCountSchema,
    matchingRequests: statisticsCountSchema,
  })
  .strict();

/**
 * 对外视图：只有四个计数。
 * **不含** `userId`（归属）、不含任何记录标识与字段取值，也不含请求级输入回显。
 */
export interface SelfStatisticsView {
  readonly educationRecords: number;
  readonly applications: number;
  readonly achievements: number;
  readonly matchingRequests: number;
}

/** 读取契约违规的统一对外文案（与其它切片一致：不区分内部原因，细节只进日志） */
export const STATISTICS_INTEGRITY_MESSAGE = '本人统计数据完整性校验失败';

export interface StatisticsContractIssue {
  readonly kind: 'invalid' | 'unexpected';
  readonly path: string;
}

export type StatisticsCountParse =
  | { readonly ok: true; readonly value: number }
  | { readonly ok: false; readonly issues: readonly StatisticsContractIssue[] };

export type SelfStatisticsParse =
  | { readonly ok: true; readonly value: SelfStatisticsView }
  | { readonly ok: false; readonly issues: readonly StatisticsContractIssue[] };

/**
 * 把 zod 的 issue 归一为「字段路径 + 违规类型」，**不回传字段取值**。
 * 多出字段（`unrecognized_keys`）的键名在 `issue.keys` 里而不在 `issue.path` 上，
 * 因此逐键展开为一条 issue，避免把「多了哪个字段」丢成 `(root)`。
 */
function toIssues(error: z.ZodError): StatisticsContractIssue[] {
  const issues: StatisticsContractIssue[] = [];
  for (const issue of error.issues) {
    if (issue.code === 'unrecognized_keys') {
      for (const key of issue.keys) {
        issues.push({ kind: 'unexpected', path: key });
      }
      continue;
    }
    issues.push({ kind: 'invalid', path: issue.path.join('.') || '(root)' });
  }
  return issues;
}

/** 校验单个来源的计数（仓储返回值在进入聚合前必须先过这一关） */
export function parseStatisticsCount(value: unknown): StatisticsCountParse {
  const parsed = statisticsCountSchema.safeParse(value);
  if (parsed.success) {
    return { ok: true, value: parsed.data };
  }
  return { ok: false, issues: toIssues(parsed.error) };
}

/** 出口门禁：聚合视图必须是恰好四个合法计数的闭集 */
export function parseSelfStatisticsView(view: unknown): SelfStatisticsParse {
  const parsed = selfStatisticsSchema.safeParse(view);
  if (parsed.success) {
    return { ok: true, value: parsed.data };
  }
  return { ok: false, issues: toIssues(parsed.error) };
}

/** 本端点声明的查询参数闭集：**空集**（`/me/statistics` 不接受任何查询参数） */
export const STATISTICS_QUERY_FIELDS = [] as const;

/**
 * 服务端独占的查询串声明（**禁止客户端提交**）：这些名字是授权/归属口径
 * （身份、角色、范围、小组归属、权限点），只能来自服务端会话与常量。
 * 即使它们不在任何 schema 内，也要给出与「未声明参数」可区分的拒绝原因，
 * 避免「以为是业务参数但被静默忽略」。
 *
 * 其余任何参数（如 `page`/`pageSize`/`sortBy`/`keyword`/`metrics` 等分页、排序与明细口径）
 * 同样被拒绝，只是原因归入「本端点不接受查询参数」这一类：本端点**不声明任何查询参数**。
 */
export const FORBIDDEN_STATISTICS_QUERY_FIELDS = [
  'userId',
  'userIds',
  'ownerUserId',
  'role',
  'roles',
  'scope',
  'dataScope',
  'groupId',
  'groupIds',
  'permissions',
  'permissionPoints',
  'assignedResourceIds',
] as const;

/**
 * 查询串闭集门禁：出现任何查询参数即抛 `ZodError`，由 `ApiExceptionFilter` 统一映射为
 * 400 `VALIDATION_FAILED` + `details.issues`（`path` 指向违规参数本身）。
 *
 * 非对象查询（`undefined`／`null`，即无查询串）不在这里拒绝：那是「没有输入」的正常情况。
 * 重复参数（如 `?userId=a&userId=b`）在 Express 下会解析成数组，但键名仍然违规，因此同样被拒绝。
 */
export function assertDeclaredStatisticsQueryFields(query: unknown): void {
  if (typeof query !== 'object' || query === null || Array.isArray(query)) return;

  const declared: readonly string[] = STATISTICS_QUERY_FIELDS;
  const forbidden: readonly string[] = FORBIDDEN_STATISTICS_QUERY_FIELDS;
  const unexpected = Object.keys(query).filter((key) => !declared.includes(key));
  if (unexpected.length === 0) return;

  throw new z.ZodError(
    unexpected.map((key) => ({
      code: 'unrecognized_keys' as const,
      keys: [key],
      path: [key] as (string | number)[],
      message: forbidden.includes(key)
        ? `禁止使用查询参数 ${key}（授权与归属只来自服务端会话）`
        : `本端点不接受查询参数 ${key}`,
    })),
  );
}

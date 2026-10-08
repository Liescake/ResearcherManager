import { z } from 'zod';
import {
  EDUCATION_STATUS_VALUES,
  EDUCATION_TYPE_VALUES,
  REVIEW_STATUS_VALUES,
  trimmedText,
  yearSchema,
} from '@rm/shared';
import type { EducationRecord } from './education-records.port';

/**
 * 升学记录切片的**输入闭集**与**读取契约**。
 *
 * 输入闭集：写接口只接受这四个字段。出现闭集之外的字段（`roles`、`scope`、`groupId`、
 * `userId`、`reviewStatus`…）一律 400，而不是「静默忽略」——客户端提交的权限/范围/归属
 * 不是「被忽略的输入」，而是明确不被接受的输入，必须留下可观测的拒绝记录。
 *
 * 读取契约：存储记录在离开进程前必须满足本结构（含枚举闭集与时间格式）。
 * 未知枚举（例如数据库迁移先于代码上线、或数据被外部改写）属于服务端缺陷：
 * 由 service 判为 500，绝不允许把未知状态当作合法值返回给调用方。
 */

/** 写接口声明的请求字段闭集 */
export const EDUCATION_RECORD_INPUT_FIELDS = [
  'year',
  'type',
  'status',
  'institutionOrDestination',
] as const;

/** 存储记录读取契约：字段 + 枚举闭集 + ISO 时间戳 */
export const storedEducationRecordSchema = z.object({
  id: z.string().uuid('必须是合法的 UUID'),
  userId: trimmedText(1, 64, '归属主体'),
  year: yearSchema,
  type: z.enum(EDUCATION_TYPE_VALUES),
  status: z.enum(EDUCATION_STATUS_VALUES),
  institutionOrDestination: trimmedText(0, 200, '院校或去向').optional(),
  reviewStatus: z.enum(REVIEW_STATUS_VALUES),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export type StoredEducationRecord = z.infer<typeof storedEducationRecordSchema>;

/**
 * 对外视图：**不含** `userId`。
 * 自读范围下调用方就是归属主体本人，响应里不需要、也不应该携带归属与身份字段，
 * 这样客户端就没有任何可回传的归属信息可用于伪造。
 */
export interface EducationRecordView {
  id: string;
  year: number;
  type: StoredEducationRecord['type'];
  status: StoredEducationRecord['status'];
  institutionOrDestination?: string;
  reviewStatus: StoredEducationRecord['reviewStatus'];
  createdAt: string;
  updatedAt: string;
}

export interface EducationRecordContractIssue {
  readonly kind: 'invalid' | 'unexpected';
  readonly path: string;
}

export type StoredEducationRecordParse =
  | { readonly ok: true; readonly value: StoredEducationRecord }
  | { readonly ok: false; readonly issues: readonly EducationRecordContractIssue[] };

/**
 * 校验并规范化一条存储记录（一次解析，避免「先断言后使用」的重复解析）。
 * 失败时只返回字段路径与违规类型，不返回字段取值。
 */
export function parseStoredEducationRecord(record: unknown): StoredEducationRecordParse {
  const parsed = storedEducationRecordSchema.safeParse(record);
  if (parsed.success) {
    return { ok: true, value: parsed.data };
  }
  return {
    ok: false,
    issues: parsed.error.issues.map((issue) => ({
      kind: issue.code === 'unrecognized_keys' ? ('unexpected' as const) : ('invalid' as const),
      path: issue.path.join('.') || '(root)',
    })),
  };
}

/** 校验后的存储记录 → 对外视图（逐字段显式赋值，不使用对象展开） */
export function toEducationRecordView(record: StoredEducationRecord): EducationRecordView {
  return {
    id: record.id,
    year: record.year,
    type: record.type,
    status: record.status,
    ...(record.institutionOrDestination
      ? { institutionOrDestination: record.institutionOrDestination }
      : {}),
    reviewStatus: record.reviewStatus,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

/**
 * 字段闭集门禁：请求体出现未声明字段时抛 `ZodError`，
 * 由 `ApiExceptionFilter` 统一映射为 400 `VALIDATION_FAILED` + `details.issues`。
 * 非对象请求体（缺体、`null`、数组、标量）不在这里拒绝，交给字段级 schema 判非法。
 */
export function assertDeclaredInputFields(body: unknown): void {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return;

  const declared: readonly string[] = EDUCATION_RECORD_INPUT_FIELDS;
  const unexpected = Object.keys(body).filter((key) => !declared.includes(key));
  if (unexpected.length === 0) return;

  throw new z.ZodError(
    unexpected.map((key) => ({
      code: 'unrecognized_keys' as const,
      keys: [key],
      path: [] as (string | number)[],
      message: `请求体包含未声明字段 ${key}`,
    })),
  );
}

/** 供测试与调用方复用：记录归属主体（不可读时返回空串，交由授权判定默认拒绝） */
export function readRecordOwnerId(record: EducationRecord): string {
  return typeof record.userId === 'string' ? record.userId : '';
}

import { z } from 'zod';
import { trimmedText, uuidSchema } from '@rm/shared';
import {
  EXPORT_RESOURCE_VALUES,
  EXPORT_STATUS_VALUES,
  ExportResource,
  ExportStatus,
  isExportResource,
} from './exports.port';

/**
 * 导出切片的**输入闭集**、**服务端字段白名单**、**读取契约**与**输出白名单**。
 *
 * 输入闭集（`POST /me/exports` 只接受两个字段）：
 * - `resource`：必须是服务端白名单资源（`profile` / `achievement` / `education` / `statistics`）；
 * - `fields`：可选的导出字段列表，必须是**该资源服务端白名单的子集**（缺省 = 白名单全集）。
 *
 * 闭集之外的字段一律 400，**不是静默忽略**：`userId`/`roles`/`scope`/`groupId`/`status`/
 * `fileUrl`/`path`/`artifactId`/`createdAt` 之类的服务端字段是必须显式拒绝的越权尝试，
 * 拒绝原因与「未声明字段」可区分（`exports.service.ts` 的判定顺序把它们与字段级白名单分开）。
 *
 * 值得注意的一致性细节：`fields` 里的 `status`（升学记录的升学状态）是**资源字段名**，
 * 与请求体的顶层 `status`（导出任务状态，服务端独占）不是一回事：
 * 闭集门禁只看请求体的**顶层键**，因此 `{"status":"completed"}` 被拒绝（400），
 * 而 `{"resource":"education","fields":["status"]}` 合法。
 *
 * 输出白名单（`EXPORT_REQUEST_VIEW_FIELDS`）：对外视图**恰好**是
 * `id` / `resource` / `fields` / `status` / `createdAt` / `updatedAt`，
 * 不含归属 `ownerUserId`、不含产物句柄 `artifactId`，也**不含任何文件路径、下载地址、
 * 存储 key 或文件名**——这些字段在存储记录与端口返回值里就不存在（见 `exports.port.ts`）。
 *
 * 读取契约（存储记录离开进程前的最后一道门）：字段闭集（`.strict()`）、枚举闭集、
 * 字段白名单子集与去重、状态与产物句柄自洽、ISO 时间戳。任一项违规都属于服务端缺陷：
 * 按 500 处理，**且日志与错误详情只写字段路径与违规类型、不写取值**，
 * 因此即便存储里被塞进了证件号或文件路径，也不会经由本切片的任何响应或日志外发。
 */

/**
 * 服务端**可导出字段白名单**（按资源）：镜像各资源本人读取视图（profiles / achievements /
 * education / statistics）的字段集合。高敏与内部字段**不在白名单内**（因此客户端请求它们只会 400）：
 * - 画像：`name` / `studentNo` / `phone` / `privacyConsent` 与归属 `userId` 全部不可导出；
 * - 成果：证据文件标识 `evidenceFileId` 不可导出（不把内部文件指针带进导出）；
 * - 升学：归属 `userId` 不可导出；
 * - 统计：只导出四类计数，不导出任何明细标识。
 *
 * 字段名本身也只是「列名」；真正的取值脱敏与文件生成属后续切片（本切片只把**列白名单**
 * 固定下来，因此导出范围在契约层面就是闭合的）。
 */
export const EXPORTABLE_FIELDS: Readonly<Record<ExportResource, readonly string[]>> = {
  [ExportResource.Profile]: [
    'college',
    'major',
    'grade',
    'skills',
    'programmingLevel',
    'researchExperience',
    'competitionExperience',
    'availableTime',
    'researchInterests',
    'strengths',
    'intendedFields',
    'createdAt',
    'updatedAt',
  ],
  [ExportResource.Achievement]: [
    'type',
    'title',
    'awardLevel',
    'description',
    'achievedAt',
    'reviewStatus',
    'createdAt',
    'updatedAt',
  ],
  [ExportResource.Education]: [
    'year',
    'type',
    'status',
    'institutionOrDestination',
    'reviewStatus',
    'createdAt',
    'updatedAt',
  ],
  [ExportResource.Statistics]: [
    'educationRecords',
    'applications',
    'achievements',
    'matchingRequests',
  ],
};

/**
 * 全部白名单字段名的**并集**（去重）：用于输出契约的闭集校验。
 * 必须与 `EXPORTABLE_FIELDS` 的并集逐项一致（`exports.controller.spec.ts` 有回归断言）。
 */
export const EXPORTABLE_FIELD_NAME_VALUES = [
  'college',
  'major',
  'grade',
  'skills',
  'programmingLevel',
  'researchExperience',
  'competitionExperience',
  'availableTime',
  'researchInterests',
  'strengths',
  'intendedFields',
  'createdAt',
  'updatedAt',
  'type',
  'title',
  'awardLevel',
  'description',
  'achievedAt',
  'reviewStatus',
  'year',
  'status',
  'institutionOrDestination',
  'educationRecords',
  'applications',
  'achievements',
  'matchingRequests',
] as const;

/** 单次导出可声明的字段数上限：等于最大的资源白名单长度（白名单本身即上界） */
export const EXPORT_MAX_FIELD_COUNT = Object.values(EXPORTABLE_FIELDS).reduce(
  (max, fields) => Math.max(max, fields.length),
  0,
);

/** 归属主体形态：与会话存储的 ID 白名单同构（非空、无空白与控制字符、长度受控） */
export const requesterIdSchema = z
  .string()
  .regex(/^[A-Za-z0-9._:@-]{1,64}$/u, '导出请求归属形态不合法');

/** 读取契约违规、归属不一致等内部缺陷的统一对外文案（不区分内部原因，细节只进日志） */
export const EXPORT_REQUEST_INTEGRITY_MESSAGE = '导出请求完整性校验失败';

/**
 * 导出资源字段的**输入闭集**（与服务端白名单一致；缺省 = 白名单全集）。
 * 每个元素只能是「列名」，因此不对元素内容做免 PII 校验：白名单之外的一切取值（含证件号、
 * 路径、URL）都命中「不在白名单内」并被拒绝，且拒绝原因**不回显该取值**。
 */
export const exportRequestInputSchema = z
  .object({
    resource: z
      .string({
        required_error: '必须声明导出资源',
        invalid_type_error: '导出资源必须是字符串',
      })
      .refine((value): value is ExportResource => isExportResource(value), {
        message: '导出资源不在服务端白名单内',
      }),
    fields: z
      .array(trimmedText(1, 64, '导出字段'))
      .min(1, '导出字段至少 1 项')
      .max(EXPORT_MAX_FIELD_COUNT, `导出字段最多 ${EXPORT_MAX_FIELD_COUNT} 项`)
      .optional(),
  })
  .strict();

export type ExportRequestInput = z.infer<typeof exportRequestInputSchema>;

/**
 * 字段白名单门禁：把客户端声明的字段（或白名单全集）归一化为服务端选定的字段列表。
 *
 * - 白名单之外的取值一律抛 `ZodError`（`path` 指向 `fields.<下标>`，**不回显取值**，
 *   避免把客户端塞进来的证件号/路径写进响应或日志）；
 * - 重复字段按**首次出现**去重（不报错：请求仍是白名单内的合法子集）；
 * - 缺省时返回白名单全集（顺序固定 = 契约顺序，便于回归断言）。
 */
export function resolveExportFields(
  resource: ExportResource,
  requested: readonly string[] | undefined,
): string[] {
  const whitelist = EXPORTABLE_FIELDS[resource];
  const chosen = requested === undefined ? whitelist : requested;

  const issues: z.ZodIssue[] = [];
  const seen = new Set<string>();
  const normalized: string[] = [];

  chosen.forEach((field, index) => {
    if (!whitelist.includes(field)) {
      issues.push({
        code: z.ZodIssueCode.custom,
        path: ['fields', index],
        message: `导出字段不在资源 ${resource} 的服务端白名单内`,
      });
      return;
    }
    if (seen.has(field)) return;
    seen.add(field);
    normalized.push(field);
  });

  if (issues.length > 0) throw new z.ZodError(issues);
  return normalized;
}

/** 存储记录读取契约：字段闭集 + 枚举闭集 + 字段白名单子集/去重 + 状态与产物自洽 + ISO 时间 */
const storedExportRequestObjectSchema = z
  .object({
    id: uuidSchema,
    ownerUserId: requesterIdSchema,
    resource: z.enum(EXPORT_RESOURCE_VALUES),
    fields: z.array(z.string().min(1).max(64)).min(1).max(EXPORT_MAX_FIELD_COUNT),
    status: z.enum(EXPORT_STATUS_VALUES),
    artifactId: uuidSchema.optional(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .strict();

export const storedExportRequestSchema = storedExportRequestObjectSchema.superRefine(
  (value, ctx) => {
    const whitelist = EXPORTABLE_FIELDS[value.resource];
    const unique = new Set(value.fields);
    if (
      unique.size !== value.fields.length ||
      value.fields.some((field) => !whitelist.includes(field))
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['fields'],
        message: '导出字段必须是该资源服务端白名单的子集且不重复',
      });
    }

    // 状态与产物句柄必须自洽：`completed` 必有产物；`pending` / `failed` 必无产物
    if (value.status === ExportStatus.Completed && value.artifactId === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['artifactId'],
        message: 'completed 状态必须携带服务端产物句柄',
      });
    }
    if (value.status !== ExportStatus.Completed && value.artifactId !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['artifactId'],
        message: `${value.status} 状态不得携带服务端产物句柄`,
      });
    }
  },
);

export type StoredExportRequest = z.infer<typeof storedExportRequestObjectSchema>;

/** 对外视图字段白名单（顺序即文档顺序） */
export const EXPORT_REQUEST_VIEW_FIELDS = [
  'id',
  'resource',
  'fields',
  'status',
  'createdAt',
  'updatedAt',
] as const;

export type ExportRequestViewField = (typeof EXPORT_REQUEST_VIEW_FIELDS)[number];

/** 对外视图的必需字段：本切片的视图字段全部必需（没有条件字段，产物句柄一律不外发） */
export const EXPORT_REQUEST_VIEW_REQUIRED_FIELDS = [
  'id',
  'resource',
  'fields',
  'status',
  'createdAt',
  'updatedAt',
] as const;

/** 出口门禁：视图必须是白名单闭集（多出字段、非法枚举一律违规） */
export const exportRequestViewSchema = z
  .object({
    id: uuidSchema,
    resource: z.enum(EXPORT_RESOURCE_VALUES),
    fields: z.array(z.enum(EXPORTABLE_FIELD_NAME_VALUES)).min(1).max(EXPORT_MAX_FIELD_COUNT),
    status: z.enum(EXPORT_STATUS_VALUES),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .strict();

/**
 * 对外视图：**不含**归属 `ownerUserId`、产物句柄 `artifactId`，
 * 也不含文件名/路径/下载地址/存储 key（这些字段在本切片的存储记录里就不存在）。
 */
export interface ExportRequestView {
  id: string;
  resource: ExportResource;
  fields: string[];
  status: ExportStatus;
  createdAt: string;
  updatedAt: string;
}

export interface ExportContractIssue {
  readonly kind: 'invalid' | 'unexpected';
  readonly path: string;
}

export type StoredExportRequestParse =
  | { readonly ok: true; readonly value: StoredExportRequest }
  | { readonly ok: false; readonly issues: readonly ExportContractIssue[] };

export type ExportRequestViewParse =
  | { readonly ok: true; readonly value: ExportRequestView }
  | { readonly ok: false; readonly issues: readonly ExportContractIssue[] };

/**
 * 把 zod 的 issue 归一为「字段路径 + 违规类型」，**不回传字段取值与消息**。
 * 多出字段（`unrecognized_keys`）的键名在 `issue.keys` 里而不在 `issue.path` 上，
 * 因此逐键展开为一条 issue，避免把「多了哪个字段」丢成 `(root)`。
 */
function toIssues(error: z.ZodError): ExportContractIssue[] {
  const issues: ExportContractIssue[] = [];
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

/** 校验并规范化一条存储记录（失败时只给字段路径与违规类型，不给取值） */
export function parseStoredExportRequest(record: unknown): StoredExportRequestParse {
  const parsed = storedExportRequestSchema.safeParse(record);
  if (parsed.success) {
    return { ok: true, value: parsed.data };
  }
  return { ok: false, issues: toIssues(parsed.error) };
}

/** 出口门禁：对外视图必须是白名单闭集（多出字段、非法字段值一律违规） */
export function parseExportRequestView(view: unknown): ExportRequestViewParse {
  const parsed = exportRequestViewSchema.safeParse(view);
  if (parsed.success) {
    return { ok: true, value: parsed.data };
  }
  return { ok: false, issues: toIssues(parsed.error) };
}

/** 校验后的存储记录 → 对外视图（逐字段显式赋值，不使用对象展开，避免未知字段外泄） */
export function toExportRequestView(record: StoredExportRequest): ExportRequestView {
  return {
    id: record.id,
    resource: record.resource,
    fields: [...record.fields],
    status: record.status,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

/** 供测试与调用方复用：记录归属主体（不可读时返回空串，交由调用方按服务端缺陷处理） */
export function readExportOwnerId(record: { readonly ownerUserId?: unknown }): string {
  return typeof record.ownerUserId === 'string' ? record.ownerUserId : '';
}

/** 产物句柄契约：只有一个不透明 UUID，多余字段即违规 */
export const exportArtifactRefSchema = z.object({ artifactId: uuidSchema }).strict();

/**
 * 读取产物句柄：形态非法一律返回 `undefined`（调用方按「导出未生成」收敛为 `failed` 终态），
 * 因此非法返回值的内容既不会被落库，也不会被外发。
 */
export function readArtifactId(ref: unknown): string | undefined {
  const parsed = exportArtifactRefSchema.safeParse(ref);
  return parsed.success ? parsed.data.artifactId : undefined;
}

/**
 * 端点声明的查询参数闭集：**空集**（`/me/exports` 的读与写都不接受任何查询参数）。
 * 列表筛选、分页与排序属后续切片；`?status=` / `?userId=` 这类查询不是「被忽略的输入」，
 * 而是明确不被接受的输入。
 */
export const EXPORT_QUERY_FIELDS = [] as const;

/**
 * 服务端独占的查询串声明（**禁止客户端提交**）：身份、操作主体、角色、范围、小组归属、
 * 权限点、任务状态与产物位置（文件名/路径/下载地址/存储 key）都只能来自服务端。
 */
export const FORBIDDEN_EXPORT_QUERY_FIELDS = [
  'id',
  'exportId',
  'exportRequestId',
  'requestId',
  'userId',
  'userIds',
  'ownerUserId',
  'ownerId',
  'actorUserId',
  'actorId',
  'targetUserId',
  'role',
  'roles',
  'scope',
  'dataScope',
  'groupId',
  'groupIds',
  'permissions',
  'permissionPoints',
  'assignedResourceIds',
  'status',
  'state',
  'fileUrl',
  'fileURL',
  'downloadUrl',
  'signedUrl',
  'url',
  'path',
  'filePath',
  'storagePath',
  'storageKey',
  'objectKey',
  'storageHandle',
  'artifactId',
  'fileName',
  'filename',
  'expiresAt',
] as const;

/**
 * 查询串闭集门禁：出现任何查询参数即抛 `ZodError`，由 `ApiExceptionFilter` 统一映射为
 * 400 `VALIDATION_FAILED` + `details.issues`（`path` 指向违规参数本身，不回显取值）。
 *
 * 非对象查询（`undefined`／`null`，即无查询串）不在这里拒绝：那是「没有输入」的正常情况。
 * 重复参数在 Express 下会解析成数组，但键名仍然违规，因此同样被拒绝。
 */
export function assertDeclaredExportQueryFields(query: unknown): void {
  const unexpected = unexpectedFields(query, EXPORT_QUERY_FIELDS);
  if (!unexpected) return;

  const forbidden: readonly string[] = FORBIDDEN_EXPORT_QUERY_FIELDS;
  throwUnexpectedFields(unexpected, (key) =>
    forbidden.includes(key)
      ? `禁止使用查询参数 ${key}（归属、授权、状态与产物位置只来自服务端）`
      : `本端点不接受查询参数 ${key}`,
  );
}

/** 端点声明的请求体字段闭集（`POST /me/exports` 只接受这两个字段） */
export const EXPORT_REQUEST_INPUT_FIELDS = ['resource', 'fields'] as const;

/**
 * 服务端独占的请求体字段（**禁止客户端提交**）：归属、授权、状态、产物位置与产物句柄
 * 只能来自服务端会话、状态机与产物存储；`resource` / `fields` 之外的任何字段都不被接受。
 *
 * 位置类字段刻意列全：`fileUrl` / `downloadUrl` / `signedUrl`（下载签名）/
 * `storageKey` / `objectKey` / `storageHandle`（对象存储句柄）。它们**即使只被客户端声明**
 * 也必须以可区分的原因拒绝，而不是落进「未声明字段」——这两类拒绝在安全上等价，
 * 但前者能明确表达「这是服务端独占的能力引用」。
 */
export const FORBIDDEN_EXPORT_REQUEST_FIELDS = [
  'id',
  'exportId',
  'exportRequestId',
  'requestId',
  'userId',
  'userIds',
  'ownerUserId',
  'ownerId',
  'actorUserId',
  'actorId',
  'requestedBy',
  'targetUserId',
  'role',
  'roles',
  'scope',
  'dataScope',
  'groupId',
  'groupIds',
  'permissions',
  'permissionPoints',
  'assignedResourceIds',
  'status',
  'state',
  'fileUrl',
  'fileURL',
  'downloadUrl',
  'signedUrl',
  'url',
  'path',
  'filePath',
  'storagePath',
  'storageKey',
  'objectKey',
  'storageHandle',
  'artifactId',
  'fileName',
  'filename',
  'expiresAt',
  'createdAt',
  'updatedAt',
  'rowCount',
  'byteSize',
  'size',
  'content',
  'rows',
  'data',
  'masking',
  'redaction',
] as const;

/**
 * 请求体闭集门禁：出现未声明字段即抛 `ZodError` → 400，`path` 指向违规字段本身，
 * 拒绝原因区分「服务端字段」与「未声明字段」，且**不回显提交的取值**。
 *
 * 非对象请求体（缺体、`null`、数组、标量）不在这里拒绝：缺体由字段级 schema 判「缺 resource」，
 * 数组与标量由 schema 判非法类型；本函数只负责「多出了不该有的字段」这一类违规。
 */
export function assertDeclaredExportRequestFields(body: unknown): void {
  const unexpected = unexpectedFields(body, EXPORT_REQUEST_INPUT_FIELDS);
  if (!unexpected) return;

  const forbidden: readonly string[] = FORBIDDEN_EXPORT_REQUEST_FIELDS;
  throwUnexpectedFields(unexpected, (key) =>
    forbidden.includes(key) ? `禁止设置服务端字段 ${key}` : `请求体包含未声明字段 ${key}`,
  );
}

/** 只取「对象上存在但未被声明」的键名；非对象（缺体/数组/标量）返回 undefined */
function unexpectedFields(input: unknown, declared: readonly string[]): string[] | undefined {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return undefined;
  const unexpected = Object.keys(input).filter((key) => !declared.includes(key));
  return unexpected.length > 0 ? unexpected : undefined;
}

/** 逐键构造 `unrecognized_keys`（键名与拒绝原因可区分），保持 `path` 指向违规字段本身 */
function throwUnexpectedFields(
  keys: readonly string[],
  messageFor: (key: string) => string,
): never {
  throw new z.ZodError(
    keys.map((key) => ({
      code: 'unrecognized_keys' as const,
      keys: [key],
      path: [key] as (string | number)[],
      message: messageFor(key),
    })),
  );
}

import { createHash } from 'node:crypto';
import { z } from 'zod';
import { trimmedText, uuidSchema } from '@rm/shared';
import {
  EXPORT_DOWNLOAD_AUDIT_RESULT_VALUES,
  EXPORT_RESOURCE_VALUES,
  EXPORT_STATUS_VALUES,
  ExportResource,
  ExportStatus,
  isExportResource,
} from './exports.port';
import type { ExportDownloadAuditEntry } from './exports.port';

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
 * 不含归属 `ownerUserId`、不含产物句柄 `artifactId`、**也不含服务端有效期 `expiresAt`**
 * （到期时刻不外发：它只用于服务端判定，少一个对外事实就少一处可用来推断交付窗口的信息），
 * 更**不含任何文件路径、下载地址、存储 key 或文件名**——这些字段在存储记录与端口返回值里
 * 就不存在（见 `exports.port.ts`）。因此本切片不扩大对外响应面：视图字段一个都不新增。
 *
 * 读取契约（存储记录离开进程前的最后一道门）：字段闭集（`.strict()`）、枚举闭集、
 * 字段白名单子集与去重、状态与产物句柄自洽、**可选的服务端有效期（UTC ISO 或缺失）**、
 * ISO 时间戳。任一项违规都属于服务端缺陷：按 500 处理，**且日志与错误详情只写字段路径与
 * 违规类型、不写取值**，因此即便存储里被塞进了证件号或文件路径，也不会经由本切片的任何
 * 响应或日志外发。注意「有效期缺失」**不是**读取契约违规：缺失是 fail-closed 的合法存储
 * 形态（数据库 `NULL`），由下载边界统一拒绝，而不是把整条记录判成损坏（否则拒绝会从
 * 稳定的 404 变成 500，反而泄露「这条记录存在且缺字段」）。
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
    // 服务端有效期：**缺省即 fail-closed**（见 `isExportDownloadExpired`）。
    // `z.string().datetime()` 默认只接受以 `Z` 结尾的 UTC 形（小数秒可选），因此
    // 「本地时间 / 带时区偏移 / 非 ISO 形态」的取值在这里就被拒绝，
    // 不会以「某个本地时刻」的语义流入判定。
    expiresAt: z.string().datetime().optional(),
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

/**
 * 下载切片（`GET /me/exports/:exportId/download`）的**出口契约**。
 *
 * 这一块刻意只放「服务端常量 + 纯函数」：下载响应不是 JSON 信封，因此它没有视图白名单可复用，
 * 它的安全边界就是三类**固定值**：
 * 1. 固定的响应头取值（`Content-Type` / `Content-Disposition` / 缓存策略）；
 * 2. 固定的文件名字母表（只由服务端摘要派生，不含任何客户端取值）；
 * 3. 固定的内容硬上限。
 *
 * 为什么文件名与 Content-Type 都必须是常量派生，而不是取自记录或请求：
 * 响应头是**注入面**（CRLF 头注入、`filename=` 引号逃逸、路径穿越）；把它们限制成
 * 「服务端摘要 + 固定后缀」后，客户端与存储侧都没有任何取值能进入响应头。
 */

/**
 * 导出 ID 路径参数契约：必须是 UUID 形态。非 UUID 一律按**统一安全拒绝**处理
 * （与「不存在」同一个出口），因此非法形态既不会进入存储，也不会泄露存在性。
 */
export const exportDownloadIdSchema = uuidSchema;

/**
 * 产物**短期有效期**（服务端 TTL）：创建时刻起 24 小时。
 *
 * 为什么是「短期」且写在契约层：导出产物是「一次性取走」的交付物，交付窗口越长，
 * 落盘的脱敏文件被旁路读取/残留的时间就越长。把 TTL 固定成**服务端常量**（而不是配置项、
 * 更不是客户端可提交的参数）之后，「有效期有多长」这件事在部署之间没有漂移面，
 * 也不会出现「某个环境悄悄配成 10 年」这种把短期有效期变成永久交付的改动。
 *
 * 写入方只有一处：`ExportsService.createMyExportRequest` 用服务端时钟算出
 * `expiresAt = now + EXPORT_DOWNLOAD_TTL_MS`（见 `exportExpiresAtFrom`），
 * 客户端提交的同名字段一律 400（见 `FORBIDDEN_EXPORT_REQUEST_FIELDS` /
 * `FORBIDDEN_EXPORT_QUERY_FIELDS`），写回（`save`）路径也不得改写它。
 */
export const EXPORT_DOWNLOAD_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * 由服务端时钟（epoch 毫秒）派生有效期：**UTC 绝对时刻**的 ISO 8601 形态
 * （`YYYY-MM-DDTHH:mm:ss.sssZ`）。
 *
 * 刻意只接受 epoch 毫秒、且只产出 `Z` 结尾的形态：调用方无法在这里传入本地时间字符串、
 * 时区偏移或日期字面量，因此「有效期落在哪个瞬时点」不依赖运行机器的时区设置与夏令时规则。
 * TTL 恒为正（见上），所以 `expiresAt > createdAt` 这条存储层不变式天然成立。
 */
export function exportExpiresAtFrom(nowMs: number): string {
  return new Date(nowMs + EXPORT_DOWNLOAD_TTL_MS).toISOString();
}

/**
 * 过期判定（纯函数，服务端唯一判定点）：**有效当且仅当**存在一个严格的 UTC 时刻且当前时刻
 * 严格早于它。
 *
 * 返回 `true` 表示「不可下载」，四类取值都收敛到 `true`（**fail-closed**）：
 * - `undefined` / 非字符串 —— 存储里没有服务端有效期（数据库 `NULL` 的领域形）；
 * - 非法时间形态（非 ISO 8601、非 UTC `Z` 结尾、`NaN`）—— 存储被写坏；
 * - 恰好等于当前时刻 —— 边界判定为**已过期**（半开区间 `[expiresAt, +∞)` 都不可下载，
 *   因此不存在「到期后还能取走一次」的窗口）；
 * - 早于当前时刻 —— 正常过期。
 *
 * 比较发生在**绝对时刻**上（`Date.parse` 把 ISO `Z` 形态解析成 UTC 瞬时点），
 * 与本地时区、夏令时切换、机器时钟的时区设置都无关；两个被比较的量一个来自服务端存储，
 * 一个来自调用方传入的服务端时钟读数（`Date.now()`），调用方不得传入客户端可影响的取值。
 */
export function isExportDownloadExpired(expiresAt: unknown, nowMs: number): boolean {
  if (typeof expiresAt !== 'string') {
    return true;
  }
  if (!z.string().datetime().safeParse(expiresAt).success) {
    return true;
  }
  const expiresAtMs = Date.parse(expiresAt);
  if (!Number.isFinite(expiresAtMs)) {
    return true;
  }
  return !(nowMs < expiresAtMs);
}

/** 下载端点声明的查询参数闭集：**空集**（与 `/me/exports` 的读写口径一致） */
export const EXPORT_DOWNLOAD_QUERY_FIELDS = EXPORT_QUERY_FIELDS;

/**
 * 单次下载的内容硬上限（5 MiB）。超过上限**不截断、不分片、不流式降级**：
 * 一律 fail-closed 拒绝（否则「超出上限」会被当成「部分成功」，下游拿到的是一份不完整的交付物）。
 *
 * 取值由 port 一次返回全部内容这一契约保证可判定：调用方在写出任何字节之前就能比较长度。
 */
export const EXPORT_DOWNLOAD_MAX_BYTES = 5 * 1024 * 1024;

/**
 * 下载响应的**固定** Content-Type。
 *
 * 与内存基线的产物后缀（`.csv`）一致，且**不从存储返回的 MIME、扩展名或记录字段推导**：
 * 客户端与存储侧都无法让响应带上 `text/html` / `image/svg+xml` 这类可被浏览器解释的类型。
 */
export const EXPORT_DOWNLOAD_CONTENT_TYPE = 'text/csv; charset=utf-8';

/** Content-Disposition 的处置类型：一律 `attachment`（不允许内联渲染） */
export const EXPORT_DOWNLOAD_DISPOSITION_TYPE = 'attachment';

/** 文件名前缀与后缀：都由服务端常量给出 */
export const EXPORT_DOWNLOAD_FILENAME_PREFIX = 'rm-export-';
export const EXPORT_DOWNLOAD_FILENAME_EXTENSION = '.csv';

/**
 * 文件名字母表：首字符为字母数字，其后只允许字母数字与 `.` `_` `-`，总长 ≤ 64。
 * 该正则**不含** `/` `\` `"` CR LF 与控制字符，因此路径分隔符与头注入字符在形态上就不可能通过。
 */
export const EXPORT_DOWNLOAD_FILENAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}\.csv$/u;

/** 统一安全拒绝的对外文案：不存在、跨主体、未完成、产物缺失**共用**这一条，不区分原因 */
export const EXPORT_DOWNLOAD_UNAVAILABLE_MESSAGE = '导出文件不存在或不可下载';

/** 响应头取值中绝不允许出现的字符：CR / LF / NUL 与其余控制字符（含 DEL） */
// eslint-disable-next-line no-control-regex -- 这里是「显式拒绝控制字符」的判定本身
const UNSAFE_HEADER_CHARS = /[\u0000-\u001f\u007f]/u;

/** 文件名中额外不允许出现的字符：路径分隔符、双引号、控制字符 */
// eslint-disable-next-line no-control-regex -- 这里是「显式拒绝控制字符」的判定本身
const UNSAFE_FILENAME_CHARS = /[\\/"\u0000-\u001f\u007f]/u;

/** 头取值长度上限：正常取值（文件名 / MIME / 数字）远短于此，超长即视为异常并拒绝 */
const MAX_HEADER_VALUE_LENGTH = 255;

/**
 * 单次下载的实际响应头（顺序即写入顺序）：**恰好五个**，全部由服务端常量或内容长度派生。
 * `content-length` 由内容字节数给出，`x-content-type-options: nosniff` 阻止浏览器按内容嗅探类型
 * （下载端点自带断言的响应头，因此不依赖全局安全头中间件是否装配）。
 */
export const EXPORT_DOWNLOAD_RESPONSE_HEADER_NAMES = [
  'content-type',
  'content-disposition',
  'content-length',
  'cache-control',
  'x-content-type-options',
] as const;

/** 下载响应的缓存策略：交付物不得被缓存（`no-store`），避免共享缓存/磁盘缓存留副本 */
export const EXPORT_DOWNLOAD_CACHE_CONTROL = 'no-store';

/** 下载响应的类型嗅探防护 */
export const EXPORT_DOWNLOAD_NOSNIFF = 'nosniff';

/**
 * 头取值安全门禁：只接受**非空、≤255、纯可打印 ASCII**（因此不含 CR / LF / NUL / 控制字符与非
 * ASCII）的取值，违反即抛错。
 *
 * 错误消息**只写头名，不写取值**：头取值可能来自被污染的存储，不能让脱敏门禁自己变成泄漏点。
 */
export function assertSafeExportDownloadHeaderValue(name: string, value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > MAX_HEADER_VALUE_LENGTH ||
    UNSAFE_HEADER_CHARS.test(value) ||
    /[^\u0020-\u007e]/u.test(value)
  ) {
    throw new Error(`导出下载响应头取值不合法：${name}`);
  }
  return value;
}

/**
 * 文件名字母表门禁：必须匹配 `EXPORT_DOWNLOAD_FILENAME_PATTERN`，且**再显式拒绝**路径分隔符、
 * 引号、控制字符与 `..` 片段。
 *
 * 为什么正则通过后还要再拒一次：正则与「显式拒绝清单」是两道独立的门 —— 将来若有人放宽正则
 * （例如允许 Unicode 文件名），CRLF / 路径注入仍然会被下面这一层拦下，而不是悄悄放行。
 */
export function assertSafeExportDownloadFilename(fileName: unknown): string {
  if (typeof fileName !== 'string' || !EXPORT_DOWNLOAD_FILENAME_PATTERN.test(fileName)) {
    throw new Error('导出下载文件名不符合服务端字母表');
  }
  if (UNSAFE_FILENAME_CHARS.test(fileName) || fileName.includes('..')) {
    throw new Error('导出下载文件名含路径分隔符、引号、控制字符或上溯片段');
  }
  return fileName;
}

/**
 * 由导出 ID 派生下载文件名：`rm-export-<sha256 前 16 位十六进制>.csv`。
 *
 * 客户端取值（路由参数原样）不进入文件名，只有它的**单向摘要**进入；因此文件名既稳定可复现，
 * 又不含任何原始标识、路径分隔符或可注入字符。
 */
export function buildExportDownloadFilename(exportId: string): string {
  const digest = logSafeDigestHex(exportId, 16);
  return assertSafeExportDownloadFilename(
    `${EXPORT_DOWNLOAD_FILENAME_PREFIX}${digest}${EXPORT_DOWNLOAD_FILENAME_EXTENSION}`,
  );
}

/** 组装并校验 Content-Disposition（先校验文件名，再校验整条头取值） */
export function buildExportDownloadDisposition(fileName: unknown): string {
  const safeName = assertSafeExportDownloadFilename(fileName);
  return assertSafeExportDownloadHeaderValue(
    'content-disposition',
    `${EXPORT_DOWNLOAD_DISPOSITION_TYPE}; filename="${safeName}"`,
  );
}

/** 下载审计摘要前缀与形态：`sha256:<32 位小写十六进制>` */
export const EXPORT_DOWNLOAD_AUDIT_DIGEST_PREFIX = 'sha256:';
export const EXPORT_DOWNLOAD_AUDIT_DIGEST_PATTERN = /^sha256:[0-9a-f]{32}$/u;

/** sha256 的前 `length` 位十六进制（内部工具，长度由调用方固定为常量） */
function logSafeDigestHex(value: unknown, length: number): string {
  const text = typeof value === 'string' ? value : '';
  return createHash('sha256').update(text, 'utf8').digest('hex').slice(0, length);
}

/**
 * 导出 ID → 审计摘要：**单向**，且长度固定（只取 sha256 前 32 位十六进制）。
 *
 * 记摘要而不是原值：审计可用于「同一次导出被下载了几次」这类关联，但不落任何原始标识；
 * 非字符串输入（存储或调用链损坏）按空串摘要，绝不把异常对象序列化进审计。
 */
export function digestExportId(exportId: unknown): string {
  return `${EXPORT_DOWNLOAD_AUDIT_DIGEST_PREFIX}${logSafeDigestHex(exportId, 32)}`;
}

/** 下载审计条目的字段白名单（顺序即文档顺序）：**恰好三个** */
export const EXPORT_DOWNLOAD_AUDIT_FIELDS = ['requestId', 'exportIdDigest', 'result'] as const;

/**
 * 下载审计条目**禁止出现**的字段：产物内容 / 字节 / 响应体、产物句柄、存储位置（key / 路径 /
 * URL / 签名地址 / 文件名）、归属主体、角色与权限、请求侧输入（查询串 / 头 / IP / UA）、
 * 原始错误文本。
 *
 * 该清单与 `exportDownloadAuditEntrySchema` 的 `.strict()` 是同一件事的两种表达（前者可读、
 * 后者可机器判定），因此「审计顺手多记一个字段」会被严格契约拒绝，而不是被静默剥离。
 */
export const FORBIDDEN_EXPORT_DOWNLOAD_AUDIT_FIELDS = [
  'bytes',
  'content',
  'body',
  'payload',
  'artifact',
  'artifactId',
  'artifactKey',
  'storageKey',
  'objectKey',
  'storagePath',
  'path',
  'filePath',
  'fileName',
  'filename',
  'fileUrl',
  'downloadUrl',
  'signedUrl',
  'url',
  'ownerUserId',
  'ownerId',
  'userId',
  'actorUserId',
  'subject',
  'roles',
  'scope',
  'groupId',
  'permissions',
  'query',
  'headers',
  'authorization',
  'ip',
  'ipHash',
  'userAgent',
  'error',
  'errorMessage',
  'message',
  'stack',
] as const;

/**
 * 下载审计条目契约（**严格**）：恰好 `requestId` / `exportIdDigest` / `result` 三个字段，
 * 任何多余字段（即任何业务取值）都会让解析失败。
 */
export const exportDownloadAuditEntrySchema = z
  .object({
    requestId: uuidSchema,
    exportIdDigest: z
      .string()
      .regex(EXPORT_DOWNLOAD_AUDIT_DIGEST_PATTERN, '下载审计摘要必须是 sha256 前 32 位十六进制'),
    result: z.enum(EXPORT_DOWNLOAD_AUDIT_RESULT_VALUES),
  })
  .strict();

export type ExportDownloadAuditEntryParse =
  | { readonly ok: true; readonly value: ExportDownloadAuditEntry }
  | { readonly ok: false; readonly issues: readonly ExportContractIssue[] };

/** 校验一条下载审计条目；失败时只给字段路径与违规类型（不回显任何取值） */
export function parseExportDownloadAuditEntry(entry: unknown): ExportDownloadAuditEntryParse {
  const parsed = exportDownloadAuditEntrySchema.safeParse(entry);
  if (parsed.success) {
    return { ok: true, value: parsed.data };
  }
  return { ok: false, issues: toIssues(parsed.error) };
}

import { z } from 'zod';
import {
  DATA_RETENTION_STATUS_VALUES,
  EXPORT_AVAILABILITY_STATUS_VALUES,
  PRIVACY_CONSENT_STATUS_VALUES,
  PrivacyConsentStatus,
  DataRetentionStatus,
  ExportAvailabilityStatus,
} from './compliance.port';

/**
 * 合规切片的**读取契约**、**输出白名单**与**输入闭集**。
 *
 * 输出白名单（`COMPLIANCE_STATUS_VIEW_FIELDS`）：`GET /me/compliance-status` 的 `data`
 * **恰好**是三个状态枚举字段 `privacyConsent` / `dataRetention` / `exportAvailability`。
 * 白名单是 `.strict()` 的：出现第四个字段即判为契约漂移，由 service 按服务端缺陷 500 处理，
 * 绝不外发。**不含**归属 `ownerUserId`、不含同意原文与政策正文、不含手机号/学号/姓名、
 * 不含内部审核意见与审核人、不含证据文件标识、不含任何时间戳与期限取值——
 * 这些内容在本切片的存储记录里就不存在（见 `compliance.port.ts`），
 * 因此响应在结构上不可能携带它们，而不是「记得别带」。
 *
 * 读取契约（存储记录离开进程前的最后一道门）：字段闭集（`.strict()`）、枚举闭集、
 * 主体形态白名单、状态自洽。任一项违规都属于服务端缺陷：按 500 处理，
 * **且日志与错误详情只写字段路径与违规类型、不写取值**，
 * 因此即便存储里被塞进了同意原文或审核意见，也不会经由本切片的任何响应或日志外发。
 *
 * 输入闭集：本端点**不声明任何查询参数与请求体字段**（`COMPLIANCE_QUERY_FIELDS` /
 * `COMPLIANCE_STATUS_BODY_FIELDS` 都是空集）。服务端独占的名字（身份、角色、范围、
 * 小组归属、同意与留存状态、审核与证据字段）不是「被忽略的输入」，而是明确不被接受的输入：
 * 出现即 400 `VALIDATION_FAILED`，且**不回显提交的取值**。
 */

/** 主体形态：与会话存储的 ID 白名单同构（非空、无空白与控制字符、长度受控） */
export const complianceSubjectIdSchema = z
  .string()
  .regex(/^[A-Za-z0-9._:@-]{1,64}$/u, '合规状态归属形态不合法');

/** 存储记录读取契约违规、归属不一致等内部缺陷的统一对外文案（不区分内部原因，细节只进日志） */
export const COMPLIANCE_INTEGRITY_MESSAGE = '本人合规状态完整性校验失败';

/** 对外视图字段白名单（顺序即文档顺序） */
export const COMPLIANCE_STATUS_VIEW_FIELDS = [
  'privacyConsent',
  'dataRetention',
  'exportAvailability',
] as const;

export type ComplianceStatusViewField = (typeof COMPLIANCE_STATUS_VIEW_FIELDS)[number];

/** 对外视图的必需字段：本切片的视图字段全部必需（没有条件字段） */
export const COMPLIANCE_STATUS_VIEW_REQUIRED_FIELDS = [
  'privacyConsent',
  'dataRetention',
  'exportAvailability',
] as const;

/**
 * 对外视图：**只有三个状态枚举**。
 * 不含归属、原文、联系方式、审核/证据字段，也不含请求级输入回显。
 */
export interface ComplianceStatusView {
  readonly privacyConsent: PrivacyConsentStatus;
  readonly dataRetention: DataRetentionStatus;
  readonly exportAvailability: ExportAvailabilityStatus;
}

/** 存储记录读取契约：字段闭集 + 枚举闭集 + 主体形态 + 状态自洽（超集见下方 superRefine） */
const storedComplianceRecordObjectSchema = z
  .object({
    ownerUserId: complianceSubjectIdSchema,
    privacyConsent: z.enum(PRIVACY_CONSENT_STATUS_VALUES),
    dataRetention: z.enum(DATA_RETENTION_STATUS_VALUES),
    exportAvailability: z.enum(EXPORT_AVAILABILITY_STATUS_VALUES),
  })
  .strict();

/**
 * 状态自洽（**单向蕴含**，刻意不做双向等价）：
 * `exportAvailability = available` 是「本人导出通道已对本人开放」的强断言，
 * 必须由**已生效的同意**与**仍在保留期内**这两条事实支撑；
 * 反之 `unavailable` 恒合法——导出被停用还可能出于平台开关、调查冻结等本切片不建模的原因，
 * 因此不要求 `unavailable` 必须能由这两个字段反推。
 */
export const storedComplianceRecordSchema = storedComplianceRecordObjectSchema.superRefine(
  (value, ctx) => {
    if (value.exportAvailability !== ExportAvailabilityStatus.Available) return;

    if (value.privacyConsent !== PrivacyConsentStatus.Granted) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['exportAvailability'],
        message: '同意未生效时不得声明导出可用',
      });
    }
    if (value.dataRetention !== DataRetentionStatus.WithinRetention) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['exportAvailability'],
        message: '保留期已过时不得声明导出可用',
      });
    }
  },
);

export type StoredComplianceRecord = z.infer<typeof storedComplianceRecordObjectSchema>;

/** 出口门禁：对外视图必须是白名单闭集（多出字段、非法枚举、缺字段一律违规） */
export const complianceStatusViewSchema = z
  .object({
    privacyConsent: z.enum(PRIVACY_CONSENT_STATUS_VALUES),
    dataRetention: z.enum(DATA_RETENTION_STATUS_VALUES),
    exportAvailability: z.enum(EXPORT_AVAILABILITY_STATUS_VALUES),
  })
  .strict();

export interface ComplianceContractIssue {
  readonly kind: 'invalid' | 'unexpected';
  readonly path: string;
}

export type StoredComplianceRecordParse =
  | { readonly ok: true; readonly value: StoredComplianceRecord }
  | { readonly ok: false; readonly issues: readonly ComplianceContractIssue[] };

export type ComplianceStatusViewParse =
  | { readonly ok: true; readonly value: ComplianceStatusView }
  | { readonly ok: false; readonly issues: readonly ComplianceContractIssue[] };

/**
 * 把 zod 的 issue 归一为「字段路径 + 违规类型」，**不回传字段取值与消息**。
 * 多出字段（`unrecognized_keys`）的键名在 `issue.keys` 里而不在 `issue.path` 上，
 * 因此逐键展开为一条 issue，避免把「多了哪个字段」丢成 `(root)`。
 */
function toIssues(error: z.ZodError): ComplianceContractIssue[] {
  const issues: ComplianceContractIssue[] = [];
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
export function parseStoredComplianceRecord(record: unknown): StoredComplianceRecordParse {
  const parsed = storedComplianceRecordSchema.safeParse(record);
  if (parsed.success) {
    return { ok: true, value: parsed.data };
  }
  return { ok: false, issues: toIssues(parsed.error) };
}

/** 出口门禁：对外视图必须是三个状态枚举的闭集 */
export function parseComplianceStatusView(view: unknown): ComplianceStatusViewParse {
  const parsed = complianceStatusViewSchema.safeParse(view);
  if (parsed.success) {
    return { ok: true, value: parsed.data };
  }
  return { ok: false, issues: toIssues(parsed.error) };
}

/**
 * 校验后的存储记录 → 对外视图（逐字段显式赋值，不使用对象展开，避免未知字段外泄）。
 * 归属 `ownerUserId` 刻意不投影：它是服务端判定入参，不是对外内容。
 */
export function toComplianceStatusView(record: StoredComplianceRecord): ComplianceStatusView {
  return {
    privacyConsent: record.privacyConsent,
    dataRetention: record.dataRetention,
    exportAvailability: record.exportAvailability,
  };
}

/** 供测试与调用方复用：记录归属主体（不可读时返回空串，交由调用方按服务端缺陷处理） */
export function readComplianceOwnerId(record: { readonly ownerUserId?: unknown }): string {
  return typeof record.ownerUserId === 'string' ? record.ownerUserId : '';
}

/**
 * 端点声明的查询参数闭集：**空集**（`/me/compliance-status` 不接受任何查询参数）。
 * 状态筛选、分页、排序都不属于本切片；`?userId=` / `?roles=` / `?phone=` 这类查询
 * 不是「被忽略的输入」，而是明确不被接受的输入。
 */
export const COMPLIANCE_QUERY_FIELDS = [] as const;

/**
 * 服务端独占的查询串声明（**禁止客户端提交**）：身份、操作主体、角色、范围、小组归属、
 * 权限点，以及合规事实本身（同意状态/原文、保留状态、导出可用性、审核与证据字段）。
 * 它们只能来自服务端会话、服务端常量与存储读取契约。
 */
export const FORBIDDEN_COMPLIANCE_QUERY_FIELDS = [
  'id',
  'userId',
  'userIds',
  'ownerUserId',
  'ownerId',
  'actorUserId',
  'actorId',
  'targetUserId',
  'sessionId',
  'sessionToken',
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
  'privacyConsent',
  'consent',
  'consentStatus',
  'consentText',
  'consentBody',
  'policyText',
  'policyVersion',
  'consentedAt',
  'withdrawnAt',
  'dataRetention',
  'retention',
  'retentionStatus',
  'retentionUntil',
  'expiresAt',
  'exportAvailability',
  'export',
  'exportEnabled',
  'reviewStatus',
  'reviewNote',
  'reviewComment',
  'reviewerId',
  'reviewedAt',
  'evidenceFileId',
  'evidence',
  'evidenceId',
  'name',
  'studentNo',
  'phone',
  'mobile',
  'idCard',
  'wechatOpenId',
] as const;

/**
 * 端点声明的请求体字段闭集：**空集**（`GET /me/compliance-status` 不接受任何请求体字段）。
 * 读取接口不需要请求体；提交 `userId`/`roles`/`consentText` 之类一律 400，而不是静默忽略。
 */
export const COMPLIANCE_STATUS_BODY_FIELDS = [] as const;

/**
 * 服务端独占的请求体字段（**禁止客户端提交**）：与查询串同一口径，只是入口不同。
 * 加上时间戳：本端点的响应里没有时间戳，客户端提交它属于越权写入服务端事实的尝试。
 * 刻意**不**把 `note`/`reason`/`comment` 这类自由文本列为服务端字段：
 * 它们不是合规事实，落进「未声明字段」这一类（读取接口不接受任何请求体字段）。
 */
export const FORBIDDEN_COMPLIANCE_BODY_FIELDS = [
  ...FORBIDDEN_COMPLIANCE_QUERY_FIELDS,
  'createdAt',
  'updatedAt',
] as const;

/**
 * 查询串闭集门禁：出现任何查询参数即抛 `ZodError`，由 `ApiExceptionFilter` 统一映射为
 * 400 `VALIDATION_FAILED` + `details.issues`（`path` 指向违规参数本身，不回显取值）。
 *
 * 非对象查询（`undefined`／`null`，即无查询串）不在这里拒绝：那是「没有输入」的正常情况。
 * 重复参数在 Express 下会解析成数组，但键名仍然违规，因此同样被拒绝。
 */
export function assertDeclaredComplianceQueryFields(query: unknown): void {
  assertNoDeclaredInput(query, COMPLIANCE_QUERY_FIELDS, FORBIDDEN_COMPLIANCE_QUERY_FIELDS, 'query');
}

/**
 * 请求体闭集门禁：出现任何请求体字段即抛 `ZodError` → 400，`path` 指向违规字段本身。
 * 服务端字段与未声明字段的拒绝原因可区分，且**不回显提交的取值**。
 *
 * 非对象请求体（缺体、`null`、数组、标量）不在这里拒绝：那是「没有请求体」或
 * 「请求体形态非法」的正常情况——GET 读取接口不需要请求体，空对象与缺体都不含字段。
 */
export function assertDeclaredComplianceBodyFields(body: unknown): void {
  assertNoDeclaredInput(
    body,
    COMPLIANCE_STATUS_BODY_FIELDS,
    FORBIDDEN_COMPLIANCE_BODY_FIELDS,
    'body',
  );
}

/** 只取「对象上存在但未被声明」的键名；非对象（缺体/数组/标量）视为没有输入 */
function assertNoDeclaredInput(
  input: unknown,
  declared: readonly string[],
  forbidden: readonly string[],
  channel: 'query' | 'body',
): void {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return;

  const unexpected = Object.keys(input).filter((key) => !declared.includes(key));
  if (unexpected.length === 0) return;

  const isQuery = channel === 'query';
  throw new z.ZodError(
    unexpected.map((key) => ({
      code: 'unrecognized_keys' as const,
      keys: [key],
      path: [key] as (string | number)[],
      message: forbidden.includes(key)
        ? isQuery
          ? `禁止使用查询参数 ${key}（身份、授权与合规事实只来自服务端）`
          : `禁止设置服务端字段 ${key}（身份、授权与合规事实只来自服务端）`
        : isQuery
          ? `本端点不接受查询参数 ${key}`
          : `请求体包含未声明字段 ${key}`,
    })),
  );
}

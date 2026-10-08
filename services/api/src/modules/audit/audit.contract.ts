import { createHash } from 'node:crypto';
import { z } from 'zod';
import { riskFreeText, uuidSchema } from '@rm/shared';
import {
  AUDIT_EVENT_TYPE_VALUES,
  AUDIT_RESOURCE_TYPE_VALUES,
  AUDIT_RESULT_VALUES,
} from './audit.port';

/**
 * 审计切片的**输入闭集**、**请求上下文取值口径**、**读取契约**与**输出白名单**。
 *
 * 输入闭集（`GET /me/audit-events` 不接受任何客户端声明）：
 * - 端点**不声明任何查询参数**：`?userId=`/`?actorUserId=`/`?roles=`/`?scope=`/`?ip=`/
 *   `?requestId=`/`?result=` 等一律 400，而不是「恰好没读它」——客户端提交的归属、权限、
 *   网络与结果声明不是被忽略的输入，而是明确不被接受的输入；
 * - 端点**不接受任何请求体字段**（GET 也不读请求体）：客户端伪造的 `actorUserId`/`result`/
 *   `ipHash`/`requestId`/`selfVisible` 出现即 400（给出与「未声明字段」可区分的拒绝原因）。
 *
 * 请求上下文取值口径（`AuditRequestContext`）：
 * - 只取**传输层事实**：对端地址来自 `request.socket.remoteAddress`；
 * - **不读任何客户端头**：`x-forwarded-for`、`x-real-ip`、`x-ip` 等既不被采信也不被转发，
 *   因此客户端无法通过伪造头改变审计里的网络归属（Express 的 `req.ip` 在启用 trust proxy 时
 *   同样会采信这些头，所以本切片刻意不用 `req.ip`）；
 * - 明文地址不入库：`hashPeerAddress` 输出 sha256（64 位十六进制），与数据字典 §4
 *   「IP 只存哈希/脱敏」一致。
 *
 * 读取契约（存储记录离开进程前的最后一道门）：字段类型、三个枚举闭集（事件类型 / 结果 / 资源类型）、
 * ISO 时间戳、UUID 形态的主键与关联 ID、`ipHash` 必须是 sha256 十六进制（明文 IP 视为存储损坏），
 * 外加**免 PII 摘要**（身份证号、长数字标识、疑似密钥一律命中）。任一项违规都属于服务端缺陷：
 * 按 500 处理，**且日志只写字段路径与违规类型、不写取值**，因此即使摘要被写入了身份证号或密钥，
 * 也不会经由本切片的任何响应或日志外发。存储记录的字段集合同样是**闭集**（`.strict()`）：
 * 多出字段说明存储与审计契约已经漂移，宁可 fail-closed 也不静默容忍。
 *
 * 输出白名单：对外视图**恰好**是 `AUDIT_EVENT_VIEW_FIELDS` 这些字段，且出口再过一遍 `.strict()`
 * 闭集——多出字段即 500，绝不外发。视图**不含** `actorUserId`（归属）、`requestId`（服务端关联 ID）、
 * `ipHash`（网络归属的哈希）、`selfVisible`（服务端可见性口径）与 `resourceId`，也不含
 * 改前/改后快照与理由字段：客户端因此没有任何可回传的审计字段可用于伪造。
 */

/** 对外视图字段白名单（顺序用于文档与回归断言） */
export const AUDIT_EVENT_VIEW_FIELDS = [
  'id',
  'type',
  'result',
  'resourceType',
  'summary',
  'occurredAt',
] as const;

/** 对外视图的必需字段：本切片的事件摘要字段全部必需（没有条件字段） */
export const AUDIT_EVENT_VIEW_REQUIRED_FIELDS = [
  'id',
  'type',
  'result',
  'resourceType',
  'summary',
  'occurredAt',
] as const;

/** 读取契约违规的统一对外文案（与其它切片一致：不区分内部原因，细节只进日志） */
export const AUDIT_INTEGRITY_MESSAGE = '审计事件完整性校验失败';

/** sha256 十六进制：审计只存对端地址的哈希，明文 IP 形态（含 IPv4/IPv6/端口）一律不合法 */
export const ipHashSchema = z.string().regex(/^[a-f0-9]{64}$/u, 'ipHash 必须是 sha256 十六进制');

/**
 * 审计主体形态：与会话存储的 ID 白名单同构（非空、无空白与控制字符、长度受控）。
 * 审计记录里出现自由文本式的主体（例如姓名、手机号）本身就是存储损坏，按 500 处理。
 */
export const actorIdSchema = z.string().regex(/^[A-Za-z0-9._:@-]{1,64}$/u, '审计主体形态不合法');

/**
 * 服务端在「本人读取审计摘要」时写入的摘要文案。
 * 它是**服务端常量**（不接受客户端提交），且按 `riskFreeText` 校验不含高敏内容，
 * 因此读取事件本身不会把任何用户输入带进审计。
 */
export const SELF_AUDIT_READ_SUMMARY = '读取本人审计事件摘要';

/** 存储记录读取契约：字段闭集 + 三个枚举闭集 + 时间/标识形态 + 免 PII 摘要 */
export const storedAuditEventSchema = z
  .object({
    id: uuidSchema,
    actorUserId: actorIdSchema,
    type: z.enum(AUDIT_EVENT_TYPE_VALUES),
    result: z.enum(AUDIT_RESULT_VALUES),
    resourceType: z.enum(AUDIT_RESOURCE_TYPE_VALUES),
    resourceId: uuidSchema.optional(),
    summary: riskFreeText(1, 200, '审计摘要'),
    selfVisible: z.boolean(),
    requestId: uuidSchema,
    ipHash: ipHashSchema,
    occurredAt: z.string().datetime(),
  })
  .strict();

export type StoredAuditEvent = z.infer<typeof storedAuditEventSchema>;

/** 对外视图读取契约：白名单闭集（`.strict()` 使「多出字段」成为可检测的违规） */
export const auditEventViewSchema = z
  .object({
    id: uuidSchema,
    type: z.enum(AUDIT_EVENT_TYPE_VALUES),
    result: z.enum(AUDIT_RESULT_VALUES),
    resourceType: z.enum(AUDIT_RESOURCE_TYPE_VALUES),
    summary: riskFreeText(1, 200, '审计摘要'),
    occurredAt: z.string().datetime(),
  })
  .strict();

/**
 * 对外事件摘要：只有「事件 ID + 类型 + 结果 + 资源类型 + 免 PII 摘要 + 时间」，
 * 不含归属、网络归属、关联 ID、可见性口径与资源标识。
 */
export interface AuditEventView {
  id: string;
  type: StoredAuditEvent['type'];
  result: StoredAuditEvent['result'];
  resourceType: StoredAuditEvent['resourceType'];
  summary: string;
  occurredAt: string;
}

export interface AuditContractIssue {
  readonly kind: 'invalid' | 'unexpected';
  readonly path: string;
}

export type StoredAuditEventParse =
  | { readonly ok: true; readonly value: StoredAuditEvent }
  | { readonly ok: false; readonly issues: readonly AuditContractIssue[] };

export type AuditEventViewParse =
  | { readonly ok: true; readonly value: AuditEventView }
  | { readonly ok: false; readonly issues: readonly AuditContractIssue[] };

/**
 * 把 zod 的 issue 归一为「字段路径 + 违规类型」，**不回传字段取值**。
 * 多出字段（`unrecognized_keys`）的键名在 `issue.keys` 里而不在 `issue.path` 上，
 * 因此逐键展开为一条 issue，避免把「多了哪个字段」丢成 `(root)`。
 */
function toIssues(error: z.ZodError): AuditContractIssue[] {
  const issues: AuditContractIssue[] = [];
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
export function parseStoredAuditEvent(record: unknown): StoredAuditEventParse {
  const parsed = storedAuditEventSchema.safeParse(record);
  if (parsed.success) {
    return { ok: true, value: parsed.data };
  }
  return { ok: false, issues: toIssues(parsed.error) };
}

/** 出口门禁：对外视图必须是白名单闭集（多出字段、非法字段值一律违规） */
export function parseAuditEventView(view: unknown): AuditEventViewParse {
  const parsed = auditEventViewSchema.safeParse(view);
  if (parsed.success) {
    return { ok: true, value: parsed.data };
  }
  return { ok: false, issues: toIssues(parsed.error) };
}

/** 校验后的存储记录 → 对外摘要（逐字段显式赋值，不使用对象展开，避免未知字段外泄） */
export function toAuditEventView(record: StoredAuditEvent): AuditEventView {
  return {
    id: record.id,
    type: record.type,
    result: record.result,
    resourceType: record.resourceType,
    summary: record.summary,
    occurredAt: record.occurredAt,
  };
}

/**
 * 请求级服务端上下文：**只含传输层事实**，不含任何客户端可提交的字段。
 * 审计写入所需的主体、结果、时间、关联 ID、网络归属一律由 service 从会话主体、
 * 服务端时钟与本上下文推导，不存在「从请求里读 result/actor」的路径。
 */
export interface AuditRequestContext {
  /** 传输层对端地址（`request.socket.remoteAddress`）；缺失时按服务端哨兵值哈希 */
  readonly peerAddress?: string;
}

/** 对端地址不可用时的**服务端**哨兵值：绝不用客户端提交的值占位 */
export const UNKNOWN_PEER_ADDRESS = 'peer-address-unavailable';

/**
 * 从 HTTP 请求对象中提取唯一允许读取的传输层事实。
 *
 * 显式白名单取值：只读 `socket.remoteAddress`。任何请求头（`x-forwarded-for`、`x-real-ip`、
 * `x-ip`…）都不在这里被读取，因此伪造头无法改变审计中的网络归属；
 * 传入完整请求对象的风险被限制在本函数的读路径内（service 只接收提取结果）。
 */
export function toAuditRequestContext(request: unknown): AuditRequestContext {
  if (typeof request !== 'object' || request === null) return {};
  const socket = (request as { socket?: unknown }).socket;
  if (typeof socket !== 'object' || socket === null) return {};
  const address = (socket as { remoteAddress?: unknown }).remoteAddress;
  if (typeof address !== 'string' || address === '') return {};
  return { peerAddress: address };
}

/**
 * 对端地址 → sha256 十六进制（数据字典 §4「IP 只存哈希/脱敏」）。
 * 明文地址既不入库也不外发；地址不可用时哈希服务端哨兵值，而不是接受客户端提供的值。
 */
export function hashPeerAddress(peerAddress?: string): string {
  const source =
    typeof peerAddress === 'string' && peerAddress !== '' ? peerAddress : UNKNOWN_PEER_ADDRESS;
  return createHash('sha256').update(source, 'utf8').digest('hex');
}

/** 端点声明的查询参数闭集：**空集**（`/me/audit-events` 不接受任何查询参数） */
export const AUDIT_QUERY_FIELDS = [] as const;

/**
 * 服务端独占的查询串声明（**禁止客户端提交**）：这些名字是授权/归属/网络/结果口径
 * （身份、操作主体、角色、范围、小组归属、权限点、对端地址、请求关联 ID、结果、可见性），
 * 只能来自服务端会话、传输层与常量。
 */
export const FORBIDDEN_AUDIT_QUERY_FIELDS = [
  'userId',
  'userIds',
  'actorUserId',
  'actorId',
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
  'ip',
  'ipHash',
  'remoteAddress',
  'requestId',
  'result',
  'selfVisible',
] as const;

/**
 * 查询串闭集门禁：出现任何查询参数即抛 `ZodError`，由 `ApiExceptionFilter` 统一映射为
 * 400 `VALIDATION_FAILED` + `details.issues`（`path` 指向违规参数本身）。
 *
 * 非对象查询（`undefined`／`null`，即无查询串）不在这里拒绝：那是「没有输入」的正常情况。
 * 重复参数（如 `?userId=a&userId=b`）在 Express 下会解析成数组，但键名仍然违规，因此同样被拒绝。
 */
export function assertDeclaredAuditQueryFields(query: unknown): void {
  const unexpected = unexpectedFields(query, AUDIT_QUERY_FIELDS);
  if (!unexpected) return;

  const forbidden: readonly string[] = FORBIDDEN_AUDIT_QUERY_FIELDS;
  throwUnexpectedFields(unexpected, (key) =>
    forbidden.includes(key)
      ? `禁止使用查询参数 ${key}（授权、归属与网络口径只来自服务端）`
      : `本端点不接受查询参数 ${key}`,
  );
}

/** 端点声明的请求体字段闭集：**空集**（本端点不从请求体读取任何输入） */
export const AUDIT_READ_BODY_FIELDS = [] as const;

/**
 * 服务端独占的请求体字段（**禁止客户端提交**）：审计记录的每一个字段都由服务端生成或推导，
 * 即使是 `summary`、`occurredAt` 这类看似业务字段的名字也不接受客户端声明。
 * 该清单与查询串清单分开维护，使拒绝原因可区分（「服务端字段」vs「未声明字段」）。
 */
export const FORBIDDEN_AUDIT_BODY_FIELDS = [
  'id',
  'actorUserId',
  'actorId',
  'userId',
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
  'type',
  'result',
  'resourceType',
  'resourceId',
  'summary',
  'occurredAt',
  'selfVisible',
  'requestId',
  'ip',
  'ipHash',
  'remoteAddress',
] as const;

/**
 * 请求体闭集门禁：本端点**不接受任何请求体字段**，出现即抛 `ZodError` → 400。
 *
 * 非对象请求体（缺体、`null`、数组、标量）不在这里拒绝：缺体是「没有输入」的正常情况，
 * 数组与标量没有字段可声明；本函数只负责「多出了不该有的字段」这一类违规。
 */
export function assertNoAuditReadBodyFields(body: unknown): void {
  const unexpected = unexpectedFields(body, AUDIT_READ_BODY_FIELDS);
  if (!unexpected) return;

  const forbidden: readonly string[] = FORBIDDEN_AUDIT_BODY_FIELDS;
  throwUnexpectedFields(unexpected, (key) =>
    forbidden.includes(key) ? `禁止设置服务端字段 ${key}` : `本端点不接受请求体字段 ${key}`,
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

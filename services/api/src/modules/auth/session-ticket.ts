import { createHash, randomBytes } from 'node:crypto';
import { isIsoTimestamp } from '../../db/ports/sql-executor-verification';

/**
 * 会话票据的形状与**不可逆摘要**（纯函数，无状态、不建连接、不读环境变量）。
 *
 * ## 为什么把票据处理单独成文件
 * 「敏感 token 只存不可逆 hash」是一条同时约束**写路径**（创建会话）与**读路径**（解析会话）的
 * 规则：两条路径必须用同一个摘要函数，否则「写得进去、读不出来」会在真实环境里表现为
 * 「所有人突然未登录」。把口径收敛到本文件后，持久化 adapter、内存基线与测试引用的是同一实现。
 *
 * ## 边界事实
 * - 只依赖 `node:crypto`，不 import 任何数据库驱动、不读环境变量、不写日志；
 * - 摘要为 `sha256`（**64 位小写十六进制**）：单向、定长、可直接作为主键与查询键；
 * - 票据为 32 字节 `randomBytes` 的 **base64url** 形（43 字符）：落在
 *   `session-subject.baseline.ts` 的 Bearer 字符集白名单（`[A-Za-z0-9._:-]{8,128}`）内；
 * - **两种形态刻意不重叠**：票据是 43 字符 base64url，摘要是 64 字符十六进制。因此
 *   `sessions.session_id` 的形状约束（`^[0-9a-f]{64}$`）在**结构上**拒绝把原始票据落库 ——
 *   即使写入方写错了（忘了哈希、直接把入参绑进 SQL），数据库也会以约束冲突拒绝，而不是
 *   静默保存一份可用凭证。这条性质由「形状不同」保证，而不是靠「记得调用哈希函数」；
 * - 本文件**不返回也不记录**任何摘要的输入：`sessionTicketDigest` 只做一次哈希运算。
 *
 * ## 为什么不是「可验证签名」或「明文 ID + 服务端映射」
 * - 明文 ID 落库意味着拿到表内容即可直接冒用凭证，违反「只存摘要」；
 * - 签名式票据要求密钥轮换与密钥管理，属于后续切片（微信登录）的选型范围，本切片不预判。
 */

/** 票据字节数：32 字节随机（256 位），不存在可枚举空间 */
export const SESSION_TICKET_BYTES = 32;

/** 票据文本形状：32 字节 base64url（43 字符，无填充）—— **上线形** */
export const SESSION_TICKET_PATTERN = /^[A-Za-z0-9_-]{43}$/u;

/** 存储主键形状：sha256 的 64 位小写十六进制 —— **落库形**，与票据形状不重叠 */
export const SESSION_ID_PATTERN = /^[0-9a-f]{64}$/u;

/**
 * 主体 ID 形状白名单：与 `session-subject.baseline.ts` 的 `SAFE_ID` 同口径。
 *
 * 为什么在 adapter 侧再判一次：数据库是外部可变状态，行内容可能被任意来源写坏。行契约必须能在
 * 把 `user_id` / `groupIds` 交给授权判定之前拒绝掉形状非法的值（控制字符、超长、空串）。
 */
export const SESSION_SAFE_ID_PATTERN = /^[A-Za-z0-9._:@-]{1,64}$/u;

/** 生成一张新的会话票据（原始值只返回给调用方，调用方负责转交且不得记录） */
export function generateSessionTicket(): string {
  return randomBytes(SESSION_TICKET_BYTES).toString('base64url');
}

/**
 * 票据 → 不可逆摘要（写路径与读路径共用的**唯一**口径）。
 *
 * 输入是客户端提交的原始票据，输出是可以安全落库/比较的摘要。
 * 本函数不抛错、不做形状校验：形状校验由调用方在**下发 SQL 之前**完成
 * （见 `session-store.postgres-repository.ts`），避免把任意字符串送进查询路径。
 */
export function sessionTicketDigest(ticket: string): string {
  return createHash('sha256').update(ticket, 'utf8').digest('hex');
}

/** 票据/摘要形状判定（不做任何哈希运算）：只认**上线形**票据 */
export function isSessionTicket(value: unknown): value is string {
  return typeof value === 'string' && SESSION_TICKET_PATTERN.test(value);
}

/** 摘要形状判定：只认**落库形**摘要 */
export function isSessionDigest(value: unknown): value is string {
  return typeof value === 'string' && SESSION_ID_PATTERN.test(value);
}

/** 主体 ID 形状判定（userId / groupIds / assignedResourceIds 共用） */
export function isSessionSafeId(value: unknown): value is string {
  return typeof value === 'string' && SESSION_SAFE_ID_PATTERN.test(value);
}

/**
 * 会话有效期上界（天）。
 *
 * 为什么要有上界：没有上界时，一次写入错误（例如把毫秒当秒、或写入一个极大值）会造出一张
 * **永不过期**的会话，而它在读取路径上完全合法、无法被察觉。上界让这种写入在创建时即失败。
 */
export const SESSION_TTL_MAX_DAYS = 30;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * 过期时刻判定：必须是带时区的 ISO 时间戳，且落在 `(now, now + 上界]` 内。
 *
 * @param nowMs 判定时刻（毫秒）；由调用方显式注入，保证可复现
 */
export function isSessionExpiryWithinBounds(
  value: unknown,
  nowMs: number,
  maxDays: number = SESSION_TTL_MAX_DAYS,
): value is string {
  if (!isIsoTimestamp(value)) {
    return false;
  }
  const parsed = Date.parse(value);
  return parsed > nowMs && parsed <= nowMs + maxDays * MS_PER_DAY;
}

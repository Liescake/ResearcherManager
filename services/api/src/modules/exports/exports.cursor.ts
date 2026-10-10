import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { uuidSchema } from '@rm/shared';
import type { ExportKeyset } from './exports.port';

/**
 * `GET /me/exports` 的**不透明分页游标**（键集游标的编解码与校验）。
 *
 * ## 游标里有什么、没有什么
 *
 * 载荷**只有一个版本号与两个排序键分量**：`{v, c(createdAt), i(id)}`。
 * 刻意**没有**：归属主体（`ownerUserId` / `userId`）、角色 / 范围 / 小组、权限点、
 * 产物句柄（`artifactId`）、文件名 / 路径 / 下载地址 / 签名地址 / 存储 key / 对象 key、
 * 资源快照、筛选条件、服务端有效期、任何 PII 字段。因此「游标里被顺手塞进一个内部标识或
 * 一条路径」不是本实现的一个疏漏点，而是**结构上不可表达**：载荷契约是 `.strict()` 的闭集，
 * 多一个键就解析失败。
 *
 * 载荷里的两个分量也不是「额外泄露」：它们就是该主体自己的记录在公开视图里已经收到的
 * `createdAt` 与 `id`（`EXPORT_REQUEST_VIEW_FIELDS` 的前两项），因此游标不携带任何
 * 客户端尚未持有的信息。整串仍然经过 base64url 与签名，形态上对客户端不可读、不可改。
 *
 * ## 为什么必须签名、且签名必须绑定服务端主体
 *
 * 游标是**客户端持有的状态**，因此它天然是可篡改的输入。本实现用 HMAC-SHA256 把它变成
 * 「服务端才能签发」的凭据，并且**签名密钥由服务端主体派生**：
 *
 * ```
 * ownerKey = HMAC-SHA256(rootSecret, "rm-export-cursor:owner:" + ownerUserId)
 * mac      = HMAC-SHA256(ownerKey, "e1." + payloadSegment)
 * ```
 *
 * 于是三类攻击在同一条判定上收敛为「游标无效」：
 * - **篡改**（改边界、改排序键、伪造版本号）⇒ `mac` 不匹配；
 * - **跨主体重放**（拿 A 的游标在 B 的会话里继续分页）⇒ B 的 `ownerKey` 不同 ⇒ `mac` 不匹配；
 * - **超长 / 非形态输入** ⇒ 在**解码之前**就被长度与字母表门禁拒绝（不做任何昂贵的哈希）。
 *
 * 三者对外的拒绝**完全同形**（同一个 400 `VALIDATION_FAILED`、同一条文案、不区分原因、
 * 不回显取值），因此拒绝本身不构成「这个游标是谁的 / 改坏了哪个字节」的探测口。
 *
 * ## 为什么不需要「游标撤销表」
 *
 * 游标是无状态派生值：它不含服务端会话标识、不含一次性令牌、也不产生任何服务端写入。
 * 越权的重放（他人主体）在密码学上直接不成立，因此不需要一张「已签发游标」的表来撤销
 * （本切片也明确不做 revoke / 不新增迁移）。
 *
 * ## 服务端密钥从哪来
 *
 * `resolveExportCursorSecret` 优先用配置的 `SESSION_SECRET`（经一次域分离的 SHA-256 派生，
 * 不把原值当密钥使用、也不外发）。**未配置时**退化为**进程内随机密钥**（每次启动重新生成）：
 * 这不是把签名降级成「可猜测的常量」，而是把游标的可用范围限制在签发它的那个进程内 ——
 * 重启或换副本后旧游标一律判为无效（fail-closed 到「重新从首页开始」），
 * 绝不会出现「用固定默认密钥签出的游标可以被任意进程伪造」这种真正的降级。
 */

/** 游标版本段：出现在整串最前面，便于将来换算法时区分（旧版本一律判为无效） */
export const EXPORT_CURSOR_VERSION = 1;

/** 整串前缀（含分隔点）：`e1.<载荷段>.<签名段>` */
export const EXPORT_CURSOR_PREFIX = 'e1.';

/** 游标**输入**的硬长度上限（超出即 400，且在任何解码 / 哈希之前判定） */
export const EXPORT_CURSOR_MAX_LENGTH = 512;

/** 载荷段的字母表与长度上限：base64url 且不超过 256 个字符（解码后 ≤ 192 字节） */
const EXPORT_CURSOR_PAYLOAD_SEGMENT_PATTERN = '[A-Za-z0-9_-]{1,256}';

/** 签名字段的字母表与长度：HMAC-SHA256 的 base64url 无填充形恰好 43 个字符 */
const EXPORT_CURSOR_SIGNATURE_SEGMENT_PATTERN = '[A-Za-z0-9_-]{43}';

/**
 * 游标整串形态：**三段 + 两个点**，字母表是 base64url（不含 `+` `/` `=`、不含空白与控制字符）。
 * 先过这一层再解码，因此「超长输入 / 非 base64 / 夹带注入载荷」都不会进入密码学路径。
 */
export const EXPORT_CURSOR_PATTERN = new RegExp(
  `^${EXPORT_CURSOR_PREFIX}${EXPORT_CURSOR_PAYLOAD_SEGMENT_PATTERN}\\.${EXPORT_CURSOR_SIGNATURE_SEGMENT_PATTERN}$`,
  'u',
);

/** 游标拒绝的**统一**文案：篡改 / 跨主体 / 形态非法 / 版本不符共用同一条，不区分原因 */
export const EXPORT_CURSOR_INVALID_MESSAGE = '导出分页游标无效';

/** 游标载荷契约（**严格闭集**）：只有版本号与两个排序键分量 */
const exportCursorPayloadSchema = z
  .object({
    v: z.literal(EXPORT_CURSOR_VERSION),
    c: z.string().datetime(),
    i: uuidSchema,
  })
  .strict();

/** 游标编解码端口（由 DI 令牌 `EXPORT_CURSOR_CODEC` 提供，测试可注入固定密钥的实现） */
export interface ExportCursorCodec {
  /** 由一页的**最后一行**签发下一页游标（键集非法属服务端缺陷，抛非 Zod 错误 ⇒ 500） */
  encode(keyset: ExportKeyset, ownerUserId: string): string;
  /** 校验并解出键集边界；任何失败都抛 `ZodError`（⇒ 400），且消息不回显游标取值 */
  decode(cursor: string, ownerUserId: string): ExportKeyset;
}

/** DI 令牌：分页游标编解码器 */
export const EXPORT_CURSOR_CODEC = Symbol('EXPORT_CURSOR_CODEC');

/** 统一的 400 出口：只给字段路径与稳定文案，绝不含游标取值 */
function invalidCursor(): never {
  throw new z.ZodError([
    {
      code: z.ZodIssueCode.custom,
      path: ['cursor'],
      message: EXPORT_CURSOR_INVALID_MESSAGE,
    },
  ]);
}

/**
 * 主体必须是「非空且长度受限」的字符串：空主体会让所有调用者共享同一把派生密钥，
 * 长度不受限则把服务端主体当成无界输入。两者都是服务端缺陷（抛非 Zod 错误 ⇒ 500），
 * 而不是客户端输入问题。
 */
function requireKeyingSubject(ownerUserId: unknown): string {
  if (typeof ownerUserId !== 'string' || ownerUserId.length === 0 || ownerUserId.length > 128) {
    throw new Error('导出分页游标要求非空且长度受限的服务端主体（服务端缺陷）');
  }
  return ownerUserId;
}

/** 域分离后的主体密钥：不同主体的游标在同一条 HMAC 判定下不可能互相验证通过 */
function ownerBoundKey(rootSecret: Buffer, ownerUserId: string): Buffer {
  return createHmac('sha256', rootSecret)
    .update(`rm-export-cursor:owner:${ownerUserId}`, 'utf8')
    .digest();
}

/**
 * 构造游标编解码器。密钥必须至少 16 字节（越短的密钥越接近「可穷举」，
 * 因此这里是构造期 fail-closed，而不是运行期告警）。
 */
export function createExportCursorCodec(secret: Buffer): ExportCursorCodec {
  if (!Buffer.isBuffer(secret) || secret.length < 16) {
    throw new Error('导出分页游标密钥不可用（必须是长度不少于 16 字节的密钥材料）');
  }
  const rootSecret = Buffer.from(secret);

  return {
    encode(keyset: ExportKeyset, ownerUserId: string): string {
      const subject = requireKeyingSubject(ownerUserId);
      const parsed = exportCursorPayloadSchema.safeParse({
        v: EXPORT_CURSOR_VERSION,
        c: keyset?.createdAt,
        i: keyset?.id,
      });
      if (!parsed.success) {
        // 键集来自已通过读取契约的记录；到这里还不合法说明调用链已损坏 ⇒ 500
        throw new Error('导出分页游标键不合法（服务端缺陷）');
      }
      const payloadSegment = Buffer.from(JSON.stringify(parsed.data), 'utf8').toString('base64url');
      const mac = createHmac('sha256', ownerBoundKey(rootSecret, subject))
        .update(`${EXPORT_CURSOR_PREFIX}${payloadSegment}`, 'utf8')
        .digest();
      return `${EXPORT_CURSOR_PREFIX}${payloadSegment}.${mac.toString('base64url')}`;
    },

    decode(cursor: string, ownerUserId: string): ExportKeyset {
      const subject = requireKeyingSubject(ownerUserId);
      // 1. 长度与字母表门禁：超长 / 非 base64 / 段数不对都在这里就拒绝（不做任何解码与哈希）
      if (
        typeof cursor !== 'string' ||
        cursor.length === 0 ||
        cursor.length > EXPORT_CURSOR_MAX_LENGTH ||
        !EXPORT_CURSOR_PATTERN.test(cursor)
      ) {
        invalidCursor();
      }

      const segments = cursor.split('.');
      const payloadSegment = segments[1] ?? '';
      const signatureSegment = segments[2] ?? '';

      // 2. 签名验证（**先验签再解析载荷**）：跨主体重放与篡改都在这一步失败
      const expected = createHmac('sha256', ownerBoundKey(rootSecret, subject))
        .update(`${EXPORT_CURSOR_PREFIX}${payloadSegment}`, 'utf8')
        .digest();
      const provided = Buffer.from(signatureSegment, 'base64url');
      if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
        invalidCursor();
      }

      // 3. 载荷解析（严格闭集 + 版本号 + ISO 时刻 + UUID）
      let raw: unknown;
      try {
        raw = JSON.parse(Buffer.from(payloadSegment, 'base64url').toString('utf8'));
      } catch {
        invalidCursor();
      }
      const parsed = exportCursorPayloadSchema.safeParse(raw);
      if (!parsed.success) {
        invalidCursor();
      }

      return { createdAt: parsed.data.c, id: parsed.data.i };
    },
  };
}

/** 进程内随机密钥：未配置 `SESSION_SECRET` 时的退化形态（见文件头说明），每次启动重新生成 */
let processScopedSecret: Buffer | undefined;

/**
 * 解析游标签名密钥的根材料：
 * 1. 配置了 `SESSION_SECRET`（非空、非纯空白）⇒ 域分离派生（`sha256("rm-export-cursor:root:" + secret)`），
 *    原值既不当密钥使用也不进入任何返回值 / 错误消息；
 * 2. 未配置 ⇒ **本进程随机** 32 字节（惰性生成一次并复用），因此游标只在本进程内有效：
 *    重启 / 换副本后旧游标一律判为无效（客户端重新从首页开始），而不会退化成可伪造的固定密钥。
 */
export function resolveExportCursorSecret(env: { readonly SESSION_SECRET?: string }): Buffer {
  const configured = typeof env.SESSION_SECRET === 'string' ? env.SESSION_SECRET.trim() : '';
  if (configured !== '') {
    return createHash('sha256')
      .update('rm-export-cursor:root:', 'utf8')
      .update(configured, 'utf8')
      .digest();
  }
  processScopedSecret ??= randomBytes(32);
  return Buffer.from(processScopedSecret);
}

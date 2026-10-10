import { createHmac, randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { ZodError } from 'zod';
import {
  EXPORT_CURSOR_INVALID_MESSAGE,
  EXPORT_CURSOR_MAX_LENGTH,
  EXPORT_CURSOR_PATTERN,
  EXPORT_CURSOR_PREFIX,
  EXPORT_CURSOR_VERSION,
  createExportCursorCodec,
  resolveExportCursorSecret,
} from './exports.cursor';

/**
 * 分页游标编解码器的**离线**验收（纯函数，不连数据库、不建 Nest 应用）。
 *
 * 覆盖用户要求的四条游标性质：
 * 1. **opaque**：整串只有 base64url 段与点，形态上不可读；**不含**归属、路径、产物句柄、
 *    存储 key 或任何 PII 的明文；
 * 2. **签名**：篡改载荷 / 篡改签名 / 换密钥 / 换版本号一律拒绝（同一出口：`ZodError` ⇒ 400）；
 * 3. **绑定服务端主体**：跨主体重放（A 的游标在 B 的会话里使用）必须拒绝 —— 绑定不在载荷里，
 *    而在**由主体派生的签名密钥**里，因此「把载荷里的 owner 改掉」在结构上不可表达；
 * 4. **fail-closed**：超长 / 空串 / 段数不对 / 非 base64url 字符 / 签名长度不符都在**解码之前**
 *    被拒绝，且拒绝文案完全同形、不回显游标取值。
 *
 * 夹具密钥是**测试本地常量**（`Buffer.alloc` / `randomBytes`），不使用也不断言部署密钥；
 * `resolveExportCursorSecret` 的两条分支（已配置 / 未配置）单独验证。
 */

/** 测试用固定密钥（≥16 字节）：与部署配置无关，仅用于让编解码可复现 */
const SECRET = Buffer.from('rm-export-cursor-spec-secret-0123456789', 'utf8');
const OTHER_SECRET = Buffer.from('rm-export-cursor-spec-secret-abcdefghij', 'utf8');

const OWNER = 'u-student-1';
const OTHER_OWNER = 'u-student-2';

const KEYSET = {
  createdAt: '2026-01-06T00:00:00.000Z',
  id: '11111111-1111-4111-8111-111111111111',
};
const NEXT_KEYSET = {
  createdAt: '2026-01-06T00:00:00.001Z',
  id: '22222222-2222-4222-8222-222222222222',
};

function codecFor(secret: Buffer = SECRET) {
  return createExportCursorCodec(secret);
}

/**
 * 按**线格式**自行签一份游标（测试内重新实现，用来证明「格式契约」本身：任何改动 ——
 * 换派生串、换分隔符、换签名算法 —— 都会让本用例失败，而不是被静默接受）。
 */
function signRaw(secret: Buffer, owner: string, payload: unknown): string {
  const ownerKey = createHmac('sha256', secret)
    .update(`rm-export-cursor:owner:${owner}`, 'utf8')
    .digest();
  const segment = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const mac = createHmac('sha256', ownerKey)
    .update(`${EXPORT_CURSOR_PREFIX}${segment}`, 'utf8')
    .digest('base64url');
  return `${EXPORT_CURSOR_PREFIX}${segment}.${mac}`;
}

/** 捕获游标拒绝：必须是 `ZodError`（⇒ 400），且消息与路径稳定 */
function expectCursorRejected(action: () => unknown): ZodError {
  let captured: unknown;
  try {
    action();
  } catch (error) {
    captured = error;
  }
  expect(captured).toBeInstanceOf(ZodError);
  const error = captured as ZodError;
  expect(error.issues).toHaveLength(1);
  expect(error.issues[0]?.path).toEqual(['cursor']);
  expect(error.issues[0]?.message).toBe(EXPORT_CURSOR_INVALID_MESSAGE);
  return error;
}

describe('导出分页游标：编解码与不透明性', () => {
  it('本人游标可往返解出同一键集，且两次编码逐字节相同（服务端派生、无随机盐）', () => {
    const codec = codecFor();
    const cursor = codec.encode(KEYSET, OWNER);

    expect(codec.decode(cursor, OWNER)).toEqual(KEYSET);
    expect(codec.encode(KEYSET, OWNER)).toBe(cursor);
    // 不同键集 → 不同游标（不是「恒定串」这种假实现）
    expect(codec.encode(NEXT_KEYSET, OWNER)).not.toBe(cursor);
  });

  it('游标形态恒为 `e1.<载荷>.<签名>`：长度受控、只含 base64url 字母表', () => {
    const cursor = codecFor().encode(KEYSET, OWNER);

    expect(cursor.startsWith(EXPORT_CURSOR_PREFIX)).toBe(true);
    expect(cursor).toMatch(EXPORT_CURSOR_PATTERN);
    expect(cursor.length).toBeLessThanOrEqual(EXPORT_CURSOR_MAX_LENGTH);
    expect(cursor.split('.')).toHaveLength(3);
    // 载荷段是 base64url，因此整串里不存在明文的时间戳与主键（可读性为 0）
    expect(cursor).not.toContain(KEYSET.id);
    expect(cursor).not.toContain(KEYSET.createdAt);
    expect(cursor).not.toContain(OWNER);
  });

  it('载荷是**严格闭集**：只有版本号与两个排序键分量，多一个键即拒绝（归属结构上装不进去）', () => {
    const codec = codecFor();
    const payload = JSON.parse(
      Buffer.from(codec.encode(KEYSET, OWNER).split('.')[1] ?? '', 'base64url').toString('utf8'),
    ) as Record<string, unknown>;

    expect(Object.keys(payload).sort()).toEqual(['c', 'i', 'v']);
    expect(payload).toMatchObject({ v: EXPORT_CURSOR_VERSION, c: KEYSET.createdAt, i: KEYSET.id });

    // 用**正确密钥**签一份「多带一个 ownerUserId」的载荷：仍然必须被严格契约拒绝
    const forged = signRaw(SECRET, OWNER, {
      v: EXPORT_CURSOR_VERSION,
      c: KEYSET.createdAt,
      i: KEYSET.id,
      ownerUserId: OWNER,
    });
    expectCursorRejected(() => codec.decode(forged, OWNER));
  });

  it('版本号不属于闭集即拒绝（换算法时旧实现不得把新格式当合法输入）', () => {
    const forged = signRaw(SECRET, OWNER, {
      v: EXPORT_CURSOR_VERSION + 1,
      c: KEYSET.createdAt,
      i: KEYSET.id,
    });
    expectCursorRejected(() => codecFor().decode(forged, OWNER));
  });

  it('载荷分量必须仍是「ISO 时间 + UUID」：非法形态即使签名正确也被拒绝', () => {
    for (const payload of [
      { v: EXPORT_CURSOR_VERSION, c: '2026/01/06', i: KEYSET.id },
      { v: EXPORT_CURSOR_VERSION, c: KEYSET.createdAt, i: 'not-a-uuid' },
      { v: EXPORT_CURSOR_VERSION, c: KEYSET.createdAt, i: `${KEYSET.id} OR 1=1` },
      { v: EXPORT_CURSOR_VERSION, c: KEYSET.createdAt },
    ]) {
      const forged = signRaw(SECRET, OWNER, payload);
      expectCursorRejected(() => codecFor().decode(forged, OWNER));
    }
  });
});

describe('导出分页游标：篡改 / 跨主体重放 / 超长输入', () => {
  it('篡改载荷或签名的任一字节 → 拒绝（且不区分「改了哪里」）', () => {
    const codec = codecFor();
    const cursor = codec.encode(KEYSET, OWNER);
    const [prefix, payloadSegment = '', signatureSegment = ''] = cursor.split('.');

    /**
     * 改动 base64url 段的**首字符**：首字符承载 6 个有效位，改动必然改变解码结果。
     * （刻意不翻末字符：base64url 不是规范编码，末字符可能只带无意义填充位，
     * 改它仍会解出**同一份字节**，那属于「同一游标的另一种写法」而不是篡改。）
     */
    const flip = (segment: string): string => {
      const head = segment.slice(0, 1) === 'A' ? 'B' : 'A';
      return `${head}${segment.slice(1)}`;
    };

    for (const tampered of [
      `${prefix}.${flip(payloadSegment)}.${signatureSegment}`,
      `${prefix}.${payloadSegment}.${flip(signatureSegment)}`,
      // 换掉整个载荷段（合法 base64url，但签名不匹配）
      `${prefix}.${Buffer.from('{"v":1}', 'utf8').toString('base64url')}.${signatureSegment}`,
    ]) {
      expect(tampered).not.toBe(cursor);
      expectCursorRejected(() => codec.decode(tampered, OWNER));
    }
  });

  it('跨主体重放：A 的游标在 B 的会话里一律拒绝（绑定在主体派生的密钥里，不在载荷里）', () => {
    const codec = codecFor();
    const subjectACursor = codec.encode(KEYSET, OWNER);

    // A 自己用没问题
    expect(codec.decode(subjectACursor, OWNER)).toEqual(KEYSET);
    // B 用 A 的游标：即使拿到完整原文（这里它就是原文）也解不出来
    expectCursorRejected(() => codec.decode(subjectACursor, OTHER_OWNER));
    // 反方向同样成立（不是「某一侧恰好不匹配」）
    expectCursorRejected(() => codec.decode(codec.encode(NEXT_KEYSET, OTHER_OWNER), OWNER));
  });

  it('换签名密钥（模拟跨部署 / 换 SESSION_SECRET）→ 拒绝', () => {
    const cursor = codecFor(SECRET).encode(KEYSET, OWNER);
    expectCursorRejected(() => codecFor(OTHER_SECRET).decode(cursor, OWNER));
  });

  it('超长输入在**解码之前**就被拒绝，且拒绝信息不含游标取值', () => {
    const long = 'A'.repeat(EXPORT_CURSOR_MAX_LENGTH + 1);
    const padded = `${EXPORT_CURSOR_PREFIX}${long}.${'A'.repeat(43)}`;
    const error = expectCursorRejected(() => codecFor().decode(padded, OWNER));

    expect(JSON.stringify(error.issues)).not.toContain(long.slice(0, 32));
  });

  it('空串 / 非字符串 / 段数不对 / 非 base64url / 签名长度不符一律拒绝', () => {
    const codec = codecFor();
    const valid = codec.encode(KEYSET, OWNER);
    const [prefix, payloadSegment = '', signatureSegment = ''] = valid.split('.');

    const malformed: readonly unknown[] = [
      '',
      'e1',
      'e1.',
      'e1..',
      `${prefix}.${payloadSegment}`,
      `${prefix}.${payloadSegment}.${signatureSegment}.${signatureSegment}`,
      // 前缀版本段不对
      `e2.${payloadSegment}.${signatureSegment}`,
      // 非 base64url 字母表（`+` `/` `=` 与空白、控制字符、注入载荷）
      `${prefix}.${payloadSegment}+.${signatureSegment}`,
      `${prefix}.${payloadSegment}.${signatureSegment}=`,
      `${prefix}.${payloadSegment}.${'A'.repeat(42)}`,
      `${prefix}.${payloadSegment}.${'A'.repeat(44)}`,
      `${prefix}.${payloadSegment}.${signatureSegment}%20`,
      `${prefix}.${payloadSegment}.${signatureSegment}\n`,
      'e1.a.b; DROP TABLE export_jobs',
      undefined,
      null,
      123,
      {},
      [],
    ];

    for (const value of malformed) {
      expectCursorRejected(() => codec.decode(value as string, OWNER));
    }
    // 反向对照：原串仍然可解（证明上面的拒绝来自形态门禁，而不是「一律拒绝」）
    expect(codec.decode(valid, OWNER)).toEqual(KEYSET);
  });
});

describe('导出分页游标：服务端主体与密钥材料的 fail-closed', () => {
  it('空主体 / 超长主体一律抛非 Zod 错误（服务端缺陷 ⇒ 500，不是客户端 400）', () => {
    const codec = codecFor();
    for (const owner of ['', 'x'.repeat(129)]) {
      for (const action of [
        () => codec.encode(KEYSET, owner),
        () => codec.decode(codec.encode(KEYSET, OWNER), owner),
      ]) {
        let captured: unknown;
        try {
          action();
        } catch (error) {
          captured = error;
        }
        expect(captured).toBeInstanceOf(Error);
        expect(captured).not.toBeInstanceOf(ZodError);
      }
    }
  });

  it('键集形态非法（非 UUID 主键 / 非 ISO 时间 / 非对象）在**签发**侧 fail-closed', () => {
    const codec = codecFor();
    for (const keyset of [
      { createdAt: KEYSET.createdAt, id: 'not-a-uuid' },
      { createdAt: '2026/01/06', id: KEYSET.id },
      {},
      undefined,
      null,
    ]) {
      let captured: unknown;
      try {
        codec.encode(keyset as never, OWNER);
      } catch (error) {
        captured = error;
      }
      expect(captured).toBeInstanceOf(Error);
      expect(captured).not.toBeInstanceOf(ZodError);
    }
  });

  it('密钥材料不足 16 字节 / 不是 Buffer → 构造期拒绝', () => {
    for (const secret of [
      Buffer.alloc(0),
      Buffer.from('short'),
      Buffer.alloc(15),
      'not-a-buffer' as unknown as Buffer,
      undefined as unknown as Buffer,
    ]) {
      expect(() => createExportCursorCodec(secret)).toThrow(/游标密钥不可用/u);
    }
    expect(() => createExportCursorCodec(randomBytes(16))).not.toThrow();
  });

  it('密钥解析：配置了 SESSION_SECRET 时确定性派生（且不等于原值）；未配置时退化为进程内随机密钥', () => {
    const configuredA = resolveExportCursorSecret({ SESSION_SECRET: 'configured-secret-value' });
    const configuredB = resolveExportCursorSecret({ SESSION_SECRET: 'configured-secret-value' });
    expect(configuredA.equals(configuredB)).toBe(true);
    expect(configuredA.length).toBeGreaterThanOrEqual(16);
    expect(configuredA.toString('utf8')).not.toContain('configured-secret-value');
    // 空白视为未配置（与 env 层的「空串视为未设置」同口径）
    expect(
      resolveExportCursorSecret({ SESSION_SECRET: '   ' }).equals(
        resolveExportCursorSecret({ SESSION_SECRET: 'configured-secret-value' }),
      ),
    ).toBe(false);
    // 不同配置 → 不同密钥（不是「同一常量」）
    expect(
      configuredA.equals(resolveExportCursorSecret({ SESSION_SECRET: 'another-secret-value' })),
    ).toBe(false);

    // 未配置：进程内随机且**同一进程内稳定**（游标在本进程可继续使用，重启后失效）
    const fallbackA = resolveExportCursorSecret({});
    const fallbackB = resolveExportCursorSecret({});
    expect(fallbackA.equals(fallbackB)).toBe(true);
    expect(fallbackA.length).toBe(32);
    expect(fallbackA.equals(configuredA)).toBe(false);

    // 派生密钥可用：配置分支签出的游标必须能被同一配置的编解码器解出
    const codec = createExportCursorCodec(configuredA);
    expect(codec.decode(codec.encode(KEYSET, OWNER), OWNER)).toEqual(KEYSET);
  });
});

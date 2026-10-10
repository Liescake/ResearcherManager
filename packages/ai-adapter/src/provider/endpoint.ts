/**
 * AI 服务端点安全校验（出站 SSRF 防线）。
 *
 * 设计边界（务必如实理解，不要过度承诺）：
 * - **只做字面量判定，不做任何 DNS / 网络解析**：校验完全基于 URL 文本与主机名字面量，
 *   因此没有网络依赖，也不存在「解析期与连接期结果不一致」的时序问题；
 * - 它能**可证明地**拒绝：非 http/https 协议、携带 userinfo/query/hash/反斜杠/控制字符的地址、
 *   字面量形式的回环（localhost、127.0.0.0/8、::1）、IPv4 私网（RFC1918）、CGNAT、
 *   link-local（含云元数据 169.254.169.254）、保留/组播地址、IPv6 ULA/链路本地、
 *   以及不在允许范围内的端口；
 * - 它**不能**证明一个域名解析后落在公网：若攻击者控制 DNS，仍可能把已放行的域名解析到内网。
 *   本模块**不承诺解决 DNS rebinding**，也不会为此引入 DNS 解析（那既引入网络依赖，
 *   又只能把风险换个地方）。需要更强保证时，应由**显式受信主机 allowlist**
 *   （`AI_TRUSTED_HOSTS`）把可访问主机收敛到运维确认过的少数名字上；
 * - 对无法可靠判定的字面量（单标签主机名、畸形 IP 字面量、含转义/非法字符的主机名、
 *   无法解析的 URL）一律 **fail-closed**：拒绝，而不是放行。
 *
 * 错误消息只描述**规则**，绝不回显原始 URL（可能含凭据或查询串）。
 */

/** 允许的出站协议：只接受 http / https */
export const AI_ENDPOINT_SCHEME_ALLOWLIST = ['http:', 'https:'] as const;
export type AiEndpointScheme = (typeof AI_ENDPOINT_SCHEME_ALLOWLIST)[number];

/** 端点校验错误码（闭集，供配置层与测试判定；不含任何原始输入） */
export const AiEndpointErrorCode = {
  Invalid: 'AI_ENDPOINT_INVALID',
  SchemeUnsupported: 'AI_ENDPOINT_SCHEME_UNSUPPORTED',
  CredentialsNotAllowed: 'AI_ENDPOINT_CREDENTIALS_NOT_ALLOWED',
  QueryNotAllowed: 'AI_ENDPOINT_QUERY_NOT_ALLOWED',
  FragmentNotAllowed: 'AI_ENDPOINT_FRAGMENT_NOT_ALLOWED',
  BackslashNotAllowed: 'AI_ENDPOINT_BACKSLASH_NOT_ALLOWED',
  ControlCharacterNotAllowed: 'AI_ENDPOINT_CONTROL_CHARACTER_NOT_ALLOWED',
  HostMissing: 'AI_ENDPOINT_HOST_MISSING',
  HostNotAllowed: 'AI_ENDPOINT_HOST_NOT_ALLOWED',
  PortNotAllowed: 'AI_ENDPOINT_PORT_NOT_ALLOWED',
} as const;
export type AiEndpointErrorCode = (typeof AiEndpointErrorCode)[keyof typeof AiEndpointErrorCode];

export interface AiEndpointPolicy {
  /**
   * 显式受信主机 allowlist：**精确匹配**（大小写不敏感，忽略 IPv6 方括号与末尾根点），
   * 不支持通配符 / 后缀匹配（未命中即 fail-closed）。命中后放宽「主机安全」与「端口范围」
   * 两项判定，但**不**放宽协议、userinfo、query、hash、反斜杠、控制字符这些结构约束。
   */
  readonly trustedHosts?: string | readonly string[] | undefined;
  /** 允许的端口；未配置时按协议取安全默认值（http → 80，https → 443） */
  readonly allowedPorts?: readonly number[] | undefined;
}

/** 已通过校验的端点（`url` 是规范化后的字面量，不含 userinfo/query/hash） */
export interface ResolvedAiEndpoint {
  readonly protocol: AiEndpointScheme;
  readonly host: string;
  readonly port: number;
  readonly url: string;
  /** 是否由显式受信主机 allowlist 放行（仅用于审计/诊断，不用于对外输出） */
  readonly trusted: boolean;
}

export type AiEndpointResolution =
  | { readonly ok: true; readonly endpoint: ResolvedAiEndpoint }
  | { readonly ok: false; readonly code: AiEndpointErrorCode; readonly message: string };

/** 未配置受信主机时的安全默认端口：只允许协议的标准端口 */
const DEFAULT_ALLOWED_PORTS: Readonly<Record<AiEndpointScheme, readonly number[]>> = {
  'http:': [80],
  'https:': [443],
};

/**
 * 可证明的私有 / 不可路由 DNS 后缀（含 IANA 保留的特殊用途顶级域）。
 * 这些名字不经过公网 DNS 即属于本机或私有网络语义，命中一律拒绝。
 */
const PRIVATE_USE_SUFFIXES = [
  '.localhost',
  '.local',
  '.internal',
  '.home.arpa',
  '.lan',
  '.corp',
  '.intranet',
  '.localdomain',
  '.test',
  '.invalid',
  '.example',
  '.onion',
] as const;

/**
 * 合法多标签主机名（URL 解析后已是小写、IDN 已转 punycode）：
 * 至少两个标签，每个标签为字母/数字/连字符且不以连字符开头结尾。
 * 单标签主机名（常见于内网短名）与含下划线、百分号转义、空标签的名字都**不**匹配 → fail-closed。
 */
const DNS_NAME_PATTERN =
  /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/u;

type HostClassification = 'public' | 'dangerous' | 'ambiguous';

function fail(code: AiEndpointErrorCode, message: string): AiEndpointResolution {
  return { ok: false, code, message };
}

/** 是否包含 C0 控制字符或 DEL（按码点判断，避免正则字面量里的控制字符） */
function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint <= 0x1f || codePoint === 0x7f) {
      return true;
    }
  }
  return false;
}

/** 规范化受信主机条目：去空白、转小写、去掉 IPA 字面量方括号与末尾根点；空条目忽略 */
export function normalizeTrustedHosts(
  input: string | readonly string[] | undefined,
): readonly string[] {
  if (input === undefined) {
    return [];
  }
  const values = typeof input === 'string' ? input.split(',') : [...input];
  const normalized: string[] = [];
  for (const value of values) {
    const host = canonicalizeHost(value);
    if (host !== '' && !normalized.includes(host)) {
      normalized.push(host);
    }
  }
  return normalized;
}

/** 主机名规范化：转小写、去末尾根点、去 IPv6 方括号（保留冒号以判定字面量） */
function canonicalizeHost(value: string): string {
  let host = value.trim().toLowerCase();
  while (host.endsWith('.')) {
    host = host.slice(0, -1);
  }
  if (host.startsWith('[') && host.endsWith(']')) {
    host = host.slice(1, -1);
  }
  return host;
}

/** 解析 IPv4 点分四段；任何可疑形式（前导零、段数不足、越界、非数字）都返回 undefined */
function parseIpv4Octets(input: string): number[] | null {
  const parts = input.split('.');
  if (parts.length !== 4) {
    return null;
  }
  const octets: number[] = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/u.test(part)) {
      return null;
    }
    // 前导零是历史八进制写法的歧义来源，按 fail-closed 拒绝
    if (part.length > 1 && part.startsWith('0')) {
      return null;
    }
    const value = Number.parseInt(part, 10);
    if (value > 255) {
      return null;
    }
    octets.push(value);
  }
  return octets;
}

/**
 * 解析 IPv6 为 8 个 16 位组；支持 `::` 压缩与末尾内嵌 IPv4（如 `::ffff:127.0.0.1`）。
 * 任何非规范 / 歧义写法返回 null（由调用方 fail-closed）。
 */
function parseIpv6Hextets(input: string): number[] | null {
  if (input === '' || input.includes('%')) {
    return null;
  }
  const sections = input.split('::');
  if (sections.length > 2) {
    return null;
  }
  const hasGap = sections.length === 2;

  const parseSide = (side: string, allowsIpv4Tail: boolean): number[] | null => {
    if (side === '') {
      return [];
    }
    const parts = side.split(':');
    const values: number[] = [];
    for (let index = 0; index < parts.length; index += 1) {
      const part = parts[index] ?? '';
      if (part === '') {
        return null;
      }
      const isLast = index === parts.length - 1;
      if (allowsIpv4Tail && isLast && part.includes('.')) {
        const octets = parseIpv4Octets(part);
        if (octets === null) {
          return null;
        }
        values.push(octets[0]! * 0x100 + octets[1]!, octets[2]! * 0x100 + octets[3]!);
        continue;
      }
      if (!/^[0-9a-f]{1,4}$/u.test(part)) {
        return null;
      }
      values.push(Number.parseInt(part, 16));
    }
    return values;
  };

  const head = parseSide(sections[0] ?? '', !hasGap);
  if (head === null) {
    return null;
  }
  if (!hasGap) {
    return head.length === 8 ? head : null;
  }
  const tail = parseSide(sections[1] ?? '', true);
  if (tail === null) {
    return null;
  }
  const gap = 8 - head.length - tail.length;
  if (gap < 1) {
    return null;
  }
  return [...head, ...Array.from({ length: gap }, () => 0), ...tail];
}

/** 仅接受可路由的全球单播 IPv4：私网 / 回环 / 链路本地 / CGNAT / 保留 / 组播一律拒绝 */
function isPublicIpv4(octets: readonly number[]): boolean {
  const [a = 0, b = 0, c = 0] = octets;
  if (a === 0) return false; // 0.0.0.0/8：本网络 / 未指定
  if (a === 10) return false; // RFC1918
  if (a === 100 && b >= 64 && b <= 127) return false; // CGNAT 100.64.0.0/10（含云元数据 100.100.100.200）
  if (a === 127) return false; // 回环
  if (a === 169 && b === 254) return false; // link-local（含 169.254.169.254 云元数据）
  if (a === 172 && b >= 16 && b <= 31) return false; // RFC1918
  if (a === 192 && b === 0 && c === 0) return false; // 192.0.0.0/24 IETF 协议专用
  if (a === 192 && b === 0 && c === 2) return false; // TEST-NET-1
  if (a === 192 && b === 88 && c === 99) return false; // 6to4 中继任播（已废弃）
  if (a === 192 && b === 168) return false; // RFC1918
  if (a === 198 && (b === 18 || b === 19)) return false; // 基准测试
  if (a === 198 && b === 51 && c === 100) return false; // TEST-NET-2
  if (a === 203 && b === 0 && c === 113) return false; // TEST-NET-3
  if (a >= 224) return false; // 组播 / 保留 / 广播
  return true;
}

/**
 * 仅接受全球单播 IPv6（2000::/3）中的可路由子集。
 * 回环 `::1`、未指定 `::`、IPv4 映射 `::ffff:0:0/96`、ULA `fc00::/7`、
 * 链路本地 `fe80::/10`、组播 `ff00::/8` 都不在 2000::/3 内，因此被统一拒绝。
 */
function isPublicIpv6(hextets: readonly number[]): boolean {
  const first = hextets[0] ?? 0;
  const second = hextets[1] ?? 0;
  if ((first & 0xe000) !== 0x2000) {
    return false;
  }
  if (first === 0x2001 && second === 0x0db8) return false; // 文档用途 2001:db8::/32
  if (first === 0x2001 && second === 0x0000) return false; // Teredo 隧道 2001::/32
  if (first === 0x2002) {
    // 6to4 2002::/16：按内嵌 IPv4 判定，避免通过隧道绕过 IPv4 私网规则
    const third = hextets[2] ?? 0;
    const fourth = hextets[3] ?? 0;
    return isPublicIpv4([third >> 8, third & 0xff, fourth >> 8, fourth & 0xff]);
  }
  return true;
}

function classifyIpv4Literal(host: string): HostClassification {
  const octets = parseIpv4Octets(host);
  if (octets === null) {
    return 'ambiguous';
  }
  return isPublicIpv4(octets) ? 'public' : 'dangerous';
}

function classifyHostname(host: string): HostClassification {
  if (host.includes(':')) {
    const hextets = parseIpv6Hextets(host);
    if (hextets === null) {
      return 'ambiguous';
    }
    return isPublicIpv6(hextets) ? 'public' : 'dangerous';
  }
  // WHATWG URL 已把各种 IPv4 写法（十六进制/十进制/少于四段）规范化为点分四段，
  // 因此只把「规范点分四段」当作 IP 字面量；`1password.com` 这类以数字开头的域名仍按域名判定。
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/u.test(host)) {
    return classifyIpv4Literal(host);
  }
  if (host === 'localhost' || PRIVATE_USE_SUFFIXES.some((suffix) => host.endsWith(suffix))) {
    return 'dangerous';
  }
  if (!DNS_NAME_PATTERN.test(host)) {
    // 单标签内网短名、含下划线/转义的畸形名字、超长标签等：无法可靠判断 → fail-closed
    return 'ambiguous';
  }
  return 'public';
}

/**
 * 校验并解析 AI 服务地址。
 *
 * @returns `ok: true` 时给出规范化端点；否则给出错误码与**不含原始输入**的消息。
 */
export function resolveAiEndpoint(
  raw: string,
  policy: AiEndpointPolicy = {},
): AiEndpointResolution {
  if (typeof raw !== 'string' || raw.trim() === '') {
    return fail(AiEndpointErrorCode.Invalid, 'AI 服务地址不能为空');
  }
  const value = raw.trim();

  if (hasControlCharacter(value)) {
    return fail(
      AiEndpointErrorCode.ControlCharacterNotAllowed,
      'AI 服务地址不得包含控制字符（已按 fail-closed 拒绝）',
    );
  }
  if (value.includes('\\')) {
    return fail(
      AiEndpointErrorCode.BackslashNotAllowed,
      'AI 服务地址不得包含反斜杠（不同解析器对其处理不一致，已按 fail-closed 拒绝）',
    );
  }

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return fail(AiEndpointErrorCode.Invalid, 'AI 服务地址不是合法 URL（已按 fail-closed 拒绝）');
  }

  const protocol = parsed.protocol;
  if (protocol !== 'http:' && protocol !== 'https:') {
    return fail(
      AiEndpointErrorCode.SchemeUnsupported,
      `AI 服务地址协议不受支持（只允许 ${AI_ENDPOINT_SCHEME_ALLOWLIST.join(' / ')}）`,
    );
  }
  if (parsed.username !== '' || parsed.password !== '') {
    return fail(
      AiEndpointErrorCode.CredentialsNotAllowed,
      'AI 服务地址不得包含用户名或口令（凭据只允许通过请求头传递）',
    );
  }
  if (parsed.search !== '') {
    return fail(AiEndpointErrorCode.QueryNotAllowed, 'AI 服务地址不得包含查询串');
  }
  if (parsed.hash !== '') {
    return fail(AiEndpointErrorCode.FragmentNotAllowed, 'AI 服务地址不得包含 URL 片段');
  }

  const host = canonicalizeHost(parsed.hostname);
  if (host === '') {
    return fail(AiEndpointErrorCode.HostMissing, 'AI 服务地址缺少主机名');
  }
  if (host.includes('%')) {
    return fail(
      AiEndpointErrorCode.HostNotAllowed,
      'AI 服务地址主机名包含转义字符，无法可靠判定（已按 fail-closed 拒绝）',
    );
  }

  const trusted = normalizeTrustedHosts(policy.trustedHosts).includes(host);
  if (!trusted && classifyHostname(host) !== 'public') {
    return fail(
      AiEndpointErrorCode.HostNotAllowed,
      'AI 服务地址指向本机 / 私网 / 链路本地 / 保留地址，或主机名无法可靠判定（已按安全策略拒绝；确需访问请显式加入 AI_TRUSTED_HOSTS）',
    );
  }

  const explicitPort = parsed.port === '' ? undefined : Number.parseInt(parsed.port, 10);
  const port = explicitPort ?? (protocol === 'https:' ? 443 : 80);
  if (!trusted) {
    const allowedPorts = policy.allowedPorts ?? DEFAULT_ALLOWED_PORTS[protocol];
    if (!allowedPorts.includes(port)) {
      return fail(
        AiEndpointErrorCode.PortNotAllowed,
        `AI 服务地址端口不在允许范围内（当前协议只允许 ${allowedPorts.join(' / ')}；其他端口需显式列入 AI_TRUSTED_HOSTS）`,
      );
    }
  }

  return {
    ok: true,
    endpoint: { protocol, host, port, url: parsed.href, trusted },
  };
}

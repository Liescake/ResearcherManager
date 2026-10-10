import { describe, expect, it } from 'vitest';
import {
  AiEndpointErrorCode,
  normalizeTrustedHosts,
  resolveAiEndpoint,
} from '../provider/endpoint';

/** 断言拒绝，并返回错误码与消息（消息必须可用于日志：不含原始 URL） */
function expectRejected(raw: string, trustedHosts?: string): { code: string; message: string } {
  const resolution = resolveAiEndpoint(raw, { trustedHosts });
  expect(resolution.ok).toBe(false);
  if (resolution.ok) {
    throw new Error('应当拒绝该地址');
  }
  // 无论哪种失败，消息都不得回显原始输入（可能含凭据 / 查询串 / 内网主机名）
  if (raw !== '') {
    expect(resolution.message).not.toContain(raw);
  }
  return { code: resolution.code, message: resolution.message };
}

describe('AI 服务端点安全校验', () => {
  it('只接受 http / https，其他协议一律拒绝', () => {
    for (const raw of [
      'ftp://api.example.com/v1',
      'file:///etc/passwd',
      'ws://api.example.com/v1',
      'javascript:alert(1)',
      'data:text/plain,hello',
    ]) {
      expect(expectRejected(raw).code).toBe(AiEndpointErrorCode.SchemeUnsupported);
    }
    // 缺少协议头 / 无法解析：fail-closed
    expect(expectRejected('api.example.com/v1').code).toBe(AiEndpointErrorCode.Invalid);
    expect(expectRejected('').code).toBe(AiEndpointErrorCode.Invalid);
  });

  it('拒绝 userinfo / query / hash / 反斜杠 / 控制字符', () => {
    expect(expectRejected('https://user:pw@api.example.com/v1').code).toBe(
      AiEndpointErrorCode.CredentialsNotAllowed,
    );
    expect(expectRejected('https://api.example.com/v1?token=abc').code).toBe(
      AiEndpointErrorCode.QueryNotAllowed,
    );
    expect(expectRejected('https://api.example.com/v1#frag').code).toBe(
      AiEndpointErrorCode.FragmentNotAllowed,
    );
    expect(expectRejected('https://api.example.com\\@127.0.0.1/v1').code).toBe(
      AiEndpointErrorCode.BackslashNotAllowed,
    );
    expect(expectRejected('https://api.example.com/v1\u0000').code).toBe(
      AiEndpointErrorCode.ControlCharacterNotAllowed,
    );
  });

  it('可证明的本机 / 私网 / 链路本地 / 元数据地址一律拒绝（IPv4）', () => {
    for (const raw of [
      'http://localhost/v1',
      'http://foo.localhost/v1',
      'http://127.0.0.1/v1',
      'http://127.9.9.9/v1',
      'http://10.0.0.5/v1',
      'http://172.16.3.4/v1',
      'http://172.31.255.254/v1',
      'http://192.168.1.1/v1',
      'http://169.254.169.254/latest/meta-data',
      'http://100.100.100.200/v1',
      'http://100.64.1.1/v1',
      'http://0.0.0.0/v1',
      'http://224.0.0.1/v1',
    ]) {
      expect(expectRejected(raw).code).toBe(AiEndpointErrorCode.HostNotAllowed);
    }
  });

  it('URL 规范化后的等价写法同样被识破（十六进制 / 十进制 / 少段 IPv4）', () => {
    expect(expectRejected('http://0x7f000001/v1').code).toBe(AiEndpointErrorCode.HostNotAllowed);
    expect(expectRejected('http://2130706433/v1').code).toBe(AiEndpointErrorCode.HostNotAllowed);
    expect(expectRejected('http://127.1/v1').code).toBe(AiEndpointErrorCode.HostNotAllowed);
  });

  it('IPv6 回环 / ULA / 链路本地 / IPv4 映射地址一律拒绝', () => {
    for (const raw of [
      'http://[::1]/v1',
      'http://[::]/v1',
      'http://[fe80::1]/v1',
      'http://[fd00::1]/v1',
      'http://[ff02::1]/v1',
      'http://[::ffff:127.0.0.1]/v1',
      'http://[::ffff:169.254.169.254]/v1',
    ]) {
      expect(expectRejected(raw).code).toBe(AiEndpointErrorCode.HostNotAllowed);
    }
  });

  it('私有用途 DNS 后缀与云元数据主机名一律拒绝', () => {
    for (const raw of [
      'http://metadata.google.internal/computeMetadata/v1',
      'http://gw.internal/v1',
      'http://gw.local/v1',
      'http://gw.home.arpa/v1',
    ]) {
      expect(expectRejected(raw).code).toBe(AiEndpointErrorCode.HostNotAllowed);
    }
  });

  it('无法可靠判定的主机名按 fail-closed 拒绝', () => {
    // 单标签内网短名
    expect(expectRejected('https://ai-gateway/v1').code).toBe(AiEndpointErrorCode.HostNotAllowed);
    // 含下划线等非法主机名字符
    expect(expectRejected('https://ai_gateway.example.com/v1').code).toBe(
      AiEndpointErrorCode.HostNotAllowed,
    );
  });

  it('端口按协议收敛：默认只允许 443（https）/ 80（http）', () => {
    expect(resolveAiEndpoint('https://api.example.com/v1').ok).toBe(true);
    expect(resolveAiEndpoint('https://api.example.com:443/v1').ok).toBe(true);
    expect(resolveAiEndpoint('http://api.example.com/v1').ok).toBe(true);

    expect(expectRejected('https://api.example.com:8443/v1').code).toBe(
      AiEndpointErrorCode.PortNotAllowed,
    );
    expect(expectRejected('http://api.example.com:8080/v1').code).toBe(
      AiEndpointErrorCode.PortNotAllowed,
    );
    // http + 443 组合也不在默认允许范围
    expect(expectRejected('http://api.example.com:443/v1').code).toBe(
      AiEndpointErrorCode.PortNotAllowed,
    );
  });

  it('放行公网域名，并把末尾根点规范化掉', () => {
    const resolution = resolveAiEndpoint('https://api.example.com/v1/');
    expect(resolution.ok).toBe(true);
    if (!resolution.ok) {
      throw new Error('应当放行');
    }
    expect(resolution.endpoint.host).toBe('api.example.com');
    expect(resolution.endpoint.port).toBe(443);
    expect(resolution.endpoint.protocol).toBe('https:');
    expect(resolution.endpoint.url).toBe('https://api.example.com/v1/');
    expect(resolution.endpoint.trusted).toBe(false);

    // 末尾根点（FQDN 绝对形式）不影响判定
    const absolute = resolveAiEndpoint('https://api.example.com./v1');
    expect(absolute.ok).toBe(true);
    if (absolute.ok) {
      expect(absolute.endpoint.host).toBe('api.example.com');
    }
  });

  it('显式受信主机 allowlist 放行本机 / 内网与非标准端口', () => {
    const loopback = resolveAiEndpoint('http://127.0.0.1:11434/v1', {
      trustedHosts: '127.0.0.1',
    });
    expect(loopback.ok).toBe(true);
    if (loopback.ok) {
      expect(loopback.endpoint.trusted).toBe(true);
      expect(loopback.endpoint.port).toBe(11434);
    }

    // 逗号分隔 + IPv6 方括号写法都能匹配
    expect(resolveAiEndpoint('http://[::1]:8080/v1', { trustedHosts: 'gateway, [::1]' }).ok).toBe(
      true,
    );
    expect(
      resolveAiEndpoint('http://gw.internal:9000/v1', { trustedHosts: ['gw.internal'] }).ok,
    ).toBe(true);
  });

  it('受信主机是精确匹配：不放宽协议与结构约束，也不做后缀匹配', () => {
    // 不做后缀匹配：evil-api.example.com 不会因为 api.example.com 受信而放行 8443
    expect(expectRejected('https://evil-api.example.com:8443/v1', 'api.example.com').code).toBe(
      AiEndpointErrorCode.PortNotAllowed,
    );
    // 受信也不放宽协议
    expect(expectRejected('ftp://127.0.0.1/v1', '127.0.0.1').code).toBe(
      AiEndpointErrorCode.SchemeUnsupported,
    );
    // 受信也不放宽 userinfo / query
    expect(expectRejected('http://user:pw@127.0.0.1/v1', '127.0.0.1').code).toBe(
      AiEndpointErrorCode.CredentialsNotAllowed,
    );
    expect(expectRejected('http://127.0.0.1/v1?token=abc', '127.0.0.1').code).toBe(
      AiEndpointErrorCode.QueryNotAllowed,
    );
  });

  it('受信主机清单规范化：忽略空白条目并去重', () => {
    expect(normalizeTrustedHosts(' A.example.com , ,[::1] , a.example.com. ')).toEqual([
      'a.example.com',
      '::1',
    ]);
    expect(normalizeTrustedHosts(undefined)).toEqual([]);
  });

  it('失败消息只描述规则，不回显原始地址中的凭据与查询串', () => {
    const raw = 'https://ops:sup3rsecret@127.0.0.1:8080/v1?token=sekret-token';
    const { message } = expectRejected(raw);
    expect(message).not.toContain('sup3rsecret');
    expect(message).not.toContain('sekret-token');
    expect(message).not.toContain('127.0.0.1');
  });
});

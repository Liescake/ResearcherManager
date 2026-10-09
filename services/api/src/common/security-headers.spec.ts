import 'reflect-metadata';
import type { IncomingHttpHeaders } from 'node:http';
import { request } from 'node:http';
import { Controller, Get, Module, type INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { afterAll, describe, expect, it } from 'vitest';
import {
  CONTENT_SECURITY_POLICY,
  PERMISSIONS_POLICY,
  STATIC_SECURITY_HEADERS,
  STRICT_TRANSPORT_SECURITY,
  applySecurityHeaders,
  createSecurityHeadersMiddleware,
  resolveSecurityHeaders,
  shouldEnableHsts,
} from './security-headers';

/**
 * **安全响应头**验证：头存在性、HSTS 的条件性、以及「值不泄露」。
 *
 * 分两层：
 * 1. 判定与中间件的单元级用例（不启监听）：穷举 HSTS 条件，并守住「写入的响应头是
 *    一组固定常量」这条不泄露属性（判定输入里的任何内容都不得出现在头值里）。
 * 2. 真实 HTTP 用例（真实 socket + Base HTTP 服务器）：证明中间件确实作用在**每一条**响应上
 *    （命中路由、404、带 `Origin` 的跨源请求），且 JSON API 不受影响。
 *
 * 为什么这里用一个最小 `@Module` 而不是 `AppModule`：`AppModule` 在 `NODE_ENV=production`
 * 下按设计 fail-closed（内存基线 + 未验证 SQL 执行器禁止上线），**不可能**在 production
 * 档位起监听；而 HSTS 恰恰只在 production 出现。用最小模块 + 显式策略跑真实 HTTP，
 * 才能把「生产 + 已确认 HTTPS ⇒ 真的发出 HSTS」与「开发/测试 HTTP ⇒ 不发出 HSTS」
 * 两条都在真实 socket 上验证。`createApp` 走的是同一个 `applySecurityHeaders`，
 * 其真实装配路径由 `startup-assembly.spec.ts` 的用例覆盖。
 */
@Controller('probe')
class ProbeController {
  @Get()
  read(): { ok: boolean } {
    return { ok: true };
  }

  @Get('boom')
  boom(): never {
    throw new Error('probe failure');
  }
}

@Module({ controllers: [ProbeController] })
class ProbeModule {}

/** 已装配/已监听的应用：统一在用例结束后关闭，避免悬挂句柄 */
const startedApps: INestApplication[] = [];

afterAll(async () => {
  await Promise.all(startedApps.map((app) => app.close()));
});

interface HttpResult {
  readonly status: number;
  readonly body: unknown;
  readonly headers: IncomingHttpHeaders;
}

function httpGet(
  baseUrl: string,
  path: string,
  headers: Record<string, string> = {},
): Promise<HttpResult> {
  return new Promise((resolvePromise, rejectPromise) => {
    const req = request(`${baseUrl}${path}`, { method: 'GET', headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let body: unknown;
        try {
          body = JSON.parse(text) as unknown;
        } catch {
          body = text;
        }
        resolvePromise({ status: res.statusCode ?? 0, body, headers: res.headers });
      });
    });
    req.on('error', rejectPromise);
    req.end();
  });
}

/** 起一个真实监听的最小应用，并按给定环境档位装安全响应头 */
async function startProbeApp(
  env: Parameters<typeof applySecurityHeaders>[1],
): Promise<{ baseUrl: string; policy: Readonly<Record<string, string>> }> {
  const app = await NestFactory.create(ProbeModule, { logger: false, abortOnError: false });
  startedApps.push(app);
  const policy = applySecurityHeaders(app, env);
  await app.init();
  await app.listen(0, '127.0.0.1');
  return { baseUrl: await app.getUrl(), policy };
}

describe('安全响应头：常量头始终存在', () => {
  it('解析结果只包含固定常量头，取值与导出常量逐字一致', () => {
    const policy = resolveSecurityHeaders({ nodeEnv: 'development' });

    expect(policy).toEqual({
      'Content-Security-Policy': CONTENT_SECURITY_POLICY,
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'no-referrer',
      'Permissions-Policy': PERMISSIONS_POLICY,
    });
    expect(Object.keys(policy).sort()).toEqual([
      'Content-Security-Policy',
      'Permissions-Policy',
      'Referrer-Policy',
      'X-Content-Type-Options',
      'X-Frame-Options',
    ]);
  });

  it('CSP 按 API-only 下限配置：拒绝一切资源，并显式封住 frame-ancestors 与 base-uri', () => {
    expect(CONTENT_SECURITY_POLICY).toBe(
      "default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
    );
    // 不允许出现任何放行来源（'self' / http(s):// / *）：本服务不返回页面
    expect(CONTENT_SECURITY_POLICY).not.toMatch(/self|unsafe-inline|unsafe-eval|\*/u);
  });

  it('Permissions-Policy 用空允许列表显式禁用（而不是省略）', () => {
    for (const feature of ['camera', 'microphone', 'geolocation', 'payment', 'usb']) {
      expect(PERMISSIONS_POLICY).toContain(`${feature}=()`);
    }
    expect(PERMISSIONS_POLICY).not.toContain('*');
  });
});

describe('安全响应头：HSTS 只在「生产 且 已确认 HTTPS」时设置', () => {
  it('开发 / 测试环境即使配置了 https 地址也不设置 HSTS（HTTP 开发不得设置）', () => {
    expect(shouldEnableHsts({ nodeEnv: 'development', publicUrl: 'https://api.example.com' })).toBe(
      false,
    );
    expect(shouldEnableHsts({ nodeEnv: 'test', publicUrl: 'https://api.example.com' })).toBe(false);

    for (const nodeEnv of ['development', 'test']) {
      const policy = resolveSecurityHeaders({ nodeEnv, publicUrl: 'https://api.example.com' });
      expect(policy['Strict-Transport-Security']).toBeUndefined();
      expect(Object.keys(policy)).not.toContain('Strict-Transport-Security');
      // 非 HSTS 下其余常量头不得因此消失
      expect(policy).toEqual(STATIC_SECURITY_HEADERS);
    }
  });

  it('生产环境配置 https 公开地址：才设置 HSTS，取值是固定常量', () => {
    const policy = resolveSecurityHeaders({
      nodeEnv: 'production',
      publicUrl: 'https://api.example.com',
    });
    expect(policy['Strict-Transport-Security']).toBe(STRICT_TRANSPORT_SECURITY);
    expect(STRICT_TRANSPORT_SECURITY).toBe('max-age=31536000');
    // 不承诺 includeSubDomains / preload：不对同父域的其它子域作出未经验证的强制
    expect(STRICT_TRANSPORT_SECURITY).not.toContain('includeSubDomains');
    expect(STRICT_TRANSPORT_SECURITY).not.toContain('preload');
  });

  it('生产环境但未确认 HTTPS（未配置 / http / 非法 URL）：一律不设置 HSTS', () => {
    for (const publicUrl of [
      undefined,
      '',
      '   ',
      'http://api.example.com',
      'api.example.com',
      'ftp://api.example.com',
    ]) {
      expect(shouldEnableHsts({ nodeEnv: 'production', publicUrl })).toBe(false);
      const policy = resolveSecurityHeaders({ nodeEnv: 'production', publicUrl });
      expect(policy['Strict-Transport-Security']).toBeUndefined();
      // fail-safe：不确定时宁可少一个头，也不留下错误的 HTTPS 承诺
      expect(Object.keys(policy).sort()).toEqual(Object.keys(STATIC_SECURITY_HEADERS).sort());
    }
  });

  it('大小写与尾随空白不影响判定（URL 与档位都是显式配置）', () => {
    expect(
      shouldEnableHsts({ nodeEnv: 'production', publicUrl: '  HTTPS://API.example.com  ' }),
    ).toBe(true);
    // 档位取值来自已校验的 env 闭集，不做大小写宽松处理
    expect(shouldEnableHsts({ nodeEnv: 'PRODUCTION', publicUrl: 'https://api.example.com' })).toBe(
      false,
    );
  });

  it('数据库 TLS 档位不是 HSTS 的证据：判定输入里没有它', () => {
    // 判定签名只有档位与公开地址：`DATABASE_SSL_MODE=verify-full` 无法影响 HSTS，
    // 因此这里只能通过 publicUrl 才可能启用（显式声明 HTTP 层 HTTPS 已就绪）。
    expect(shouldEnableHsts({ nodeEnv: 'production' })).toBe(false);
    expect(shouldEnableHsts({ nodeEnv: 'production', publicUrl: 'https://api.example.com' })).toBe(
      true,
    );
  });
});

describe('安全响应头：中间件行为与不泄露', () => {
  it('逐个写入策略中的头，然后调用 next 一次', () => {
    const policy = resolveSecurityHeaders({
      nodeEnv: 'production',
      publicUrl: 'https://a.example',
    });
    const written: Record<string, string> = {};
    let nextCalls = 0;

    createSecurityHeadersMiddleware(policy)(
      { method: 'GET', url: '/probe' },
      {
        setHeader: (name, value) => {
          written[name] = value;
        },
      },
      () => {
        nextCalls += 1;
      },
    );

    expect(written).toEqual(policy);
    expect(Object.keys(written).sort()).toEqual(Object.keys(policy).sort());
    expect(nextCalls).toBe(1);
  });

  it('响应对象没有 setHeader 时不抛错（加固手段不得把请求变成 500）', () => {
    const middleware = createSecurityHeadersMiddleware(resolveSecurityHeaders({ nodeEnv: 'test' }));
    let nextCalls = 0;
    expect(() =>
      middleware({}, {}, () => {
        nextCalls += 1;
      }),
    ).not.toThrow();
    expect(nextCalls).toBe(1);
  });

  it('不泄露值：头值全部来自固定常量，配置里的任何片段都不出现在头里', () => {
    // 带凭据的公开地址：判定只看协议，但整串绝不能进入响应头
    const policy = resolveSecurityHeaders({
      nodeEnv: 'production',
      publicUrl: 'https://svc-user:s3cret-pw@api.example.com/private',
    });
    const serialized = JSON.stringify(policy);

    expect(policy['Strict-Transport-Security']).toBe('max-age=31536000');
    expect(serialized).not.toContain('s3cret-pw');
    expect(serialized).not.toContain('svc-user');
    expect(serialized).not.toContain('api.example.com');
    expect(serialized).not.toContain('/private');
    // 也不含任何常见的敏感字样
    expect(serialized).not.toMatch(/postgres|password|secret|bearer|token/iu);
  });
});

describe('安全响应头：真实 HTTP（生产 + 已确认 HTTPS）', () => {
  it('命中路由与未命中路由（404）都带安全响应头，并设置 HSTS', async () => {
    const { baseUrl } = await startProbeApp({
      NODE_ENV: 'production',
      API_PUBLIC_URL: 'https://api.example.com',
    });

    const ok = await httpGet(baseUrl, '/probe');
    expect(ok.status).toBe(200);
    expect(ok.body).toEqual({ ok: true });
    expect(ok.headers['content-type']).toContain('application/json');
    expect(ok.headers['content-security-policy']).toBe(
      "default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
    );
    expect(ok.headers['x-content-type-options']).toBe('nosniff');
    expect(ok.headers['x-frame-options']).toBe('DENY');
    expect(ok.headers['referrer-policy']).toBe('no-referrer');
    expect(ok.headers['permissions-policy']).toContain('camera=()');
    expect(ok.headers['strict-transport-security']).toBe('max-age=31536000');

    // 404 也必须带头：中间件在路由注册之前挂载（否则只会覆盖命中的路由）
    const missing = await httpGet(baseUrl, '/definitely-not-a-route');
    expect(missing.status).toBe(404);
    expect(missing.headers['content-security-policy']).toBe(
      "default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
    );
    expect(missing.headers['x-content-type-options']).toBe('nosniff');
    expect(missing.headers['x-frame-options']).toBe('DENY');
    expect(missing.headers['strict-transport-security']).toBe('max-age=31536000');

    // 异常出口（500）同样带头：安全头是「引擎盖」而不是「成功响应的装饰」
    const boom = await httpGet(baseUrl, '/probe/boom');
    expect(boom.status).toBe(500);
    expect(boom.headers['x-content-type-options']).toBe('nosniff');
    expect(boom.headers['content-security-policy']).toContain("default-src 'none'");
    expect(boom.headers['strict-transport-security']).toBe('max-age=31536000');
  });

  it('CORS 默认关闭：带 Origin 的跨源请求不回显 Origin、不允许 credentials', async () => {
    const { baseUrl } = await startProbeApp({
      NODE_ENV: 'production',
      API_PUBLIC_URL: 'https://api.example.com',
    });

    const crossOrigin = await httpGet(baseUrl, '/probe', {
      Origin: 'https://admin.example.com',
    });

    expect(crossOrigin.status).toBe(200);
    expect(crossOrigin.headers['access-control-allow-origin']).toBeUndefined();
    expect(crossOrigin.headers['access-control-allow-credentials']).toBeUndefined();
    expect(crossOrigin.headers['access-control-allow-methods']).toBeUndefined();
    expect(crossOrigin.headers['access-control-allow-headers']).toBeUndefined();
    // 没有 CORS 中间件时不应出现 Vary: Origin 这种「按来源协商」的痕迹
    expect(String(crossOrigin.headers['vary'] ?? '')).not.toContain('Origin');
  });
});

describe('安全响应头：真实 HTTP（开发/测试 HTTP 不得设置 HSTS）', () => {
  for (const nodeEnv of ['development', 'test'] as const) {
    it(`${nodeEnv} 档位：常量头存在、无 HSTS、JSON 响应体不受影响`, async () => {
      const { baseUrl, policy } = await startProbeApp({
        NODE_ENV: nodeEnv,
        API_PUBLIC_URL: 'https://api.example.com',
      });

      // 策略层就先断言一次：即使给了 https 地址，非生产也不启用 HSTS
      expect(policy['Strict-Transport-Security']).toBeUndefined();

      const result = await httpGet(baseUrl, '/probe', { Origin: 'https://admin.example.com' });
      expect(result.status).toBe(200);
      // JSON API 不被安全头破坏：状态码、类型与响应体原样
      expect(result.headers['content-type']).toContain('application/json');
      expect(result.body).toEqual({ ok: true });
      expect(result.headers['strict-transport-security']).toBeUndefined();
      expect(result.headers['x-content-type-options']).toBe('nosniff');
      expect(result.headers['x-frame-options']).toBe('DENY');
      expect(result.headers['referrer-policy']).toBe('no-referrer');
      expect(result.headers['permissions-policy']).toContain('camera=()');
      expect(result.headers['access-control-allow-origin']).toBeUndefined();
      expect(result.headers['access-control-allow-credentials']).toBeUndefined();
    });
  }
});

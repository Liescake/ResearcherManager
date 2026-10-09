import type { INestApplication } from '@nestjs/common';
import type { AppEnv } from '../config/env';

/**
 * API 专用安全响应头。
 *
 * 为什么自己写而不用 helmet：本切片要求**不引入新依赖**，而需要的头只有固定几个、
 * 取值全为常量（不随请求变化）。直接挂在 HTTP 适配器的中间件上，行为完全可测、可读，
 * 也避免了「框架默认值随版本漂移」这种不受本仓库控制的隐式行为。
 *
 * 覆盖范围：**所有**响应，包括 404 与异常出口 —— 中间件必须在 `app.init()`（注册路由）
 * 之前注册，Express 按注册顺序执行，先注册的中间件才会覆盖路由与内建 404 处理。
 *
 * 本模块**不做**任何跨源开放：没有 `Access-Control-Allow-*`，不回显 `Origin`，
 * 不调用 Nest 的 `enableCors()`。管理端（admin-web）独立域应按部署侧反向代理同源收敛，
 * 而不是在此开放任意跨源。
 */

/**
 * 内容安全策略：本服务只返回 JSON / 文件流，页面不需要加载**任何**外部资源，
 * 因此按「一律拒绝」的下限配置（`default-src 'none'` 会同时收敛 script/style/font/img/connect 等）。
 * `frame-ancestors 'none'` 与 `base-uri 'none'` 显式覆盖这两个不受 default-src 约束的指令。
 *
 * 只对响应的**头**生效，不改变响应体：JSON API 的解析、字段与状态码均不受影响
 * （`startup-assembly.spec.ts` 与 `security-headers.spec.ts` 用真实 HTTP 用例守住这一点）。
 */
export const CONTENT_SECURITY_POLICY =
  "default-src 'none'; frame-ancestors 'none'; base-uri 'none'";

/**
 * 最小权限禁用：本服务不提供需要浏览器能力的页面，摄像头/定位/麦克风等一律显式拒绝。
 * 使用空允许列表（`feature=()`）而不是省略：省略表示「继承默认」，显式空列表才是「禁止」。
 */
export const PERMISSIONS_POLICY =
  'accelerometer=(), camera=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), payment=(), usb=()';

/**
 * 始终设置的安全响应头（与是否启用 HSTS 无关）。
 *
 * - `X-Content-Type-Options: nosniff`：阻止浏览器按内容嗅探类型（JSON 响应被当成 HTML 执行）。
 * - `X-Frame-Options: DENY`：等价于 CSP 的 `frame-ancestors 'none'`，兼顾不认识 CSP 的旧客户端。
 * - `Referrer-Policy: no-referrer`：API 响应不追随来源信息泄露（请求方 URL / 查询串）。
 *
 * 取值全部是常量：**不从环境变量取值**，因此不存在把配置（含口令/连接串）写进响应头的路径。
 */
export const STATIC_SECURITY_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  'Content-Security-Policy': CONTENT_SECURITY_POLICY,
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Permissions-Policy': PERMISSIONS_POLICY,
});

/**
 * HSTS 取值：一年。
 *
 * 为什么**不含** `includeSubDomains` / `preload`：本项目的 API 与其它前端可能落在同一父域下的
 * 不同子域（例如 admin-web），一旦声明 `includeSubDomains`，任何尚未全量 HTTPS 的子域都会被
 * 浏览器强制拦截。这里只对**本 API 自己的主机**作出承诺，宁可少承诺也不制造部署事故。
 */
export const STRICT_TRANSPORT_SECURITY = 'max-age=31536000';

/** HSTS 的判定输入：与配置来源无关，便于单测直接构造 */
export interface SecurityHeaderPolicyInput {
  /** 生效环境档位（`AppEnv['NODE_ENV']`：development / test / production） */
  readonly nodeEnv: string;
  /** 对外公开地址（`API_PUBLIC_URL`）：仅在 production 下作为「已确认 HTTPS」的证据 */
  readonly publicUrl?: string | undefined;
}

/**
 * HSTS 只在「生产 **且** 配置明确确认 HTTPS」时设置。
 *
 * 判定依据只取 `API_PUBLIC_URL` 的协议：这是部署方**显式声明**的对外地址，
 * 是运行时唯一能拿到的「HTTPS 已就绪」证据。开发/测试（HTTP）下绝不设置，
 * 否则浏览器会把开发机的 HTTP 访问锁死，且本地 HTTP 上设置 HSTS 本身就是错误信号。
 *
 * 注意：数据库的 `DATABASE_SSL_MODE=verify-full` 是**数据库连接**的 TLS 档位，
 * 不能当作「本服务已由 HTTPS 提供」的证据，因此不参与本判定。
 */
export function shouldEnableHsts(input: SecurityHeaderPolicyInput): boolean {
  return input.nodeEnv === 'production' && isHttpsUrl(input.publicUrl);
}

function isHttpsUrl(value: string | undefined): boolean {
  if (typeof value !== 'string' || value.trim() === '') {
    return false;
  }
  try {
    return new URL(value.trim()).protocol === 'https:';
  } catch {
    // 非法 URL 一律按「未确认 HTTPS」处理（fail-safe：不设置 HSTS）
    return false;
  }
}

/** 由判定输入得出该次装配要写的完整响应头集合（纯函数，可单测） */
export function resolveSecurityHeaders(
  input: SecurityHeaderPolicyInput,
): Readonly<Record<string, string>> {
  const headers: Record<string, string> = { ...STATIC_SECURITY_HEADERS };
  if (shouldEnableHsts(input)) {
    headers['Strict-Transport-Security'] = STRICT_TRANSPORT_SECURITY;
  }
  return headers;
}

/** 响应对象的最小结构（与 `request-context.ts` 的做法一致：不依赖 express 类型） */
export interface SecurityHeaderResponseLike {
  setHeader?: (name: string, value: string) => void;
}

/** 中间件的 next 回调（不吞异常：原样透传） */
export type NextFunctionLike = (error?: unknown) => void;

/** 生成安全响应头中间件：把这些常量头写入响应后继续链路 */
export function createSecurityHeadersMiddleware(
  policy: Readonly<Record<string, string>>,
): (request: unknown, response: SecurityHeaderResponseLike, next: NextFunctionLike) => void {
  return (_request, response, next) => {
    for (const [name, value] of Object.entries(policy)) {
      // 非 Express 上下文（或已被销毁的响应）没有 setHeader：此时跳过而不是抛错，
      // 安全头是加固手段，不应把请求变成 500。
      response.setHeader?.(name, value);
    }
    next();
  };
}

/**
 * 把安全响应头装到应用上（`createApp` 的装配步骤之一，必须早于 `app.init()`）。
 * 返回实际写入的响应头集合，便于调用方/测试断言「装了什么」。
 */
export function applySecurityHeaders(
  app: INestApplication,
  env: Pick<AppEnv, 'NODE_ENV' | 'API_PUBLIC_URL'>,
): Readonly<Record<string, string>> {
  const policy = resolveSecurityHeaders({
    nodeEnv: env.NODE_ENV,
    publicUrl: env.API_PUBLIC_URL,
  });
  app.use(createSecurityHeadersMiddleware(policy));
  return policy;
}

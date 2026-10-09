import { isAbsolute } from 'node:path';
import { z } from 'zod';

/**
 * 共享数据库配置解析（PostgreSQL 持久化基础层，**不含驱动**）。
 *
 * 设计目标（fail-closed，见 docs/P2-数据约束与迁移设计.md 与 docs/P3-依赖清单与版本决策.md）：
 * - 配置非法一律抛 `DatabaseConfigError`，绝不静默降级成「无数据库」或默认凭据；
 * - 生产环境缺少 `DATABASE_URL` 直接拒绝启动（开发/测试仍允许无库启动，与 health 的
 *   `database.not_configured` 语义一致）；
 * - 远端主机默认要求 TLS；生产环境显式关闭 TLS 且主机不是回环地址时拒绝启动；
 * - 连接串中的用户名/密码永不进入日志、错误消息或 `describeDatabaseConfig` 输出。
 *
 * 本文件不 import 任何数据库驱动：ORM / 迁移工具选型（Prisma 与 TypeORM 比较，
 * 见 docs/P2-开源复用评估.md §1）尚未完成，驱动接入必须由消费方显式注册
 * （见 `ports/sql-executor.port.ts` 的「不可用工厂」）。
 */

/** 允许的连接串协议：只接受 PostgreSQL，其他协议视为配置错误 */
export const DATABASE_SCHEME_ALLOWLIST = ['postgres:', 'postgresql:'] as const;

/** 允许的 sslmode 取值（连接串查询参数口径），以及它们在本项目里的等价开关 */
export const DATABASE_SSL_MODE_ALLOWLIST = [
  'disable',
  'allow',
  'prefer',
  'require',
  'verify-ca',
  'verify-full',
] as const;

/**
 * `DATABASE_SSL_MODE` 环境变量允许的取值（**显式 TLS 档位**，与连接串的 `sslmode` 同义）。
 *
 * - `disable`：不使用 TLS（只允许本地回环 / 开发 Compose）；
 * - `require`：加密但**不校验**服务端身份（中间人可替换证书）；
 * - `verify-full`：加密 + 校验证书链与主机名（生产唯一可接受档位）。
 *
 * 为什么把 `allow` / `prefer` 排除在显式档位之外：它们是「尽量用 TLS」的宽松语义，
 * 结果取决于服务端能力，属于**不可判定**的档位；显式配置必须给出确定强度。
 */
export const DATABASE_SSL_EXPLICIT_MODE_ALLOWLIST = ['disable', 'require', 'verify-full'] as const;

export type DatabaseSslMode = 'disable' | 'require' | 'verify-full';

/** 证书文件路径（**仓库外挂载**，只存路径不存内容） */
export interface DatabaseTlsFiles {
  readonly caPath?: string;
  readonly certPath?: string;
  readonly keyPath?: string;
}

export type DatabaseConfigErrorCode =
  | 'DATABASE_URL_REQUIRED_IN_PRODUCTION'
  | 'DATABASE_URL_INVALID'
  | 'DATABASE_URL_SCHEME_UNSUPPORTED'
  | 'DATABASE_URL_INCOMPLETE'
  | 'DATABASE_SSL_MODE_UNSUPPORTED'
  | 'DATABASE_SSL_DISABLED_FOR_REMOTE_HOST'
  | 'DATABASE_TLS_NOT_VERIFIED_IN_PRODUCTION'
  | 'DATABASE_TLS_FILE_PATH_INVALID'
  | 'DATABASE_NUMERIC_OPTION_INVALID'
  | 'DATABASE_APPLICATION_NAME_INVALID';

/** 配置错误：`code` 供测试与运维判定，消息里只出现变量名与脱敏后的连接串 */
export class DatabaseConfigError extends Error {
  readonly code: DatabaseConfigErrorCode;

  constructor(code: DatabaseConfigErrorCode, message: string) {
    super(message);
    this.name = 'DatabaseConfigError';
    this.code = code;
  }
}

/** 已解析并通过校验的数据库配置（`connectionString` 属机密，禁止写入日志） */
export interface ResolvedDatabaseConfig {
  /** 原始连接串（机密：只允许交给驱动，不允许打日志） */
  readonly connectionString: string;
  readonly host: string;
  readonly port: number;
  readonly database: string;
  /** 数据库用户（内部使用；`describeDatabaseConfig` 不输出） */
  readonly user: string;
  /** TLS 档位：`disable` / `require` / `verify-full`（生产只接受 `verify-full`） */
  readonly ssl: DatabaseSslMode;
  /** TLS 证书文件路径（只存路径；证书内容由驱动在运行时读取，仓库内不写证书） */
  readonly tls: DatabaseTlsFiles;
  readonly poolMax: number;
  readonly connectTimeoutMs: number;
  readonly statementTimeoutMs: number;
  readonly applicationName: string;
  /** 已脱敏的连接串：仅用于日志与错误消息 */
  readonly redactedUrl: string;
}

/**
 * 解析结果：
 * - `configured`：拿到可用配置；
 * - `absent`：未配置，且当前环境允许无数据库启动（开发/测试）。
 * 生产环境缺少配置不会走到 `absent`，而是在解析时抛错。
 */
export type DatabaseConfigResolution =
  | { readonly status: 'configured'; readonly config: ResolvedDatabaseConfig }
  | { readonly status: 'absent'; readonly detail: string };

/**
 * 配置来源：与 `services/api/src/config/env.ts` 的 `AppEnv` 结构兼容（只取需要的键）。
 * 布尔与数值允许直接传已解析值（`AppEnv` 已把数值型配置转成 number；`DATABASE_SSL`
 * 未配置时保持 `undefined`、显式配置时为 boolean），也允许传原始字符串（测试与其他调用方）。
 * 「未配置」与「显式 false」必须区分：前者走安全默认值，后者按显式关闭 TLS 判定。
 */
export interface DatabaseConfigSource {
  readonly NODE_ENV?: string | undefined;
  readonly DATABASE_URL?: string | undefined;
  readonly DATABASE_SSL?: string | boolean | undefined;
  /** 显式 TLS 档位：disable / require / verify-full（优先于 `DATABASE_SSL` 与连接串 sslmode） */
  readonly DATABASE_SSL_MODE?: string | undefined;
  /** CA 证书文件路径（绝对路径；生产 verify-full 建议提供，用于校验证书链） */
  readonly DATABASE_SSL_CA_PATH?: string | undefined;
  /** 客户端证书文件路径（双向 TLS，可选） */
  readonly DATABASE_SSL_CERT_PATH?: string | undefined;
  /** 客户端私钥文件路径（双向 TLS，可选） */
  readonly DATABASE_SSL_KEY_PATH?: string | undefined;
  readonly DATABASE_POOL_MAX?: string | number | undefined;
  readonly DATABASE_CONNECT_TIMEOUT_MS?: string | number | undefined;
  readonly DATABASE_STATEMENT_TIMEOUT_MS?: string | number | undefined;
  readonly DATABASE_APPLICATION_NAME?: string | undefined;
}

export interface ResolveDatabaseConfigOptions {
  /** 默认 application_name（便于 DBA 在 pg_stat_activity 里定位来源） */
  readonly defaultApplicationName?: string;
  /** 视为本地回环、允许关闭 TLS 的主机（默认 localhost / 127.0.0.0-8 / ::1） */
  readonly loopbackHosts?: readonly string[];
}

const DEFAULT_APPLICATION_NAME = 'researcher-manager';
const DEFAULT_POSTGRES_PORT = 5432;
const LOOPBACK_HOSTS = ['localhost', '::1', '[::1]', '127.0.0.1'] as const;
const APPLICATION_NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,62}$/u;

/** 空字符串/纯空白视为未设置（与 services/api/src/config/env.ts 的 `emptyToUndefined` 同语义） */
function blankToUndefined(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

/** 数值型选项的预处理器：保留 number，字符串去空白，空串视为未设置 */
function emptyToUndefined(value: unknown): unknown {
  if (typeof value === 'string' && value.trim() === '') {
    return undefined;
  }
  return value;
}

/**
 * 脱敏连接串：抹掉 user:password 与可能出现在查询串里的口令参数。
 * 对无法解析的连接串也安全（正则替换，不抛错、不回显原文）。
 */
export function redactDatabaseUrl(raw: string): string {
  return raw
    .replace(/^([a-zA-Z][a-zA-Z0-9+.-]*:\/\/)[^@/]*@/u, '$1***:***@')
    .replace(/([?&](?:password|pwd|sslpassword)=)[^&#]*/giu, '$1***');
}

/** 回环主机判定：只有本地地址才允许在无 TLS 的情况下连接 */
export function isLoopbackHost(host: string, extraLoopbackHosts: readonly string[] = []): boolean {
  const normalized = host.trim().toLowerCase();
  if (normalized.startsWith('127.')) {
    return true;
  }
  return [...LOOPBACK_HOSTS, ...extraLoopbackHosts].some(
    (candidate) => candidate.trim().toLowerCase() === normalized,
  );
}

/** `DATABASE_SSL`：空串视为未配置（复制 .env.example 后不会因为空值失败），boolean 直接采用 */
function parseBooleanOption(value: string | boolean | undefined): boolean | undefined {
  if (typeof value === 'boolean') {
    return value;
  }
  const normalized = blankToUndefined(value)?.toLowerCase();
  if (normalized === undefined) {
    return undefined;
  }
  if (normalized === 'true' || normalized === '1') {
    return true;
  }
  if (normalized === 'false' || normalized === '0') {
    return false;
  }
  return undefined;
}

function resolveSslMode(
  parsed: URL,
  source: DatabaseConfigSource,
  host: string,
  extraLoopbackHosts: readonly string[],
): DatabaseSslMode {
  // 1. 显式档位优先：`DATABASE_SSL_MODE` 是唯一能表达 verify-full 的开关
  const explicitMode = blankToUndefined(source.DATABASE_SSL_MODE)?.toLowerCase();
  if (explicitMode !== undefined) {
    if (!(DATABASE_SSL_EXPLICIT_MODE_ALLOWLIST as readonly string[]).includes(explicitMode)) {
      throw new DatabaseConfigError(
        'DATABASE_SSL_MODE_UNSUPPORTED',
        `DATABASE_SSL_MODE 取值不受支持（允许: ${DATABASE_SSL_EXPLICIT_MODE_ALLOWLIST.join('/')}）`,
      );
    }
    return explicitMode as DatabaseSslMode;
  }

  // 2. 旧开关 `DATABASE_SSL`：true = 加密（require），false = 关闭
  const explicit = parseBooleanOption(source.DATABASE_SSL);
  if (explicit !== undefined) {
    return explicit ? 'require' : 'disable';
  }

  // 3. 连接串 sslmode
  const sslmode = parsed.searchParams.get('sslmode');
  if (sslmode !== null && sslmode.trim() !== '') {
    const normalized = sslmode.trim().toLowerCase();
    if (!(DATABASE_SSL_MODE_ALLOWLIST as readonly string[]).includes(normalized)) {
      throw new DatabaseConfigError(
        'DATABASE_SSL_MODE_UNSUPPORTED',
        `DATABASE_URL 的 sslmode 取值不受支持（允许: ${DATABASE_SSL_MODE_ALLOWLIST.join('/')}）`,
      );
    }
    if (normalized === 'disable' || normalized === 'allow') {
      return 'disable';
    }
    if (normalized === 'verify-ca' || normalized === 'verify-full') {
      return 'verify-full';
    }
    // prefer / require 只是「尽量用 TLS」的宽松语义，本项目按安全优先一律升级为 require
    return 'require';
  }

  // 4. 未显式配置时：本地回环不强制 TLS，远端主机默认要求 TLS（安全默认值）
  return isLoopbackHost(host, extraLoopbackHosts) ? 'disable' : 'require';
}

/**
 * 证书文件路径解析（**只存路径，不读内容**）。
 *
 * 安全约束：证书必须通过挂载卷或环境变量注入到**容器/主机上的绝对路径**；仓库只登记路径。
 * 相对路径一律拒绝 —— 相对路径意味着证书可能落在仓库工作区内，存在被提交的风险
 * （`.gitignore` 已排除 `*.pem` / `*.key`，但「不写进仓库」不能只靠忽略规则）。
 */
function resolveTlsFiles(source: DatabaseConfigSource): DatabaseTlsFiles {
  const read = (label: string, value: string | undefined): string | undefined => {
    const trimmed = blankToUndefined(value);
    if (trimmed === undefined) {
      return undefined;
    }
    if (!isAbsolute(trimmed) || trimmed.includes('\0')) {
      throw new DatabaseConfigError(
        'DATABASE_TLS_FILE_PATH_INVALID',
        `${label} 必须是绝对路径（证书由挂载卷 / 环境变量注入，不得写入仓库工作区）`,
      );
    }
    return trimmed;
  };

  const certPath = read('DATABASE_SSL_CERT_PATH', source.DATABASE_SSL_CERT_PATH);
  const keyPath = read('DATABASE_SSL_KEY_PATH', source.DATABASE_SSL_KEY_PATH);
  if ((certPath === undefined) !== (keyPath === undefined)) {
    throw new DatabaseConfigError(
      'DATABASE_TLS_FILE_PATH_INVALID',
      'DATABASE_SSL_CERT_PATH 与 DATABASE_SSL_KEY_PATH 必须成对配置（双向 TLS 需要证书与私钥）',
    );
  }

  const caPath = read('DATABASE_SSL_CA_PATH', source.DATABASE_SSL_CA_PATH);
  return {
    ...(caPath !== undefined ? { caPath } : {}),
    ...(certPath !== undefined ? { certPath } : {}),
    ...(keyPath !== undefined ? { keyPath } : {}),
  };
}

const numericOptionsSchema = z.object({
  DATABASE_POOL_MAX: z.preprocess(
    emptyToUndefined,
    z.coerce.number().int().min(1).max(100).default(10),
  ),
  DATABASE_CONNECT_TIMEOUT_MS: z.preprocess(
    emptyToUndefined,
    z.coerce.number().int().min(1000).max(60000).default(10000),
  ),
  DATABASE_STATEMENT_TIMEOUT_MS: z.preprocess(
    emptyToUndefined,
    z.coerce.number().int().min(0).max(300000).default(30000),
  ),
});

interface NumericOptions {
  readonly DATABASE_POOL_MAX: number;
  readonly DATABASE_CONNECT_TIMEOUT_MS: number;
  readonly DATABASE_STATEMENT_TIMEOUT_MS: number;
}

function resolveNumericOptions(source: DatabaseConfigSource): NumericOptions {
  const parsed = numericOptionsSchema.safeParse({
    DATABASE_POOL_MAX: source.DATABASE_POOL_MAX,
    DATABASE_CONNECT_TIMEOUT_MS: source.DATABASE_CONNECT_TIMEOUT_MS,
    DATABASE_STATEMENT_TIMEOUT_MS: source.DATABASE_STATEMENT_TIMEOUT_MS,
  });
  if (!parsed.success) {
    // 只输出变量名与规则，不输出变量值
    const issues = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ');
    throw new DatabaseConfigError(
      'DATABASE_NUMERIC_OPTION_INVALID',
      `数据库数值型配置校验失败: ${issues}`,
    );
  }
  return parsed.data;
}

function resolveApplicationName(
  source: DatabaseConfigSource,
  defaultApplicationName: string,
): string {
  const configured = blankToUndefined(source.DATABASE_APPLICATION_NAME) ?? defaultApplicationName;
  if (!APPLICATION_NAME_PATTERN.test(configured)) {
    throw new DatabaseConfigError(
      'DATABASE_APPLICATION_NAME_INVALID',
      'DATABASE_APPLICATION_NAME 必须是 1-63 位小写字母/数字/下划线/连字符，且以字母或数字开头',
    );
  }
  return configured;
}

/**
 * 解析并校验数据库配置。
 *
 * @throws DatabaseConfigError 配置非法，或生产环境缺少 `DATABASE_URL`
 */
export function resolveDatabaseConfig(
  source: DatabaseConfigSource,
  options: ResolveDatabaseConfigOptions = {},
): DatabaseConfigResolution {
  const nodeEnv = blankToUndefined(source.NODE_ENV) ?? 'development';
  const isProduction = nodeEnv === 'production';
  const rawUrl = blankToUndefined(source.DATABASE_URL);

  if (rawUrl === undefined) {
    if (isProduction) {
      throw new DatabaseConfigError(
        'DATABASE_URL_REQUIRED_IN_PRODUCTION',
        '生产环境必须配置 DATABASE_URL（PostgreSQL）：缺少时拒绝启动，禁止以内存存储顶替生产存储',
      );
    }
    return {
      status: 'absent',
      detail:
        '未配置 DATABASE_URL：仅开发/测试允许无数据库启动（health 记为 database.not_configured）',
    };
  }

  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new DatabaseConfigError(
      'DATABASE_URL_INVALID',
      `DATABASE_URL 不是合法 URL: ${redactDatabaseUrl(rawUrl)}`,
    );
  }

  if (!(DATABASE_SCHEME_ALLOWLIST as readonly string[]).includes(parsed.protocol)) {
    throw new DatabaseConfigError(
      'DATABASE_URL_SCHEME_UNSUPPORTED',
      `DATABASE_URL 协议不受支持（只允许 ${DATABASE_SCHEME_ALLOWLIST.join(' / ')}）: ${redactDatabaseUrl(rawUrl)}`,
    );
  }

  const host = parsed.hostname;
  const database = decodeURIComponent(parsed.pathname.replace(/^\/+/u, ''));
  if (host === '' || database === '') {
    throw new DatabaseConfigError(
      'DATABASE_URL_INCOMPLETE',
      `DATABASE_URL 必须同时包含主机与库名: ${redactDatabaseUrl(rawUrl)}`,
    );
  }

  const port = parsed.port === '' ? DEFAULT_POSTGRES_PORT : Number(parsed.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new DatabaseConfigError(
      'DATABASE_URL_INVALID',
      `DATABASE_URL 端口非法: ${redactDatabaseUrl(rawUrl)}`,
    );
  }

  const extraLoopbackHosts = options.loopbackHosts ?? [];
  const ssl = resolveSslMode(parsed, source, host, extraLoopbackHosts);
  const tls = resolveTlsFiles(source);
  if (isProduction) {
    // 生产 TLS 策略（fail-closed）：只接受 verify-full。
    // 显式对非回环主机关闭 TLS 保留更具体的错误码，便于定位配置来源。
    if (ssl === 'disable' && !isLoopbackHost(host, extraLoopbackHosts)) {
      throw new DatabaseConfigError(
        'DATABASE_SSL_DISABLED_FOR_REMOTE_HOST',
        '生产环境禁止对非回环主机关闭 TLS（DATABASE_SSL=false / sslmode=disable）：请启用 TLS 或改用本地回环地址',
      );
    }
    if (ssl !== 'verify-full') {
      throw new DatabaseConfigError(
        'DATABASE_TLS_NOT_VERIFIED_IN_PRODUCTION',
        `生产环境必须使用可校验身份的 TLS（DATABASE_SSL_MODE=verify-full 或 sslmode=verify-full）：当前档位为 ${ssl}，缺失配置按安全默认值处理同样拒绝启动`,
      );
    }
  }

  const numeric = resolveNumericOptions(source);
  const applicationName = resolveApplicationName(
    source,
    options.defaultApplicationName ?? DEFAULT_APPLICATION_NAME,
  );

  return {
    status: 'configured',
    config: {
      connectionString: rawUrl,
      host,
      port,
      database,
      user: decodeURIComponent(parsed.username),
      ssl,
      tls,
      poolMax: numeric.DATABASE_POOL_MAX,
      connectTimeoutMs: numeric.DATABASE_CONNECT_TIMEOUT_MS,
      statementTimeoutMs: numeric.DATABASE_STATEMENT_TIMEOUT_MS,
      applicationName,
      redactedUrl: redactDatabaseUrl(rawUrl),
    },
  };
}

/**
 * 可安全写日志的配置摘要：**不含**用户名、口令、原始连接串。
 * 未配置时只返回 `{ status: 'absent' }`，不暴露任何连接细节。
 */
export function describeDatabaseConfig(
  resolution: DatabaseConfigResolution,
): Record<string, unknown> {
  if (resolution.status === 'absent') {
    return { status: 'absent' };
  }
  const { config } = resolution;
  return {
    status: 'configured',
    host: config.host,
    port: config.port,
    database: config.database,
    ssl: config.ssl,
    // 只报告「证书是否已注入」的布尔事实：路径属于主机内部布局，不进入摘要
    tlsCaConfigured: config.tls.caPath !== undefined,
    tlsClientCertificateConfigured:
      config.tls.certPath !== undefined && config.tls.keyPath !== undefined,
    poolMax: config.poolMax,
    connectTimeoutMs: config.connectTimeoutMs,
    statementTimeoutMs: config.statementTimeoutMs,
    applicationName: config.applicationName,
    credentialsConfigured: config.user !== '',
    redactedUrl: config.redactedUrl,
  };
}

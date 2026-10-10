import { DEFAULT_AI_MAX_RESPONSE_BYTES, resolveAiEndpoint } from '@rm/ai-adapter';
import { API_PREFIX } from '@rm/shared';
import { z } from 'zod';

/**
 * 环境变量校验：启动早期失败，避免带着错误配置运行。
 * 规则：
 * - 空字符串视为「未配置」（复制 .env.example 后不会因为空值启动失败）；
 * - 真实密钥只从环境读取，不写入日志、不进入错误消息。
 */

/** 空字符串/纯空白视为未设置 */
function emptyToUndefined(value: unknown): unknown {
  if (typeof value === 'string' && value.trim() === '') {
    return undefined;
  }
  return value;
}

export const optionalSecret = z.preprocess(emptyToUndefined, z.string().min(1).optional());
export const optionalUrl = z.preprocess(
  emptyToUndefined,
  z.string().url('必须是完整 URL').optional(),
);

const booleanFromEnv = z
  .enum(['true', 'false', '1', '0'])
  .default('false')
  .transform((value) => value === 'true' || value === '1');

/**
 * 可选布尔型配置：未配置（含空串/纯空白）时是 `undefined`，而不是 `false`。
 *
 * 为什么不能用 `booleanFromEnv` 的默认值：「未配置」与「显式 false」语义不同。
 * `DATABASE_SSL` 若默认成 `false`，`@rm/db` 的 `resolveDatabaseConfig` 会把它当成
 * 「显式关闭 TLS」，从而**绕过**「远端主机未配置 TLS 时按安全默认要求 TLS / 生产环境
 * 对非回环主机关闭 TLS 一律拒绝」这条 fail-closed 规则（见
 * `src/db/config/database-config.ts` 的 `resolveSslMode`）。留作 `undefined` 后，
 * 安全默认值才能生效；显式 `false` 仍然被如实识别，并在生产环境按违规拒绝。
 */
const optionalBooleanFromEnv = z.preprocess(
  emptyToUndefined,
  z
    .enum(['true', 'false', '1', '0'])
    .transform((value) => value === 'true' || value === '1')
    .optional(),
);

/** 可选数值型配置：空串视为未配置，缺省回落到安全默认值 */
const optionalCount = (min: number, max: number, fallback: number) =>
  z.preprocess(emptyToUndefined, z.coerce.number().int().min(min).max(max).default(fallback));

/** 字段级环境变量 schema（未含跨字段的端点策略校验；对外使用下面的 `envSchema`） */
const envShape = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),

  API_HOST: z.string().min(1).default('127.0.0.1'),
  API_PORT: z.coerce.number().int('端口必须是整数').min(1).max(65535).default(3000),
  API_PREFIX: z.string().startsWith('/').default(API_PREFIX),
  API_PUBLIC_URL: optionalUrl,

  DATABASE_URL: optionalSecret,
  // 未配置时留空：由 @rm/db 按「回环不强制 TLS、远端默认要求 TLS」的安全默认值解析
  DATABASE_SSL: optionalBooleanFromEnv,
  // 显式 TLS 档位：disable / require / verify-full。
  // 生产环境只接受 verify-full（缺失按 require 的安全默认值处理，同样被拒绝启动）。
  DATABASE_SSL_MODE: z.enum(['disable', 'require', 'verify-full']).optional(),
  // TLS 证书**路径**（绝对路径；证书内容必须由挂载卷 / 环境变量注入，禁止写入仓库工作区）
  DATABASE_SSL_CA_PATH: optionalSecret,
  DATABASE_SSL_CERT_PATH: optionalSecret,
  DATABASE_SSL_KEY_PATH: optionalSecret,
  // PostgreSQL 连接池与超时（由 @rm/db 的共享配置解析再校验一次；此处先做启动期快速失败）
  DATABASE_POOL_MAX: optionalCount(1, 100, 10),
  DATABASE_CONNECT_TIMEOUT_MS: optionalCount(1000, 60000, 10000),
  DATABASE_STATEMENT_TIMEOUT_MS: optionalCount(0, 300000, 30000),
  // 写入连接 application_name，便于 DBA 在 pg_stat_activity 中定位来源
  DATABASE_APPLICATION_NAME: optionalSecret,
  // ---------------------------------------------------------------------------
  // 执行器 attest 取证事实（由**运维 / CI 显式提供**，代码绝不生成「已验证」）
  // 缺任何一项 ⇒ 拿不到封存声明 ⇒ 数据库已配置时启动 fail-closed。
  //
  // 这组字段同时是一份**类型契约**：`db/database.module.ts` 把解析出的 env 对象直接交给
  // `resolvePostgresAttestationRegistration(env)`，其形参类型是 `PostgresAttestationSource`
  // （见 `db/postgres/postgres-attestation.ts`）。两边字段名必须逐一对应 —— 此处少一个字段，
  // 纯净检出就会在 `db/database.module.ts` 的调用点报「类型不兼容」。
  // ---------------------------------------------------------------------------
  DATABASE_EXECUTOR_EVIDENCE_ID: optionalSecret,
  DATABASE_EXECUTOR_VERIFIED_BY: optionalSecret,
  DATABASE_EXECUTOR_VERIFIED_AT: optionalSecret,
  DATABASE_EXECUTOR_EVIDENCE_REF: optionalSecret,
  // 验证方式：空串/纯空白同样视为未配置（与本文件顶部规则一致）；允许取值是**闭集**，
  // 非法取值直接拒绝启动，避免把任意文本当成「验证方式」带进证据。
  DATABASE_EXECUTOR_EVIDENCE_METHOD: z.preprocess(
    emptyToUndefined,
    z.enum(['integration-test', 'contract-test', 'manual-review']).optional(),
  ),
  DATABASE_SCHEMA_READINESS_ID: optionalSecret,
  DATABASE_SCHEMA_CHECKED_BY: optionalSecret,
  DATABASE_SCHEMA_CHECKED_AT: optionalSecret,
  DATABASE_SCHEMA_READINESS_REF: optionalSecret,
  // 迁移版本事实（CSV，升序）：代码侧可用版本与数据库侧已应用版本，必须由取证方核对后给出
  DATABASE_MIGRATION_AVAILABLE_VERSIONS: optionalSecret,
  DATABASE_MIGRATION_APPLIED_VERSIONS: optionalSecret,
  // 迁移 CLI 的可选覆盖（默认 <repo>/db/migrations）
  DATABASE_MIGRATIONS_DIR: optionalSecret,
  DATABASE_MIGRATION_APPLIED_BY: optionalSecret,

  SESSION_SECRET: optionalSecret,

  WECHAT_MINIAPP_APP_ID: optionalSecret,
  WECHAT_MINIAPP_APP_SECRET: optionalSecret,

  AI_PROVIDER: z.enum(['mock', 'http-json', 'disabled']).default('mock'),
  AI_BASE_URL: optionalUrl,
  AI_API_KEY: optionalSecret,
  AI_MODEL: optionalSecret,
  /**
   * 显式受信主机 allowlist（逗号分隔，精确匹配；不支持通配符）。
   * 只有在运维**明确**要访问本机/内网网关时才配置；它只放宽「主机安全」与「端口范围」判定，
   * 不放宽协议、userinfo、query、hash 等结构约束（见 `@rm/ai-adapter` 的 `resolveAiEndpoint`）。
   */
  AI_TRUSTED_HOSTS: optionalSecret,
  /** 模型响应体硬上限（字节）：超过即按安全 ProviderError 降级，不做 JSON 解析 */
  AI_MAX_RESPONSE_BYTES: optionalCount(1024, 16_777_216, DEFAULT_AI_MAX_RESPONSE_BYTES),
  AI_TIMEOUT_MS: z.coerce.number().int().min(100).max(60000).default(8000),
  AI_MAX_RETRIES: z.coerce.number().int().min(0).max(5).default(1),
  AI_MATCHING_ENABLED: booleanFromEnv,

  EXPORT_FILE_TTL_MINUTES: z.coerce.number().int().min(5).max(1440).default(60),
  EXPORT_MAX_ROWS: z.coerce.number().int().min(1).max(1_000_000).default(50000),
});

/**
 * 生产环境出站是否**必须**走 TLS。
 *
 * 触发条件与 provider 装配的条件**逐字对齐**（见
 * `src/modules/matching/matching.ai-provider.ts` 的 `createMatchingAiProvider` /
 * `isMatchingEnabled`）：只有「NODE_ENV=production」且「匹配开关已打开」且
 * 「AI_PROVIDER=http-json」三者同时成立时才会真的向外部模型服务发出请求，
 * 此时明文 http 会把模型提示词与 `Authorization: Bearer <key>` 一起暴露在同链路上。
 *
 * 刻意**不**依赖 NODE_ENV 以外的任何未定义配置（如代理、附加开关）：
 * 关闭 / mock provider 与开发、测试环境语义完全不变（`AI_TRUSTED_HOSTS` 允许的
 * 本机 / 内网 http 网关在非生产环境仍然放行）。
 */
function requiresHttpsAiEndpoint(value: {
  readonly NODE_ENV: 'development' | 'test' | 'production';
  readonly AI_PROVIDER: 'mock' | 'http-json' | 'disabled';
  readonly AI_MATCHING_ENABLED: boolean;
}): boolean {
  return (
    value.NODE_ENV === 'production' &&
    value.AI_MATCHING_ENABLED &&
    value.AI_PROVIDER === 'http-json'
  );
}

/**
 * 完整环境变量 schema：在字段级校验之上追加 AI 出站端点的启动期安全校验，
 * 与 provider 侧复用**同一份**判定逻辑，避免「启动放行、运行拒绝」或反向的偏差。
 *
 * 两条规则（都只增补 `AI_BASE_URL` 的 issue，消息**只描述规则**，不回显 URL / key）：
 * 1. 端点字面量安全校验（协议白名单、userinfo / query / hash、主机与端口）；
 * 2. 生产环境的 `http-json` + 匹配开启（即真的会出站）时，**只接受 `https:`**，
 *    明文 `http` fail-closed 拒绝启动。
 */
export const envSchema = envShape.superRefine((value, ctx) => {
  if (value.AI_BASE_URL === undefined) {
    return;
  }
  const resolution = resolveAiEndpoint(value.AI_BASE_URL, {
    trustedHosts: value.AI_TRUSTED_HOSTS,
  });
  if (!resolution.ok) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['AI_BASE_URL'],
      message: resolution.message,
    });
    // 字面量本身已不合规：不再追加 TLS 判定，避免同一处配置出现互相矛盾的提示
    return;
  }
  if (requiresHttpsAiEndpoint(value) && resolution.endpoint.protocol !== 'https:') {
    // 只写变量名与规则，绝不回显取值（取值可能含主机名、端口乃至凭据）
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['AI_BASE_URL'],
      message:
        '生产环境（NODE_ENV=production）在匹配开启且 AI_PROVIDER=http-json 时必须使用 https 端点；明文 http 会把模型请求与 API key 暴露在同链路上，已按 fail-closed 拒绝',
    });
  }
});

export type AppEnv = z.infer<typeof envSchema>;

export function loadEnv(source: NodeJS.ProcessEnv | Record<string, unknown> = process.env): AppEnv {
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    // 只输出变量名与规则，不输出变量值（可能是密钥）
    const issues = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ');
    throw new Error(`环境变量校验失败: ${issues}`);
  }
  return parsed.data;
}

/** 生成可安全写日志的配置摘要（不含任何密钥） */
export function describeEnv(env: AppEnv): Record<string, unknown> {
  return {
    nodeEnv: env.NODE_ENV,
    apiPort: env.API_PORT,
    apiPrefix: env.API_PREFIX,
    databaseConfigured: Boolean(env.DATABASE_URL),
    aiProvider: env.AI_PROVIDER,
    aiMatchingEnabled: env.AI_MATCHING_ENABLED,
  };
}

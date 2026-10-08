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

export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),

  API_HOST: z.string().min(1).default('127.0.0.1'),
  API_PORT: z.coerce.number().int('端口必须是整数').min(1).max(65535).default(3000),
  API_PREFIX: z.string().startsWith('/').default(API_PREFIX),
  API_PUBLIC_URL: optionalUrl,

  DATABASE_URL: optionalSecret,
  DATABASE_SSL: booleanFromEnv,

  SESSION_SECRET: optionalSecret,

  WECHAT_MINIAPP_APP_ID: optionalSecret,
  WECHAT_MINIAPP_APP_SECRET: optionalSecret,

  AI_PROVIDER: z.enum(['mock', 'http-json', 'disabled']).default('mock'),
  AI_BASE_URL: optionalUrl,
  AI_API_KEY: optionalSecret,
  AI_MODEL: optionalSecret,
  AI_TIMEOUT_MS: z.coerce.number().int().min(100).max(60000).default(8000),
  AI_MAX_RETRIES: z.coerce.number().int().min(0).max(5).default(1),
  AI_MATCHING_ENABLED: booleanFromEnv,

  EXPORT_FILE_TTL_MINUTES: z.coerce.number().int().min(5).max(1440).default(60),
  EXPORT_MAX_ROWS: z.coerce.number().int().min(1).max(1_000_000).default(50000),
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

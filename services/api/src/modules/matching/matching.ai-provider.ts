import { createHttpJsonProvider, createMockProvider } from '@rm/ai-adapter';
import type { AiProvider } from '@rm/ai-adapter';
import type { AppEnv } from '../../config/env';

/**
 * 匹配 provider 装配：把**已校验配置**翻译成 `@rm/ai-adapter` 的 `AiProvider` 端口实现。
 *
 * - `AI_PROVIDER=http-json` 且匹配开关打开时必须配置 `AI_BASE_URL`，否则**启动即失败**
 *   （配置错误不允许退化成「悄悄用桩 provider」）；
 * - 其余情况（`mock` / `disabled` / 开关关闭）绑定本地桩 provider：
 *   开关关闭时 `matchingEnabled = false`，适配层**不会**调用 provider，
 *   而是走明确的规则降级路径（`matching.service.ts`）；
 * - 本函数不读 `process.env`：配置只经 `APP_ENV` 令牌注入。
 *
 * 密钥只交给 provider 内部作为请求头使用，不写日志、不进入错误消息、不出现在响应里。
 */
export function createMatchingAiProvider(env: AppEnv): AiProvider {
  if (env.AI_PROVIDER === 'http-json' && isMatchingEnabled(env)) {
    if (!env.AI_BASE_URL) {
      throw new Error('AI_PROVIDER=http-json 且匹配已开启时必须配置 AI_BASE_URL');
    }
    return createHttpJsonProvider({
      baseUrl: env.AI_BASE_URL,
      ...(env.AI_API_KEY ? { apiKey: env.AI_API_KEY } : {}),
      model: env.AI_MODEL ?? 'default',
    });
  }
  return createMockProvider();
}

/**
 * 匹配功能开关：**只有**同时满足「配置里显式打开」与「provider 不是 disabled」才调用模型。
 * 任一条不满足都走规则降级，因此「AI disabled 时行为明确」不是靠 provider 报错兜底。
 */
export function isMatchingEnabled(env: AppEnv): boolean {
  return env.AI_MATCHING_ENABLED && env.AI_PROVIDER !== 'disabled';
}

/** 写入 ai_match_records.model_version 的版本标识：未配置模型名时回落为 provider 标识 */
export function resolveModelVersion(env: AppEnv, provider: AiProvider): string {
  return env.AI_MODEL ?? provider.id;
}

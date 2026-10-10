import { describe, expect, it } from 'vitest';
import { AiAdapterError } from '@rm/ai-adapter';
import { loadEnv, type AppEnv } from '../../config/env';
import {
  createMatchingAiProvider,
  isMatchingEnabled,
  resolveModelVersion,
} from './matching.ai-provider';

describe('匹配 provider 装配与端点安全策略', () => {
  it('未配置 AI_BASE_URL 时启动即失败（不允许悄悄退回桩 provider）', () => {
    const env = loadEnv({ AI_PROVIDER: 'http-json', AI_MATCHING_ENABLED: 'true' });
    expect(() => createMatchingAiProvider(env)).toThrowError(/AI_BASE_URL/u);
  });

  it('provider 侧对 baseUrl 再校验一次：未受信的本机地址被拒绝（纵深防御）', () => {
    // env 层已会拒绝；这里构造绕过 env 校验的 AppEnv，证明 provider 侧不是唯一防线
    const env = {
      ...loadEnv({ AI_PROVIDER: 'http-json', AI_MATCHING_ENABLED: 'true' }),
      AI_BASE_URL: 'http://127.0.0.1:11434/v1',
    } as AppEnv;
    expect(() => createMatchingAiProvider(env)).toThrowError(AiAdapterError);
  });

  it('显式受信主机放行本机网关，并透传响应体上限与模型名', () => {
    const env = loadEnv({
      AI_PROVIDER: 'http-json',
      AI_MATCHING_ENABLED: 'true',
      AI_BASE_URL: 'http://127.0.0.1:11434/v1',
      AI_TRUSTED_HOSTS: '127.0.0.1',
      AI_MAX_RESPONSE_BYTES: '4096',
      AI_MODEL: 'local-model',
    });
    const provider = createMatchingAiProvider(env);
    expect(provider.id).toBe('http-json');
    expect(resolveModelVersion(env, provider)).toBe('local-model');
  });

  it('mock / disabled 与开关矩阵保持既有语义', () => {
    expect(createMatchingAiProvider(loadEnv({})).id).toBe('mock');
    const disabled = loadEnv({ AI_PROVIDER: 'disabled', AI_MATCHING_ENABLED: 'true' });
    expect(isMatchingEnabled(disabled)).toBe(false);
    expect(createMatchingAiProvider(disabled).id).toBe('mock');
  });
});

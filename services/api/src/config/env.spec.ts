import { describe, expect, it } from 'vitest';
import { describeEnv, loadEnv } from './env';

describe('环境变量校验', () => {
  it('全部缺省时也能启动（P3 骨架允许无数据库）', () => {
    const env = loadEnv({});
    expect(env.NODE_ENV).toBe('development');
    expect(env.API_HOST).toBe('127.0.0.1');
    expect(env.API_PORT).toBe(3000);
    expect(env.API_PREFIX).toBe('/api/v1');
    expect(env.DATABASE_URL).toBeUndefined();
    expect(env.AI_PROVIDER).toBe('mock');
    expect(env.AI_MATCHING_ENABLED).toBe(false);
    expect(env.AI_TIMEOUT_MS).toBe(8000);
    expect(env.EXPORT_FILE_TTL_MINUTES).toBe(60);
  });

  it('空字符串视为未配置（复制 .env.example 后不会启动失败）', () => {
    const env = loadEnv({
      DATABASE_URL: '',
      AI_BASE_URL: '   ',
      AI_API_KEY: '',
      SESSION_SECRET: '',
    });
    expect(env.DATABASE_URL).toBeUndefined();
    expect(env.AI_BASE_URL).toBeUndefined();
    expect(env.AI_API_KEY).toBeUndefined();
    expect(env.SESSION_SECRET).toBeUndefined();
  });

  it('字符串数值与布尔值被正确转换', () => {
    const env = loadEnv({
      API_PORT: '8080',
      AI_MATCHING_ENABLED: 'true',
      AI_TIMEOUT_MS: '15000',
      DATABASE_SSL: 'true',
    });
    expect(env.API_PORT).toBe(8080);
    expect(env.AI_MATCHING_ENABLED).toBe(true);
    expect(env.AI_TIMEOUT_MS).toBe(15000);
    expect(env.DATABASE_SSL).toBe(true);
  });

  it('非法配置直接失败，且错误信息不回显变量原值', () => {
    expect(() => loadEnv({ API_PORT: '70000' })).toThrowError(/环境变量校验失败/u);
    expect(() => loadEnv({ API_PREFIX: 'api/v1' })).toThrowError(/环境变量校验失败/u);
    expect(() => loadEnv({ AI_PROVIDER: 'unknown-provider' })).toThrowError(/环境变量校验失败/u);

    try {
      loadEnv({ AI_BASE_URL: 'not-a-url-value' });
      expect.unreachable('应当抛出环境变量校验错误');
    } catch (error) {
      expect((error as Error).message).not.toContain('not-a-url-value');
    }
  });

  it('日志摘要只包含开关与布尔状态，不含任何密钥', () => {
    const env = loadEnv({
      DATABASE_URL: 'postgresql://postgres:sup3rsecret@127.0.0.1:5432/researcher_manager',
      AI_API_KEY: 'sk-sup3rsecret',
      SESSION_SECRET: 'sup3rsecret-session-key-value',
      AI_MATCHING_ENABLED: 'true',
    });
    const summary = JSON.stringify(describeEnv(env));
    expect(summary).not.toContain('sup3rsecret');
    expect(summary).toContain('"databaseConfigured":true');
    expect(summary).toContain('"aiMatchingEnabled":true');
  });
});

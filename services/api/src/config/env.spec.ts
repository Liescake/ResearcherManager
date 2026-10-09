import { describe, expect, it } from 'vitest';
import type { PostgresAttestationSource } from '../db/postgres/postgres-attestation';
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

  it('DATABASE_SSL 未配置时保持 undefined：安全默认值由 @rm/db 决定（远端默认要求 TLS）', () => {
    expect(loadEnv({}).DATABASE_SSL).toBeUndefined();
    // 空串同样视为未配置，不会退化成「显式关闭 TLS」
    expect(loadEnv({ DATABASE_SSL: '' }).DATABASE_SSL).toBeUndefined();
    expect(loadEnv({ DATABASE_SSL: 'false' }).DATABASE_SSL).toBe(false);
    expect(loadEnv({ DATABASE_SSL: '1' }).DATABASE_SSL).toBe(true);
  });

  it('执行器取证事实：未配置与空串都视为未提供（代码绝不生成「已验证」）', () => {
    const empty = loadEnv({});
    expect(empty.DATABASE_EXECUTOR_EVIDENCE_ID).toBeUndefined();
    expect(empty.DATABASE_EXECUTOR_VERIFIED_AT).toBeUndefined();
    expect(empty.DATABASE_EXECUTOR_EVIDENCE_METHOD).toBeUndefined();
    expect(empty.DATABASE_MIGRATION_APPLIED_VERSIONS).toBeUndefined();

    // 复制 .env.example 后留空（含纯空白）不得退化成「已取证」，也不得让启动失败
    const blank = loadEnv({
      DATABASE_EXECUTOR_EVIDENCE_ID: '',
      DATABASE_EXECUTOR_VERIFIED_BY: '   ',
      DATABASE_EXECUTOR_EVIDENCE_METHOD: '',
      DATABASE_MIGRATION_AVAILABLE_VERSIONS: '',
    });
    expect(blank.DATABASE_EXECUTOR_EVIDENCE_ID).toBeUndefined();
    expect(blank.DATABASE_EXECUTOR_VERIFIED_BY).toBeUndefined();
    expect(blank.DATABASE_EXECUTOR_EVIDENCE_METHOD).toBeUndefined();
    expect(blank.DATABASE_MIGRATION_AVAILABLE_VERSIONS).toBeUndefined();
  });

  it('执行器取证事实：按原样透传，且验证方式只接受闭集内的取值', () => {
    const env = loadEnv({
      DATABASE_EXECUTOR_EVIDENCE_ID: 'ev-1',
      DATABASE_EXECUTOR_VERIFIED_AT: '2026-01-01T00:00:00Z',
      DATABASE_EXECUTOR_EVIDENCE_METHOD: 'integration-test',
      DATABASE_MIGRATION_AVAILABLE_VERSIONS: '0001,0002',
    });
    expect(env.DATABASE_EXECUTOR_EVIDENCE_ID).toBe('ev-1');
    expect(env.DATABASE_EXECUTOR_VERIFIED_AT).toBe('2026-01-01T00:00:00Z');
    expect(env.DATABASE_EXECUTOR_EVIDENCE_METHOD).toBe('integration-test');
    expect(env.DATABASE_MIGRATION_AVAILABLE_VERSIONS).toBe('0001,0002');

    expect(() => loadEnv({ DATABASE_EXECUTOR_EVIDENCE_METHOD: '自述已验证' })).toThrowError(
      /环境变量校验失败/u,
    );
  });

  it('AppEnv 可直接作为 PostgreSQL 取证来源（编译期契约：字段缺失即 API typecheck 失败）', () => {
    // 这里就是 db/database.module.ts 的调用形状：把 env 直接交给取证解析（见 393 行附近）。
    const source: PostgresAttestationSource = loadEnv({});
    expect(source.DATABASE_EXECUTOR_EVIDENCE_ID).toBeUndefined();
    expect(source.DATABASE_SCHEMA_READINESS_ID).toBeUndefined();
    expect(source.DATABASE_MIGRATION_APPLIED_VERSIONS).toBeUndefined();
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

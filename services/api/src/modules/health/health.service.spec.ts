import { describe, expect, it } from 'vitest';
import { loadEnv } from '../../config/env';
import { SERVICE_NAME, SERVICE_VERSION, HealthService } from './health.service';

const readyEnv = loadEnv({
  DATABASE_URL: 'postgresql://postgres:postgres@127.0.0.1:5432/researcher_manager',
  SESSION_SECRET: 'a'.repeat(48),
  AI_MATCHING_ENABLED: 'true',
  AI_PROVIDER: 'http-json',
});

describe('健康检查', () => {
  it('返回服务名、版本、统一前缀与时间戳', () => {
    const service = new HealthService(readyEnv);
    const payload = service.getHealth(new Date('2026-01-01T00:00:00.000Z'));

    expect(payload.status).toBe('ok');
    expect(payload.service).toBe(SERVICE_NAME);
    expect(payload.version).toBe(SERVICE_VERSION);
    expect(payload.prefix).toBe('/api/v1');
    expect(payload.timestamp).toBe('2026-01-01T00:00:00.000Z');
    expect(payload.uptimeSeconds).toBeGreaterThanOrEqual(0);
  });

  it('缺少数据库或密钥时标记 degraded，而不是假装就绪', () => {
    const service = new HealthService(loadEnv({}));
    const payload = service.getReadiness();

    expect(payload.status).toBe('degraded');
    expect(payload.checks.find((check) => check.name === 'database')?.status).toBe(
      'not_configured',
    );
    expect(payload.checks.find((check) => check.name === 'sessionSecret')?.status).toBe(
      'not_configured',
    );
  });

  it('配置齐全且 AI 匹配开启时报告 ready', () => {
    const service = new HealthService(readyEnv);
    const payload = service.getReadiness();

    expect(payload.status).toBe('ready');
    expect(payload.checks.every((check) => check.status === 'ok')).toBe(true);
  });

  it('健康输出不泄露连接串与密钥', () => {
    const service = new HealthService(readyEnv);
    const serialized = `${JSON.stringify(service.getHealth())}${JSON.stringify(service.getReadiness())}`;

    expect(serialized).not.toContain('postgres:postgres');
    expect(serialized).not.toContain('a'.repeat(48));
  });
});

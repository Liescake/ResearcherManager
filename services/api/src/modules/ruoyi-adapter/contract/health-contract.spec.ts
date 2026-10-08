import { describe, expect, it } from 'vitest';
import { loadEnv } from '../../../config/env';
import { HealthService } from '../../health/health.service';
import {
  HEALTH_CONTRACT_SLICE,
  HEALTH_CONTRACT_VERSION,
  HEALTH_READINESS_CHECK_NAMES,
  checkHealthDataAgainstContract,
  checkReadinessDataAgainstContract,
  expectedReadinessStatus,
} from './health-contract';

/**
 * 契约符合性回归：断言 NestJS 基线的真实 /health 与 /health/ready 业务数据
 * 满足 services/ruoyi-api/contracts/health.openapi.yaml 的字段与取值约束。
 *
 * 契约文件本身由 services/ruoyi-api/contracts/validate.mjs 校验（YAML + $ref + x-boundary）；
 * 这里补的是它无法覆盖的一侧：运行时响应是否真的符合契约。
 */

const degradedEnv = loadEnv({});
const readyEnv = loadEnv({
  DATABASE_URL: 'postgresql://postgres:postgres@127.0.0.1:5432/researcher_manager',
  SESSION_SECRET: 'a'.repeat(48),
  AI_MATCHING_ENABLED: 'true',
  AI_PROVIDER: 'http-json',
});

/** 契约版本与边界标识必须与 health.openapi.yaml 的 x-boundary 一致 */
describe('health 契约边界声明', () => {
  it('声明的契约版本与切片标识符合边界约定', () => {
    expect(HEALTH_CONTRACT_VERSION).toMatch(/^\d+\.\d+\.\d+$/u);
    expect(HEALTH_CONTRACT_SLICE).toBe('health');
  });

  it('就绪巡检项闭集与 health.service 的实现保持一致', () => {
    const service = new HealthService(degradedEnv);
    const names = service.getReadiness().checks.map((check) => check.name);
    expect([...names].sort()).toEqual([...HEALTH_READINESS_CHECK_NAMES].sort());
  });
});

describe('GET /health 响应符合契约', () => {
  it('degraded 与 ready 两种配置下都满足字段与取值约束', () => {
    for (const env of [degradedEnv, readyEnv]) {
      const payload = new HealthService(env).getHealth(new Date('2026-01-01T00:00:00.000Z'));
      expect(checkHealthDataAgainstContract(payload)).toEqual([]);
    }
  });

  it('拒绝契约未声明的额外字段（additionalProperties: false）', () => {
    const payload = new HealthService(degradedEnv).getHealth();
    const withExtra = { ...payload, internalAddress: '10.0.0.1:5432' };
    expect(checkHealthDataAgainstContract(withExtra)).toEqual([
      expect.objectContaining({ kind: 'unexpected', path: 'data.internalAddress' }),
    ]);
  });

  it('拒绝非法 semver 与非 ISO 时间戳', () => {
    const payload = new HealthService(degradedEnv).getHealth();
    expect(checkHealthDataAgainstContract({ ...payload, version: '0.1' })).toEqual([
      expect.objectContaining({ kind: 'invalid', path: 'data.version' }),
    ]);
    expect(
      checkHealthDataAgainstContract({ ...payload, timestamp: '2026-01-01 00:00:00' }),
    ).toEqual([expect.objectContaining({ kind: 'invalid', path: 'data.timestamp' })]);
  });

  it('缺失必需字段时报告 missing 而不是静默通过', () => {
    const { prefix: _prefix, ...withoutPrefix } = new HealthService(degradedEnv).getHealth();
    expect(checkHealthDataAgainstContract(withoutPrefix)).toEqual([
      expect.objectContaining({ kind: 'missing', path: 'data.prefix' }),
    ]);
  });
});

describe('GET /health/ready 响应符合契约', () => {
  it('degraded 与 ready 两种形态都满足字段与取值约束', () => {
    for (const env of [degradedEnv, readyEnv]) {
      const payload = new HealthService(env).getReadiness();
      expect(checkReadinessDataAgainstContract(payload)).toEqual([]);
    }
  });

  it('status 与逐项 checks 保持一致（ready ⇔ 全部 ok）', () => {
    for (const env of [degradedEnv, readyEnv]) {
      const payload = new HealthService(env).getReadiness();
      expect(payload.status).toBe(expectedReadinessStatus(payload.checks));
    }
    expect(new HealthService(degradedEnv).getReadiness().status).toBe('degraded');
    expect(new HealthService(readyEnv).getReadiness().status).toBe('ready');
  });

  it('拒绝契约闭集之外的巡检项名称', () => {
    const payload = new HealthService(degradedEnv).getReadiness();
    const withUnknownCheck = {
      ...payload,
      checks: [...payload.checks, { name: 'redis', status: 'ok' }],
    };
    expect(checkReadinessDataAgainstContract(withUnknownCheck)).toEqual([
      expect.objectContaining({ kind: 'invalid', path: 'data.checks[3].name' }),
    ]);
  });

  it('拒绝空的 checks 与未声明的检查项字段', () => {
    const payload = new HealthService(degradedEnv).getReadiness();
    expect(checkReadinessDataAgainstContract({ ...payload, checks: [] })).toEqual([
      expect.objectContaining({ kind: 'invalid', path: 'data.checks' }),
    ]);
    expect(
      checkReadinessDataAgainstContract({
        ...payload,
        checks: [{ name: 'database', status: 'ok', host: 'db' }],
      }),
    ).toEqual([expect.objectContaining({ kind: 'unexpected', path: 'data.checks[0].host' })]);
  });
});

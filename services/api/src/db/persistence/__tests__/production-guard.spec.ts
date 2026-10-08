import { describe, expect, it } from 'vitest';
import type { PersistenceCapabilities } from '../../ports/sql-executor.port';
import {
  assertPersistenceBoundary,
  evaluatePersistenceBoundary,
  PersistenceBoundaryError,
  type PersistenceBinding,
} from '../production-guard';

const IN_MEMORY: PersistenceCapabilities = {
  backend: 'in-memory-baseline',
  persistent: false,
  productionReady: false,
};

/** 未验证的 Postgres 实现：持久但尚未通过验证，生产环境必须同样被拦下 */
const POSTGRES_UNVERIFIED: PersistenceCapabilities = {
  backend: 'postgres-draft',
  persistent: true,
  productionReady: false,
};

const POSTGRES_VERIFIED: PersistenceCapabilities = {
  backend: 'postgres',
  persistent: true,
  productionReady: true,
};

function binding(token: string, capabilities?: PersistenceCapabilities): PersistenceBinding {
  return capabilities === undefined
    ? { token, label: `${token} 的绑定` }
    : { token, label: `${token} 的绑定`, capabilities };
}

describe('evaluatePersistenceBoundary：开发/测试不因内存基线失败', () => {
  it('非生产环境放行内存基线，并报告已检查的端口', () => {
    const report = evaluatePersistenceBoundary({
      nodeEnv: 'test',
      databaseConfigured: false,
      bindings: [binding('GROUP_REPOSITORY', IN_MEMORY), binding('AUDIT_REPOSITORY', IN_MEMORY)],
    });
    expect(report.ok).toBe(true);
    expect(report.violations).toEqual([]);
    expect(report.checkedTokens).toEqual(['GROUP_REPOSITORY', 'AUDIT_REPOSITORY']);
  });

  it('能力声明缺失在任何环境都是代码缺陷（不能等到生产才暴露）', () => {
    const report = evaluatePersistenceBoundary({
      nodeEnv: 'test',
      databaseConfigured: true,
      bindings: [binding('GROUP_REPOSITORY')],
    });
    expect(report.ok).toBe(false);
    expect(report.violations.map((item) => item.rule)).toEqual(['MISSING_CAPABILITIES']);
  });

  it('backend 标识为空时判 BACKEND_NOT_DECLARED', () => {
    const report = evaluatePersistenceBoundary({
      nodeEnv: 'test',
      databaseConfigured: true,
      bindings: [
        binding('GROUP_REPOSITORY', { backend: '  ', persistent: true, productionReady: true }),
      ],
    });
    expect(report.violations.map((item) => item.rule)).toEqual(['BACKEND_NOT_DECLARED']);
  });
});

describe('evaluatePersistenceBoundary：生产环境 fail-closed', () => {
  it('内存基线在生产环境判违规（禁止把内存实现当生产存储）', () => {
    const report = evaluatePersistenceBoundary({
      nodeEnv: 'production',
      databaseConfigured: true,
      bindings: [binding('GROUP_REPOSITORY', IN_MEMORY)],
    });
    expect(report.ok).toBe(false);
    expect(report.violations).toEqual([
      {
        rule: 'IN_MEMORY_BACKEND_IN_PRODUCTION',
        token: 'GROUP_REPOSITORY',
        detail: expect.stringContaining('in-memory-baseline'),
      },
    ]);
  });

  it('未验证的 Postgres 实现同样判违规（禁止切换到未验证数据库）', () => {
    const report = evaluatePersistenceBoundary({
      nodeEnv: 'production',
      databaseConfigured: true,
      bindings: [binding('GROUP_REPOSITORY', POSTGRES_UNVERIFIED)],
    });
    expect(report.violations.map((item) => item.rule)).toEqual([
      'BACKEND_NOT_PRODUCTION_READY_IN_PRODUCTION',
    ]);
    expect(report.violations[0]?.detail).toContain('postgres-draft');
  });

  it('生产环境未配置 DATABASE_URL 时判配置 fail-closed', () => {
    const report = evaluatePersistenceBoundary({
      nodeEnv: 'production',
      databaseConfigured: false,
      bindings: [binding('GROUP_REPOSITORY', POSTGRES_VERIFIED)],
    });
    expect(report.ok).toBe(false);
    expect(report.violations.map((item) => item.rule)).toEqual([
      'DATABASE_NOT_CONFIGURED_IN_PRODUCTION',
    ]);
    expect(report.violations[0]?.token).toBe('DATABASE_CONFIG');
  });

  it('全部绑定持久且生产可用、且已配置数据库时通过', () => {
    const report = evaluatePersistenceBoundary({
      nodeEnv: 'production',
      databaseConfigured: true,
      bindings: [binding('GROUP_REPOSITORY', POSTGRES_VERIFIED)],
    });
    expect(report).toEqual({
      ok: true,
      violations: [],
      checkedTokens: ['GROUP_REPOSITORY'],
    });
  });
});

describe('assertPersistenceBoundary：抛出可定位且不含机密的错误', () => {
  it('违规时抛 PersistenceBoundaryError，列出全部违规端口与规则', () => {
    let captured: unknown;
    try {
      assertPersistenceBoundary({
        nodeEnv: 'production',
        databaseConfigured: false,
        bindings: [binding('GROUP_REPOSITORY', IN_MEMORY), binding('AUDIT_REPOSITORY', IN_MEMORY)],
      });
    } catch (error) {
      captured = error;
    }

    expect(captured).toBeInstanceOf(PersistenceBoundaryError);
    const boundaryError = captured as PersistenceBoundaryError;
    expect(boundaryError.violations).toHaveLength(3);
    expect(boundaryError.message).toContain('GROUP_REPOSITORY[IN_MEMORY_BACKEND_IN_PRODUCTION]');
    expect(boundaryError.message).toContain('AUDIT_REPOSITORY[IN_MEMORY_BACKEND_IN_PRODUCTION]');
    expect(boundaryError.message).toContain(
      'DATABASE_CONFIG[DATABASE_NOT_CONFIGURED_IN_PRODUCTION]',
    );
    // 边界错误只承载端口名/后端名，永不携带连接串或口令
    expect(boundaryError.message).not.toContain('postgresql://');
    expect(boundaryError.message).not.toContain('@');
  });

  it('通过时返回报告，不抛错', () => {
    const report = assertPersistenceBoundary({
      nodeEnv: 'production',
      databaseConfigured: true,
      bindings: [binding('GROUP_REPOSITORY', POSTGRES_VERIFIED)],
    });
    expect(report.ok).toBe(true);
  });
});

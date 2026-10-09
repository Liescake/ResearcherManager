import { describe, expect, it } from 'vitest';
import {
  createSqlExecutorVerificationRegistry,
  type SqlExecutorSurfaceFacts,
} from '../../ports/sql-executor-verification';
import type { PersistenceCapabilities } from '../../ports/sql-executor.port';
import {
  assertPersistenceBoundary,
  evaluatePersistenceBoundary,
  PersistenceBoundaryError,
  SQL_EXECUTOR_PORT_TOKEN,
  type PersistenceBinding,
  type PersistenceExecutorVerificationInput,
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

describe('evaluatePersistenceBoundary：数据库已配置 ⇒ 必须有契约事实且必须 attest', () => {
  /** 未封存的「能力自述」执行器：自称 postgres + 持久 + 生产可用 */
  const SELF_DECLARED: PersistenceCapabilities = {
    backend: 'postgres',
    persistent: true,
    productionReady: true,
  };

  /** 连接工厂形态的最小结构事实（只读判定用，不建连接） */
  const FACTORY_SURFACE: SqlExecutorSurfaceFacts = {
    kind: 'connection-factory',
    hasConnect: true,
    hasQuery: false,
    queryParameterSlots: 0,
    hasTransaction: false,
    transactionParameterSlots: 0,
    hasClose: false,
  };

  const NOW = new Date('2026-06-01T00:00:00.000Z').toISOString();

  function executorFacts(nodeEnv: string): PersistenceExecutorVerificationInput {
    return {
      token: SQL_EXECUTOR_PORT_TOKEN,
      input: {
        nodeEnv,
        declaration: SELF_DECLARED,
        surface: FACTORY_SURFACE,
        registry: createSqlExecutorVerificationRegistry(),
        now: NOW,
        label: SQL_EXECUTOR_PORT_TOKEN,
      },
    };
  }

  it('要求 attest 但装配没有执行器事实：判 SQL_EXECUTOR_VERIFICATION_REQUIRED', () => {
    const report = evaluatePersistenceBoundary({
      nodeEnv: 'test',
      databaseConfigured: true,
      bindings: [binding('GROUP_REPOSITORY', IN_MEMORY)],
      requireAttestedExecutor: true,
    });

    expect(report.ok).toBe(false);
    expect(report.violations).toEqual([
      {
        rule: 'SQL_EXECUTOR_VERIFICATION_REQUIRED',
        token: SQL_EXECUTOR_PORT_TOKEN,
        detail: expect.stringContaining('数据库已配置'),
      },
    ]);
    expect(report.violations[0]?.detail).not.toContain('://');
  });

  it('要求 attest 时判定与 NODE_ENV 无关：测试环境的未封存执行器同样被拒', () => {
    const facts = executorFacts('test');
    const report = evaluatePersistenceBoundary({
      nodeEnv: 'test',
      databaseConfigured: true,
      bindings: [binding('GROUP_REPOSITORY', IN_MEMORY)],
      executorVerifications: [facts],
      requireAttestedExecutor: true,
    });

    const executorViolations = report.violations.filter(
      (item) => item.rule === 'SQL_EXECUTOR_VERIFICATION_FAILED',
    );
    expect(executorViolations.length).toBeGreaterThan(0);
    expect(executorViolations.map((item) => item.executorCode)).toEqual(
      expect.arrayContaining(['DECLARATION_NOT_SEALED']),
    );
  });

  it('不要求 attest 时既有装配不受影响（开发/测试的内存替身继续放行）', () => {
    const report = evaluatePersistenceBoundary({
      nodeEnv: 'test',
      databaseConfigured: true,
      bindings: [binding('GROUP_REPOSITORY', IN_MEMORY)],
      executorVerifications: [executorFacts('test')],
    });
    expect(report).toEqual({
      ok: true,
      violations: [],
      checkedTokens: ['GROUP_REPOSITORY'],
    });
  });

  it('无数据库时不要求执行器 attest（无数据库启动保持默认放行）', () => {
    const report = evaluatePersistenceBoundary({
      nodeEnv: 'test',
      databaseConfigured: false,
      bindings: [binding('GROUP_REPOSITORY', IN_MEMORY)],
      executorVerifications: [executorFacts('test')],
    });
    expect(report.ok).toBe(true);
  });

  it('assertPersistenceBoundary 把缺失契约事实报成可定位且不含机密的错误', () => {
    let captured: unknown;
    try {
      assertPersistenceBoundary({
        nodeEnv: 'test',
        databaseConfigured: true,
        bindings: [binding('GROUP_REPOSITORY', IN_MEMORY)],
        requireAttestedExecutor: true,
      });
    } catch (error) {
      captured = error;
    }

    expect(captured).toBeInstanceOf(PersistenceBoundaryError);
    const boundaryError = captured as PersistenceBoundaryError;
    expect(boundaryError.message).toContain(
      `${SQL_EXECUTOR_PORT_TOKEN}[SQL_EXECUTOR_VERIFICATION_REQUIRED]`,
    );
    expect(boundaryError.message).not.toContain('://');
    expect(boundaryError.message).not.toContain('@');
  });
});

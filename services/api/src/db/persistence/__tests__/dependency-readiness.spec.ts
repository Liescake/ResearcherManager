import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { isDeeplyImmutableDeclaration } from '../../ports/sql-executor-verification';
import {
  assertDependencyReadiness,
  assertDependencyEvidenceShape,
  assertDependencyAttestationShape,
  createDependencyReadinessRegistry,
  DEFAULT_DEPENDENCY_READINESS_REGISTRY,
  DependencyReadinessError,
  DEPENDENCY_ACCEPTED_EVIDENCE_METHODS,
  DEPENDENCY_EVIDENCE_MAX_AGE_DAYS,
  DEPENDENCY_READINESS_CONTRACT_ID,
  DEPENDENCY_READINESS_CONTRACT_VERSION,
  DEPENDENCY_ROLE_ORDER,
  describeDependencyReadinessTier,
  evaluateDependencyReadiness,
  evaluateDependencyStage,
  isDependencyReadinessRequired,
  type DependencyReadinessCandidate,
  type DependencyReadinessEvidence,
  type DependencyReadinessRegistry,
  type DependencyRole,
} from '../dependency-readiness';

/**
 * 生产依赖就绪契约的**纯判定**回归（不建连接、不读磁盘、不读环境变量）：
 * 1. 登记表：封存身份不可伪造、形状不合格一律拒绝、证据可核对；
 * 2. 单阶段判定：内存替身 / 未验证后端 / 伪造自述 / 未登记与过期证据各自的违规码；
 * 3. 分阶段判定：**认证先于业务**，认证失败时业务阶段整体短路（业务候选根本不会被求值）；
 * 4. 档位口径与运行时（runtime-info / 启动门禁）共用同一个函数。
 */

/** 判定时刻与证据时间（窗口：最长 90 天、允许时钟偏移 15 分钟） */
const NOW = '2026-06-01T00:00:00.000Z';
/** 12 天前：新鲜 */
const FRESH = '2026-05-20T00:00:00.000Z';
/** 120 天前：过期 */
const STALE = '2026-02-01T00:00:00.000Z';
/** 判定时刻之后 1 小时：超出时钟偏移 */
const FUTURE = '2026-06-01T01:00:00.000Z';

let sequence = 0;

function nextId(prefix: string): string {
  sequence += 1;
  return `${prefix}-${sequence}`;
}

interface AttestFixture {
  readonly token?: string;
  readonly role?: DependencyRole;
  readonly backend?: string;
  readonly verifiedAt?: string;
  readonly evidenceId?: string;
  /** 证据侧的偏差：用于构造「声明与证据不一致」 */
  readonly evidenceToken?: string;
  readonly evidenceRole?: DependencyRole;
  readonly evidenceBackend?: string;
  readonly evidenceVerifiedAt?: string;
  readonly method?: DependencyReadinessEvidence['method'];
  readonly register?: boolean;
}

/** 构造一条「封存声明 + 已登记证据」的候选事实（默认合法且新鲜） */
function attestedCandidate(
  registry: DependencyReadinessRegistry,
  fixture: AttestFixture = {},
): DependencyReadinessCandidate {
  const token = fixture.token ?? 'SESSION_STORE';
  const role = fixture.role ?? 'authentication';
  const backend = fixture.backend ?? 'postgres';
  const verifiedAt = fixture.verifiedAt ?? FRESH;
  const evidenceId = fixture.evidenceId ?? nextId('evidence');

  if (fixture.register !== false) {
    registry.registerEvidence({
      evidenceId,
      token: fixture.evidenceToken ?? token,
      role: fixture.evidenceRole ?? role,
      backend: fixture.evidenceBackend ?? backend,
      contractId: DEPENDENCY_READINESS_CONTRACT_ID,
      contractVersion: DEPENDENCY_READINESS_CONTRACT_VERSION,
      verifiedBy: 'fixture-ci',
      verifiedAt: fixture.evidenceVerifiedAt ?? verifiedAt,
      method: fixture.method ?? 'integration-test',
      persistent: true,
      productionReady: true,
      evidenceRef: `fixture-run-${evidenceId}`,
    });
  }

  return {
    token,
    role,
    capabilities: registry.attest({
      token,
      role,
      backend,
      persistent: true,
      productionReady: true,
      evidenceId,
      verifiedAt,
    }),
  };
}

function codesOf(candidate: DependencyReadinessCandidate, registry: DependencyReadinessRegistry) {
  const report = evaluateDependencyStage({
    required: true,
    role: candidate.role,
    candidates: [candidate],
    registry,
    now: NOW,
  });
  return report.violations.map((item) => item.code);
}

describe('契约身份与档位：与启动门禁 / 运行时信息共用同一口径', () => {
  it('角色顺序固定为「认证 → 业务」，生产只接受集成测试证据', () => {
    expect([...DEPENDENCY_ROLE_ORDER]).toEqual(['authentication', 'business']);
    expect([...DEPENDENCY_ACCEPTED_EVIDENCE_METHODS]).toEqual(['integration-test']);
    expect(DEPENDENCY_EVIDENCE_MAX_AGE_DAYS).toBe(90);
  });

  it('档位：生产或已配置数据库 ⇒ required；开发/测试且无库 ⇒ not-required', () => {
    expect(describeDependencyReadinessTier('production', false)).toBe('required');
    expect(describeDependencyReadinessTier('production', true)).toBe('required');
    expect(describeDependencyReadinessTier('test', true)).toBe('required');
    expect(describeDependencyReadinessTier('development', true)).toBe('required');
    expect(describeDependencyReadinessTier('test', false)).toBe('not-required');
    expect(describeDependencyReadinessTier('development', false)).toBe('not-required');

    for (const nodeEnv of ['development', 'test', 'production'] as const) {
      for (const configured of [false, true]) {
        expect(isDependencyReadinessRequired(nodeEnv, configured)).toBe(
          describeDependencyReadinessTier(nodeEnv, configured) === 'required',
        );
      }
    }
  });

  it('默认登记表是空集：没有任何依赖被签发过封存身份（不引入任何生产实现）', () => {
    expect(DEFAULT_DEPENDENCY_READINESS_REGISTRY.describe()).toEqual({
      sealedDeclarations: 0,
      evidence: 0,
    });
  });
});

describe('登记表：封存身份不可伪造、形状不合格一律拒绝', () => {
  it('attest 产出深度冻结、不可变的封存声明，且身份只认本登记表', () => {
    const registry = createDependencyReadinessRegistry();
    const candidate = attestedCandidate(registry);
    const declaration = candidate.capabilities as Record<string, unknown>;

    expect(registry.isSealed(declaration)).toBe(true);
    expect(isDeeplyImmutableDeclaration(declaration)).toBe(true);
    expect(Object.isFrozen(declaration)).toBe(true);
    expect(registry.describe()).toEqual({ sealedDeclarations: 1, evidence: 1 });

    // 复制 / 克隆 / 原型继承 / JSON 往返都拿不到封存身份
    expect(registry.isSealed({ ...declaration })).toBe(false);
    expect(registry.isSealed(structuredClone(declaration))).toBe(false);
    expect(registry.isSealed(Object.create(declaration))).toBe(false);
    expect(registry.isSealed(JSON.parse(JSON.stringify(declaration)) as unknown)).toBe(false);
    expect(registry.isSealed(undefined)).toBe(false);
    expect(registry.isSealed('postgres')).toBe(false);

    // 封存后不可改写（严格模式下写入会抛错，非严格模式静默失败但值不变）
    expect(() => {
      (declaration as { persistent?: unknown }).persistent = false;
    }).toThrow(TypeError);
    expect(declaration['persistent']).toBe(true);
  });

  it('attest 拒绝内存 / 非持久 / 未验证 / 缺来源的声明（自述不能变成封存身份）', () => {
    const registry = createDependencyReadinessRegistry();
    const base = {
      token: 'SESSION_STORE',
      role: 'authentication' as DependencyRole,
      backend: 'postgres',
      persistent: true,
      productionReady: true,
      evidenceId: nextId('evidence'),
      verifiedAt: FRESH,
    };

    const rejected: Array<Partial<typeof base>> = [
      { token: '   ' },
      { role: 'storage' as DependencyRole },
      { backend: 'in-memory-baseline' },
      { backend: 'inmemory-session' },
      { backend: '' },
      { persistent: false },
      { productionReady: false },
      { evidenceId: '  ' },
      { verifiedAt: '2026-05-20' },
      { verifiedAt: 'not-a-timestamp' },
    ];
    for (const override of rejected) {
      expect(() => registry.attest({ ...base, ...override })).toThrow(DependencyReadinessError);
    }
    // 一条都没写进登记表
    expect(registry.describe()).toEqual({ sealedDeclarations: 0, evidence: 0 });
  });

  it('registerEvidence 的形状校验：契约身份、时间、方式、可核对引用缺一不可', () => {
    const valid: DependencyReadinessEvidence = {
      evidenceId: 'evidence-1',
      token: 'SESSION_STORE',
      role: 'authentication',
      backend: 'postgres',
      contractId: DEPENDENCY_READINESS_CONTRACT_ID,
      contractVersion: DEPENDENCY_READINESS_CONTRACT_VERSION,
      verifiedBy: 'ci',
      verifiedAt: FRESH,
      method: 'integration-test',
      persistent: true,
      productionReady: true,
      evidenceRef: 'run-1',
    };
    expect(() => assertDependencyEvidenceShape(valid)).not.toThrow();

    const rejected: ReadonlyArray<Partial<Record<keyof DependencyReadinessEvidence, unknown>>> = [
      { evidenceId: '' },
      { token: ' ' },
      { role: 'storage' },
      { backend: 'in-memory-baseline' },
      { backend: '' },
      { contractId: 'other-contract' },
      { contractVersion: 2 },
      { verifiedBy: '' },
      { verifiedAt: 'yesterday' },
      { method: 'guessed' },
      { persistent: false },
      { productionReady: false },
      { evidenceRef: '  ' },
    ];
    for (const override of rejected) {
      expect(() =>
        assertDependencyEvidenceShape({
          ...valid,
          ...override,
        } as DependencyReadinessEvidence),
      ).toThrow(DependencyReadinessError);
    }
  });

  it('登记表按内容去重：重复登记幂等，内容不同的同名登记并存（构成冲突证据）', () => {
    const registry = createDependencyReadinessRegistry();
    const record: DependencyReadinessEvidence = {
      evidenceId: 'evidence-dup',
      token: 'SESSION_STORE',
      role: 'authentication',
      backend: 'postgres',
      contractId: DEPENDENCY_READINESS_CONTRACT_ID,
      contractVersion: DEPENDENCY_READINESS_CONTRACT_VERSION,
      verifiedBy: 'ci',
      verifiedAt: FRESH,
      method: 'integration-test',
      persistent: true,
      productionReady: true,
      evidenceRef: 'run-1',
    };
    registry.registerEvidence(record);
    registry.registerEvidence({ ...record });
    expect(registry.evidence('evidence-dup')).toHaveLength(1);

    registry.registerEvidence({ ...record, verifiedBy: 'other-ci' });
    expect(registry.evidence('evidence-dup')).toHaveLength(2);
    expect(registry.evidence('missing-evidence')).toEqual([]);
  });
});

describe('单阶段判定：内存替身、未验证后端、伪造自述与证据问题', () => {
  it('未生效档位不做任何判定（连证据登记表都不用）', () => {
    const registry = createDependencyReadinessRegistry();
    const report = evaluateDependencyStage({
      required: false,
      role: 'authentication',
      candidates: [],
      registry,
      now: 'not-a-timestamp',
    });
    expect(report).toEqual({
      role: 'authentication',
      state: 'not-required',
      violations: [],
      checkedTokens: [],
    });
  });

  it('生效档位要求带时区的 ISO 判定时刻（fail-loud，不静默用当前时间）', () => {
    const registry = createDependencyReadinessRegistry();
    expect(() =>
      evaluateDependencyStage({
        required: true,
        role: 'authentication',
        candidates: [],
        registry,
        now: '2026-06-01',
      }),
    ).toThrow(TypeError);
  });

  it('能力声明缺失 / 非对象 → DEPENDENCY_CAPABILITIES_MISSING（任何环境都是代码缺陷）', () => {
    const registry = createDependencyReadinessRegistry();
    const missing = codesOf({ token: 'SESSION_STORE', role: 'authentication' }, registry);
    expect(missing).toEqual(['DEPENDENCY_CAPABILITIES_MISSING']);

    const notAnObject = codesOf(
      { token: 'SESSION_STORE', role: 'authentication', capabilities: 'postgres' },
      registry,
    );
    expect(notAnObject).toEqual(['DEPENDENCY_CAPABILITIES_MISSING']);
  });

  it('内存替身（InMemorySessionStore 能力）→ DEPENDENCY_NOT_PERSISTENT', () => {
    const registry = createDependencyReadinessRegistry();
    const codes = codesOf(
      {
        token: 'SESSION_STORE',
        role: 'authentication',
        capabilities: { backend: 'in-memory-baseline', persistent: false, productionReady: false },
      },
      registry,
    );
    expect(codes).toEqual(['DEPENDENCY_NOT_PERSISTENT']);
  });

  it('声明持久但未验证 → DEPENDENCY_NOT_VERIFIED', () => {
    const registry = createDependencyReadinessRegistry();
    const codes = codesOf(
      {
        token: 'GROUP_REPOSITORY',
        role: 'business',
        capabilities: { backend: 'postgres', persistent: true, productionReady: false },
      },
      registry,
    );
    expect(codes).toEqual(['DEPENDENCY_NOT_VERIFIED']);
  });

  it('伪造自述（未封存的 persistent + productionReady 字面量）→ NOT_SEALED + MUTABLE', () => {
    const registry = createDependencyReadinessRegistry();
    const literal = { backend: 'postgres', persistent: true, productionReady: true };
    expect(
      codesOf({ token: 'SESSION_STORE', role: 'authentication', capabilities: literal }, registry),
    ).toEqual(['DEPENDENCY_NOT_SEALED', 'DEPENDENCY_MUTABLE']);

    // 冻结过的字面量仍然不是封存身份（身份只由登记表签发）
    const frozen = Object.freeze({ backend: 'postgres', persistent: true, productionReady: true });
    expect(
      codesOf({ token: 'SESSION_STORE', role: 'authentication', capabilities: frozen }, registry),
    ).toEqual(['DEPENDENCY_NOT_SEALED']);
  });

  it('封存声明 + 已登记的新鲜证据 → 通过（契约不是死路）', () => {
    const registry = createDependencyReadinessRegistry();
    const candidate = attestedCandidate(registry);
    expect(codesOf(candidate, registry)).toEqual([]);
  });

  it('封存声明引用的证据未登记 → DEPENDENCY_EVIDENCE_UNKNOWN', () => {
    const registry = createDependencyReadinessRegistry();
    const candidate = attestedCandidate(registry, { register: false });
    expect(codesOf(candidate, registry)).toEqual(['DEPENDENCY_EVIDENCE_UNKNOWN']);
  });

  it('声明与证据冲突（端口/后端/时间不一致）→ DEPENDENCY_EVIDENCE_CONFLICTING', () => {
    const registry = createDependencyReadinessRegistry();

    expect(
      codesOf(attestedCandidate(registry, { evidenceToken: 'OTHER_STORE' }), registry),
    ).toEqual(['DEPENDENCY_EVIDENCE_CONFLICTING']);
    expect(codesOf(attestedCandidate(registry, { evidenceBackend: 'mysql' }), registry)).toEqual([
      'DEPENDENCY_EVIDENCE_CONFLICTING',
    ]);

    // 同名证据的两条内容不一致登记同样判冲突
    const conflicting = createDependencyReadinessRegistry();
    const candidate = attestedCandidate(conflicting, { evidenceId: 'evidence-c' });
    conflicting.registerEvidence({
      evidenceId: 'evidence-c',
      token: 'SESSION_STORE',
      role: 'authentication',
      backend: 'postgres',
      contractId: DEPENDENCY_READINESS_CONTRACT_ID,
      contractVersion: DEPENDENCY_READINESS_CONTRACT_VERSION,
      verifiedBy: 'another-ci',
      verifiedAt: FRESH,
      method: 'integration-test',
      persistent: true,
      productionReady: true,
      evidenceRef: 'run-other',
    });
    expect(codesOf(candidate, conflicting)).toEqual(['DEPENDENCY_EVIDENCE_CONFLICTING']);
  });

  it('验证方式不被生产接受 → DEPENDENCY_EVIDENCE_METHOD_NOT_ACCEPTED', () => {
    const registry = createDependencyReadinessRegistry();
    expect(codesOf(attestedCandidate(registry, { method: 'manual-review' }), registry)).toEqual([
      'DEPENDENCY_EVIDENCE_METHOD_NOT_ACCEPTED',
    ]);
  });

  it('证据过期或时间超前 → DEPENDENCY_EVIDENCE_STALE', () => {
    const staleRegistry = createDependencyReadinessRegistry();
    expect(codesOf(attestedCandidate(staleRegistry, { verifiedAt: STALE }), staleRegistry)).toEqual(
      ['DEPENDENCY_EVIDENCE_STALE'],
    );

    const futureRegistry = createDependencyReadinessRegistry();
    expect(
      codesOf(attestedCandidate(futureRegistry, { verifiedAt: FUTURE }), futureRegistry),
    ).toEqual(['DEPENDENCY_EVIDENCE_STALE']);
  });

  it('封存声明必须在契约身份与端口/角色上自洽（伪造登记表身份与声明挪用都被拦下）', () => {
    // 只有契约身份需要「敌意登记表」才能构造：声明本身由本模块产出，身份字段不可改写。
    const hostile: DependencyReadinessRegistry = {
      attest: () => {
        throw new Error('未使用');
      },
      registerEvidence: () => undefined,
      isSealed: () => true,
      evidence: () => [],
      describe: () => ({ sealedDeclarations: 0, evidence: 0 }),
    };
    const mismatch = codesOf(
      {
        token: 'SESSION_STORE',
        role: 'authentication',
        capabilities: {
          contractId: 'other-contract',
          contractVersion: 99,
          token: 'SESSION_STORE',
          role: 'authentication',
          backend: 'postgres',
          persistent: true,
          productionReady: true,
        },
      },
      hostile,
    );
    expect(mismatch).toEqual(
      expect.arrayContaining(['DEPENDENCY_CONTRACT_MISMATCH', 'DEPENDENCY_EVIDENCE_UNKNOWN']),
    );

    // 声明挪用：业务端口的封存声明被绑到会话存储上
    const registry = createDependencyReadinessRegistry();
    const foreign = attestedCandidate(registry, { token: 'GROUP_REPOSITORY', role: 'business' });
    const misbound: DependencyReadinessCandidate = {
      token: 'SESSION_STORE',
      role: 'authentication',
      capabilities: foreign.capabilities,
    };
    expect(codesOf(misbound, registry)).toEqual([
      'DEPENDENCY_BINDING_MISMATCH',
      'DEPENDENCY_EVIDENCE_CONFLICTING',
    ]);
  });

  it('违规信息只含端口名、角色与布尔/枚举能力值，不含证据引用与连接串', () => {
    const registry = createDependencyReadinessRegistry();
    const report = evaluateDependencyStage({
      required: true,
      role: 'authentication',
      candidates: [
        {
          token: 'SESSION_STORE',
          role: 'authentication',
          capabilities: { backend: 'postgres', persistent: true, productionReady: true },
        },
        {
          token: 'GROUP_REPOSITORY',
          role: 'business',
          capabilities: {
            backend: 'in-memory-baseline',
            persistent: false,
            productionReady: false,
          },
        },
      ],
      registry,
      now: NOW,
    });

    // 未封存的字面量同时命中「不是封存身份」与「可变」两条，端口顺序即候选顺序
    expect(report.violations.map((item) => item.token)).toEqual([
      'SESSION_STORE',
      'SESSION_STORE',
      'GROUP_REPOSITORY',
    ]);
    expect(report.violations.map((item) => item.code)).toEqual([
      'DEPENDENCY_NOT_SEALED',
      'DEPENDENCY_MUTABLE',
      'DEPENDENCY_NOT_PERSISTENT',
    ]);
    const serialized = JSON.stringify(report.violations);
    expect(serialized).not.toContain('://');
    expect(serialized).not.toContain('@');
    expect(serialized).not.toContain('fixture-run');
    // 诊断信息仍然可定位：后端标识不是机密，端口与后端一起出现在 detail 里
    const notPersistent = report.violations.find(
      (item) => item.code === 'DEPENDENCY_NOT_PERSISTENT',
    );
    expect(notPersistent?.detail).toContain('in-memory-baseline');
    expect(notPersistent?.detail).not.toContain('://');
  });
});

describe('分阶段判定：认证先于业务，认证失败时业务阶段整体短路', () => {
  it('未生效档位不调用任何一个候选提供者（无数据库默认启动保持现状）', () => {
    const authentication = vi.fn(() => []);
    const business = vi.fn(() => []);
    const report = evaluateDependencyReadiness({
      required: false,
      authentication,
      business,
      registry: createDependencyReadinessRegistry(),
      now: NOW,
    });

    expect(report).toEqual({
      ok: true,
      tier: 'not-required',
      authentication: 'not-required',
      business: 'not-required',
      checkedTokens: [],
      violations: [],
    });
    expect(authentication).not.toHaveBeenCalled();
    expect(business).not.toHaveBeenCalled();
  });

  it('认证阶段失败：业务候选提供者根本不会被调用，业务状态为 not-checked', () => {
    const registry = createDependencyReadinessRegistry();
    const authentication = () => [
      {
        token: 'SESSION_STORE',
        role: 'authentication' as DependencyRole,
        capabilities: { backend: 'in-memory-baseline', persistent: false, productionReady: false },
      },
    ];
    const business = vi.fn(() => [attestedCandidate(registry, { token: 'X', role: 'business' })]);

    const report = evaluateDependencyReadiness({
      required: true,
      authentication,
      business,
      registry,
      now: NOW,
    });

    expect(report).toEqual({
      ok: false,
      tier: 'required',
      authentication: 'rejected',
      business: 'not-checked',
      checkedTokens: ['SESSION_STORE'],
      violations: [
        {
          code: 'DEPENDENCY_NOT_PERSISTENT',
          token: 'SESSION_STORE',
          role: 'authentication',
          detail: expect.stringContaining('in-memory-baseline'),
        },
      ],
    });
    expect(business).not.toHaveBeenCalled();
  });

  it('认证通过后业务失败：认证状态为 verified，业务状态为 rejected', () => {
    const registry = createDependencyReadinessRegistry();
    const report = evaluateDependencyReadiness({
      required: true,
      authentication: () => [attestedCandidate(registry)],
      business: () => [
        {
          token: 'GROUP_REPOSITORY',
          role: 'business',
          capabilities: { backend: 'postgres-draft', persistent: true, productionReady: false },
        },
      ],
      registry,
      now: NOW,
    });

    expect(report.ok).toBe(false);
    expect(report.authentication).toBe('verified');
    expect(report.business).toBe('rejected');
    expect(report.checkedTokens).toEqual(['SESSION_STORE', 'GROUP_REPOSITORY']);
    expect(report.violations.map((item) => item.code)).toEqual(['DEPENDENCY_NOT_VERIFIED']);
  });

  it('两个阶段都就绪：ok + 两阶段 verified，已检查端口覆盖认证与业务', () => {
    const registry = createDependencyReadinessRegistry();
    const input = {
      required: true,
      authentication: () => [attestedCandidate(registry)],
      business: () => [
        attestedCandidate(registry, { token: 'GROUP_REPOSITORY', role: 'business' }),
        attestedCandidate(registry, { token: 'AUDIT_REPOSITORY', role: 'business' }),
      ],
      registry,
      now: NOW,
    };
    const report = evaluateDependencyReadiness(input);

    expect(report).toEqual({
      ok: true,
      tier: 'required',
      authentication: 'verified',
      business: 'verified',
      checkedTokens: ['SESSION_STORE', 'GROUP_REPOSITORY', 'AUDIT_REPOSITORY'],
      violations: [],
    });
    expect(assertDependencyReadiness(input)).toEqual(report);
  });

  it('assertDependencyReadiness 在不通过时抛可定位且不含机密的错误', () => {
    const registry = createDependencyReadinessRegistry();
    let captured: unknown;
    try {
      assertDependencyReadiness({
        required: true,
        authentication: () => [
          {
            token: 'SESSION_STORE',
            role: 'authentication',
            capabilities: { backend: 'postgres', persistent: true, productionReady: true },
          },
        ],
        business: () => [],
        registry,
        now: NOW,
      });
    } catch (error) {
      captured = error;
    }

    expect(captured).toBeInstanceOf(DependencyReadinessError);
    const error = captured as DependencyReadinessError;
    expect(error.message).toContain('SESSION_STORE[DEPENDENCY_NOT_SEALED]');
    expect(error.violations.map((item) => item.code)).toEqual([
      'DEPENDENCY_NOT_SEALED',
      'DEPENDENCY_MUTABLE',
    ]);
  });
});

describe('契约模块的边界事实：纯判定，不依赖文件系统与运行期配置', () => {
  it('契约源码不 import node: 内置模块，也不含任何驱动痕迹', () => {
    const source = readFileSync(
      join(
        findRepoRoot(process.cwd()),
        'services',
        'api',
        'src',
        'db',
        'persistence',
        'dependency-readiness.ts',
      ),
      'utf8',
    );
    expect(source).not.toMatch(/from\s+['"]node:/u);
    expect(source).not.toMatch(/require\s*\(\s*['"]node:/u);
    expect(source).not.toMatch(/new Pool|createConnection|DataSource/u);
  });

  it('封存契约形状校验函数可直接断言（供登记表与调用点复用）', () => {
    expect(() =>
      assertDependencyAttestationShape({
        token: 'SESSION_STORE',
        role: 'authentication',
        backend: 'postgres',
        persistent: true,
        productionReady: true,
        evidenceId: 'evidence-x',
        verifiedAt: FRESH,
      }),
    ).not.toThrow();
    expect(() =>
      assertDependencyAttestationShape({
        token: 'SESSION_STORE',
        role: 'authentication',
        backend: 'in-memory-baseline',
        persistent: false,
        productionReady: false,
        evidenceId: '',
        verifiedAt: NOW,
      }),
    ).toThrow(DependencyReadinessError);
  });
});

/** 从当前工作目录向上寻找仓库根（含 pnpm-workspace.yaml） */
function findRepoRoot(start: string): string {
  let current = resolve(start);
  for (let depth = 0; depth < 8; depth += 1) {
    if (existsSync(join(current, 'pnpm-workspace.yaml'))) {
      return current;
    }
    const parent = dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }
  throw new Error('未找到仓库根目录（缺少 pnpm-workspace.yaml）');
}

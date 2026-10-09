import { describe, expect, it } from 'vitest';
import { Role } from '@rm/shared';
import type { AuthorizationSubject } from '@rm/shared';
import { loadEnv } from '../../config/env';
import {
  DEFAULT_DEPENDENCY_READINESS_REGISTRY,
  evaluateDependencyStage,
} from '../../db/persistence/dependency-readiness';
import { evaluatePersistenceBoundary } from '../../db/persistence/production-guard';
import {
  createUnavailableSqlConnectionFactory,
  type SqlConnection,
  type SqlConnectionFactory,
  type SqlExecutor,
  type SqlQueryResult,
} from '../../db/ports/sql-executor.port';
import { InMemoryComplianceRepository } from './compliance.in-memory-repository';
import { createComplianceRepository } from './compliance.module';
import { POSTGRES_COMPLIANCE_REPOSITORY_CAPABILITIES } from './compliance.postgres-repository';
import {
  COMPLIANCE_REPOSITORY,
  COMPLIANCE_REPOSITORY_BACKEND_POSTGRES,
  DataRetentionStatus,
  ExportAvailabilityStatus,
  PrivacyConsentStatus,
  type ComplianceRecord,
} from './compliance.port';

/**
 * 合规切片的**换绑分流点**（`createComplianceRepository`）：把「合规状态的 PostgreSQL adapter
 * 接入已配置数据库且执行器就绪的运行路径」这件事变成可机器判定的三条性质，而不是靠注释。
 *
 * 1. 未解析出 `DATABASE_URL` → 内存基线（开发/测试行为与切片之前一致，且如实声明非持久）；
 * 2. 已解析出 `DATABASE_URL` 但拿不到 `SQL_CONNECTION_FACTORY` → **抛错**（fail-closed：
 *    绝不悄悄退回内存合规存储）；
 * 3. 已解析出 `DATABASE_URL` 且拿到执行器工厂 → PostgreSQL adapter，且**延迟建连**：
 *    装配阶段一次都不碰数据库（否则「未 attest 的执行器」「依赖未就绪」就轮不到启动期门禁
 *    来给出结构化违规，而会在这里表现为一个数据库连接错误）。
 *
 * 另外固定本切片特有的安全口径：
 * - **生产环境（`NODE_ENV=production`）无数据库时**：配置解析先拒绝（不存在「生产用内存合规
 *   存储」的可用路径）；
 * - **存储 ID 域先判、再建连**：非 UUID 的会话主体（基线的 `u-student-1`）在解析执行器
 *   **之前**就被拒绝，因此既不进 SQL，也不触发任何连接；
 * - **owner/scope 隔离**：归属只来自服务端主体，且被下推进 SQL（参数化）；仓储若返回他人记录
 *   必须判服务端缺陷（`OWNER_VIOLATION`），而不是静默过滤或回流；
 * - **参数化 SQL + 显式列**：主体只出现在参数里，SQL 文本里没有任何取值；未登记列（PII /
 *   同意原文 / 审核证据）会让严格行契约 fail-closed。
 *
 * 授权先于仓储访问这一半由 `compliance.controller.spec.ts` 直接回归（403 时端口零调用），
 * 这里固定的是端口语义与换绑事实。
 */
const LOOPBACK_URL = 'postgresql://postgres:postgres@127.0.0.1:5432/researcher_manager';
const OWNER = '11111111-1111-4111-8111-111111111111';
const OTHER_OWNER = '22222222-2222-4222-8222-222222222222';
/** 会话基线形状的主体（「安全 ID」，但不是 UUID） */
const SESSION_STYLE_SUBJECT = 'u-student-1';

const OWNER_STATUS = {
  privacyConsent: PrivacyConsentStatus.Granted,
  dataRetention: DataRetentionStatus.WithinRetention,
  exportAvailability: ExportAvailabilityStatus.Available,
} as const;

function recordFor(ownerUserId: string): ComplianceRecord {
  return { ownerUserId, ...OWNER_STATUS };
}

/** 与 adapter 输出列一一对应的数据库行（严格行契约的合法形态） */
function rowFor(ownerUserId: string): Record<string, unknown> {
  return {
    user_id: ownerUserId,
    privacy_consent: OWNER_STATUS.privacyConsent,
    data_retention: OWNER_STATUS.dataRetention,
    export_availability: OWNER_STATUS.exportAvailability,
  };
}

interface CountingFactory {
  readonly factory: SqlConnectionFactory;
  readonly connects: () => number;
  /** 执行器收到过的 SQL（用于断言「取值只进参数、不进 SQL 文本」） */
  readonly sql: () => readonly string[];
  readonly parameters: () => readonly (readonly unknown[] | undefined)[];
}

/** 只记录调用、不做任何真实连接的执行器工厂（延迟建连与参数化断言用） */
function countingFactory(rows: readonly unknown[] = []): CountingFactory {
  let connects = 0;
  const statements: string[] = [];
  const parameters: (readonly unknown[] | undefined)[] = [];
  const connection: SqlConnection = {
    capabilities: { backend: 'postgres', persistent: true, productionReady: false },
    query: <Row = Record<string, unknown>>(
      sql: string,
      values?: readonly unknown[],
    ): Promise<SqlQueryResult<Row>> => {
      statements.push(sql);
      parameters.push(values);
      return Promise.resolve({ rows, rowCount: rows.length } as unknown as SqlQueryResult<Row>);
    },
    transaction: <Result>(run: (executor: SqlExecutor) => Promise<Result>): Promise<Result> =>
      run(connection),
    close: () => Promise.resolve(),
  };
  return {
    factory: {
      capabilities: { backend: 'postgres', persistent: true, productionReady: true },
      connect: () => {
        connects += 1;
        return Promise.resolve(connection);
      },
    },
    connects: () => connects,
    sql: () => statements,
    parameters: () => parameters,
  };
}

describe('合规仓储的持久化分流（createComplianceRepository）', () => {
  it('未配置数据库：绑定内存基线，如实声明非持久 / 不可用于生产', async () => {
    const repository = createComplianceRepository(loadEnv({ NODE_ENV: 'test' }), undefined);

    expect(repository).toBeInstanceOf(InMemoryComplianceRepository);
    expect(repository.capabilities).toEqual({
      backend: 'in-memory-baseline',
      persistent: false,
      productionReady: false,
    });

    // 行为保持：开发/测试下仍可按服务端主体取数；未 seed 时 fail-closed 地「无记录」
    const memory = repository as InMemoryComplianceRepository;
    await expect(repository.findByUserId(OWNER)).resolves.toBeUndefined();
    memory.seed(recordFor(OWNER));
    await expect(repository.findByUserId(OWNER)).resolves.toEqual(recordFor(OWNER));
    await expect(repository.findByUserId(OTHER_OWNER)).resolves.toBeUndefined();
  });

  it('配置了数据库但没有执行器工厂：抛错，绝不静默退回内存合规存储', () => {
    expect(() =>
      createComplianceRepository(
        loadEnv({ NODE_ENV: 'test', DATABASE_URL: LOOPBACK_URL }),
        undefined,
      ),
    ).toThrow(/拒绝退回内存合规仓储/u);
  });

  it('配置了数据库且拿到执行器工厂：换绑到 PostgreSQL adapter，且构造时不建连', async () => {
    const harness = countingFactory();
    const repository = createComplianceRepository(
      loadEnv({ NODE_ENV: 'test', DATABASE_URL: LOOPBACK_URL }),
      harness.factory,
    );

    // 延迟建连：装配阶段一次都没有调用 connect（真正的准入判定属于启动期门禁）
    expect(harness.connects()).toBe(0);
    expect(repository).not.toBeInstanceOf(InMemoryComplianceRepository);
    expect(repository.capabilities).toEqual(POSTGRES_COMPLIANCE_REPOSITORY_CAPABILITIES);
    expect(repository.capabilities).toMatchObject({
      backend: COMPLIANCE_REPOSITORY_BACKEND_POSTGRES,
      persistent: true,
    });
    expect(repository.capabilities.productionReady).toBe(false);

    // 合法主体、库里没有记录：这时才建连（一次），并且按内存基线同语义返回 undefined
    await expect(repository.findByUserId(OWNER)).resolves.toBeUndefined();
    expect(harness.connects()).toBe(1);

    // 连接被复用：第二次取数不再建连
    await expect(repository.findByUserId(OWNER)).resolves.toBeUndefined();
    expect(harness.connects()).toBe(1);
  });

  it('参数化 SQL + 显式列：主体只出现在参数里，SQL 文本里没有任何取值', async () => {
    const harness = countingFactory([rowFor(OWNER)]);
    const repository = createComplianceRepository(
      loadEnv({ NODE_ENV: 'test', DATABASE_URL: LOOPBACK_URL }),
      harness.factory,
    );

    await expect(repository.findByUserId(OWNER)).resolves.toEqual(recordFor(OWNER));

    const [sql] = harness.sql();
    expect(sql).toBeDefined();
    // 显式列清单：不使用 SELECT *，且不选中任何内部列
    expect(sql).toContain('SELECT user_id, privacy_consent, data_retention, export_availability');
    expect(sql).not.toContain('*');
    expect(sql).not.toContain('created_at');
    expect(sql).not.toContain('updated_at');
    // 归属下推进 SQL，且是占位符绑定
    expect(sql).toContain('WHERE user_id = $1::uuid');
    // 取值绝不出现在 SQL 文本里
    expect(sql).not.toContain(OWNER);
    expect(harness.parameters()[0]).toEqual([OWNER]);
  });

  it('存储 ID 域先判、再建连：非 UUID 会话主体在进入 SQL 之前就被拒绝', async () => {
    const harness = countingFactory([rowFor(OWNER)]);
    const repository = createComplianceRepository(
      loadEnv({ NODE_ENV: 'test', DATABASE_URL: LOOPBACK_URL }),
      harness.factory,
    );

    // 会话基线形状的主体（`u-student-1`）不是存储 ID 域内的标识：拒绝，且**不建连**、不执行 SQL。
    // 这正是「客户端/会话声明的 userId 不得变成 SQL 里的归属谓词」这条不变量在数据库路径上的落点。
    await expect(repository.findByUserId(SESSION_STYLE_SUBJECT)).rejects.toMatchObject({
      code: 'INVALID_SUBJECT',
    });
    await expect(repository.findByUserId('')).rejects.toMatchObject({ code: 'INVALID_SUBJECT' });
    await expect(
      repository.findByUserId('11111111-1111-4111-8111-11111111111Z'),
    ).rejects.toMatchObject({ code: 'INVALID_SUBJECT' });
    expect(harness.connects()).toBe(0);
    expect(harness.sql()).toEqual([]);

    // 合法请求才建连（证明上面的拒绝来自校验，而不是「谁都连不上」）
    await expect(repository.findByUserId(OWNER)).resolves.toEqual(recordFor(OWNER));
    expect(harness.connects()).toBe(1);
  });

  it('owner 隔离：仓储若返回他人记录（未按主体过滤）必须判服务端缺陷，不静默过滤也不外发', async () => {
    const harness = countingFactory([rowFor(OTHER_OWNER)]);
    const repository = createComplianceRepository(
      loadEnv({ NODE_ENV: 'test', DATABASE_URL: LOOPBACK_URL }),
      harness.factory,
    );

    let captured: unknown;
    try {
      await repository.findByUserId(OWNER);
    } catch (error) {
      captured = error;
    }
    expect(captured).toMatchObject({ code: 'OWNER_VIOLATION' });
    // 错误只承载字段路径，不回显任何归属取值
    const serialized = JSON.stringify(captured, Object.getOwnPropertyNames(captured ?? {}));
    expect(serialized).not.toContain(OTHER_OWNER);
    expect(serialized).not.toContain(OWNER);
  });

  it('严格行契约：未登记列（PII / 同意原文 / 审核证据）与未知枚举一律 fail-closed', async () => {
    const leaked = {
      ...rowFor(OWNER),
      phone: '13800000000',
      consent_text: '本人同意……',
      reviewer_id: OTHER_OWNER,
    };
    const harness = countingFactory([leaked]);
    const repository = createComplianceRepository(
      loadEnv({ NODE_ENV: 'test', DATABASE_URL: LOOPBACK_URL }),
      harness.factory,
    );

    let captured: unknown;
    try {
      await repository.findByUserId(OWNER);
    } catch (error) {
      captured = error;
    }
    expect(captured).toMatchObject({ code: 'INVALID_ROW' });
    const error = captured as { issues: readonly string[] };
    // 只列出字段名（不是取值）：既让契约漂移可定位，又不泄露数据
    expect(error.issues).toEqual(
      expect.arrayContaining([
        'phone(unexpected)',
        'consent_text(unexpected)',
        'reviewer_id(unexpected)',
      ]),
    );
    const serialized = JSON.stringify(captured, Object.getOwnPropertyNames(captured ?? {}));
    expect(serialized).not.toContain('13800000000');
    expect(serialized).not.toContain('本人同意');

    // 结果集多行同样是服务端缺陷（本读模型按主体唯一）
    const duplicates = countingFactory([rowFor(OWNER), rowFor(OWNER)]);
    const duplicateRepository = createComplianceRepository(
      loadEnv({ NODE_ENV: 'test', DATABASE_URL: LOOPBACK_URL }),
      duplicates.factory,
    );
    await expect(duplicateRepository.findByUserId(OWNER)).rejects.toMatchObject({
      code: 'RESULT_SET_VIOLATION',
    });
  });

  it('状态不自洽的记录（未生效的同意却声明导出可用）在读取路径上 fail-closed', async () => {
    const inconsistent = {
      ...rowFor(OWNER),
      privacy_consent: PrivacyConsentStatus.NotRecorded,
    };
    const harness = countingFactory([inconsistent]);
    const repository = createComplianceRepository(
      loadEnv({ NODE_ENV: 'test', DATABASE_URL: LOOPBACK_URL }),
      harness.factory,
    );

    await expect(repository.findByUserId(OWNER)).rejects.toMatchObject({ code: 'INVALID_ROW' });
  });

  it('执行器工厂是 fail-closed 的未验证驱动时：首次读取失败，错误文本不回显连接串', async () => {
    const repository = createComplianceRepository(
      loadEnv({ NODE_ENV: 'test', DATABASE_URL: LOOPBACK_URL }),
      createUnavailableSqlConnectionFactory('测试：未验证驱动'),
    );

    let captured: unknown;
    try {
      await repository.findByUserId(OWNER);
    } catch (error) {
      captured = error;
    }
    expect(captured).toBeInstanceOf(Error);
    const message = String((captured as Error).message);
    expect(message).not.toContain('://');
    expect(message).not.toContain('postgres');
    expect(message).not.toContain('password');
  });

  it('生产环境且未配置数据库：配置解析先于任何绑定失败（不存在生产用内存合规存储）', () => {
    // 生产环境的 fail-closed 有两条，且**顺序固定**：先拒绝「没有数据库」，再轮到内存基线自检。
    // 因此这里断言的是配置层错误，而不是「先构造内存仓储再被它拒绝」。
    expect(() =>
      createComplianceRepository(
        loadEnv({ NODE_ENV: 'production', SESSION_SECRET: 'x'.repeat(32) }),
        undefined,
      ),
    ).toThrow(/生产环境必须配置 DATABASE_URL/u);
  });

  it('生产配置了数据库但依赖不就绪：换绑到「持久但未验证」的 adapter，并由启动期门禁 fail-closed', async () => {
    // 生产只接受可校验身份的 TLS，因此「配置齐全」必须显式给出 verify-full 档位与证书路径
    const env = loadEnv({
      NODE_ENV: 'production',
      SESSION_SECRET: 'x'.repeat(32),
      DATABASE_URL: 'postgresql://rm:secret@db.internal:5432/researcher_manager',
      DATABASE_SSL_MODE: 'verify-full',
      DATABASE_SSL_CA_PATH: '/etc/rm-tls/ca.pem',
    });

    // 1. 缺执行器工厂：工厂直接抛错（绝不悄悄退回内存）
    expect(() => createComplianceRepository(env, undefined)).toThrow(/拒绝退回内存合规仓储/u);

    // 2. 有执行器工厂：绑定的是延迟建连的 PostgreSQL adapter，装配阶段不建连
    const harness = countingFactory();
    const repository = createComplianceRepository(env, harness.factory);
    expect(repository.capabilities).toEqual(POSTGRES_COMPLIANCE_REPOSITORY_CAPABILITIES);
    expect(repository.capabilities.productionReady).toBe(false);
    expect(harness.connects()).toBe(0);

    // 3. 该绑定在启动期被两道门禁拒绝（都在任何 connect 之前）：
    //    能力边界：自称「持久但未验证」不得进生产
    expect(
      evaluatePersistenceBoundary({
        nodeEnv: 'production',
        databaseConfigured: true,
        bindings: [
          {
            token: COMPLIANCE_REPOSITORY.description ?? 'COMPLIANCE_REPOSITORY',
            label: '合规状态仓储',
            capabilities: repository.capabilities,
          },
        ],
      }).violations.map((item) => item.rule),
    ).toEqual(['BACKEND_NOT_PRODUCTION_READY_IN_PRODUCTION']);

    //    依赖就绪门禁（业务阶段）：未持封存声明与已登记证据 ⇒ DEPENDENCY_NOT_VERIFIED
    const readiness = evaluateDependencyStage({
      required: true,
      role: 'business',
      candidates: [
        {
          token: COMPLIANCE_REPOSITORY.description ?? 'COMPLIANCE_REPOSITORY',
          role: 'business',
          capabilities: repository.capabilities,
        },
      ],
      registry: DEFAULT_DEPENDENCY_READINESS_REGISTRY,
      now: '2026-10-10T00:00:00.000Z',
    });
    expect(readiness.state).toBe('rejected');
    expect(readiness.violations.map((item) => item.code)).toEqual(['DEPENDENCY_NOT_VERIFIED']);
    expect(readiness.violations[0]?.token).toBe('COMPLIANCE_REPOSITORY');
    expect(harness.connects()).toBe(0);
  });
});

/**
 * 归属隔离在**内存基线**上的回归（数据库实现由离线 adapter spec 与真库集成 spec 各自覆盖，
 * 两者必须同语义）。这一组用例固定的是 service 依赖的端口语义：
 * 归属由服务端写入且不可被他人取回，客户端提交的 userId / status / owner 都不是取数入口。
 */
describe('合规端口语义：归属与只读隔离（内存基线）', () => {
  function seededRepository(): InMemoryComplianceRepository {
    const repository = new InMemoryComplianceRepository(loadEnv({ NODE_ENV: 'test' }));
    repository.seed(recordFor(OWNER));
    repository.seed(recordFor(OTHER_OWNER));
    return repository;
  }

  it('归属隔离：每个主体只看得到自己那一条，拿不到他人的合规状态', async () => {
    const repository = seededRepository();

    await expect(repository.findByUserId(OWNER)).resolves.toEqual(recordFor(OWNER));
    await expect(repository.findByUserId(OTHER_OWNER)).resolves.toEqual(recordFor(OTHER_OWNER));
    const mine = await repository.findByUserId(OWNER);
    expect(JSON.stringify(mine)).not.toContain(OTHER_OWNER);
  });

  it('端口只有一个「按主体取数」入口：没有按客户端声明取数、列表或批量导出的入口', () => {
    const repository = seededRepository() as unknown as Record<string, unknown>;
    expect(typeof repository['findByUserId']).toBe('function');
    // 批量 / 未过滤的读取入口一个都不存在（入口越少，越不存在越权面）
    for (const forbidden of [
      'findAll',
      'list',
      'listByOwnerId',
      'findById',
      'findByOwner',
      'query',
    ]) {
      expect(repository[forbidden]).toBeUndefined();
    }
    // 写入口同样一个都不存在（本切片是只读切片）
    for (const forbidden of ['create', 'save', 'insert', 'update', 'upsert', 'delete', 'archive']) {
      expect(repository[forbidden]).toBeUndefined();
    }
  });

  it('未 seed 的主体返回 undefined（由 service 按 fail-closed 处理，绝不凭空给出状态）', async () => {
    const repository = new InMemoryComplianceRepository(loadEnv({ NODE_ENV: 'test' }));
    await expect(repository.findByUserId(OWNER)).resolves.toBeUndefined();
  });

  it('内存基线不把内部可变引用交给调用方：改动返回值不改写存储内容', async () => {
    const repository = seededRepository();
    const first = await repository.findByUserId(OWNER);
    expect(first).toBeDefined();
    (first as { privacyConsent: string }).privacyConsent = 'tampered';

    const second = await repository.findByUserId(OWNER);
    expect(second?.privacyConsent).toBe(PrivacyConsentStatus.Granted);
    expect(second).not.toBe(first);
  });
});

describe('合规令牌与装配常量', () => {
  it('DI 令牌描述名保持不变（登记表与装配按名字比对）', () => {
    expect(COMPLIANCE_REPOSITORY.description).toBe('COMPLIANCE_REPOSITORY');
  });

  it('PostgreSQL adapter 的能力声明如实反映「持久但未验证」', () => {
    expect(POSTGRES_COMPLIANCE_REPOSITORY_CAPABILITIES).toEqual({
      backend: 'postgres',
      persistent: true,
      productionReady: false,
    });
    expect(Object.isFrozen(POSTGRES_COMPLIANCE_REPOSITORY_CAPABILITIES)).toBe(true);
  });

  it('分流点不读环境变量以外的配置来源：同一个 env 只产生一种绑定（重复调用稳定）', () => {
    const env = loadEnv({ NODE_ENV: 'test' });
    const first = createComplianceRepository(env, undefined);
    const second = createComplianceRepository(env, undefined);
    expect(first).toBeInstanceOf(InMemoryComplianceRepository);
    expect(second).toBeInstanceOf(InMemoryComplianceRepository);
    expect(first).not.toBe(second);
  });

  it('会话主体（含客户端可伪造的字段）不参与绑定判定：绑定只按 DATABASE_URL 分流', () => {
    const subject: AuthorizationSubject = {
      userId: SESSION_STYLE_SUBJECT,
      roles: [Role.Student],
    };
    // 主体形状只影响 adapter 的存储 ID 域判定，不影响「绑定到哪个实现」
    expect(createComplianceRepository(loadEnv({ NODE_ENV: 'test' }), undefined)).toBeInstanceOf(
      InMemoryComplianceRepository,
    );
    expect(subject.userId).not.toBe(OWNER);
  });
});

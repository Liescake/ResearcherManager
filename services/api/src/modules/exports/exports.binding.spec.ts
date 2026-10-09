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
import { EXPORTABLE_FIELDS } from './exports.contract';
import { InMemoryExportRepository } from './exports.in-memory-repository';
import { createExportRepository } from './exports.module';
import { POSTGRES_EXPORT_REPOSITORY_CAPABILITIES } from './exports.postgres-repository';
import {
  EXPORT_REPOSITORY,
  EXPORT_REPOSITORY_BACKEND_POSTGRES,
  ExportResource,
  ExportStatus,
  type ExportRequest,
} from './exports.port';

/**
 * 导出切片的**换绑分流点**（`createExportRepository`）：把「导出请求的 PostgreSQL adapter 接入
 * 已配置数据库且执行器/依赖就绪的运行路径」这件事变成可机器判定的性质，而不是靠注释。
 *
 * 1. 未解析出 `DATABASE_URL` → 内存基线（开发/测试行为与换绑之前一致，且如实声明非持久）；
 * 2. 已解析出 `DATABASE_URL` 但拿不到 `SQL_CONNECTION_FACTORY` → **抛错**（fail-closed：
 *    绝不悄悄退回内存导出存储）；
 * 3. 已解析出 `DATABASE_URL` 且拿到执行器工厂 → PostgreSQL adapter，且**延迟建连**：
 *    装配阶段一次都不碰数据库（否则「未 attest 的执行器」「依赖未就绪」就轮不到启动期门禁
 *    来给出结构化违规，而会在这里表现为一个数据库连接错误）。
 *
 * 另外固定本切片特有的安全口径（用户要求的补充回归）：
 * - **存储 ID 域先判、再建连**：非 UUID 的会话主体（基线的 `u-student-1`）在解析执行器
 *   **之前**就被拒绝 —— 写入路径与取数路径都是如此，因此既不进 SQL，也不触发任何连接；
 * - **owner 隔离**：归属只来自服务端主体，写回以 `id + 归属` 双重限定；仓储若返回他人记录
 *   必须判服务端缺陷（`OWNER_VIOLATION`），而不是静默过滤或回流；
 * - **隐私（不落库 / 不外发）**：原始 PII、文件路径、下载地址与签名、对象存储 key、文件体、
 *   内部资源快照、筛选条件与原始错误文本**都不在列清单里**；数据库行一旦多出这些列，
 *   严格行契约必须 fail-closed，且错误信息只含**字段名**、不含任何取值；
 * - **参数化 SQL + 显式列**：主体只出现在参数里，SQL 文本里没有任何取值。
 *
 * 授权先于仓储访问这一半由 `exports.controller.spec.ts` 直接回归（403 时端口零调用），
 * 这里固定的是端口语义、换绑事实与隐私边界。
 */
const LOOPBACK_URL = 'postgresql://postgres:postgres@127.0.0.1:5432/researcher_manager';
const OWNER = '11111111-1111-4111-8111-111111111111';
const OTHER_OWNER = '22222222-2222-4222-8222-222222222222';
/** 会话基线形状的主体（「安全 ID」，但不是 UUID） */
const SESSION_STYLE_SUBJECT = 'u-student-1';
const REQUEST_ID = '33333333-3333-4333-8333-333333333333';
const OTHER_REQUEST_ID = '55555555-5555-4555-8555-555555555555';
const ARTIFACT_ID = '44444444-4444-4444-8444-444444444444';
const TIMESTAMP = '2026-10-10T00:00:00.000Z';
/** 从服务端字段白名单派生，避免把「合法字段」抄成两份真相 */
const FIELDS = EXPORTABLE_FIELDS[ExportResource.Profile].slice(0, 2);

function recordFor(ownerUserId: string, overrides: Partial<ExportRequest> = {}): ExportRequest {
  return {
    id: REQUEST_ID,
    ownerUserId,
    resource: ExportResource.Profile,
    fields: [...FIELDS],
    status: ExportStatus.Pending,
    createdAt: TIMESTAMP,
    updatedAt: TIMESTAMP,
    ...overrides,
  };
}

/** 与 adapter 输出列一一对应的数据库行（严格行契约的合法形态） */
function rowFor(
  ownerUserId: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: REQUEST_ID,
    requester_id: ownerUserId,
    resource: ExportResource.Profile,
    fields: [...FIELDS],
    status: ExportStatus.Pending,
    artifact_id: null,
    created_at: TIMESTAMP,
    updated_at: TIMESTAMP,
    ...overrides,
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

describe('导出仓储的持久化分流（createExportRepository）', () => {
  it('未配置数据库：绑定内存基线，如实声明非持久 / 不可用于生产', async () => {
    const repository = createExportRepository(loadEnv({ NODE_ENV: 'test' }), undefined);

    expect(repository).toBeInstanceOf(InMemoryExportRepository);
    expect(repository.capabilities).toEqual({
      backend: 'in-memory-baseline',
      persistent: false,
      productionReady: false,
    });

    // 行为保持：开发/测试下仍可按服务端主体读写；未写入时返回空数组（不是 undefined）
    const memory = repository as InMemoryExportRepository;
    await expect(repository.listByOwnerId(OWNER)).resolves.toEqual([]);
    await memory.create(recordFor(OWNER));
    await expect(repository.listByOwnerId(OWNER)).resolves.toEqual([recordFor(OWNER)]);
    await expect(repository.listByOwnerId(OTHER_OWNER)).resolves.toEqual([]);
  });

  it('配置了数据库但没有执行器工厂：抛错，绝不静默退回内存导出存储', () => {
    expect(() =>
      createExportRepository(loadEnv({ NODE_ENV: 'test', DATABASE_URL: LOOPBACK_URL }), undefined),
    ).toThrow(/拒绝退回内存导出仓储/u);
  });

  it('配置了数据库且拿到执行器工厂：换绑到 PostgreSQL adapter，且构造时不建连', async () => {
    const harness = countingFactory();
    const repository = createExportRepository(
      loadEnv({ NODE_ENV: 'test', DATABASE_URL: LOOPBACK_URL }),
      harness.factory,
    );

    // 延迟建连：装配阶段一次都没有调用 connect（真正的准入判定属于启动期门禁）
    expect(harness.connects()).toBe(0);
    expect(repository).not.toBeInstanceOf(InMemoryExportRepository);
    expect(repository.capabilities).toEqual(POSTGRES_EXPORT_REPOSITORY_CAPABILITIES);
    expect(repository.capabilities).toMatchObject({
      backend: EXPORT_REPOSITORY_BACKEND_POSTGRES,
      persistent: true,
    });
    expect(repository.capabilities.productionReady).toBe(false);

    // 合法主体、库里没有记录：这时才建连（一次），并按内存基线同语义返回空数组
    await expect(repository.listByOwnerId(OWNER)).resolves.toEqual([]);
    expect(harness.connects()).toBe(1);

    // 连接被复用：第二次取数不再建连
    await expect(repository.listByOwnerId(OWNER)).resolves.toEqual([]);
    expect(harness.connects()).toBe(1);
  });

  it('参数化 SQL + 显式列：主体只出现在参数里，SQL 文本里没有任何取值', async () => {
    const harness = countingFactory([rowFor(OWNER)]);
    const repository = createExportRepository(
      loadEnv({ NODE_ENV: 'test', DATABASE_URL: LOOPBACK_URL }),
      harness.factory,
    );

    await expect(repository.listByOwnerId(OWNER)).resolves.toEqual([recordFor(OWNER)]);

    const [sql] = harness.sql();
    expect(sql).toBeDefined();
    // 显式列清单：不使用 SELECT *，且不选中任何内部列
    expect(sql).toContain(
      'SELECT id, requester_id, resource, fields, status, artifact_id, created_at, updated_at',
    );
    expect(sql).not.toContain('*');
    // 归属下推进 SQL，且是占位符绑定；没有任何内部列（位置 / 凭据 / 原始错误）被选中
    expect(sql).toContain('WHERE requester_id = $1::uuid');
    for (const internal of [
      'file_name',
      'file_path',
      'download_url',
      'signed_url',
      'storage_key',
      'object_key',
      'content',
      'checksum',
      'resource_snapshot',
      'filters',
      'error_message',
      'stack_trace',
      'expires_at',
      'downloaded_at',
      'idempotency_key',
    ]) {
      expect(sql).not.toContain(internal);
    }
    // 取值绝不出现在 SQL 文本里
    expect(sql).not.toContain(OWNER);
    expect(harness.parameters()[0]).toEqual([OWNER]);
  });

  it('存储 ID 域先判、再建连：非 UUID 会话主体在进入 SQL 之前就被拒绝', async () => {
    const harness = countingFactory([rowFor(OWNER)]);
    const repository = createExportRepository(
      loadEnv({ NODE_ENV: 'test', DATABASE_URL: LOOPBACK_URL }),
      harness.factory,
    );

    // 会话基线形状的主体（`u-student-1`）不是存储 ID 域内的标识：拒绝，且**不建连**、不执行 SQL。
    // 这正是「客户端/会话声明的 userId 不得变成 SQL 里的归属谓词」这条不变量在数据库路径上的落点。
    await expect(repository.listByOwnerId(SESSION_STYLE_SUBJECT)).rejects.toMatchObject({
      code: 'INVALID_SUBJECT',
    });
    await expect(repository.listByOwnerId('')).rejects.toMatchObject({ code: 'INVALID_SUBJECT' });
    await expect(
      repository.listByOwnerId('11111111-1111-4111-8111-11111111111Z'),
    ).rejects.toMatchObject({ code: 'INVALID_SUBJECT' });

    // 写入路径同样先判主体域：未授权/非法归属不得先建连再失败
    await expect(repository.create(recordFor(SESSION_STYLE_SUBJECT))).rejects.toMatchObject({
      code: 'INVALID_SUBJECT',
    });
    await expect(repository.save(recordFor(SESSION_STYLE_SUBJECT))).rejects.toMatchObject({
      code: 'INVALID_SUBJECT',
    });

    expect(harness.connects()).toBe(0);
    expect(harness.sql()).toEqual([]);

    // 合法请求才建连（证明上面的拒绝来自校验，而不是「谁都连不上」）
    await expect(repository.listByOwnerId(OWNER)).resolves.toEqual([recordFor(OWNER)]);
    expect(harness.connects()).toBe(1);
  });

  it('owner 隔离：仓储若返回他人记录（未按主体过滤）必须判服务端缺陷，不静默过滤也不外发', async () => {
    const harness = countingFactory([rowFor(OTHER_OWNER)]);
    const repository = createExportRepository(
      loadEnv({ NODE_ENV: 'test', DATABASE_URL: LOOPBACK_URL }),
      harness.factory,
    );

    let captured: unknown;
    try {
      await repository.listByOwnerId(OWNER);
    } catch (error) {
      captured = error;
    }
    expect(captured).toMatchObject({ code: 'OWNER_VIOLATION' });
    // 错误只承载字段路径，不回显任何归属取值
    const serialized = JSON.stringify(captured, Object.getOwnPropertyNames(captured ?? {}));
    expect(serialized).not.toContain(OTHER_OWNER);
    expect(serialized).not.toContain(OWNER);
  });

  it('隐私：未登记列（原始 PII / 文件路径 / 下载签名 / 存储 key / 文件体 / 原始错误）一律 fail-closed', async () => {
    // 这些列**不允许**出现在表里，也不允许被投影：数据库行一旦多出它们就必须整批拒绝
    const leaked = rowFor(OWNER, {
      phone: '13800000000',
      id_card: '110101199001011234',
      file_path: '/srv/exports/2026/secret.xlsx',
      download_url: 'https://cdn.internal/signed?token=abc',
      signed_url: 'https://cdn.internal/signed?token=abc',
      storage_key: 'exports/2026/secret.xlsx',
      content: '原始文件体',
      error_message: 'connection string postgres://rm:pw@db:5432/rm',
    });
    const harness = countingFactory([leaked]);
    const repository = createExportRepository(
      loadEnv({ NODE_ENV: 'test', DATABASE_URL: LOOPBACK_URL }),
      harness.factory,
    );

    let captured: unknown;
    try {
      await repository.listByOwnerId(OWNER);
    } catch (error) {
      captured = error;
    }
    expect(captured).toMatchObject({ code: 'INVALID_ROW' });
    const error = captured as { issues: readonly string[] };
    // 只列出字段名（不是取值）：既让契约漂移可定位，又不泄露数据
    expect(error.issues).toEqual(
      expect.arrayContaining([
        'phone(unexpected)',
        'id_card(unexpected)',
        'file_path(unexpected)',
        'download_url(unexpected)',
        'signed_url(unexpected)',
        'storage_key(unexpected)',
        'content(unexpected)',
        'error_message(unexpected)',
      ]),
    );
    // 任何取值都不得随错误外泄（含路径、签名、存储 key、PII 与连接串）
    const serialized = JSON.stringify(captured, Object.getOwnPropertyNames(captured ?? {}));
    for (const secret of [
      '13800000000',
      '110101199001011234',
      '/srv/exports/2026/secret.xlsx',
      'cdn.internal',
      'token=abc',
      'exports/2026/secret.xlsx',
      '原始文件体',
      'postgres://rm:pw@db:5432/rm',
    ]) {
      expect(serialized).not.toContain(secret);
    }
  });

  it('状态与产物短引用不自洽（completed 无句柄 / 非 completed 带句柄）在读取路径上 fail-closed', async () => {
    for (const inconsistent of [
      rowFor(OWNER, { status: ExportStatus.Completed, artifact_id: null }),
      rowFor(OWNER, { status: ExportStatus.Pending, artifact_id: ARTIFACT_ID }),
      rowFor(OWNER, { status: ExportStatus.Failed, artifact_id: ARTIFACT_ID }),
    ]) {
      const harness = countingFactory([inconsistent]);
      const repository = createExportRepository(
        loadEnv({ NODE_ENV: 'test', DATABASE_URL: LOOPBACK_URL }),
        harness.factory,
      );
      await expect(repository.listByOwnerId(OWNER)).rejects.toMatchObject({ code: 'INVALID_ROW' });
    }
    // 自洽的 completed 记录可以正常往返（证明上面的拒绝来自不自洽，而不是「completed 一律拒绝」）
    const ok = countingFactory([
      rowFor(OWNER, { status: ExportStatus.Completed, artifact_id: ARTIFACT_ID }),
    ]);
    const repository = createExportRepository(
      loadEnv({ NODE_ENV: 'test', DATABASE_URL: LOOPBACK_URL }),
      ok.factory,
    );
    await expect(repository.listByOwnerId(OWNER)).resolves.toEqual([
      recordFor(OWNER, { status: ExportStatus.Completed, artifactId: ARTIFACT_ID }),
    ]);
  });

  it('执行器工厂是 fail-closed 的未验证驱动时：首次读取失败，错误文本不回显连接串', async () => {
    const repository = createExportRepository(
      loadEnv({ NODE_ENV: 'test', DATABASE_URL: LOOPBACK_URL }),
      createUnavailableSqlConnectionFactory('测试：未验证驱动'),
    );

    let captured: unknown;
    try {
      await repository.listByOwnerId(OWNER);
    } catch (error) {
      captured = error;
    }
    expect(captured).toBeInstanceOf(Error);
    const message = String((captured as Error).message);
    expect(message).not.toContain('://');
    expect(message).not.toContain('postgres');
    expect(message).not.toContain('password');
  });

  it('生产环境且未配置数据库：配置解析先于任何绑定失败（不存在生产用内存导出存储）', () => {
    // 生产环境的 fail-closed 有两条，且**顺序固定**：先拒绝「没有数据库」，再轮到内存基线自检。
    // 因此这里断言的是配置层错误，而不是「先构造内存仓储再被它拒绝」。
    expect(() =>
      createExportRepository(
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
    expect(() => createExportRepository(env, undefined)).toThrow(/拒绝退回内存导出仓储/u);

    // 2. 有执行器工厂：绑定的是延迟建连的 PostgreSQL adapter，装配阶段不建连
    const harness = countingFactory();
    const repository = createExportRepository(env, harness.factory);
    expect(repository.capabilities).toEqual(POSTGRES_EXPORT_REPOSITORY_CAPABILITIES);
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
            token: EXPORT_REPOSITORY.description ?? 'EXPORT_REPOSITORY',
            label: '导出请求仓储',
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
          token: EXPORT_REPOSITORY.description ?? 'EXPORT_REPOSITORY',
          role: 'business',
          capabilities: repository.capabilities,
        },
      ],
      registry: DEFAULT_DEPENDENCY_READINESS_REGISTRY,
      now: '2026-10-10T00:00:00.000Z',
    });
    expect(readiness.state).toBe('rejected');
    expect(readiness.violations.map((item) => item.code)).toEqual(['DEPENDENCY_NOT_VERIFIED']);
    expect(readiness.violations[0]?.token).toBe('EXPORT_REPOSITORY');
    expect(harness.connects()).toBe(0);
  });
});

/**
 * 归属隔离与「落库只保存受控状态与短引用」在**内存基线**上的回归（数据库实现由离线 adapter spec
 * 与真库集成 spec 各自覆盖，两者必须同语义）。这一组用例固定的是 service 依赖的端口语义：
 * 归属由服务端写入且不可被他人取回，客户端提交的 userId / status / downloadUrl / storageHandle
 * 都不是取数入口。
 */
describe('导出端口语义：归属隔离与受控落库（内存基线）', () => {
  async function seededRepository(): Promise<InMemoryExportRepository> {
    const repository = new InMemoryExportRepository(loadEnv({ NODE_ENV: 'test' }));
    await repository.create(recordFor(OWNER));
    await repository.create(recordFor(OTHER_OWNER, { id: OTHER_REQUEST_ID }));
    return repository;
  }

  it('归属隔离：每个主体只看得到自己的导出请求，拿不到他人的', async () => {
    const repository = await seededRepository();

    const mine = await repository.listByOwnerId(OWNER);
    expect(mine).toHaveLength(1);
    expect(mine[0]?.ownerUserId).toBe(OWNER);
    const theirs = await repository.listByOwnerId(OTHER_OWNER);
    expect(theirs).toHaveLength(1);
    expect(theirs[0]?.ownerUserId).toBe(OTHER_OWNER);
    expect(JSON.stringify(mine)).not.toContain(OTHER_OWNER);
  });

  it('端口没有「按客户端声明取数」与删除入口：只有 create / save / listByOwnerId', () => {
    const repository = new InMemoryExportRepository(
      loadEnv({ NODE_ENV: 'test' }),
    ) as unknown as Record<string, unknown>;
    for (const present of ['create', 'save', 'listByOwnerId']) {
      expect(typeof repository[present]).toBe('function');
    }
    // 删除 / 归档 / 未过滤读取入口一个都不存在（入口越少，越不存在越权面）
    for (const forbidden of [
      'delete',
      'remove',
      'archive',
      'purge',
      'truncate',
      'upsert',
      'findAll',
      'findById',
      'findByOwner',
      'query',
    ]) {
      expect(repository[forbidden]).toBeUndefined();
    }
  });

  it('落库内容只有受控状态与服务端短引用：记录里没有任何位置、凭据或签名来源', async () => {
    const repository = new InMemoryExportRepository(loadEnv({ NODE_ENV: 'test' }));
    await repository.create(recordFor(OWNER));
    const [stored] = await repository.listByOwnerId(OWNER);

    expect(stored).toBeDefined();
    // 恰好是端口契约的字段集合（多一个字段就是「顺手把不该落库的东西带进来」）
    expect(Object.keys(stored ?? {}).sort()).toEqual(
      ['artifactId', 'createdAt', 'fields', 'id', 'ownerUserId', 'resource', 'status', 'updatedAt']
        .filter((field) => field in (stored ?? {}))
        .sort(),
    );
    // 位置 / 凭据 / 签名 / PII 字段名一个都不存在于记录上
    for (const forbidden of [
      'filePath',
      'fileName',
      'downloadUrl',
      'signedUrl',
      'storageKey',
      'objectKey',
      'storageHandle',
      'content',
      'phone',
      'idCard',
      'errorMessage',
    ]) {
      expect(stored).not.toHaveProperty(forbidden);
    }
  });

  it('未写入的主体返回空数组（由 service 按 fail-closed 处理，绝不凭空给出记录）', async () => {
    const repository = new InMemoryExportRepository(loadEnv({ NODE_ENV: 'test' }));
    await expect(repository.listByOwnerId(OWNER)).resolves.toEqual([]);
  });

  it('内存基线不把内部可变引用交给调用方：改动返回值不改写存储内容', async () => {
    const repository = await seededRepository();
    const first = (await repository.listByOwnerId(OWNER))[0];
    expect(first).toBeDefined();
    (first as { status: ExportStatus }).status = ExportStatus.Failed;
    (first?.fields as unknown as string[]).push('major');

    const second = (await repository.listByOwnerId(OWNER))[0];
    expect(second?.status).toBe(ExportStatus.Pending);
    expect(second?.fields).toEqual(FIELDS);
    expect(second).not.toBe(first);
  });
});

describe('导出令牌与装配常量', () => {
  it('DI 令牌描述名保持不变（登记表与装配按名字比对）', () => {
    expect(EXPORT_REPOSITORY.description).toBe('EXPORT_REPOSITORY');
  });

  it('PostgreSQL adapter 的能力声明如实反映「持久但未验证」', () => {
    expect(POSTGRES_EXPORT_REPOSITORY_CAPABILITIES).toEqual({
      backend: 'postgres',
      persistent: true,
      productionReady: false,
    });
    expect(Object.isFrozen(POSTGRES_EXPORT_REPOSITORY_CAPABILITIES)).toBe(true);
  });

  it('分流点不读环境变量以外的配置来源：同一个 env 只产生一种绑定（重复调用稳定）', () => {
    const env = loadEnv({ NODE_ENV: 'test' });
    const first = createExportRepository(env, undefined);
    const second = createExportRepository(env, undefined);
    expect(first).toBeInstanceOf(InMemoryExportRepository);
    expect(second).toBeInstanceOf(InMemoryExportRepository);
    expect(first).not.toBe(second);
  });

  it('会话主体（含客户端可伪造的字段）不参与绑定判定：绑定只按 DATABASE_URL 分流', () => {
    const subject: AuthorizationSubject = {
      userId: SESSION_STYLE_SUBJECT,
      roles: [Role.Student],
    };
    // 主体形状只影响 adapter 的存储 ID 域判定，不影响「绑定到哪个实现」
    expect(createExportRepository(loadEnv({ NODE_ENV: 'test' }), undefined)).toBeInstanceOf(
      InMemoryExportRepository,
    );
    expect(subject.userId).not.toBe(OWNER);
  });
});

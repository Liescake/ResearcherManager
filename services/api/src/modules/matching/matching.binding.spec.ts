import { describe, expect, it } from 'vitest';
import { AiErrorCode } from '@rm/ai-adapter';
import { MatchingRequestStatus, Role } from '@rm/shared';
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
import { InMemoryMatchingRepository } from './matching.in-memory-repository';
import { createMatchingRepository } from './matching.module';
import {
  POSTGRES_MATCHING_COLUMNS,
  POSTGRES_MATCHING_REPOSITORY_CAPABILITIES,
} from './matching.postgres-repository';
import {
  MATCHING_REPOSITORY,
  MATCHING_REPOSITORY_BACKEND_POSTGRES,
  type MatchingAccessScope,
  type MatchingRequest,
} from './matching.port';

/**
 * 匹配切片的**换绑分流点**（`createMatchingRepository`）：把「匹配记录的 PostgreSQL adapter 接入
 * 已配置数据库且执行器 / 依赖就绪的运行路径」变成可机器判定的性质，而不是靠注释。
 *
 * ## 分流口径（三态，fail-closed）
 * 1. 未解析出 `DATABASE_URL` → 内存基线（开发/测试行为与此前一致，且如实声明非持久）；
 * 2. 已解析出 `DATABASE_URL` 但拿不到 `SQL_CONNECTION_FACTORY` → **抛错**（绝不悄悄退回内存存储）；
 * 3. 已解析出 `DATABASE_URL` 且拿到执行器工厂 → PostgreSQL adapter，且**延迟建连**：
 *    装配阶段一次都不碰数据库（否则「未 attest 的执行器」「依赖未就绪」就轮不到启动期门禁给出
 *    结构化违规，而会在这里表现为一个数据库连接错误）。
 *
 * ## 本切片特有的安全口径（用户要求的补充回归）
 * - **存储 ID 域先判、再建连**：非 UUID 的会话主体（基线的 `u-student-1`）与非 UUID 的授权小组
 *   标识在解析执行器**之前**就被拒绝 —— 读、写路径都是如此，因此既不进 SQL，也不触发任何连接；
 * - **owner 隔离**：归属只来自服务端主体，写回以 `id + 归属` 双重限定；仓储若返回他人记录必须判
 *   服务端缺陷（`OWNER_VIOLATION`），而不是静默过滤或回流；
 * - **小组授权边界**：记录里的推荐小组越出 `MatchingAccessScope.authorizedGroupIds` 即
 *   `GROUP_SCOPE_VIOLATION` fail-closed（**不静默过滤**）；
 * - **隐私（不落库 / 不外发）**：原始 AI 输入 / 特征快照 / 提示词 / 模型 payload、PII、内部评分与
 *   审核字段**都不在列清单里**；数据库行一旦多出这些列，严格行契约必须 fail-closed，且错误信息
 *   只含**字段名**、不含任何取值；
 * - **参数化 SQL + 显式列**：主体只出现在参数里，SQL 文本里没有任何取值，且不使用 `SELECT *`。
 *
 * 「授权先于仓储访问」这一半由 `matching.controller.spec.ts` / `matching.service.spec.ts` 直接回归
 * （403 / 400 时端口零调用），这里固定的是端口语义、换绑事实与隐私边界。
 */
const LOOPBACK_URL = 'postgresql://postgres:postgres@127.0.0.1:5432/researcher_manager';
const OWNER = '11111111-1111-4111-8111-111111111111';
const OTHER_OWNER = '22222222-2222-4222-8222-222222222222';
const GROUP = '33333333-3333-4333-8333-333333333333';
const OTHER_GROUP = '44444444-4444-4444-8444-444444444444';
const REQUEST_ID = '55555555-5555-4555-8555-555555555555';
const OTHER_REQUEST_ID = '66666666-6666-4666-8666-666666666666';
/** 会话基线形状的主体（「安全 ID」，但不是 UUID） */
const SESSION_STYLE_SUBJECT = 'u-student-1';
const HASH = 'a1'.repeat(32);
const TIMESTAMP = '2026-10-10T00:00:00.000Z';

const SCOPE: MatchingAccessScope = { ownerUserId: OWNER, authorizedGroupIds: [GROUP] };

/** 入口记录（`pending`，推荐为空） */
function entryFor(ownerUserId: string, overrides: Partial<MatchingRequest> = {}): MatchingRequest {
  return {
    id: REQUEST_ID,
    userId: ownerUserId,
    status: MatchingRequestStatus.Pending,
    inputSnapshotHash: HASH,
    recommendations: [],
    modelVersion: 'rule-fallback-v1',
    promptVersion: 'match-prompt-v1',
    fallbackUsed: true,
    createdAt: TIMESTAMP,
    updatedAt: TIMESTAMP,
    ...overrides,
  };
}

/** 终态记录（`completed`，一条已授权推荐） */
function completedFor(
  ownerUserId: string,
  overrides: Partial<MatchingRequest> = {},
): MatchingRequest {
  return entryFor(ownerUserId, {
    status: MatchingRequestStatus.Completed,
    recommendations: [{ groupId: GROUP, score: 88, reason: '方向一致', advice: '补齐技能' }],
    degradationCode: AiErrorCode.Disabled,
    ...overrides,
  });
}

/** 与 adapter 输出列一一对应的数据库行（严格行契约的合法形态） */
function rowFor(
  ownerUserId: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: REQUEST_ID,
    user_id: ownerUserId,
    status: MatchingRequestStatus.Pending,
    profile_version: null,
    input_snapshot_hash: HASH,
    recommendations: [],
    model_version: 'rule-fallback-v1',
    prompt_version: 'match-prompt-v1',
    fallback_used: true,
    degradation_code: null,
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

describe('匹配仓储的持久化分流（createMatchingRepository）', () => {
  it('未配置数据库：绑定内存基线，如实声明非持久 / 不可用于生产，且语义不变', async () => {
    const repository = createMatchingRepository(loadEnv({ NODE_ENV: 'test' }), undefined);

    expect(repository).toBeInstanceOf(InMemoryMatchingRepository);
    expect(repository.capabilities).toEqual({
      backend: 'in-memory-baseline',
      persistent: false,
      productionReady: false,
    });

    // 行为保持：仍可按服务端主体读写；未写入时返回空数组（不是 undefined）
    await expect(repository.listByUserId(SCOPE)).resolves.toEqual([]);
    await expect(repository.create(entryFor(OWNER), SCOPE)).resolves.toEqual(entryFor(OWNER));
    await expect(repository.listByUserId(SCOPE)).resolves.toEqual([entryFor(OWNER)]);
    await expect(
      repository.listByUserId({ ownerUserId: OTHER_OWNER, authorizedGroupIds: [] }),
    ).resolves.toEqual([]);
  });

  it('配置了数据库但没有执行器工厂：抛错，绝不静默退回内存匹配存储', () => {
    expect(() =>
      createMatchingRepository(
        loadEnv({ NODE_ENV: 'test', DATABASE_URL: LOOPBACK_URL }),
        undefined,
      ),
    ).toThrow(/拒绝退回内存匹配仓储/u);
  });

  it('配置了数据库且拿到执行器工厂：换绑到 PostgreSQL adapter，且构造时不建连', async () => {
    const harness = countingFactory();
    const repository = createMatchingRepository(
      loadEnv({ NODE_ENV: 'test', DATABASE_URL: LOOPBACK_URL }),
      harness.factory,
    );

    // 延迟建连：装配阶段一次都没有调用 connect（真正的准入判定属于启动期门禁）
    expect(harness.connects()).toBe(0);
    expect(repository).not.toBeInstanceOf(InMemoryMatchingRepository);
    expect(repository.capabilities).toEqual(POSTGRES_MATCHING_REPOSITORY_CAPABILITIES);
    expect(repository.capabilities).toMatchObject({
      backend: MATCHING_REPOSITORY_BACKEND_POSTGRES,
      persistent: true,
    });
    expect(repository.capabilities.productionReady).toBe(false);

    // 合法主体、库里没有记录：这时才建连（一次），并按内存基线同语义返回空数组
    await expect(repository.listByUserId(SCOPE)).resolves.toEqual([]);
    expect(harness.connects()).toBe(1);

    // 连接被复用：第二次取数不再建连
    await expect(repository.listByUserId(SCOPE)).resolves.toEqual([]);
    expect(harness.connects()).toBe(1);
  });

  it('参数化 SQL + 显式列：主体只出现在参数里，SQL 文本里没有任何取值', async () => {
    const harness = countingFactory([rowFor(OWNER)]);
    const repository = createMatchingRepository(
      loadEnv({ NODE_ENV: 'test', DATABASE_URL: LOOPBACK_URL }),
      harness.factory,
    );

    await expect(repository.listByUserId(SCOPE)).resolves.toEqual([entryFor(OWNER)]);

    const [sql] = harness.sql();
    expect(sql).toBeDefined();
    // 显式列清单：不使用 SELECT *，且不选中任何内部列
    expect(sql).toContain(`SELECT ${POSTGRES_MATCHING_COLUMNS.join(', ')}`);
    expect(sql).not.toContain('*');
    // 归属下推进 SQL，且是占位符绑定；没有任何内部列（原始 AI 输入 / 提示词 / 评分 / 审核）被选中
    expect(sql).toContain('WHERE user_id = $1::uuid');
    for (const internal of [
      'ai_input',
      'student_profile',
      'prompt_text',
      'model_payload',
      'raw_response',
      'phone',
      'internal_score',
      'score_breakdown',
      'review_note',
      'error_message',
    ]) {
      expect(sql).not.toContain(internal);
    }
    // 取值绝不出现在 SQL 文本里
    expect(sql).not.toContain(OWNER);
    expect(harness.parameters()[0]).toEqual([OWNER]);
  });

  it('存储 ID 域先判、再建连：非 UUID 会话主体/小组/记录 ID 在进入 SQL 之前就被拒绝', async () => {
    const harness = countingFactory([rowFor(OWNER)]);
    const repository = createMatchingRepository(
      loadEnv({ NODE_ENV: 'test', DATABASE_URL: LOOPBACK_URL }),
      harness.factory,
    );

    // 会话基线形状的主体（`u-student-1`）不是存储 ID 域内的标识：拒绝，且**不建连**、不执行 SQL。
    // 这正是「客户端 / 会话声明的 userId 不得变成 SQL 里的归属谓词」这条不变量在数据库路径上的落点。
    await expect(
      repository.listByUserId({ ownerUserId: SESSION_STYLE_SUBJECT, authorizedGroupIds: [] }),
    ).rejects.toMatchObject({ code: 'INVALID_SUBJECT' });
    await expect(
      repository.listByUserId({ ownerUserId: '', authorizedGroupIds: [] }),
    ).rejects.toMatchObject({ code: 'INVALID_SUBJECT' });
    // 非 UUID 的已授权小组标识同样属于服务端缺陷，不得进入 SQL
    await expect(
      repository.listByUserId({ ownerUserId: OWNER, authorizedGroupIds: ['g-1'] }),
    ).rejects.toMatchObject({ code: 'INVALID_SCOPE' });

    // 写入路径同样先判主体域与记录 ID：未授权 / 非法归属不得先建连再失败
    await expect(
      repository.create(entryFor(SESSION_STYLE_SUBJECT), {
        ownerUserId: SESSION_STYLE_SUBJECT,
        authorizedGroupIds: [],
      }),
    ).rejects.toMatchObject({ code: 'INVALID_SUBJECT' });
    await expect(
      repository.create(entryFor(OWNER, { id: 'not-a-uuid' }), SCOPE),
    ).rejects.toMatchObject({ code: 'INVALID_RECORD' });
    // 非入口态记录不得走 create（状态只能由服务端状态机推进）
    await expect(repository.create(completedFor(OWNER), SCOPE)).rejects.toMatchObject({
      code: 'INVALID_RECORD',
    });

    expect(harness.connects()).toBe(0);
    expect(harness.sql()).toEqual([]);

    // 合法请求才建连（证明上面的拒绝来自校验，而不是「谁都连不上」）
    await expect(repository.listByUserId(SCOPE)).resolves.toEqual([entryFor(OWNER)]);
    expect(harness.connects()).toBe(1);
  });

  it('授权边界形状自洽：闭集之外的字段、缺失主体、非数组小组集合一律拒绝', async () => {
    const harness = countingFactory([rowFor(OWNER)]);
    const repository = createMatchingRepository(
      loadEnv({ NODE_ENV: 'test', DATABASE_URL: LOOPBACK_URL }),
      harness.factory,
    );

    for (const scope of [
      { ownerUserId: OWNER, authorizedGroupIds: [], userId: OTHER_OWNER },
      { authorizedGroupIds: [] },
      { ownerUserId: OWNER },
      { ownerUserId: OWNER, authorizedGroupIds: [GROUP, null] },
      undefined,
    ] as unknown[]) {
      await expect(repository.listByUserId(scope as MatchingAccessScope)).rejects.toMatchObject({
        code: expect.stringMatching(/^INVALID_(SCOPE|SUBJECT)$/u) as unknown as string,
      });
    }
    expect(harness.connects()).toBe(0);
  });

  it('owner 隔离：仓储若返回他人记录（未按主体过滤）必须判服务端缺陷，不静默过滤也不外发', async () => {
    const harness = countingFactory([rowFor(OTHER_OWNER)]);
    const repository = createMatchingRepository(
      loadEnv({ NODE_ENV: 'test', DATABASE_URL: LOOPBACK_URL }),
      harness.factory,
    );

    let captured: unknown;
    try {
      await repository.listByUserId(SCOPE);
    } catch (error) {
      captured = error;
    }
    expect(captured).toMatchObject({ code: 'OWNER_VIOLATION' });
    // 错误只承载字段路径，不回显任何归属取值
    const serialized = JSON.stringify(captured, Object.getOwnPropertyNames(captured ?? {}));
    expect(serialized).not.toContain(OTHER_OWNER);
    expect(serialized).not.toContain(OWNER);
  });

  it('小组授权边界：返回记录里出现未授权小组必须 fail-closed（不静默过滤）', async () => {
    const harness = countingFactory([
      rowFor(OWNER, {
        status: MatchingRequestStatus.Completed,
        recommendations: [
          { groupId: OTHER_GROUP, score: 70, reason: '方向一致', advice: '补齐技能' },
        ],
      }),
    ]);
    const repository = createMatchingRepository(
      loadEnv({ NODE_ENV: 'test', DATABASE_URL: LOOPBACK_URL }),
      harness.factory,
    );

    let captured: unknown;
    try {
      await repository.listByUserId(SCOPE);
    } catch (error) {
      captured = error;
    }
    expect(captured).toMatchObject({ code: 'GROUP_SCOPE_VIOLATION' });
    const serialized = JSON.stringify(captured, Object.getOwnPropertyNames(captured ?? {}));
    expect(serialized).not.toContain(OTHER_GROUP);
  });

  it('写入路径同样判小组边界，且判定发生在进入 SQL 之前（无副作用）', async () => {
    const harness = countingFactory([rowFor(OWNER)]);
    const repository = createMatchingRepository(
      loadEnv({ NODE_ENV: 'test', DATABASE_URL: LOOPBACK_URL }),
      harness.factory,
    );

    await expect(
      repository.save(
        completedFor(OWNER, {
          recommendations: [
            { groupId: OTHER_GROUP, score: 70, reason: '方向一致', advice: '补齐技能' },
          ],
        }),
        SCOPE,
      ),
    ).rejects.toMatchObject({ code: 'GROUP_SCOPE_VIOLATION' });
    expect(harness.connects()).toBe(0);
    expect(harness.sql()).toEqual([]);
  });

  it('隐私：未登记列（原始 AI 输入 / 提示词 / 模型 payload / PII / 内部评分 / 审核 / 原始错误）一律 fail-closed', async () => {
    // 这些列**不允许**出现在表里，也不允许被投影：数据库行一旦多出它们就必须整批拒绝
    const leaked = rowFor(OWNER, {
      ai_input: '学生画像原文',
      student_profile: '{"name":"张三"}',
      prompt_text: '系统提示词',
      model_payload: '{"raw":true}',
      raw_response: '模型原始响应',
      phone: '13800000000',
      student_no: '2023123456',
      internal_score: 91.5,
      score_breakdown: '{"skill":0.8}',
      review_note: '管理员备注',
      error_message: 'connection string postgres://rm:pw@db:5432/rm',
    });
    const harness = countingFactory([leaked]);
    const repository = createMatchingRepository(
      loadEnv({ NODE_ENV: 'test', DATABASE_URL: LOOPBACK_URL }),
      harness.factory,
    );

    let captured: unknown;
    try {
      await repository.listByUserId(SCOPE);
    } catch (error) {
      captured = error;
    }
    expect(captured).toMatchObject({ code: 'INVALID_ROW' });
    const error = captured as { issues: readonly string[] };
    // 只列出字段名（不是取值）：既让契约漂移可定位，又不泄露数据
    expect(error.issues).toEqual(
      expect.arrayContaining([
        'ai_input(unexpected)',
        'student_profile(unexpected)',
        'prompt_text(unexpected)',
        'model_payload(unexpected)',
        'raw_response(unexpected)',
        'phone(unexpected)',
        'student_no(unexpected)',
        'internal_score(unexpected)',
        'score_breakdown(unexpected)',
        'review_note(unexpected)',
        'error_message(unexpected)',
      ]),
    );
    // 任何取值都不得随错误外泄（含画像原文、提示词、模型响应、PII 与连接串）
    const serialized = JSON.stringify(captured, Object.getOwnPropertyNames(captured ?? {}));
    for (const secret of [
      '学生画像原文',
      '张三',
      '系统提示词',
      '{"raw":true}',
      '模型原始响应',
      '13800000000',
      '2023123456',
      '91.5',
      '{"skill":0.8}',
      '管理员备注',
      'postgres://rm:pw@db:5432/rm',
    ]) {
      expect(serialized).not.toContain(secret);
    }
  });

  it('数据库行缺列 / 未知状态 / 未知降级码 / 推荐条目夹带内部字段 → fail-closed', async () => {
    const cases: readonly Record<string, unknown>[] = [
      // 缺列（PG 对 SELECT 列表里的列一定返回键，缺键说明驱动或 SQL 被改动）
      (() => {
        const { degradation_code: _omitted, ...rest } = rowFor(OWNER);
        return rest;
      })(),
      rowFor(OWNER, { status: 'unknown_status' }),
      rowFor(OWNER, { degradation_code: 'AI_NOT_REGISTERED' }),
      rowFor(OWNER, {
        recommendations: [
          {
            groupId: GROUP,
            score: 70,
            reason: '方向一致',
            advice: '补齐技能',
            modelPayload: '{"raw":true}',
          },
        ],
      }),
    ];

    for (const row of cases) {
      const harness = countingFactory([row]);
      const repository = createMatchingRepository(
        loadEnv({ NODE_ENV: 'test', DATABASE_URL: LOOPBACK_URL }),
        harness.factory,
      );
      await expect(repository.listByUserId(SCOPE)).rejects.toMatchObject({
        code: expect.stringMatching(/^INVALID_(ROW|RECORD)$/u) as unknown as string,
      });
    }
  });

  it('执行器工厂是 fail-closed 的未验证驱动时：首次读取失败，错误文本不回显连接串', async () => {
    const repository = createMatchingRepository(
      loadEnv({ NODE_ENV: 'test', DATABASE_URL: LOOPBACK_URL }),
      createUnavailableSqlConnectionFactory('测试：未验证驱动'),
    );

    let captured: unknown;
    try {
      await repository.listByUserId(SCOPE);
    } catch (error) {
      captured = error;
    }
    expect(captured).toBeInstanceOf(Error);
    const message = String((captured as Error).message);
    expect(message).not.toContain('://');
    expect(message).not.toContain('postgres');
    expect(message).not.toContain('password');
  });

  it('生产环境且未配置数据库：配置解析先于任何绑定失败（不存在生产用内存匹配存储）', () => {
    expect(() =>
      createMatchingRepository(
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
    expect(() => createMatchingRepository(env, undefined)).toThrow(/拒绝退回内存匹配仓储/u);

    // 2. 有执行器工厂：绑定的是延迟建连的 PostgreSQL adapter，装配阶段不建连
    const harness = countingFactory();
    const repository = createMatchingRepository(env, harness.factory);
    expect(repository.capabilities).toEqual(POSTGRES_MATCHING_REPOSITORY_CAPABILITIES);
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
            token: MATCHING_REPOSITORY.description ?? 'MATCHING_REPOSITORY',
            label: '匹配记录仓储',
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
          token: MATCHING_REPOSITORY.description ?? 'MATCHING_REPOSITORY',
          role: 'business',
          capabilities: repository.capabilities,
        },
      ],
      registry: DEFAULT_DEPENDENCY_READINESS_REGISTRY,
      now: '2026-10-10T00:00:00.000Z',
    });
    expect(readiness.state).toBe('rejected');
    expect(readiness.violations.map((item) => item.code)).toEqual(['DEPENDENCY_NOT_VERIFIED']);
    expect(readiness.violations[0]?.token).toBe('MATCHING_REPOSITORY');
    expect(harness.connects()).toBe(0);
  });
});

/**
 * 端口语义在**内存基线**上的回归（数据库实现由离线 adapter spec 与真库集成 spec 各自覆盖，
 * 两者必须同语义）。这里固定的是 service 依赖的端口语义：归属只来自服务端，小组边界 fail-closed，
 * 客户端声明的 userId / groupId / status / recommendations 都不是取数入口。
 */
describe('匹配端口语义：归属隔离、小组边界与受控落库（内存基线）', () => {
  function repository(): InMemoryMatchingRepository {
    return new InMemoryMatchingRepository(loadEnv({ NODE_ENV: 'test' }));
  }

  it('归属隔离：每个主体只看得到自己的匹配请求，拿不到他人的', async () => {
    const store = repository();
    await store.create(entryFor(OWNER), SCOPE);
    await store.create(entryFor(OTHER_OWNER, { id: OTHER_REQUEST_ID }), {
      ownerUserId: OTHER_OWNER,
      authorizedGroupIds: [],
    });

    const mine = await store.listByUserId(SCOPE);
    expect(mine).toHaveLength(1);
    expect(mine[0]?.userId).toBe(OWNER);
    const theirs = await store.listByUserId({ ownerUserId: OTHER_OWNER, authorizedGroupIds: [] });
    expect(theirs).toHaveLength(1);
    expect(theirs[0]?.userId).toBe(OTHER_OWNER);
    expect(JSON.stringify(mine)).not.toContain(OTHER_OWNER);
  });

  it('写入归属与访问主体不一致 / 越权小组 / 同 ID 冲突 / 覆盖未知 ID 一律 fail-closed', async () => {
    const store = repository();

    await expect(
      store.create(entryFor(OTHER_OWNER, { id: OTHER_REQUEST_ID }), SCOPE),
    ).rejects.toMatchObject({ code: 'OWNER_VIOLATION' });
    await expect(
      store.save(
        completedFor(OWNER, {
          recommendations: [
            { groupId: OTHER_GROUP, score: 60, reason: '方向一致', advice: '补齐技能' },
          ],
        }),
        SCOPE,
      ),
    ).rejects.toMatchObject({ code: 'GROUP_SCOPE_VIOLATION' });

    await store.create(entryFor(OWNER), SCOPE);
    await expect(store.create(entryFor(OWNER), SCOPE)).rejects.toMatchObject({
      code: 'CONFLICT',
    });
    await expect(
      store.save(entryFor(OWNER, { id: OTHER_REQUEST_ID }), SCOPE),
    ).rejects.toMatchObject({ code: 'UPDATE_MISSING' });
  });

  it('单条取数不区分「不存在」与「他人记录」：统一 undefined，不可探测', async () => {
    const store = repository();
    await store.create(entryFor(OTHER_OWNER, { id: OTHER_REQUEST_ID }), {
      ownerUserId: OTHER_OWNER,
      authorizedGroupIds: [],
    });

    await expect(store.findById(OTHER_REQUEST_ID, SCOPE)).resolves.toBeUndefined();
    await expect(store.findById('missing', SCOPE)).resolves.toBeUndefined();
  });

  it('落库内容只有端口契约的字段：没有任何位置、凭据、原始 AI 输入或 PII 字段', async () => {
    const store = repository();
    await store.create(completedFor(OWNER), SCOPE);
    const [stored] = await store.listByUserId(SCOPE);

    expect(stored).toBeDefined();
    expect(Object.keys(stored ?? {}).sort()).toEqual(
      [
        'createdAt',
        'degradationCode',
        'fallbackUsed',
        'id',
        'inputSnapshotHash',
        'modelVersion',
        'promptVersion',
        'recommendations',
        'status',
        'updatedAt',
        'userId',
      ].sort(),
    );
    // 推荐条目恰是白名单四字段（多一个字段就是「顺手把不该落库的东西带进来」）
    expect(Object.keys(stored?.recommendations[0] ?? {}).sort()).toEqual([
      'advice',
      'groupId',
      'reason',
      'score',
    ]);
    for (const forbidden of [
      'modelPayload',
      'rawResponse',
      'promptText',
      'aiInput',
      'phone',
      'studentNo',
      'internalScore',
      'reviewNote',
      'errorMessage',
    ]) {
      expect(stored).not.toHaveProperty(forbidden);
    }
  });

  it('内存基线不把内部可变引用交给调用方：改动返回值不改写存储内容', async () => {
    const store = repository();
    await store.create(completedFor(OWNER), SCOPE);
    const first = (await store.listByUserId(SCOPE))[0];
    expect(first).toBeDefined();
    (first as { status: MatchingRequestStatus }).status = MatchingRequestStatus.Failed;
    (first?.recommendations as unknown as { score: number }[])[0]!.score = 1;

    const second = (await store.listByUserId(SCOPE))[0];
    expect(second?.status).toBe(MatchingRequestStatus.Completed);
    expect(second?.recommendations[0]?.score).toBe(88);
    expect(second).not.toBe(first);
  });

  it('端口没有「按客户端声明取数」与删除入口：只有 create / save / findById / listByUserId', () => {
    const store = repository() as unknown as Record<string, unknown>;
    for (const present of ['create', 'save', 'findById', 'listByUserId']) {
      expect(typeof store[present]).toBe('function');
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
      'findByOwner',
      'listAll',
      'query',
    ]) {
      expect(store[forbidden]).toBeUndefined();
    }
  });
});

describe('匹配令牌与装配常量', () => {
  it('DI 令牌描述名保持不变（登记表与装配按名字比对）', () => {
    expect(MATCHING_REPOSITORY.description).toBe('MATCHING_REPOSITORY');
  });

  it('PostgreSQL adapter 的能力声明如实反映「持久但未验证」', () => {
    expect(POSTGRES_MATCHING_REPOSITORY_CAPABILITIES).toEqual({
      backend: 'postgres',
      persistent: true,
      productionReady: false,
    });
    expect(Object.isFrozen(POSTGRES_MATCHING_REPOSITORY_CAPABILITIES)).toBe(true);
  });

  it('分流点不读环境变量以外的配置来源：同一个 env 只产生一种绑定（重复调用稳定）', () => {
    const env = loadEnv({ NODE_ENV: 'test' });
    const first = createMatchingRepository(env, undefined);
    const second = createMatchingRepository(env, undefined);
    expect(first).toBeInstanceOf(InMemoryMatchingRepository);
    expect(second).toBeInstanceOf(InMemoryMatchingRepository);
    expect(first).not.toBe(second);
  });

  it('会话主体（含客户端可伪造的字段）不参与绑定判定：绑定只按 DATABASE_URL 分流', () => {
    const subject: AuthorizationSubject = {
      userId: SESSION_STYLE_SUBJECT,
      roles: [Role.Student],
    };
    // 主体形状只影响 adapter 的存储 ID 域判定，不影响「绑定到哪个实现」
    expect(createMatchingRepository(loadEnv({ NODE_ENV: 'test' }), undefined)).toBeInstanceOf(
      InMemoryMatchingRepository,
    );
    expect(subject.userId).not.toBe(OWNER);
  });
});

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { GROUP_STATUS_VALUES, GroupStatus } from '@rm/shared';
import { describeSchemaDraftFile } from '../../db/migrations/schema-draft';
import type {
  PersistenceCapabilities,
  SqlExecutor,
  SqlQueryResult,
} from '../../db/ports/sql-executor.port';
import type { AsyncGroupRepository, ResearchGroup } from './groups.port';
import { GROUP_REPOSITORY_BACKEND_POSTGRES } from './groups.port';
import {
  POSTGRES_GROUP_COLUMNS,
  POSTGRES_GROUP_REPOSITORY_CAPABILITIES,
  POSTGRES_GROUP_REPOSITORY_VERIFICATION_STEPS,
  POSTGRES_GROUP_TABLE,
  POSTGRES_GROUP_VISIBILITY_PREDICATE,
  PostgresGroupRepository,
  PostgresGroupRepositoryError,
  assertPostgresGroupRepositoryCapabilities,
} from './groups.postgres-repository';

/**
 * PostgreSQL 小组仓储 adapter 的**离线**验收（不连数据库、不引驱动）。
 *
 * 覆盖四类要求：
 * - 参数化 SQL：客户端可控值只出现在参数里，SQL 文本只由模块常量构成；
 * - 显式字段映射 + 严格输出校验：未登记列 / 未知 JSON 键 / 非法枚举 / 坏时间戳一律拒绝；
 * - subject 与 visibility 边界：归属必须来自服务端主体，范围外或非开放记录不得回流；
 * - fail-closed：没有执行器、执行器不合规、结果不合规都在构造或调用处直接抛错。
 */

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

const REPO_ROOT = findRepoRoot(process.cwd());
const ADAPTER_PATH = resolve(
  process.cwd(),
  'src',
  'modules',
  'groups',
  'groups.postgres-repository.ts',
);

interface RecordedCall {
  readonly sql: string;
  readonly parameters: readonly unknown[] | undefined;
}

/**
 * 记录型假执行器：只记录 SQL 与参数、按预设顺序返回结果，不连数据库。
 *
 * 能力声明刻意写成「postgres + persistent」：adapter 会拒绝非持久后端（内存替身），
 * 因此替身必须如实声明自己代表的是持久化 PostgreSQL。
 */
class RecordingExecutor implements SqlExecutor {
  capabilities: PersistenceCapabilities = {
    backend: 'postgres-test-double',
    persistent: true,
    productionReady: false,
  };

  readonly calls: RecordedCall[] = [];
  private readonly responses: unknown[];

  constructor(responses: unknown[] = []) {
    this.responses = [...responses];
  }

  query<Row = Record<string, unknown>>(
    sql: string,
    parameters?: readonly unknown[],
  ): Promise<SqlQueryResult<Row>> {
    this.calls.push({ sql, parameters });
    const next = (this.responses.shift() ?? { rows: [], rowCount: 0 }) as SqlQueryResult<Row>;
    return Promise.resolve(next);
  }
}

const GROUP_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_GROUP_ID = '33333333-3333-4333-8333-333333333333';
const LEADER_ID = '22222222-2222-4222-8222-222222222222';
const OTHER_LEADER_ID = '44444444-4444-4444-8444-444444444444';

const GROUP: ResearchGroup = {
  id: GROUP_ID,
  name: '可信数据空间小组',
  description: '研究数据要素流通',
  researchDirections: ['数据要素', '隐私计算'],
  recruitmentRequirements: { skills: ['TypeScript'], headcount: 3 },
  leaderUserId: LEADER_ID,
  status: GroupStatus.Open,
  createdAt: '2026-01-02T03:04:05.000Z',
  updatedAt: '2026-01-02T03:04:05.000Z',
};

/** 数据库行（snake_case），默认与 GROUP 等价 */
function rowFromGroup(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: GROUP.id,
    name: GROUP.name,
    description: GROUP.description ?? null,
    research_directions: ['数据要素', '隐私计算'],
    recruitment_requirements: { skills: ['TypeScript'], headcount: 3 },
    leader_user_id: GROUP.leaderUserId,
    status: 'open',
    created_at: new Date('2026-01-02T03:04:05Z'),
    updated_at: new Date('2026-01-02T03:04:05Z'),
    ...overrides,
  };
}

async function captureRepoError(
  run: () => Promise<unknown>,
): Promise<PostgresGroupRepositoryError> {
  let captured: unknown;
  try {
    await run();
  } catch (error) {
    captured = error;
  }
  expect(captured).toBeInstanceOf(PostgresGroupRepositoryError);
  return captured as PostgresGroupRepositoryError;
}

function captureSyncError(run: () => unknown): PostgresGroupRepositoryError {
  let captured: unknown;
  try {
    run();
  } catch (error) {
    captured = error;
  }
  expect(captured).toBeInstanceOf(PostgresGroupRepositoryError);
  return captured as PostgresGroupRepositoryError;
}

/** SQL 里出现的占位符序号（去重升序），用于断言「占位符数量 === 参数数量」 */
function placeholderIndexes(sql: string): number[] {
  return [...new Set([...sql.matchAll(/\$(\d+)/gu)].map((match) => Number(match[1])))].sort(
    (left, right) => left - right,
  );
}

const OPEN_VISIBILITY = { includeAllOpenGroups: true, visibleGroupIds: [] } as const;
const SCOPED_WINDOW = { offset: 0, limit: 10 } as const;

describe('PostgreSQL 小组仓储：能力声明不声称生产可用', () => {
  it('能力声明恰好是 postgres / persistent=true / productionReady=false，且被冻结', () => {
    expect(POSTGRES_GROUP_REPOSITORY_CAPABILITIES).toEqual({
      backend: 'postgres',
      persistent: true,
      productionReady: false,
    });
    expect(GROUP_REPOSITORY_BACKEND_POSTGRES).toBe('postgres');
    expect(Object.isFrozen(POSTGRES_GROUP_REPOSITORY_CAPABILITIES)).toBe(true);
  });

  it('验证清单覆盖「驱动 → 集成 → 迁移 → 异步端口 → 才可声明生产」五步', () => {
    expect(POSTGRES_GROUP_REPOSITORY_VERIFICATION_STEPS).toEqual([
      'driver-dependency-evaluated',
      'integration-tests-against-real-postgres',
      'schema-draft-promoted-to-migration',
      'group-repository-port-migrated-to-async',
      'production-ready-capability-flipped-with-evidence',
    ]);
  });

  it('自检放行当前声明，但拒绝「未验证就声称生产可用」', () => {
    expect(() => assertPostgresGroupRepositoryCapabilities()).not.toThrow();

    const promoted = captureSyncError(() =>
      assertPostgresGroupRepositoryCapabilities({
        backend: 'postgres',
        persistent: true,
        productionReady: true,
      }),
    );
    expect(promoted.code).toBe('CAPABILITY_MISDECLARED');
    expect(promoted.issues).toContain('productionReady');

    const nonPersistent = captureSyncError(() =>
      assertPostgresGroupRepositoryCapabilities({
        backend: 'postgres',
        persistent: false,
        productionReady: false,
      }),
    );
    expect(nonPersistent.issues).toContain('persistent');

    for (const backend of ['mysql', 'postgres-draft', 'in-memory-baseline', '']) {
      const misdeclared = captureSyncError(() =>
        assertPostgresGroupRepositoryCapabilities({
          backend,
          persistent: true,
          productionReady: false,
        }),
      );
      expect(misdeclared.issues).toContain('backend');
    }
  });
});

describe('PostgreSQL 小组仓储：构造与调用 fail-closed', () => {
  it('没有执行器 / 执行器缺 query / 缺能力声明 → 构造即拒绝，且不执行任何 SQL', async () => {
    for (const broken of [undefined, null, {}, { capabilities: { backend: 'postgres' } }]) {
      const error = captureSyncError(
        () => new PostgresGroupRepository(broken as unknown as SqlExecutor),
      );
      expect(error.code).toBe('EXECUTOR_UNAVAILABLE');
    }

    const executor = new RecordingExecutor([{ rows: [rowFromGroup()], rowCount: 1 }]);
    new PostgresGroupRepository(executor);
    expect(executor.calls).toHaveLength(0);
  });

  it('执行器声明的后端不是 PostgreSQL → 拒绝（不得把 adapter 挂到其他存储上）', async () => {
    const error = captureSyncError(
      () =>
        new PostgresGroupRepository({
          query: () => Promise.resolve({ rows: [], rowCount: 0 }),
          capabilities: { backend: 'mysql', persistent: true, productionReady: true },
        }),
    );
    expect(error.code).toBe('EXECUTOR_NOT_POSTGRES');
  });

  it('执行器声明为非持久后端（内存替身）→ 拒绝', async () => {
    const error = captureSyncError(
      () =>
        new PostgresGroupRepository({
          query: () => Promise.resolve({ rows: [], rowCount: 0 }),
          capabilities: { backend: 'postgres', persistent: false, productionReady: false },
        }),
    );
    expect(error.code).toBe('EXECUTOR_NOT_PERSISTENT');
  });

  it('构造后执行器被降级为非持久 → 下一次调用 fail-closed，且不再访问 SQL', async () => {
    const executor = new RecordingExecutor([{ rows: [rowFromGroup()], rowCount: 1 }]);
    const repository = new PostgresGroupRepository(executor);

    executor.capabilities = { backend: 'postgres', persistent: false, productionReady: false };

    const error = await captureRepoError(() =>
      repository.listVisibleGroups(OPEN_VISIBILITY, SCOPED_WINDOW),
    );
    expect(error.code).toBe('EXECUTOR_NOT_PERSISTENT');
    expect(executor.calls).toHaveLength(0);
  });

  it('结果集缺少 rows 数组 → 判驱动缺陷，不伪装成「空结果」', async () => {
    for (const broken of [undefined, null, {}, { rows: null }, 'rows']) {
      // 用「原样返回」的执行器，避免替身自身的默认值把 undefined 吞掉
      const rawExecutor: SqlExecutor = {
        capabilities: { backend: 'postgres-raw', persistent: true, productionReady: false },
        query: () => Promise.resolve(broken as unknown as SqlQueryResult<never>),
      };
      const repository = new PostgresGroupRepository(rawExecutor);
      const error = await captureRepoError(() =>
        repository.listVisibleGroups(OPEN_VISIBILITY, SCOPED_WINDOW),
      );
      expect(error.code).toBe('INVALID_ROW');
    }
  });

  it('实现的是异步仓储契约（Promise 语义），未被绑定为同步端口', async () => {
    const executor = new RecordingExecutor([{ rows: [rowFromGroup()], rowCount: 1 }]);
    const repository: AsyncGroupRepository = new PostgresGroupRepository(executor);

    expect(repository.capabilities).toEqual(POSTGRES_GROUP_REPOSITORY_CAPABILITIES);
    const created = repository.create(GROUP);
    expect(created).toBeInstanceOf(Promise);
    await expect(created).resolves.toEqual(GROUP);
  });
});

describe('PostgreSQL 小组仓储：写入路径的参数化与显式映射', () => {
  it('使用占位符绑定写入：SQL 只由常量与 $n 组成，参数按列顺序传入', async () => {
    const executor = new RecordingExecutor([{ rows: [rowFromGroup()], rowCount: 1 }]);
    const repository = new PostgresGroupRepository(executor);

    const created = await repository.create(GROUP);

    const call = executor.calls[0];
    expect(call?.sql).toContain(`INSERT INTO ${POSTGRES_GROUP_TABLE} (`);
    expect(call?.sql).toContain(
      'VALUES ($1, $2, $3, $4::text[], $5::jsonb, $6, $7, $8::timestamptz, $9::timestamptz)',
    );
    expect(call?.sql).toContain('ON CONFLICT (id) DO NOTHING');
    expect(call?.sql).toContain('RETURNING');
    expect(call?.sql).not.toContain('SELECT *');
    expect(call?.sql).not.toContain('*');
    expect(placeholderIndexes(call?.sql ?? '')).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(call?.parameters).toHaveLength(9);

    // 领域对象的值只出现在参数里；SQL 文本里一个都不出现
    for (const value of [GROUP.name, GROUP.description, GROUP.id, GROUP.leaderUserId]) {
      expect(call?.sql).not.toContain(String(value));
    }
    expect(call?.parameters).toEqual([
      GROUP.id,
      GROUP.name,
      GROUP.description,
      ['数据要素', '隐私计算'],
      { skills: ['TypeScript'], headcount: 3 },
      GROUP.leaderUserId,
      GROUP.status,
      GROUP.createdAt,
      GROUP.updatedAt,
    ]);
    expect(created).toEqual(GROUP);
    expect(created).not.toHaveProperty('deleted_at');
    expect(created).not.toHaveProperty('leader_user_id');
  });

  it('缺少 description 时写入 null（不是 undefined，也不是省略列）', async () => {
    const executor = new RecordingExecutor([
      { rows: [rowFromGroup({ description: null })], rowCount: 1 },
    ]);
    const repository = new PostgresGroupRepository(executor);
    const { description: _description, ...withoutDescription } = GROUP;

    await repository.create(withoutDescription);

    expect(executor.calls[0]?.parameters?.[2]).toBeNull();
    expect(placeholderIndexes(executor.calls[0]?.sql ?? '')).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it('主键冲突（无返回行）→ 显式抛错，不静默覆盖', async () => {
    const executor = new RecordingExecutor([{ rows: [], rowCount: 0 }]);
    const repository = new PostgresGroupRepository(executor);

    const error = await captureRepoError(() => repository.create(GROUP));
    expect(error.code).toBe('CONFLICT');
    expect(error.message).toContain(GROUP.id);
  });

  it('写入返回多行 → 主键唯一性被破坏，fail-closed', async () => {
    const executor = new RecordingExecutor([
      { rows: [rowFromGroup(), rowFromGroup()], rowCount: 2 },
    ]);
    const repository = new PostgresGroupRepository(executor);

    const error = await captureRepoError(() => repository.create(GROUP));
    expect(error.code).toBe('RESULT_SET_VIOLATION');
  });

  it('行映射：显式逐字段、数组复制、时间转 ISO、空描述不出现', async () => {
    const driverDirections = ['数据要素'];
    const executor = new RecordingExecutor([
      {
        rows: [rowFromGroup({ description: null, research_directions: driverDirections })],
        rowCount: 1,
      },
    ]);
    const repository = new PostgresGroupRepository(executor);

    const created = await repository.create(GROUP);

    expect(created).toEqual({
      id: GROUP.id,
      name: GROUP.name,
      researchDirections: ['数据要素'],
      recruitmentRequirements: { skills: ['TypeScript'], headcount: 3 },
      leaderUserId: GROUP.leaderUserId,
      status: GroupStatus.Open,
      createdAt: '2026-01-02T03:04:05.000Z',
      updatedAt: '2026-01-02T03:04:05.000Z',
    });
    expect(created).not.toHaveProperty('description');
    // 不把驱动持有的数组交给上层
    expect(created.researchDirections).not.toBe(driverDirections);
    expect(executor.calls[0]?.parameters?.[7]).toBe(GROUP.createdAt);
  });
});

describe('PostgreSQL 小组仓储：subject 边界（他人归属不得回流）', () => {
  it('空 UUID 负责人（无主记录）一律拒绝，且不写库', async () => {
    const executor = new RecordingExecutor([{ rows: [rowFromGroup()], rowCount: 1 }]);
    const repository = new PostgresGroupRepository(executor);

    const error = await captureRepoError(() =>
      repository.create({ ...GROUP, leaderUserId: '00000000-0000-0000-0000-000000000000' }),
    );
    expect(error.code).toBe('INVALID_RECORD');
    expect(error.issues).toContain('leaderUserId');
    expect(executor.calls).toHaveLength(0);
  });

  it('数据库返回的负责人与请求写入的负责人不一致 → IDENTITY_MISMATCH', async () => {
    const executor = new RecordingExecutor([
      { rows: [rowFromGroup({ leader_user_id: OTHER_LEADER_ID })], rowCount: 1 },
    ]);
    const repository = new PostgresGroupRepository(executor);

    const error = await captureRepoError(() => repository.create(GROUP));
    expect(error.code).toBe('IDENTITY_MISMATCH');
    expect(error.issues).toContain('leader_user_id');
    // 错误信息不得回显任何一方的主体标识
    expect(error.message).not.toContain(OTHER_LEADER_ID);
    expect(error.message).not.toContain(LEADER_ID);
  });

  it('负责人不是合法 UUID → INVALID_RECORD（归属只能来自服务端会话主体）', async () => {
    const executor = new RecordingExecutor([{ rows: [rowFromGroup()], rowCount: 1 }]);
    const repository = new PostgresGroupRepository(executor);

    for (const leaderUserId of ['', 'not-a-uuid', "1' OR '1'='1"]) {
      const error = await captureRepoError(() => repository.create({ ...GROUP, leaderUserId }));
      expect(error.code).toBe('INVALID_RECORD');
      expect(error.message).not.toContain(leaderUserId === '' ? 'x' : leaderUserId);
    }
    expect(executor.calls).toHaveLength(0);
  });

  it('服务端独占字段无法经领域对象夹带（写路径字段污染）', async () => {
    const executor = new RecordingExecutor([{ rows: [rowFromGroup()], rowCount: 1 }]);
    const repository = new PostgresGroupRepository(executor);

    for (const polluted of [
      { ...GROUP, ownerUserId: OTHER_LEADER_ID },
      { ...GROUP, deletedAt: '2026-01-02T03:04:05.000Z' },
      { ...GROUP, members: ['x'] },
      { ...GROUP, leaderUserId2: LEADER_ID },
    ]) {
      const error = await captureRepoError(() =>
        repository.create(polluted as unknown as ResearchGroup),
      );
      expect(error.code).toBe('INVALID_RECORD');
    }
    expect(executor.calls).toHaveLength(0);
  });

  it('数据库返回的主键与请求写入的主键不一致 → IDENTITY_MISMATCH（他人记录不得回流）', async () => {
    const executor = new RecordingExecutor([
      { rows: [rowFromGroup({ id: OTHER_GROUP_ID })], rowCount: 1 },
    ]);
    const repository = new PostgresGroupRepository(executor);

    const error = await captureRepoError(() => repository.create(GROUP));
    expect(error.code).toBe('IDENTITY_MISMATCH');
    expect(error.issues).toContain('id');
    expect(error.message).not.toContain(OTHER_GROUP_ID);
    expect(error.message).not.toContain(GROUP_ID);
  });

  it('存储记录缺少状态或状态非法 → 拒绝（缺失不得被默认为 open）', async () => {
    const executor = new RecordingExecutor([{ rows: [rowFromGroup()], rowCount: 1 }]);
    const repository = new PostgresGroupRepository(executor);

    const { status: _status, ...withoutStatus } = GROUP;
    const missing = await captureRepoError(() =>
      repository.create(withoutStatus as unknown as ResearchGroup),
    );
    expect(missing.code).toBe('INVALID_RECORD');
    expect(missing.issues.join(',')).toContain('status');

    const unknown = await captureRepoError(() =>
      repository.create({ ...GROUP, status: 'archived' } as unknown as ResearchGroup),
    );
    expect(unknown.code).toBe('INVALID_RECORD');

    expect(executor.calls).toHaveLength(0);
  });
});

describe('PostgreSQL 小组仓储：SQL 注入防线', () => {
  const INJECTION = "x'); DROP TABLE research_groups; --";

  it('名称/简介里的注入载荷只进参数，SQL 文本与正常输入逐字节相同', async () => {
    const benign = new RecordingExecutor([{ rows: [rowFromGroup()], rowCount: 1 }]);
    const malicious = new RecordingExecutor([{ rows: [rowFromGroup()], rowCount: 1 }]);

    await new PostgresGroupRepository(benign).create(GROUP);
    await new PostgresGroupRepository(malicious).create({
      ...GROUP,
      name: INJECTION,
      description: INJECTION,
      researchDirections: [INJECTION],
    });

    const maliciousCall = malicious.calls[0];
    expect(maliciousCall?.sql).toEqual(benign.calls[0]?.sql);
    expect(maliciousCall?.sql).not.toContain('DROP TABLE');
    expect(maliciousCall?.sql).not.toContain('--');
    expect(maliciousCall?.parameters?.[1]).toBe(INJECTION);
    expect(maliciousCall?.parameters?.[3]).toEqual([INJECTION]);
  });

  it('可见范围内的注入式 groupId 在进入 SQL 之前就被拒绝（fail-closed）', async () => {
    const executor = new RecordingExecutor([{ rows: [], rowCount: 0 }]);
    const repository = new PostgresGroupRepository(executor);

    for (const injected of [
      `${GROUP_ID}' OR 1=1 --`,
      "1' OR '1'='1",
      '${GROUP_ID}',
      GROUP_ID.toUpperCase().replace(/-/gu, ''),
      '',
    ]) {
      const error = await captureRepoError(() =>
        repository.listVisibleGroups(
          { includeAllOpenGroups: false, visibleGroupIds: [injected] },
          SCOPED_WINDOW,
        ),
      );
      expect(error.code).toBe('INVALID_QUERY');
    }
    expect(executor.calls).toHaveLength(0);
  });

  it('可见性查询形状异常（非布尔 / 非数组）→ 拒绝，不进入 SQL', async () => {
    const executor = new RecordingExecutor([{ rows: [], rowCount: 0 }]);
    const repository = new PostgresGroupRepository(executor);

    for (const query of [
      { includeAllOpenGroups: 'true', visibleGroupIds: [] },
      { includeAllOpenGroups: true, visibleGroupIds: 'g-1' },
      { includeAllOpenGroups: true, visibleGroupIds: [123] },
      { visibleGroupIds: [] },
      null,
    ]) {
      const error = await captureRepoError(() =>
        repository.listVisibleGroups(
          query as unknown as Parameters<PostgresGroupRepository['listVisibleGroups']>[0],
          SCOPED_WINDOW,
        ),
      );
      expect(error.code).toBe('INVALID_QUERY');
    }
    expect(executor.calls).toHaveLength(0);
  });

  it('取数窗口必须是整数（注入式/浮点/负数一律拒绝，不绑定进 SQL）', async () => {
    const executor = new RecordingExecutor([{ rows: [], rowCount: 0 }]);
    const repository = new PostgresGroupRepository(executor);

    for (const window of [
      { offset: '1 OR 1=1', limit: 10 },
      { offset: 0, limit: 1.5 },
      { offset: -1, limit: 10 },
      { offset: 0, limit: Number.MAX_SAFE_INTEGER + 1 },
      { offset: 0, limit: Number.NaN },
      {},
    ]) {
      const error = await captureRepoError(() =>
        repository.listVisibleGroups(
          OPEN_VISIBILITY,
          window as unknown as Parameters<PostgresGroupRepository['listVisibleGroups']>[1],
        ),
      );
      expect(error.code).toBe('INVALID_WINDOW');
    }
    expect(executor.calls).toHaveLength(0);
  });

  it('表名与列清单只由模块常量构成且都是裸标识符，不含任何通配选择', async () => {
    const executor = new RecordingExecutor([
      { rows: [rowFromGroup()], rowCount: 1 },
      { rows: [rowFromGroup()], rowCount: 1 },
      { rows: [{ total: '1' }], rowCount: 1 },
    ]);
    const repository = new PostgresGroupRepository(executor);

    await repository.create(GROUP);
    await repository.listVisibleGroups(OPEN_VISIBILITY, SCOPED_WINDOW);
    await repository.countVisibleGroups(OPEN_VISIBILITY);

    expect(POSTGRES_GROUP_TABLE).toBe('research_groups');
    expect(POSTGRES_GROUP_COLUMNS.every((column) => /^[a-z][a-z0-9_]*$/u.test(column))).toBe(true);
    for (const call of executor.calls) {
      expect(call.sql).toContain(POSTGRES_GROUP_TABLE);
      // 唯一允许的通配只有 COUNT(*)；不存在 SELECT *（列清单始终显式）
      expect(call.sql.replace('COUNT(*)::bigint AS total', '')).not.toContain('*');
      expect(placeholderIndexes(call.sql)).toHaveLength(call.parameters?.length ?? 0);
    }
  });
});

describe('PostgreSQL 小组仓储：严格输出校验（字段污染不得带出）', () => {
  it('数据库返回未登记列 → 整行拒绝（不静默丢弃，也不带进结果）', async () => {
    for (const extra of [
      { deleted_at: null },
      { leader_email: 'attacker@example.com' },
      { internal_note: '内部备注' },
      { password_hash: 'x' },
    ]) {
      const executor = new RecordingExecutor([{ rows: [rowFromGroup(extra)], rowCount: 1 }]);
      const repository = new PostgresGroupRepository(executor);

      const error = await captureRepoError(() => repository.create(GROUP));
      expect(error.code).toBe('INVALID_ROW');
      expect(error.issues.join(',')).toContain('unrecognized_keys');
      // 错误信息只带字段路径，不回显被污染的取值
      for (const value of Object.values(extra)) {
        if (typeof value === 'string' && value.length > 0) {
          expect(error.message).not.toContain(value);
        }
      }
    }
  });

  it('jsonb 招募要求出现未登记键或错误形状 → 拒绝', async () => {
    for (const requirements of [
      { skills: ['TypeScript'], internal_note: 'secret' },
      { skills: 'TypeScript' },
      '{"skills":["TypeScript"]}',
      [],
      42,
    ]) {
      const executor = new RecordingExecutor([
        { rows: [rowFromGroup({ recruitment_requirements: requirements })], rowCount: 1 },
      ]);
      const repository = new PostgresGroupRepository(executor);

      const error = await captureRepoError(() => repository.create(GROUP));
      expect(error.code).toBe('INVALID_ROW');
    }
  });

  it('非法枚举 / 非数组方向 / 坏时间戳 / 缺列 一律拒绝（未知状态不得当作合法值输出）', async () => {
    const poisoned = [
      rowFromGroup({ status: 'archived' }),
      rowFromGroup({ status: 'OPEN' }),
      rowFromGroup({ research_directions: '数据要素' }),
      rowFromGroup({ research_directions: [] }),
      rowFromGroup({ research_directions: null }),
      rowFromGroup({ leader_user_id: 'nope' }),
      rowFromGroup({ id: 'nope' }),
      rowFromGroup({ created_at: 'not-a-date' }),
      rowFromGroup({ created_at: '2026-13-45T99:99:99Z' }),
      (() => {
        const { name: _name, ...withoutName } = rowFromGroup();
        return withoutName;
      })(),
    ];

    for (const row of poisoned) {
      const executor = new RecordingExecutor([{ rows: [row], rowCount: 1 }]);
      const repository = new PostgresGroupRepository(executor);

      const error = await captureRepoError(() => repository.create(GROUP));
      expect(error.code).toBe('INVALID_ROW');
    }
  });

  it('行里可以携带时区偏移时间戳，映射后统一为 UTC ISO 字符串', async () => {
    const executor = new RecordingExecutor([
      {
        rows: [rowFromGroup({ created_at: '2026-01-02T11:04:05.000+08:00' })],
        rowCount: 1,
      },
    ]);
    const repository = new PostgresGroupRepository(executor);

    const created = await repository.create(GROUP);
    expect(created.createdAt).toBe('2026-01-02T03:04:05.000Z');
  });
});

describe('PostgreSQL 小组仓储：visibility 边界（越权取数不得回流）', () => {
  it('列表与计数共用同一套可见性谓词，且窗口下推为 LIMIT/OFFSET', async () => {
    const executor = new RecordingExecutor([
      { rows: [rowFromGroup()], rowCount: 1 },
      { rows: [{ total: '1' }], rowCount: 1 },
    ]);
    const repository = new PostgresGroupRepository(executor);

    const visibility = { includeAllOpenGroups: false, visibleGroupIds: [GROUP_ID] };
    const rows = await repository.listVisibleGroups(visibility, { offset: 20, limit: 10 });
    const total = await repository.countVisibleGroups(visibility);

    const listCall = executor.calls[0];
    const countCall = executor.calls[1];

    expect(POSTGRES_GROUP_VISIBILITY_PREDICATE).toContain("status = 'open'");
    expect(POSTGRES_GROUP_VISIBILITY_PREDICATE).toContain('deleted_at IS NULL');
    expect(POSTGRES_GROUP_VISIBILITY_PREDICATE).toContain('($1::boolean OR id = ANY($2::uuid[]))');
    expect(POSTGRES_GROUP_VISIBILITY_PREDICATE).toContain(`'${GroupStatus.Open}'`);
    expect(listCall?.sql).toContain(POSTGRES_GROUP_VISIBILITY_PREDICATE);
    expect(countCall?.sql).toContain(POSTGRES_GROUP_VISIBILITY_PREDICATE);
    expect(listCall?.sql).toContain('ORDER BY created_at ASC, id ASC');
    expect(listCall?.sql).toContain('LIMIT $3 OFFSET $4');
    expect(countCall?.sql).not.toContain('LIMIT');
    expect(listCall?.parameters).toEqual([false, [GROUP_ID], 10, 20]);
    expect(countCall?.parameters).toEqual([false, [GROUP_ID]]);
    expect(rows).toHaveLength(1);
    expect(total).toBe(1);
  });

  it('空 visibleGroupIds 不等于「不过滤」：绑定空数组，且返回任何行都判越权', async () => {
    const executor = new RecordingExecutor([{ rows: [], rowCount: 0 }]);
    const repository = new PostgresGroupRepository(executor);

    await repository.listVisibleGroups(
      { includeAllOpenGroups: false, visibleGroupIds: [] },
      SCOPED_WINDOW,
    );
    expect(executor.calls[0]?.parameters?.[0]).toBe(false);
    expect(executor.calls[0]?.parameters?.[1]).toEqual([]);
    expect(executor.calls[0]?.sql).toContain('id = ANY($2::uuid[])');

    const leaky = new RecordingExecutor([{ rows: [rowFromGroup()], rowCount: 1 }]);
    const error = await captureRepoError(() =>
      new PostgresGroupRepository(leaky).listVisibleGroups(
        { includeAllOpenGroups: false, visibleGroupIds: [] },
        SCOPED_WINDOW,
      ),
    );
    expect(error.code).toBe('VISIBILITY_VIOLATION');
  });

  it('数据库返回判定范围之外的小组 → VISIBILITY_VIOLATION（不把别人小组交给上层）', async () => {
    const executor = new RecordingExecutor([
      { rows: [rowFromGroup({ id: OTHER_GROUP_ID })], rowCount: 1 },
    ]);
    const repository = new PostgresGroupRepository(executor);

    const error = await captureRepoError(() =>
      repository.listVisibleGroups(
        { includeAllOpenGroups: false, visibleGroupIds: [GROUP_ID] },
        SCOPED_WINDOW,
      ),
    );
    expect(error.code).toBe('VISIBILITY_VIOLATION');
    expect(error.message).not.toContain(OTHER_GROUP_ID);
  });

  it('数据库返回非开放状态小组 → VISIBILITY_VIOLATION', async () => {
    for (const status of [GroupStatus.Paused, GroupStatus.Closed]) {
      const executor = new RecordingExecutor([{ rows: [rowFromGroup({ status })], rowCount: 1 }]);
      const repository = new PostgresGroupRepository(executor);

      const error = await captureRepoError(() =>
        repository.listVisibleGroups(OPEN_VISIBILITY, SCOPED_WINDOW),
      );
      expect(error.code).toBe('VISIBILITY_VIOLATION');
    }
  });

  it('返回行数超过窗口 / 出现重复 ID → 结果集违约，fail-closed', async () => {
    const overfull = new RecordingExecutor([
      { rows: [rowFromGroup(), rowFromGroup({ id: OTHER_GROUP_ID })], rowCount: 2 },
    ]);
    const overflow = await captureRepoError(() =>
      new PostgresGroupRepository(overfull).listVisibleGroups(OPEN_VISIBILITY, {
        offset: 0,
        limit: 1,
      }),
    );
    expect(overflow.code).toBe('RESULT_SET_VIOLATION');

    const duplicated = new RecordingExecutor([
      { rows: [rowFromGroup(), rowFromGroup()], rowCount: 2 },
    ]);
    const duplicate = await captureRepoError(() =>
      new PostgresGroupRepository(duplicated).listVisibleGroups(OPEN_VISIBILITY, {
        offset: 0,
        limit: 2,
      }),
    );
    expect(duplicate.code).toBe('RESULT_SET_VIOLATION');
  });

  it('可见 ID 去重后绑定，窗口为 0 时合法但返回任何行都判违约', async () => {
    const executor = new RecordingExecutor([{ rows: [], rowCount: 0 }]);
    const repository = new PostgresGroupRepository(executor);

    await repository.listVisibleGroups(
      { includeAllOpenGroups: false, visibleGroupIds: [GROUP_ID, GROUP_ID] },
      SCOPED_WINDOW,
    );
    expect(executor.calls[0]?.parameters?.[1]).toEqual([GROUP_ID]);

    const zeroWindow = new RecordingExecutor([{ rows: [], rowCount: 0 }]);
    await new PostgresGroupRepository(zeroWindow).listVisibleGroups(OPEN_VISIBILITY, {
      offset: 0,
      limit: 0,
    });
    expect(zeroWindow.calls[0]?.parameters).toEqual([true, [], 0, 0]);
  });
});

describe('PostgreSQL 小组仓储：计数与列表同源且严格解析', () => {
  it('字符串 / 数字 / bigint 计数都解析为非负整数', async () => {
    for (const [raw, expected] of [
      ['7', 7],
      [7, 7],
      [7n, 7],
      ['0', 0],
    ] as const) {
      const executor = new RecordingExecutor([{ rows: [{ total: raw }], rowCount: 1 }]);
      const visible = await new PostgresGroupRepository(executor).countVisibleGroups(
        OPEN_VISIBILITY,
      );
      expect(visible).toBe(expected);
      expect(executor.calls[0]?.sql).toContain('COUNT(*)::bigint AS total');
      expect(executor.calls[0]?.sql).toContain(POSTGRES_GROUP_VISIBILITY_PREDICATE);
      expect(placeholderIndexes(executor.calls[0]?.sql ?? '')).toEqual([1, 2]);
    }
  });

  it('计数结果不合规（缺行 / 多行 / NaN / 负数 / 小数 / 非数字文本）→ fail-closed', async () => {
    const poisoned = [
      { rows: [], rowCount: 0 },
      { rows: [{ total: '1' }, { total: '2' }], rowCount: 2 },
      { rows: [{ total: Number.NaN }], rowCount: 1 },
      { rows: [{ total: -1 }], rowCount: 1 },
      { rows: [{ total: 1.5 }], rowCount: 1 },
      { rows: [{ total: 'many' }], rowCount: 1 },
      { rows: [{ total: ' 7 ' }], rowCount: 1 },
      { rows: [{ total: null }], rowCount: 1 },
      { rows: [{}], rowCount: 1 },
    ];

    for (const response of poisoned) {
      const executor = new RecordingExecutor([response]);
      const error = await captureRepoError(() =>
        new PostgresGroupRepository(executor).countVisibleGroups(OPEN_VISIBILITY),
      );
      expect(error.code).toBe('INVALID_ROW');
    }
  });
});

describe('PostgreSQL 小组仓储：未装配、无驱动依赖、与 schema 草案对齐', () => {
  it('GroupsModule 仍只绑定内存基线（本 adapter 未被装配）', () => {
    const moduleFile = resolve(process.cwd(), 'src', 'modules', 'groups', 'groups.module.ts');
    const content = readFileSync(moduleFile, 'utf8');

    expect(content).not.toContain('PostgresGroupRepository');
    expect(content).not.toContain('groups.postgres-repository');
    expect(content).toContain('InMemoryGroupRepository');
    expect(content).toContain(
      '{ provide: GROUP_REPOSITORY, useExisting: InMemoryGroupRepository }',
    );
  });

  it('持久化登记与数据库模块都不引用本 adapter（端口登记表仍按令牌判定）', () => {
    for (const relative of [
      join('src', 'db', 'persistence-bindings.ts'),
      join('src', 'db', 'database.module.ts'),
      join('src', 'db', 'ports', 'sql-executor.port.ts'),
    ]) {
      const content = readFileSync(resolve(process.cwd(), relative), 'utf8');
      // 端口文件只在注释里以「示例路径」提到 adapter，这不构成装配；任何 import / provider
      // 引用（类名或模块路径）都必须为零
      expect(content).not.toContain('PostgresGroupRepository');
      expect(content).not.toMatch(/from\s+['"][^'"]*groups\.postgres-repository['"]/u);
      expect(content).not.toMatch(/require\(\s*['"][^'"]*groups\.postgres-repository['"]\s*\)/u);
    }
  });

  it('adapter 不引入任何数据库驱动 / ORM 依赖', () => {
    const source = readFileSync(ADAPTER_PATH, 'utf8');
    const forbidden = new Set([
      'pg',
      'pg-pool',
      'pg-promise',
      'node-postgres',
      'postgres',
      'postgres.js',
      'slonik',
      'prisma',
      '@prisma/client',
      'typeorm',
      'kysely',
      'drizzle-orm',
      'drizzle-kit',
      'sequelize',
      '@mikro-orm/core',
    ]);
    const specifiers = [
      ...source.matchAll(/from\s+['"]([^'"]+)['"]/gu),
      ...source.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/gu),
    ].map((match) => match[1] ?? '');

    expect(specifiers.length).toBeGreaterThan(0);
    for (const specifier of specifiers) {
      expect(forbidden.has(specifier)).toBe(false);
    }
    expect(new Set(specifiers)).toEqual(
      new Set([
        'zod',
        '@rm/shared',
        '../../db/ports/sql-executor.port',
        './groups.contract',
        './groups.port',
      ]),
    );
  });

  it('工作区依赖里没有 pg / ORM 包', () => {
    for (const relative of [join('services', 'api', 'package.json'), 'package.json']) {
      const manifest = JSON.parse(readFileSync(join(REPO_ROOT, relative), 'utf8')) as {
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
      };
      const names = [
        ...Object.keys(manifest.dependencies ?? {}),
        ...Object.keys(manifest.devDependencies ?? {}),
      ];
      for (const name of names) {
        expect(
          /^(?:pg|pg-pool|pg-promise|postgres|prisma|@prisma\/client|typeorm|kysely|drizzle-orm|sequelize|@mikro-orm\/core)$/u.test(
            name,
          ),
        ).toBe(false);
      }
    }
  });

  it('表名、列清单与状态枚举都与 db/schema-drafts 草案一致，且草案仍未转迁移', () => {
    const draftDir = join(REPO_ROOT, 'db', 'schema-drafts');
    const draftName = '0001_research_groups.draft.sql';
    const content = readFileSync(join(draftDir, draftName), 'utf8');

    const descriptor = describeSchemaDraftFile(draftName, content);
    expect(descriptor.targetTable).toBe(POSTGRES_GROUP_TABLE);
    expect(descriptor.applied).toBe(false);

    for (const column of [...POSTGRES_GROUP_COLUMNS, 'deleted_at']) {
      expect(content).toContain(column);
    }
    expect(content).toContain(`CREATE TABLE IF NOT EXISTS ${POSTGRES_GROUP_TABLE}`);

    // 状态闭集必须与共享枚举一一对应（草案的 CHECK 是数据库侧的唯一事实来源）
    const statusCheck = /status IN \(([^)]*)\)/iu.exec(content);
    const draftStatuses = [...(statusCheck?.[1] ?? '').matchAll(/'([a-z_]+)'/gu)]
      .map((match) => match[1])
      .sort();
    expect(draftStatuses).toEqual([...GROUP_STATUS_VALUES].sort());

    // 草案不得提前变成迁移（迁移一旦合并即不可修改）
    const migrationFiles = readdirSync(join(REPO_ROOT, 'db', 'migrations'));
    expect(migrationFiles.some((file) => file.includes('research_groups'))).toBe(false);
  });
});

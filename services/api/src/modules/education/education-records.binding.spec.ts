import { describe, expect, it, vi } from 'vitest';
import { EducationStatus, EducationType, ReviewStatus } from '@rm/shared';
import { loadEnv } from '../../config/env';
import {
  DEFAULT_DEPENDENCY_READINESS_REGISTRY,
  describeDependencyReadinessTier,
  evaluateDependencyStage,
} from '../../db/persistence/dependency-readiness';
import { bindingTokenName, PERSISTENCE_BINDINGS } from '../../db/persistence-bindings';
import {
  createUnavailableSqlConnectionFactory,
  type SqlConnectionFactory,
  type SqlExecutor,
} from '../../db/ports/sql-executor.port';
import { createEducationRecordRepository } from './education.module';
import { InMemoryEducationRecordRepository } from './education-records.in-memory-repository';
import {
  POSTGRES_EDUCATION_RECORD_REPOSITORY_CAPABILITIES,
  PostgresEducationRecordRepositoryError,
} from './education-records.postgres-repository';
import { EDUCATION_RECORD_REPOSITORY } from './education-records.port';
import type { EducationRecord } from './education-records.port';

/**
 * 升学记录切片的**换绑分流点**：这是第五个被绑定的业务持久化切片（前四个是会话存储、
 * 成果、学生画像、本人统计），因此它的分流规则必须可机器判定，而不是靠注释。
 *
 * 五条硬性质：
 * 1. 未配置数据库 → 内存基线（行为与换绑之前一致，且如实声明 non-persistent）；
 * 2. 配置了数据库但拿不到执行器工厂 → **抛错**（拒绝静默退回内存升学记录存储）；
 * 3. 配置了数据库且拿到执行器工厂 → PostgreSQL adapter，且**延迟建连**：装配阶段一次都不碰
 *    数据库（否则「未 attest 的执行器」就轮不到启动期持久化边界与依赖就绪门禁来拒绝了）；
 * 4. 存储 ID 域（UUID）在**进入 SQL 之前**判定：非 UUID 的资源 ID / 会话主体不会触发任何连接；
 * 5. **归属隔离在换绑后仍然成立**：单条读取把归属下推进 SQL（两个占位符），
 *    返回他人归属的行一律 fail-closed，绝不回流。
 *
 * 这些都是「运行时路径」断言：全部通过 `education.module.ts` 的 `createEducationRecordRepository`
 * 与端口实现本身验证，不 mock 生产代码内部结构。
 */
const LOOPBACK_URL = 'postgresql://postgres:postgres@127.0.0.1:5432/researcher_manager';

/** 存储 ID 域内的主体（会话主体收敛为 UUID 之前，真实基线的 u-student-1 会被 adapter 拒绝） */
const OWNER = '11111111-1111-4111-8111-111111111111';
const OTHER_OWNER = '22222222-2222-4222-8222-222222222222';

interface RecordedCall {
  readonly sql: string;
  readonly parameters: readonly unknown[] | undefined;
}

/** 记录型假执行器：只记录 SQL 与参数、返回预设结果，不连数据库 */
class RecordingExecutor implements SqlExecutor {
  readonly capabilities = {
    backend: 'postgres-test-double',
    persistent: true,
    productionReady: false,
  } as const;

  readonly calls: RecordedCall[] = [];
  private readonly responses: unknown[];

  constructor(responses: unknown[] = []) {
    this.responses = [...responses];
  }

  query<Row = Record<string, unknown>>(
    sql: string,
    parameters?: readonly unknown[],
  ): Promise<{ rows: Row[]; rowCount: number }> {
    this.calls.push({ sql, parameters });
    const next = (this.responses.shift() ?? { rows: [], rowCount: 0 }) as {
      rows: Row[];
      rowCount: number;
    };
    return Promise.resolve(next);
  }
}

const RECORD: EducationRecord = {
  id: '33333333-3333-4333-8333-333333333333',
  userId: OWNER,
  year: 2026,
  type: EducationType.Postgraduate,
  status: EducationStatus.Admitted,
  institutionOrDestination: '示例大学',
  reviewStatus: ReviewStatus.Pending,
  createdAt: '2026-05-01T00:00:00.000Z',
  updatedAt: '2026-05-01T00:00:00.000Z',
};

/** 与 RECORD 等价的数据库行（snake_case），供假执行器返回 */
function rowOf(
  record: EducationRecord,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: record.id,
    user_id: record.userId,
    year: record.year,
    type: record.type,
    status: record.status,
    institution_or_destination: record.institutionOrDestination ?? null,
    review_status: record.reviewStatus,
    created_at: new Date(record.createdAt),
    updated_at: new Date(record.updatedAt),
    ...overrides,
  };
}

function factoryWith(connect: SqlConnectionFactory['connect']): SqlConnectionFactory {
  return {
    capabilities: { backend: 'postgres', persistent: true, productionReady: true },
    connect,
  };
}

function repositoryWith(executor: SqlExecutor): {
  readonly repository: ReturnType<typeof createEducationRecordRepository>;
  readonly connect: ReturnType<typeof vi.fn>;
} {
  const connect = vi.fn(async () => executor);
  const repository = createEducationRecordRepository(
    loadEnv({ NODE_ENV: 'test', DATABASE_URL: LOOPBACK_URL }),
    factoryWith(connect as unknown as SqlConnectionFactory['connect']),
  );
  return { repository, connect };
}

describe('升学记录的持久化分流', () => {
  it('未配置数据库：内存基线（如实声明非持久 / 不可用于生产），读写同语义', async () => {
    const repository = createEducationRecordRepository(loadEnv({ NODE_ENV: 'test' }), undefined);

    expect(repository).toBeInstanceOf(InMemoryEducationRecordRepository);
    expect(repository.capabilities).toEqual({
      backend: 'in-memory-baseline',
      persistent: false,
      productionReady: false,
    });

    await expect(repository.listByUserId('u-student-1')).resolves.toEqual([]);
    await expect(repository.findById(RECORD.id, 'u-student-1')).resolves.toBeUndefined();

    const saved = await repository.create({ ...RECORD, userId: 'u-student-1' });
    expect(saved.userId).toBe('u-student-1');
    await expect(repository.listByUserId('u-student-1')).resolves.toEqual([saved]);
    // 归属命中：他人主体取不到这条记录（与 PostgreSQL 实现同一口径）
    await expect(repository.findById(RECORD.id, 'u-student-2')).resolves.toBeUndefined();
    await expect(repository.findById(RECORD.id, 'u-student-1')).resolves.toEqual(saved);
  });

  it('配置了数据库但没有执行器工厂：抛错，绝不静默退回内存实现', () => {
    expect(() =>
      createEducationRecordRepository(
        loadEnv({ NODE_ENV: 'test', DATABASE_URL: LOOPBACK_URL }),
        undefined,
      ),
    ).toThrow(/拒绝退回内存升学记录仓储/u);
  });

  it('配置了数据库且拿到执行器工厂：换绑到 PostgreSQL adapter，且装配阶段不建连', async () => {
    const executor = new RecordingExecutor([{ rows: [], rowCount: 0 }]);
    const { repository, connect } = repositoryWith(executor);

    // 延迟建连：装配阶段一次都没有调用 connect
    expect(connect).not.toHaveBeenCalled();
    expect(repository).not.toBeInstanceOf(InMemoryEducationRecordRepository);
    expect(repository.capabilities).toEqual(POSTGRES_EDUCATION_RECORD_REPOSITORY_CAPABILITIES);
    expect(repository.capabilities.backend).not.toBe('in-memory-baseline');

    // 非存储 ID 域的主体（会话基线形状）在进入 SQL 之前就被拒绝 —— 仍然不会调用 connect
    await expect(repository.listByUserId('u-student-1')).rejects.toMatchObject({
      code: 'INVALID_SUBJECT',
    });
    await expect(repository.findById(RECORD.id, 'u-student-1')).rejects.toMatchObject({
      code: 'INVALID_SUBJECT',
    });
    // 非 UUID 的资源 ID 同样在进 SQL 之前被拒绝
    await expect(repository.findById('not-a-uuid', OWNER)).rejects.toMatchObject({
      code: 'INVALID_RECORD_ID',
    });
    expect(connect).not.toHaveBeenCalled();

    // 写入路径同样先判存储 ID 域（严格记录契约 → INVALID_RECORD），也不建连
    await expect(repository.create({ ...RECORD, userId: 'u-student-1' })).rejects.toMatchObject({
      code: 'INVALID_RECORD',
    });
    expect(connect).not.toHaveBeenCalled();
  });

  it('存储 ID 域内的主体：单条取数把归属下推进 SQL，两个标识都不进入 SQL 文本', async () => {
    const executor = new RecordingExecutor([{ rows: [], rowCount: 0 }]);
    const { repository, connect } = repositoryWith(executor);

    await expect(repository.findById(RECORD.id, OWNER)).resolves.toBeUndefined();

    expect(connect).toHaveBeenCalledTimes(1);
    expect(executor.calls).toHaveLength(1);
    const call = executor.calls[0];
    expect(call?.sql).toContain('WHERE id = $1::uuid AND user_id = $2::uuid');
    expect(call?.sql).not.toContain(RECORD.id);
    expect(call?.sql).not.toContain(OWNER);
    expect(call?.parameters).toEqual([RECORD.id, OWNER]);
    expect(call?.sql).not.toContain('*');
  });

  it('列表：只按主体取数，主体不进入 SQL 文本，排序下推保证稳定顺序', async () => {
    const executor = new RecordingExecutor([{ rows: [], rowCount: 0 }]);
    const { repository } = repositoryWith(executor);

    await expect(repository.listByUserId(OWNER)).resolves.toEqual([]);

    const call = executor.calls[0];
    expect(call?.sql).toContain('WHERE user_id = $1::uuid');
    expect(call?.sql).toContain('ORDER BY created_at ASC, id ASC');
    expect(call?.sql).not.toContain(OWNER);
    expect(call?.parameters).toEqual([OWNER]);
  });

  it('写入：参数化 INSERT（主键冲突不覆盖），参数次序与列清单一致，归属来自服务端主体', async () => {
    const executor = new RecordingExecutor([{ rows: [rowOf(RECORD)], rowCount: 1 }]);
    const { repository } = repositoryWith(executor);

    const stored = await repository.create(RECORD);

    expect(stored).toEqual(RECORD);
    const call = executor.calls[0];
    expect(call?.sql).toContain('INSERT INTO education_records');
    expect(call?.sql).toContain('ON CONFLICT (id) DO NOTHING');
    expect(call?.sql).toContain('RETURNING');
    // 参数次序与列清单一致：id → user_id → year → …
    expect(call?.parameters?.[0]).toBe(RECORD.id);
    expect(call?.parameters?.[1]).toBe(OWNER);
    // 个人级内容（院校或去向）只作为参数出现，绝不拼进 SQL 文本
    expect(call?.sql).not.toContain(RECORD.institutionOrDestination ?? '');
    expect(call?.sql).not.toContain('*');
  });

  it('归属隔离：数据库返回他人归属的行 → OWNER_VIOLATION（不回显任何标识与内容）', async () => {
    const executor = new RecordingExecutor([
      { rows: [rowOf(RECORD, { user_id: OTHER_OWNER })], rowCount: 1 },
    ]);
    const { repository } = repositoryWith(executor);

    let captured: unknown;
    try {
      await repository.findById(RECORD.id, OWNER);
    } catch (error) {
      captured = error;
    }

    expect(captured).toBeInstanceOf(PostgresEducationRecordRepositoryError);
    expect((captured as PostgresEducationRecordRepositoryError).code).toBe('OWNER_VIOLATION');
    const serialized = JSON.stringify(captured, Object.getOwnPropertyNames(captured));
    expect(serialized).not.toContain(OTHER_OWNER);
    expect(serialized).not.toContain(OWNER);
    expect(serialized).not.toContain(RECORD.institutionOrDestination ?? '');
  });

  it('执行器工厂是 fail-closed 的未验证驱动时：首次取数失败，错误文本不回显连接串', async () => {
    const repository = createEducationRecordRepository(
      loadEnv({ NODE_ENV: 'test', DATABASE_URL: LOOPBACK_URL }),
      createUnavailableSqlConnectionFactory('测试：未验证驱动'),
    );

    let captured: unknown;
    try {
      await repository.listByUserId(OWNER);
    } catch (error) {
      captured = error;
    }
    expect(captured).toBeInstanceOf(Error);
    expect(String((captured as Error).message)).not.toContain('://');
    expect(String((captured as Error).message)).not.toContain('postgres');
  });
});

/** 令牌与工厂稳定性：换绑点只认端口令牌与 `createEducationRecordRepository`，避免改名后登记表漂移 */
describe('升学记录令牌与换绑工厂', () => {
  it('端口令牌描述名与端口常量一致（登记表按这个名字判定绑定事实）', () => {
    expect(EDUCATION_RECORD_REPOSITORY.description).toBe('EDUCATION_RECORD_REPOSITORY');
  });

  it('createEducationRecordRepository 是唯一的换绑入口（按配置分流，不做别的判定）', () => {
    expect(typeof createEducationRecordRepository).toBe('function');
    expect(createEducationRecordRepository.length).toBe(2);
  });
});

/**
 * 与生产依赖就绪门禁的衔接：「数据库已配置但依赖未就绪 ⇒ fail-closed」必须对**这个**绑定成立，
 * 而不是只对会话存储成立。这里用真实分流产物（`createEducationRecordRepository` 的返回值）的能力声明
 * 直接喂给门禁判定器，因此「换绑后由门禁拒绝」是可机器复现的，不依赖注释或人工复核。
 */
describe('升学记录切片与生产依赖就绪门禁的衔接', () => {
  it('登记表把 EDUCATION_RECORD_REPOSITORY 登记为 business 角色（门禁按这个令牌与角色判定）', () => {
    const binding = PERSISTENCE_BINDINGS.find((item) => item.token === EDUCATION_RECORD_REPOSITORY);
    expect(binding).toBeDefined();
    expect(binding?.module).toBe('education');
    expect(binding?.role).toBe('business');
    expect(bindingTokenName(EDUCATION_RECORD_REPOSITORY)).toBe('EDUCATION_RECORD_REPOSITORY');
  });

  it('数据库已配置但依赖未验证：门禁对 EDUCATION_RECORD_REPOSITORY 判 DEPENDENCY_NOT_VERIFIED', () => {
    const executor = new RecordingExecutor([{ rows: [], rowCount: 0 }]);
    const { repository } = repositoryWith(executor);

    const report = evaluateDependencyStage({
      required: true,
      role: 'business',
      candidates: [
        {
          token: bindingTokenName(EDUCATION_RECORD_REPOSITORY),
          role: 'business',
          capabilities: repository.capabilities,
        },
      ],
      registry: DEFAULT_DEPENDENCY_READINESS_REGISTRY,
      now: new Date().toISOString(),
    });

    // 能力声明如实为 persistent=true / productionReady=false ⇒ 只可能是「未验证」，不是「内存替身」
    expect(report.state).toBe('rejected');
    expect(report.violations.map((item) => item.code)).toEqual(['DEPENDENCY_NOT_VERIFIED']);
    expect(report.violations[0]?.token).toBe('EDUCATION_RECORD_REPOSITORY');
    expect(report.violations[0]?.detail).toContain('productionReady=false');
    // 违规文案不泄漏连接串（口令 / 主机 / 库名都不出现在判定结果里）
    expect(JSON.stringify(report)).not.toContain('://');
    expect(JSON.stringify(report)).not.toContain('researcher_manager');
  });

  it('未配置数据库：档位 not-required，内存基线不进入判定（默认启动不受影响）', () => {
    const repository = createEducationRecordRepository(loadEnv({ NODE_ENV: 'test' }), undefined);
    const stage = evaluateDependencyStage({
      required: false,
      role: 'business',
      candidates: [
        {
          token: bindingTokenName(EDUCATION_RECORD_REPOSITORY),
          role: 'business',
          capabilities: repository.capabilities,
        },
      ],
      registry: DEFAULT_DEPENDENCY_READINESS_REGISTRY,
      now: '2026-01-01T00:00:00.000Z',
    });

    // 档位口径与启动门禁同一个函数：生产环境或已配置数据库才 required
    expect(describeDependencyReadinessTier('test', false)).toBe('not-required');
    expect(describeDependencyReadinessTier('test', true)).toBe('required');
    expect(describeDependencyReadinessTier('production', false)).toBe('required');
    expect(stage.state).toBe('not-required');
    expect(stage.checkedTokens).toEqual([]);
  });
});

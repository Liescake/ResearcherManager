import { describe, expect, it, vi } from 'vitest';
import { AvailablePeriod, Grade, ProgrammingLevel } from '@rm/shared';
import { loadEnv } from '../../config/env';
import {
  describeDependencyReadinessTier,
  evaluateDependencyStage,
  DEFAULT_DEPENDENCY_READINESS_REGISTRY,
} from '../../db/persistence/dependency-readiness';
import { bindingTokenName, PERSISTENCE_BINDINGS } from '../../db/persistence-bindings';
import { createUnavailableSqlConnectionFactory } from '../../db/ports/sql-executor.port';
import type { SqlConnectionFactory, SqlExecutor } from '../../db/ports/sql-executor.port';
import { createProfileRepository } from './profiles.module';
import { InMemoryProfileRepository } from './student-profile.in-memory-repository';
import { POSTGRES_STUDENT_PROFILE_REPOSITORY_CAPABILITIES } from './student-profile.postgres-repository';
import { PROFILE_REPOSITORY } from './student-profile.port';
import type { StudentProfile } from './student-profile.port';

/**
 * 画像切片的**换绑分流点**：这是本阶段第二个被绑定的业务持久化切片（第一个是本人统计），
 * 因此它的分流规则必须可机器判定，而不是靠注释。
 *
 * 四条硬性质：
 * 1. 未配置数据库 → 内存基线（行为与换绑之前一致，且如实声明 non-persistent）；
 * 2. 配置了数据库但拿不到执行器工厂 → **抛错**（拒绝静默退回内存画像存储）；
 * 3. 配置了数据库且拿到执行器工厂 → PostgreSQL adapter，且**延迟建连**：装配阶段一次都不碰
 *    数据库（否则「未 attest 的执行器」就轮不到启动期持久化边界与依赖就绪门禁来拒绝了）；
 * 4. 存储 ID 域（UUID）在**进入 SQL 之前**判定：非 UUID 的会话主体不会触发任何连接。
 *
 * 这些都是「运行时路径」断言：全部通过 `profiles.module.ts` 的 `createProfileRepository`
 * 与端口实现本身验证，不 mock 生产代码内部结构。
 */
const LOOPBACK_URL = 'postgresql://postgres:postgres@127.0.0.1:5432/researcher_manager';

/** 存储 ID 域内的主体（会话主体收敛为 UUID 之前，真实基线的 u-student-1 会被 adapter 拒绝） */
const OWNER = '11111111-1111-4111-8111-111111111111';

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

const PROFILE: StudentProfile = {
  userId: OWNER,
  name: '张三',
  studentNo: '2023123456',
  college: '计算机学院',
  major: '软件工程',
  grade: Grade.Junior,
  phone: '13800138000',
  skills: ['TypeScript', 'PostgreSQL'],
  programmingLevel: ProgrammingLevel.Intermediate,
  availableTime: { weeklyHours: 10, periods: [AvailablePeriod.Weekend] },
  researchInterests: ['数据要素'],
  intendedFields: ['可信数据空间'],
  privacyConsent: { policyVersion: 'v2026-01', consentedAt: '2026-01-02T03:00:00.000Z' },
  createdAt: '2026-01-02T03:04:05.000Z',
  updatedAt: '2026-01-03T04:05:06.000Z',
};

/** 与 PROFILE 等价的数据库行（snake_case），供假执行器返回 */
function rowOf(profile: StudentProfile): Record<string, unknown> {
  return {
    user_id: profile.userId,
    name: profile.name,
    student_no: profile.studentNo,
    college: profile.college,
    major: profile.major,
    grade: profile.grade,
    phone: profile.phone,
    skills: [...profile.skills],
    programming_level: profile.programmingLevel,
    research_experience: profile.researchExperience ?? null,
    competition_experience: profile.competitionExperience ?? null,
    available_time: profile.availableTime,
    research_interests: [...profile.researchInterests],
    strengths: profile.strengths ?? null,
    intended_fields: [...profile.intendedFields],
    privacy_consent: profile.privacyConsent,
    created_at: new Date(profile.createdAt),
    updated_at: new Date(profile.updatedAt),
  };
}

function factoryWith(connect: SqlConnectionFactory['connect']): SqlConnectionFactory {
  return {
    capabilities: { backend: 'postgres', persistent: true, productionReady: true },
    connect,
  };
}

describe('学生画像的持久化分流', () => {
  it('未配置数据库：内存基线（如实声明非持久 / 不可用于生产），读写同语义', async () => {
    const repository = createProfileRepository(loadEnv({ NODE_ENV: 'test' }), undefined);

    expect(repository).toBeInstanceOf(InMemoryProfileRepository);
    expect(repository.capabilities).toEqual({
      backend: 'in-memory-baseline',
      persistent: false,
      productionReady: false,
    });

    await expect(repository.findByUserId('u-student-1')).resolves.toBeUndefined();
    const saved = await repository.save({ ...PROFILE, userId: 'u-student-1' });
    expect(saved.userId).toBe('u-student-1');
    await expect(repository.findByUserId('u-student-1')).resolves.toEqual(saved);
  });

  it('配置了数据库但没有执行器工厂：抛错，绝不静默退回内存实现', () => {
    expect(() =>
      createProfileRepository(loadEnv({ NODE_ENV: 'test', DATABASE_URL: LOOPBACK_URL }), undefined),
    ).toThrow(/拒绝退回内存画像仓储/u);
  });

  it('配置了数据库且拿到执行器工厂：换绑到 PostgreSQL adapter，且装配阶段不建连', async () => {
    const executor = new RecordingExecutor([{ rows: [], rowCount: 0 }]);
    const connect = vi.fn(async () => executor as SqlExecutor);

    const repository = createProfileRepository(
      loadEnv({ NODE_ENV: 'test', DATABASE_URL: LOOPBACK_URL }),
      factoryWith(connect as unknown as SqlConnectionFactory['connect']),
    );

    // 延迟建连：装配阶段一次都没有调用 connect
    expect(connect).not.toHaveBeenCalled();
    expect(repository).not.toBeInstanceOf(InMemoryProfileRepository);
    expect(repository.capabilities).toEqual(POSTGRES_STUDENT_PROFILE_REPOSITORY_CAPABILITIES);
    expect(repository.capabilities.backend).not.toBe('in-memory-baseline');

    // 非存储 ID 域的主体（会话基线形状）在进入 SQL 之前就被拒绝 —— 仍然不会调用 connect
    await expect(repository.findByUserId('u-student-1')).rejects.toMatchObject({
      code: 'INVALID_SUBJECT',
    });
    expect(connect).not.toHaveBeenCalled();
  });

  it('存储 ID 域内的主体：走参数化的按主体取数，主体不进入 SQL 文本', async () => {
    const executor = new RecordingExecutor([{ rows: [], rowCount: 0 }]);
    const connect = vi.fn(async () => executor as SqlExecutor);
    const repository = createProfileRepository(
      loadEnv({ NODE_ENV: 'test', DATABASE_URL: LOOPBACK_URL }),
      factoryWith(connect as unknown as SqlConnectionFactory['connect']),
    );

    await expect(repository.findByUserId(OWNER)).resolves.toBeUndefined();

    expect(connect).toHaveBeenCalledTimes(1);
    expect(executor.calls).toHaveLength(1);
    const call = executor.calls[0];
    expect(call?.sql).toContain('WHERE user_id = $1::uuid');
    expect(call?.sql).not.toContain(OWNER);
    expect(call?.parameters).toEqual([OWNER]);
    expect(call?.sql).not.toContain('*');
  });

  it('写入：参数化 upsert，参数次序与列清单一致，归属来自服务端主体', async () => {
    const executor = new RecordingExecutor([{ rows: [rowOf(PROFILE)], rowCount: 1 }]);
    const connect = vi.fn(async () => executor as SqlExecutor);
    const repository = createProfileRepository(
      loadEnv({ NODE_ENV: 'test', DATABASE_URL: LOOPBACK_URL }),
      factoryWith(connect as unknown as SqlConnectionFactory['connect']),
    );

    const stored = await repository.save(PROFILE);

    expect(stored).toEqual(PROFILE);
    const call = executor.calls[0];
    expect(call?.sql).toContain('INSERT INTO student_profiles');
    expect(call?.sql).toContain('ON CONFLICT (user_id) DO UPDATE');
    expect(call?.parameters?.[0]).toBe(OWNER);
    // 高敏感字段（学号 / 联系方式）只作为参数出现，绝不拼进 SQL 文本
    expect(call?.sql).not.toContain(PROFILE.studentNo);
    expect(call?.sql).not.toContain(PROFILE.phone);
    expect(call?.sql).not.toContain('*');
  });

  it('执行器工厂是 fail-closed 的未验证驱动时：首次读数失败，错误文本不回显连接串', async () => {
    const repository = createProfileRepository(
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
    expect(String((captured as Error).message)).not.toContain('://');
    expect(String((captured as Error).message)).not.toContain('postgres');
  });
});

/** 令牌与工厂稳定性：换绑点只认端口令牌与 `createProfileRepository`，避免改名后登记表漂移 */
describe('画像令牌与换绑工厂', () => {
  it('端口令牌描述名与端口常量一致（登记表按这个名字判定绑定事实）', () => {
    expect(PROFILE_REPOSITORY.description).toBe('PROFILE_REPOSITORY');
  });

  it('createProfileRepository 是唯一的换绑入口（按配置分流，不做别的判定）', () => {
    expect(typeof createProfileRepository).toBe('function');
    expect(createProfileRepository.length).toBe(2);
  });
});

/**
 * 与生产依赖就绪门禁的衔接：「数据库已配置但依赖未就绪 ⇒ fail-closed」必须对**这个**绑定成立，
 * 而不是只对会话存储成立。这里用真实分流产物（`createProfileRepository` 的返回值）的能力声明
 * 直接喂给门禁判定器，因此「换绑后由门禁拒绝」是可机器复现的，不依赖注释或人工复核。
 */
describe('画像切片与生产依赖就绪门禁的衔接', () => {
  it('登记表把 PROFILE_REPOSITORY 登记为 business 角色（门禁按这个令牌与角色判定）', () => {
    const binding = PERSISTENCE_BINDINGS.find((item) => item.token === PROFILE_REPOSITORY);
    expect(binding).toBeDefined();
    expect(binding?.module).toBe('profiles');
    expect(binding?.role).toBe('business');
    expect(bindingTokenName(PROFILE_REPOSITORY)).toBe('PROFILE_REPOSITORY');
  });

  it('数据库已配置但依赖未验证：门禁对 PROFILE_REPOSITORY 判 DEPENDENCY_NOT_VERIFIED', () => {
    const executor = new RecordingExecutor([{ rows: [], rowCount: 0 }]);
    const repository = createProfileRepository(
      loadEnv({ NODE_ENV: 'test', DATABASE_URL: LOOPBACK_URL }),
      factoryWith(
        vi.fn(async () => executor as SqlExecutor) as unknown as SqlConnectionFactory['connect'],
      ),
    );

    const report = evaluateDependencyStage({
      required: true,
      role: 'business',
      candidates: [
        {
          token: bindingTokenName(PROFILE_REPOSITORY),
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
    expect(report.violations[0]?.token).toBe('PROFILE_REPOSITORY');
    expect(report.violations[0]?.detail).toContain('productionReady=false');
    // 违规文案不泄漏连接串（口令 / 主机 / 库名都不出现在判定结果里）
    expect(JSON.stringify(report)).not.toContain('://');
    expect(JSON.stringify(report)).not.toContain('researcher_manager');
  });

  it('未配置数据库：档位 not-required，内存基线不进入判定（默认启动不受影响）', () => {
    const repository = createProfileRepository(loadEnv({ NODE_ENV: 'test' }), undefined);
    const stage = evaluateDependencyStage({
      required: false,
      role: 'business',
      candidates: [
        {
          token: bindingTokenName(PROFILE_REPOSITORY),
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

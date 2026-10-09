import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { ForbiddenException, InternalServerErrorException, Logger } from '@nestjs/common';
import { AchievementType, DataScope, ReviewStatus, Role, achievementInputSchema } from '@rm/shared';
import { ZodError } from 'zod';
import { describe, expect, it, vi } from 'vitest';
import { AuthorizationGuard } from '../access-control/authorization-guard';
import { AuthorizationPolicy } from '../access-control/authorization-policy';
import { BaselineRuoYiAuthzAdapter } from '../ruoyi-adapter/ruoyi-adapter.baseline';
import type { AuthorizationDecision, RuoYiAuthzAdapter } from '../ruoyi-adapter/ruoyi-adapter.port';
import { ACHIEVEMENT_INPUT_FIELDS, ACHIEVEMENT_INTEGRITY_MESSAGE } from './achievements.contract';
import type { Achievement, AchievementRepository } from './achievements.port';
import { AchievementsService } from './achievements.service';

/**
 * 成果服务层回归（不启 HTTP）：把「判定入参来自服务端」「授权先于仓储访问」
 * 「未知枚举 fail-closed」「仓储越界取数不当作正常输出」四条约束固定在 service 这一层，
 * 避免它们只靠 HTTP 用例间接覆盖。
 *
 * 端口是**异步契约**（内存基线与 PostgreSQL 实现同签名），因此这里也断言「先授权、后 await 取数」
 * 的顺序事实：授权拒绝时仓储方法一次都不被调用。
 */

const policy = new AuthorizationPolicy();
const guard = new AuthorizationGuard(new BaselineRuoYiAuthzAdapter(policy));

/** 仓储替身：只实现端口语义，不引入第二套授权或校验规则；记录调用次数以证明访问顺序 */
class StubAchievementRepository implements AchievementRepository {
  readonly capabilities = {
    backend: 'stub',
    persistent: false,
    productionReady: false,
  } as const;

  readonly created: Achievement[] = [];
  createCalls = 0;
  listCalls = 0;
  /** 供用例模拟「仓储未按主体过滤 / 数据被外部改写」的越界返回 */
  listOverride: readonly Achievement[] | undefined;

  private readonly records = new Map<string, Achievement>();

  constructor(seed: readonly Achievement[] = []) {
    for (const record of seed) this.records.set(record.id, record);
  }

  create(achievement: Achievement): Promise<Achievement> {
    this.createCalls += 1;
    this.created.push(achievement);
    this.records.set(achievement.id, achievement);
    return Promise.resolve(achievement);
  }

  listByUserId(userId: string): Promise<readonly Achievement[]> {
    this.listCalls += 1;
    if (this.listOverride) return Promise.resolve(this.listOverride);
    return Promise.resolve([...this.records.values()].filter((record) => record.userId === userId));
  }
}

const student = { userId: 'u-student-1', roles: [Role.Student] } as const;
const admin = { userId: 'u-admin-1', roles: [Role.Admin] } as const;

const validBody = {
  type: AchievementType.Paper,
  title: '第一作者论文',
  awardLevel: '校级一等奖',
  description: '论文成果说明',
  achievedAt: '2026-05-01T00:00:00.000Z',
  evidenceFileId: randomUUID(),
};

function record(overrides: Partial<Achievement> = {}): Achievement {
  const now = '2026-01-01T00:00:00.000Z';
  return {
    id: randomUUID(),
    userId: 'u-student-1',
    type: AchievementType.Competition,
    title: '竞赛成果',
    reviewStatus: ReviewStatus.Approved,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function serviceWith(repository: AchievementRepository): AchievementsService {
  return new AchievementsService(guard, repository);
}

/** 端口是异步契约：同步抛出的授权/校验拒绝会变成 rejected promise，因此捕获也必须是异步的 */
async function captureError(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run();
  } catch (error) {
    return error;
  }
  throw new Error('预期抛出异常，但没有抛出');
}

describe('AchievementsService：主体与归属只来自服务端', () => {
  it('创建：归属、审核态、时间戳由服务端写入，视图不含 userId', async () => {
    const repository = new StubAchievementRepository();
    const service = serviceWith(repository);

    const view = await service.createMyAchievement(student, { ...validBody });

    expect(repository.created).toHaveLength(1);
    const stored = repository.created[0];
    expect(stored?.userId).toBe('u-student-1');
    expect(stored?.reviewStatus).toBe(ReviewStatus.Pending);
    expect(stored?.createdAt).toBe(stored?.updatedAt);
    // 取得时间由服务端规范化为 ISO 8601
    expect(stored?.achievedAt).toBe('2026-05-01T00:00:00.000Z');
    expect(view.title).toBe('第一作者论文');

    // 对外视图字段闭集：没有 userId，也没有任何内部处理字段
    expect(Object.keys(view).sort()).toEqual([
      'achievedAt',
      'awardLevel',
      'createdAt',
      'description',
      'evidenceFileId',
      'id',
      'reviewStatus',
      'title',
      'type',
      'updatedAt',
    ]);
    expect(JSON.stringify(view)).not.toContain('u-student-1');
  });

  it('列表：只按服务端主体取数，绝不返回他人记录', async () => {
    const repository = new StubAchievementRepository([
      record({ userId: 'u-student-1' }),
      record({ userId: 'u-student-2', title: '他人成果' }),
    ]);
    const service = serviceWith(repository);

    const items = await service.listMyAchievements(student);

    expect(items).toHaveLength(1);
    expect(JSON.stringify(items)).not.toContain('他人成果');
    expect(JSON.stringify(items)).not.toContain('u-student-2');
  });

  it('授权先于仓储访问：端口拒绝时仓储的读写方法一次都不被调用', async () => {
    const denying: RuoYiAuthzAdapter = {
      capabilities: new BaselineRuoYiAuthzAdapter(policy).capabilities,
      checkAuthorization: (): AuthorizationDecision => ({
        allowed: false,
        reason: 'policy-denied',
      }),
      checkGrant: (): AuthorizationDecision => ({ allowed: false, reason: 'policy-denied' }),
    };
    const repository = new StubAchievementRepository([record()]);
    const service = new AchievementsService(new AuthorizationGuard(denying), repository);

    expect(await captureError(async () => service.listMyAchievements(student))).toBeInstanceOf(
      ForbiddenException,
    );
    expect(
      await captureError(async () => service.createMyAchievement(student, { ...validBody })),
    ).toBeInstanceOf(ForbiddenException);

    expect(repository.listCalls).toBe(0);
    expect(repository.createCalls).toBe(0);
    expect(repository.created).toHaveLength(0);
  });
});

describe('AchievementsService：输入闭集与字段校验（fail-closed）', () => {
  it('服务端独占字段（userId/roles/scope/groupId/reviewStatus）→ ZodError，且不落库', async () => {
    const repository = new StubAchievementRepository();
    const service = serviceWith(repository);

    const error = await captureError(async () =>
      service.createMyAchievement(student, {
        ...validBody,
        userId: 'u-victim-1',
        roles: [Role.SuperAdmin],
        scope: DataScope.Global,
        groupId: 'g-1',
        reviewStatus: ReviewStatus.Approved,
      }),
    );

    expect(error).toBeInstanceOf(ZodError);
    const messages = (error as ZodError).issues.map((issue) => issue.message).join('|');
    for (const key of ['userId', 'roles', 'scope', 'groupId', 'reviewStatus']) {
      expect(messages).toContain(key);
    }
    expect(repository.created).toHaveLength(0);
    expect(repository.createCalls).toBe(0);
  });

  it('未知枚举/越界/非法时间/非 UUID 佐证/敏感内容 → ZodError', async () => {
    const repository = new StubAchievementRepository();
    const service = serviceWith(repository);

    const cases: unknown[] = [
      { ...validBody, type: 'unknown_type' },
      {},
      { ...validBody, title: '' },
      { ...validBody, title: 'x'.repeat(301) },
      { ...validBody, title: '标题\u0007' },
      { ...validBody, achievedAt: 'not-a-date' },
      { ...validBody, evidenceFileId: 'not-a-uuid' },
      { ...validBody, description: '证件 11010119900307721X' },
      { ...validBody, description: 'api_key: sk-abcdef123456' },
      { ...validBody, description: '卡号 6222020200112233445' },
    ];

    for (const body of cases) {
      expect(
        await captureError(async () => service.createMyAchievement(student, body)),
      ).toBeInstanceOf(ZodError);
    }
    expect(repository.created).toHaveLength(0);
  });

  it('字段闭集与共享 achievementInputSchema 的键集一致（契约回归）', () => {
    expect([...ACHIEVEMENT_INPUT_FIELDS].sort()).toEqual(
      Object.keys(achievementInputSchema.shape).sort(),
    );
  });

  it('授权先于字段校验：无权限角色得到 403，而不是校验结果', async () => {
    const repository = new StubAchievementRepository();
    const service = serviceWith(repository);

    const error = await captureError(async () =>
      service.createMyAchievement(admin, { type: 'unknown_type' }),
    );

    expect(error).toBeInstanceOf(ForbiddenException);
    expect(repository.createCalls).toBe(0);
  });

  it('未登记角色/空主体的主体一律 403（fail-closed）', async () => {
    const repository = new StubAchievementRepository();
    const service = serviceWith(repository);

    expect(
      await captureError(async () =>
        service.listMyAchievements({ userId: 'u-x', roles: ['guest' as Role] }),
      ),
    ).toBeInstanceOf(ForbiddenException);
    expect(
      await captureError(async () =>
        service.listMyAchievements({ userId: 'u-x', roles: [Role.Student, 'guest' as Role] }),
      ),
    ).toBeInstanceOf(ForbiddenException);
    expect(
      await captureError(async () =>
        service.listMyAchievements({ userId: '', roles: [Role.Student] }),
      ),
    ).toBeInstanceOf(ForbiddenException);
    expect(repository.listCalls).toBe(0);
  });
});

describe('AchievementsService：存储异常 fail-closed', () => {
  it('存储枚举未登记 → 500，且异常不携带原始取值', async () => {
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const corrupted = record({
      type: 'unknown_type' as AchievementType,
      title: '受损记录标题',
    });
    const service = serviceWith(new StubAchievementRepository([corrupted]));

    const error = await captureError(async () => service.listMyAchievements(student));

    expect(error).toBeInstanceOf(InternalServerErrorException);
    expect((error as InternalServerErrorException).getStatus()).toBe(500);
    expect((error as InternalServerErrorException).message).toBe(ACHIEVEMENT_INTEGRITY_MESSAGE);
    const serialized = JSON.stringify(error);
    expect(serialized).not.toContain('unknown_type');
    expect(serialized).not.toContain('受损记录标题');
    expect(Logger.prototype.error).toHaveBeenCalled();
  });

  it('存储时间戳非法 → 500（读取契约包含时间格式）', async () => {
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const service = serviceWith(
      new StubAchievementRepository([record({ createdAt: '2026-01-01 00:00:00' })]),
    );

    expect(await captureError(async () => service.listMyAchievements(student))).toBeInstanceOf(
      InternalServerErrorException,
    );
  });

  it('仓储返回他人归属 → 500，绝不把他人记录当作本人列表输出', async () => {
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const repository = new StubAchievementRepository();
    repository.listOverride = [record({ userId: 'u-student-2', title: '他人成果' })];
    const service = serviceWith(repository);

    const error = await captureError(async () => service.listMyAchievements(student));

    expect(error).toBeInstanceOf(InternalServerErrorException);
    // 与「存储记录损坏」共用同一文案：调用方无法据此区分内部原因
    expect((error as InternalServerErrorException).message).toBe(ACHIEVEMENT_INTEGRITY_MESSAGE);
    const serialized = JSON.stringify(error);
    expect(serialized).not.toContain('他人成果');
    expect(serialized).not.toContain('u-student-2');
  });
});

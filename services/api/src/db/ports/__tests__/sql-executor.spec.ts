import { describe, expect, it } from 'vitest';
import { resolveDatabaseConfig } from '../../config/database-config';
import {
  assertProductionReadyExecutor,
  createUnavailableSqlConnectionFactory,
  DatabaseUnavailableError,
  type PersistenceCapabilities,
  UNVERIFIED_DRIVER_BACKEND,
} from '../sql-executor.port';

const IN_MEMORY: PersistenceCapabilities = {
  backend: 'in-memory-baseline',
  persistent: false,
  productionReady: false,
};

describe('createUnavailableSqlConnectionFactory：未注册驱动时 fail-closed', () => {
  it('如实声明未验证驱动，且不声称持久化或生产可用', () => {
    const factory = createUnavailableSqlConnectionFactory('尚未选定数据库驱动');
    expect(factory.capabilities).toEqual({
      backend: UNVERIFIED_DRIVER_BACKEND,
      persistent: false,
      productionReady: false,
    });
  });

  it('connect 一律拒绝，并给出可定位的原因', async () => {
    const factory = createUnavailableSqlConnectionFactory('尚未选定数据库驱动（Prisma/TypeORM 比较未完成）');
    const config = resolveDatabaseConfig({
      DATABASE_URL: 'postgresql://u:p@127.0.0.1:5432/db',
    });
    if (config.status !== 'configured') {
      throw new Error('测试前置失败：配置应为 configured');
    }

    await expect(factory.connect(config.config)).rejects.toBeInstanceOf(DatabaseUnavailableError);
    await expect(factory.connect(config.config)).rejects.toMatchObject({
      code: 'DATABASE_UNAVAILABLE',
      backend: UNVERIFIED_DRIVER_BACKEND,
    });
  });
});

describe('assertProductionReadyExecutor：把未验证执行器挡在生产之外', () => {
  it('非生产环境不拦截（内存基线仍可在开发/测试使用）', () => {
    expect(() => assertProductionReadyExecutor(IN_MEMORY, 'GROUP_REPOSITORY', 'test')).not.toThrow();
    expect(() =>
      assertProductionReadyExecutor(IN_MEMORY, 'GROUP_REPOSITORY', 'development'),
    ).not.toThrow();
  });

  it('生产环境拦截内存基线与未验证后端', () => {
    expect(() => assertProductionReadyExecutor(IN_MEMORY, 'GROUP_REPOSITORY', 'production')).toThrow(
      DatabaseUnavailableError,
    );
    expect(() =>
      assertProductionReadyExecutor(
        { backend: 'postgres-draft', persistent: true, productionReady: false },
        'GROUP_REPOSITORY',
        'production',
      ),
    ).toThrow(DatabaseUnavailableError);
  });

  it('生产环境放行已声明持久且生产可用的后端', () => {
    expect(() =>
      assertProductionReadyExecutor(
        { backend: 'postgres', persistent: true, productionReady: true },
        'GROUP_REPOSITORY',
        'production',
      ),
    ).not.toThrow();
  });
});

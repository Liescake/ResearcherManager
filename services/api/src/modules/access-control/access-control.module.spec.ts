import 'reflect-metadata';
import { ForbiddenException, forwardRef, type ForwardReference } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { describe, expect, it, vi } from 'vitest';
import { DataScope, PermissionPoint, Role } from '@rm/shared';
import { AppModule } from '../../app.module';
import { BaselineRuoYiAuthzAdapter } from '../ruoyi-adapter/ruoyi-adapter.baseline';
import { RuoYiAdapterModule } from '../ruoyi-adapter/ruoyi-adapter.module';
import { RUOYI_AUTHZ_ADAPTER, type RuoYiAuthzAdapter } from '../ruoyi-adapter/ruoyi-adapter.port';
import { AccessControlModule } from './access-control.module';
import { AuthorizationGuard } from './authorization-guard';
import { AuthorizationPolicyModule } from './authorization-policy.module';

/**
 * 授权边界的**装配**回归（与 guard 的判定回归互补）：
 *
 * 1. `AuthorizationGuard` 由 `AccessControlModule` 提供，但判定所需的端口令牌
 *    `RUOYI_AUTHZ_ADAPTER` 由 `RuoYiAdapterModule` 绑定 —— 静态断言依赖方向，
 *    防止退回「guard 直接注入 AuthorizationPolicy」；
 * 2. 模块图必须无环，且不得靠 `forwardRef` 兜底（那正是循环依赖的信号）；
 * 3. 运行期用真实 Nest 容器验证 guard 拿到的就是端口绑定的那个适配器实例。
 */

type ModuleClass = new (...args: never[]) => unknown;

function metadata(key: 'imports' | 'providers' | 'exports' | 'controllers', target: ModuleClass) {
  return (Reflect.getMetadata(key, target) as readonly unknown[] | undefined) ?? [];
}

/** 动态模块（`{ module: X, ... }`）取出其模块类；其余形态返回 undefined。 */
function dynamicModuleClass(imported: unknown): ModuleClass | undefined {
  if (typeof imported !== 'object' || imported === null) return undefined;
  const inner = (imported as { module?: unknown }).module;
  return typeof inner === 'function' ? (inner as ModuleClass) : undefined;
}

/** 从 root 出发做 DFS：若某模块在自身依赖路径上再次出现，返回该环。 */
function findImportCycle(root: ModuleClass): string[] | undefined {
  const path: ModuleClass[] = [];

  const visit = (module: ModuleClass): string[] | undefined => {
    const seenAt = path.indexOf(module);
    if (seenAt >= 0) return [...path.slice(seenAt), module].map((entry) => entry.name);

    path.push(module);
    for (const imported of metadata('imports', module)) {
      const target =
        typeof imported === 'function' ? (imported as ModuleClass) : dynamicModuleClass(imported);
      if (!target) continue;
      const cycle = visit(target);
      if (cycle) return cycle;
    }
    path.pop();
    return undefined;
  };

  return visit(root);
}

/** 收集整图中被 forwardRef 包裹的导入；非空即说明存在循环依赖兜底。 */
function collectForwardRefs(root: ModuleClass): string[] {
  const found: string[] = [];
  const visited = new Set<ModuleClass>();
  const stack: ModuleClass[] = [root];

  while (stack.length > 0) {
    const current = stack.pop();
    if (!current || visited.has(current)) continue;
    visited.add(current);

    for (const imported of metadata('imports', current)) {
      if (typeof imported === 'function') {
        if ('forwardRef' in imported) {
          found.push(`${current.name} -> ${(imported as unknown as ModuleClass).name}`);
        }
        stack.push(imported as ModuleClass);
      } else {
        const dynamic = dynamicModuleClass(imported);
        if (dynamic) stack.push(dynamic);
      }
    }
  }

  return found;
}

const studentSubject = { userId: 'u-student-1', roles: [Role.Student] } as const;

describe('AccessControlModule 授权边界装配', () => {
  it('提供并导出 AuthorizationGuard，且重导出策略模块（调用方接口不变）', () => {
    expect(metadata('providers', AccessControlModule)).toEqual([AuthorizationGuard]);
    expect(metadata('exports', AccessControlModule)).toContain(AuthorizationGuard);
    expect(metadata('exports', AccessControlModule)).toContain(AuthorizationPolicyModule);
    expect(metadata('imports', AccessControlModule)).toContain(AuthorizationPolicyModule);
    expect(metadata('imports', AccessControlModule)).toContain(RuoYiAdapterModule);
  });

  it('RuoYiAdapterModule 把端口绑定到基线适配器（useExisting 同一实例）并导出，且不注册路由', () => {
    const providers = metadata('providers', RuoYiAdapterModule);
    expect(providers).toContain(BaselineRuoYiAuthzAdapter);
    expect(providers).toContainEqual({
      provide: RUOYI_AUTHZ_ADAPTER,
      useExisting: BaselineRuoYiAuthzAdapter,
    });
    expect(metadata('exports', RuoYiAdapterModule)).toContain(RUOYI_AUTHZ_ADAPTER);
    expect(metadata('controllers', RuoYiAdapterModule)).toHaveLength(0);
  });

  it('适配器模块只依赖叶子策略模块，不反向依赖 access-control', () => {
    expect(metadata('imports', RuoYiAdapterModule)).toEqual([AuthorizationPolicyModule]);
  });

  it('从 AppModule 出发的模块图无环，且未使用 forwardRef 兜底', () => {
    expect(findImportCycle(AppModule)).toBeUndefined();
    expect(collectForwardRefs(AppModule)).toEqual([]);
  });
});

describe('AccessControlModule 运行期解析', () => {
  it('guard 经端口拿到端口绑定的适配器实例，并把拒绝转成 403', async () => {
    const app = await NestFactory.createApplicationContext(AccessControlModule, { logger: false });
    try {
      const adapter = app.get<RuoYiAuthzAdapter>(RUOYI_AUTHZ_ADAPTER);
      expect(adapter).toBeInstanceOf(BaselineRuoYiAuthzAdapter);

      const guard = app.get(AuthorizationGuard);
      const spy = vi.spyOn(adapter, 'checkAuthorization');

      expect(() =>
        guard.assertAuthorized(studentSubject, {
          permission: PermissionPoint.ProfileSelfRead,
          scope: DataScope.Self,
          resourceUserId: 'u-student-1',
        }),
      ).not.toThrow();
      expect(spy).toHaveBeenCalledTimes(1);

      expect(() =>
        guard.assertAuthorized(studentSubject, {
          permission: PermissionPoint.ProfileSelfRead,
          scope: DataScope.Self,
          resourceUserId: 'u-other-1',
        }),
      ).toThrow(ForbiddenException);
    } finally {
      await app.close();
    }
  });
});

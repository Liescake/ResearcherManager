import 'reflect-metadata';
import {
  ForbiddenException,
  Module,
  forwardRef,
  type DynamicModule,
  type ForwardReference,
} from '@nestjs/common';
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

/** Nest `forwardRef()` 的运行期形态：`{ forwardRef: () => target }`（对象，而非函数）。 */
type ForwardRefWrapper = ForwardReference<() => unknown>;

/** `imports` 条目归一化后的结果。 */
interface ResolvedImport {
  readonly target: ModuleClass;
  readonly viaForwardRef: boolean;
}

function metadata(key: 'imports' | 'providers' | 'exports' | 'controllers', target: ModuleClass) {
  return (Reflect.getMetadata(key, target) as readonly unknown[] | undefined) ?? [];
}

/** 收窄为模块类：Nest 用构造函数标识模块，`typeof` 判断已足够，无需断言具体签名。 */
function isModuleClass(value: unknown): value is ModuleClass {
  return typeof value === 'function';
}

/** 动态模块（`{ module: X, ... }`）取出其模块类；其余形态返回 undefined。 */
function dynamicModuleClass(imported: unknown): ModuleClass | undefined {
  if (typeof imported !== 'object' || imported === null) return undefined;
  const inner = (imported as { module?: unknown }).module;
  return isModuleClass(inner) ? inner : undefined;
}

/** 模块类或动态模块 → 其模块类；其余形态（含 forwardRef 包装本身）返回 undefined。 */
function moduleClassOf(value: unknown): ModuleClass | undefined {
  if (isModuleClass(value)) return value;
  return dynamicModuleClass(value);
}

/**
 * 识别 `forwardRef` 包装。
 *
 * **运行期它是对象**（`{ forwardRef: () => Type }`，见 `@nestjs/common` 的
 * `ForwardReference`），不是函数。此前该判断被写在 `typeof imported === 'function'`
 * 分支内、并把包装断言成 `ModuleClass` 去取 `.name`：该分支恒不可达，于是
 * forwardRef 兜底被静默漏检、也无法下探被包裹模块的依赖；断言本身也与
 * `ForwardReference` 的真实形状不符。此处按官方类型收窄并直接读取其 thunk。
 */
function isForwardReference(imported: unknown): imported is ForwardRefWrapper {
  if (typeof imported !== 'object' || imported === null) return false;
  return typeof (imported as { forwardRef?: unknown }).forwardRef === 'function';
}

/**
 * 归一化一个 `imports` 条目：模块类、动态模块，或它们的 `forwardRef` 包装。
 * 三种形态都必须能取出目标模块类，否则模块图检查会漏掉「看不见」的边。
 */
function resolveImport(imported: unknown): ResolvedImport | undefined {
  if (isForwardReference(imported)) {
    const target = moduleClassOf(imported.forwardRef());
    return target ? { target, viaForwardRef: true } : undefined;
  }
  const target = moduleClassOf(imported);
  return target ? { target, viaForwardRef: false } : undefined;
}

/** 从 root 出发做 DFS：若某模块在自身依赖路径上再次出现，返回该环。 */
function findImportCycle(root: ModuleClass): string[] | undefined {
  const path: ModuleClass[] = [];

  const visit = (module: ModuleClass): string[] | undefined => {
    const seenAt = path.indexOf(module);
    if (seenAt >= 0) return [...path.slice(seenAt), module].map((entry) => entry.name);

    path.push(module);
    for (const imported of metadata('imports', module)) {
      const resolved = resolveImport(imported);
      if (!resolved) continue;
      const cycle = visit(resolved.target);
      if (cycle) return cycle;
    }
    path.pop();
    return undefined;
  };

  return visit(root);
}

/**
 * 收集整图中被 forwardRef 包裹的导入；非空即说明存在循环依赖兜底。
 * 只要出现就记为兜底（不做白名单），并继续下探被包裹模块，避免漏检。
 */
function collectForwardRefs(root: ModuleClass): string[] {
  const found: string[] = [];
  const visited = new Set<ModuleClass>();
  const stack: ModuleClass[] = [root];

  while (stack.length > 0) {
    const current = stack.pop();
    if (!current || visited.has(current)) continue;
    visited.add(current);

    for (const imported of metadata('imports', current)) {
      const resolved = resolveImport(imported);
      if (!resolved) continue;
      if (resolved.viaForwardRef) found.push(`${current.name} -> ${resolved.target.name}`);
      stack.push(resolved.target);
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

  /**
   * 探测器自检（合成模块，不进入真实模块图）：真实图当前无环、也不用 forwardRef 兜底，
   * 所以只有证明「探测器确实能看见 forwardRef」时，上面那条断言才是有效的回归，
   * 而不是恒真的空检查。
   */
  describe('模块图探测能力自检', () => {
    @Module({})
    class SyntheticLeafModule {}

    @Module({ imports: [forwardRef(() => SyntheticLeafModule)] })
    class SyntheticForwardRefModule {}

    @Module({ imports: [forwardRef(() => SyntheticCycleModule)] })
    class SyntheticCycleModule {}

    /** 动态模块边（`{ module: X }`）：必须被下探，且本身不得被误报为 forwardRef 兜底。 */
    const syntheticDynamicEdge: DynamicModule = { module: SyntheticForwardRefModule };

    @Module({ imports: [syntheticDynamicEdge] })
    class SyntheticDynamicHostModule {}

    /** forwardRef 包裹**动态模块**：thunk 延迟求值，故可安全自引用成环。 */
    @Module({
      imports: [forwardRef((): DynamicModule => ({ module: SyntheticDynamicForwardRefModule }))],
    })
    class SyntheticDynamicForwardRefModule {}

    it('能识别运行期形态为对象的 forwardRef 包装，并下探其目标', () => {
      expect(collectForwardRefs(SyntheticForwardRefModule)).toEqual([
        'SyntheticForwardRefModule -> SyntheticLeafModule',
      ]);
      expect(findImportCycle(SyntheticForwardRefModule)).toBeUndefined();
    });

    it('能穿透 forwardRef 包装发现其后的模块环', () => {
      expect(findImportCycle(SyntheticCycleModule)).toEqual([
        'SyntheticCycleModule',
        'SyntheticCycleModule',
      ]);
    });

    it('动态模块边被下探且不被误报为 forwardRef 兜底', () => {
      // 断言的正是「穿过动态模块后才发现的那个 forwardRef」：若动态边被跳过，这里会是 []。
      expect(collectForwardRefs(SyntheticDynamicHostModule)).toEqual([
        'SyntheticForwardRefModule -> SyntheticLeafModule',
      ]);
      expect(findImportCycle(SyntheticDynamicHostModule)).toBeUndefined();
    });

    it('forwardRef 包裹动态模块时同样能识别并据此发现环', () => {
      expect(collectForwardRefs(SyntheticDynamicForwardRefModule)).toEqual([
        'SyntheticDynamicForwardRefModule -> SyntheticDynamicForwardRefModule',
      ]);
      expect(findImportCycle(SyntheticDynamicForwardRefModule)).toEqual([
        'SyntheticDynamicForwardRefModule',
        'SyntheticDynamicForwardRefModule',
      ]);
    });

    it('无依赖的叶子模块报告为空（对照组，证明非恒真）', () => {
      expect(findImportCycle(SyntheticLeafModule)).toBeUndefined();
      expect(collectForwardRefs(SyntheticLeafModule)).toEqual([]);
    });
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

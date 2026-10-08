# @rm/shared

共享契约包：受控枚举、状态机、字段级 zod 校验、响应信封与脱敏工具。

## 为什么存在

小程序端、管理端和 API 必须使用**同一份**状态、枚举与校验规则，否则会出现「前端能提交、后端拒绝」或
「状态判断不一致」的漂移。本包是这些规则的唯一来源，禁止在各端重复定义。

## 目录

```text
src/
├─ enums/        受控枚举 + 中文标签 + 权限点/数据范围（默认拒绝）
├─ states/       申请、成员关系状态机；升学率口径计算
├─ validation/   字段级 zod 校验（与 docs/P1-字段级数据字典.md 对齐）
├─ api/          统一响应信封 { data, meta, error }、稳定错误码、HTTP 映射
├─ privacy/      手机号/学号/姓名/标识脱敏
└─ constants.ts  分页上限、幂等头、匹配取值范围等
```

## 使用

```ts
import {
  ApplicationStatus,
  assertApplicationTransition,
  studentProfileInputSchema,
} from '@rm/shared';

const input = studentProfileInputSchema.parse(body); // 校验失败抛 ZodError
assertApplicationTransition(current, next); // 非法转移抛 StateTransitionError
```

## 约定

1. **默认拒绝**：未列出的权限点一律拒绝；权限判断只用 `PermissionPoint` 里的受控值。
2. **状态机在服务端**：`canTransition*` / `assert*` 由 API 调用，前端按钮状态不构成控制。
3. **敏感信息不落原文**：`detectHighRiskContent` 只返回掩码片段；日志用 `privacy/masking.ts`。
4. **升学率口径**：只把「已录取」计入分子，分母为已审核通过且已有结论（已录取 + 未上岸）；
   `备考中` 不进分母，分母为 0 时返回 `null`。
5. `packages/shared` 不依赖任何基础设施（无数据库、无 HTTP、无 NestJS），只依赖 `zod`。

## 命令

```bash
pnpm --filter @rm/shared test        # vitest 单元测试
pnpm --filter @rm/shared typecheck   # tsc --noEmit
pnpm --filter @rm/shared build       # 产出 dist（CommonJS + .d.ts），供 API 运行时导入
```

## 依赖

| 依赖 | 版本     | 许可证 | 用途                                                       |
| ---- | -------- | ------ | ---------------------------------------------------------- |
| zod  | ^3.25.76 | MIT    | 运行时结构校验（选 3.25 LTS 线：CJS/ESM 双发行、类型稳定） |

> 版本决策与升级路径见 `docs/P3-依赖清单与版本决策.md`。

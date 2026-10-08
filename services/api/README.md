# @rm/api

NestJS API 服务：**唯一业务规则入口**，前端不直接访问数据库（docs/P2-架构与数据设计.md §1）。

## 当前范围（P3 基础工程）

- 统一前缀 `API_PREFIX`（默认 `/api/v1`）。
- `GET /api/v1/health`：存活、版本、运行时长。
- `GET /api/v1/health/ready`：依赖配置就绪情况（不返回任何密钥）。
- `GET /api/v1/runtime-info`：运行期配置摘要，**只回** `nodeEnv`/`apiPort`/`apiPrefix`/`databaseConfigured`/`aiProvider`/`aiMatchingEnabled`
  六个非敏感白名单字段；不返回连接串、会话密钥、AI key/base URL 或原始 `process.env`，出现白名单之外的字段即 500（`runtime-info.controller.spec.ts` 守住闭集）。
- 统一响应信封 `{ data, meta, error }` + 稳定错误码 + 请求 ID。
- 13 个领域模块的**空模块占位**（auth、access-control、profiles、groups、memberships、achievements、
  education、matching、statistics、exports、compliance、audit、notifications）：只声明边界，无业务实现。
- **RuoYi 兼容适配器（可回退基线）**：`src/modules/ruoyi-adapter/`。只注册端口
  `RUOYI_AUTHZ_ADAPTER`，不注册路由、不改动现有响应，因此不改变对外行为：
  - `ruoyi-adapter.port.ts`：端口与能力声明（基线如实声明 `menuRbacBackend = false`、未接入 RuoYi）；
  - `ruoyi-adapter.baseline.ts`：只做委托 + 边界强制转换（未登记权限/范围/角色进谓词前即拒绝）；
  - `contract/*`：把 `services/ruoyi-api/contracts` 的公开 health/authz 契约读成可断言结构
    （**仅测试期读取**，应用启动不依赖契约目录）。
- 环境变量在启动时校验，非法配置立即失败。

**未包含**：数据库连接、微信登录、RBAC 实现、业务接口。它们属于 P4 及之后阶段。

## 命令

```bash
pnpm --filter @rm/api typecheck   # 直接对源码做类型检查（经 tsconfig paths 引用工作区包源码）
pnpm --filter @rm/api test        # vitest：env 校验、信封、异常映射、健康检查、运维信息白名单、RuoYi 契约符合性
pnpm --filter @rm/api build       # tsc 产出 dist（CommonJS + decorator metadata）
pnpm --filter @rm/api start       # node dist/main.js
```

> `test` 同时包含 `src/modules/ruoyi-adapter/contract/*.spec.ts`：把 `services/ruoyi-api/contracts`
> 的公开 health/authz 契约喂给**真实生产代码路径**（健康服务、`AuthorizationPolicy`、适配器），
> 断言运行时响应符合契约。契约的静态校验器在 `services/ruoyi-api/contracts/validate.mjs`，两者互补。

启动（需先构建工作区包，root 脚本已处理顺序）：

```bash
cp .env.example .env              # 至少可保持默认值：无 DATABASE_URL 也能启动
pnpm dev:api                      # 等价于 build packages + tsc + node dist/main.js
curl http://127.0.0.1:3000/api/v1/health
```

## 设计说明

1. **不使用 Nest CLI**：为保持「最小依赖」，构建与运行直接用 `tsc` + `node`；
   需要 `nest start --watch` 等能力时再引入 `@nestjs/cli`（见 `docs/P3-依赖清单与版本决策.md`）。
2. **不使用 class-validator**：请求校验统一使用 `@rm/shared` 的 zod schema，
   避免两套校验规则并存。
3. **不使用 `@nestjs/config`**：环境变量由 `src/config/env.ts` 用 zod 校验，
   通过 `APP_ENV` 令牌注入，禁止业务代码直接读 `process.env`。
4. **Express 5 / NestJS 11**：中间件路由通配符在 Express 5 下语义变化，因此请求 ID 在
   拦截器与异常过滤器内解析（`src/common/request-context.ts`），不使用通配中间件。
5. **日志**：只记录请求 ID、方法、路径（去掉查询串）、状态码与错误码；不记录请求体与隐私原文。
6. **RuoYi 迁移边界**：RuoYi 体系准入（JDK 17 / Maven / 许可证 / SBOM / PostgreSQL 门禁）之前，
   后端迁移只允许通过 `ruoyi-adapter` 端口预留接缝；端口实现当前是基线委托，
   `services/ruoyi-api` 内不得出现 `pom.xml`、Java 源码或 Maven 依赖。
   适配器契约与切换说明见 `services/ruoyi-api/contracts/README.md` §4.1，符合性回归见 §7.6。

## 依赖

| 依赖                                     | 版本      | 许可证     | 用途                                            |
| ---------------------------------------- | --------- | ---------- | ----------------------------------------------- |
| @nestjs/common / core / platform-express | ^11.2.7   | MIT        | Web 框架（NestJS 12 已转为纯 ESM，P3 暂不升级） |
| reflect-metadata                         | ^0.2.2    | Apache-2.0 | 装饰器元数据                                    |
| rxjs                                     | ^7.8.2    | Apache-2.0 | NestJS 拦截器数据流                             |
| zod                                      | ^3.25.76  | MIT        | 环境变量与请求校验                              |
| @rm/shared / @rm/ai-adapter              | workspace | 内部       | 共享契约与 AI 适配层                            |

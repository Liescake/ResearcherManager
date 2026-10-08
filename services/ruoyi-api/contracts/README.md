# ruoyi-api 公开契约（边界骨架）

> 状态：POC 契约切片 P3.1。本目录只保存**语言无关的公开契约**，不包含 Java 源码、`pom.xml`、数据库迁移或任何 RuoYi 文件副本，也不声明可构建、可运行或生产就绪。

## 1. 本目录内容

| 文件                  | 用途                                                               | 静态校验                                                                            |
| --------------------- | ------------------------------------------------------------------ | ----------------------------------------------------------------------------------- |
| `README.md`           | 契约边界、信封/错误码与授权语义说明                                | 人工评审（本文件不参与自动校验）                                                    |
| `validate.mjs`        | 本目录公开静态校验器（仅用 Node 内置模块，结构 + 授权场景重放）    | 自身即校验入口，见 §7.1                                                             |
| `health.openapi.yaml` | `GET /health`、`GET /health/ready` 的 OpenAPI 3.0.3 契约           | YAML 解析、OpenAPI 结构、`$ref` 可解析（§7.1/§7.2）                                 |
| `authz-fixtures.json` | `SELF/GROUP/ASSIGNED/GLOBAL/SYSTEM` 授权判定夹具（含越权负向用例） | JSON 解析、夹具结构与授权场景重放（§7.1/§7.3）；枚举与单一事实来源一致（§7.1/§7.4） |

校验命令见 §7；`authz-fixtures.json` 的判定语义必须与 NestJS 基线谓词一致（§5），并可用 §7.4 的方式回归。

## 2. 边界与单一事实来源

这些文件描述「RuoYi POC 必须实现的接口与授权行为」，语义与现有 NestJS 基线（`services/api`）保持一致，而不是 RuoYi 代码的复制。下列来源是唯一事实来源，本目录**不得重复定义或改写**：

| 语义                                               | 唯一事实来源                                        |
| -------------------------------------------------- | --------------------------------------------------- |
| 统一信封 `{ data, meta, error }`                   | `packages/shared/src/api/envelope.ts`               |
| 错误码注册表与 HTTP 映射                           | `packages/shared/src/api/error-codes.ts`            |
| 角色 / 数据范围 / 原子权限目录                     | `packages/shared/src/enums/permission.ts`           |
| 授权判定谓词 `isAuthorized`、`canGrantPermissions` | `packages/shared/src/enums/authorization.ts`        |
| 健康检查响应字段                                   | `services/api/src/modules/health/health.service.ts` |

约束：

- 本目录文件属于**公开说明材料**，可提交到版本控制；内部需求、计划、评估和迁移文档只保留在本地，且**不是**本契约的运行期依赖（本文件刻意不引用这些本地路径的内容）。
- 边界内不得引入 RuoYi 源码或 Maven 依赖。在 JDK 17、Maven、许可证 / NOTICE / SBOM / 漏洞扫描与 PostgreSQL 门禁通过前，不创建 `pom.xml` 或 Java 实现（详见 `services/ruoyi-api/README.md`）。
- 不修改、不覆盖 `services/api`（NestJS 回滚基线）与既有数据迁移。

## 3. 通用约定

- Base URL：`/api/v1`。
- 响应恒为信封 `{ data, meta, error }`：成功时 `error = null`；失败时 `data = null`，且 `meta.requestId` 必填。
- `meta` 至少包含 `requestId`；基线实现在此之上返回 `generatedAt`。
- 列表统一分页、排序与过滤，服务端限制 page size（基线 `DEFAULT_PAGE_SIZE = 20`、`MAX_PAGE_SIZE = 100`）；写接口支持 `Idempotency-Key`，取值规则与 `packages/shared/src/validation/fields.ts` 的 `idempotencyKeySchema` 一致：去首尾空白后 8–128 字符，仅允许字母、数字和 `.`、`_`、`:`、`-`。
- 权限失败统一 `403 + FORBIDDEN`；不得通过错误码或消息泄露他组资源是否存在（`404 NOT_FOUND` 同样不得区分「不存在」与「不可见」）。

### 错误码注册表

与 `packages/shared/src/api/error-codes.ts` 完全一致（本表为便于评审的副本，冲突时以该文件为准）：

| code                       | HTTP | 含义                                     |
| -------------------------- | ---: | ---------------------------------------- |
| `VALIDATION_FAILED`        |  400 | 请求字段或枚举不合法                     |
| `UNAUTHENTICATED`          |  401 | 缺少或失效会话                           |
| `FORBIDDEN`                |  403 | 权限点或数据范围不满足；不泄露资源存在性 |
| `NOT_FOUND`                |  404 | 目标资源不存在或不可见                   |
| `CONFLICT`                 |  409 | 通用状态冲突                             |
| `IDEMPOTENCY_CONFLICT`     |  409 | 同一幂等键的请求内容不一致               |
| `STATE_TRANSITION_INVALID` |  409 | 状态机不允许该转移                       |
| `RATE_LIMITED`             |  429 | 请求过于频繁                             |
| `AI_OUTPUT_INVALID`        |  502 | 模型输出不符合 schema，已降级            |
| `AI_UNAVAILABLE`           |  503 | 智能匹配不可用                           |
| `INTERNAL_ERROR`           |  500 | 服务器内部错误（不返回内部细节）         |

未知错误码一律按 500 处理，避免把内部错误暴露为成功。

## 4. 授权语义

- 数据范围枚举：`SELF`、`GROUP`、`ASSIGNED`、`GLOBAL`、`SYSTEM`。
- **默认拒绝**：未登记的权限、角色范围不匹配、缺少服务端解析的归属信息，一律拒绝。
- 服务端必须自行解析并绑定：`userId`、`roles`、`groupIds`（已验证的组关系）、`assignedResourceIds`（已授权资源集合）、`resourceUserId`（资源归属）。客户端提交的 `scope`、`groupId`、`role`、资源 owner 或授权集合**永不**作为判定输入。
- 判定入口：`authorize(subject, request) → boolean` 与 `canConfigure(actor, grants) → boolean`（`services/api/src/modules/access-control/authorization-policy.ts`）。RuoYi 的菜单/按钮 RBAC 只能作为粗粒度入口，不能替代该判定。

角色上限：

| 角色           | 数据范围              | 说明                                                                |
| -------------- | --------------------- | ------------------------------------------------------------------- |
| `student`      | `SELF`                | 本人画像/申请/成果/升学、`group:read:open`、`matching:self:request` |
| `group_leader` | `GROUP`               | 仅本人负责的小组（服务端 `groupIds`）                               |
| `admin`        | `ASSIGNED`            | 仅超级管理员明确授予的原子权限与资源集合                            |
| `system_admin` | `SYSTEM` / `ASSIGNED` | 账号、权限、审计与系统配置；业务数据须另行授予                      |
| `super_admin`  | `GLOBAL`              | 全部业务权限；敏感字段仍按字段策略审计                              |

补充规则：

- 原子权限目录中的值必须精确匹配；`export:*`、`profile:*` 等通配形式以及任何未列出的值一律拒绝。
- `role:assign` 与 `permission:configure` 不得经通用配置接口授予，且不进入超级管理员的默认权限集合；`role:assign` 只能走独立二次确认流程。
- 普通管理员不得授予任何权限；系统管理员不得自动获得全局业务数据。
- **范围判定是「单角色严格相等」**：命中某个角色时，`request.scope` 必须等于该角色的默认范围（`DEFAULT_ROLE_DATA_SCOPE`）；需要不同范围时，只能由主体**同时持有相应角色**、经多角色并集的另一条分支满足（例如同时持 `system_admin` 与 `admin`，才能在 `ASSIGNED` 范围下操作）。仅持 `system_admin` 而请求 `ASSIGNED` 会被拒绝。
- 本切片谓词的输入只有 `roles` / `groupIds` / `assignedResourceIds`，**没有**「按用户授予的权限集合」这一输入：`isAuthorized` 只按角色的默认权限目录（`DEFAULT_ROLE_PERMISSIONS`）判定。因此上表所述「由超级管理员明确授予的原子权限」在本契约中体现为角色默认集合的固定边界；动态授予需后续切片新增独立输入后另行定义，并同步更新夹具。

### 4.1 RuoYi 兼容适配器接口（可回退基线）

在 RuoYi 体系尚未准入之前，NestJS 基线提供一个**可回退的适配器边界**，位置与职责如下（不改变既有 API 行为，也不声称 RuoYi 已接入）：

| 文件（`services/api/src/modules/ruoyi-adapter/`） | 职责                                                                                |
| ------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `ruoyi-adapter.port.ts`                           | 端口 `RuoYiAuthzAdapter`（`checkAuthorization` / `checkGrant`）、能力声明与 DI 令牌 |
| `ruoyi-adapter.baseline.ts`                       | 基线实现：只做委托（见下），能力声明 backend = `nestjs-baseline`                    |
| `ruoyi-adapter.module.ts`                         | 绑定 `RUOYI_AUTHZ_ADAPTER → BaselineRuoYiAuthzAdapter`，导出端口，不注册任何路由    |
| `contract/health-contract.ts`                     | 健康探针契约的字段/取值约束（不解析 YAML，不复制契约文案）                          |
| `contract/authz-fixtures.ts`                      | 夹具读取与跨边界强制转换（未登记枚举 → undefined → 拒绝）                           |

约定：

1. **端口只接受服务端解析结果**：与 §4 的 `authorize(subject, request)` 语义相同，客户端提交的 `scope` / `groupId` / `role` / 资源归属永不作为入参。
2. **基线实现只做委托**：判定仍由 `packages/shared` 的 `isAuthorized` / `canGrantPermissions` 完成，适配器只额外负责边界强制转换（未登记权限/范围/角色在进入谓词前即判拒绝）与结构化决策（便于接审计切片）。因此「适配器路径」与「基线路径」在契约重放中必然同结果。
3. **能力声明必须如实**：`menuRbacBackend` / `ruoyiDataScopeBackend` 基线上恒为 `false`，`ruoyiSourceIncluded` / `mavenDependencyIntroduced` 恒为 `false`；只有真正切换实现时才允许改变，且必须同步本节与 `x-boundary`。
4. **切换即回退点**：迁移到 RuoYi 时把该 provider 换成 RuoYi 侧实现（或在测试中替换 DI 令牌）即可，调用方无需改动；本模块不注册路由，因此不影响现有 API 的对外行为。
5. 适配器**不承载**认证（401）、状态机、审计落库与脱敏——它们是后续切片。

## 5. `authz-fixtures.json` 夹具格式

顶层字段：

| 字段                           | 说明                                                         |
| ------------------------------ | ------------------------------------------------------------ |
| `contract` / `contractVersion` | 契约标识与版本                                               |
| `binding`                      | 判定入口与默认拒绝策略说明                                   |
| `evaluation`                   | 执行规则（每个 `kind` 如何求值、忽略哪些字段）               |
| `enums`                        | 角色、数据范围、原子权限目录快照；必须等于服务端单一事实来源 |
| `fixtures`                     | 授权夹具：`authorize(subject, request)`                      |
| `grantFixtures`                | 授权配置夹具：`canConfigure(actor, grants)`                  |
| `nonGoals`                     | 本切片明确不覆盖的范围                                       |

执行规则：

1. `kind = "authorize"`：以 `subject` 与 `request` 调用 `isAuthorized`，结果必须等于 `expect.allowed`。
2. `kind = "grant"`：以 `actor` 与 `grants` 调用 `canGrantPermissions`，结果必须等于 `expect.allowed`。
3. `clientClaims` 仅供评审说明客户端曾提交什么，**执行器必须忽略**：夹具中的 `subject` / `request` 一律视为服务端已解析结果。带 `clientClaims` 的夹具在忽略该字段前后必须得到相同结论。
4. `expect.deniedBy` 是便于定位失败原因的分类标签，不参与断言。

覆盖的负向用例（对应 POC 计划中「授权边界」一节；该计划属本地文档，不随本目录上传，也不作为本契约的运行期依赖）：

- 学生访问他人 `SELF` 资源；
- 负责人访问非所属 `GROUP`；
- 普通管理员访问未分配的 `ASSIGNED` 资源；
- 客户端伪造 `scope` / `groupId` / `role`；
- 未登记权限、通配权限、`role:assign` / `permission:configure` 的非法授予。

`nonGoals` 明确本切片不覆盖：认证与会话（401）、`join application` 幂等与状态机、字段脱敏与审计事件——这些属于后续契约切片。

## 6. `health.openapi.yaml` 说明

- 覆盖 `GET /api/v1/health`（存活与版本信息）与 `GET /api/v1/health/ready`（依赖配置就绪情况），两者 `security: []`，用于本地编排与 POC 探活。
- 响应只包含运行状态与配置**开关**，不返回连接串、密钥、内部地址或依赖版本明细。
- 与基线一致：缺少 `DATABASE_URL` / `SESSION_SECRET` 或 AI 匹配未启用时，`ready` 返回 `status = "degraded"` 与逐项 `checks`，HTTP 仍为 `200`（P3 骨架允许无数据库启动）；`degraded` 是业务事实而不是传输失败，因此不映射为 `503`。

## 7. 静态校验

本目录自带公开校验器 `validate.mjs`：只用 Node 内置模块，不声明也不安装第三方依赖，不联网、不写文件，可在任意工作目录执行。以下检查必须在提交前通过：

```bash
# 7.1 本目录公开校验器（主门禁；失败时退出码为 1，仅输出失败项）
node services/ruoyi-api/contracts/validate.mjs
# 等价写法：进入本目录后执行（脚本按自身位置解析同目录契约文件）
cd services/ruoyi-api/contracts && node validate.mjs
```

7.1 的校验范围：

- `authz-fixtures.json` 结构：JSON 解析、顶层字段、`enums` 内部一致性（角色 ↔ 默认范围 ↔ 权限目录、受限权限必须已登记、权限目录不含通配形式）、逐条夹具的必需字段与允许键（判定输入只允许白名单字段，客户端声明只能出现在 `clientClaims`）、拒绝用例必须携带 `deniedBy`、夹具 id 唯一、契约版本为 semver；
- `authz-fixtures.json` 授权场景重放：内置参考执行器（镜像 `packages/shared/src/enums/authorization.ts` 的 `isAuthorized` / `canGrantPermissions`）逐条断言结果等于 `expect.allowed`；放行用例不得引用未登记的枚举，`clientClaims` 必须被忽略且确实伪造了与服务端解析结果不同的声明，并按 §5 检查负向场景标签覆盖是否齐全；
- `enums` 快照与单一事实来源一致：冻结快照必须等于 `packages/shared/src/enums/permission.ts` 派生出的权限目录（该文件不可读时跳过，并在输出中标注）；
- `health.openapi.yaml`：无依赖解析本文件使用的缩进式 YAML 子集（块映射/序列、字面量块、引号标量、JSON 兼容集合），校验必要顶层字段、必需路径 `/health` 与 `/health/ready`、操作与响应的 `description`、`*Envelope` 的 `required: [data, meta, error]` 与 `additionalProperties: false`、全部 `$ref` 均为本文档内引用且可解析、`x-boundary` 边界声明（未含 RuoYi 源码、未引入 Maven 依赖）与契约版本一致；
- 不支持的 YAML 写法（制表符缩进、锚点/别名/标签、多文档、跨行流式集合）直接判定失败，不做宽松猜测。

7.1 的授权场景重放是**契约自包含的参考执行器**，不是第二事实来源：它把夹具断言到文档语义，`enums` 快照仍以 `packages/shared/src/enums/permission.ts` 为准；与基线共享包（`packages/shared/dist/index.js`）的独立谓词回归见 7.4，两者互为交叉验证。

```bash
# 7.2 YAML 解析 + OpenAPI 结构 + $ref 解析（可选交叉验证，任选一个可用解析器）
python -c "import yaml;yaml.safe_load(open('services/ruoyi-api/contracts/health.openapi.yaml',encoding='utf-8'))"
# node 变体需要本机已有 YAML 解析器；仓库刻意不声明该依赖，未安装时用上面的 python/pyyaml
node -e "import('yaml').then(m=>m.parse(require('fs').readFileSync('services/ruoyi-api/contracts/health.openapi.yaml','utf8')))"

# 7.3 JSON 解析（可选交叉验证）
python -c "import json;json.load(open('services/ruoyi-api/contracts/authz-fixtures.json',encoding='utf-8'))"

# 7.4 夹具回归：遍历 fixtures/grantFixtures，逐条断言
#     isAuthorized(subject, request) === expect.allowed
#     canGrantPermissions(actor, grants) === expect.allowed
#     判定入口为 packages/shared/dist/index.js（只读导入基线共享包，不新增依赖）

# 7.5 空白与冲突标记
git diff --check
```

7.4 的判定入口为 `packages/shared/dist/index.js` 的 `isAuthorized` / `canGrantPermissions`，输入即夹具中的 `subject` / `request` / `actor` / `grants`；`enums` 快照必须与 `packages/shared/src/enums/permission.ts` 完全一致（7.1 已自动核对）。

### 7.6 与 NestJS 基线的双向符合性回归

§7.1 校验的是**契约文件本身**；下列回归校验的是**运行时响应是否真的符合契约**，属于运行期一侧：

```bash
pnpm --filter @rm/api test    # vitest：契约符合性 + 夹具重放
```

| 测试文件（`services/api/src/modules/ruoyi-adapter/`） | 覆盖内容                                                                                                                                           |
| ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ruoyi-adapter.baseline.spec.ts`                      | 能力声明如实（未接入 RuoYi 不得声明 true）、默认拒绝原因、判定与基线谓词一致、观察者不落主体标识                                                   |
| `contract/health-contract.spec.ts`                    | `GET /health`、`GET /health/ready` 的真实数据满足契约字段/取值/闭集/`additionalProperties: false`                                                  |
| `contract/authz-fixtures.spec.ts`                     | `authz-fixtures.json` 全量重放：基线谓词与适配器都必须等于 `expect.allowed`；`clientClaims` 必须被忽略且确实伪造；`enums` 快照与 `@rm/shared` 一致 |

这组测试与 §7.1 互为交叉验证：§7.1 用自包含参考执行器把夹具断言到文档语义，§7.6 用**真实生产代码路径**（`AuthorizationPolicy` + 适配器）复算同一批夹具。

注意：契约文件在运行期**不可达时不会静默跳过**——`contract/*.spec.ts` 会明确失败并提示需在仓库根内运行，避免「测试通过但契约其实没被读到」的假阳性。

## 8. 后续契约切片与版本规则

按垂直切片逐步补充，每个切片单独验证并按模块门禁上传：

1. mock login 与服务端主体解析；
2. groups 查询的服务端范围过滤；
3. join application 的幂等键、状态和版本控制；
4. 统一错误信封、审计事件与脱敏字段清单；
5. AI adapter 健康调用的 schema、超时与降级边界。

版本规则：非破坏性新增递增次版本；任何破坏性变更（字段删除、枚举收缩、权限语义变化）必须提升主/次版本并在本文件记录兼容性声明与迁移说明。

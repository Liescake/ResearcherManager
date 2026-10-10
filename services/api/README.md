# @rm/api

NestJS API 服务：**唯一业务规则入口**，前端不直接访问数据库（docs/P2-架构与数据设计.md §1）。

## 当前范围（P3 基础工程）

- 统一前缀 `API_PREFIX`（默认 `/api/v1`）。
- `GET /api/v1/health`：存活、版本、运行时长。
- `GET /api/v1/health/ready`：依赖配置就绪情况（不返回任何密钥）。
- `GET /api/v1/runtime-info`：运行期配置摘要，**只回** `nodeEnv`/`apiPort`/`apiPrefix`/`databaseConfigured`/`aiProvider`/`aiMatchingEnabled`
  六个非敏感白名单字段；不返回连接串、会话密钥、AI key/base URL 或原始 `process.env`，出现白名单之外的字段即 500（`runtime-info.controller.spec.ts` 守住闭集）。
- 统一响应信封 `{ data, meta, error }` + 稳定错误码 + 请求 ID。
- 领域模块边界（auth、access-control、profiles、groups、memberships、achievements、education、matching、
  statistics、exports、compliance、audit、notifications）：P3 期间都是空模块占位，自 P4 起逐个填充实现；
  当前 `education`、`profiles`、`memberships`（入组申请学生自服务）与 `achievements`
  （成果学生自服务）已落地业务切片，其余仍只声明边界。
- **升学记录切片（`education`，学生自服务）**：`src/modules/education/`。它同时是「认证 → 授权 →
  校验 → 存储端口 → 统一响应」的端到端样板：
  - 路由：`GET/POST /api/v1/me/education-records`、`GET /api/v1/me/education-records/{recordId}`
    （权限点 `education:self:create` / `education:self:read`，数据范围固定 `SELF`）；
  - 请求校验：`@rm/shared` 的 `educationRecordInputSchema`（未知枚举、年份越界、控制字符、
    「已录取但缺院校/去向」→ 400 `VALIDATION_FAILED` + 字段路径）；
    另有**字段闭集**：请求体出现 `roles`/`scope`/`groupId`/`userId`/`reviewStatus` 等未声明字段直接 400；
  - 认证：`AuthModule` 的 `SESSION_SUBJECT_RESOLVER` 端口把 `Bearer <sessionId>` 解析为**服务端主体**，
    角色与组归属只来自服务端会话存储；存储里出现未登记角色时整体 fail-closed 为 401；
  - 授权：资源级判定只经 `AuthorizationGuard`（`RUOYI_AUTHZ_ADAPTER` 端口 → canonical 谓词），
    `resourceUserId` 取自服务端主体或存储记录，客户端无法影响；越权/缺权限点 → 403；
  - 输出：存储记录离开进程前再按读取契约校验（枚举闭集 + ISO 时间戳），违者 500 且不泄露字段取值。
- **学生画像切片（`profiles`，本人自服务）**：`src/modules/profiles/`。复用与升学记录相同的
  「认证 → 授权 → 校验 → 存储端口 → 统一响应」链路：
  - 路由：`GET /api/v1/me/profile`、`PATCH /api/v1/me/profile`
    （权限点 `profile:self:read` / `profile:self:update`，数据范围固定 `SELF`；
    契约基线的 `PUT /me/profile`（首次提交）与更正申请不在本切片）；
  - 请求校验：`@rm/shared` 的 `studentProfileUpdateSchema`（复用创建 schema 的字段级规则：
    未登记枚举、越界数值、控制字符、「未同意隐私政策」→ 400 `VALIDATION_FAILED` + 字段路径）；
    另有**字段闭集**：请求体出现 `roles`/`scope`/`groupId`/`userId`/`permissions`/`reviewStatus`
    等未声明字段直接 400（身份/权限字段给出可区分的拒绝原因），不是静默忽略；
  - 认证：主体只来自 `SESSION_SUBJECT_RESOLVER`；授权：资源级判定只经 `AuthorizationGuard`
    （`RUOYI_AUTHZ_ADAPTER` 端口），并**先于任何存储访问**——第一次 SELF 判定以会话主体作为
    `resourceUserId`，未授权主体只会得到 403，连「画像是否存在」都观察不到（不是 404）；
    取数后再按**存储归属**做第二次 SELF 判定（纵深防御：仓储返回他人归属或归属缺失即同一个 403）。
    权限点/范围/归属全部是服务端解析值，客户端无法影响；
  - 输出：对外视图不含 `userId`；`privacyConsent`（政策版本与同意时间是服务端处理记录）与
    学号（`studentNo`）、联系方式（`phone`）一律**只写不读**——任何状态码的响应都不出现这些
    字段与其明文；读取契约仍校验它们的存储形状（违规 500）。
- **入组申请切片（`memberships`，学生自服务）**：`src/modules/memberships/`（该模块即
  docs/P2-架构与数据设计.md §2 声明的「入退组申请和成员关系状态机」边界，本切片只落地入组申请）：
  - 路由：`POST/GET /api/v1/me/applications`、`POST /api/v1/me/applications/{applicationId}/withdraw`
    （权限点 `membership:self:create` / `membership:self:withdraw`，数据范围固定 `SELF`；
    契约基线的 `/join-applications`、管理端 `/admin/applications*` 与审核不在本切片）。
    撤回是对既有资源的幂等状态变更，因此显式返回 200（而不是 POST 默认的 201）；
  - 请求校验：`@rm/shared` 的 `joinApplicationInputSchema`（创建）与 `withdrawApplicationInputSchema`
    （撤回的路径 ID 必须是 UUID）→ 400 `VALIDATION_FAILED` + 字段路径；另有**字段闭集**：
    创建只接受 `groupId`/`note`，撤回**不接受任何请求体字段**；
  - 主体与归属：`userId` 只来自 `SESSION_SUBJECT_RESOLVER` 解析出的服务端会话主体，
    `status`/`kind`/时间戳只由服务端写入；客户端提交 `status`/`reviewStatus`/`decision`/`userId`/
    `roles`/`scope`/`dataScope`/`groupIds`/`kind` 等**服务端独占字段**一律 400（给出可区分的拒绝
    原因），不是静默剥离。`groupId`（单数）是**申请目标小组**这一业务字段（契约基线要求请求包含
    它），从不作为授权范围：`scope` 恒为服务端常量 `SELF`；
  - 授权：三条路由都先经 `AuthorizationGuard`（`RUOYI_AUTHZ_ADAPTER` 端口），**先于任何存储访问**；
    撤回在取数后按**存储归属**做第二次 SELF 判定（纵深防御）；缺权限点/跨主体一律同一个 403；
  - 状态：创建固定落在共享状态机中**唯一的入口状态** `pending`；撤回只允许 `pending -> withdrawn`，
    其余状态 → 409 `STATE_TRANSITION_INVALID`；同一用户同一小组的**未终态**申请重复提交 → 409
    （终态申请不占用该约束，撤回后可以重新提交）；
  - 输出：对外视图不含 `userId`，也不含审核人/审核意见/审核时间；读取契约仍校验它们的存储形状
    （违规 500），但绝不投影到响应里；
  - 读取口径（已知偏差）：权限目录是闭集且没有 membership self-read 点，本人列表暂以
    `membership:self:create` 作为「本人申请自服务」的读取门控点；登记 `membership:self:read`
    需要权限目录版本升级并同步 `services/ruoyi-api/contracts` 夹具，属后续版本项；
  - 尚不包含：小组存在性/招募状态校验（需要 `groups` 仓储端口）、审核、退组申请、成员关系联动、
    结果通知、幂等键、审计落库、列表分页与排序。
- **成果切片（`achievements`，学生自服务）**：`src/modules/achievements/`（该模块即
  docs/P2-架构与数据设计.md §2 声明的「成果、附件与审核」边界，本切片只落地成果自服务）：
  - 路由：`POST/GET /api/v1/me/achievements` 与 `GET /api/v1/me/achievements/{achievementId}`
    （权限点 `achievement:self:create` / `achievement:self:read`，数据范围固定 `SELF`；
    更新 `PATCH /me/achievements/{id}`（`achievement:self:update`）、审核（`achievement:review`）、
    附件实体校验、导出与统计不在本切片）；
  - 请求校验：`@rm/shared` 的 `achievementInputSchema`（未知类型枚举、空/超长标题、控制字符、
    `achievedAt` 非法时间、`evidenceFileId` 非 UUID、说明含身份证号/密钥/长数字标识
    → 400 `VALIDATION_FAILED` + 字段路径）；另有**字段闭集**：请求体出现 `userId`/`roles`/
    `scope`/`groupId`/`reviewStatus`/`id`/`createdAt` 等**服务端独占字段**一律 400
    （给出可区分的拒绝原因），不是静默剥离；
  - 主体与归属：`userId` 只来自 `SESSION_SUBJECT_RESOLVER` 解析出的服务端会话主体，
    `reviewStatus`/时间戳只由服务端写入（入口恒为共享审核态的 `pending`，自授权通过审核需要
    `achievement:review`）；自定义头（`x-user-id`/`x-roles`/`x-scope`/`x-group-id`）与请求体
    一样不进入任何判定；
  - 授权：三条路由都先经 `AuthorizationGuard`（`RUOYI_AUTHZ_ADAPTER` 端口），
    **先于任何仓储访问**——缺权限点（如 `admin`）或权限点存在但范围不是 `SELF`
    （如 `group_leader` 的 `achievement:self:read` 只在 `GROUP` 范围生效）都得到同一个 403，
    且拒绝时仓储方法一次都不被调用；
  - 单条读取（`GET /me/achievements/{achievementId}`）的判定顺序：**先行 SELF 授权**
    （`resourceUserId` = 会话主体，不访问存储）→ 路径参数按共享 `uuidSchema` 判形状（非法 400）
    → `findById(achievementId, 会话主体)` 把**归属下推到取数**
    （PostgreSQL 侧 `WHERE id = $1::uuid AND user_id = $2::uuid`，他人成果根本不出库）
    → 归属二次授权（纵深防御）。因此「成果不存在」与「成果不属于该主体」**统一 404**、
    不可区分，他人成果的存在性无法被探测；
  - 输出：对外视图不含 `userId`，也不含审核人/审核意见/审核时间/审计事件 ID；读取契约仍校验
    存储形状（枚举闭集 + ISO 时间格式），并额外复核**记录归属与会话主体一致**，
    违者 500 且不泄露字段取值（损坏与越界取数共用同一文案，调用方无法区分内部原因）；
  - 尚不包含：更新与撤回、审核状态流转、附件实体（本切片只校验 `evidenceFileId`
    的 UUID 形状，不校验文件是否存在）、幂等键、审计落库、列表分页与排序。
- **小组切片（`groups`，浏览与创建）**：`src/modules/groups/`（该模块即
  docs/P2-架构与数据设计.md §2 声明的「小组资料、开放状态与招募要求」边界）：
  - 路由：`GET /api/v1/groups`（浏览可见的开放小组，`group:read:open`）、
    `POST /api/v1/groups`（创建小组，`group:manage`）；契约基线的小组详情
    `GET /groups/{groupId}` 与修改/停用 `PATCH /groups/{groupId}` 不在本切片；
  - 请求校验：**直接复用**共享 `researchGroupInputSchema`（`.omit({ leaderUserId, status })`），
    因此小组名称/简介长度、研究方向标签数量与去重、招募要求（技能/年级/周投入/人数/说明）的
    枚举与范围约束、控制字符全部由共享 schema 决定，共享 schema 变更时本接口自动跟随；
    另有**字段闭集**：请求体出现 `leaderUserId`/`status`/`groupId`/`groupIds`/`userId`/`roles`/
    `scope`/`id`/时间戳等**服务端独占字段**一律 400（给出可区分的拒绝原因），不是静默剥离；
  - 主体与归属：`leaderUserId` 只来自 `SESSION_SUBJECT_RESOLVER` 解析出的服务端会话主体
    （创建者即负责人），`status` 只由服务端常量写入（入口恒为 `open`）；自定义头
    （`x-user-id`/`x-roles`/`x-scope`/`x-group-id`）与请求体一样不进入任何判定；
  - 授权：两条路由都先经 `AuthorizationGuard`（`RUOYI_AUTHZ_ADAPTER` 端口），**先于任何仓储访问**。
    创建用服务端常量 `group:manage` + `GLOBAL`（权限矩阵中该点只授予默认范围为 GLOBAL 的角色，
    因此当前实际只对超级管理员放行；把 `group:manage` 授予小组负责人属权限目录版本变更，
    需要同步 `services/ruoyi-api/contracts` 夹具，不在本切片）；
    浏览则不能用单一范围表达——`group:read:open` 对全部角色开放但各角色默认范围不同
    （学生 `SELF`、负责人 `GROUP`、管理员 `ASSIGNED`、系统管理员 `SYSTEM`、超级管理员 `GLOBAL`），
    谓词又要求范围**精确相等**，因此 service 把服务端主体翻译成一组候选
    （`buildGroupReadCandidates`，范围表复用共享 `DEFAULT_ROLE_DATA_SCOPE`）逐个询问端口并取并集：
    集合级候选（SELF/SYSTEM/GLOBAL）通过即可见全部开放小组，资源级候选（GROUP/ASSIGNED）通过
    则只可见逐条命中的小组；一个候选都不通过（如负责人没有任何 `groupIds`、管理员没有被分配的
    资源）得到 403，而不是空列表——本端点不回答「是否存在你看不见的小组」；
  - 输出：只暴露**开放**小组，且对外视图**不含** `leaderUserId`（数据字典标注为「内部」的负责人
    标识）；读取契约仍校验其存储形状（违规 500）。仓储返回非开放小组、授权集合之外的小组、
    未知状态枚举或非法时间戳一律 500，且不泄露字段取值（损坏与越权取数共用同一文案）；
  - 已知偏差：`GET /groups` 尚未分页（契约基线的「分页浏览」需要在仓储端口上加窗口参数并把
    列表返回改为分页包装，属后续切片），本切片固定返回服务端判定可见的全部开放小组；
    控制器不声明任何查询参数，因此查询串里的 `groupId`/`scope`/`userId`/`roles` 既不被读取
    也不被信任（已有真实 HTTP 回归证明其不产生任何影响）；
  - 尚不包含：小组详情、修改/停用（含状态机与资源级 `group:manage` 判定）、成员与成员数、
    负责人由管理员指派、分页/排序/过滤、幂等键与审计落库。
- **存储端口（无数据库阶段）**：`EDUCATION_RECORD_REPOSITORY`、`PROFILE_REPOSITORY`、
  `APPLICATION_REPOSITORY`、`ACHIEVEMENT_REPOSITORY`、`GROUP_REPOSITORY` 与 `SESSION_STORE`
  都是**显式可替换端口**，默认绑定内存基线（`persistent = false`、`productionReady = false`，
  `NODE_ENV=production` 下拒绝构造，默认不预置任何会话/记录/画像/申请/成果/小组）；引入 PostgreSQL 时只替换
  provider 绑定，controller/service 不改动。
- 统一响应信封 `{ data, meta, error }` + 稳定错误码 + 请求 ID。请求体解析失败
  （body-parser，例如 JSON 语法错误或 strict 模式拒绝 JSON 标量）的原始消息会**回显请求体片段**，
  统一异常过滤器将其替换为稳定安全文案（错误码 `VALIDATION_FAILED` 与 400 状态码不变）。
- **RuoYi 兼容适配器（可回退基线）**：`src/modules/ruoyi-adapter/`。只注册端口
  `RUOYI_AUTHZ_ADAPTER`，不注册路由、不改动现有响应，因此不改变对外行为：
  - `ruoyi-adapter.port.ts`：端口与能力声明（基线如实声明 `menuRbacBackend = false`、未接入 RuoYi）；
  - `ruoyi-adapter.baseline.ts`：只做委托 + 边界强制转换（未登记权限/范围/角色进谓词前即拒绝）；
  - `contract/*`：把 `services/ruoyi-api/contracts` 的公开 health/authz 契约读成可断言结构
    （**仅测试期读取**，应用启动不依赖契约目录）。
- 环境变量在启动时校验，非法配置立即失败。

**未包含**：数据库连接、微信登录、RuoYi RBAC 实现，以及升学记录/学生画像/入组申请/成果/小组之外的其他业务接口
（画像首次提交锁定与管理员代改、升学记录的状态流转/审核、更新与撤回、升学率统计、入组申请的审核与
退组、成员关系联动、小组存在性与招募状态校验、小组详情与修改/停用、小组成员与负责人指派、成果的
更新/审核与附件实体、列表分页与排序、所有写接口的幂等键与审计落库）。它们属于后续切片。

## 命令

```bash
pnpm --filter @rm/api typecheck   # 直接对源码做类型检查（经 tsconfig paths 引用工作区包源码）
pnpm --filter @rm/api test        # vitest：env 校验、信封、异常映射、健康检查、运维信息白名单、RuoYi 契约、升学记录切片、学生画像切片、入组申请切片、成果切片、小组切片（真实 HTTP）
pnpm --filter @rm/api build       # tsc 产出 dist（CommonJS + decorator metadata）
pnpm --filter @rm/api start       # node dist/main.js
```

> 只有在「禁止子进程管道/IPC」的受限执行环境里，vitest 默认 forks 池才会 `spawn EPERM`
> （vite 8 加载配置时还会因 `exec('net use')` 失败）：此时改用
> `pnpm --filter @rm/api exec vitest run --pool=threads`，并加一个把 `net use` 调用改为
> 回调报错的 `NODE_OPTIONS=--require=…` preload 让配置加载回退到 `fs.realpathSync` 即可。
> 这是运行环境限制，不是项目配置；常规环境直接用上面的命令。

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
7. **认证与授权分离，主体只来自服务端**：认证（会话凭证 → 服务端主体）在 `AuthModule` 经
   `SESSION_SUBJECT_RESOLVER` 端口完成，授权（权限点 + 数据范围 + 资源归属）经
   `AuthorizationGuard` → `RUOYI_AUTHZ_ADAPTER` 端口完成。控制器不解析角色字段、不自行判断权限，
   客户端提交的 `roles`/`scope`/`groupId`/`userId` 不进入判定（升学记录、画像、入组申请、成果与小组
   切片直接以字段闭集拒绝，小组切片的查询串声明因控制器不声明任何查询参数而不可读取）；
   持久化一律经仓储端口注入，不用模块级/全局内存冒充生产存储。

## 依赖

| 依赖                                     | 版本      | 许可证     | 用途                                            |
| ---------------------------------------- | --------- | ---------- | ----------------------------------------------- |
| @nestjs/common / core / platform-express | ^11.2.7   | MIT        | Web 框架（NestJS 12 已转为纯 ESM，P3 暂不升级） |
| reflect-metadata                         | ^0.2.2    | Apache-2.0 | 装饰器元数据                                    |
| rxjs                                     | ^7.8.2    | Apache-2.0 | NestJS 拦截器数据流                             |
| zod                                      | ^3.25.76  | MIT        | 环境变量与请求校验                              |
| @rm/shared / @rm/ai-adapter              | workspace | 内部       | 共享契约与 AI 适配层                            |

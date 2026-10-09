# 大学生科研团队管理系统（Researcher Manager）

面向大学生科研团队的管理系统：学生端小程序 + 管理端 Web + 统一后端 API + AI 智能匹配。

> **当前状态：P3 基础工程（最小可运行骨架）**
> 已建立 monorepo、共享契约、AI 适配层、可启动的 API、可运行的 Admin Web 外壳、小程序本地占位结构、
> 迁移目录与校验脚本。**业务功能尚未实现**（P4 及之后阶段），各包的 README 都写明了「已具备 / 未实现」边界。

## 技术栈（已冻结）

TypeScript 5.9 + React 19/Vite 8（管理端）+ NestJS 11（API）+ PostgreSQL（数据）+ zod（校验）。
版本与工程边界以本 README、各包公开说明和 CI 配置为准。

## 目录结构

```text
.
├─ apps/
│  ├─ miniapp/             微信小程序学生端（本地占位骨架，未接入开发者工具，不可发布）
│  └─ admin-web/           管理端 Web（React + Vite，可运行外壳）
├─ services/
│  ├─ api/                 NestJS API（唯一业务规则入口）
│  └─ ruoyi-api/           后端迁移隔离边界：公开契约 + 工具链门禁（不含 RuoYi 源码/Java/Maven）
├─ packages/
│  ├─ shared/              枚举、状态机、zod 校验、响应信封、脱敏（前后端共用）
│  └─ ai-adapter/          结构化匹配 schema、输出校验、安全降级、Provider 端口
├─ db/migrations/          迁移规范 + 初始元数据迁移（ORM 选型未定）
├─ scripts/                骨架自检、迁移静态校验
├─ docs/                   公开说明文档（内部规划与评估记录不入库）
└─ .github/workflows/      CI：lint / format / typecheck / build / test
```

## 快速开始

要求：Node ≥ 22.12（CI 使用 Node 24）、pnpm 11（`package.json` 的 `packageManager` 已声明）。

```bash
pnpm install

cp .env.example .env      # 可选；缺省配置即可启动 API（无数据库也能启动）
pnpm verify               # 骨架自检 + 迁移静态校验
pnpm typecheck            # 全部包类型检查
pnpm lint                 # ESLint（flat config）
pnpm test                 # 全部包单元测试
pnpm build                # 工作区包 → API → Admin Web
```

启动（两个终端）：

```bash
pnpm dev:api      # 终端 A：构建工作区包并启动 API（默认 http://127.0.0.1:3000/api/v1）
pnpm dev:admin    # 终端 B：Vite 开发服务器（http://127.0.0.1:5173）
```

验证 API：

```bash
curl http://127.0.0.1:3000/api/v1/health
# {"data":{"status":"ok","service":"researcher-manager-api",...},"meta":{"requestId":"..."},"error":null}
curl http://127.0.0.1:3000/api/v1/health/ready
```

## 本地 PostgreSQL 与 API 容器（WSL2 + Docker Compose）

第一阶段真实 PostgreSQL 集成已落地：官方 `pg` 驱动、受 attest 约束的参数化 SQL 执行器、
迁移运行入口、TLS 策略与一个已绑定的业务切片（**本人统计**聚合读）。其余十个 Postgres
adapter 继续「写好但未装配」。

容器化说明的完整版见 [DOCKER.md](DOCKER.md)（含 WSL2 前置、证书准备、排查命令与 fail-closed 清单）。

```bash
cp .env.docker.example .env.docker     # 模板只有占位符；至少改 POSTGRES_PASSWORD / SESSION_SECRET
docker compose --env-file .env.docker up -d postgres   # 只启动本地开发库（默认端口 55432，避开宿主机 5432）
docker compose --env-file .env.docker ps               # 等待 healthcheck 变为 healthy
docker compose --env-file .env.docker up -d            # 起库 + API 容器（API 的 healthcheck 跟随 API_PREFIX）
```

`docker-compose.yml` 是**仅本机**的开发档：凭据没有内置默认值（缺失时 Compose 直接报错退出）、
两个服务都在显式网络 `rm-internal` 上、`api` 依赖 `postgres` 的 `service_healthy`、数据库数据落在
具名卷 `rm-postgres-data`。生产档是 `docker-compose.prod.yml`（TLS `verify-full` + 证书只读挂载 +
必填取证事实），两份文件由 `pnpm verify:docker` 静态比对守护：

```bash
cp .env.docker.example .env.docker.prod                                   # 再逐项替换 change-me-* / REPLACE-ME-*
docker compose -f docker-compose.prod.yml --env-file .env.docker.prod config   # 先渲染检查
docker compose -f docker-compose.prod.yml --env-file .env.docker.prod up -d
```

> 生产档的每个机密与取证事实都是 `${VAR:?}` 必填：缺任何一项，Compose 在**解析阶段**就退出，
> 不会带着空值或默认口令启动；应用侧还会独立拒绝非 `verify-full` 的生产 TLS 档位。

| 事项         | 说明                                                                                                                                                        |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 连接串       | `postgresql://<POSTGRES_USER>:<POSTGRES_PASSWORD>@127.0.0.1:55432/<POSTGRES_DB>`（默认库名 `researcher_manager`，端口/库名可覆盖）                          |
| 集成测试库   | 初始化脚本会额外创建 `researcher_manager_test`（集成测试**只允许**库名包含 `test` 的目标）                                                                  |
| 迁移         | `pnpm db:migrate` / `pnpm db:migrate:status`（先过 `migration-deployment-guard`：草案、危险非事务 DDL、未参数化动态标识符、校验和与已应用顺序都判在守卫里） |
| 集成测试     | `TEST_DATABASE_URL=postgresql://<user>:<password>@127.0.0.1:55432/researcher_manager_test pnpm --filter @rm/api test`                                       |
| Docker 镜像  | `docker build -t rm-api:dev .`（`Dockerfile` 为开发/联调用镜像；当前运行阶段仍含 devDependencies）                                                          |
| 容器静态门禁 | `pnpm verify:docker`（不需要 Docker 守护进程；已并入 `pnpm verify`）                                                                                        |
| API 认证门禁 | 未配置 `DATABASE_URL` 时启动与既有行为完全一致；配置后要求执行器 attest 与认证依赖就绪（见下）                                                              |

**为什么现在还不能「带上 DATABASE_URL 启动 API」**：只要解析出 `DATABASE_URL`，启动期持久化边界
就要求「经过 attest 且证据完整的 SQL 执行器」**且**「认证依赖（会话存储）先就绪」。会话存储
adapter 属于下一阶段（`db/persistence/postgres-adapter-registry.ts` 里以**有理由的豁免**显式登记），
因此当前 API 会按设计 fail-closed 拒绝启动 —— 这是安全边界，不是配置错误。开发档的 `api` 容器
也因此**不注入** `DATABASE_URL`。

**TLS 策略**（fail-closed）：

- 本地 Compose 用显式 `DATABASE_SSL_MODE=disable`（容器内主机名不是回环地址，必须显式声明档位）；
- `verify-full` 的证书**只登记路径**：`DATABASE_SSL_CA_PATH` / `DATABASE_SSL_CERT_PATH` /
  `DATABASE_SSL_KEY_PATH`（必须绝对路径、证书与私钥成对）；证书内容来自挂载卷或密钥管理，
  `certs/`、`*.pem`、`*.key` 已在 `.gitignore` 与 `.dockerignore` 中排除；
- 生产环境（`NODE_ENV=production`）缺少 TLS 配置、或档位不是 `verify-full`（含 `disable` / `require`），
  一律拒绝启动，且**不再**为回环地址开例外：本地开发请用 `NODE_ENV=development`。

**执行器 attest 取证**：`DATABASE_EXECUTOR_*` / `DATABASE_SCHEMA_*` / `DATABASE_MIGRATION_*` 必须由
真的做过验证的人或 CI 填写（可核对的 `evidenceRef`、由 `pnpm db:migrate:status` 核对过的迁移版本）。
缺任何一项就表示执行器拿不到封存声明，启动按 fail-closed 拒绝 —— 代码**不会**替使用者生成「已验证」。

**集成测试的 skip 语义**：未设置 `TEST_DATABASE_URL` 时真实数据库用例**显式 skip**（并给出原因），
绝不伪造通过；设置了但连不上、或目标库名不含 `test` 时用例**失败**。

## 常用命令

| 命令                                               | 说明                                                                                                |
| -------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `pnpm verify`                                      | 骨架自检（目录/工作区/脚本）+ 迁移文件静态校验 + OpenAPI 契约 + Docker 打包静态门禁                 |
| `pnpm lint` / `pnpm lint:fix`                      | ESLint（仅官方推荐规则集）                                                                          |
| `pnpm format:check` / `pnpm format`                | Prettier（公开 Markdown 与代码格式检查）                                                            |
| `pnpm typecheck`                                   | 全部包 `tsc --noEmit`（跨包类型经 `tsconfig.paths` 指向源码，无需先构建）                           |
| `pnpm build`                                       | `@rm/shared` → `@rm/ai-adapter` → `@rm/api` → `@rm/admin-web`                                       |
| `pnpm test`                                        | 各包 vitest 单测（小程序无测试脚本，自动跳过）                                                      |
| `pnpm dev:api` / `pnpm start:api`                  | 构建并启动 / 直接启动 API                                                                           |
| `pnpm db:migrate` / `pnpm db:migrate:status`       | 应用待执行迁移 / 只看状态（先过迁移部署守卫；`README` 的 PostgreSQL 一节）                          |
| `pnpm verify:docker`                               | Docker 打包静态门禁（多阶段/构建顺序/入口/健康检查/两档编排/凭据与证书；不需要守护进程）            |
| `docker build -t rm-api:dev .`                     | 构建 API 镜像（`Dockerfile`，开发/联调用途）                                                        |
| `pnpm dev:admin` / `pnpm preview:admin`            | 管理端开发服务器 / 预览构建产物                                                                     |
| `node services/ruoyi-api/contracts/validate.mjs`   | ruoyi-api 公开契约静态校验（零依赖：结构 + 授权场景重放 + `$ref` 解析）                             |
| `node services/ruoyi-api/toolchain/check-gate.mjs` | ruoyi-api 工具链与准入门禁（`--java-home`/`--maven-home` 可复现探测；退出码 0/1/2/64，见其 README） |

## 环境变量

统一维护在仓库根目录：`.env.example`（示例，可提交）→ `.env`（本地，禁止提交）。
容器化另有 `.env.docker.example`（Compose 用模板，只含占位符）→ `.env.docker` / `.env.docker.prod`（本地，禁止提交）。
关键项：`API_PORT`、`API_PREFIX`、`DATABASE_URL`、`SESSION_SECRET`、`AI_*`、`VITE_API_BASE_URL`。
Admin Web 的 `envDir` 指向仓库根目录，因此前端变量也只维护一份。

安全约定：

- `VITE_` 前缀变量会进入前端产物，**禁止**写入任何密钥。
- 微信 AppSecret、AI API Key 只能存在于服务端环境变量，不进代码与文档。
- 空字符串按「未配置」处理，复制示例文件不会导致启动失败。

## 工程约定

1. **默认拒绝**：权限判断只使用 `@rm/shared` 中的受控权限点；未列出的权限一律拒绝。
2. **状态机在服务端**：`canTransition*` / `assert*` 由 API 调用；前端按钮状态不构成控制。
3. **敏感字段**：学号、联系方式、微信标识不进入日志、AI 提示词与文件名；展示默认掩码
   （`packages/shared/src/privacy`）。
4. **AI 只做排序**：输入最小必要 + 脱敏，输出必须过 schema、候选白名单与可解释性校验；
   任何失败都降级为规则推荐，不阻塞业务（`packages/ai-adapter`）。
5. **升学率口径**：分子只含「已录取」，分母为审核通过且已有结论（已录取 + 未上岸）的记录，
   备考中不入分母，分母为 0 时展示「暂无数据」。
6. **不引入未经评估的模板**：组件库、ORM、小程序构建工具都需先完成许可证/活跃度/安全评估。

## 公开说明

本仓库仅公开 README、代码包内说明和必要的 API/构建说明。需求、权限矩阵、数据字典、验收基线、迁移评估、错误记录和开发计划等内部工作文档不随仓库分发。

`需求.txt`、`要求.txt`、`AI开发计划表.md`、`计划表待确认问题清单.md` 为本地文档，已在 `.gitignore` 中排除，
不随仓库分发。

## 已知限制

- API 已接入 PostgreSQL 基础层（官方 `pg` 驱动 + 受 attest 约束的参数化执行器 + 迁移运行入口 +
  TLS 策略），但**业务仅绑定了一个切片**（本人统计聚合读）；其余十个 Postgres adapter 尚未装配。
- 未配置 `DATABASE_URL` 时 `/health/ready` 报告 `degraded`（这是设计，不是故障）；配置了
  `DATABASE_URL` 但执行器未 attest 或认证依赖未就绪时，装配阶段直接 fail-closed。
- 会话存储 adapter 未落地，因此当前无法带着 `DATABASE_URL` 启动 API（见「本地 PostgreSQL」一节）。
- 后端仍以 NestJS 为基线：RuoYi 兼容适配器只是**可回退接缝**（默认不接入 RuoYi，`services/ruoyi-api` 内无 `pom.xml`/Java/Maven）。
- Admin Web 仅有一个契约自检页面，无登录与权限控制。
- 小程序未接入微信开发者工具，无 E2E；工具可行性验证属于 P3 §4 待办。
- 依赖漏洞扫描与许可证扫描尚未纳入 CI；正式接入新依赖前必须完成独立供应链审查。
- 受限沙箱内 `vitest` 无法启动（Vite 会调用 `child_process.exec`，管道 stdio 被拒绝为 EPERM）；
  这是运行环境限制而非代码缺陷，需在非受限终端执行 `pnpm test` 复核。
- 容器镜像当前是**开发/联用**镜像（运行阶段仍含 devDependencies）；生产镜像最小化需要
  `pnpm deploy --prod`，而它不支持本仓库 `.npmrc` 的 `node-linker=hoisted`，属后续发布切片。
- 本次交付环境**没有可用的 Docker 守护进程**，因此容器**运行**行为（真正 `up` 起来并 healthy）
  未做端到端验证；已完成 `docker compose ... config` 静态渲染、`pnpm verify:docker` 静态门禁，
  以及本机直跑构建产物 `node services/api/dist/main.js` 的真实 HTTP 探针。

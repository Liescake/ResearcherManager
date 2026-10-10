# Docker 与 WSL2 部署说明（公开）

本文档只描述**公开的**容器化方式：如何在本机 WSL2 上用 Docker 跑起 PostgreSQL 与 API 容器、
如何构建镜像、如何准备证书、哪些行为是刻意的 fail-closed。

- 本地开发档：`docker-compose.yml`（**仅本机**；数据库不启用 TLS）
- 生产档：`docker-compose.prod.yml`（TLS `verify-full` + 证书只读挂载 + 必填取证事实）
- 环境变量模板：`.env.docker.example`（只含占位符，**没有任何真实密钥**）
- 镜像：仓库根 `Dockerfile`（多阶段；API 容器入口 `node services/api/dist/main.js`）
- 静态门禁：`pnpm verify:docker`（不需要 Docker 守护进程）
- 生产反向代理与访问日志脱敏：第 6 节（**部署必做**，含真实请求验证与部署证据要求）
- AI provider 出站（egress）与 DNS/日志验证：第 7 节（**部署必做**；TLS 与代理约束见 7.6 / 7.7，真实部署取证见 7.8）

> 只放说明、不放凭据：`certs/`、`*.pem`、`*.key`、真实 `.env.docker*` 已在 `.gitignore` 与
> `.dockerignore` 中排除；公开模板里的机密字段是占位符，`pnpm verify:docker` 会守住这一点。

---

## 1. 前置条件

| 组件           | 要求                                                         | 检查命令                 |
| -------------- | ------------------------------------------------------------ | ------------------------ |
| WSL2           | Windows 上的 Linux 发行版（Ubuntu 等），版本为 2             | `wsl -l -v`              |
| Docker Desktop | 已开启 WSL 集成，或直接在 WSL 内装 Docker Engine             | `docker version`         |
| Docker Compose | v2 插件（`docker compose`，注意中间是空格）                  | `docker compose version` |
| 仓库位置       | WSL 内可访问的路径（如 `/mnt/d/WorkSpace/ReseacherManager`） | `pwd`                    |

首次准备（Windows PowerShell，管理员）：

```powershell
wsl --install                 # 未装 WSL 时
wsl --set-default-version 2   # 默认版本设为 2
wsl -l -v                     # 确认发行版 VERSION = 2
```

然后在 **Docker Desktop → Settings → Resources → WSL Integration** 中为该发行版打开集成；
回到 WSL 终端验证：

```bash
docker version          # 能打印 Server 段（只打印 Client 段说明守护进程没连上）
docker compose version
```

进入仓库（路径按实际盘符调整）：

```bash
cd /mnt/d/WorkSpace/ReseacherManager
```

**两个 WSL2 常见坑**（都会表现为「配置读到的值莫名其妙」）：

1. **CRLF**：在 Windows 侧编辑出的 `.env` / `pg_hba.conf` 若带 CRLF，`\r` 会被当成值的一部分，
   口令、路径都会读错。用 `file .env.docker` 确认是 `ASCII text`（而非 `with CRLF line terminators`），
   必要时 `sed -i 's/\r$//' .env.docker`，或 `git config --global core.autocrlf input`。
2. **证书权限**：bind mount 会保留宿主机权限位。容器内的 `postgres` / `node` 用户必须能读到
   证书与 `pg_hba.conf`，否则容器起不来（这是刻意的 fail-closed，不是随机故障）。见第 5 节。

---

## 2. 本地开发：起 PostgreSQL 与 API 容器

```bash
# 1) 准备环境变量（模板里全是占位符，按需改成你自己的本地口令）
cp .env.docker.example .env.docker
#    至少改掉 POSTGRES_PASSWORD 与 SESSION_SECRET；SESSION_SECRET 用：
#    openssl rand -base64 48

# 2) 只起开发库（默认发布到宿主机 55432，避开宿主机已装的 5432）
docker compose --env-file .env.docker up -d postgres
docker compose --env-file .env.docker ps          # 等 postgres 变成 healthy

# 3) 起库 + API 容器
docker compose --env-file .env.docker up -d
docker compose --env-file .env.docker ps          # 等 api 也变 healthy

# 4) 验证
curl -fsS http://127.0.0.1:3000/api/v1/health
curl -fsS http://127.0.0.1:3000/api/v1/health/ready

# 5) 停止（加 -v 连数据卷一起删）
docker compose --env-file .env.docker down
docker compose --env-file .env.docker down -v
```

没有内置口令：`POSTGRES_USER` / `POSTGRES_PASSWORD` / `SESSION_SECRET` 缺失时，Compose 在
**解析阶段**就报错退出（`${VAR:?}` 的 fail-closed 语义），不会拿一个「人人可猜的默认口令」启动。

### 2.1 从宿主机跑迁移与集成测试

容器把 PostgreSQL 发布在宿主机 `55432`，所以宿主机上的 Node 流程可以直连：

```bash
# 依赖安装（仅首次）
pnpm install --frozen-lockfile

# 迁移（先过 migration deployment guard；连接串指向**非生产**库）
DATABASE_URL='postgresql://<user>:<password>@127.0.0.1:55432/researcher_manager' \
  pnpm db:migrate
DATABASE_URL='postgresql://<user>:<password>@127.0.0.1:55432/researcher_manager' \
  pnpm db:migrate:status

# 真实数据库集成测试：未设置 TEST_DATABASE_URL 时用例**显式 skip**，不会伪造通过
TEST_DATABASE_URL='postgresql://<user>:<password>@127.0.0.1:55432/researcher_manager_test' \
  pnpm --filter @rm/api test
```

初始化脚本 `db/docker/init/00-databases.sql` 已在首次建库时额外创建 `researcher_manager_test`
（库名必须含 `test`，集成测试会在库名不含 `test` 时 fail-closed 拒绝执行 DDL）。

### 2.2 常用排查命令

```bash
docker compose --env-file .env.docker logs -f api          # 追 API 日志
docker compose --env-file .env.docker logs -f postgres
docker compose --env-file .env.docker exec api \
  node -e "console.log(process.env.API_PREFIX)"            # 确认容器内配置
docker compose --env-file .env.docker config               # 渲染最终编排（不含真实值）
```

`api` 容器的健康检查复用 `scripts/docker-healthcheck.mjs`，它按 `API_PREFIX` 拼出
`<API_PREFIX>/health` 并只在 **HTTP 200** 时返回 0。该脚本也能在宿主机自测：

```bash
API_PORT=3000 node scripts/docker-healthcheck.mjs   # 本机 API 在跑时应打印 healthy 并以 0 退出
API_PORT=1    node scripts/docker-healthcheck.mjs   # 连不上时应打印 unhealthy 并以 1 退出
```

---

## 3. 镜像是怎么构建的

```bash
docker build -t rm-api:dev .
```

- **构建上下文必须是仓库根**：`pnpm-workspace.yaml` 与各包 manifest 要同时可见。
- 三个阶段：`deps`（`pnpm install --frozen-lockfile`）→ `build`（`pnpm build:packages`
  再 `pnpm --filter @rm/api build`）→ `runtime`。
- **顺序是硬要求**：`services/api/tsconfig.build.json` 清空了 `paths`，编译期 `@rm/*` 从
  `node_modules` 解析，所以 `@rm/shared`、`@rm/ai-adapter` 必须先有 `dist`。新增 `@rm/*`
  工作区依赖时，`pnpm verify:docker` 会要求 `build:packages` 一并覆盖。
- **入口**：`CMD ["node", "services/api/dist/main.js"]`，与 `services/api/package.json` 的
  `main`（`dist/main.js`）一致；该产物由 `pnpm --filter @rm/api build` 生成。
- 运行阶段以非 root 用户 `node` 启动，`EXPOSE 3000`。
- 前端（`apps/admin-web`、`apps/miniapp`）**不进**这个镜像：API 镜像不该携带前端产物。
- 当前镜像是**开发/联用**镜像，运行阶段仍含 devDependencies；最小化需要 `pnpm deploy --prod`，
  而它不支持本仓库 `.npmrc` 的 `node-linker=hoisted`，属后续发布切片。

---

## 4. 生产档（TLS + fail-closed）

```bash
cp .env.docker.example .env.docker.prod
# 逐项替换 change-me-* / REPLACE-ME-*；口令与密钥由密钥管理系统生成后注入
docker compose -f docker-compose.prod.yml --env-file .env.docker.prod config   # 先渲染检查
docker compose -f docker-compose.prod.yml --env-file .env.docker.prod up -d
```

生产档与开发档**分开维护**（不用 `-f` 叠加）：生产差异是结构性的，而叠加式覆盖对 `ports`
这类序列字段是追加而不是替换，`config` 输出容易看错。生产档的特点：

- **数据库不发布端口**到宿主机，只在编排网络 `rm-internal` 内通过 `expose` 暴露；
- **API 端口只绑宿主机回环**：`api` 的 `ports` 必须用长语法逐项声明
  `host_ip: 127.0.0.1` / `target: 3000` / `published: "${API_PORT:-3000}"` / `protocol: tcp`。
  禁止 `0.0.0.0`、`::` 这类通配地址，也禁止空 `host_ip`、缺 `host_ip` 与短语法
  （`"${API_PORT:-3000}:3000"`）——Compose 对缺省 host 的处理就是绑**所有网卡**，
  宿主机只要有公网/局域网地址，API 就被直接暴露。需要对外提供服务时，在宿主机上用
  反向代理或防火墙把流量转发到回环端口，而不是让容器监听所有网卡；
- 不挂载 `db/docker/init`（它会在生产库里创建 `*_test` 数据库）；
- **TLS 两端都开**：postgres `ssl=on` + 服务端证书，并用 `db/docker/prod/pg_hba.conf`
  （`hba_file=`）**只接受 `hostssl`**、显式 `reject` 明文连接；api 用 `verify-full` 校验
  证书链与主机名；
- `DATABASE_SSL_MODE: verify-full` **写死在编排里**，不能用环境变量降级成 `disable`/`require`；
- 所有机密与取证事实用 `${VAR:?}` 声明为**必填**，缺失时解析阶段就失败；
- **优雅停止窗口显式声明**：`api` 与 `postgres` 都写 `stop_grace_period: 30s`。Compose 的缺省
  停止窗口只有 10s（即 Docker 默认的 SIGTERM→SIGKILL 宽限期），对 postgres 的 smart shutdown
  （等连接退出、收尾 checkpoint 与 WAL）和 api 的在途请求收尾都偏短；超时即 SIGKILL，属非优雅
  终止，编排层表现为 `down`/重建时卡在停止阶段（shutdown BLOCK）。该值必须是**带单位的严格时长**
  且解析后**恰好** 30 秒（`30s` / `30000ms` / `0.5m` 等等价写法都接受），裸数字 `30` 与
  `${VAR}` 插值一律判失败——前者在 Compose 里的含义无法从文件确定，后者会让窗口在运行时漂移；
- 证书目录以 `RM_TLS_DIR` 只读挂载到 `/etc/rm-tls`，镜像与仓库里**没有**证书内容。

### 4.1 生产凭据与取证事实（缺一即拒绝启动）

| 变量                                                  | 作用                                                         | 缺失时                                                   |
| ----------------------------------------------------- | ------------------------------------------------------------ | -------------------------------------------------------- |
| `POSTGRES_USER` / `POSTGRES_PASSWORD` / `POSTGRES_DB` | 数据库凭据                                                   | Compose 解析失败                                         |
| `DATABASE_URL`                                        | API 连接串（`sslmode=verify-full`）                          | Compose 解析失败；`NODE_ENV=production` 时应用也拒绝启动 |
| `SESSION_SECRET`                                      | 会话密钥（≥32 字节随机值）                                   | Compose 解析失败                                         |
| `RM_TLS_DIR`                                          | 宿主机证书目录（绝对路径，只读挂载）                         | Compose 解析失败                                         |
| `DATABASE_EXECUTOR_*`                                 | SQL 执行器取证事实（id / 验证人 / 时间 / 可核对引用 / 方法） | 应用在**任何数据库连接之前**终止启动                     |
| `DATABASE_SCHEMA_*`                                   | schema 就绪事实                                              | 同上                                                     |
| `DATABASE_MIGRATION_*`                                | 代码侧可用版本与数据库侧已应用版本                           | 同上                                                     |

取证事实必须由**真的做过验证的人或 CI**填写（CI 运行链接、集成测试用例路径都属于可核对引用）；
代码不会替你生成「已验证」。填写 `DATABASE_MIGRATION_APPLIED_VERSIONS` 前请先跑
`pnpm db:migrate:status` 核对。

### 4.2 边界：为什么开发档的 API 不带 `DATABASE_URL`

这不是配置疏忽，是安全边界：**只要**运行时解析出 `DATABASE_URL`，启动期持久化边界就要求
「已 attest 且证据完整的 SQL 执行器」**且**「认证依赖（会话存储）先就绪」。会话存储 adapter
尚未落地，因此带库启动会被按设计拒绝（`services/api/src/db/persistence/*` 里的依赖就绪门禁）。
开发档的 `api` 服务因此只用于「无数据库」形态的镜像/可观测性验证。

---

## 5. 证书准备（生产档）

在**仓库之外**的目录生成自签/正式证书（示例用自签，正式环境用 CA 签发）：

```bash
export RM_TLS_DIR="$HOME/rm-certs"     # 仓库外目录；.gitignore/.dockerignore 已排除 certs/、*.pem、*.key
mkdir -p "$RM_TLS_DIR" && cd "$RM_TLS_DIR"

# CA
openssl req -x509 -newkey rsa:4096 -nodes -days 3650 \
  -keyout ca.key -out ca.pem -subj "/CN=rm-local-ca"

# 服务端证书（CN/SAN 必须与 api 连接串里的主机名一致，生产档里是服务名 postgres）
openssl req -newkey rsa:4096 -nodes -keyout server.key -out server.csr -subj "/CN=postgres"
openssl x509 -req -in server.csr -CA ca.pem -CAkey ca.key -CAcreateserial \
  -out server.crt -days 825 -extfile <(printf "subjectAltName=DNS:postgres,DNS:localhost,IP:127.0.0.1")

# 认证规则（仓库内的公开文件，拷到证书目录供 postgres 通过 hba_file 读取）
cp /mnt/d/WorkSpace/ReseacherManager/db/docker/prod/pg_hba.conf "$RM_TLS_DIR/pg_hba.conf"

# 权限：bind mount 保留宿主机权限位——容器内 postgres/node 必须读得到
chmod 644 ca.pem server.crt pg_hba.conf
chmod 640 server.key ca.key            # 私钥只给必要的读者
```

把 `.env.docker.prod` 里的 `RM_TLS_DIR` 指向该**绝对路径**。证书只登记路径：
`DATABASE_SSL_CA_PATH` 等用容器内路径 `/etc/rm-tls/*`，宿主机路径只出现在环境变量里。

---

## 6. 生产反向代理与访问日志脱敏清单（部署必做）

生产档把 `api` 的宿主端口**只绑回环**（第 4 节），对外服务因此在宿主机上由反向代理（或托管负载均衡）
终结 TLS 并转发到回环端口。这一层是**独立的票据泄露面**：即便应用侧日志已经脱敏，代理自身的访问日志、
错误日志与编排/宿主机日志仍可能把 `Authorization`、`Cookie`、查询串里的凭据原样落盘。本节给出**部署必做**
的清单与验收证据要求。

> **保持同源收敛、CORS 默认关闭**：应用不调用 `enableCors()`，不发出任何 `Access-Control-Allow-*`、
> 不回显 `Origin`、不允许 credentials。跨源需求一律由部署侧把前端与 API **收敛到同一站点**（同一域名/端口
> 下的反向代理路径）来解决；不要把「打开 CORS」当成代理配置的替代品，也不要在代理层添加回显来源的响应头。

> **本节刻意不给 Nginx / Caddy / Apache / 托管负载均衡的具体配置片段**：各实现的指令名、模块与生效位置
> 不同，照抄一段「看起来已经脱敏」的配置**不能证明**脱敏生效——日志格式里到底有没有记录某个头，只有真实
> 请求触发的日志能回答。请按下面的清单在你所用的代理实现上逐项落实，并用第 6.2 节的真实请求证据验收。

### 6.1 清单

| 编号 | 要求                                                                                                                                                                                                                                                                                                                                                      | 可核对证据                                                                                                                  |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| L1   | **`Authorization` 与 `Cookie` 必须禁记或固定脱敏**：访问日志（以及任何其它日志格式）不得包含这两个头的值；代理默认格式若会记录（例如常见的 combined 格式包含 Cookie），必须显式关闭该字段，或改写成**固定占位符**。不接受「保留前后若干字符」的部分脱敏——片段往往仍可还原                                                                                 | 脱敏后的日志格式定义 + 一条真实请求的日志样本（这两处为固定占位符或完全缺失）                                               |
| L2   | **query string 默认不记录**：访问日志默认不落查询串；同时**禁止把 token / 凭据放进 query**（`?token=`、`?access_token=`、`?code=`、`?session=` 这类形态一律禁止），API 侧也不得回显此类参数；若某些路径必须转发查询串，代理侧必须显式保证它不落盘                                                                                                         | 日志格式定义 + 一条带查询串的真实请求：代理日志中该请求行不含查询串                                                         |
| L3   | **request body 一律不记录**：代理与应用都不得记录请求体（表单、JSON、multipart，以及错误路径上的原始 body）；「只在 4xx/5xx 时记录」同样禁止——登录与令牌端点的**失败**请求恰恰最可能带凭据                                                                                                                                                                | 双向核对：代理日志与 `docker compose logs api` 中均无请求体                                                                 |
| L4   | **机密与取证事实不得进日志**（全链路）：`DATABASE_URL`（含连接串中的口令）、`POSTGRES_PASSWORD`、`SESSION_SECRET`、`AI_API_KEY` 及其它 `AI_*` 密钥类变量、AI keys/evidence 与相关证据引用。代理日志、API 容器日志、宿主机 journal/syslog、编排层日志（`docker compose logs` / `docker logs`）**逐个**核对，不能因为「应用侧已脱敏」就跳过代理层，反之亦然 | 逐处日志的检索结果（关键词：`DATABASE_URL`、`POSTGRES_PASSWORD`、`SESSION_SECRET`、`AI_API_KEY`、`Bearer`）为空或只剩占位符 |
| L5   | **禁止 debug / 请求头 / 环境变量转储**：不得开启会把请求头全量或 `process.env` 打进日志的调试开关与诊断端点（应用侧 `DEBUG` / `NODE_DEBUG` / `NODE_OPTIONS`、代理的 debug/trace 级别、请求头转储中间件），也不得为排查临时把 `env` / `printenv` 输出到日志；`docker inspect` 与容器环境输出不得粘进工单、群聊或笔记                                       | 代理与应用日志级别的核对记录；日志中无环境变量列表、无完整请求头转储                                                        |
| L6   | **错误日志同样脱敏**：异常、堆栈与上游错误体不得携带 `Authorization` / `Cookie` / 连接串 / 密钥。代理写入自身日志的错误信息与返回给客户端的错误信息都必须经过同一套脱敏规则（堆栈可以记录，但其中的请求头、请求体与环境值必须已脱敏）；上游 5xx 时不得把完整请求回显进错误日志                                                                            | 一条故意触发 4xx/5xx 的真实请求：代理错误日志、应用错误日志、响应体三处均无票据                                             |
| L7   | **最小必要 retention 与受限访问**：保留期按最小必要设定并写入部署记录（有明确上限，不默认「永久保留」）；日志目录与采集通道只授予运维/审计所需的受限访问（非全员可读、非默认公开的对象存储桶）；日志导出、下载与订阅同样受限并留痕                                                                                                                        | 保留期数值与生效位置、日志访问控制清单（谁能读、经什么通道）均可在部署记录中查到                                            |
| L8   | **真实请求验证与部署证据**：每次生产部署都要做一遍第 6.2 节的验证，并把证据记入部署记录                                                                                                                                                                                                                                                                   | 见第 6.2 节的证据清单                                                                                                       |

### 6.2 真实部署验证：带票据的请求不得出现在任何日志里

对**部署后的真实环境**（含反向代理）执行验证，只在本地跑通不算数：

1. 准备一个**一次性、可撤销**的测试令牌（Bearer 或会话），**不要**用真实生产用户令牌；
2. 用它发一条真实的成功请求，再用同一条令牌发一条**失败路径**请求（4xx/5xx），另发一条把凭据放进
   query 的请求（用于核对 L2）；
3. 在该请求经过的**每一处**日志中检索该令牌字符串及其可还原片段：
   - 代理的访问日志与错误日志（含轮转后的上一个文件）；
   - API 容器日志（`docker compose logs api`）；
   - 宿主机与编排层日志（journald / syslog / docker daemon 日志）；
   - 已接入的日志采集/转发目的地（含 ingest 缓冲与索引）；
4. **判定**：任一位置出现令牌原文或可还原片段 → 本次验证**不通过**，修到全部不可见后**重做整套验证**
   （修好一处不等于修好全链路，漏掉的往往是另一层）；
5. 验证结束后**立即吊销/删除**该测试令牌。

**部署证据**（写入部署记录；证据本身也**不得包含票据原文**）：

| 证据项     | 内容                                                                                                      |
| ---------- | --------------------------------------------------------------------------------------------------------- |
| 时间与环境 | 验证时间、执行人、环境标识、代理软件与版本、所用编排文件路径                                              |
| 请求形状   | 形如「Bearer <一次性测试令牌>」的描述，**不写**票据值；注明覆盖了成功路径 + 失败路径 + query 凭据三种请求 |
| 逐处结果   | 每处日志的检索命令/关键词与结果（命中 0 次，或只剩固定占位符）                                            |
| 处置与销毁 | 发现的问题与修复方式、测试令牌的吊销时间与方式                                                            |

> 本次交付**没有**做过任何真实代理部署验证（本仓库构建环境没有可用的 Docker 守护进程，也没有配好的反向代理），
> 因此上述清单是**部署要求**，不是「本仓库已经做到」的声明；第 9 节如实记录了本次的验证边界。

---

## 7. AI Provider 出站（egress）与生产验证（部署必做）

生产档默认 `AI_PROVIDER=disabled`（不联网），开发档默认 `mock`（本地桩）；**只有**显式改成
`http-json` 时，API 才会真正向外部模型服务发出请求。此时多出一条独立于数据库的**出站面**：
SSRF（把出站请求打到内网或云 metadata）、把 `Bearer` 密钥送到非预期主机、以及提示词/请求体/响应体
进入日志。本节给出**部署必做**的要求与证据要求。

> **应用侧的字面量校验不等于网络可达性证明**：端点判定（`packages/ai-adapter/src/provider/endpoint.ts`
> 与 `services/api/src/config/env.ts` 复用同一份逻辑）只判断 URL 文本与主机名字面量，**不做 DNS 解析、
> 不建立连接**。它能**可证明地**拒绝字面量危险地址，但**不能**证明「已放行的域名解析后落在公网」。
> 网络层 egress 收敛与 DNS 验证只能由部署环境承担（7.2、7.4）。

> **本节刻意不给 Nginx / Caddy / Apache / 云厂商安全组的具体配置片段**：与第 6 节同理，各实现的指令名、
> 作用位置与默认语义不同，照抄一段「看起来已收敛」的片段**不能证明** egress 真的只放行了目标 host/port。
> 请按下面的清单在你所用的实现上逐项落实，并用 7.4 / 7.5 的**真实环境**证据验收。

### 7.1 生产 `AI_BASE_URL`：固定、精确、不接受任意用户可配 URL

| 编号 | 要求                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A1   | **固定单点**：每个生产环境只允许**一个**取值，形如 `https://<精确主机>`（可带一个明确端口），由密钥管理/部署配置在部署时注入；不允许按请求、按用户或按前端设置切换端点                                                                                                                                                                                                                                                                                                                                                       |
| A2   | **不接受任意用户可配 URL**：不得提供任何让用户/前端/调用方填 baseURL 的入口（API 参数、请求头、管理界面都不行）。当前实现只从进程环境变量读取 `AI_BASE_URL`，运行时请求没有覆盖它的通道；这是**必须保持**的边界                                                                                                                                                                                                                                                                                                              |
| A3   | **精确 host allowlist**：确需访问本机/内网模型网关时，把该**精确主机名**（大小写不敏感，忽略 IPv6 方括号与末尾根点）列入 `AI_TRUSTED_HOSTS`（逗号分隔）。**不支持通配符、后缀或正则匹配**，未命中即 fail-closed；该条目只放宽「主机安全」与「端口范围」两项，**不**放宽协议、userinfo、query、hash、反斜杠与控制字符                                                                                                                                                                                                         |
| A4   | **端口白名单**：未列入受信主机时只允许协议标准端口（`https`→443、`http`→80）；其他端口必须由受信主机条目**显式**放行                                                                                                                                                                                                                                                                                                                                                                                                         |
| A5   | **启动期 fail-closed**：校验在环境变量解析阶段执行，不通过则 API **拒绝启动**；错误消息含变量名与规则，**不回显取值**（取值可能含凭据）                                                                                                                                                                                                                                                                                                                                                                                      |
| A6   | **生产环境强制 HTTPS**：`NODE_ENV=production` **且**匹配开关打开（`AI_MATCHING_ENABLED`）**且** `AI_PROVIDER=http-json`（即真的会出站）时，`AI_BASE_URL` **只接受 `https:`**；明文 `http` 一律在启动期被拒（fail-closed），且该判定**不**被 `AI_TRUSTED_HOSTS` 放宽。其余组合（`disabled` / `mock` / 匹配关闭 / `development` / `test`）语义不变，本机与内网 `http` 网关仍可按受信主机放行。该规则只依赖 `NODE_ENV` 与上面两个已定义开关，不依赖任何其它未定义配置；错误消息只含变量名与规则，不回显 URL、主机名、端口或密钥 |

字面量层面**可证明拒绝**的类别（应用侧，任一命中即拒绝启动或拒绝创建 Provider）：

| 类别                                  | 例子                                                                                                                     |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| IPv4 私网（RFC1918）                  | `10.0.0.0/8`、`172.16.0.0/12`、`192.168.0.0/16`                                                                          |
| CGNAT                                 | `100.64.0.0/10`（含云元数据 `100.100.100.200`）                                                                          |
| 回环                                  | `localhost`、`127.0.0.0/8`、`::1`                                                                                        |
| link-local 与云 metadata              | `169.254.0.0/16`（含 `169.254.169.254`）                                                                                 |
| 保留 / 组播 / 未指定 / 文档与测试网段 | `0.0.0.0/8`、`224.0.0.0/4` 及以上、`192.0.2.0/24`、`198.51.100.0/24`、`203.0.113.0/24`、`198.18.0.0/15`、`2001:db8::/32` |
| IPv6 ULA / 链路本地 / IPv4 映射       | `fc00::/7`、`fe80::/10`、`::ffff:0:0/96`（`2000::/3` 之外一律拒绝）                                                      |
| 无法可靠判定的名字                    | 单标签内网短名、`.internal`/`.local`/`.lan`/`.corp`/`.home.arpa` 等私有后缀、含下划线/转义/畸形 IP 字面量                |
| 结构违规                              | 非 `http`/`https`、含 userinfo、query、hash、反斜杠或控制字符                                                            |

### 7.2 容器与宿主机 egress：只放行该 host/port

| 编号 | 要求                                                                                                                                                                                       |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| E1   | **出口默认拒绝、只放行目标**：API 容器与宿主机（含编排网络与出站网关）只允许到 7.1 固定的**该主机 + 该端口**；其余一切出站默认拒绝。DNS 解析器是必要依赖，同样只放行所需解析器             |
| E2   | **危险目标必须显式拒绝**（与是否通过应用侧校验无关）：RFC1918、IPv6 ULA、loopback、link-local、云 metadata（`169.254.169.254`、`100.100.100.200` 等），以及任何**未列入 allowlist** 的目标 |
| E3   | **网络层是独立且必需的一层**：应用不做 DNS 解析，无法阻止「已放行域名被解析到内网」，仅靠应用侧校验**不构成** egress 控制；两侧都要有                                                      |
| E4   | **证据**：出口策略的作用位置与生效范围（编排网络 / 宿主机防火墙 / 出口网关）、以及一次「到未允许目标被拒绝」的真实观测（连接被拒或超时的原始输出，不含密钥）                               |

### 7.3 Provider 侧硬约束（代码已实现，无需部署额外动作）

| 行为                            | 实现                                                                                                                                                                                | 可核对位置                                                                                            |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| **拒绝重定向**                  | `fetch` 显式 `redirect: 'error'`；3xx 响应同样判定 → 安全 `ProviderError`（`safeDetails.reason = 'redirect'`）；**不跟随**、不把密钥带去新主机；错误消息不含目标 URL 与原始 baseURL | `packages/ai-adapter/src/provider/http-json-provider.ts`、`src/__tests__/provider.spec.ts`            |
| **超大响应**                    | 默认 1 MiB 硬上限（`AI_MAX_RESPONSE_BYTES`，1024–16777216）：先看 `content-length`，再按流式分块计数，超限立即取消读取并降级，**不做 JSON 解析**                                    | 同上                                                                                                  |
| **非 2xx / 网络失败**           | 只暴露 HTTP 状态码或错误名；不回显响应体、完整 URL 或密钥                                                                                                                           | 同上                                                                                                  |
| **API key 只发给受信 endpoint** | 密钥只放在 `Authorization: Bearer <key>` 请求头，绝不进请求体、日志与错误消息；只有通过端点校验的受信 endpoint 才会拿到该头                                                         | 同上；`services/api/src/config/env.spec.ts`                                                           |
| **失败即安全降级（fail-safe）** | provider 任何失败 → 规则推荐（确定性、可解释）；日志只记稳定错误码（`[matching] 匹配降级: <code>`），不记提示词、请求体、响应体、baseURL 或密钥                                     | `packages/ai-adapter/src/matching/invoke.ts`、`services/api/src/modules/matching/matching.service.ts` |

### 7.4 真实部署验证：DNS 解析与解析后 IP

在**真实部署环境**（含 egress 策略、实际解析器与真实模型端点）执行，静态文档与单测都不算：

1. 对**实际发起出站的那一侧**（API 容器内，必要时再加宿主机/出口网关侧）解析 7.1 的固定主机，
   记录命令与完整输出（`getent ahosts <host>`、`dig +short <host>` 等，以该环境实际使用的解析器为准）；
2. **判定**：任何一次解析结果落入 RFC1918 / IPv6 ULA / loopback / link-local / 云 metadata /
   其他未允许网段 → 本次验证**不通过**（应用侧通过校验也一样不通过），修好 DNS 与 egress 后**重做整套验证**；
3. **重复解析稳定性**：连续多次、跨进程/跨容器（建议同时跨越一段时间）解析，结果集合必须一致；
   出现变化即记录并复核该主机的权威解析与缓存路径，不得当作偶发忽略；
4. **DNS rebinding**：应用侧**不做 DNS 解析**，因此**无法**证明「校验时的解析结果 == 实际连接时用的 IP」。
   该风险只能由部署环境的真实证据来缓解：egress allowlist 确实生效（只允许该 host/port）、解析结果稳定且为
   公网、并有连接实测记录。**没有这些证据就不得声称 rebinding 已缓解**；
5. 取证只写主机名、命令、IP、时间与结果，**不得写密钥**。

### 7.5 一次性凭据 + 恶意 fixture + 全链路日志核对

1. 准备一个**一次性、可撤销**的测试 API key（验证后立即吊销），**不要**用生产 key；
2. 三类请求 fixture（离线夹具已在仓库内，**真实环境**再各做一次）：
   - **正常一次 Bearer 请求**：请求头携带 `Authorization: Bearer <一次性 key>`，核对 key 只出现在该头里；
   - **恶意 redirect**：让端点返回 3xx（或指向非受信主机）→ 必须按安全 `ProviderError` 降级，
     **不跟随**跳转，且未把 key 发往新主机；
   - **超大响应**：返回超过 `AI_MAX_RESPONSE_BYTES` 的响应 → 必须安全降级，且**不解析**响应体。

   离线夹具可核对的位置：`packages/ai-adapter/src/__tests__/provider.spec.ts`（`redirect: 'error'`、
   3xx、`content-length` 与流式超限）与 `services/api/src/config/env.spec.ts`（危险 `AI_BASE_URL`
   启动即失败且不回显原文）。**离线夹具通过不等于真实部署通过**；

3. **安全 fallback 判定**：以上失败必须落为规则推荐（`fallbackUsed`/`degraded` 为真、稳定错误码），
   业务侧不抛异常、不返回模型原文；
4. **全链路日志核对**（与第 6 节同一套方法，逐处覆盖）：代理访问日志与错误日志、`docker compose logs api`、
   宿主机 journald/syslog 与 docker daemon 日志、已接入的日志采集/转发/索引目的地。检索以下内容**全部不得命中**：
   AI key 原文、提示词/请求体、响应体、`baseURL`/端点主机名与端口、任何票据（Bearer / 会话）；
   允许的只有**固定占位符**或稳定错误码；
5. 验证结束后**立即吊销/删除**该测试 key。

**部署证据**（写入部署记录；证据本身也**不得包含 secret**）：

| 证据项        | 内容                                                                                  |
| ------------- | ------------------------------------------------------------------------------------- |
| 时间与环境    | 验证时间、执行人、环境标识、编排文件路径、所用解析器                                  |
| 端点与 egress | 固定主机与端口（非机密，可写）、`AI_TRUSTED_HOSTS` 条目、出口策略的作用位置与生效范围 |
| DNS 证据      | 解析命令、解析出的 IP、重复解析次数与结果集合、是否稳定、是否落入私网/metadata 的结论 |
| fixture 结果  | 三类请求（Bearer / 恶意 redirect / 超大响应）各自的降级结果与稳定错误码               |
| 逐处日志结果  | 每处日志的检索命令/关键词与结果（命中 0 次，或只剩固定占位符）                        |
| 处置与销毁    | 发现的问题与修复方式、测试 key 的吊销时间与方式                                       |

> 本次交付**没有**做过任何真实部署的 AI 出站验证：本仓库构建环境没有可用的 Docker 守护进程，也没有配好的
> egress 策略、解析器与真实模型端点。因此 7.1–7.5 的 egress / DNS / 日志要求是**部署要求**，不是
> 「本仓库已经做到」的声明；7.3 所列的 redirect 拒绝、超大响应拒绝、key 仅在请求头与失败降级属**代码行为**，
> 由仓库内单测覆盖，同样**不等于**部署证明。第 9 节如实记录本次验证边界。

### 7.6 生产 TLS 部署清单（部署必做）

生产档的 `AI_PROVIDER` 默认是 `disabled`（第 7 节开头），**一旦**改成 `http-json` 并打开匹配开关，
`AI_BASE_URL` 就必须是 `https:`（7.1 的 A6 已在**启动期**强制，明文 `http` 直接拒绝启动）。
但「配置里写了 `https`」只说明协议名，**不构成**链路加密与对端身份的任何证明：证书链是否完整、
主机名是否匹配、签发 CA 是否受信、证书是否在有效期内，都只有真实握手能回答。以下逐项在**真实环境**落实并取证。

| 编号 | 要求                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| T1   | **生产 AI provider 必须 HTTPS**：`AI_PROVIDER=http-json` 且匹配开启的生产环境只允许 `https://<精确主机>`（可带一个明确端口）。明文 `http` 在启动期即被拒（A6），不要试图用 `AI_TRUSTED_HOSTS` 绕过——它只放宽主机与端口两项，**不放宽 TLS**                                                                                                                                                                                                                                                                                                 |
| T2   | **验证证书链完整**：服务端必须提交**完整的中间证书链**（叶子 + 中间 CA）。缺中间证书时部分客户端会失败、部分会「静默成功」，这本身就是不可接受的不确定性。用真实握手核对链的深度与顺序，而不是只看证书文件是否存在                                                                                                                                                                                                                                                                                                                         |
| T3   | **验证 hostname / SAN 匹配**：证书的 SAN 必须覆盖 `AI_BASE_URL` 里**实际使用的那个主机名**（不是别名、不是 CNAME 目标、不是另一张证书上的名字）。仅靠 CN 的老式匹配不视为满足；`AI_BASE_URL` 用 IP 字面量时证书 SAN 必须含该 IP，且更推荐改用域名                                                                                                                                                                                                                                                                                          |
| T4   | **验证 CA 信任并禁用绕过**：签发链必须锚定到本环境**显式信任**的 CA——系统信任库、容器镜像内的 CA 包，或通过 `NODE_EXTRA_CA_CERTS`（或平台等价机制）挂载的私有 CA **证书内容**（只登记路径即可，内容来自挂载卷 / 密钥管理，绝不写入仓库）。**生产环境禁止** `NODE_TLS_REJECT_UNAUTHORIZED=0`，以及任何等价形态的 TLS 校验绕过（自定义 `fetch`/agent 关闭 `rejectUnauthorized`、改写全局 `https.globalAgent`、把校验失败降级为「记录后继续」、或把端点交给一个不校验证书的中间代理）。命中任一项即为**部署不合规**，必须修掉而不是记录后放行 |
| T5   | **验证有效期与续期**：核对证书的 `notBefore` / `notAfter` 与剩余有效期，并确认**自动续期与到期告警**存在（含私有 CA 的根与中间证书本身）。不接受「到期当天人工换证」这种没有告警兜底的做法；也不接受把过期证书错误当成「网络抖动」重试                                                                                                                                                                                                                                                                                                     |
| T6   | **禁止降级到明文**：不得为了让请求「先跑通」而把端点改回 `http`、不得把 HTTPS 终结在一个不受信/不校验证书的中间跳、不得在应用与真实模型端点之间插入明文跳。任何一次排障如果临时放宽了校验，必须**恢复到强校验**并重做 7.4/7.5/7.8 的整套验证                                                                                                                                                                                                                                                                                               |

### 7.7 HTTP_PROXY / HTTPS_PROXY / NO_PROXY 的部署约束（**仅当**运行时或全局 dispatcher 真的生效时适用）

先判断**是否生效**，再谈约束：

- **生效的情形**：运行该进程的运行时/toolchain（或它使用的全局 HTTP dispatcher / agent 层）在**未显式传入**
  proxy 选项时也会读取 `HTTP_PROXY` / `HTTPS_PROXY` / `NO_PROXY` 等环境变量——此时这两个变量会**静默改变**
  出站请求的去向。
- **不生效的情形**：运行时或其 dispatcher 不读取这些变量（请求直连）。此时**不要**假设「配了环境变量就等于走代理」，
  也不要因为「没配代理变量」就认为出站已被控制：控制只能来自 7.2 的 egress 收敛与 7.6 的 TLS 校验。

**不要在本仓库里断言当前运行时属于哪一种**：这取决于具体运行时版本与其 dispatcher 实现，属于**部署期必须实测**的事实（见 7.8）。若需要显式代理支持，那是代码/依赖层的变更，须单独评估与评审——**不得**通过修改 `packages/ai-adapter` 的 HTTPS 强制、重定向拒绝、响应体上限或端点校验来实现（7.3 的硬化行为是**必须保持**的边界）。

| 编号 | 要求（代理生效时）                                                                                                                                                                                                                   |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| P1   | **代理仅允许受信 host/port**：只允许指向运维确认过的出口代理（精确主机名与端口）。代理地址同样不得指向公网任意主机、用户可配地址或未受控的第三方；代理自身的选择范围也应按 7.2 收敛                                                  |
| P2   | **`Authorization`（及 AI key）不得经过非受信代理**：只有受信代理可以见到请求头。任何不受信、共享、来源不明的代理一旦出现在链路上，API key 就等同于交给该代理——此时必须**拒绝出站**，而不是「照常发出去」                             |
| P3   | **显式 `NO_PROXY` 收敛**：`NO_PROXY` 必须显式列出**必须直连**的主机（至少包含 `AI_BASE_URL` 的目标主机与内部依赖主机名），避免内部流量被意外送进外部代理；不要依赖空值或「约定俗成」的默认行为                                       |
| P4   | **禁止明文代理协议承载密钥**：代理协议自身若为明文（如 `http://` 代理），则 `Authorization` 头在应用与代理之间是明文传输，**不可接受**；只允许经 TLS 保护的代理通道（或容器/主机级的等价加密通道）                                   |
| P5   | **代理不得关闭上游校验**：不得配置「上游证书不校验」「上游 TLS 降级」这类代理选项；代理对上游必须做与 T2–T5 同等的链、SAN、CA 与有效期校验，而不是替客户端「信任一切」                                                               |
| P6   | **代理日志与 6.1 同一套脱敏**：代理会看到 `Authorization`，其访问日志/错误日志因此是独立的票据泄露面；必须逐项满足第 6 节的 L1–L7（禁记或固定脱敏、不记 query、不记请求体、不记机密），并纳入 6.2 的真实请求检索范围                 |
| P7   | **DNS 与代理的一致性**：代理生效时，出站 DNS 解析发生在**代理侧**（而非 API 容器内），因此 7.4 的解析证据必须在**实际解析的那一侧**采集，并同样满足「不落私网 / 不落 metadata / 重复解析稳定」的判定；只测容器内解析不足以覆盖该链路 |

### 7.8 真实部署验证：TLS、代理、redirect 与 DNS/egress（把证据存下来）

对**部署后的真实环境**（真实模型端点、真实解析器、真实出口策略，代理生效时含真实代理）执行，
离线单测、静态文档与 `docker compose config` 渲染**都不算**。取证只写主机名、端口、命令、时间与结果，
**不得写 key、令牌、连接串或任何可还原片段**；测试只用一次性、可撤销的凭据，验证后立即吊销。

1. **TLS 握手与证书链**：对 `AI_BASE_URL` 的目标主机 + 端口做一次真实握手，保存**完整**输出
   （`openssl s_client -connect <host>:<port> -servername <host> -showcerts` 或该环境等价的诊断命令），
   并逐项判定：
   - 链是否完整（叶子 + 中间 CA）并可验证到受信锚点（T2、T4）；
   - SAN 是否覆盖实际使用的那个主机名（T3）；
   - `notBefore` / `notAfter` 与剩余有效期、续期与告警机制（T5）；
   - 协议与加密套件是否为该端点明确支持的版本（不是「碰巧协商上了就通过」）。
2. **不得存在校验绕过**：核对该环境**实际生效**的进程环境变量与运行时配置——`NODE_TLS_REJECT_UNAUTHORIZED`
   **未设置或为 `1`**，不存在等价的全局 agent 改写或「校验失败仍继续」的开关（T4）。这一步要看**运行时真实读到的东西**
   （例如在容器内打印该变量名对应的取值），而不是看编排文件里「写了什么」。
3. **代理链路的确定性与受信性**（代理生效时）：给出「运行时是否读取 `HTTP_PROXY` / `HTTPS_PROXY` / `NO_PROXY`」
   的**实测结论**与判定方法（例如对比显式禁用代理与当前配置两种情形下出站目标的观测差异），并逐项核对
   P1–P7：代理主机/端口精确受信、`NO_PROXY` 显式列出必须直连的主机、代理协议加密、代理侧不关闭上游校验、
   代理日志与第 6 节同一套脱敏。
4. **redirect**：用一个**受控**端点返回 3xx（或指向非受信主机），确认实现**不跟随**、按安全 `ProviderError`
   降级、且 key **没有**被发往新主机——证据是「新主机侧未收到该次请求」的观测（或该侧访问日志中无该请求），
   而不只是「应用日志里没写成功」。
5. **DNS 与 egress**：按 7.4 记录解析命令与 IP 结果集合（代理生效时在代理侧采集），并做一次
   「到未允许目标被拒绝」的真实观测（连接被拒或超时的原始输出）；两者都要能回答「出站是否只到该 host/port」。
6. **重做条件**：以上任一项不通过 → 修好后**重做整套验证**（含 7.5 的全链路日志核对与本节全部条目）；
   修好一处不等于修好全链路。任何一次临时放宽（关闭校验、改回明文、绕开代理）之后都必须重做。

**部署证据**（写入部署记录；证据本身**不得包含 secret**；本节清单是**要求**，不是「已做到」的声明）：

| 证据项            | 内容                                                                                                                                     |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| 时间与环境        | 验证时间、执行人、环境标识、编排文件路径、API 镜像摘要、运行时版本                                                                       |
| 端点与协议        | 固定主机与端口（非机密，可写）、协议为 HTTPS、`AI_TRUSTED_HOSTS` 条目                                                                    |
| TLS 证据          | 握手命令、证书链完整性与锚定结果、SAN 与所用主机名的一致性判定、`notBefore`/`notAfter` 与剩余有效期、续期与告警机制                      |
| 校验绕过核对      | `NODE_TLS_REJECT_UNAUTHORIZED` 等绕过项的**运行时**取值（未设置 / 为 `1`），以及全局 agent 未被改写的核对结果                            |
| 代理证据          | 「运行时是否生效读代理变量」的实测结论与判定方法、代理主机/端口、`NO_PROXY` 条目、代理协议是否加密、代理侧上游校验设置、代理日志脱敏核对 |
| redirect 证据     | 触发方式、降级结果与稳定错误码、以及「新主机侧未收到该请求」的观测                                                                       |
| DNS / egress 证据 | 解析命令、解析出的 IP、重复解析次数与结果集合、是否落入私网/metadata 的结论、未允许目标被拒的原始输出                                    |
| 逐处日志结果      | 每处日志（代理 / API 容器 / 宿主机 / 采集索引）的检索命令与结果（命中 0 次，或只剩固定占位符）                                           |
| 处置与销毁        | 发现的问题与修复方式、测试 key / 令牌的吊销时间与方式                                                                                    |

---

## 8. fail-closed 行为速查

| 场景                                                                                     | 结果                                                               |
| ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| 机密变量未设置（生产档）                                                                 | Compose 解析阶段报错退出                                           |
| `NODE_ENV=production` 且 `DATABASE_URL` 缺失                                             | API 拒绝启动                                                       |
| 生产环境 TLS 档位不是 `verify-full`（含 `disable` / `require`）                          | API 拒绝启动                                                       |
| 生产环境对**非回环**主机关闭 TLS                                                         | API 拒绝启动（更具体的错误码）                                     |
| `DATABASE_SSL_CERT_PATH` 与 `DATABASE_SSL_KEY_PATH` 只配一个                             | API 拒绝启动（必须成对）                                           |
| 证书/`pg_hba.conf` 容器内不可读                                                          | 容器起不来（TLS 强制失败，不会静默降级）                           |
| 拿到 `DATABASE_URL` 但执行器未 attest / 会话存储未就绪                                   | API 在任何数据库连接之前终止启动                                   |
| 集成测试未设置 `TEST_DATABASE_URL`                                                       | 用例**显式 skip**，绝不伪造通过                                    |
| 集成测试目标库名不含 `test`                                                              | 用例失败                                                           |
| `AI_BASE_URL` 未通过出站端点校验（危险 / 畸形 / 未列入受信主机）                         | API 拒绝启动（消息不含取值）                                       |
| 生产环境匹配开启且 `AI_PROVIDER=http-json`，但 `AI_BASE_URL` 是明文 `http`（含受信主机） | API 拒绝启动（消息不含取值；TLS 要求不被 `AI_TRUSTED_HOSTS` 放宽） |
| `AI_PROVIDER=http-json` 且匹配开启但未配置 `AI_BASE_URL`                                 | API 拒绝启动（不静默退回桩 provider）                              |
| 模型服务返回 3xx 重定向                                                                  | 不跟随，安全降级为规则推荐                                         |
| 模型响应体超过 `AI_MAX_RESPONSE_BYTES`                                                   | 立即中止读取，安全降级为规则推荐                                   |

---

## 9. 门禁与本次验证边界

```bash
pnpm verify:docker                                  # Docker 打包静态门禁（不需要守护进程）
pnpm verify:docker -- --self-test                   # 用合成样本验证门禁自身
docker compose --env-file .env.docker.example config           # 开发档渲染
docker compose -f docker-compose.prod.yml --env-file .env.docker.example config   # 生产档渲染（占位符即可渲染）
docker compose --env-file .env.docker.example config >/dev/null && echo OK
```

`pnpm verify:docker` 断言的内容（都不需要 Docker 守护进程）：镜像的多阶段与工作区构建顺序、
容器启动入口与 `services/api/package.json` 的 `main` 一致、健康检查复用同一份跟随 `API_PREFIX`
的探针、两档编排的服务/网络/卷/依赖顺序/健康检查、凭据无内置默认值、生产档 `verify-full` 与
证书只读挂载、`pg_hba.conf` 拒绝明文、模板里机密字段仍是占位符、忽略规则正确排除证书与真实 `.env`；
生产档 `api` 的宿主端口还会**逐项**核对长语法的 `host_ip`（必须精确等于 `127.0.0.1`，通配 / 空 /
缺失一律失败）与 `target` / `published` / `protocol` 三项显式声明，短语法直接判失败。容器加固与
停机基线同样逐条复核：`read_only` / `cap_drop: [ALL]` / `no-new-privileges` / 显式非 root `user` /
`restart`，以及两个服务的 `stop_grace_period`——缺失、解析后过短（如 15s）、过长、非数值或不明确
配置（裸数字、`${VAR}` 插值、未知或大写单位）都会失败，对应的合成反例在 `--self-test` 里。

**如实声明**：本仓库的构建环境**没有可用的 Docker 守护进程**，因此本文档描述的容器**运行**行为
（真正 `up` 起来、`healthy`、连通性）没有在本次交付中做端到端验证；已完成的验证是
`docker compose ... config` 静态渲染与 `pnpm verify:docker` 静态门禁、以及本机直跑
`node services/api/dist/main.js` 的真实 HTTP 探针（`/api/v1/health` 200、`/health` 404）。
有 Docker 守护进程时，请按第 2 节的命令补做一次真实启动验证。

同理，第 6 节的反向代理与访问日志脱敏清单**属部署必做**：其中的日志检索、带票据请求验证与部署证据
都必须在**真实部署环境**（含反向代理与日志采集）里执行，本仓库的静态门禁与本地构建都无法代替它，
本次交付也没有做过该验证。

第 7 节的 AI provider 出站要求**同样属部署必做**：容器/主机 egress 只放行固定 host/port、拒绝
RFC1918 / ULA / loopback / link-local / metadata 与其他未允许目标、DNS 解析结果与重复解析稳定性的实测、
以及「解析期与连接期是否一致（DNS rebinding）」的部署证据，都只能在**真实部署环境**里取得。
本次交付**未**做过这些验证，也**不**声称静态文档或离线单测构成部署证明；仓库内已覆盖的是**代码行为**
证据（拒绝重定向、超大响应硬上限、key 仅在 `Authorization` 头、失败安全降级），见 7.3 与 7.5。

第 7.6 / 7.7 / 7.8 节的 TLS 与代理要求**同样属部署必做**，且本次交付**全部未验证**：证书链完整性、
hostname/SAN 匹配、CA 信任与有效期、`NODE_TLS_REJECT_UNAUTHORIZED` 等绕过项的运行时取值、
`HTTP_PROXY` / `HTTPS_PROXY` / `NO_PROXY` 在**该运行时与 dispatcher** 下是否真的生效、代理是否受信
以及 `Authorization` 是否只经过受信代理——这些只能在**真实部署环境**里实测取得，本仓库的静态门禁、
离线单测与本机直跑都无法代替。**本文档只是要求清单，不是「已经做到」的证明**；本次交付**不**声称
文档、静态门禁或离线单测构成任何部署证明。已落到**代码**里的强约束只有一条：生产环境在匹配开启且
`AI_PROVIDER=http-json` 时，明文 `AI_BASE_URL` 在**启动期**即被拒绝（7.1 的 A6，由
`services/api/src/config/env.ts` 实现、`services/api/src/config/env.spec.ts` 覆盖）；
TLS 校验是否真的生效、代理是否真的生效，代码层**无法**证明。

# Docker 与 WSL2 部署说明（公开）

本文档只描述**公开的**容器化方式：如何在本机 WSL2 上用 Docker 跑起 PostgreSQL 与 API 容器、
如何构建镜像、如何准备证书、哪些行为是刻意的 fail-closed。

- 本地开发档：`docker-compose.yml`（**仅本机**；数据库不启用 TLS）
- 生产档：`docker-compose.prod.yml`（TLS `verify-full` + 证书只读挂载 + 必填取证事实）
- 环境变量模板：`.env.docker.example`（只含占位符，**没有任何真实密钥**）
- 镜像：仓库根 `Dockerfile`（多阶段；API 容器入口 `node services/api/dist/main.js`）
- 静态门禁：`pnpm verify:docker`（不需要 Docker 守护进程）

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

## 6. fail-closed 行为速查

| 场景                                                            | 结果                                     |
| --------------------------------------------------------------- | ---------------------------------------- |
| 机密变量未设置（生产档）                                        | Compose 解析阶段报错退出                 |
| `NODE_ENV=production` 且 `DATABASE_URL` 缺失                    | API 拒绝启动                             |
| 生产环境 TLS 档位不是 `verify-full`（含 `disable` / `require`） | API 拒绝启动                             |
| 生产环境对**非回环**主机关闭 TLS                                | API 拒绝启动（更具体的错误码）           |
| `DATABASE_SSL_CERT_PATH` 与 `DATABASE_SSL_KEY_PATH` 只配一个    | API 拒绝启动（必须成对）                 |
| 证书/`pg_hba.conf` 容器内不可读                                 | 容器起不来（TLS 强制失败，不会静默降级） |
| 拿到 `DATABASE_URL` 但执行器未 attest / 会话存储未就绪          | API 在任何数据库连接之前终止启动         |
| 集成测试未设置 `TEST_DATABASE_URL`                              | 用例**显式 skip**，绝不伪造通过          |
| 集成测试目标库名不含 `test`                                     | 用例失败                                 |

---

## 7. 门禁与本次验证边界

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
缺失一律失败）与 `target` / `published` / `protocol` 三项显式声明，短语法直接判失败。

**如实声明**：本仓库的构建环境**没有可用的 Docker 守护进程**，因此本文档描述的容器**运行**行为
（真正 `up` 起来、`healthy`、连通性）没有在本次交付中做端到端验证；已完成的验证是
`docker compose ... config` 静态渲染与 `pnpm verify:docker` 静态门禁、以及本机直跑
`node services/api/dist/main.js` 的真实 HTTP 探针（`/api/v1/health` 200、`/health` 404）。
有 Docker 守护进程时，请按第 2 节的命令补做一次真实启动验证。

# 数据库迁移

> 阶段：P3 基础工程 → 第一阶段真实 PostgreSQL 集成。迁移**执行入口已落地**
> （`services/api/src/db/migrations/migration-runner.ts` + `run-migrations.ts`），驱动为官方
> `pg`；迁移文件本身的规范与静态校验保持不变（`scripts/db-migrations-lint.mjs`）。

## 目录约定

```text
db/migrations/
├─ 0001_bootstrap.sql          初始化 schema_migrations（元数据表，可回滚，不建业务表）
├─ 0002_education_records.sql  升学记录表（本人统计来源表）
├─ 0003_join_applications.sql  入组/退组申请表（本人统计来源表）
├─ 0004_achievements.sql       成果表（本人统计来源表）
├─ 0005_ai_match_records.sql   AI 匹配记录表（本人统计来源表）
├─ 0006_sessions.sql           服务端会话表（会话存储切片）
├─ 0007_student_profiles.sql   学生画像表（PostgreSQL 画像仓储切片）
├─ 0008_achievements_constraints.sql  成果表存储层约束补齐（PostgreSQL 成果仓储切片）
├─ 0009_audit_logs.sql         不可变业务审计表（PostgreSQL 审计仓储切片 · 存储层仅追加）
├─ 0010_notifications.sql      站内通知表（PostgreSQL 通知仓储切片 · 归属隔离 + read 状态机）
├─ 0011_research_groups.sql    科研小组表（PostgreSQL 小组仓储切片）
├─ 0012_user_compliance.sql    本人合规状态聚合读模型（PostgreSQL 合规格切片）
├─ 0013_export_jobs.sql        导出请求事实表（PostgreSQL 导出仓储切片 · 状态读 / 创建 / 完成）
├─ 0014_ai_match_records_guards.sql  ai_match_records 存储层守卫补齐（存储 ID 域 + 结果行形状）
├─ 0015_export_jobs_expiry.sql 导出请求事实表补服务端有效期列（导出下载切片 · 过期拒绝）
└─ 0016_export_jobs_revocation.sql 导出请求事实表补服务端撤销列（导出本人撤销切片 · 取回交付能力）
```

`0002`–`0005` 是第一个真实业务持久化切片（本人统计聚合读）所需的四张来源表：每张表都带
`user_id`（前导列）索引，服务「按主体计数」与「按主体列表按创建顺序分页」两条取数路径。
它们只把**适配器契约已经蕴含**的规则下沉到存储层（枚举闭集、长度上界），不建外键
（`users` / `research_groups` 尚未有迁移），也不建尚未在应用中处理冲突的额外唯一约束。

`0006` 建会话表（会话票据的不可逆 sha256 摘要即主键），`0007` 建学生画像表（`user_id` 既是
归属也是主键，一人一行）。两者都服务于「开发/测试无数据库走内存基线、配置了 `DATABASE_URL`
则换绑 PostgreSQL 实现」的分流：PostgreSQL 实现只在配置了数据库时被装配，且如实声明
`productionReady = false`，因此生产环境在补齐验证证据前会被启动期依赖就绪门禁拒绝。

`0008` 是**约束补齐**（不建表）：成果表已在 `0004` 建好，本切片的自服务读写路径需要在存储层
补上「标题非空且不超长」与「归属不得为空 UUID」两条 CHECK。口径仍是「只把 adapter 契约已经
蕴含的规则下沉」，不引入应用层语义（内容安全、时间格式）与后续切片的对象（审核留痕、
`deleted_at`、`users` 外键），也不新增索引（`0004` 的 `(user_id, created_at, id)` 已覆盖
本人列表与本人统计两条取数路径）。

`0009` 建**不可变业务审计表**：列清单与 `audit.postgres-repository.ts` 的
`POSTGRES_AUDIT_COLUMNS` 一一对应（11 列），并额外用**触发器**把「只追加」变成数据库自身的
不变量 —— 业务侧改写 / 删除（含整表截断）在存储层被拒绝（`audit_logs_reject_mutation`），
因此「审计不可删除」不再只依赖 adapter 缺方法。表里刻意**不**建高敏内容与快照列
（`payload` / `before` / `after` / `reason`）、请求与网络元数据（明文 IP / 请求头 / 路径 / URL）
以及链式完整性字段：它们属于后续切片，adapter 的列清单里也没有它们，建了只会得到没有写入方的空列。

`0010` 建**站内通知表**：列清单与 `notifications.postgres-repository.ts` 的
`POSTGRES_NOTIFICATION_COLUMNS` 一一对应（9 列），并按 adapter 契约蕴含的规则补上 CHECK
（类型 / 状态闭集、标题与正文长度上界、存储 ID 域，以及「`read` 必带 `read_at`、`unread` 不得
携带」这条跨字段不变式 —— 它正是 `markNotificationRead` 状态机在存储层的镜像，因此
「已读时间不被重复请求改写」不只依赖 service 的幂等分支）。取数索引
`(user_id, created_at, id)` 覆盖本人列表的「过滤 + 全序排序」。刻意**不**建订阅消息外发列
（收件标识 / 模板 / 重试次数）与跳转 / 附件 / 软删除 / 幂等键列：它们属于后续切片，adapter 的列
清单里也没有它们（内部列已单独登记为「不进 SELECT / RETURNING」）。

`0013` 建**导出请求事实表** `export_jobs`：列清单与 `exports.postgres-repository.ts` 的
`POSTGRES_EXPORT_COLUMNS` 一一对应（8 列），并按 adapter 契约蕴含的规则补上 CHECK
（资源 / 状态闭集、字段数组非空、存储 ID 域，以及「产物短引用**当且仅当**结论为 `completed`
时存在」这条跨字段不变式 —— 它正是状态机与读取契约在存储层的镜像）。取数索引
`(requester_id, created_at, id)` 覆盖 adapter 的 `ORDER BY created_at ASC, id ASC` 与归属谓词。
表里刻意**不**建产物位置与文件体（文件名 / 路径 / 下载地址 / 签名地址 / 存储 key / 对象 key /
文件体 / 摘要）、内部资源内容与筛选条件、原始错误文本，以及下载簿记（下载时间 / 软删除时间 /
幂等键）：原始 PII、文件路径、对象存储凭据与下载签名**都不得落库**，本表只保存受控状态与服务端
生成的短引用，因此这些列既不在迁移里，也不在 adapter 的列清单里（adapter 的
`POSTGRES_EXPORT_INTERNAL_COLUMNS` 把它们登记为「不进 SELECT / RETURNING」）。

`0015` 给 `export_jobs` **补出服务端有效期列** `expires_at timestamptz`（可空、无 DEFAULT）与
「有效期必须在创建时间之后」的 CHECK `export_jobs_expires_at_after_created_at`。
`0013` 已应用且校验和钉住、不可改写，因此加列只能走新迁移；`expires_at` 也由此从
「没有写入方的簿记列」变成 adapter 列清单里的真实列（第 9 列，下载边界读取它做过期判定），
但仍然**不进入公开视图**，所以同时被登记进 `POSTGRES_EXPORT_VIEW_EXCLUDED_COLUMNS`。
可空是**语义**而不是遗漏：`NULL` = 「这条记录没有服务端写入的有效期」，下载边界按 fail-closed
拒绝（与「不存在 / 跨主体 / 未完成 / 产物缺失」同一出口），绝不解释为「永不过期」；
不加 DEFAULT 同样是有意的 —— 有效期只能由服务端时钟写入，存储层不得自行发明一个到期时刻。
回滚方式登记在迁移头部：`ALTER TABLE export_jobs DROP COLUMN IF EXISTS expires_at`
（只回滚本迁移新增的列与约束，不动 `0013` 建出的表、其它列与既有数据）。

`0016` 给 `export_jobs` **补出服务端撤销列** `revoked_at timestamptz`（可空、无 DEFAULT）与两条
CHECK：`export_jobs_revoked_at_matches_status`（`revoked_at IS NULL OR status IN ('pending',
'completed')` —— 即 `failed` 结论不可撤销）与 `export_jobs_revoked_at_after_created_at`
（撤销时刻不得早于创建时刻，NULL 放行）。`0013` / `0015` 都已应用且校验和钉住、不可改写，
因此加列只能走新迁移；`revoked_at` 也由此成为 adapter 列清单里的真实列（第 10 列，下载失效判定与
列表的 `revoked` 呈现都读它），但仍然**不进入公开视图**（撤销时刻不外发），所以同时被登记进
`POSTGRES_EXPORT_VIEW_EXCLUDED_COLUMNS` 与 `POSTGRES_EXPORT_PII_COLUMNS`。

**撤销与状态机正交**：它不是第四个 `status` 取值，因此 `0013` 已建出的状态闭集 CHECK
（`export_jobs_status_check`）与「产物短引用当且仅当 `completed` 时存在」的跨字段 CHECK
（`export_jobs_artifact_matches_status`）在 `0016` 里**逐字不变** —— 撤销不删除记录、
不清理产物（清理属异步后续切片），也不改写既有结论终态。可空是**语义**而不是遗漏：
`NULL` = 「这条记录没有被撤销」；不加 DEFAULT 同样是有意的 —— 撤销时刻只能由服务端时钟写入。
「已过期不可撤销」刻意**不**写成 CHECK：过期是相对当前时刻的性质，CHECK 必须对同一行永远成立，
该规则留在 service 的撤销边界（与下载边界共用同一个过期判定）。
回滚方式登记在迁移头部：`ALTER TABLE export_jobs DROP COLUMN IF EXISTS revoked_at`
（只回滚本迁移新增的列与两个 CHECK，不动 `0013` / `0015` 建出的表、其它列与既有数据）。

## 命名与顺序

- 文件名格式：`NNNN_snake_case.sql`，4 位序号 + 下划线 + 小写字母数字下划线。
- 序号唯一且严格递增；`scripts/db-migrations-lint.mjs` 会在 CI 与本地校验。
- 一份迁移只做一件事：建表、加索引、加约束或数据回填，避免「大爆炸迁移」。
- 每份迁移必须自带**独立成行的** `BEGIN;` / `COMMIT;`：执行入口会摘掉这两行，改用执行器的
  事务把「迁移语句 + 记账写入」放在同一个事务里（失败即整体回滚，不留半成品 schema 与记账行）。

## 每个文件必须包含的头部注释

```sql
-- migration: 0002_create_users
-- description: 创建 users 表
-- reversible: 是/否（否必须说明原因与恢复方式）
-- owner: 阶段或负责人
```

## 编写规则

1. 迁移一旦合并即**不可修改**；修正必须新增迁移。
2. 建表语句使用 `IF NOT EXISTS`，便于在预发布环境重复执行与演练。
3. 主键 UUID；时间统一 `timestamptz`；业务表包含 `created_at` / `updated_at`，适用时 `deleted_at`。
4. 高敏感字段（学号、联系方式、微信标识）应用层加密；需要按值查询时另存不可逆 hash，禁止明文索引。
5. 审计类表只允许追加：不提供业务侧 `UPDATE` / `DELETE`。
6. 破坏性变更（删列、改类型、加非空约束）必须分两步：先兼容写入，再清理，并在迁移头部说明回滚方式。
7. 数据迁移（存量导入）走 staging 校验 + 事务写入，保留对账结果与失败记录（计划表 P8 §6）。
8. **危险非事务 DDL 一律禁止**（`CREATE INDEX CONCURRENTLY` / `VACUUM` / `CLUSTER` /
   `ALTER SYSTEM` / `ALTER TYPE ... ADD VALUE` …）：部署守卫会直接拒绝，且不执行任何 SQL。
9. **草案永不部署**：`db/schema-drafts/*.draft.sql` 必须经选型评审后按本规范重写，不能改后缀直发。

## 本地执行

前置：本地开发库（仓库根 `docker-compose.yml`）或任何测试库；`DATABASE_URL` 必须指向**非生产**库。

```bash
cp .env.docker.example .env.docker                                  # 只有占位符，先改口令
docker compose --env-file .env.docker up -d postgres                # WSL2 + Docker，默认端口 55432
pnpm db:migrate:status               # 只读：列出已应用 / 待执行版本（不写库）
pnpm db:migrate                      # 应用待执行迁移（先过部署守卫）
pnpm db:migrate -- --dry-run         # 只判定不执行
```

执行入口的退出码：`0` 成功 / `1` 守卫拒绝或执行失败（**没有**任何 SQL 被提交）/ `2` 前置未满足
（未配置 `DATABASE_URL`、环境名非法）。静态校验仍可单独运行：

```bash
pnpm verify:migrations
```

`DATABASE_URL` 配置见仓库根目录 `.env.example`。本地开发使用 WSL + Docker 或本机 PostgreSQL 均可，
但必须在执行迁移前确认目标库不是生产库。

## 与执行器的关系

迁移就绪证据（代码侧可用版本 vs 数据库侧已应用版本）是生产执行器 attest 的一部分：
`pnpm db:migrate:status` 的输出是填写 `DATABASE_MIGRATION_AVAILABLE_VERSIONS` /
`DATABASE_MIGRATION_APPLIED_VERSIONS` 的**唯一依据**（见仓库根 README 与 `.env.example`）。

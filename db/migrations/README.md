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
└─ 0008_achievements_constraints.sql  成果表存储层约束补齐（PostgreSQL 成果仓储切片）
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

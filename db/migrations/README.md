# 数据库迁移

> 阶段：P3 基础工程。ORM / 迁移工具选型（Prisma 与 TypeORM 比较）**尚未完成**，
> 见 `docs/P2-开源复用评估.md` §1；因此本目录当前只包含迁移规范与一份不建业务表的占位迁移。

## 目录约定

```text
db/migrations/
├─ 0001_bootstrap.sql      初始化 schema_migrations（元数据表，可回滚）
└─ 0002_xxx.sql            后续按主题拆分（见下）
```

## 命名与顺序

- 文件名格式：`NNNN_snake_case.sql`，4 位序号 + 下划线 + 小写字母数字下划线。
- 序号唯一且严格递增；`scripts/db-migrations-lint.mjs` 会在 CI 与本地校验。
- 一份迁移只做一件事：建表、加索引、加约束或数据回填，避免「大爆炸迁移」。

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

## 本地执行（待选型完成后启用）

```bash
# 选型完成后，迁移执行由 workspace 脚本统一封装，例如：
#   pnpm db:migrate        # 应用未执行迁移
#   pnpm db:migrate:status # 查看已执行/待执行
# 当前仅提供静态校验：
pnpm verify:migrations
```

`DATABASE_URL` 配置见仓库根目录 `.env.example`。本地开发使用 WSL + Docker 或本机 PostgreSQL 均可，
但必须在执行迁移前确认目标库不是生产库。

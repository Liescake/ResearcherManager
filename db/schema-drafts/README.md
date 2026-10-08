# schema 草案（未应用）

本目录存放**尚未转成迁移**的业务表 DDL 草案。

## 为什么单独一层

`db/migrations/` 的迁移一旦合并即不可修改（见 `db/migrations/README.md`），而 ORM / 迁移工具
选型（Prisma 与 TypeORM 比较，见 `docs/P2-开源复用评估.md` §1）尚未完成。因此业务表 DDL 先以
草案形式放在这里：

- 草案**不是迁移**：任何 runner 都不得执行它，`pnpm verify:migrations` 也不扫描本目录；
- 草案由 `@rm/db` 的 `describeSchemaDraftFile` / `readSchemaDraftDirectory` 做静态校验
  （命名 `NNNN_snake_case.draft.sql`、头部字段、事务边界、`IF NOT EXISTS`、
  UUID 主键、`timestamptz`、`created_at`/`updated_at`、高敏感字段禁止明文索引）；
- 选型完成并通过评审后，草案按 `db/migrations/README.md` 的规范转成 `NNNN_*.sql` 迁移，
  届时删除对应草案文件，避免同一张表出现两份真相。

## 必须包含的头部注释

```sql
-- draft: 0001_research_groups
-- description: 一句话说明本草案覆盖的切片
-- target-table: research_groups
-- status: 未应用（草案；选型与评审完成前不得转为迁移、不得执行）
-- owner: 阶段或负责人
```

## 校验方式

```bash
pnpm --filter @rm/db test
```

测试会读取本目录并逐份校验草案规则（同时校验 `db/migrations/` 的命名、头部与顺序）。

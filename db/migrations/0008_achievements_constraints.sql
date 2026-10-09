-- migration: 0008_achievements_constraints
-- description: 补齐成果表在自服务读写路径上的存储层约束（标题非空且不超长、归属不得为空 UUID）
-- reversible: 是（ALTER TABLE achievements DROP CONSTRAINT IF EXISTS achievements_title_length / achievements_owner_not_nil）
-- owner: P5 成果切片持久化（PostgreSQL 成果仓储切片 · 存储层约束补齐）

BEGIN;

-- 口径与 `0004_achievements.sql` / `0007_student_profiles.sql` 一致：**只把「adapter 契约已经
-- 蕴含」的规则下沉到存储层**，用于拦住绕过应用层的写入；应用层写入前已按同一组规则校验，
-- 因此这些 CHECK 不会拒绝任何合法写入。刻意不重复实现应用层语义（内容安全、时间格式、
-- 审核留痕、软删除），也不建外键（`users` 尚无迁移）。
--
-- 本切片（成果学生自服务：创建本人成果 / 本人成果列表）需要的两条约束：
--   1. `title`：读取契约与共享 `achievementInputSchema` 都要求 1–300 字符
--      （`trimmedText(1, 300)`）。0004 的 `varchar(300) NOT NULL` 只挡住了上界与 NULL，
--      **空串仍可落库** —— 这里补上下界，让「空标题成果」在存储层就写不进去。
--   2. `user_id`：adapter 的存储 ID 域约束要求归属是「合法且非空的规范小写 UUID」，
--      nil UUID 属服务端缺陷（`INVALID_SUBJECT` / `INVALID_RECORD`）。0004 只声明了 `uuid`
--      类型 —— 这里把「非空」这一条下沉到存储层。
--
-- ## 为什么用 `DO` 块先查目录再加约束
-- PostgreSQL 没有 `ADD CONSTRAINT IF NOT EXISTS`。迁移必须**可重复执行**：集成测试里的
-- 「全新数据库 bootstrap」用例会清空记账表后按守卫顺序重放全部迁移（0004 已经建好表），
-- 直接 `ALTER TABLE ... ADD CONSTRAINT` 会在重放时因「约束已存在」失败。这里先查
-- `pg_constraint`，只在缺失时新增，因此重放是幂等的，且**不使用任何 DROP**（不删既有对象）。

DO $achievements_constraints$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conrelid = 'achievements'::regclass
       AND conname = 'achievements_title_length'
  ) THEN
    ALTER TABLE achievements
      ADD CONSTRAINT achievements_title_length
        CHECK (char_length(title) BETWEEN 1 AND 300);
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conrelid = 'achievements'::regclass
       AND conname = 'achievements_owner_not_nil'
  ) THEN
    ALTER TABLE achievements
      ADD CONSTRAINT achievements_owner_not_nil
        CHECK (user_id <> '00000000-0000-0000-0000-000000000000'::uuid);
  END IF;
END
$achievements_constraints$;

-- 注释是幂等的（重复执行只是覆盖同一段文本）
COMMENT ON CONSTRAINT achievements_title_length ON achievements IS
  '标题长度：与共享 achievementInputSchema 的 trimmedText(1, 300) 一致；空串与超长都在存储层被拒绝。';
COMMENT ON CONSTRAINT achievements_owner_not_nil ON achievements IS
  '归属不得为空 UUID：与 adapter 的存储 ID 域约束（合法且非空的规范小写 UUID）一致。';

-- 索引无需新增：0004 的 `idx_achievements_user_created_at (user_id, created_at, id)` 已经同时服务
-- 「按主体取数（本人列表）」与「按主体计数（本人统计）」两条路径，本切片的列表排序
-- （`ORDER BY created_at ASC, id ASC`）与过滤（`WHERE user_id = $1`）都落在该索引上。

COMMIT;

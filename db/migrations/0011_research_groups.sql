-- migration: 0011_research_groups
-- description: 建立科研小组表 research_groups（分页浏览可见的开放小组 + 创建小组：软删除过滤 + 可见性过滤 + 分页窗口）
-- reversible: 是（DROP TABLE IF EXISTS research_groups：表为小组主数据，回滚即整表丢弃）
-- owner: 小组切片持久化（PostgreSQL 小组仓储切片 · 最小表）

BEGIN;

-- 字段清单与 services/api/src/modules/groups/groups.postgres-repository.ts 的
-- POSTGRES_GROUP_COLUMNS（9 个输出列）+ POSTGRES_GROUP_INTERNAL_COLUMNS（1 个内部列
-- deleted_at）双向一致：不多列、也不许少列。刻意不预判后续切片：
--   * 成员关系 / 成员数（group_memberships）属于「成员管理」切片，本表不建 ——
--     它的写入路径与授权口径都还没定义，建了只会得到一张永远没有写入方的表；
--   * 招募要求的独立列（skills / grades / min_weekly_hours / headcount 分别建列）属于
--     检索与筛选切片：本切片只做创建与浏览，形状由 packages/shared 的
--     recruitmentRequirementsSchema 校验后整体落 jsonb；
--   * 负责人邮箱 / 联系方式等 PII 列不建：它们既不在读取视图白名单里，也不在本切片的职责内；
--   * users 表尚未有迁移，故 leader_user_id 暂不建外键（与 0002–0010 的既有约定一致）。
CREATE TABLE IF NOT EXISTS research_groups (
  id                       uuid PRIMARY KEY,
  name                     varchar(100) NOT NULL,
  description              text,
  research_directions      text[] NOT NULL DEFAULT '{}',
  recruitment_requirements jsonb NOT NULL,
  leader_user_id           uuid NOT NULL,
  status                   varchar(16) NOT NULL,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),
  -- 内部列：只被可见性谓词使用（deleted_at IS NULL），既不进 SELECT / RETURNING，
  -- 也不进领域对象（见 adapter 的 POSTGRES_GROUP_INTERNAL_COLUMNS）
  deleted_at               timestamptz,
  -- 状态闭集（与 packages/shared 的 GROUP_STATUS_VALUES 逐值一致）
  CONSTRAINT research_groups_status_check
    CHECK (status IN ('open', 'paused', 'closed')),
  -- 名称非空且长度与读取契约一致（name: 1–100 字符）
  CONSTRAINT research_groups_name_not_blank
    CHECK (char_length(btrim(name)) BETWEEN 1 AND 100),
  -- 描述长度上界与读取契约一致（description: 0–5000 字符）
  CONSTRAINT research_groups_description_length
    CHECK (description IS NULL OR char_length(description) <= 5000),
  -- 研究方向至少一项（读取契约要求 min(1)）
  CONSTRAINT research_groups_directions_not_empty
    CHECK (cardinality(research_directions) >= 1),
  -- 存储 ID 域：主键与负责人都必须是合法且**非空**的 UUID
  -- （空 UUID 不是可用负责人，adapter 在进 SQL 之前就会拒绝，这里把同一条规则下沉到存储层）
  CONSTRAINT research_groups_id_not_nil
    CHECK (id <> '00000000-0000-0000-0000-000000000000'::uuid),
  CONSTRAINT research_groups_leader_user_id_not_nil
    CHECK (leader_user_id <> '00000000-0000-0000-0000-000000000000'::uuid)
);

COMMENT ON TABLE research_groups IS
  '科研小组（分页浏览可见的开放小组 + 创建小组）：归属 leader_user_id 由服务端会话主体写入；字段与敏感级别以 docs/P1-字段级数据字典.md 与 docs/P2-架构与数据设计.md §2 为准。';
COMMENT ON COLUMN research_groups.leader_user_id IS
  '负责人：由服务端会话主体写入，永不来自请求体；该字段为内部字段，不进入对外视图。外键在 users 表建立后补。';
COMMENT ON COLUMN research_groups.recruitment_requirements IS
  '招募要求 JSON：形状由 packages/shared 的 recruitmentRequirementsSchema 约束，服务端写入前必须已校验；adapter 读出时按严格版本复核（出现未登记键即 fail-closed）。';
COMMENT ON COLUMN research_groups.status IS
  '小组状态（闭集 open / paused / closed）：本端点只输出 open（与共享 isGroupApplicable 一致）；状态机属于后续切片的 PATCH。';
COMMENT ON COLUMN research_groups.deleted_at IS
  '软删除标记（内部列）：只被可见性谓词使用（deleted_at IS NULL），不进入 SELECT 列表、RETURNING 与领域对象。';

-- 约束口径：只把「适配器契约已经蕴含」的规则下沉到存储层（枚举闭集、长度上界、数组非空、
-- 存储 ID 域）。适配器写入前已按同一组规则校验，因此这些 CHECK 不会拒绝任何合法写入，
-- 只用于拦住绕过应用层的写坏数据。刻意**不**在 SQL 里重复实现应用层语义：
-- 招募要求的逐字段形状（skills / grades / minWeeklyHours / headcount 的枚举与范围）、
-- 时间戳格式、以及「小组名在有效期内唯一」的冲突语义由 adapter 与读取契约判定。

-- 同一有效期内（未软删除）小组名唯一：软删除行不参与唯一性，因此用部分唯一索引而不是列约束。
-- adapter 侧对应 ON CONFLICT (id) DO NOTHING 只处理主键冲突；重名会由本索引以 23505 拒绝。
CREATE UNIQUE INDEX IF NOT EXISTS uq_research_groups_name_active
  ON research_groups (name)
  WHERE deleted_at IS NULL;

-- 列表端点的取数路径是
--   WHERE deleted_at IS NULL AND status = 'open' AND ($1 OR id = ANY($2)) ORDER BY created_at ASC, id ASC LIMIT/OFFSET
-- 因此用「过滤列 + 排序键」的部分索引覆盖「过滤 + 排序 + 窗口」而不需要额外排序步骤。
CREATE INDEX IF NOT EXISTS idx_research_groups_open_created_at
  ON research_groups (created_at, id)
  WHERE status = 'open' AND deleted_at IS NULL;

-- 负责人维度的取数（后续切片的「我负责的小组」）先建普通索引，避免那时再改表
CREATE INDEX IF NOT EXISTS idx_research_groups_leader_user_id
  ON research_groups (leader_user_id);

COMMIT;

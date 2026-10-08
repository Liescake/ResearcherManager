-- draft: 0001_research_groups
-- description: research_groups 表草案（小组持久化最小切片：创建小组 / 浏览可见的开放小组）
-- target-table: research_groups
-- status: 未应用（草案；ORM 与迁移工具选型及评审完成前不得转为 db/migrations 迁移，也不得执行）
-- owner: P4 持久化基础（@rm/db）

BEGIN;

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
  deleted_at               timestamptz,
  CONSTRAINT research_groups_name_not_blank CHECK (btrim(name) <> ''),
  CONSTRAINT research_groups_description_length CHECK (
    description IS NULL OR char_length(description) <= 5000
  ),
  CONSTRAINT research_groups_directions_not_empty CHECK (cardinality(research_directions) >= 1),
  CONSTRAINT research_groups_status_check CHECK (status IN ('open', 'paused', 'closed'))
);

COMMENT ON TABLE research_groups IS
  '科研小组：字段与敏感级别以 docs/P1-字段级数据字典.md 为准；leader_user_id 为内部字段，不进入对外视图。';
COMMENT ON COLUMN research_groups.leader_user_id IS
  '负责人：由服务端会话主体写入，永不来自请求体；外键在 users 表建立后补（见下方说明）。';
COMMENT ON COLUMN research_groups.recruitment_requirements IS
  '招募要求 JSON：形状由 packages/shared 的 recruitmentRequirementsSchema 约束，服务端写入前必须已校验。';

-- 外键延后：users 表尚未建立（docs/P1-字段级数据字典.md / docs/P2-数据约束与迁移设计.md）。
-- 建立 users 的迁移落地后，用新的迁移补：
--   ALTER TABLE research_groups
--     ADD CONSTRAINT fk_research_groups_leader_user
--     FOREIGN KEY (leader_user_id) REFERENCES users (id) ON DELETE RESTRICT;

-- 同一有效期内小组名唯一（软删除行不参与唯一性）
CREATE UNIQUE INDEX IF NOT EXISTS uq_research_groups_name_active
  ON research_groups (name)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_research_groups_leader_user_id
  ON research_groups (leader_user_id);

-- 列表端点的取数路径：只查开放且未删除的小组，按创建顺序分页（对应仓储的 LIMIT/OFFSET 下推）
CREATE INDEX IF NOT EXISTS idx_research_groups_open_created_at
  ON research_groups (created_at, id)
  WHERE status = 'open' AND deleted_at IS NULL;

-- 说明（不在本草案内实现，转迁移时按需补充）：
--   * status 用 CHECK 约束而不是 PG enum 类型，避免枚举值变更时的类型迁移成本；
--   * updated_at 由应用层在写入时维护（不使用触发器，保持写入路径显式可审计）；
--   * 审计类表只允许追加（不提供业务侧 UPDATE/DELETE），不在本草案范围内。

COMMIT;

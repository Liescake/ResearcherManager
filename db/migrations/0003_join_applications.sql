-- migration: 0003_join_applications
-- description: 建立入组/退组申请表 join_applications（本人统计切片的来源表之一）
-- reversible: 是（DROP TABLE IF EXISTS join_applications）
-- owner: P4 持久化基础（本人统计切片 · 四张来源表）

BEGIN;

CREATE TABLE IF NOT EXISTS join_applications (
  id                  uuid         PRIMARY KEY,
  user_id             uuid         NOT NULL,
  group_id            uuid         NOT NULL,
  kind                varchar(8)   NOT NULL,
  note                varchar(1000),
  status              varchar(16)  NOT NULL,
  reviewed_by_user_id uuid,
  review_comment      varchar(500),
  reviewed_at         timestamptz,
  created_at          timestamptz  NOT NULL DEFAULT now(),
  updated_at          timestamptz  NOT NULL DEFAULT now(),
  CONSTRAINT join_applications_kind_check
    CHECK (kind IN ('join', 'leave')),
  CONSTRAINT join_applications_status_check
    CHECK (status IN ('pending', 'approved', 'rejected', 'withdrawn', 'completed')),
  CONSTRAINT join_applications_note_length
    CHECK (note IS NULL OR char_length(note) <= 1000),
  CONSTRAINT join_applications_review_comment_length
    CHECK (review_comment IS NULL OR char_length(review_comment) <= 500)
);

COMMENT ON TABLE join_applications IS
  '入组/退组申请：字段与敏感级别以 docs/P1-字段级数据字典.md 为准；reviewed_by_user_id / review_comment 为内部审核留痕，不进入对外视图。';
COMMENT ON COLUMN join_applications.user_id IS
  '申请主体：由服务端会话主体写入，永不来自请求体；外键在 users 表建立后补（见下方延后说明）。';
COMMENT ON COLUMN join_applications.group_id IS
  '目标小组：外键在 research_groups 表建立后补（当前只有 db/schema-drafts/0001_research_groups.draft.sql 草案）。';
COMMENT ON COLUMN join_applications.kind IS
  '申请类型：与 packages/shared 的 APPLICATION_KIND_VALUES 一致（join/leave）。';
COMMENT ON COLUMN join_applications.status IS
  '申请状态：与 packages/shared 的 APPLICATION_STATUS_VALUES 一致（pending/approved/rejected/withdrawn/completed）。';

-- 约束口径：只把「适配器契约已经蕴含」的规则下沉到存储层（枚举闭集、长度上界）。
--
-- 刻意**不**在本迁移建立以下两类约束（属于后续切片，需与适配器的冲突映射一起落地）：
--   1. ER 图的「同用户同小组未终态唯一」部分唯一索引 —— 适配器当前没有唯一冲突
--      （SQLSTATE 23505）到业务错误码的映射，先建约束会把并发重复提交变成未处理的服务端错误；
--   2. 「审核状态与审核人/时间成对出现」的 CHECK —— 适配器的行契约允许这三个列独立为空，
--      先建约束会拒绝当前契约允许的写入形状。
-- 两项都由后续迁移补，并在适配器补齐冲突映射后一起纳入集成验证。

-- 外键延后：users / research_groups 尚未建立。
--   ALTER TABLE join_applications
--     ADD CONSTRAINT fk_join_applications_user
--     FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE RESTRICT;
--   ALTER TABLE join_applications
--     ADD CONSTRAINT fk_join_applications_group
--     FOREIGN KEY (group_id) REFERENCES research_groups (id) ON DELETE RESTRICT;

-- 索引：user_id 为前导列，同时服务按主体计数、按主体列表与「同主体同小组」取数。
CREATE INDEX IF NOT EXISTS idx_join_applications_user_created_at
  ON join_applications (user_id, created_at, id);
CREATE INDEX IF NOT EXISTS idx_join_applications_user_group
  ON join_applications (user_id, group_id);

COMMIT;

-- migration: 0004_achievements
-- description: 建立成果表 achievements（本人统计切片的来源表之一）
-- reversible: 是（DROP TABLE IF EXISTS achievements）
-- owner: P4 持久化基础（本人统计切片 · 四张来源表）

BEGIN;

CREATE TABLE IF NOT EXISTS achievements (
  id               uuid         PRIMARY KEY,
  user_id          uuid         NOT NULL,
  type             varchar(32)  NOT NULL,
  title            varchar(300) NOT NULL,
  award_level      varchar(100),
  description      varchar(2000),
  achieved_at      timestamptz,
  evidence_file_id uuid,
  review_status    varchar(16)  NOT NULL,
  created_at       timestamptz  NOT NULL DEFAULT now(),
  updated_at       timestamptz  NOT NULL DEFAULT now(),
  CONSTRAINT achievements_type_check
    CHECK (type IN ('paper', 'patent', 'software', 'competition', 'project', 'experience')),
  CONSTRAINT achievements_review_status_check
    CHECK (review_status IN ('pending', 'approved', 'rejected')),
  CONSTRAINT achievements_award_level_length
    CHECK (award_level IS NULL OR char_length(award_level) <= 100),
  CONSTRAINT achievements_description_length
    CHECK (description IS NULL OR char_length(description) <= 2000)
);

COMMENT ON TABLE achievements IS
  '成果：字段与敏感级别以 docs/P1-字段级数据字典.md 为准；evidence_file_id 为高敏感附件标识，不进日志与错误信息。';
COMMENT ON COLUMN achievements.user_id IS
  '归属：由服务端会话主体写入，永不来自请求体；外键在 users 表建立后补（见下方延后说明）。';
COMMENT ON COLUMN achievements.type IS
  '成果类型：与 packages/shared 的 ACHIEVEMENT_TYPE_VALUES 一致。';
COMMENT ON COLUMN achievements.evidence_file_id IS
  '佐证附件标识：高敏感，只存受控文件服务的标识，不存文件内容；外键在文件表建立后补。';
COMMENT ON COLUMN achievements.review_status IS
  '审核状态：与 packages/shared 的 REVIEW_STATUS_VALUES 一致（pending/approved/rejected）。';

-- 约束口径：只把「适配器契约已经蕴含」的规则下沉到存储层（枚举闭集、长度上界）。
-- 审核留痕（审核人、审核意见、审核时间、审计事件 ID）与 deleted_at 属后续切片，
-- 本迁移不建列，也不建对应的成对约束。

-- 外键延后：users 表尚未建立。
--   ALTER TABLE achievements
--     ADD CONSTRAINT fk_achievements_user
--     FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE RESTRICT;

-- 索引：user_id 为前导列，同时服务按主体计数与本人列表按创建顺序分页。
CREATE INDEX IF NOT EXISTS idx_achievements_user_created_at
  ON achievements (user_id, created_at, id);

COMMIT;

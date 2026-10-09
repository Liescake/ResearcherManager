-- migration: 0002_education_records
-- description: 建立升学记录表 education_records（本人统计切片的第一张来源表）
-- reversible: 是（DROP TABLE IF EXISTS education_records）
-- owner: P4 持久化基础（本人统计切片 · 四张来源表）

BEGIN;

CREATE TABLE IF NOT EXISTS education_records (
  id                         uuid        PRIMARY KEY,
  user_id                    uuid        NOT NULL,
  year                       smallint    NOT NULL,
  type                       varchar(32) NOT NULL,
  status                     varchar(16) NOT NULL,
  institution_or_destination varchar(200),
  review_status              varchar(16) NOT NULL,
  created_at                 timestamptz NOT NULL DEFAULT now(),
  updated_at                 timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT education_records_year_range
    CHECK (year BETWEEN 2000 AND 2100),
  CONSTRAINT education_records_type_check
    CHECK (type IN ('recommendation', 'postgraduate', 'doctoral', 'direct_doctorate')),
  CONSTRAINT education_records_status_check
    CHECK (status IN ('preparing', 'admitted', 'not_admitted')),
  CONSTRAINT education_records_review_status_check
    CHECK (review_status IN ('pending', 'approved', 'rejected')),
  CONSTRAINT education_records_institution_length
    CHECK (institution_or_destination IS NULL OR char_length(institution_or_destination) <= 200)
);

COMMENT ON TABLE education_records IS
  '升学记录：字段与敏感级别以 docs/P1-字段级数据字典.md 为准；user_id 为内部归属列，不进入对外视图。';
COMMENT ON COLUMN education_records.user_id IS
  '归属：由服务端会话主体写入，永不来自请求体；外键在 users 表建立后补（见下方延后说明）。';
COMMENT ON COLUMN education_records.year IS
  '升学年份：与 packages/shared 的 yearSchema 一致（2000–2100）。';
COMMENT ON COLUMN education_records.type IS
  '升学类型：与 packages/shared 的 EDUCATION_TYPE_VALUES 一致。';
COMMENT ON COLUMN education_records.status IS
  '升学状态：与 packages/shared 的 EDUCATION_STATUS_VALUES 一致（备考中/已录取/未上岸）。';
COMMENT ON COLUMN education_records.review_status IS
  '审核状态：与 packages/shared 的 REVIEW_STATUS_VALUES 一致（pending/approved/rejected）。';

-- 约束口径：只把「适配器契约已经蕴含」的规则下沉到存储层（枚举闭集、长度上界）。
-- 适配器写入前已按同一组 zod 规则校验，因此这些 CHECK 不会拒绝任何合法写入，
-- 只用于拦住绕过应用层的写坏数据。

-- 外键延后：users 表尚未建立（docs/P1-字段级数据字典.md / docs/P2-数据约束与迁移设计.md）。
-- 建立 users 的迁移落地后，用新的迁移补：
--   ALTER TABLE education_records
--     ADD CONSTRAINT fk_education_records_user
--     FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE RESTRICT;

-- 索引：user_id 为前导列，同时服务
--   * 本人统计的按主体计数（WHERE user_id = $1::uuid）；
--   * 本人列表按创建顺序分页（ORDER BY created_at ASC, id ASC）。
CREATE INDEX IF NOT EXISTS idx_education_records_user_created_at
  ON education_records (user_id, created_at, id);

COMMIT;

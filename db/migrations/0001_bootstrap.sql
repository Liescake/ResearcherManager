-- migration: 0001_bootstrap
-- description: 建立迁移记录表 schema_migrations（不创建任何业务表）
-- reversible: 是（DROP TABLE schema_migrations）
-- owner: P3 基础工程

BEGIN;

CREATE TABLE IF NOT EXISTS schema_migrations (
  version      text PRIMARY KEY,
  name         text NOT NULL,
  checksum     text NOT NULL,
  applied_at   timestamptz NOT NULL DEFAULT now(),
  applied_by   text NOT NULL DEFAULT current_user,
  execution_ms integer
);

COMMENT ON TABLE schema_migrations IS
  '迁移执行记录：只追加；已应用版本的校验和不一致时必须人工处理，不得静默重写。';

CREATE INDEX IF NOT EXISTS idx_schema_migrations_applied_at
  ON schema_migrations (applied_at DESC);

-- ---------------------------------------------------------------------------
-- 占位说明：以下业务表将在 P4 起按主题拆分迁移创建，字段以 docs/P1-字段级数据字典.md 为准
--   users, student_profiles, research_groups, group_memberships,
--   join_applications, leave_applications, achievements, education_records,
--   ai_match_records, audit_logs, privacy_consents, export_jobs,
--   system_configs, announcements
-- 设计约束（docs/P2-架构与数据设计.md §4）：
--   * 主键 UUID；时间使用 timestamptz；业务表包含 created_at / updated_at，适用时 deleted_at
--   * 高敏感字段应用层加密，需要不可逆查询时另存 hash，不用明文索引
--   * 审计表只允许追加，不提供业务侧 UPDATE / DELETE
-- ---------------------------------------------------------------------------

COMMIT;

-- migration: 0005_ai_match_records
-- description: 建立 AI 匹配记录表 ai_match_records（本人统计切片的来源表之一）
-- reversible: 是（DROP TABLE IF EXISTS ai_match_records）
-- owner: P4 持久化基础（本人统计切片 · 四张来源表）

BEGIN;

CREATE TABLE IF NOT EXISTS ai_match_records (
  id                  uuid         PRIMARY KEY,
  user_id             uuid         NOT NULL,
  status              varchar(16)  NOT NULL,
  profile_version     integer,
  input_snapshot_hash varchar(64)  NOT NULL,
  recommendations     jsonb        NOT NULL,
  model_version       varchar(64)  NOT NULL,
  prompt_version      varchar(64)  NOT NULL,
  fallback_used       boolean      NOT NULL,
  degradation_code    varchar(32),
  created_at          timestamptz  NOT NULL DEFAULT now(),
  updated_at          timestamptz  NOT NULL DEFAULT now(),
  CONSTRAINT ai_match_records_status_check
    CHECK (status IN ('pending', 'completed', 'no_candidate', 'failed')),
  CONSTRAINT ai_match_records_profile_version_range
    CHECK (profile_version IS NULL OR (profile_version >= 1 AND profile_version <= 1000000)),
  CONSTRAINT ai_match_records_snapshot_hash_shape
    CHECK (input_snapshot_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT ai_match_records_model_version_shape
    CHECK (char_length(model_version) BETWEEN 1 AND 64),
  CONSTRAINT ai_match_records_prompt_version_shape
    CHECK (char_length(prompt_version) BETWEEN 1 AND 64),
  CONSTRAINT ai_match_records_degradation_code_check
    CHECK (
      degradation_code IS NULL
      OR degradation_code IN (
        'AI_DISABLED',
        'AI_TIMEOUT',
        'AI_PROVIDER_ERROR',
        'AI_OUTPUT_INVALID',
        'AI_ILLEGAL_GROUP_ID',
        'AI_UNGROUNDED_REASON',
        'AI_INPUT_PII_DETECTED',
        'AI_NO_CANDIDATE'
      )
    )
);

COMMENT ON TABLE ai_match_records IS
  'AI 匹配记录：不保存敏感原文，只保存脱敏输入的 sha256 摘要、脱敏推荐结果与模型/提示词版本（docs/P2-数据约束与迁移设计.md）。';
COMMENT ON COLUMN ai_match_records.user_id IS
  '归属：由服务端会话主体写入，永不来自请求体；外键在 users 表建立后补（见下方延后说明）。';
COMMENT ON COLUMN ai_match_records.status IS
  '匹配状态：与 packages/shared 的 MATCHING_REQUEST_STATUS_VALUES 一致（pending/completed/no_candidate/failed）。';
COMMENT ON COLUMN ai_match_records.input_snapshot_hash IS
  '脱敏输入的 sha256 摘要（64 位小写十六进制）：只存摘要、不存原文。';
COMMENT ON COLUMN ai_match_records.degradation_code IS
  '降级错误码：与 @rm/ai-adapter 的 AI_ERROR_CODE_VALUES 一致；未降级时为 NULL。';

-- 约束口径：只把「适配器契约已经蕴含」的规则下沉到存储层（枚举闭集、长度/形状上界）。
-- 适配器行契约已强制「fallback_used=false ⇒ degradation_code 必填」等自洽规则，属于应用层语义；
-- 这里只做存储层的形状防守，不重复实现应用层推理。

-- 外键延后：users 表尚未建立。
--   ALTER TABLE ai_match_records
--     ADD CONSTRAINT fk_ai_match_records_user
--     FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE RESTRICT;

-- 索引：user_id 为前导列，同时服务按主体计数与本人匹配记录按创建顺序分页。
CREATE INDEX IF NOT EXISTS idx_ai_match_records_user_created_at
  ON ai_match_records (user_id, created_at, id);

COMMIT;

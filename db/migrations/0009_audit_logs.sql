-- migration: 0009_audit_logs
-- description: 建立不可变业务审计表 audit_logs（仅追加：表级触发器拒绝业务侧改写与删除）
-- reversible: 是（DROP TABLE IF EXISTS audit_logs：表为追加型审计日志，回滚即整表丢弃）
-- owner: 审计切片持久化（PostgreSQL 审计仓储切片 · 最小表）

BEGIN;

-- 字段清单与 services/api/src/modules/audit/audit.postgres-repository.ts 的
-- POSTGRES_AUDIT_COLUMNS 一一对应（列名/类型与 docs/P1-字段级数据字典.md §4 的 audit_logs 一致）。
-- 刻意不预判后续切片：
--   * 高敏内容与快照列（payload / before / after / reason）属于「管理员代改与拒绝留痕」切片，
--     本表不建：adapter 的列清单里也刻意没有它们，建了只会得到一列永远没有写入方的空列；
--   * 网络与请求元数据（明文 ip / peer_address / request_headers / user_agent / path / url /
--     method）不入库：字典要求「IP 只存哈希」，adapter 只写入 ip_hash；
--   * 链式完整性字段（integrity_hash / prev_hash / sequence）、软删除（deleted_at）与幂等键
--     （idempotency_key）属于后续切片，本表不建；
--   * 审计记录**只追加**，因此没有 updated_at：事件时间就是 occurred_at（服务端时钟），
--     创建即最终形态，不存在「更新」这一生命周期；
--   * users 表尚未有迁移，故 actor_user_id 暂不建外键（与 0002–0008 的既有约定一致）。
CREATE TABLE IF NOT EXISTS audit_logs (
  id            uuid          NOT NULL,
  actor_user_id uuid          NOT NULL,
  action        varchar(64)   NOT NULL,
  result        varchar(16)   NOT NULL,
  resource_type varchar(32)   NOT NULL,
  resource_id   uuid,
  summary       varchar(200)  NOT NULL,
  self_visible  boolean       NOT NULL,
  request_id    uuid          NOT NULL,
  ip_hash       varchar(64)   NOT NULL,
  occurred_at   timestamptz   NOT NULL,
  CONSTRAINT audit_logs_pkey PRIMARY KEY (id),
  -- 受控操作字典（闭集，与 audit.port.ts 的 AUDIT_EVENT_TYPE_VALUES 逐值一致）
  CONSTRAINT audit_logs_action_check
    CHECK (action IN (
      'profile_self_update',
      'membership_apply',
      'membership_review',
      'achievement_review',
      'education_review',
      'matching_request',
      'audit_self_events_read'
    )),
  -- 结果闭集（与 AUDIT_RESULT_VALUES 逐值一致）
  CONSTRAINT audit_logs_result_check
    CHECK (result IN ('success', 'denied', 'failed')),
  -- 资源类型闭集（与 AUDIT_RESOURCE_TYPE_VALUES 逐值一致）
  CONSTRAINT audit_logs_resource_type_check
    CHECK (resource_type IN (
      'user',
      'student_profile',
      'membership',
      'achievement',
      'education_record',
      'matching_request',
      'audit_event'
    )),
  CONSTRAINT audit_logs_summary_length
    CHECK (char_length(summary) BETWEEN 1 AND 200),
  -- 存储 ID 域：主键 / 归属 / 关联 ID 与资源 ID 都必须是合法且**非空**的 UUID
  -- （空 UUID 不是可用主体，adapter 在进 SQL 之前就会拒绝，这里把同一条规则下沉到存储层）
  CONSTRAINT audit_logs_id_not_nil
    CHECK (id <> '00000000-0000-0000-0000-000000000000'::uuid),
  CONSTRAINT audit_logs_actor_not_nil
    CHECK (actor_user_id <> '00000000-0000-0000-0000-000000000000'::uuid),
  CONSTRAINT audit_logs_request_id_not_nil
    CHECK (request_id <> '00000000-0000-0000-0000-000000000000'::uuid),
  CONSTRAINT audit_logs_resource_id_not_nil
    CHECK (resource_id IS NULL OR resource_id <> '00000000-0000-0000-0000-000000000000'::uuid),
  -- 明文 IP 不入库：只接受对端地址的 sha256（64 位小写十六进制）
  CONSTRAINT audit_logs_ip_hash_shape
    CHECK (ip_hash ~ '^[a-f0-9]{64}$')
);

COMMENT ON TABLE audit_logs IS
  '不可变业务审计记录：只允许追加（见 audit_logs_reject_mutation 触发器），业务 API 不提供改写与删除；字段与敏感级别以 docs/P1-字段级数据字典.md §4 为准。';
COMMENT ON COLUMN audit_logs.actor_user_id IS
  '操作主体：由服务端会话主体写入，永不来自请求体；取数时作为归属谓词下推进 SQL（actor_user_id = $1）。';
COMMENT ON COLUMN audit_logs.action IS
  '受控操作字典（闭集）：与 audit.port.ts 的 AuditEventType 一致；本列在 adapter 里映射为领域字段 type。';
COMMENT ON COLUMN audit_logs.summary IS
  '免 PII 的服务端摘要（1–200 字符）：应用层读取契约拒绝身份证号、长数字标识、疑似密钥、连接串与 SQL 语句片段。';
COMMENT ON COLUMN audit_logs.self_visible IS
  '服务端可见性口径：仅用于把「仅管理端可见」的事件排除在本人审计摘要之外，不是授权判定（授权先于任何仓储访问）。';
COMMENT ON COLUMN audit_logs.ip_hash IS
  '对端地址的 sha256：明文 IP / 对端地址不入库；值由服务端从传输层事实推导，不读取任何客户端头。';

-- 约束口径：只把「适配器契约已经蕴含」的规则下沉到存储层（枚举闭集、长度上界、存储 ID 域、
-- 哈希形状）。适配器写入前已按同一组规则校验，因此这些 CHECK 不会拒绝任何合法写入，
-- 只用于拦住绕过应用层的写坏数据。刻意**不**在 SQL 里重复实现应用层语义：
-- 摘要的内容安全（身份证号 / 长数字标识 / 密钥 / 连接串 / SQL）与时间戳格式由 adapter 与读取契约判定。

-- 取数索引：本人审计摘要的取数路径是
--   WHERE actor_user_id = $1 AND self_visible = TRUE ORDER BY occurred_at ASC, id ASC
-- 因此索引以两个等值列前导、排序键随后，覆盖「过滤 + 排序」而不需要额外排序步骤。
CREATE INDEX IF NOT EXISTS idx_audit_logs_actor_visible_occurred
  ON audit_logs (actor_user_id, self_visible, occurred_at, id);

-- ---------------------------------------------------------------------------
-- 仅追加：在**存储层**拒绝业务侧改写与删除
-- ---------------------------------------------------------------------------
-- 为什么用触发器而不是只靠「adapter 没有改写方法」：adapter 缺方法只说明这一条代码路径不存在，
-- 任何 SQL 客户端（运维脚本、误连的会话、未来的 ORM）仍然可以改写或清空审计表。
-- 触发器把「审计只追加」变成数据库自身的不变量（docs/P2-架构与数据设计.md §4
-- 「审计表只允许追加，不提供业务侧 UPDATE / DELETE」）。
-- 只拒绝业务侧的改写 / 删除；DDL（迁移回滚时的 DROP TABLE）与正常追加不受影响。
CREATE OR REPLACE FUNCTION audit_logs_reject_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit_logs 只允许追加：业务侧不得改写或删除审计记录'
    USING ERRCODE = '55000';
END;
$$;

COMMENT ON FUNCTION audit_logs_reject_mutation() IS
  '审计表仅追加保证：任何业务侧改写 / 删除（含整表截断）都在存储层被拒绝。';

DROP TRIGGER IF EXISTS audit_logs_append_only_row ON audit_logs;
CREATE TRIGGER audit_logs_append_only_row
  BEFORE UPDATE OR DELETE ON audit_logs
  FOR EACH ROW EXECUTE FUNCTION audit_logs_reject_mutation();

DROP TRIGGER IF EXISTS audit_logs_append_only_statement ON audit_logs;
CREATE TRIGGER audit_logs_append_only_statement
  BEFORE TRUNCATE ON audit_logs
  FOR EACH STATEMENT EXECUTE FUNCTION audit_logs_reject_mutation();

COMMIT;

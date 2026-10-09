-- migration: 0012_user_compliance
-- description: 建立本人合规状态聚合读模型 user_compliance（隐私同意 / 数据保留 / 导出可用性三个状态闭集 + 归属唯一）
-- reversible: 是（DROP TABLE IF EXISTS user_compliance：本表是服务端派生读模型，回滚即整表丢弃；原始同意表 privacy_consents 不受影响）
-- owner: 合规划片持久化（PostgreSQL 合规状态仓储切片 · 最小表）

BEGIN;

-- 字段清单与 services/api/src/modules/compliance/compliance.postgres-repository.ts 的
-- POSTGRES_COMPLIANCE_COLUMNS（4 个输出列：user_id / privacy_consent / data_retention /
-- export_availability）一致；其余列（id / created_at / updated_at）在该文件的
-- POSTGRES_COMPLIANCE_INTERNAL_COLUMNS 里登记为**存储侧内部列**：既不进 SELECT，也不进领域对象，
-- 更不会进入公开视图（公开视图恰好是三个状态枚举）。
--
-- 与 0001 占位清单的关系：0001 登记的是**原始同意表** privacy_consents
-- （user_id, policy_id, consented_at, withdrawn_at）。它已应用且不可改写（校验和），因此本迁移
-- 不改它，而是显式建出**服务端派生读模型**：
--   * privacy_consents 是**记录来源**（同意 / 撤回的原始事实）；
--   * user_compliance 是**派生读模型**：由「同意状态 + 留存策略 + 导出开关」在服务端派生后落库，
--     供本人合规状态端点按主体取一条。两者是「来源 → 派生」关系，不是同一概念的两份真相。
--
-- 刻意不预判后续切片：
--   * 同意原文 / 政策正文 / 政策版本（consent_text / policy_text / policy_version / policy_id）属于
--     「记录与撤回同意 + 政策版本升级」切片，本表不建：本端点只回答三个状态枚举，原文落库只会把
--     可泄露内容提前带进存储；
--   * 联系方式与身份 PII（name / student_no / phone / email / id_card / wechat_openid …）不建；
--   * 审核与证据列（review_status / reviewer_id / evidence_file_id / evidence_url …）属于后续切片；
--   * 内部时间戳与保留期取值（consented_at / withdrawn_at / expires_at / retention_until / purged_at）
--     不建：本端点的响应里没有任何时间戳，期限取值由 docs/P2-隐私留存矩阵.md 约束「须由责任人批准后
--     配置」，其派生口径仍在 adapter 的验证清单里（retention-and-export-availability-derivation-defined）；
--   * users 表尚未有迁移，故 user_id 暂不建外键（与 0002–0011 的既有约定一致）。
CREATE TABLE IF NOT EXISTS user_compliance (
  id                  uuid          NOT NULL,
  user_id             uuid          NOT NULL,
  privacy_consent     varchar(16)   NOT NULL,
  data_retention      varchar(16)   NOT NULL,
  export_availability varchar(16)   NOT NULL,
  created_at          timestamptz   NOT NULL,
  updated_at          timestamptz   NOT NULL,
  CONSTRAINT user_compliance_pkey PRIMARY KEY (id),
  -- 隐私同意状态闭集（与 compliance.port.ts 的 PRIVACY_CONSENT_STATUS_VALUES 逐值一致）
  CONSTRAINT user_compliance_privacy_consent_check
    CHECK (privacy_consent IN ('granted', 'withdrawn', 'not-recorded')),
  -- 数据保留状态闭集（与 DATA_RETENTION_STATUS_VALUES 逐值一致）
  CONSTRAINT user_compliance_data_retention_check
    CHECK (data_retention IN ('within-retention', 'expired')),
  -- 导出可用性闭集（与 EXPORT_AVAILABILITY_STATUS_VALUES 逐值一致）
  CONSTRAINT user_compliance_export_availability_check
    CHECK (export_availability IN ('available', 'unavailable')),
  -- 跨字段不变式：`available` 是**需要举证**的强断言，必须由「已生效的同意」与「仍在保留期内」
  -- 支撑（与 compliance.contract.ts 读取契约的单向蕴含逐字一致）。反向不成立：已同意且未过期
  -- 也可以声明 unavailable（导出通道未开启）。
  CONSTRAINT user_compliance_export_requires_active_consent
    CHECK (
      export_availability <> 'available'
      OR (privacy_consent = 'granted' AND data_retention = 'within-retention')
    ),
  -- 存储 ID 域：主键与归属都必须是合法且**非空**的 UUID
  -- （空 UUID 不是可用主体，adapter 在进 SQL 之前就会拒绝，这里把同一条规则下沉到存储层）
  CONSTRAINT user_compliance_id_not_nil
    CHECK (id <> '00000000-0000-0000-0000-000000000000'::uuid),
  CONSTRAINT user_compliance_user_id_not_nil
    CHECK (user_id <> '00000000-0000-0000-0000-000000000000'::uuid)
);

COMMENT ON TABLE user_compliance IS
  '本人合规状态聚合读模型（隐私同意 / 数据保留 / 导出可用性）：归属 user_id 由服务端会话主体决定；本表是 privacy_consents 等来源记录的**服务端派生**读模型，字段与敏感级别以 docs/P1-字段级数据字典.md 与 docs/P2-架构与数据设计.md §2 为准。';
COMMENT ON COLUMN user_compliance.user_id IS
  '归属主体：由服务端会话主体决定，永不来自请求体；取数时作为归属谓词下推进 SQL（user_id = $1::uuid）。该列不进入公开视图。';
COMMENT ON COLUMN user_compliance.privacy_consent IS
  '隐私同意状态（闭集 granted / withdrawn / not-recorded）：只表达服务端是否记录了有效同意，不携带同意原文、政策正文与时间。';
COMMENT ON COLUMN user_compliance.data_retention IS
  '数据保留状态（闭集 within-retention / expired）：只回答是否仍在批准的保留期限内，不携带期限取值与到期时间。';
COMMENT ON COLUMN user_compliance.export_availability IS
  '导出可用性（闭集 available / unavailable）：available 需由已生效的同意与未过的保留期支撑（见 user_compliance_export_requires_active_consent）。';
COMMENT ON COLUMN user_compliance.created_at IS
  '存储侧内部列（创建时间）：登记在 adapter 的 POSTGRES_COMPLIANCE_INTERNAL_COLUMNS 里，不进入 SELECT / RETURNING、领域对象与公开视图。';
COMMENT ON COLUMN user_compliance.updated_at IS
  '存储侧内部列（更新时间）：与 created_at 同一口径，绝不进入公开输出、错误消息与日志。';

-- 约束口径：只把「适配器契约已经蕴含」的规则下沉到存储层（枚举闭集、跨字段不变式、存储 ID 域）。
-- 适配器读取前已按同一组规则校验（严格行契约 + 读取契约），因此这些 CHECK 不会拒绝任何合法写入，
-- 只用于拦住绕过应用层的写坏数据。刻意**不**在 SQL 里重复实现应用层语义：公开视图白名单、
-- 字段闭集与状态自洽的判定仍由读取契约与 adapter 承担。

-- 本读模型**按主体唯一**（本人合规状态至多一条），因此用唯一索引把同一主体两行变成存储层错误
-- （23505），而不是让 adapter 在结果集复核里才发现（那里判 RESULT_SET_VIOLATION 并 fail-closed）。
CREATE UNIQUE INDEX IF NOT EXISTS uq_user_compliance_user_id
  ON user_compliance (user_id);

COMMIT;

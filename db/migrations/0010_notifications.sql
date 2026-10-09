-- migration: 0010_notifications
-- description: 建立站内通知表 notifications（本人通知箱读写：归属隔离 + read 状态机单一前向边）
-- reversible: 是（DROP TABLE IF EXISTS notifications：表为站内通知状态，回滚即整表丢弃）
-- owner: 通知切片持久化（PostgreSQL 通知仓储切片 · 最小表）

BEGIN;

-- 字段清单与 services/api/src/modules/notifications/notifications.postgres-repository.ts 的
-- POSTGRES_NOTIFICATION_COLUMNS 一一对应（9 列，双向一致：不多列也不许少列）。
-- 刻意不预判后续切片：
--   * 订阅消息外发相关列（recipient_openid / template_id / send_status / retry_count）
--     属于「订阅消息下发与失败重试」切片，本表不建：adapter 的列清单里也没有它们，
--     建了只会得到一列永远没有写入方的空列，且会把 PII 提前带进存储；
--   * 跳转与附件列（payload / deep_link_path / action_url / attachment_storage_handle）
--     属于通知生产侧与小程序落地页切片，本表不建（adapter 已把它们登记为**内部列**，
--     既不进 SELECT / RETURNING，也不进领域对象）；
--   * 软删除（deleted_at）、归档、幂等键（idempotency_key）、批量已读与未读计数的物化列
--     属于后续切片，本表不建；
--   * users 表尚未有迁移，故 user_id 暂不建外键（与 0002–0009 的既有约定一致）。
CREATE TABLE IF NOT EXISTS notifications (
  id          uuid          NOT NULL,
  user_id     uuid          NOT NULL,
  type        varchar(32)   NOT NULL,
  title       varchar(200)  NOT NULL,
  body        varchar(2000) NOT NULL,
  status      varchar(16)   NOT NULL,
  read_at     timestamptz,
  created_at  timestamptz   NOT NULL,
  updated_at  timestamptz   NOT NULL,
  CONSTRAINT notifications_pkey PRIMARY KEY (id),
  -- 通知类型闭集（与 notifications.port.ts 的 NOTIFICATION_TYPE_VALUES 逐值一致）
  CONSTRAINT notifications_type_check
    CHECK (type IN (
      'membership_review',
      'achievement_review',
      'education_review',
      'matching_result',
      'announcement'
    )),
  -- 阅读状态闭集（与 NOTIFICATION_STATUS_VALUES 逐值一致）：read 是终态
  CONSTRAINT notifications_status_check
    CHECK (status IN ('unread', 'read')),
  -- 标题 / 正文长度上界与读取契约一致（riskFreeText(1, 200) / riskFreeText(0, 2000)）
  CONSTRAINT notifications_title_length
    CHECK (char_length(title) BETWEEN 1 AND 200),
  CONSTRAINT notifications_body_length
    CHECK (char_length(body) <= 2000),
  -- 跨字段不变式：`read` 必须带服务端已读时间，`unread` 不得携带（与 markNotificationRead 状态机一致）
  CONSTRAINT notifications_read_state_consistent
    CHECK ((status = 'read') = (read_at IS NOT NULL)),
  -- 存储 ID 域：主键与归属都必须是合法且**非空**的 UUID
  -- （空 UUID 不是可用主体，adapter 在进 SQL 之前就会拒绝，这里把同一条规则下沉到存储层）
  CONSTRAINT notifications_id_not_nil
    CHECK (id <> '00000000-0000-0000-0000-000000000000'::uuid),
  CONSTRAINT notifications_user_id_not_nil
    CHECK (user_id <> '00000000-0000-0000-0000-000000000000'::uuid)
);

COMMENT ON TABLE notifications IS
  '站内通知（本人通知箱）：归属 user_id 由服务端会话主体写入，状态只由服务端 read 状态机推进；字段与敏感级别以 docs/P1-字段级数据字典.md 与 docs/P2-架构与数据设计.md §2 为准。';
COMMENT ON COLUMN notifications.user_id IS
  '归属主体：由服务端会话主体写入，永不来自请求体；取数时作为归属谓词下推进 SQL（user_id = $1）。';
COMMENT ON COLUMN notifications.type IS
  '通知类型（闭集）：与 notifications.port.ts 的 NotificationType 一致；只描述通知因何产生，不参与授权判定。';
COMMENT ON COLUMN notifications.title IS
  '免 PII 标题（1–200 字符）：应用层读取契约拒绝身份证号、长数字标识、疑似密钥与连接串。';
COMMENT ON COLUMN notifications.body IS
  '免 PII 正文（0–2000 字符）：与标题同一道内容安全门禁；公开视图逐字段裁剪，不携带归属与内部列。';
COMMENT ON COLUMN notifications.status IS
  '阅读状态（闭集 unread / read）：唯一前向边是 unread -> read，且幂等；不存在「已读 -> 未读」回退路径。';
COMMENT ON COLUMN notifications.read_at IS
  '服务端标记已读时间：与 status 由 CHECK 约束绑定（read 必填 / unread 必空），因此 readAt 不会被重复请求改写。';

-- 约束口径：只把「适配器契约已经蕴含」的规则下沉到存储层（枚举闭集、长度上界、跨字段不变式、
-- 存储 ID 域）。适配器写入前已按同一组规则校验，因此这些 CHECK 不会拒绝任何合法写入，
-- 只用于拦住绕过应用层的写坏数据。刻意**不**在 SQL 里重复实现应用层语义：
-- 标题 / 正文的内容安全（身份证号 / 长数字标识 / 密钥 / 连接串）与时间戳格式由 adapter
-- 与读取契约判定。

-- 取数索引：本人通知列表的取数路径是
--   WHERE user_id = $1 ORDER BY created_at ASC, id ASC
-- 因此索引以等值列前导、排序键随后，覆盖「过滤 + 排序」而不需要额外排序步骤。
-- 单条读取（WHERE id = $1 AND user_id = $2）由主键索引覆盖，不需要额外索引。
CREATE INDEX IF NOT EXISTS idx_notifications_user_created
  ON notifications (user_id, created_at, id);

COMMIT;

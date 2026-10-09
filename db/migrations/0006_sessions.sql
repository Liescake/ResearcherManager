-- migration: 0006_sessions
-- description: 建立服务端会话表 sessions（会话票据的不可逆 sha256 摘要 + 服务端主体 + 角色/范围 + 过期/撤销）
-- reversible: 是（DROP TABLE IF EXISTS sessions）
-- owner: P4 持久化基础（会话存储切片 · 最小会话表）

BEGIN;

-- 最小字段集（刻意只有 6 列，不预判后续切片）：
--   session_id  —— 客户端 Bearer 票据的 **sha256 摘要**（64 位小写十六进制），同时是主键与查询键。
--                  原始票据绝不落库：落库的是不可逆摘要，拿到表内容也无法反推出可用凭证。
--                  票据本身是 43 字符 base64url，与摘要的 64 字符十六进制**形状不重叠**，
--                  因此下面的形状约束会在结构上拒绝「把原始票据直接写进这一列」这种写入错误。
--   user_id     —— 服务端主体（会话解析结果的权威来源），非请求体输入。
--   roles       —— 服务端主体角色集合（文本数组，元素形状受约束）。
--   scope       —— 服务端主体范围（jsonb 对象，只承载 groupIds / assignedResourceIds）。
--   expires_at  —— 过期时刻（timestamptz，数据库时钟判定）。
--   revoked_at  —— 撤销时刻；NULL 表示未撤销。
--
-- 与 db/migrations/README.md「每个业务表含 created_at / updated_at」的偏差是**刻意的**：
-- 本切片要求字段仅上面 6 列；过期清理由 expires_at 承担，撤销审计由上层审计切片承担，
-- 因此不引入额外的记账列。
CREATE TABLE IF NOT EXISTS sessions (
  session_id  varchar(64)  PRIMARY KEY,
  user_id     varchar(64)  NOT NULL,
  roles       text[]       NOT NULL,
  scope       jsonb        NOT NULL,
  expires_at  timestamptz  NOT NULL,
  revoked_at  timestamptz,
  CONSTRAINT sessions_session_id_shape
    CHECK (session_id ~ '^[0-9a-f]{64}$'),
  CONSTRAINT sessions_user_id_shape
    CHECK (user_id ~ '^[A-Za-z0-9._:@-]{1,64}$'),
  CONSTRAINT sessions_roles_shape
    CHECK (
      cardinality(roles) BETWEEN 1 AND 16
      AND cardinality(roles) = cardinality(array_remove(roles, NULL))
      AND array_to_string(roles, ',') ~ '^[a-z][a-z0-9_]*(,[a-z][a-z0-9_]*)*$'
    ),
  CONSTRAINT sessions_scope_shape
    CHECK (jsonb_typeof(scope) = 'object')
);

COMMENT ON TABLE sessions IS
  '服务端会话：只保存 Bearer 票据的 sha256 摘要与主体事实，不保存原始票据（docs/P2-数据约束与迁移设计.md）。';
COMMENT ON COLUMN sessions.session_id IS
  '客户端 Bearer 票据的不可逆 sha256 摘要（64 位小写十六进制）：摘要即主键，原始票据永不落库。';
COMMENT ON COLUMN sessions.user_id IS
  '服务端主体标识：由会话创建方（服务端）写入，永不来自请求体；外键在 users 表建立后补（见下方延后说明）。';
COMMENT ON COLUMN sessions.roles IS
  '服务端主体角色集合：元素形状在存储层约束，**角色闭集**由 packages/shared 的 ROLE_VALUES 拥有，'
  '由认证边界（normalizeSubject）在解析时判定 —— 在 SQL 里复制一份枚举会让新增角色必须改迁移，'
  '也会让陈旧的库约束静默拒绝合法会话。';
COMMENT ON COLUMN sessions.scope IS
  '服务端主体范围（jsonb 对象）：只承载 groupIds / assignedResourceIds 两类已验证的组关系。';
COMMENT ON COLUMN sessions.revoked_at IS
  '撤销时刻；NULL 表示未撤销。已撤销会话在读取路径上不可用，等待过期清理或保留审计。';

-- 约束口径：只下沉「适配器契约已经蕴含」的形状规则（摘要形状、主体 ID 形状、角色数量与元素形状、
-- 范围必须是对象）。不重复实现应用层语义：角色是否已登记、范围键是否合法、TTL 是否有界，
-- 都由 adapter 的严格行契约与认证边界判定。
--
-- 刻意不建 `revoked_at <= expires_at`：撤销一条**已经过期**的会话是合法的 no-op，
-- 加上该约束会让「撤销」在过期行上直接失败，破坏幂等撤销。

-- 外键延后：users 表尚未建立。
--   ALTER TABLE sessions
--     ADD CONSTRAINT fk_sessions_user
--     FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE RESTRICT;

-- 索引：会话读取走主键（session_id），这里只补过期清理的扫描路径。
CREATE INDEX IF NOT EXISTS idx_sessions_expires_at ON sessions (expires_at);

COMMIT;

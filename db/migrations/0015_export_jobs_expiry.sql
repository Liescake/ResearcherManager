-- migration: 0015_export_jobs_expiry
-- description: 为导出请求事实表 export_jobs 增加服务端产物有效期列 expires_at（下载边界的过期判定；NULL fail-closed）
-- reversible: 是（ALTER TABLE export_jobs DROP COLUMN IF EXISTS expires_at：只回滚本迁移新增的列与约束，不动 0013 建出的表、其它列与既有数据）
-- owner: 导出切片持久化（下载有效期 · 存储层列补齐）

BEGIN;

-- 为什么需要这一条迁移（而不是改写 0013）：
-- 0013_export_jobs.sql 已应用且校验和钉住，不可改写；它刻意**没有**建 expires_at
-- （原文注释把它登记为「有效期与清理、下载审计、幂等键等后续切片」）。下载边界的过期判定
-- 是本切片新引入的**服务端事实**，因此按仓库约定用「下一个空闲版本号」新增迁移补列，
-- 而不是只改 adapter —— 只改 adapter 会让「代码认为有 expires_at、真实表里没有」在
-- 真库上表现为 42703（column does not exist），把配置/装配缺陷伪装成运行期故障。
--
-- 语义（与 services/api/src/modules/exports/exports.port.ts 的 ExportRequest.expiresAt
-- 与 exports.postgres-repository.ts 的 POSTGRES_EXPORT_COLUMNS 逐列一致）：
--   * **绝对时刻**：timestamptz 存的是 UTC 瞬时点，不含本地时区与夏令时歧义；
--     adapter 读出的形态固定为 `toISOString()`（`YYYY-MM-DDTHH:mm:ss.sssZ`），
--     因此「写入 → 读出 → 比较」三段使用的是同一个绝对量，时间比较与时区无关；
--   * **列可空（刻意不加 NOT NULL、刻意不给 DEFAULT）**：NULL 表示「这条记录没有服务端写入的
--     有效期」。它是**fail-closed** 的取值：下载边界把 NULL 与「不存在 / 跨主体 / 未完成 / 产物缺失」
--     收敛到同一个稳定拒绝，绝不把 NULL 解释成「永不过期」。同时不加 DEFAULT 是有意的——
--     有效期只能由服务端（service 的服务端时钟）写入，存储层不得自行发明一个有效期；
--     既有行（0013 建立后、本迁移之前写入的记录）因此得到 NULL 并自动被下载边界拒绝，
--     而不是被静默赋予一个谁都没审过的到期时间。
--
-- 与 0001 的关系：0001_bootstrap.sql 只在业务表占位注释里提到 export_jobs，没有建表语句；
-- 表由 0013 建出。本迁移只补列与约束，不新建表、不新建索引。
ALTER TABLE export_jobs
  ADD COLUMN IF NOT EXISTS expires_at timestamptz;

-- 跨字段不变式：有效期必须在创建时间**之后**（`expires_at IS NULL OR expires_at > created_at`）。
-- 它把 service「写入 `createdAt = now` 与 `expiresAt = now + TTL`（TTL > 0）」这条规则下沉到存储层：
--   * NULL 放行 —— NULL 是 fail-closed 的合法存储形态（见上），不是「写坏的数据」；
--   * 早于创建时间的有效期永远是「一出生就过期」的记录，属于写坏的数据，必须拦住；
--   * 比较发生在数据库自己的 timestamptz 语义上（同一绝对时刻轴上的比较），
--     因此时区/夏令时不会让这条约束产生歧义。
ALTER TABLE export_jobs
  DROP CONSTRAINT IF EXISTS export_jobs_expires_at_after_created_at;
ALTER TABLE export_jobs
  ADD CONSTRAINT export_jobs_expires_at_after_created_at
  CHECK (expires_at IS NULL OR expires_at > created_at);

COMMENT ON COLUMN export_jobs.expires_at IS
  '服务端产物有效期（绝对时刻 · timestamptz）：只由服务端时钟写入（创建时 = 创建时刻 + 服务端 TTL），客户端提交的同名字段一律 400；写回路径不改写该列。NULL 表示没有服务端有效期，下载边界按 fail-closed 拒绝（与「不存在 / 跨主体 / 未完成 / 产物缺失」同一出口），绝不解释为「永不过期」。该列不进入公开视图（到期时刻不外发），因此已登记进 adapter 的公开输出裁剪列。';
COMMENT ON CONSTRAINT export_jobs_expires_at_after_created_at ON export_jobs IS
  '有效期必须在创建时间之后（NULL 放行）：把 service「expiresAt = createdAt + 服务端正 TTL」这条不变式下沉到存储层；早于创建时间的有效期属于写坏的数据。';

COMMIT;

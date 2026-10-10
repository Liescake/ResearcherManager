-- migration: 0016_export_jobs_revocation
-- description: 为导出请求事实表 export_jobs 增加服务端撤销列 revoked_at（本人撤销切片：撤销事实与状态机正交，只由服务端时钟写入）
-- reversible: 是（ALTER TABLE export_jobs DROP COLUMN IF EXISTS revoked_at：只回滚本迁移新增的列与两个 CHECK，不动 0013/0015 建出的表、其它列与既有数据）
-- owner: 导出切片持久化（本人撤销 · 存储层列补齐）

BEGIN;

-- 为什么需要这一条迁移（而不是改写 0013 / 0015）：
-- 0013_export_jobs.sql 与 0015_export_jobs_expiry.sql 都已应用且校验和钉住，不可改写；
-- 0013 的原文注释把「下载簿记 / 软删除」一类列登记为后续切片。撤销（本人取回自己的导出请求）
-- 是本切片新引入的**服务端事实**，因此按仓库约定用「下一个空闲版本号」新增迁移补列，
-- 而不是只改 adapter —— 只改 adapter 会让「代码认为有 revoked_at、真实表里没有」在真库上
-- 表现为 42703（column does not exist），把配置/装配缺陷伪装成运行期故障。
--
-- 语义（与 services/api/src/modules/exports/exports.port.ts 的 ExportRequest.revokedAt
-- 与 exports.postgres-repository.ts 的 POSTGRES_EXPORT_COLUMNS 逐列一致）：
--   * **绝对时刻**：timestamptz 存的是 UTC 瞬时点，不含本地时区与夏令时歧义；
--     adapter 读出的形态固定为 `toISOString()`（`YYYY-MM-DDTHH:mm:ss.SSSZ`），
--     因此「写入 → 读出 → 比较」三段使用的是同一个绝对量，时间比较与时区无关；
--   * **列可空（刻意不加 NOT NULL、刻意不给 DEFAULT）**：NULL 表示「这条记录**没有**被撤销」。
--     不给 DEFAULT 是有意的 —— 撤销时刻只能由服务端（service 的服务端时钟）写入，
--     存储层不得自行发明一个撤销时刻；既有行（本迁移之前写入的记录）因此得到 NULL
--     （= 未被撤销），而不是被静默赋予一个谁都没审过的撤销时间；
--   * **与状态机正交**：本列**不是**第四个 status 取值。撤销是一条独立的服务端事实
--     （单调：NULL → 时刻，永不回退），因此 0013 的 `status` 闭集
--     （`export_jobs_status_check`：pending / completed / failed）与
--     `export_jobs_artifact_matches_status`（产物短引用当且仅当 completed 时存在）两条
--     已应用约束**逐字不变** —— 撤销不删除产物（无物理删除、无同步清理），
--     也不改写既有结论终态。
--
-- 与 0001 的关系：0001_bootstrap.sql 只在业务表占位注释里提到 export_jobs，没有建表语句；
-- 表由 0013 建出，服务端有效期列由 0015 补出。本迁移只补列与约束，不新建表、不新建索引。
ALTER TABLE export_jobs
  ADD COLUMN IF NOT EXISTS revoked_at timestamptz;

-- 跨字段不变式（存储层镜像「failed 不可撤销」）：
-- `revoked_at IS NULL OR status IN ('pending', 'completed')`。
--   * NULL 放行 —— NULL 是「未被撤销」的合法存储形态（见上），不是「写坏的数据」；
--   * `pending` / `completed` 放行 —— 这两类结论都可被本人撤销（撤销是取回交付物，不是推进状态机）；
--   * `failed` 被拒绝 —— 失败结论没有任何可交付内容，撤销它只会凭空改写历史结论；
--   * 取值闭集直接写成字面量（pending / completed），与 adapter 的可撤销前驱集合
--     （exports.state-machine.ts 的 EXPORT_REVOCABLE_STATUSES）逐值一致。
-- 刻意**不**把「已过期不可撤销」写成 CHECK：过期是**相对当前时刻**的性质，CHECK 必须
-- 对同一行永远成立，时间相关性会让约束随墙钟变化而翻转。该规则留在 service 的撤销边界
-- （与下载边界共用同一个 `isExportDownloadExpired` 判定），存储层只钉住与时间无关的三条。
ALTER TABLE export_jobs
  DROP CONSTRAINT IF EXISTS export_jobs_revoked_at_matches_status;
ALTER TABLE export_jobs
  ADD CONSTRAINT export_jobs_revoked_at_matches_status
  CHECK (revoked_at IS NULL OR status IN ('pending', 'completed'));

-- 跨字段不变式：撤销时刻不得早于创建时刻（`revoked_at IS NULL OR revoked_at >= created_at`）。
--   * NULL 放行（未被撤销）；
--   * 相等放行 —— 与 0015 的「有效期必须**严格**晚于创建时间」不同：撤销发生在记录存在之后，
--     服务端在同一毫秒内创建并撤销是合法事实，因此这里用 `>=` 而不是 `>`；
--   * 早于创建时间永远是「一出生就被撤销」的写坏数据，必须拦住；
--   * 比较发生在数据库自己的 timestamptz 语义上（同一绝对时刻轴上的比较），
--     因此时区/夏令时不会让这条约束产生歧义。
ALTER TABLE export_jobs
  DROP CONSTRAINT IF EXISTS export_jobs_revoked_at_after_created_at;
ALTER TABLE export_jobs
  ADD CONSTRAINT export_jobs_revoked_at_after_created_at
  CHECK (revoked_at IS NULL OR revoked_at >= created_at);

COMMENT ON COLUMN export_jobs.revoked_at IS
  '服务端撤销时刻（绝对时刻 · timestamptz）：只由服务端时钟在本人撤销入口写入（值 = 该次撤销的服务端当前时刻），客户端提交的同名字段一律 400 且不回显；撤销是**单调**事实（NULL → 时刻），没有任何写回路径会清空或改写它（状态机推进的 SET 列表里没有本列，并发撤销必须胜过并发完成）。NULL 表示未被撤销。撤销后下载边界立即按统一拒绝（404）失效，但本列不触发任何物理删除或产物清理（清理属异步后续切片）。该列不进入公开视图（撤销时刻不外发，列表只把 status 呈现为 revoked），因此已登记进 adapter 的公开输出裁剪列。';
COMMENT ON CONSTRAINT export_jobs_revoked_at_matches_status ON export_jobs IS
  '撤销时刻只允许落在可撤销结论上（pending / completed；NULL 放行）：failed 结论没有可交付内容，不得被撤销；取值闭集与 adapter 的 EXPORT_REVOCABLE_STATUSES 逐值一致。';
COMMENT ON CONSTRAINT export_jobs_revoked_at_after_created_at ON export_jobs IS
  '撤销时刻不得早于创建时刻（NULL 放行；相等放行）：把 service「撤销发生在记录存在之后」这条不变式下沉到存储层；早于创建时间的撤销时刻属于写坏的数据。';

COMMIT;

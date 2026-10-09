-- migration: 0013_export_jobs
-- description: 建立导出请求事实表 export_jobs（导出切片持久化：状态读 / 创建 / 完成；落库只含受控状态与服务端短引用）
-- reversible: 是（DROP TABLE IF EXISTS export_jobs：本表是本切片的事实表，回滚即整表丢弃；既有迁移不受影响）
-- owner: 导出切片持久化（PostgreSQL 导出请求仓储切片 · 最小表）

BEGIN;

-- 列清单与 services/api/src/modules/exports/exports.postgres-repository.ts 的
-- POSTGRES_EXPORT_COLUMNS **逐列一致**（8 个输出列：id / requester_id / resource / fields /
-- status / artifact_id / created_at / updated_at）。adapter 只使用显式列清单（绝不 SELECT *）
-- 且行契约是 .strict()，因此本表多建的任何列都会让读取路径 fail-closed。
--
-- 与 0001 占位清单的关系：0001_bootstrap.sql 只在业务表占位注释里提到 export_jobs，没有建表语句。
-- 0001 已应用且不可改写（校验和），因此本迁移把该表显式建出来。命名与 docs/P2-ER图.md 的
-- export_jobs(id, requester_id, resource, filters, fields, status, expires_at, downloaded_at) 对齐，
-- 并按其最小字段列表 + 本切片端口需要补齐 artifact_id（承载服务端生成的产物短引用）。
--
-- 刻意不建本切片契约之外的高敏列（用户明确要求：原始 PII / 文件路径 / 对象存储凭据 / 下载签名
-- **都不得落库**）：
--   * 产物位置与文件体（file_name / file_path / download_url / signed_url / storage_key /
--     object_key / artifact_handle / content / checksum）——位置即能力，泄露即等同交付；
--   * 原始 PII 与内部资源内容（resource_id / resource_snapshot / filters）——快照可能含未脱敏的
--     画像或成果内部字段；
--   * 原始错误文本（error_message / failure_reason / stack_trace）——可能含内部路径与连接串；
--   * 存储侧簿记（expires_at / downloaded_at / deleted_at / idempotency_key）——属于有效期与清理、
--     下载审计、幂等键等**后续切片**，本切片端口没有这些字段，建了只会得到没有写入方的空列。
-- 本表落库的内容因此只有：服务端生成的 UUID 短引用（id / artifact_id）、服务端会话主体归属
-- （requester_id）、服务端白名单内的资源与字段选择（resource / fields）、状态机结论（status）
-- 与服务端时钟（created_at / updated_at）。
--
-- users / research_groups 尚未有可引用的迁移，故 requester_id 暂不建外键（与 0002–0012 的既有约定一致）。
CREATE TABLE IF NOT EXISTS export_jobs (
  id           uuid        NOT NULL,
  requester_id uuid        NOT NULL,
  resource     varchar(16) NOT NULL,
  fields       text[]      NOT NULL,
  status       varchar(16) NOT NULL,
  artifact_id  uuid,
  created_at   timestamptz NOT NULL,
  updated_at   timestamptz NOT NULL,
  CONSTRAINT export_jobs_pkey PRIMARY KEY (id),
  -- 导出资源闭集（与 exports.port.ts 的 EXPORT_RESOURCE_VALUES 逐值一致）
  CONSTRAINT export_jobs_resource_check
    CHECK (resource IN ('profile', 'achievement', 'education', 'statistics')),
  -- 导出任务状态闭集（与 EXPORT_STATUS_VALUES 逐值一致）：入口恒为 pending，终态不可再转移
  CONSTRAINT export_jobs_status_check
    CHECK (status IN ('pending', 'completed', 'failed')),
  -- 跨字段不变式：产物短引用**当且仅当**结论为 completed 时存在。
  -- 它正是 adapter 读取契约「状态与产物句柄自洽」与状态机在存储层的镜像：
  --   * completed 必须带 artifact_id（否则「导出已完成」是无凭据的强断言）；
  --   * pending / failed 不得携带 artifact_id（否则会凭空交付一个并不存在的产物引用）。
  CONSTRAINT export_jobs_artifact_matches_status
    CHECK ((status = 'completed') = (artifact_id IS NOT NULL)),
  -- 字段选择必须非空（与行契约的 .min(1) 一致）；上界由应用层白名单与 EXPORT_MAX_FIELD_COUNT 约束
  CONSTRAINT export_jobs_fields_not_empty
    CHECK (cardinality(fields) >= 1),
  -- 存储 ID 域：主键、归属与产物短引用都必须是合法且**非空**的 UUID
  -- （空 UUID 不是可用主体/产物，adapter 在进 SQL 之前就会拒绝，这里把同一条规则下沉到存储层）
  CONSTRAINT export_jobs_id_not_nil
    CHECK (id <> '00000000-0000-0000-0000-000000000000'::uuid),
  CONSTRAINT export_jobs_requester_id_not_nil
    CHECK (requester_id <> '00000000-0000-0000-0000-000000000000'::uuid),
  CONSTRAINT export_jobs_artifact_id_not_nil
    CHECK (artifact_id IS NULL OR artifact_id <> '00000000-0000-0000-0000-000000000000'::uuid)
);

COMMENT ON TABLE export_jobs IS
  '导出请求事实表（本人导出请求的最小垂直切片）：归属 requester_id 由服务端会话主体决定，绝不来自请求体；本表只保存受控状态与服务端生成的短引用（UUID），不保存原始 PII、文件路径、对象存储凭据或下载签名。';
COMMENT ON COLUMN export_jobs.id IS
  '导出请求主键：由服务端生成的 UUID 短引用，客户端提交的同名字段一律 400。';
COMMENT ON COLUMN export_jobs.requester_id IS
  '归属主体：由服务端会话主体决定，永不来自请求体；取数时作为归属谓词下推进 SQL（requester_id = $1::uuid），写回时与 id 一起构成 WHERE 条件。该列不进入公开视图。';
COMMENT ON COLUMN export_jobs.resource IS
  '导出资源（闭集 profile / achievement / education / statistics）：客户端只能在服务端白名单内选择。';
COMMENT ON COLUMN export_jobs.fields IS
  '导出字段选择（text[]）：必须是该资源服务端字段白名单的子集；由 service 归一化后写入。';
COMMENT ON COLUMN export_jobs.status IS
  '任务状态（闭集 pending / completed / failed）：入口恒为 pending，只允许推进到一个终态，终态不可再转移。';
COMMENT ON COLUMN export_jobs.artifact_id IS
  '服务端产物短引用（不透明 UUID，仅 completed 存在）：绝不进入任何 API 输出，也不携带路径、URL 或存储 key。';
COMMENT ON COLUMN export_jobs.created_at IS
  '创建时间（服务端时钟）：只由服务端写入，写回时作为不可变列逐列复核。';
COMMENT ON COLUMN export_jobs.updated_at IS
  '更新时间（服务端时钟）：随状态推进改写，写回时逐列复核。';

-- 约束口径：只把「适配器契约已经蕴含」的规则下沉到存储层（枚举闭集、跨字段不变式、存储 ID 域、
-- 字段非空）。适配器读取前已按同一组规则校验（严格行契约 + 读取契约），因此这些 CHECK 不会拒绝
-- 任何合法写入，只用于拦住绕过应用层的写坏数据。刻意**不**在 SQL 里重复实现应用层语义：
-- 公开视图白名单、字段白名单子集与去重的判定仍由读取契约与 adapter 承担。

-- 取数索引：覆盖本切片唯一的列表路径「按主体过滤 + 按创建顺序全序排序」
-- （adapter 的 ORDER_BY 是 `created_at ASC, id ASC`）。前导列是归属列，因此他人导出请求
-- 既不出库，也不需要在索引上做额外过滤。
CREATE INDEX IF NOT EXISTS idx_export_jobs_requester_created
  ON export_jobs (requester_id, created_at, id);

COMMIT;

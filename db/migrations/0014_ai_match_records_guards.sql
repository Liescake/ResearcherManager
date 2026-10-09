-- migration: 0014_ai_match_records_guards
-- description: 补齐 ai_match_records 的存储层守卫（存储 ID 域非空、推荐结果必须是 jsonb 数组且不超过 3 条）
-- reversible: 是（DROP CONSTRAINT IF EXISTS：只回滚本迁移新增的约束，不动 0005 建出的表与数据）
-- owner: 匹配记录持久化（PostgreSQL 匹配仓储切片 · 存储层契约补齐）

BEGIN;

-- 为什么需要这一条迁移（而不是改写 0005）：
-- 0005_ai_match_records.sql 已应用且校验和钉住，不可改写。它建出的表满足 adapter 的**列清单**，
-- 但缺少两类「存储层不变量」，而这两类恰好是真实 PostgreSQL 集成测试（
-- services/api/src/db/postgres/__tests__/matching-integration.spec.ts）实测出的缺口：
--   1. **存储 ID 域的非空形**：adapter 在进入 SQL 之前就拒绝空 UUID（`INVALID_SUBJECT` /
--      `INVALID_RECORD`），但存储层原先允许直接插入 `00000000-...-0000` 作为归属 ——
--      空 UUID 不是可用主体，一旦落库就变成「谁都取不到、却真实占用主键」的行；
--   2. **推荐结果的形状**：adapter 的读取契约要求 `recommendations` 是数组且条数 ≤
--      MATCHING_MAX_RECOMMENDATIONS（3），但 0005 只声明了 `jsonb NOT NULL`，
--      因此绕过应用层可以直接写入对象或超长数组。
--
-- 刻意**不**在存储层重复实现应用层推理（与 0005 的口径一致）：
--   * 「completed 至少有 1 条、其余状态必须为空」属于读取契约的状态/条数自洽，仍由 adapter 与
--     读取契约承担（统计切片的历史夹具也会写只用于计数的行，SQL 里不重复判定该推理）；
--   * 枚举闭集（status / degradation_code）与摘要形状（sha256 十六进制）0005 已经有 CHECK，不重复。
--
-- 与 0001 的关系：0001_bootstrap.sql 只登记表名占位，本迁移不新建表，只补约束。
-- 现有合法写入不受影响：adapter 落库的 id / user_id 恒为规范小写非空 UUID，推荐结果恒为
-- 0—3 条的 JSON 数组，因此这些 CHECK 只会拦住绕过应用层的写坏数据。

-- id：主键必须是合法且非空的 UUID（adapter 在进 SQL 之前已判，这里把同一条规则下沉到存储层）
ALTER TABLE ai_match_records
  DROP CONSTRAINT IF EXISTS ai_match_records_id_not_nil;
ALTER TABLE ai_match_records
  ADD CONSTRAINT ai_match_records_id_not_nil
  CHECK (id <> '00000000-0000-0000-0000-000000000000'::uuid);

-- user_id：归属必须是合法且非空的 UUID。空 UUID 的归属会让「按主体取数」的归属谓词永远不命中，
-- 等价于一条既不属于任何人、又占着主键的行
ALTER TABLE ai_match_records
  DROP CONSTRAINT IF EXISTS ai_match_records_user_id_not_nil;
ALTER TABLE ai_match_records
  ADD CONSTRAINT ai_match_records_user_id_not_nil
  CHECK (user_id <> '00000000-0000-0000-0000-000000000000'::uuid);

-- recommendations：必须是 jsonb 数组（而不是对象 / 标量）。数组内的条目形状
-- （groupId / score / reason / advice 四字段白名单）仍由 adapter 的严格条目契约判定
ALTER TABLE ai_match_records
  DROP CONSTRAINT IF EXISTS ai_match_records_recommendations_is_array;
ALTER TABLE ai_match_records
  ADD CONSTRAINT ai_match_records_recommendations_is_array
  CHECK (jsonb_typeof(recommendations) = 'array');

-- recommendations：条数上界与共享契约 MATCHING_MAX_RECOMMENDATIONS（3）一致
ALTER TABLE ai_match_records
  DROP CONSTRAINT IF EXISTS ai_match_records_recommendations_max_items;
ALTER TABLE ai_match_records
  ADD CONSTRAINT ai_match_records_recommendations_max_items
  CHECK (jsonb_array_length(recommendations) <= 3);

COMMENT ON CONSTRAINT ai_match_records_id_not_nil ON ai_match_records IS
  '主键非空 UUID：空 UUID 不是可用资源标识（adapter 在进入 SQL 之前已拒绝，这里做存储层兜底）。';
COMMENT ON CONSTRAINT ai_match_records_user_id_not_nil ON ai_match_records IS
  '归属非空 UUID：归属由服务端会话主体写入；空 UUID 会让归属谓词永远不命中，等价于一条无主却占主键的行。';
COMMENT ON CONSTRAINT ai_match_records_recommendations_is_array ON ai_match_records IS
  '推荐结果必须是 jsonb 数组；条目内的字段白名单由 adapter 的严格条目契约承担。';
COMMENT ON CONSTRAINT ai_match_records_recommendations_max_items ON ai_match_records IS
  '推荐条数上界 3：与 packages/shared 的 MATCHING_MAX_RECOMMENDATIONS 一致。';

COMMIT;

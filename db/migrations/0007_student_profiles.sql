-- migration: 0007_student_profiles
-- description: 建立学生画像表 student_profiles（画像切片的最小持久化载体：一人一行，user_id 即主键与归属）
-- reversible: 是（DROP TABLE IF EXISTS student_profiles）
-- owner: P5 画像切片持久化（PostgreSQL 画像仓储切片 · 最小表）

BEGIN;

-- 字段清单与 services/api/src/modules/profiles/student-profile.postgres-repository.ts 的
-- POSTGRES_STUDENT_PROFILE_COLUMNS 一一对应；列名/类型与 docs/P1-字段级数据字典.md 的
-- student_profiles 一致。刻意不预判后续切片：
--   * profile_submitted_at / profile_locked_at 属于「首次提交后锁定」切片，本表不建；
--   * 软删除、审计列由各自切片引入（adapter 用显式列清单，不写 SELECT *，因此后续加列不会
--     自动流进领域对象，也不会让本 adapter 读到未登记的列）。
CREATE TABLE IF NOT EXISTS student_profiles (
  user_id                uuid          PRIMARY KEY,
  name                   varchar(50)   NOT NULL,
  student_no             varchar(32)   NOT NULL,
  college                varchar(100)  NOT NULL,
  major                  varchar(100)  NOT NULL,
  grade                  varchar(16)   NOT NULL,
  phone                  varchar(20)   NOT NULL,
  skills                 text[]        NOT NULL,
  programming_level      varchar(16)   NOT NULL,
  research_experience    varchar(2000),
  competition_experience varchar(2000),
  available_time         jsonb         NOT NULL,
  research_interests     text[]        NOT NULL,
  strengths              varchar(1000),
  intended_fields        text[]        NOT NULL,
  privacy_consent        jsonb         NOT NULL,
  created_at             timestamptz   NOT NULL DEFAULT now(),
  updated_at             timestamptz   NOT NULL DEFAULT now(),
  CONSTRAINT student_profiles_name_length
    CHECK (char_length(name) BETWEEN 1 AND 50),
  CONSTRAINT student_profiles_student_no_shape
    CHECK (char_length(student_no) BETWEEN 4 AND 32 AND student_no ~ '^[A-Za-z0-9-]+$'),
  CONSTRAINT student_profiles_college_length
    CHECK (char_length(college) BETWEEN 1 AND 100),
  CONSTRAINT student_profiles_major_length
    CHECK (char_length(major) BETWEEN 1 AND 100),
  CONSTRAINT student_profiles_grade_check
    CHECK (grade IN ('freshman', 'sophomore', 'junior', 'senior', 'graduate', 'other')),
  CONSTRAINT student_profiles_phone_length
    CHECK (char_length(phone) BETWEEN 6 AND 20),
  CONSTRAINT student_profiles_programming_level_check
    CHECK (programming_level IN ('none', 'basic', 'intermediate', 'advanced')),
  CONSTRAINT student_profiles_research_experience_length
    CHECK (research_experience IS NULL OR char_length(research_experience) <= 2000),
  CONSTRAINT student_profiles_competition_experience_length
    CHECK (competition_experience IS NULL OR char_length(competition_experience) <= 2000),
  CONSTRAINT student_profiles_strengths_length
    CHECK (strengths IS NULL OR char_length(strengths) <= 1000),
  -- 标签数组（skills / research_interests / intended_fields）：数量与 packages/shared 的
  -- tagListSchema(1, 20) 一致，且不允许 NULL 元素与空串元素（应用层写入前已按同一组规则
  -- 去重、去空）。逐元素长度上界（50）由 adapter 的 trimmedText 承担：CHECK 不允许子查询，
  -- 因此这里不写「逐元素 char_length」这种需要 unnest 的规则。
  CONSTRAINT student_profiles_skills_shape
    CHECK (
      cardinality(skills) BETWEEN 1 AND 20
      AND cardinality(skills) = cardinality(array_remove(skills, NULL))
      AND array_position(skills, '') IS NULL
    ),
  CONSTRAINT student_profiles_research_interests_shape
    CHECK (
      cardinality(research_interests) BETWEEN 1 AND 20
      AND cardinality(research_interests) = cardinality(array_remove(research_interests, NULL))
      AND array_position(research_interests, '') IS NULL
    ),
  CONSTRAINT student_profiles_intended_fields_shape
    CHECK (
      cardinality(intended_fields) BETWEEN 1 AND 20
      AND cardinality(intended_fields) = cardinality(array_remove(intended_fields, NULL))
      AND array_position(intended_fields, '') IS NULL
    ),
  -- 空余时间：jsonb 对象，且**只有** weeklyHours / periods / note 三个键（adapter 的严格
  -- jsonb 契约会拒绝未登记键，这里把同一条规则下沉到存储层）；weeklyHours 为 0–80 的整数，
  -- periods 为 1–3 项的闭集数组。
  -- 注意：整数范围用**文本正则**判定（`0`–`80` 的规范写法），因此不需要 `::int` 转换 ——
  -- CHECK 里的一次非法转换会抛错而不是判 false，那会把「形状不合规」变成一句难定位的异常。
  CONSTRAINT student_profiles_available_time_shape
    CHECK (
      jsonb_typeof(available_time) = 'object'
      AND available_time - 'weeklyHours' - 'periods' - 'note' = '{}'::jsonb
      AND jsonb_typeof(available_time -> 'weeklyHours') = 'number'
      AND (available_time ->> 'weeklyHours') ~ '^(?:0|[1-9]|[1-7][0-9]|80)$'
      AND jsonb_typeof(available_time -> 'periods') = 'array'
      AND jsonb_array_length(available_time -> 'periods') BETWEEN 1 AND 3
      AND (available_time -> 'periods') <@ '["weekday_day", "weekday_night", "weekend"]'::jsonb
      AND (
        NOT (available_time ? 'note')
        OR (
          jsonb_typeof(available_time -> 'note') = 'string'
          AND char_length(available_time ->> 'note') <= 200
        )
      )
    ),
  -- 隐私同意快照：只保存服务端处理记录（政策版本 + 同意时间），**不含**输入门禁字段 agreed；
  -- 同意时间以字符串保存，因此这里只约束对象/键/长度与「必须是字符串」，时间格式由应用层
  -- 读取契约（z.string().datetime()）判定。
  CONSTRAINT student_profiles_privacy_consent_shape
    CHECK (
      jsonb_typeof(privacy_consent) = 'object'
      AND privacy_consent - 'policyVersion' - 'consentedAt' = '{}'::jsonb
      AND jsonb_typeof(privacy_consent -> 'policyVersion') = 'string'
      AND char_length(privacy_consent ->> 'policyVersion') BETWEEN 1 AND 40
      AND jsonb_typeof(privacy_consent -> 'consentedAt') = 'string'
    )
);

COMMENT ON TABLE student_profiles IS
  '学生画像：user_id 既是归属也是主键（一人一行）；字段与敏感级别以 docs/P1-字段级数据字典.md 为准，user_id / student_no / phone / privacy_consent 不进入对外视图。';
COMMENT ON COLUMN student_profiles.user_id IS
  '归属主体：由服务端会话主体写入，永不来自请求体；adapter 要求规范小写 UUID 并复核归属回流，外键在 users 表建立后补（见下方延后说明）。';
COMMENT ON COLUMN student_profiles.student_no IS
  '学号（高敏感，只写不读）：形状与 packages/shared 的 studentNoSchema 一致；字段字典要求的「加密存储 + 摘要唯一索引」尚未落地，属后续切片（见 adapter 的 PII 落地形态说明）。';
COMMENT ON COLUMN student_profiles.phone IS
  '联系方式（高敏感，只写不读）：长度与 packages/shared 的 phoneSchema 一致；字段字典要求的「默认掩码展示」由对外视图承担（toStudentProfileView 不投影本列）。';
COMMENT ON COLUMN student_profiles.grade IS
  '年级：与 packages/shared 的 GRADE_VALUES 一致（freshman/sophomore/junior/senior/graduate/other）。';
COMMENT ON COLUMN student_profiles.programming_level IS
  '编程能力等级：与 packages/shared 的 PROGRAMMING_LEVEL_VALUES 一致（none/basic/intermediate/advanced）。';
COMMENT ON COLUMN student_profiles.available_time IS
  '空余时间（jsonb）：weeklyHours / periods / note 三个键，形状与 packages/shared 的 availableTimeSchema 一致。';
COMMENT ON COLUMN student_profiles.privacy_consent IS
  '隐私同意快照（jsonb）：policyVersion + consentedAt 两项服务端处理记录，只写不读；输入的 agreed 门禁字段不是状态，落库即脏数据。';

-- 约束口径：只把「适配器契约已经蕴含」的规则下沉到存储层（枚举闭集、长度上界、数组与 jsonb
-- 的形状/键集）。适配器写入前已按同一组 zod 规则校验，因此这些 CHECK 不会拒绝任何合法写入，
-- 只用于拦住绕过应用层的写坏数据。刻意**不**在 SQL 里重复实现应用层语义：
-- 手机号正则、内容安全（疑似证件号/密钥）、时间戳格式、标签去重都由 adapter 与读取契约判定。

-- 外键延后：users 表尚未建立（docs/P1-字段级数据字典.md / docs/P2-数据约束与迁移设计.md）。
-- 建立 users 的迁移落地后，用新的迁移补：
--   ALTER TABLE student_profiles
--     ADD CONSTRAINT fk_student_profiles_user
--     FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE RESTRICT;

-- 索引：取数走主键（user_id），本人自服务只有「按主体取一行」这一条路径，因此不额外建索引。
-- 学号摘要唯一索引随「PII 落地形态」切片一起补，避免现在为明文列建索引。

COMMIT;

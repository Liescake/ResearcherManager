import {
  AVAILABLE_PERIOD_LABELS,
  GRADE_LABELS,
  GRADE_VALUES,
  PROGRAMMING_LEVEL_LABELS,
  PROGRAMMING_LEVEL_VALUES,
  gradeLabel,
  programmingLevelLabel,
} from '@rm/shared';
import { useState, type FormEvent, type ReactNode } from 'react';
import { ENDPOINTS, endpointRef } from '../api/endpoints';
import { toUiError, type UiError } from '../api/errors';
import { DEMO_READ_ONLY_MESSAGE, type ProfilePatch } from '../api/gateway';
import type { StudentProfileView } from '../api/types';
import { useAuth } from '../auth/AuthContext';
import { AsyncStateView } from '../components/AsyncStateView';
import { ErrorPanel, NoticeBar } from '../components/StatePanel';
import { useLoader } from '../state/useLoader';
import { formatDateTime } from '../lib/format';

interface ProfileDraft {
  name: string;
  college: string;
  major: string;
  grade: string;
  programmingLevel: string;
  skills: string;
  researchInterests: string;
  intendedFields: string;
  strengths: string;
}

function toDraft(profile: StudentProfileView): ProfileDraft {
  return {
    name: profile.name,
    college: profile.college,
    major: profile.major,
    grade: profile.grade,
    programmingLevel: profile.programmingLevel,
    skills: profile.skills.join('、'),
    researchInterests: profile.researchInterests.join('、'),
    intendedFields: profile.intendedFields.join('、'),
    strengths: profile.strengths ?? '',
  };
}

/** 兼容中英文逗号、顿号与换行：使用者怎么分隔都行，提交前统一成数组 */
function splitTags(value: string): string[] {
  return value
    .split(/[,，、\n]/u)
    .map((item) => item.trim())
    .filter((item) => item !== '');
}

/**
 * 由「草稿 vs 原始画像」构造 PATCH 体：**只提交真正变化过的字段**。
 * 这不是为省流量，而是为了不把界面上的展示值（例如用「、」拼接的数组）当作全量覆盖提交——
 * 未改动字段不提交，服务端校验与审计记录里也就不会出现无意义的变更。
 */
export function buildProfilePatch(
  draft: ProfileDraft,
  original: StudentProfileView,
): { patch: ProfilePatch; issues: string[] } {
  const patch: Record<string, unknown> = {};
  const issues: string[] = [];

  const textFields = ['name', 'college', 'major'] as const;
  for (const field of textFields) {
    const value = draft[field].trim();
    if (value === original[field]) continue;
    if (value === '') {
      issues.push(`${field === 'name' ? '姓名' : field === 'college' ? '学院' : '专业'}不能为空`);
      continue;
    }
    patch[field] = value;
  }

  if (draft.grade !== original.grade) patch['grade'] = draft.grade;
  if (draft.programmingLevel !== original.programmingLevel) {
    patch['programmingLevel'] = draft.programmingLevel;
  }

  const listFields = [
    { field: 'skills', label: '擅长技能' },
    { field: 'researchInterests', label: '兴趣研究方向' },
    { field: 'intendedFields', label: '意向科研领域' },
  ] as const;
  for (const { field, label } of listFields) {
    const value = splitTags(draft[field]);
    // 只改变分隔符（、↔,）不算内容变更，不提交
    if (value.join('、') === original[field].join('、')) {
      continue;
    }
    if (value.length === 0) {
      issues.push(`${label}至少填写一项`);
      continue;
    }
    patch[field] = value;
  }

  const strengths = draft.strengths.trim();
  if (strengths !== (original.strengths ?? '')) {
    if (strengths === '') {
      // 清空可选字段：服务端 schema 为可选，提交空串会被判非法，因此显式拒绝并提示
      issues.push('个人特长与优势若要清空，请等待后端提供显式清空语义（当前不支持提交空串）');
    } else {
      patch['strengths'] = strengths;
    }
  }

  return { patch: patch as ProfilePatch, issues };
}

export function ProfilePage(): ReactNode {
  const { gateway } = useAuth();
  const profile = useLoader(() => gateway.loadProfile(), [gateway], {
    endpoint: endpointRef(ENDPOINTS.profileRead),
  });
  const [saved, setSaved] = useState<string | null>(null);

  const isDemo = gateway.mode === 'demo';

  return (
    <div className="page">
      <header className="page__header">
        <div>
          <h1>个人资料</h1>
          <p className="muted">
            <code>{endpointRef(ENDPOINTS.profileRead)}</code> 读取；变更经
            <code>{endpointRef(ENDPOINTS.profileUpdate)}</code>{' '}
            提交，成功后以服务端返回结果重新加载。
          </p>
        </div>
      </header>

      {saved !== null && <NoticeBar text={saved} onDismiss={() => setSaved(null)} />}

      <AsyncStateView
        state={profile.state}
        descriptor={ENDPOINTS.profileRead}
        label="本人画像"
        notFound="empty"
        emptyTitle="尚未提交画像"
        emptyDescription="服务端返回 404 表示本人画像尚不存在（不是错误）。契约基线的首次提交写作 PUT /me/profile，后端尚未实现，因此本页不提供「首次提交」。"
        onRetry={profile.reload}
      >
        {(data) => (
          <>
            <section className="card" aria-labelledby="profile-read-title">
              <h2 id="profile-read-title">当前画像（服务端返回）</h2>
              <dl className="kv">
                <dt>姓名</dt>
                <dd>{data.name}</dd>
                <dt>学院 / 专业</dt>
                <dd>
                  {data.college} / {data.major}
                </dd>
                <dt>年级</dt>
                <dd>{gradeLabel(data.grade)}</dd>
                <dt>编程能力</dt>
                <dd>{programmingLevelLabel(data.programmingLevel)}</dd>
                <dt>擅长技能</dt>
                <dd>{data.skills.join('、')}</dd>
                <dt>兴趣研究方向</dt>
                <dd>{data.researchInterests.join('、')}</dd>
                <dt>意向科研领域</dt>
                <dd>{data.intendedFields.join('、')}</dd>
                <dt>每周可投入</dt>
                <dd>{data.availableTime.weeklyHours} 小时</dd>
                <dt>空余时段</dt>
                <dd>
                  {data.availableTime.periods
                    .map((period) => AVAILABLE_PERIOD_LABELS[period])
                    .join('、')}
                </dd>
                <dt>科研经历</dt>
                <dd>{data.researchExperience ?? '—'}</dd>
                <dt>竞赛经历</dt>
                <dd>{data.competitionExperience ?? '—'}</dd>
                <dt>个人特长</dt>
                <dd>{data.strengths ?? '—'}</dd>
                <dt>更新时间</dt>
                <dd>{formatDateTime(data.updatedAt)}</dd>
              </dl>
              <p className="muted">
                服务端按契约**不返回**学号与联系方式（高敏感字段只写不读），因此这里没有「未填写」的
                假象——它们不在响应里，而不是为空。
              </p>
            </section>

            <section className="card" aria-labelledby="profile-edit-title">
              <h2 id="profile-edit-title">更新画像（未锁定字段）</h2>
              {isDemo ? (
                <p className="state state--pending">
                  {DEMO_READ_ONLY_MESSAGE}
                  <br />
                  演示模式不提供编辑表单，避免「改完看起来保存成功」的错觉。
                </p>
              ) : (
                <ProfileForm
                  key={data.updatedAt}
                  profile={data}
                  onSubmit={async (patch) => {
                    const updated = await gateway.updateProfile(patch);
                    setSaved(
                      `已提交并由服务端确认：${updated.name}（更新时间 ${formatDateTime(updated.updatedAt)}）。界面将按服务端返回结果重新加载。`,
                    );
                    profile.reload();
                  }}
                />
              )}
            </section>
          </>
        )}
      </AsyncStateView>
    </div>
  );
}

interface ProfileFormProps {
  profile: StudentProfileView;
  onSubmit: (patch: ProfilePatch) => Promise<void>;
}

function ProfileForm({ profile, onSubmit }: ProfileFormProps): ReactNode {
  const [draft, setDraft] = useState<ProfileDraft>(() => toDraft(profile));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<UiError | null>(null);
  const [issues, setIssues] = useState<string[]>([]);
  const [info, setInfo] = useState<string | null>(null);

  const update = (field: keyof ProfileDraft) => (value: string) =>
    setDraft((current) => ({ ...current, [field]: value }));

  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    const { patch, issues: foundIssues } = buildProfilePatch(draft, profile);
    setIssues(foundIssues);
    setError(null);
    setInfo(null);
    if (foundIssues.length > 0) return;
    if (Object.keys(patch).length === 0) {
      setInfo('没有检测到变更，未提交任何请求。');
      return;
    }
    setSaving(true);
    try {
      await onSubmit(patch);
      // 不在这里把草稿「假装成已保存」：父组件会以 updatedAt 为 key 重建表单，
      // 新草稿来自服务端返回并经 GET 重新加载的画像。
    } catch (caught) {
      setError(toUiError(caught, endpointRef(ENDPOINTS.profileUpdate)));
    } finally {
      setSaving(false);
    }
  };

  return (
    <form className="form" onSubmit={(event) => void submit(event)}>
      <label htmlFor="profile-name">姓名</label>
      <input
        id="profile-name"
        value={draft.name}
        maxLength={50}
        onChange={(event) => update('name')(event.target.value)}
      />

      <label htmlFor="profile-college">学院</label>
      <input
        id="profile-college"
        value={draft.college}
        maxLength={100}
        onChange={(event) => update('college')(event.target.value)}
      />

      <label htmlFor="profile-major">专业</label>
      <input
        id="profile-major"
        value={draft.major}
        maxLength={100}
        onChange={(event) => update('major')(event.target.value)}
      />

      <label htmlFor="profile-grade">年级</label>
      <select
        id="profile-grade"
        value={draft.grade}
        onChange={(event) => update('grade')(event.target.value)}
      >
        {GRADE_VALUES.map((value) => (
          <option key={value} value={value}>
            {GRADE_LABELS[value]}
          </option>
        ))}
      </select>

      <label htmlFor="profile-level">编程能力</label>
      <select
        id="profile-level"
        value={draft.programmingLevel}
        onChange={(event) => update('programmingLevel')(event.target.value)}
      >
        {PROGRAMMING_LEVEL_VALUES.map((value) => (
          <option key={value} value={value}>
            {PROGRAMMING_LEVEL_LABELS[value]}
          </option>
        ))}
      </select>

      <label htmlFor="profile-skills">擅长技能（用「、」或逗号分隔）</label>
      <input
        id="profile-skills"
        value={draft.skills}
        onChange={(event) => update('skills')(event.target.value)}
      />

      <label htmlFor="profile-interests">兴趣研究方向</label>
      <input
        id="profile-interests"
        value={draft.researchInterests}
        onChange={(event) => update('researchInterests')(event.target.value)}
      />

      <label htmlFor="profile-fields">意向科研领域</label>
      <input
        id="profile-fields"
        value={draft.intendedFields}
        onChange={(event) => update('intendedFields')(event.target.value)}
      />

      <label htmlFor="profile-strengths">个人特长与优势</label>
      <textarea
        id="profile-strengths"
        rows={3}
        maxLength={1000}
        value={draft.strengths}
        onChange={(event) => update('strengths')(event.target.value)}
      />

      {issues.length > 0 && (
        <ul className="state state--error">
          {issues.map((issue) => (
            <li key={issue}>{issue}</li>
          ))}
        </ul>
      )}

      <button type="submit" disabled={saving}>
        {saving ? '正在提交…' : '提交变更'}
      </button>
      <p className="muted">
        只提交真正改动的字段；提交成功后以服务端返回的画像为准重新加载，不在本地假定保存结果。
      </p>
      {error !== null && <ErrorPanel error={error} />}
      {info !== null && <NoticeBar text={info} onDismiss={() => setInfo(null)} />}
    </form>
  );
}

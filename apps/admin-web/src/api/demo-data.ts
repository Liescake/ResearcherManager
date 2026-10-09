import {
  ApplicationKind,
  ApplicationStatus,
  AvailablePeriod,
  EducationStatus,
  Grade,
  ProgrammingLevel,
  ReviewStatus,
} from '@rm/shared';
import type {
  AdminApplicationListItem,
  DashboardMetric,
  StudentProfileView,
  SelfStatisticsView,
} from './types';
import type { Paginated } from '@rm/shared';

/**
 * 受控演示夹具（**合成数据，不含任何真实用户信息**）。
 *
 * 用途只有一个：后端审核切片与统计切片尚未落地时，让管理端 MVP 的结构、状态与交互可以被
 * 真实地走查与测试。它**不是**「假后端」：
 * - 演示会话没有会话票据，请求永远不会发往服务端（见 `gateway.ts` 的 `createDemoGateway`）；
 * - 所有展示演示数据的位置都有醒目的「演示数据」标注，不冒充真实持久化结果；
 * - 演示模式下所有写操作被明确拒绝，不返回任何「保存成功」。
 *
 * 夹具与共享契约的一致性由 `demo-data.spec.ts` 断言（枚举闭集、非负整数计数、时间戳形状），
 * 共享契约升级时测试会先失败，而不是让夹具悄悄漂移。
 */

/** 夹具版本：界面与排障用它区分「看到的是哪一版演示数据」 */
export const DEMO_FIXTURE_VERSION = 'admin-web-demo/2026-10-09';

export const DEMO_DATA_NOTICE =
  '演示数据：由前端受控夹具生成，未连接后端，不代表任何真实用户或持久化结果。';

const ADMITTED = { status: EducationStatus.Admitted, reviewStatus: ReviewStatus.Approved } as const;
const NOT_ADMITTED = {
  status: EducationStatus.NotAdmitted,
  reviewStatus: ReviewStatus.Approved,
} as const;
const PREPARING = {
  status: EducationStatus.Preparing,
  reviewStatus: ReviewStatus.Approved,
} as const;
const PENDING_REVIEW = {
  status: EducationStatus.Admitted,
  reviewStatus: ReviewStatus.Pending,
} as const;

/** 升学记录夹具：用于按共享 `computeAdmissionRate` 口径计算升学率（前端不自行推导公式） */
export const DEMO_EDUCATION_RECORDS = [
  ADMITTED,
  ADMITTED,
  NOT_ADMITTED,
  PREPARING,
  PENDING_REVIEW,
] as const;

export const DEMO_PROFILE: StudentProfileView = {
  name: '演示同学',
  college: '演示学院',
  major: '演示专业',
  grade: Grade.Junior,
  skills: ['TypeScript', '数据分析', '实验设计'],
  programmingLevel: ProgrammingLevel.Intermediate,
  researchExperience: '参与过一项校级科研训练项目，负责数据采集与结果复现。（演示文本）',
  competitionExperience: '校级竞赛二等奖（演示文本）。',
  availableTime: {
    weeklyHours: 10,
    periods: [AvailablePeriod.WeekdayNight, AvailablePeriod.Weekend],
    note: '考试周会减少投入（演示文本）',
  },
  researchInterests: ['机器学习', '边缘计算'],
  strengths: '工程实现与文档整理（演示文本）',
  intendedFields: ['人工智能', '计算机系统'],
  createdAt: '2026-09-01T02:00:00.000Z',
  updatedAt: '2026-10-01T02:00:00.000Z',
};

export const DEMO_SELF_STATISTICS: SelfStatisticsView = {
  educationRecords: 5,
  applications: 2,
  achievements: 3,
  matchingRequests: 1,
};

function demoApplication(
  index: number,
  overrides: Partial<AdminApplicationListItem> & Pick<AdminApplicationListItem, 'status' | 'kind'>,
): AdminApplicationListItem {
  const day = String((index % 27) + 1).padStart(2, '0');
  return {
    id: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
    groupId: `11111111-1111-4111-8111-${String(index).padStart(12, '0')}`,
    note: `演示申请备注 ${index}`,
    createdAt: `2026-10-${day}T01:00:00.000Z`,
    updatedAt: `2026-10-${day}T03:00:00.000Z`,
    applicantName: `演示申请人 ${index}`,
    groupName: `演示科研小组 ${(index % 3) + 1}`,
    reviewStatus: ReviewStatus.Pending,
    ...overrides,
  };
}

/** 管理端申请列表夹具：混合状态，用于验证过滤、分页与空态 */
export const DEMO_APPLICATIONS: readonly AdminApplicationListItem[] = [
  demoApplication(1, { kind: ApplicationKind.Join, status: ApplicationStatus.Pending }),
  demoApplication(2, { kind: ApplicationKind.Join, status: ApplicationStatus.Pending }),
  demoApplication(3, { kind: ApplicationKind.Leave, status: ApplicationStatus.Pending }),
  demoApplication(4, { kind: ApplicationKind.Join, status: ApplicationStatus.Approved }),
  demoApplication(5, { kind: ApplicationKind.Join, status: ApplicationStatus.Rejected }),
  demoApplication(6, { kind: ApplicationKind.Leave, status: ApplicationStatus.Withdrawn }),
  demoApplication(7, { kind: ApplicationKind.Join, status: ApplicationStatus.Completed }),
];

/** 管理端统计夹具：形状未确认，因此只以「标签 + 数值」白名单形式提供 */
export const DEMO_ADMIN_STATISTICS: Readonly<Record<string, readonly DashboardMetric[]>> = {
  flow: [
    { key: 'joined', label: '期间入组', value: 12 },
    { key: 'left', label: '期间退组', value: 3 },
    { key: 'activeMemberships', label: '在组人数', value: 48 },
  ],
  achievements: [
    { key: 'total', label: '成果总数', value: 27 },
    { key: 'pendingReview', label: '待审核', value: 6, hint: '与审核切片联动后由服务端给出' },
  ],
  education: [
    { key: 'admitted', label: '已录取', value: 2 },
    { key: 'notAdmitted', label: '未上岸', value: 1 },
    { key: 'preparing', label: '备考中', value: 1 },
  ],
};

export interface DemoApplicationQuery {
  page: number;
  pageSize: number;
  status?: ApplicationStatus;
  keyword?: string;
}

/**
 * 按与后端同样的分页语义切片（page 从 1 开始；totalPages 为 0 表示空集）。
 * 前后端分页语义一致很重要：演示模式下走查到的分页行为必须能直接迁移到真实接口。
 */
export function buildDemoApplicationPage(
  query: DemoApplicationQuery,
  items: readonly AdminApplicationListItem[] = DEMO_APPLICATIONS,
): Paginated<AdminApplicationListItem> {
  const page = Math.max(1, Math.trunc(query.page));
  const pageSize = Math.max(1, Math.trunc(query.pageSize));
  const keyword = (query.keyword ?? '').trim();

  const filtered = items.filter((item) => {
    if (query.status !== undefined && item.status !== query.status) return false;
    if (keyword === '') return true;
    const haystack = [item.applicantName, item.groupName, item.note, item.groupId]
      .filter((value): value is string => typeof value === 'string')
      .join(' ');
    return haystack.includes(keyword);
  });

  const start = (page - 1) * pageSize;
  const slice = filtered.slice(start, start + pageSize);
  return {
    items: slice.map((item) => ({ ...item })),
    page,
    pageSize,
    total: filtered.length,
    totalPages: filtered.length === 0 ? 0 : Math.ceil(filtered.length / pageSize),
  };
}

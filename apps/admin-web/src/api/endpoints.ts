import { API_PREFIX, PermissionPoint } from '@rm/shared';

/**
 * API 边界登记表（**唯一**的接口地址来源）。
 *
 * 设计目标：后端切片（审核、统计、登录）与本 MVP 并行推进时，前端只依赖这张表。
 * 后端契约稳定后，改动集中在：
 * 1. 本表的 `status`（pending → stable）与路径；
 * 2. `gateway.ts` 里的取数实现；
 * 页面组件不需要任何改动。
 *
 * `status` 语义（**只描述实现进度，不构成任何授权判断**）：
 * - `stable`：后端已实现并通过验证；前端按正常流程取数、空态与错误态如实展示；
 * - `pending`：契约基线已定义、后端切片**尚未实现**（或形状未稳定）。
 *   前端仍按真实边界发起请求，观测到 404/501/403 时显示「端点尚未实现」而不是伪装成空数据；
 *   演示模式下由受控夹具替代，并全程标注「演示数据」。
 */
export type EndpointStatus = 'stable' | 'pending';

/**
 * 边界标识（显式联合类型，而不是 `keyof typeof ENDPOINTS`）：
 * 后者会让 `EndpointDescriptor.id` 与 `ENDPOINTS` 互相引用，TypeScript 会判为循环类型。
 */
export type EndpointId =
  | 'health'
  | 'profileRead'
  | 'profileUpdate'
  | 'selfStatistics'
  | 'adminApplications'
  | 'adminApplicationReview'
  | 'adminStatisticsFlow'
  | 'adminStatisticsAchievements'
  | 'adminStatisticsEducation'
  | 'sessionLogin';

export interface EndpointDescriptor {
  readonly id: EndpointId;
  readonly method: 'GET' | 'POST' | 'PATCH' | 'PUT';
  /** 相对 API 前缀的路径；`{name}` 为路径参数占位符 */
  readonly path: string;
  readonly status: EndpointStatus;
  /** 契约基线声明的权限点（仅用于界面说明与联调排查，前端不据此放行任何内容） */
  readonly permissions: readonly string[];
  readonly summary: string;
  /** 未实现/未稳定时的说明：由哪个切片承担、为什么前端不能假装成功 */
  readonly note?: string;
}

export const ENDPOINTS = {
  health: {
    id: 'health',
    method: 'GET',
    path: '/health',
    status: 'stable',
    permissions: [],
    summary: '服务健康检查',
  },
  profileRead: {
    id: 'profileRead',
    method: 'GET',
    path: '/me/profile',
    status: 'stable',
    permissions: [PermissionPoint.ProfileSelfRead],
    summary: '读取本人画像',
  },
  profileUpdate: {
    id: 'profileUpdate',
    method: 'PATCH',
    path: '/me/profile',
    status: 'stable',
    permissions: [PermissionPoint.ProfileSelfUpdate],
    summary: '更新本人画像（未锁定部分）',
    note: '契约基线把「首次提交」写作 PUT /me/profile，后端尚未实现，因此界面不承诺首次提交成功。',
  },
  selfStatistics: {
    id: 'selfStatistics',
    method: 'GET',
    path: '/me/statistics',
    status: 'stable',
    permissions: [],
    summary: '本人记录条数（四个计数的白名单闭集）',
  },
  adminApplications: {
    id: 'adminApplications',
    method: 'GET',
    path: '/admin/applications',
    status: 'pending',
    permissions: [PermissionPoint.MembershipReviewGroup, PermissionPoint.MembershipReviewGlobal],
    summary: '管理端申请列表（分页、排序、按状态过滤）',
    note: '由并行的后端审核切片实现；响应条目中审核相关字段尚未稳定，前端在字段缺失时显示占位符。',
  },
  adminApplicationReview: {
    id: 'adminApplicationReview',
    method: 'POST',
    path: '/admin/applications/{applicationId}/review',
    status: 'pending',
    permissions: [PermissionPoint.MembershipReviewGroup, PermissionPoint.MembershipReviewGlobal],
    summary: '审核入组/退组申请',
    note: '契约要求提交 decision、reason（驳回必填）与资源版本；本 MVP 只预留入口，不伪造审核成功。',
  },
  adminStatisticsFlow: {
    id: 'adminStatisticsFlow',
    method: 'GET',
    path: '/admin/statistics/flow',
    status: 'pending',
    permissions: [PermissionPoint.StatisticsFlowRead],
    summary: '人员流动统计',
    note: '响应形状未确认：界面只展示「能否取到」与演示夹具指标，不假定任何字段名。',
  },
  adminStatisticsAchievements: {
    id: 'adminStatisticsAchievements',
    method: 'GET',
    path: '/admin/statistics/achievements',
    status: 'pending',
    permissions: [PermissionPoint.StatisticsAchievementRead],
    summary: '成果统计',
    note: '响应形状未确认：同上。',
  },
  adminStatisticsEducation: {
    id: 'adminStatisticsEducation',
    method: 'GET',
    path: '/admin/statistics/education',
    status: 'pending',
    permissions: [PermissionPoint.StatisticsEducationRead],
    summary: '升学统计',
    note: '响应形状未确认：升学率口径必须由服务端按共享 computeAdmissionRate 计算，前端不自行推导。',
  },
  sessionLogin: {
    id: 'sessionLogin',
    method: 'POST',
    path: '/auth/session/login',
    status: 'pending',
    permissions: [],
    summary: '管理端会话登录',
    note:
      '契约基线只定义了 POST /auth/wechat/login（小程序凭证换取）与 POST /auth/refresh；' +
      '管理端网页登录端点尚未定义。本 MVP 把它收敛为这一条可替换边界，' +
      '登录页当前改为「会话票据联调登录」——票据由服务端种子写入后，前端通过真实请求校验，' +
      '不做任何本地伪造。',
  },
} as const satisfies Record<EndpointId, EndpointDescriptor>;

export function getEndpoint(id: EndpointId): EndpointDescriptor {
  return ENDPOINTS[id];
}

/** 替换 `{name}` 路径参数；参数缺失或多余时直接抛错（fail fast，不发出半截路径的请求） */
export function endpointPath(
  descriptor: EndpointDescriptor,
  params: Readonly<Record<string, string>> = {},
): string {
  const used = new Set<string>();
  const path = descriptor.path.replace(/\{([A-Za-z0-9_]+)\}/gu, (_match, name: string) => {
    const value = params[name];
    if (value === undefined) {
      throw new Error(`缺少路径参数 ${name}（${descriptor.method} ${descriptor.path}）`);
    }
    used.add(name);
    const encoded = encodeURIComponent(value);
    // 编码后仍含 `/` 或为空的参数会让请求落到意料之外的资源上，一律拒绝
    if (encoded === '' || encoded.includes('/')) {
      throw new Error(`路径参数 ${name} 取值非法`);
    }
    return encoded;
  });

  const unused = Object.keys(params).filter((name) => !used.has(name));
  if (unused.length > 0) {
    throw new Error(`路径参数未被使用：${unused.join(', ')}`);
  }
  return path;
}

/** `GET /api/v1/admin/applications` —— 用于界面提示与排障，不用于拼接请求（请求走 client） */
export function endpointLabel(
  descriptor: EndpointDescriptor,
  params: Readonly<Record<string, string>> = {},
): string {
  return `${descriptor.method} ${API_PREFIX}${endpointPath(descriptor, params)}`;
}

/** `METHOD /path` —— `UiError.endpoint` 的展示形态（不含前缀，便于与日志比对） */
export function endpointRef(descriptor: EndpointDescriptor): string {
  return `${descriptor.method} ${descriptor.path}`;
}

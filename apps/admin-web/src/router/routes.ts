/**
 * 路由表（单一路由来源）。刻意**不引入 react-router**：
 * - 管理端 MVP 只需要「哈希路由 + 登录守卫」，一个约 100 行的实现即可覆盖并可直接单测；
 * - 仓库的依赖准入规则要求先完成许可证与安全评估（docs/P2-开源复用评估.md），
 *   在评估完成前优先复用已有依赖；
 * - 若后续确需嵌套路由/数据加载器，替换点只有本文件与 `hash-router.ts`，页面组件不感知。
 */
export const ROUTE_IDS = [
  'login',
  'overview',
  'applications',
  'reviews',
  'reviewDetail',
  'notifications',
  'exports',
  'profile',
  'notFound',
] as const;

export type RouteId = (typeof ROUTE_IDS)[number];

export interface RouteDefinition {
  readonly id: RouteId;
  /** 以 `/` 开头的路径；`*` 表示兜底 */
  readonly path: string;
  /** true 表示未登录时必须先去登录（登录后回到原路径） */
  readonly requiresAuth: boolean;
  readonly title: string;
  /** 是否出现在主导航 */
  readonly nav: boolean;
  readonly summary?: string;
}

export const ROUTES: Record<RouteId, RouteDefinition> = {
  login: {
    id: 'login',
    path: '/login',
    requiresAuth: false,
    title: '登录',
    nav: false,
    summary: '会话票据联调登录，或进入受控演示模式。',
  },
  overview: {
    id: 'overview',
    path: '/overview',
    requiresAuth: true,
    title: '统计概览',
    nav: true,
    summary: '本人记录概览（已实现）、管理端统计边界（待后端切片）与共享口径自检。',
  },
  notifications: {
    id: 'notifications',
    path: '/notifications',
    requiresAuth: true,
    title: '我的通知',
    nav: true,
    summary: '本人站内通知：服务端白名单字段展示与标记已读（无请求体、幂等、失败不伪造成功）。',
  },
  exports: {
    id: 'exports',
    path: '/exports',
    requiresAuth: true,
    title: '我的导出',
    nav: true,
    summary: '本人导出请求的状态与撤销（确认弹窗、幂等、防重复提交；不提供下载入口）。',
  },
  applications: {
    id: 'applications',
    path: '/applications',
    requiresAuth: true,
    title: '申请列表',
    nav: true,
    summary: '管理端申请列表（后端审核切片实现中）：分页、状态过滤与空态。',
  },
  reviews: {
    id: 'reviews',
    path: '/reviews',
    requiresAuth: true,
    title: '申请审核（预留）',
    nav: true,
    summary: '预留的审核列表路由：后端审核切片稳定前只展示边界与演示只读队列。',
  },
  reviewDetail: {
    id: 'reviewDetail',
    path: '/reviews/:applicationId',
    requiresAuth: true,
    title: '审核详情（预留）',
    nav: false,
    summary: '预留的审核详情路由：承载 decision/reason/资源版本，当前不提交任何审核。',
  },
  profile: {
    id: 'profile',
    path: '/profile',
    requiresAuth: true,
    title: '个人资料',
    nav: true,
    summary: '本人画像读取与未锁定字段更新。',
  },
  notFound: {
    id: 'notFound',
    path: '*',
    // 未登录且路径未知时也先去登录：无法确认路径是否存在，fail-closed
    requiresAuth: true,
    title: '页面不存在',
    nav: false,
  },
};

export const LOGIN_PATH = ROUTES.login.path;
export const HOME_PATH = ROUTES.overview.path;

/**
 * 主导航分组（信息架构的单一来源）：
 * - 工作台：进入系统后的第一屏；
 * - 申请管理：管理职责（列表 + 预留审核），后端切片未上线的部分在标题里就标注「预留」；
 * - 个人中心：一切「只关于本人」的数据（通知 / 导出 / 资料），归属只由服务端会话主体判定。
 *
 * 把「本人」与「管理」分开，是为了让使用者在导航层就能分清数据范围，
 * 而不是在同一页里混排本人记录与管理视图。
 */
export interface NavGroup {
  readonly id: 'workspace' | 'management' | 'personal';
  readonly title: string;
  readonly routes: readonly RouteDefinition[];
}

export const NAV_GROUPS: readonly NavGroup[] = [
  { id: 'workspace', title: '工作台', routes: [ROUTES.overview] },
  { id: 'management', title: '申请管理', routes: [ROUTES.applications, ROUTES.reviews] },
  {
    id: 'personal',
    title: '个人中心',
    routes: [ROUTES.notifications, ROUTES.exports, ROUTES.profile],
  },
];

/** 主导航顺序（扁平视图，与分组顺序一致） */
export const NAV_ROUTES: readonly RouteDefinition[] = NAV_GROUPS.flatMap((group) => group.routes);

/**
 * 导航高亮归属：不在导航里的子路由（审核详情）高亮其父入口，
 * 使用者因此始终知道自己「在哪一块」。
 */
export function navOwnerOf(routeId: RouteId): RouteId | null {
  if (routeId === 'reviewDetail') return 'reviews';
  return ROUTES[routeId].nav ? routeId : null;
}

/** 按注册顺序匹配（先具体、后兜底 `*`） */
export const ROUTE_MATCH_ORDER: readonly RouteDefinition[] = [
  ROUTES.login,
  ROUTES.reviewDetail,
  ROUTES.overview,
  ROUTES.applications,
  ROUTES.reviews,
  ROUTES.notifications,
  ROUTES.exports,
  ROUTES.profile,
  ROUTES.notFound,
];

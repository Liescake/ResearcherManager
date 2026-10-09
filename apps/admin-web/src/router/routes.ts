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

/** 主导航顺序：概览 → 申请列表 → 审核（预留）→ 个人资料 */
export const NAV_ROUTES: readonly RouteDefinition[] = [
  ROUTES.overview,
  ROUTES.applications,
  ROUTES.reviews,
  ROUTES.profile,
];

/** 按注册顺序匹配（先具体、后兜底 `*`） */
export const ROUTE_MATCH_ORDER: readonly RouteDefinition[] = [
  ROUTES.login,
  ROUTES.reviewDetail,
  ROUTES.overview,
  ROUTES.applications,
  ROUTES.reviews,
  ROUTES.profile,
  ROUTES.notFound,
];

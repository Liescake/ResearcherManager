# ============================================================================
# Researcher Manager API 镜像（NestJS monorepo；多阶段构建）
#
# 为什么本文件在仓库根而不是 services/api/：pnpm workspace 的依赖解析需要
# `pnpm-workspace.yaml` 与各包 manifest 同时可见，构建上下文必须是仓库根。
#
# 构建覆盖范围（与 `pnpm verify:docker` 的静态断言一致）：
# - `@rm/shared`、`@rm/ai-adapter`（`pnpm build:packages`）先构建，**再**构建 `@rm/api`。
#   顺序是硬要求：`services/api/tsconfig.build.json` 把 `paths` 清空，编译期 `@rm/*`
#   从 node_modules 解析，所以工作区依赖必须先有 `dist`。
# - 前端（`apps/admin-web`、`apps/miniapp`）**不**进这个镜像：API 镜像不该携带前端产物，
#   静态资源发布是独立切片。这不影响「monorepo 能从根构建」这一点。
#
# 运行镜像是**开发/联用**镜像，如实说明边界：
# - 本镜像**不包含**任何机密：数据库连接串、证书都通过运行时环境变量 / 只读挂载注入；
# - 运行阶段仍携带 devDependencies 与 TypeScript 源码（体积偏大）：最小化需要
#   `pnpm deploy --prod`，而它不支持本仓库 `.npmrc` 的 `node-linker=hoisted`，
#   属于后续发布切片；
# - 只要运行时解析出 `DATABASE_URL`，启动期持久化边界就要求「已 attest 的 SQL 执行器 +
#   认证依赖就绪」，缺任何一项都会在**任何数据库连接之前**拒绝启动（fail-closed）。
# ============================================================================

ARG NODE_VERSION=24-alpine

# ---------- 依赖安装 ----------
FROM node:${NODE_VERSION} AS deps
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    CI=true
RUN corepack enable
WORKDIR /app
# 只用仓库内声明的依赖与锁文件（--frozen-lockfile：锁文件与 manifest 不一致即失败）
COPY . .
# 使用挂载缓存加速重复构建；换机/无缓存时行为不变
RUN --mount=type=cache,id=rm-pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile

# ---------- 构建 ----------
FROM deps AS build
WORKDIR /app
RUN pnpm build:packages && pnpm --filter @rm/api build

# ---------- 运行 ----------
FROM node:${NODE_VERSION} AS runtime
ENV NODE_ENV=development \
    PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH
RUN corepack enable
WORKDIR /app
# 非 root 运行；node 镜像自带的 node 用户已存在
COPY --from=build --chown=node:node /app /app
USER node
EXPOSE 3000
# 健康检查复用 `scripts/docker-healthcheck.mjs`（与 docker-compose*.yml 同一份探针）：
# 路径跟随 API_PREFIX（不再硬编码 /api/v1/health —— 全局前缀是运行时配置），
# 只打存活探针，不触发任何数据库连接。
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["node", "scripts/docker-healthcheck.mjs"]
CMD ["node", "services/api/dist/main.js"]

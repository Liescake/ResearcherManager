# @rm/admin-web

管理端 Web（React 19 + Vite 8）。当前为**可替换的管理端 MVP**：登录、基础布局、统计概览、
申请列表、个人资料，以及**预留的申请审核路由**。

## 本轮范围

| 已实现                                                                        | 明确未实现（等后端切片）                                             |
| ----------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| 哈希路由 + 登录守卫（未登录访问受保护页面先跳登录，登录后回跳；防开放重定向） | 管理端登录端点（契约基线只有 `/auth/wechat/login`、`/auth/refresh`） |
| 会话票据联调登录（**真实请求校验**，不本地伪造成功）                          | 申请审核动作（`POST /admin/applications/{id}/review`）               |
| 受控演示模式（无票据、不发请求、全程标注、写操作被拒绝）                      | 管理端统计端点（`GET /admin/statistics/*`）                          |
| 统计概览：本人统计（真实）+ 管理端统计边界（逐来源 pending）+ 升学率口径      | 申请详情读取端点（契约基线未定义）                                   |
| 申请列表：服务端分页/过滤契约、演示夹具走查、状态机参考                       | 图表、导出、权限配置、审计页面                                       |
| 个人资料：读取 + 未锁定字段 PATCH 更新（以服务端返回为准重新加载）            | 首次提交（`PUT /me/profile`）、更正申请流程                          |
| loading / empty / error / 401 / 403 / pending 六种状态语义                    | jsdom 组件交互测试（用 `react-dom/server` 静态渲染替代）             |

**不伪造的原则**（贯穿实现）：

1. 后端未实现的端点，界面显示「端点尚未实现」而不是空数据或假数据；
2. 演示模式不连接后端、不写入任何数据，写操作抛 `DEMO_READ_ONLY`，界面全程标注演示数据；
3. 响应 `meta` 缺少 `total` 时显示「总数未提供」，绝不用当前页条数冒充总数；
4. 升学率只在服务端有数据时展示；前端不自行推导分子分母（演示夹具除外，且明确标注）；
5. 审核表单按钮保持禁用——宁可显示「还不能用」，也不制造「点了就成功」。

## 目录结构

```
src/
  api/         API 边界登记表（endpoints）、客户端（client）、错误模型（errors）、
               会话（session）、演示夹具（demo-data）、取数网关（gateway）、视图类型（types）
  auth/        会话与网关的 React 上下文（AuthContext）
  router/      路由表（routes）与哈希路由/登录守卫（hash-router，纯函数）
  state/       取数状态机（async，纯函数）与 useLoader Hook
  components/  基础布局（AppLayout）、状态面板（StatePanel）、状态分派（AsyncStateView）
  pages/       登录 / 统计概览 / 申请列表 / 审核（预留）/ 个人资料 / 404
  lib/         展示格式化（纯函数）
  __tests__/   组件静态渲染测试（react-dom/server，无 jsdom）
```

`api/endpoints.ts` 是**唯一**的接口地址来源：后端契约稳定后只需改它的 `status`/路径与
`api/gateway.ts` 的取数实现，页面组件无需改动。

## 路由

| 哈希路径                    | 页面             | 需要登录 |
| --------------------------- | ---------------- | -------- |
| `#/login`                   | 登录             | 否       |
| `#/overview`（根路径亦然）  | 统计概览         | 是       |
| `#/applications`            | 申请列表         | 是       |
| `#/reviews`                 | 审核列表（预留） | 是       |
| `#/reviews/{applicationId}` | 审核详情（预留） | 是       |
| `#/profile`                 | 个人资料         | 是       |
| 其它                        | 404              | 是       |

## 会话模式

| 模式   | 票据 | 是否发请求           | 数据来源     | 写操作       |
| ------ | ---- | -------------------- | ------------ | ------------ |
| 联调   | 有   | 是                   | 后端         | 允许（真实） |
| 演示   | 无   | **否**（结构上不可） | 前端受控夹具 | 一律拒绝     |
| 未登录 | 无   | 仅登录校验探测       | —            | —            |

票据只保存在 `sessionStorage`（关闭标签页即失效），只经 `Authorization: Bearer` 发送，
形状受白名单 `[A-Za-z0-9._:-]{8,128}` 约束（结构上排除头注入），不写入 URL、不写日志。
任何请求收到 **401** 都会清空会话并回到登录页（跳转由路由守卫完成）；**403** 只影响当前页面，
由页面渲染「无权限」面板，不触发登出。

## 命令

```bash
pnpm --filter @rm/admin-web dev        # http://127.0.0.1:5173
pnpm --filter @rm/admin-web typecheck
pnpm --filter @rm/admin-web test       # 见下方沙箱注意事项
pnpm --filter @rm/admin-web build      # 产出 dist/
pnpm --filter @rm/admin-web preview
```

先启动 API 才能在联调模式下看到真实数据：

```bash
pnpm dev:api     # 终端 A（默认 http://127.0.0.1:3000）
pnpm dev:admin   # 终端 B
```

### 受限沙箱下的验证命令

DSH 受限沙箱（workspace-write）中，Node 的管道 stdio spawn 会 `EPERM`，需要：

1. `vitest` 默认 forks 池不可用，加 `--pool=threads`：

   ```bash
   pnpm --filter @rm/admin-web test -- --pool=threads
   ```

2. `vite`/`vitest` 加载配置时执行的 `net use` 探测会 `EPERM`，用一个 preload 把该探测
   改为回调报错（vite 对 error 的处理就是放弃优化，行为等价），preload 放系统临时目录、不入库：

   ```powershell
   $env:NODE_OPTIONS="--require=$env:TEMP\dsh-vite-netuse-preload.cjs"
   ```

   权限充足的环境（CI、本地完整权限）不需要以上两项。

## 配置

- `vite.config.ts` 的 `envDir` 指向仓库根目录，因此**只需维护根目录 `.env`**：

  ```bash
  VITE_API_BASE_URL=http://127.0.0.1:3000/api/v1
  ```

- 未配置时回落到同源 `/api/v1`（适合通过反向代理部署的场景）。
- `VITE_` 前缀变量会被打进前端产物，**禁止放入任何密钥**。

## 依赖

| 依赖                 | 版本            | 许可证           | 用途                        |
| -------------------- | --------------- | ---------------- | --------------------------- |
| react / react-dom    | ^19.3.0         | MIT              | UI 与静态渲染测试           |
| vite                 | ^8.3.3          | MIT              | 构建与开发服务器            |
| @vitejs/plugin-react | ^6.1.2          | MIT              | React 编译（Vite 8 主版本） |
| typescript / vitest  | ^5.9.3 / ^5.0.3 | Apache-2.0 / MIT | 类型检查与单测              |

> 未引入 Ant Design / React Admin 等大型模板，也未引入 react-router：
> 按 `docs/P2-开源复用评估.md`，组件库与路由库需先完成许可证与安全评估；
> 本 MVP 的哈希路由只有约 150 行且是可单测的纯函数，替换点集中在 `router/`。

## 临时视觉层

`src/app.css` 是**临时的、非最终视觉设计**（无组件库、无主题系统）。状态语义与结构化组件已定型，
替换视觉设计只需重写该文件。

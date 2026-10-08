# P3 RuoYi 迁移与 POC 计划

> 版本：0.1；状态：候选方案与迁移门禁；本文件不等于采用 RuoYi 或生产就绪。

## 1. 决策摘要

后端候选切换为 RuoYi-Vue 体系，优先评估其 Spring Boot 后端与前后端分离模式。具体仓库版本/tag、许可证结论、依赖快照和安全基线尚未锁定，完成评估并由架构审查通过后才能选定。RuoYi 仅作为后台平台和基础权限能力候选，不替代本项目的资源级授权、隐私、审计和业务状态规则。

迁移期间保留：

- `apps/admin-web/`：继续使用 React/Vite，作为管理端过渡和契约验证客户端；
- `apps/miniapp/`：继续保留本地占位小程序源码，不宣称可发布；
- `packages/ai-adapter/`：继续作为独立 AI 契约、脱敏、校验和降级适配层；
- `services/api/`：当前 NestJS 骨架保留，不删除、不覆盖，作为回滚基线和接口对照实现。

RuoYi 后端必须放在独立目录 `services/ruoyi-api/`，不得嵌入或覆盖 `services/api/`，避免迁移过程中破坏现有 NestJS 基线。

## 2. 候选锁定前提

在引入任何 RuoYi 代码前，必须记录：

1. 官方仓库 URL、具体 tag/commit 和获取时间；
2. 主项目及传递依赖的许可证，确认商业/学校内部使用、修改和再分发义务；
3. `LICENSE`、NOTICE、第三方版权声明和需要随交付物保留的文本；
4. SBOM、依赖漏洞扫描、构建可复现性和升级策略；
5. PostgreSQL 驱动、SQL、分页、时间类型、UUID、事务和字符集兼容性；
6. RuoYi 原有认证、菜单 RBAC、数据权限与本项目资源级授权的差异及适配方案。

未完成上述记录，不得把 RuoYi 依赖加入正式构建，也不得宣称迁移完成。

## 3. POC 范围

POC 只验证后端候选是否可迁移和可回滚，不实现完整业务。必须提供可运行的本地接口与测试数据，至少包括：

- mock login：本地测试身份，不接入真实微信凭据；
- 角色读取和最小角色授权；
- `SELF`：资源主体必须与当前用户一致；
- `GROUP`：资源所属小组必须属于服务端已验证的负责人小组集合；
- `ASSIGNED`：资源必须属于服务端计算的授权资源集合；
- groups 查询：服务端过滤范围，不信任客户端 groupId；
- join application：入组申请、幂等键、基本状态和权限校验；
- PostgreSQL：迁移、连接、事务、UUID、时间和必要约束验证；
- AI adapter 健康检查：验证 `packages/ai-adapter/` 的契约、脱敏、超时/降级适配可被后端调用或健康探测；
- 与现有 OpenAPI/错误信封/审计边界的映射记录。

POC 验收必须包含越权用例：学生访问他人 SELF 资源、负责人访问非所属 GROUP、管理员访问未分配 ASSIGNED、客户端伪造 scope/groupId，以及重复提交 join application。

## 4. 权限与安全边界

RuoYi 菜单权限、按钮权限和角色 RBAC 只能作为后台操作入口能力，不能被当作资源权限。所有业务 Controller/Service 仍必须执行服务端资源级策略：角色、原子权限、scope、资源 owner、已验证 groupIds/assignedResourceIds、审计和字段脱敏。

禁止信任客户端传入的角色、scope、groupId、资源 owner 或授权集合。RuoYi 的数据权限配置必须映射到本项目 `SELF/GROUP/ASSIGNED/SYSTEM/GLOBAL`，并由独立策略测试证明；若只能实现菜单级控制，POC 失败。

## 5. 迁移阶段与回滚点

### 阶段 P3.1：候选锁定与隔离骨架

- 锁定 RuoYi-Vue tag/commit、JDK、Spring Boot、数据库驱动和许可证资料；
- 创建 `services/ruoyi-api/` 独立工程；
- 不修改、不删除 NestJS `services/api/`；
- 建立独立构建、测试、配置和本地启动说明。

**回滚点 R0：** 删除/停用 `services/ruoyi-api/` 即可恢复原 NestJS 基线；不得让 RuoYi 依赖污染现有 workspace 或数据库迁移。

### 阶段 P3.2：POC 垂直切片

按 mock login → 角色/scope → groups 查询 → join application → PostgreSQL → AI adapter 健康顺序逐步实现，每个切片都要有单元测试、接口测试、越权测试和审计/错误证据。

**回滚点 R1：** 每个切片以独立小版本/tag/提交点记录；某切片失败时回退到上一个通过门禁的版本，不跨越已验证回滚点。

### 阶段 P3.3：双栈对照与迁移决策

将 RuoYi POC 与 NestJS 基线按 API、状态机、权限、数据约束、性能和安全结果对照。只有 POC 全部通过且审查批准，才允许制定业务模块迁移顺序；否则继续使用 NestJS 基线或放弃候选。

**回滚点 R2：** 在任何业务迁移前保留 NestJS、数据库迁移和 API 契约的可运行版本；迁移失败不得删除原实现。

## 6. 模块化版本门禁

每个独立模块的小版本完成后才能上传版本控制，模块必须同时满足：

- 代码、迁移、配置、OpenAPI/DTO 和测试作为一个可回退单元；
- lint、格式检查、类型/编译、单元测试、接口测试和越权测试通过；
- PostgreSQL 集成验证通过，或明确标记未覆盖并阻止晋级；
- 依赖许可证、NOTICE、SBOM 和漏洞扫描记录已更新；
- 迁移可前进、可回滚或有明确不可逆说明；
- 变更说明、已知风险、回滚点和版本号已记录；
- GPT6sol 代码审查和 GLM5.3 f 最终审查通过后，才允许上传该小版本。

“上传版本控制”不等于自动生产发布；禁止在门禁缺失时提交或推送。

## 7. 交付物与未决项

首个 POC 小版本应至少包含：候选版本锁定记录、许可证/NOTICE、SBOM 与漏洞报告、`services/ruoyi-api/`、PostgreSQL 验证、POC OpenAPI、权限越权测试、回滚说明和与 NestJS 的对照报告。

以下事项在本计划批准前保持未决：RuoYi 具体 tag/license、是否采用 RuoYi-Vue 而非其他变体、数据库迁移工具、认证实现、生产部署方式和真实微信登录。当前不修改四个本地需求/计划文件，不提交、不推送。

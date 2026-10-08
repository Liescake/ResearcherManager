# RuoYi 后端 POC 隔离骨架

> 状态：POC 占位；未引入 RuoYi 源码、Java 依赖或业务迁移，暂不声明可构建、可运行或生产就绪。

## 目的

本目录是 ResearcherManager 后端迁移的隔离边界。它不复制未经完整合规核验的 RuoYi 源码，也不覆盖现有 `services/api`。待候选版本完成 LICENSE/NOTICE、依赖许可证、SBOM、漏洞、PostgreSQL 和默认安全配置核验后，才允许在此目录内建立 Spring Boot 3 POC。

## 当前环境门禁

- 目标运行时：JDK 17+
- 构建工具：Maven 3.9+
- 目标数据库：PostgreSQL（必须先完成方言和迁移验证）
- 当前工作区已知限制：本机核验时为 Java 8，未安装 Maven；因此当前目录不包含 `pom.xml`，也不声明可构建。该限制可用 `toolchain/check-gate.mjs` 随时复核（见下节）。
- RuoYi 候选源码位于仓库外审计目录，不属于本目录和本仓库。

## POC 范围（后续实现）

按垂直切片逐步实现，并在每个小版本单独验证；模块小版本完成后按版本门禁上传：

1. 本地 mock login，不接入真实微信凭据。
2. 用户/角色最小读取。
3. groups 查询：服务端过滤，不信任客户端 `groupId`。
4. join application：幂等键、状态机、版本控制和审计边界。
5. 资源级范围：
   - `SELF`：服务端解析的 `resourceUserId` 必须等于当前主体。
   - `GROUP`：资源小组必须属于服务端解析的负责人小组集合。
   - `ASSIGNED`：资源必须属于服务端计算的授权资源集合。
   - `SYSTEM/GLOBAL`：仅按服务端角色、授权上限和审计规则放行。
6. AI adapter 健康调用：通过受控接口保留脱敏、schema、超时和降级边界。
7. PostgreSQL 集成、迁移前进/回滚和契约测试。

RuoYi 的菜单、按钮和角色 RBAC 只能作为粗粒度入口，不能替代上述业务资源谓词。所有角色、scope、groupId、owner 和授权集合必须由服务端会话或数据库解析，不能信任客户端字段。

## 契约静态校验

`contracts/` 下的公开契约自带零依赖校验器（只用 Node 内置模块，不联网、不写文件）：

```bash
node services/ruoyi-api/contracts/validate.mjs
```

校验范围与判定语义见 `contracts/README.md` §7：结构校验 + 授权场景重放 + 全量 `$ref` 解析。

## 工具链门禁与来源证据检查

`toolchain/` 下的公开检查器（只用 Node 内置模块，不联网、不下载依赖、不写仓库）在创建 `pom.xml` 或 Java 源码之前核验本机工具链、候选 commit 元数据占位与准入前置：

```bash
node services/ruoyi-api/toolchain/check-gate.mjs
```

判定语义与探测方式见 `toolchain/README.md`：退出码 0 通过；1 违规（门禁前出现 `pom.xml`、Java 源码或 RuoYi 源码副本，或占位/状态与事实不符）；2 未准入（本机 JDK/Maven 未达标或准入前置未满足）。只有在清单把 `stage` 提升为 `admitted`（要求候选 commit 已冻结、全部准入前置带证据满足、合规产物就位）之后，本目录才允许出现 Maven 工程与 Java 源码；本机当前为 Java 8 且未安装 Maven，因此该检查按设计返回未准入。

同一目录下的来源与合规证据清单（`provenance-manifest.json` + `check-provenance.mjs`）回答另一个问题：候选 commit/tag、许可证/NOTICE、SBOM、漏洞与 PostgreSQL 兼容性证据是否已真正核验。非 `pending` 的证据必须给出与证据文件实际字节一致的 SHA-256 摘要、必需内容标记，`verified` 还必须给出核验时间与署名，并与 `gate-manifest.json` 的候选固定值交叉核验：

```bash
# 默认检查：当前五项证据全部 pending、compliance 目录尚未创建 → 未就绪（退出码 2）
node services/ruoyi-api/toolchain/check-provenance.mjs

# 判定规则自检（合成输入，不读磁盘）；机器可读输出用 --json，信息性运行用 --report
node services/ruoyi-api/toolchain/check-provenance.mjs --self-test
```

`poc-ready` 阶段要求五项证据全部 `verified` 且证据文件存在、摘要与内容标记匹配，候选已冻结且门禁已 `admitted`；任何「先写 verified 再补文件」或「先把阶段改到 poc-ready」都会被判违规（退出码 1），而不是未就绪。语义与状态阶梯见 `toolchain/README.md` §4。

## 保留的现有边界

- `services/api`：NestJS 回滚基线，保持不变。
- `apps/admin-web`：React/Vite 管理端过渡客户端。
- `apps/miniapp`：本地小程序占位源码，首期不宣称可发布。
- `packages/ai-adapter`：独立 AI 契约、脱敏、校验和降级适配层。

## 版本门禁与回滚策略

- 小版本：每个 POC 垂直切片使用独立小版本/提交点；完成实现后必须通过模块测试、格式/编译检查、契约与安全负向用例，并由 GPT6sol 按需检查变更范围与关键安全边界后上传。
- 大版本：涉及跨模块迁移、数据库/认证/权限模型或生产切换时，除上述门禁外追加 GLM5.3 f 独立安全终审。
- R0：本目录仅为文档占位；删除或停用 `services/ruoyi-api` 不影响现有系统。
- R1：任一切片失败时回退到上一个通过门禁的提交点。
- R2：在任何业务迁移前保留 NestJS、原数据库迁移和 API 契约的可运行版本；未完成双跑、数据校验和回滚演练前不得删除旧实现。

## 下一步准入

创建 `pom.xml` 和 Java 源码前，必须完成：

- 固定实际 Spring Boot 3 候选 commit，并核对其 POM 与 JDK 要求。
- 把 `toolchain/provenance-manifest.json` 的五项证据逐项推进到 `verified`（证据文件存在、摘要与内容标记匹配、带核验时间与署名），再把 `stage` 提升为 `poc-ready`。
- 本地保留 LICENSE/NOTICE/第三方许可清单。
- 生成依赖树、SBOM、漏洞扫描和许可证扫描报告。
- 在隔离 PostgreSQL 实例中验证 DDL、分页、时间、事务、索引和迁移回滚。
- 完成 GPT6sol 架构/安全审查和 GLM5.3 f 终审。

本目录当前是隔离 POC 入口，不代表 RuoYi 已采用或迁移已完成。

# RuoYi 后端 POC 隔离骨架

> 状态：POC 占位；未引入 RuoYi 源码、Java 依赖或业务迁移，暂不声明可构建、可运行或生产就绪。

## 目的

本目录是 ResearcherManager 后端迁移的隔离边界。它不复制未经完整合规核验的 RuoYi 源码，也不覆盖现有 `services/api`。待候选版本完成 LICENSE/NOTICE、依赖许可证、SBOM、漏洞、PostgreSQL 和默认安全配置核验后，才允许在此目录内建立 Spring Boot 3 POC。

## 当前环境门禁

- 目标运行时：JDK 17+
- 构建工具：Maven 3.9+
- 目标数据库：PostgreSQL（必须先完成方言和迁移验证）
- 本机工具链实测（2026-10-08，可复现，详见 `toolchain/README.md` §5.2）：JDK 17.0.12 与 Maven 3.9.16 在**显式探测路径**下达标——JDK 用 `--java-home` 指向 `C:\Program Files\Java\jdk-17`，Maven 用 `--maven-home` 指向仓库外系统临时目录中的解压结果（压缩包 `apache-maven-3.9.16-bin.zip` 只读、不入库，解压只在仓库外）。不带显式参数时，PATH 上的 `java` 仍是 1.8.0_501 且系统未安装 Maven，因此默认运行按设计返回未准入。
- 工具链就绪**不等于**准入：准入前置当前只有 2/10 满足，候选 commit 未冻结，五项合规产物全部 `pending`，`stage` 仍为 `pre-poc-gate`。因此当前目录不包含 `pom.xml`，也不声明可构建。可用 `toolchain/check-gate.mjs` 随时复核（见下节）。
- 证据生成能力（2026-10-08 实测）：SBOM、漏洞扫描与 PostgreSQL 兼容性三项**当前都无法在本机产出真实证据**——门禁未 `admitted` 且 `pom.xml` 不存在、PATH 上没有 SBOM 工具与漏洞扫描器、本机未安装 PostgreSQL 且容器运行时守护进程不可达。能力探测与可复现步骤见 `toolchain/check-capability.mjs` 与 `toolchain/README.md` §11；能力评估不是证据，五项来源/合规证据仍全部 `pending`。
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
# 默认探测（当前环境：PATH 上的 java 为 1.8，无系统 Maven → 未准入，退出码 2）
node services/ruoyi-api/toolchain/check-gate.mjs

# 可复现探测：显式指定 JDK 与本地 Maven（优先于环境变量与 PATH）
node services/ruoyi-api/toolchain/check-gate.mjs \
  --java-home "C:\Program Files\Java\jdk-17" \
  --maven-home "<仓库外临时目录>/apache-maven-3.9.16"
```

判定语义与探测方式见 `toolchain/README.md`：退出码 0 通过；1 违规（门禁前出现 `pom.xml`、Java 源码或 RuoYi 源码副本，或占位/状态与事实不符）；2 未准入（本机 JDK/Maven 未达标或无法复现清单声明的达标状态、准入前置未满足、合规产物未就位）。**退出码 0 要求准入前置全部满足且合规产物全部就位**，因此本机即使显式探测到 JDK 17 与 Maven 3.9.16，当前仍按设计返回未准入（退出码 2）。只有在清单把 `stage` 提升为 `admitted`（要求候选 commit 已冻结、全部准入前置带证据满足、合规产物就位）之后，本目录才允许出现 Maven 工程与 Java 源码。

同一目录下的来源与合规证据清单（`provenance-manifest.json` + `check-provenance.mjs`）回答另一个问题：候选 commit/tag、许可证/NOTICE、SBOM、漏洞与 PostgreSQL 兼容性证据是否已真正核验。非 `pending` 的证据必须给出与证据文件实际字节一致的 SHA-256 摘要、必需内容标记，`verified` 还必须给出核验时间与署名，并与 `gate-manifest.json` 的候选固定值交叉核验：

```bash
# 默认检查：当前五项证据全部 pending、compliance 目录尚未创建 → 未就绪（退出码 2）
node services/ruoyi-api/toolchain/check-provenance.mjs

# 判定规则自检（合成输入，不读磁盘）；机器可读输出用 --json，信息性运行用 --report
node services/ruoyi-api/toolchain/check-provenance.mjs --self-test
```

同一目录下的能力探测器（`check-capability.mjs`）回答第三个问题：本机是否具备产出 SBOM、漏洞扫描与 PostgreSQL 兼容性证据的前置。它只做只读探测（不联网、不下依赖、不写仓库、不生成任何证据），被阻断时打印可复现的下一步：

```bash
# 默认探测：当前三项能力全部被阻断（退出码 2）
node services/ruoyi-api/toolchain/check-capability.mjs

# 显式工具链探测（build-toolchain 前置达标），以及判定规则自检
node services/ruoyi-api/toolchain/check-capability.mjs \
  --java-home "C:\Program Files\Java\jdk-17" \
  --maven-home "<仓库外临时目录>/apache-maven-3.9.16"
node services/ruoyi-api/toolchain/check-capability.mjs --self-test
```

能力口径、本机实测与复现方式见 `toolchain/README.md` §11。

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

创建 `pom.xml` 和 Java 源码前，必须按 `toolchain/gate-manifest.json` 的 `candidate.admissionSteps` 逐项完成（步骤与前置的机器约束、每步的验收证据见 `toolchain/README.md` §3.3–§3.4）：

1. **复现工具链**：用显式 `--java-home` / `--maven-home` 复现 JDK 17+ 与 Maven 3.9+ 探测（已完成，见「当前环境门禁」）。
2. **固定候选**：固定实际 Spring Boot 3 候选 commit（40 位 SHA）并同时固定 tag，核对其 POM 与 JDK 要求。**当前状态：部分完成**——`springboot3` 分支头 `a51a838b71b446ea27256900efe7ed2faa2a02fd` 与其 POM（spring-boot 3.5.16 / JDK 17）已核验，但第二轮复核确认 Gitee 与 GitHub 两侧各 27 个 tag（`v1.0`…`v3.9.2`）**无一指向该提交，连其父提交 `9e3fb55f…` 也没有**，故候选保持未冻结（核验记录与复现步骤见 `toolchain/candidate-metadata.json` 与 `toolchain/README.md` §10）。
3. **许可证与 NOTICE**：保留候选原始 LICENSE/NOTICE 原文与哈希证据。**当前状态：公开元数据已核验，证据仍未就位（保持 `pending`）**——候选 commit `a51a838b…` 的 LICENSE 位于根目录 `LICENSE`（网页 `https://github.com/yangzongzhuan/RuoYi-Vue/blob/a51a838b71b446ea27256900efe7ed2faa2a02fd/LICENSE`；blob `8564f294c7781cbbbdb22ae5927a96f859db0054`、size 1071、字节 SHA-256 `7296da00…`），许可证类型 MIT；全树 477 个条目（334 blob）中**不存在 `NOTICE`/`COPYING`/`COPYRIGHT`**，Gitee 主仓库与 GitHub 镜像的全树逐条目比对一致（单侧独有 0、sha 不一致 0）。第三轮只用公开 API 即可复现上述摘要（不克隆、不落盘，命令见 `toolchain/candidate-metadata.json` 的 `reproduce` 第 6–8 步）；原文副本与再分发说明仍未登记，`provenance` 证据 `license-notice` 保持 `pending`，理由与解除条件见 `toolchain/README.md` §10.2–§10.3。 另：公开摘要里的「上游不存在 NOTICE」（`absent-upstream`）与「本项不适用」（`not-applicable`）只是观测标签，**不等于**合规产物 `services/ruoyi-api/compliance/NOTICE` 已 `verified`；`gate-manifest.json` 的 `notice` 项因此保持 `pending`，真正的再分发证据仍为 `pending`，不会靠伪造文件推进（见 `toolchain/README.md` §3.5、§10.3）。
4. **依赖清单与 SBOM**：在隔离目录生成依赖树、传递依赖许可证清单与 SBOM（记录工具、版本、生成时间）。
5. **漏洞扫描**：完成依赖漏洞扫描并逐项记录处置结论（含扫描工具与规则版本）。
6. **PostgreSQL 验证**：在隔离 PostgreSQL 实例中验证 DDL、分页、时间、事务、索引和迁移回滚。
7. **独立审查**：完成架构/安全独立审查与终审并保留放行结论（实施方不自证）。
8. **门禁提升**：全部前置 `satisfied` 且合规产物就位后，才把 `stage` 提升为 `admitted`；同时把五项来源/合规证据推进到 `verified`（证据文件存在、摘要与内容标记匹配、带核验时间与署名），再把 `provenance-manifest.json` 的 `stage` 提升为 `poc-ready`。

第 2 步部分完成（commit 与 POM/JDK 已第二轮核验，对应 tag 无法确认 → 候选未冻结，见 `toolchain/candidate-metadata.json`）；第 3 步的公开元数据与摘要已核验，第三轮进一步把复现方式收敛为**只用公开 API**（LICENSE 字节在内存中摘要、全树 NOTICE 存在性与两主机树一致性均可公开复现），但原文副本与再分发说明未登记，证据仍为 `pending`（见 `toolchain/README.md` §10.2–§10.3）；第 4–7 步尚未开始，且 2026-10-08 的能力探测确认 SBOM、漏洞扫描与 PostgreSQL 三项证据当前均无法在本机产出（缺前置工具，见 `toolchain/README.md` §11）。许可证/NOTICE、SBOM、漏洞与 PostgreSQL 证据一律保持 `pending`，不预填、不推测，工具不可用时只记录公开的待办与可复现步骤。

本目录当前是隔离 POC 入口，不代表 RuoYi 已采用或迁移已完成。

# ruoyi-api 工具链与准入门禁（公开检查器）

> 状态：POC 准入前置切片。本目录只有**清单与只读检查器**，不含 Java 源码、`pom.xml`、Maven 依赖或任何 RuoYi 文件副本，也不声明可构建、可运行或生产就绪。

## 1. 本目录内容

| 文件                       | 用途                                                                                                | 静态校验                                                                    |
| -------------------------- | --------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `README.md`                | 门禁语义、探测方式与运行方式说明                                                                    | 人工评审（本文件不参与自动校验）                                            |
| `check-gate.mjs`           | 公开只读检查器（仅用 Node 内置模块，不联网、不下载、不写仓库）                                      | 自身即检查入口，见 §6；`--self-test` 内置 32 项自检                         |
| `gate-manifest.json`       | 工具链最低要求、禁止项、候选 commit 占位、准入前置与合规产物清单                                    | 结构、占位语义与磁盘一致性校验（§3）                                        |
| `check-provenance.mjs`     | 来源与合规证据清单检查器（仅用 Node 内置模块，不联网、不下载、不写仓库；内置纯 JavaScript SHA-256） | 自身即检查入口，见 §6；`--self-test` 内置 48 项判定场景 + 3 项 SHA-256 向量 |
| `provenance-manifest.json` | 候选来源与合规证据清单（候选 commit/tag、许可证/NOTICE、SBOM、漏洞、PostgreSQL 兼容性）             | 结构、状态与磁盘事实、摘要、内容标记、与门禁交叉核验（§4）                  |

## 2. 门禁语义

检查器把三类问题分开判定，避免「还没到条件」与「已经违反规则」被混为一谈：

| 判定     | 含义                                                                                     | 退出码 |
| -------- | ---------------------------------------------------------------------------------------- | -----: |
| 通过     | 边界无违规、清单合法、工具链达标且准入前置满足                                           |      0 |
| 违规     | 门禁前出现 Maven 工程/Java 源码/RuoYi 源码副本；或清单非法（占位被伪造、状态与事实不符） |      1 |
| 未准入   | 尚未满足条件：JDK/Maven 未达标、准入前置未满足、合规产物未就位                           |      2 |
| 用法错误 | 传入了未知参数                                                                           |     64 |

**单一闸门：** 只有在清单把 `stage` 从 `pre-poc-gate` 提升为 `admitted` 之后，本目录才允许出现 `pom.xml` 与 Java 源码；而 `admitted` 又被强制要求：候选 commit 已冻结（`resolved = true`）、全部准入前置 `satisfied` 且各带证据、合规产物全部就位、工具链达标。因此在门禁前创建 `pom.xml` 或 Java 源码必然被判为**违规**（退出码 1），而不是「未准入」。

`--report` 用于信息性运行（始终以退出码 0 结束，便于在未准入的机器上采集报告）；CI 与提交前门禁应使用默认模式。

本节描述 `check-gate.mjs` 的判定语义；候选来源与合规证据由另一条互补闸门 `check-provenance.mjs` 判定（§4），两者都不联网、都不写仓库。

## 3. 工具链门禁检查项（`check-gate.mjs`）

### 3.1 边界（`boundary`）

在 `services/ruoyi-api` 内递归扫描（跳过 `node_modules`、`target`、`.git`、`dist` 等），逐项比对清单声明的禁止模式：构建文件（`pom.xml`、`mvnw`、Gradle 文件等）、源码与构建产物扩展名（`.java`、`.kt`、`.jar`、`.war`、`.class` 等）、禁止目录（`src/main/java`、`src/test/java`、`.mvn`）、RuoYi 源码副本路径段（`ruoyi-admin`、`ruoyi-common`、`ruoyi-framework` 等）。清单中的禁止项数组不得为空，否则判为清单非法——门禁不能靠清空清单来失效。

`frozenPaths`（`services/api`、`db/migrations`）是评审时的人工核对项：检查器本身只读，绝不写入这些路径，也不修改任何既有文件。

### 3.2 候选 commit 元数据占位（`candidate`）

占位必须**显式**且不可伪造：

- `pinned.commit` 只允许 `null`（未冻结占位）或 40 位小写十六进制 SHA；短 SHA、分支名、`latest`/`head`/`main`/`master`/`tbd` 等占位词一律判违规；
- `pinned.resolved` 必须严格等于 `commit !== null`；
- 固定 commit 时必须同时固定 `tag`；
- `unresolvedReasons` 必须精确等于当前**未满足**的准入前置 id 集合（不允许漏写，也不允许留下已解决的原因）；
- 前置 `candidate-commit` 与本字段双向绑定：该前置标记 `satisfied` 时 `resolved` 必须为 `true`，反之固定候选前必须先满足该前置。

### 3.3 准入前置（`admissionPrerequisites`）

必需 id 固定为十项（`toolchain-jdk`、`toolchain-maven`、`candidate-commit`、`license-notice`、`dependency-licenses`、`sbom`、`vulnerability-scan`、`postgresql-compatibility`、`security-review`、`final-review`），缺项即判清单非法；每项状态只能是 `pending`/`satisfied`，标记 `satisfied` 必须提供非空 `evidence`。

其中两项与本机实测**双向**校验：本机 JDK 已达标却仍写 `pending`，或未达标却写 `satisfied`，都判为清单状态漂移（退出码 1）。这样「声明」与「证据」不能各写一半。

### 3.4 合规产物（`complianceArtifacts`）

每一项声明仓库内相对路径与状态 `pending`/`present`/`verified`，且必须与磁盘一致：标记 `pending` 却已存在、或标记 `present`/`verified` 却不存在，都判违规。路径不得为绝对路径，也不得包含 `..`。

### 3.5 源码自审（公开材料的机器约束）

对 `services/ruoyi-api` 下的公开代码与说明文件同时检查：

1. **只用 Node 内置模块**：代码文件中的导入说明符必须命中 `boundary.allowedImportSpecifiers` 白名单（全部为 `node:` 前缀），第三方包或裸导入一律违规；
2. **不联网**：`node:http`、`node:https`、`node:net`、`node:dgram`、`node:tls`、`node:dns` 明确禁止；
3. **不引用内部文档**：公开材料不得出现清单 `boundary.forbiddenTextMarkers` 声明的内部文档路径前缀（内部文档只保留在本地，且不是本目录的运行期依赖）；
4. **只允许同目录相对导入**：`./x.mjs` 允许，`../` 越出本模块一律违规。

## 4. 来源与合规证据检查（`check-provenance.mjs`）

`provenance-manifest.json` 与 `check-provenance.mjs` 回答另一个问题：**真实 RuoYi POC 之前，候选来源与合规证据是否已经被实际核验**。两条闸门互补：§3 的门禁管「现在是否允许在 `services/ruoyi-api` 内建立 Maven/Java 工程」，本检查管「候选 commit/tag、许可证/NOTICE、SBOM、漏洞、PostgreSQL 兼容性证据是否已达到 `verified` 且证据文件真实存在」。

### 4.1 必需证据与状态阶梯

必需证据 id 固定为五项，缺少任一项即判清单非法（不得删项使门禁失效）：`candidate-commit-tag`（候选 commit/tag）、`license-notice`（许可证/NOTICE）、`sbom`、`vulnerability-scan`（漏洞）、`postgresql-compatibility`（PostgreSQL 兼容性）。每项状态只能取：

| 状态       | 含义                                   | 检查器要求                                                         |
| ---------- | -------------------------------------- | ------------------------------------------------------------------ |
| `pending`  | 尚未收集，**当前清单五项全部为此状态** | 证据文件不得存在（存在即判「状态与证据不一致」）                   |
| `present`  | 证据文件已就位，但尚未完成核验         | 文件必须存在、摘要匹配、内容标记齐备，并记录 `method`              |
| `verified` | 已完成核验，可用于真实 POC 准入        | 在 `present` 要求之外，追加 `collectedAt` 与 `verifiedBy` 核验署名 |

只有 `verified` 计入 POC 准入；`present` 合法但不充分。

### 4.2 不得伪造证据（机器约束）

1. **状态与磁盘一致**：标记 `pending` 却已存在证据文件、或标记 `present`/`verified` 却不存在，都判违规；
2. **摘要必须匹配**：非 `pending` 的证据必须给出 `fileSha256`（64 位小写十六进制），检查器用内置纯 JavaScript SHA-256 重算证据文件的实际摘要并逐字节比对；全 0、全 f 一类的占位摘要直接判违规；
3. **内容标记齐备**：清单声明的 `requiredMarkers` 必须全部出现在证据文件里，空文件或缺标记的文件不能充当证据；
4. **核验署名**：标记 `verified` 必须给出 `collectedAt`（ISO 日期/时间戳）与非占位的 `verifiedBy`；`method` 也不得使用 `tbd`/`placeholder` 一类占位词；
5. **路径受限**：证据路径必须是 `services/ruoyi-api/` 内的仓库相对路径，不得为绝对路径、不得含 `..`，且不同证据项不得共用同一文件。

### 4.3 与准入门禁交叉核验

检查器在同目录读取 `gate-manifest.json`，并要求两者一致才能放行：

- 候选固定值（`tag`/`commit`/`resolved`）必须与门禁清单完全相同——两个公开清单不允许各说一套；
- 证据 `candidate-commit-tag` 标记 `verified` 时，`candidate.resolved` 必须为 `true`；反之固定了候选却拿不出已核验的来源证据也判违规；
- `stage=poc-ready` 还要求门禁已 `admitted`，且其合规产物没有 `pending` 项；
- 门禁清单缺失或不可解析时按 fail-closed 判违规，不允许在无法交叉核验的情况下推进 POC。

### 4.4 阶段闸门

`stage` 只有 `pre-poc` 与 `poc-ready` 两个取值：

- `pre-poc`（当前值）：证据未 `verified` 属**未就绪**（退出码 2），逐项列出缺口；检查器**不会**自动提升阶段；
- `poc-ready`：要求五项证据全部 `verified` 且文件存在、摘要与标记匹配，候选已冻结，门禁已 `admitted`；任一不满足即判**违规**（退出码 1）。

因此「先在清单里写 verified、事后补文件」与「先把 stage 改成 poc-ready」都会被直接判违规，而不是被当成未就绪。

### 4.5 判定与退出码

| 判定     | 含义                                                                                   | 退出码 |
| -------- | -------------------------------------------------------------------------------------- | -----: |
| 通过     | 五项证据全部 `verified`、文件存在且摘要/标记匹配，候选已冻结，门禁已 `admitted`        |      0 |
| 违规     | 清单结构非法、状态漂移、摘要或标记不匹配、`poc-ready` 未达标、与门禁不一致、门禁不可读 |      1 |
| 未就绪   | 结构合法且未发现伪造，但证据仍未 `verified`、候选未冻结或门禁未 `admitted`             |      2 |
| 用法错误 | 传入了未知参数                                                                         |     64 |

## 5. 本机工具链探测方式

JDK 与 Maven 的候选按 `JAVA_HOME/bin`、`MAVEN_HOME`/`M2_HOME/bin`、`PATH` 顺序解析（Windows 兼容 `java.exe`、`mvn.cmd`），逐个按三级方式取版本：

1. **管道捕获**：`spawnSync` 读取子进程输出（普通终端与 CI 的常规路径）；
2. **临时文件句柄回退**：受限沙箱会以 `EPERM` 阻止管道捕获子进程输出。此时把子进程输出重定向到系统临时目录中的一个文件句柄，读完立即删除；该文件在仓库之外，内容由子进程写入，本模块自身不写入任何文件内容；
3. **静态版本文件回退**：直接读取 JDK 安装目录的 `release` 文件（`JAVA_VERSION`）或 Maven 的 `lib/maven-core-<version>.jar` 文件名。

保证：只执行 `java -version` / `mvn -v` 这类纯查询参数，**绝不**执行任何构建目标；不联网、不安装、不下载依赖；探测不确定时按 fail-closed 视为未达标。

## 6. 运行方式

```bash
# 6.1 主门禁（任意工作目录可执行；失败时退出码 1/2，按 §2 判定）
node services/ruoyi-api/toolchain/check-gate.mjs
cd services/ruoyi-api/toolchain && node check-gate.mjs

# 6.2 机器可读输出（JSON：summary、violations、blockers、exitCode）
node services/ruoyi-api/toolchain/check-gate.mjs --json

# 6.3 信息性运行：始终退出码 0，便于在未准入机器上采集报告
node services/ruoyi-api/toolchain/check-gate.mjs --report

# 6.4 判定规则自检：32 项合成场景，不读磁盘、不执行探测
node services/ruoyi-api/toolchain/check-gate.mjs --self-test

# 6.5 来源与合规证据清单（真实 POC 前；当前为未就绪，退出码 2，按 §4 判定）
node services/ruoyi-api/toolchain/check-provenance.mjs
cd services/ruoyi-api/toolchain && node check-provenance.mjs

# 6.6 机器可读输出（JSON：summary、violations、blockers、exitCode）
node services/ruoyi-api/toolchain/check-provenance.mjs --json

# 6.7 信息性运行：始终退出码 0，便于在证据未齐备时采集报告
node services/ruoyi-api/toolchain/check-provenance.mjs --report

# 6.8 判定规则自检：48 项合成场景 + 3 项 SHA-256 向量，不读磁盘、不写文件
node services/ruoyi-api/toolchain/check-provenance.mjs --self-test
```

`--self-test` 覆盖的合成场景包括：准入前置齐备时通过；门禁前出现 `pom.xml`/Java 源码/RuoYi 源码副本/`src/main/java`；候选 commit 为短 SHA 或分支名；`resolved` 与 `commit` 不一致；固定 commit 未固定 tag；未固定原因与未满足前置不一致；`stage=admitted` 仍有未满足前置；合规产物状态与磁盘不一致；JDK 8 与 Maven 3.8.8 不达标、Maven/JDK 未安装；清单版本非 semver；工具链要求被下调；禁止项清单被清空；清单缺失；以及导入白名单/网络模块/内部文档引用/相对导入四类源码策略。

来源与合规证据检查器的 `--self-test` 覆盖：SHA-256 的 NIST 向量（空串 / `abc` / 448 位两分组）；五项证据齐备且门禁 admitted 时通过；`pending` 却已有文件、`present`/`verified` 却无文件；摘要不匹配、摘要格式非法、占位摘要；文件为空或不可读；缺少内容标记；`verified` 缺少 `collectedAt`/`verifiedBy`，或 `verifiedBy`、`method` 使用占位词；缺少必需证据项、未登记 id、id 重复、路径为绝对路径/含 `..`/越出边界/两项共用同一文件；状态与阶段取值非法、`manifestVersion` 非 semver、`contract` 不匹配、`purpose`/`nonGoals` 被清空、`pocGate` 强制开关被关闭；候选短 SHA/分支名、`resolved` 与 `commit` 不一致、固定 commit 未固定 tag、与 `gate-manifest.json` 候选值不一致；候选未冻结但来源证据已 `verified`、候选已冻结但来源证据未 `verified`；`poc-ready` 时证据仍 pending、门禁未 admitted、门禁合规产物仍 pending；门禁清单不可读/contract 不匹配/缺少 `candidate.pinned`；以及 `present` 合法但不足以准入。

本机当前状态（核验记录）：`java -version` 为 `1.8.0_501`，未安装 Maven，因此主门禁**按设计**返回「未准入」（退出码 2），阻断项为「JDK 版本不达标」「Maven 未找到」；此时本目录不含 `pom.xml`，也没有 Java 源码。来源与合规证据清单的五项证据**全部为 `pending`**，`services/ruoyi-api/compliance/` 目录尚未创建，因此证据检查器**按设计**返回「未就绪」（退出码 2）；清单不预填、不推测任何证据。

内置 SHA-256 实现另做过一次性交叉核对：0–200 字节全部长度与 1.5 MB 输入的结果都与 Node 内置 `crypto` 一致（核对脚本在仓库外临时运行，不进入本目录；本模块自身仍只导入白名单内的 `node:` 内置模块，不导入 `node:crypto`，也不调用外部命令）。

## 7. 与既有校验器的关系

| 检查器                           | 范围                                                                  | 输出              |
| -------------------------------- | --------------------------------------------------------------------- | ----------------- |
| `contracts/validate.mjs`         | 公开契约：夹具结构、授权场景重放、OpenAPI 字段与 `$ref`、枚举交叉核对 | 失败退出 1        |
| `toolchain/check-gate.mjs`       | 准入门禁：工具链可用性、候选 commit 占位、禁止项与合规产物状态        | 1 违规 / 2 未准入 |
| `toolchain/check-provenance.mjs` | 来源证据：候选来源/许可证/SBOM/漏洞/PostgreSQL 证据的状态、摘要与标记 | 1 违规 / 2 未就绪 |

三者互补且都只用 Node 内置模块、都不联网、都不写仓库；契约校验回答「契约是否自洽」，门禁回答「现在是否允许开始写 Java」，证据检查回答「候选来源与合规证据是否真的已经核验」。证据检查器还会交叉核验 `gate-manifest.json`，两个公开清单不允许各说一套。

## 8. 边界与非目标

- 本目录不保存 RuoYi 源码、候选 POM 副本、依赖锁定文件或构建产物；候选观测值、哈希与许可证原文保存在本地内部审计记录中，不进入公开目录。
- 不声明可构建、可运行或生产就绪；不替代人工架构/安全评审与许可证复核。
- 不做网络检索，不把网页结果当作合规证据；不修改、不覆盖 `services/api`（NestJS 回滚基线）与既有数据迁移。
- 证据清单只记录「证据文件的位置、摘要与结论」，不代替数据库/扫描工具本身；`--self-test` 使用合成输入，不代表本机实测结论；结论只以默认模式（或 `--json`）的输出为准。

## 9. 版本规则

- 清单 `manifestVersion` 为 semver；非破坏性新增递增次版本，字段语义或闸门收紧属破坏性变更，需提升主/次版本并在本文件记录兼容性说明。
- 禁止下调 `toolchain` 的最低要求（JDK 17+ / Maven 3.9+）或关闭边界开关：检查器会直接判为清单非法。
- `provenance-manifest.json` 同样受此规则约束：必需证据 id、`pocGate` 强制开关与「非 pending 必须给出真实摘要」的语义不得弱化；证据状态只能由实际核验结果推进，不能为了过检查器而预先写成 `verified`。

# ruoyi-api 工具链与准入门禁（公开检查器）

> 状态：POC 准入前置切片。本目录只有**清单与只读检查器**，不含 Java 源码、`pom.xml`、Maven 依赖或任何 RuoYi 文件副本，也不声明可构建、可运行或生产就绪。

## 1. 本目录内容

| 文件                       | 用途                                                                                                                 | 静态校验                                                                                                        |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `README.md`                | 门禁语义、探测方式与运行方式说明                                                                                     | 人工评审（本文件不参与自动校验）                                                                                |
| `check-gate.mjs`           | 公开只读检查器（仅用 Node 内置模块，不联网、不下载、不写仓库；支持显式 `--java-home` / `--maven-home` 可复现探测）   | 自身即检查入口，见 §6；`--self-test` 内置 54 项自检                                                             |
| `gate-manifest.json`       | 工具链最低要求与可复现探测配方、禁止项、候选 commit 占位、候选准入步骤、准入前置与合规产物清单                       | 结构、占位语义、探测配方与磁盘一致性校验（§3）                                                                  |
| `check-provenance.mjs`     | 来源与合规证据清单检查器（仅用 Node 内置模块，不联网、不下载、不写仓库；内置纯 JavaScript SHA-256）                  | 自身即检查入口，见 §6；`--self-test` 内置 48 项判定场景 + 3 项 SHA-256 向量                                     |
| `provenance-manifest.json` | 候选来源与合规证据清单（候选 commit/tag、许可证/NOTICE、SBOM、漏洞、PostgreSQL 兼容性）                              | 结构、状态与磁盘事实、摘要、内容标记、与门禁交叉核验（§4）                                                      |
| `check-capability.mjs`     | 证据生成能力探测（SBOM / 漏洞扫描 / PostgreSQL）＋外部审计前置核验（`--audit-root`）：只读探测与核验，不生成任何证据 | 自身即检查入口，见 §11、§12；`--self-test` 内置 221 项自检（含 89 项探针判定与路径安全、64 项外部审计单元检查） |
| `candidate-metadata.json`  | 候选仓库/分支/commit/tag 的公开元数据核验记录与复现步骤（当前 tag 未确认 → 候选未冻结）                              | 不参与自动校验；它是两条闸门之外的观测记录，结论见 §10                                                          |

## 2. 门禁语义

检查器把三类问题分开判定，避免「还没到条件」与「已经违反规则」被混为一谈：

| 判定     | 含义                                                                                                                 | 退出码 |
| -------- | -------------------------------------------------------------------------------------------------------------------- | -----: |
| 通过     | 边界无违规、清单合法、工具链达标、准入前置**全部**满足且合规产物全部就位                                             |      0 |
| 违规     | 门禁前出现 Maven 工程/Java 源码/RuoYi 源码副本；或清单非法（占位被伪造、状态与事实不符、实测记录高于本机可复现水平） |      1 |
| 未准入   | 尚未满足条件：本机 JDK/Maven 未达标或无法复现清单声明的达标状态、准入前置未满足、合规产物未就位                      |      2 |
| 用法错误 | 传入了未知参数，或显式探测路径不是可用的绝对 JDK/Maven home                                                          |     64 |

退出码 0 只在「本阶段确实已经就绪」时出现：只要还有准入前置是 `pending`，或还有合规产物是 `pending`，就判**未准入**（退出码 2）。这一点在 0.2.0 之前是缺失的——旧实现只把工具链不达标记为阻断项，于是「JDK/Maven 就绪 + 八项前置仍 pending」会误判为**通过**。现在这类未就绪状态一律 fail-closed，不会给未完成的准入签发放行。

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

其中两项与本机实测**双向**校验，但两个方向的性质不同：

- **本机已达标却仍写 `pending`** 是可当场举证的清单滞后，判**违规**（退出码 1）：声明落后于证据，不允许把已经具备的条件继续挂着；
- **本机测不到或不达标却写 `satisfied`** 只说明本次探测无法复现该声明，没有任何伪造的反证，因此判**未准入**（退出码 2）并给出复现指引——仍然不放行（`stage=admitted` 永远要求本机探测达标），但不冤枉清单。复现方式见 §5。

清单还用 `toolchain.probe.recorded` 记录「本机实测的主版本」：探测到达标工具时，若清单记录的主版本高于本机实际探测到的水平（例如记录 JDK 21、实测只有 17），判**违规**；这样「只写声明、不做测量」不能通过。

### 3.4 候选准入步骤（`candidate.admissionSteps`）

`admissionSteps` 是有序的准入步骤表，每步给出 `id`、`title` 与 `requires`（引用的准入前置 id）。检查器要求：

- 数组非空、每步 id 非空且不重复、title 非空；
- `requires` 只能引用已登记的前置 id（未登记即判违规）；
- 全部必需前置必须被至少一步覆盖（漏步即判违规）——「清单里列了前置」与「实际要走哪些步」不能各说一套。

当前清单登记的候选 RuoYi Spring Boot 3 准入步骤（有序，与 `gate-manifest.json` 的 `candidate.admissionSteps` 逐条对应；**全部是「要做什么」，不是「已经做到」**）：

| #   | 步骤 id                 | 内容                                                                                                      | 关联前置                                                  |
| --- | ----------------------- | --------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| 1   | `toolchain-reproduce`   | 用显式路径复现 JDK 17+ 与 Maven 3.9+ 探测（本地压缩包只在仓库外临时目录解压）                             | `toolchain-jdk`、`toolchain-maven`（本机已达标，见 §5.2） |
| 2   | `pin-candidate`         | 固定实际 Spring Boot 3 候选 commit（40 位 SHA）并同时固定 tag，核对其 POM 声明的 JDK 与 Spring Boot 版本  | `candidate-commit`                                        |
| 3   | `license-and-notice`    | 保留候选原始 LICENSE/NOTICE 原文与哈希证据（不改写）                                                      | `license-notice`                                          |
| 4   | `dependency-inventory`  | 在隔离目录生成依赖树、传递依赖许可证清单与 SBOM（记录工具、版本与生成时间）                               | `dependency-licenses`、`sbom`                             |
| 5   | `vulnerability-scan`    | 完成依赖漏洞扫描并逐项记录处置结论（记录扫描工具与规则版本）                                              | `vulnerability-scan`                                      |
| 6   | `postgresql-validation` | 在隔离 PostgreSQL 实例验证 DDL、分页、时间、事务、索引与迁移回滚                                          | `postgresql-compatibility`                                |
| 7   | `independent-reviews`   | 完成架构/安全独立审查与终审并保留放行结论（不由实施方自证）                                               | `security-review`、`final-review`                         |
| 8   | `gate-promotion`        | 全部前置 `satisfied` 且合规产物就位后，才把本清单 `stage` 提升为 `admitted`                               | —（具备上述全部前置才有意义）                             |
| 9   | `provenance-promotion`  | 五项来源/合规证据全部 `verified` 并与本清单交叉核验后，才把 `provenance-manifest.json` 提升为 `poc-ready` | —（同上）                                                 |

第 2 步**部分完成**：候选 `springboot3` 分支头提交与其 POM/JDK 已第二轮核验，但该提交（乃至其父提交）没有任何对应 tag，按「commit + tag + POM/JDK 三项同时成立」的冻结条件候选保持未冻结（核验记录与复现步骤见 §10 与 `candidate-metadata.json`）。第 3 步只完成公开元数据与摘要核验，原文副本与再分发说明未登记，因此证据仍为 `pending`（§10.2）。第 4–6 步当前无法产出证据：能力探测显示三项前置均不满足（§11）。清单不预填任何候选 commit、许可证、SBOM、漏洞或 PostgreSQL 证据，未完成的项目一律保持 `pending`，由检查器逐次核对。

### 3.5 合规产物（`complianceArtifacts`）

每一项声明仓库内相对路径与状态 `pending`/`present`/`verified`，且必须与磁盘一致：标记 `pending` 却已存在、或标记 `present`/`verified` 却不存在，都判违规。路径不得为绝对路径，也不得包含 `..`。仍为 `pending` 的产物会让整次判定停在**未准入**（退出码 2）。

`pending` 的语义是「尚未取得可核验的合规产物」，因此**不能靠标签推进**：公开摘要显示「上游不存在该文件」（`absent-upstream`）或「本项不适用」（`not-applicable`）都只是观测结论，**不等于**产物已 `present`/`verified`，也不能替代证据文件——上游没有 `NOTICE` 时该项仍保持 `pending`，不得为了推进而伪造文件（理由与解除条件见 §10.3）。

### 3.6 源码自审（公开材料的机器约束）

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

## 5. 本机工具链探测方式（可复现探测）

解析优先级固定为 **显式参数 → 环境变量 → PATH**，清单 `toolchain.probe` 必须逐项声明同一顺序；检查器会核对配方字段（显式参数名、环境变量名、顺序、压缩包约束），被改写或缺失即判清单非法。

| 工具  | 显式参数       | 环境变量                | 候选可执行文件（Windows / 其他平台）    |
| ----- | -------------- | ----------------------- | --------------------------------------- |
| JDK   | `--java-home`  | `JAVA_HOME`             | `bin\java.exe`、`bin\java` / `bin/java` |
| Maven | `--maven-home` | `MAVEN_HOME`、`M2_HOME` | `bin\mvn.cmd`、`bin\mvn.exe`、`bin\mvn` |

显式路径的约束（fail-closed）：必须是**绝对路径**、目录必须存在、`bin/` 下必须有对应可执行文件；任一不满足即以退出码 64 结束，**不会**退回到「换一个能用的路径试试」。相对路径一律拒绝，避免探测结果随工作目录漂移。

Maven 探针需要 `JAVA_HOME` 才能启动，检查器按同一优先级注入（`--java-home` → 环境变量 `JAVA_HOME` → 由本次已解析出的 JDK 反推，且仅当该目录含 `release` 标记，以免把只有 `java.exe` 的转发目录当成 JDK home）。因此一条命令即可复现整套工具链：

```bash
node services/ruoyi-api/toolchain/check-gate.mjs \
  --java-home "C:\Program Files\Java\jdk-17" \
  --maven-home "<仓库外临时目录>/apache-maven-3.9.16"
```

取版本仍是三级方式：管道捕获 → 临时文件句柄回退 → 静态版本文件回退。报告会写明每一项的**探测来源**（`explicit-flag` / `env:变量名` / `path`）、探测方式（`pipe` / `temp-fd` / `static-file`）与最终路径，便于把一次探测原样留存为证据（`--json` 可机器读取）。

保证：只执行 `java -version` / `mvn -v` 这类纯查询参数，**绝不**执行任何构建目标；不联网、不安装、不下载依赖；探测不确定时按 fail-closed 视为未达标。

### 5.1 本地 Maven 压缩包（只读、只在仓库外解压）

本机工具链来自仓库根目录的 `apache-maven-3.9.16-bin.zip`。该压缩包**不属于仓库产物**，保持只读：不修改、不移动、不入库；解压只允许发生在仓库外的系统临时目录。固定用法：

```powershell
# 1) 先记录压缩包摘要（用于证明是「只读使用」）
Get-FileHash -Algorithm SHA256 .\apache-maven-3.9.16-bin.zip
# 2) 只解压到仓库外的系统临时目录（不要解压进工作区，也不要安装到系统 PATH）
Expand-Archive -LiteralPath .\apache-maven-3.9.16-bin.zip `
  -DestinationPath "$env:TEMP\rm-toolchain-probe" -Force
# 3) 用解压结果做一次可复现探测
node services/ruoyi-api/toolchain/check-gate.mjs `
  --java-home "C:\Program Files\Java\jdk-17" `
  --maven-home "$env:TEMP\rm-toolchain-probe\apache-maven-3.9.16"
```

清单 `toolchain.probe.mavenArchive` 记录压缩包文件名、SHA-256、`inRepository: false` 与 `archivedReadOnly: true`、解压范围；检查器校验这些声明齐备、格式合法且摘要不是占位值，但**不做字节级复算**——摘要核验由上面第 1 步的脚本/人工步骤完成。本模块不含哈希实现，也不导入 `node:crypto`。

### 5.2 本机实测状态（核验记录，可复现）

| 工具  | 探测来源                | 版本    | 结论                                               |
| ----- | ----------------------- | ------- | -------------------------------------------------- |
| JDK   | `--java-home` 显式指定  | 17.0.12 | 达标（JDK home `C:\Program Files\Java\jdk-17`）    |
| Maven | `--maven-home` 显式指定 | 3.9.16  | 达标（来自 §5.1 压缩包，解压于仓库外系统临时目录） |

不带显式参数时，本机 PATH 上的 `java` 仍是 `1.8.0_501`（Oracle `java8path` 转发目录），系统也未安装 Maven，因此**默认运行按设计返回未准入**（退出码 2：JDK 版本不达标、Maven 未找到，并附「清单声明的工具链状态未能在本机复现」）。可复现探测的意义正在于此：清单记录的是**显式配方下的实测结果**，默认环境不达标是环境事实，不是清单撒谎。

## 6. 运行方式

```bash
# 6.1 主门禁（任意工作目录可执行；失败时退出码 1/2，按 §2 判定）
node services/ruoyi-api/toolchain/check-gate.mjs
cd services/ruoyi-api/toolchain && node check-gate.mjs

# 6.2 机器可读输出（JSON：summary、violations、blockers、exitCode、context.probe）
node services/ruoyi-api/toolchain/check-gate.mjs --json

# 6.3 信息性运行：始终退出码 0，便于在未准入机器上采集报告
node services/ruoyi-api/toolchain/check-gate.mjs --report

# 6.4 判定规则自检：54 项合成场景，不读磁盘、不执行探测
node services/ruoyi-api/toolchain/check-gate.mjs --self-test

# 6.5 可复现探测：显式指定 JDK 与本地 Maven（优先于环境变量与 PATH，见 §5.1）
node services/ruoyi-api/toolchain/check-gate.mjs \
  --java-home "C:\Program Files\Java\jdk-17" \
  --maven-home "<仓库外临时目录>/apache-maven-3.9.16"
node services/ruoyi-api/toolchain/check-gate.mjs --java-home="..." --maven-home="..." --json

# 6.6 来源与合规证据清单（真实 POC 前；当前为未就绪，退出码 2，按 §4 判定）
node services/ruoyi-api/toolchain/check-provenance.mjs
cd services/ruoyi-api/toolchain && node check-provenance.mjs

# 6.7 机器可读输出（JSON：summary、violations、blockers、exitCode）
node services/ruoyi-api/toolchain/check-provenance.mjs --json

# 6.8 信息性运行：始终退出码 0，便于在证据未齐备时采集报告
node services/ruoyi-api/toolchain/check-provenance.mjs --report

# 6.9 判定规则自检：48 项合成场景 + 3 项 SHA-256 向量，不读磁盘、不写文件
node services/ruoyi-api/toolchain/check-provenance.mjs --self-test
```

```bash
# 6.10 证据生成能力探测（SBOM / 漏洞扫描 / PostgreSQL；当前三项全部被阻断，退出码 2，按 §11 判定）
node services/ruoyi-api/toolchain/check-capability.mjs

# 6.11 显式工具链下的能力探测：JDK 17.0.12 + 仓库外解压的 Maven 3.9.16
node services/ruoyi-api/toolchain/check-capability.mjs \
  --java-home "C:\Program Files\Java\jdk-17" \
  --maven-home "<仓库外临时目录>/apache-maven-3.9.16"

# 6.12 能力探测与外部审计的判定规则自检：221 项（合成场景 + 探针判定、路径安全与严格版本解析 + 外部审计模式单元检查），不读磁盘、不执行探测
node services/ruoyi-api/toolchain/check-capability.mjs --self-test

# 6.13 外部审计前置核验：仓库外固定 commit 的隔离检出（本机实测 verdict=external-audit-ready，退出码 0，见 §12）
node services/ruoyi-api/toolchain/check-capability.mjs \
  --audit-root "D:\ruoyi-audit\RuoYi-Vue-springboot3-current" \
  --audit-commit a51a838b71b446ea27256900efe7ed2faa2a02fd \
  --audit-pom-sha256 16bf030a8e4c79c978bbf11eb6f6e18475771c10f4708d9e62e219480a172c9a
node services/ruoyi-api/toolchain/check-capability.mjs --audit-root "<仓库外目录>" --audit-commit "<40 位 SHA>" --json
```

`--help` 会打印含 `--java-home` / `--maven-home` 的完整用法；未知参数、重复指定、缺值或缺 `bin/` 可执行文件的显式路径都以退出码 64 结束。

`--self-test` 覆盖的合成场景包括：准入前置齐备时通过；门禁前出现 `pom.xml`/Java 源码/RuoYi 源码副本/`src/main/java`；候选 commit 为短 SHA 或分支名；`resolved` 与 `commit` 不一致；固定 commit 未固定 tag；未固定原因与未满足前置不一致；`stage=admitted` 仍有未满足前置；合规产物状态与磁盘不一致；JDK 8 与 Maven 3.8.8 不达标、Maven/JDK 未安装；清单版本非 semver；工具链要求被下调；禁止项清单被清空；清单缺失；以及导入白名单/网络模块/内部文档引用/相对导入四类源码策略。

0.2.0 追加的自检场景：清单标记 `satisfied` 但本机 JDK 未达标 / 找不到 Maven → 未准入而不是违规；清单实测记录主版本高于本机可复现水平；缺少 `toolchain.probe` 配方；配方解析优先级被改写；压缩包摘要写成占位值或被声明为可入库；准入步骤缺失、漏掉必需前置、引用未登记前置；工具链达标但准入前置未满足 → 未准入；前置齐备但合规产物仍 `pending` → 未准入；以及 `--java-home`/`--maven-home` 的合法/内联/缺值/相对路径/目录不存在/缺 `bin/` 可执行文件/重复指定与未知参数九种参数处理。

来源与合规证据检查器的 `--self-test` 覆盖：SHA-256 的 NIST 向量（空串 / `abc` / 448 位两分组）；五项证据齐备且门禁 admitted 时通过；`pending` 却已有文件、`present`/`verified` 却无文件；摘要不匹配、摘要格式非法、占位摘要；文件为空或不可读；缺少内容标记；`verified` 缺少 `collectedAt`/`verifiedBy`，或 `verifiedBy`、`method` 使用占位词；缺少必需证据项、未登记 id、id 重复、路径为绝对路径/含 `..`/越出边界/两项共用同一文件；状态与阶段取值非法、`manifestVersion` 非 semver、`contract` 不匹配、`purpose`/`nonGoals` 被清空、`pocGate` 强制开关被关闭；候选短 SHA/分支名、`resolved` 与 `commit` 不一致、固定 commit 未固定 tag、与 `gate-manifest.json` 候选值不一致；候选未冻结但来源证据已 `verified`、候选已冻结但来源证据未 `verified`；`poc-ready` 时证据仍 pending、门禁未 admitted、门禁合规产物仍 pending；门禁清单不可读/contract 不匹配/缺少 `candidate.pinned`；以及 `present` 合法但不足以准入。

本机当前状态（核验记录）：按 §5.2，显式探测下 JDK 17.0.12 与 Maven 3.9.16 均达标，但准入前置只有 2/10 满足、候选 commit 未冻结、五项合规产物全部为 `pending`，因此主门禁**按设计**返回「未准入」（退出码 2）；不带显式参数时另加「JDK 版本不达标」「Maven 未找到」两项阻断。无论哪种运行方式，退出码都不是 0，`stage` 仍是 `pre-poc-gate`，本目录不含 `pom.xml`，也没有 Java 源码。来源与合规证据清单的五项证据同样**全部为 `pending`**，`services/ruoyi-api/compliance/` 目录尚未创建，因此证据检查器**按设计**返回「未就绪」（退出码 2）；清单不预填、不推测任何证据。

内置 SHA-256 实现另做过一次性交叉核对：0–200 字节全部长度与 1.5 MB 输入的结果都与 Node 内置 `crypto` 一致（核对脚本在仓库外临时运行，不进入本目录；本模块自身仍只导入白名单内的 `node:` 内置模块，不导入 `node:crypto`，也不调用外部命令）。

## 7. 与既有校验器的关系

| 检查器                           | 范围                                                                                                                                       | 输出              |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ----------------- |
| `contracts/validate.mjs`         | 公开契约：夹具结构、授权场景重放、OpenAPI 字段与 `$ref`、枚举交叉核对                                                                      | 失败退出 1        |
| `toolchain/check-gate.mjs`       | 准入门禁：工具链可用性、候选 commit 占位、禁止项与合规产物状态                                                                             | 1 违规 / 2 未准入 |
| `toolchain/check-provenance.mjs` | 来源证据：候选来源/许可证/SBOM/漏洞/PostgreSQL 证据的状态、摘要与标记                                                                      | 1 违规 / 2 未就绪 |
| `toolchain/check-capability.mjs` | 证据生成能力：本机是否具备产出 SBOM、漏洞扫描与 PostgreSQL 兼容性证据的前置；外部审计前置：仓库外固定 commit 检出是否可开始生成证据（§12） | 1 违规 / 2 被阻断 |

三者互补且都只用 Node 内置模块、都不联网、都不写仓库；契约校验回答「契约是否自洽」，门禁回答「现在是否允许开始写 Java」，证据检查回答「候选来源与合规证据是否真的已经核验」。证据检查器还会交叉核验 `gate-manifest.json`，两个公开清单不允许各说一套。

## 8. 边界与非目标

- 本目录不保存 RuoYi 源码、候选 POM 副本、依赖锁定文件或构建产物；候选观测值、哈希与许可证原文保存在本地内部审计记录中，不进入公开目录。
- 不声明可构建、可运行或生产就绪；不替代人工架构/安全评审与许可证复核。
- 不做网络检索，不把网页结果当作合规证据；不修改、不覆盖 `services/api`（NestJS 回滚基线）与既有数据迁移。
- 证据清单只记录「证据文件的位置、摘要与结论」，不代替数据库/扫描工具本身；`--self-test` 使用合成输入，不代表本机实测结论；结论只以默认模式（或 `--json`）的输出为准。
- 能力探测（`check-capability.mjs`）只报告「前置是否满足」，不生成、不预填、不伪造任何证据，也不改变证据清单与门禁清单的任何状态；它打印的下一步命令属于人工执行项，脚本自身不联网、不下载依赖。
- 外部审计模式（`check-capability.mjs --audit-root/--audit-commit`，见 §12）只核验**仓库外**固定 commit 检出目录的前置：不读也不改 `gate-manifest.json`，不生成证据、不推进任何状态，**不把结果标为 `admitted`/`verified`**，也不解除 §3.2 的候选冻结条件与 §3.1 的仓库内 `pom.xml`/Java 源码禁入。

## 9. 版本规则

- 清单 `manifestVersion` 为 semver；非破坏性新增递增次版本，字段语义或闸门收紧属破坏性变更，需提升主/次版本并在本文件记录兼容性说明。
- `0.2.0` 的兼容性说明：`toolchain.probe`（可复现探测配方与实测记录）与 `candidate.admissionSteps`（候选准入步骤）成为**必需**字段，缺失即判清单非法；`admissionSteps` 必须覆盖全部必需前置。同一版本起，判定行为有两处修正并已在 §2/§3.3 记录：**未满足的前置与未就位的合规产物改为阻断项**（未准入，退出码 2；此前会被误判为「通过」），而**清单标记 `satisfied` 但本机无法复现**改为未准入（退出码 2）而不是违规（原为违规）。两处都只会让门禁更严或更准确，不放宽任何放行条件。
- 禁止下调 `toolchain` 的最低要求（JDK 17+ / Maven 3.9+）或关闭边界开关：检查器会直接判为清单非法。
- `provenance-manifest.json` 同样受此规则约束：必需证据 id、`pocGate` 强制开关与「非 pending 必须给出真实摘要」的语义不得弱化；证据状态只能由实际核验结果推进，不能为了过检查器而预先写成 `verified`。
- `provenance-manifest.json` 本轮只新增非证据字段 `capabilityAssessment`（能力评估，见 §11），`manifestVersion` 保持 `0.1.0`：该字段不参与判定，也不改变五项证据的状态；一旦它被用作证据来源或改变判定语义，必须提升版本并在本文件记录。`0.1.1` 只澄清 `license-notice` 的 `howToObtain`（补公开 API 可复现步骤、字节流口径与保持 `pending` 的解除条件，见 §10.3），不改变判定语义、证据状态或必需标记：五项证据仍全部 `pending`。
- `candidate-metadata.json` 属观测记录，`0.2.0` 新增「LICENSE/NOTICE 公开元数据与摘要」与「证据生成能力评估」两项观测，并把第二轮复核结论写入：候选仍未冻结（缺对应 tag），两条闸门不读该文件。
- `check-capability.mjs` 本轮新增 `--audit-root` / `--audit-commit` / `--audit-pom-sha256` 外部审计前置模式（§12），属**非破坏性新增**：默认能力探测的判定、退出码语义与两份清单（`gate-manifest.json`、`provenance-manifest.json`）都未改动，两个清单的 `manifestVersion` 也不变；新增的隔离与摘要判定只会额外拦下「在仓库内生成证据」「把证据归属到另一个提交」这类既已禁止的行为，不放宽任何放行条件。`0.3.0`（第三轮，聚焦许可证/NOTICE 准入）只增强观测与可复现性：`license-notice-metadata` 补齐路径、公开 URL、blob 摘要的内存复算与两主机全树一致性，`reproduce` 新增第 6–8 步的 `node -e` 命令并新增 `reproduceEnvironment`；本次不推进任何闸门状态，候选仍未冻结，`license-notice` 仍为 `pending`。
- 本轮把 `gate-manifest.json` 的 `complianceArtifacts` 中 `sbom` 的路径统一为 `services/ruoyi-api/compliance/provenance/sbom.cyclonedx.json`，与 `provenance-manifest.json` 的 `evidence[].path` 及 `check-capability.mjs` 探测依赖清单时读取的路径一致（见 §12.6）：这是路径纠错，既不放宽也不收紧任何判定，判定语义与退出码不变，`gate-manifest.json` 的 `manifestVersion` 因此保持 `0.2.0`；`complianceArtifacts` 其余四项与证据清单的路径差异仍未裁定（见 §12.6）。

## 10. 候选元数据核验记录（第三轮复核：候选仍未冻结）

`candidate-metadata.json` 记录 RuoYi-Vue `springboot3` 候选的公开元数据核验结果与复现步骤。它与 §3.2 的 `candidate.pinned`、§4 的证据清单是**并列的观测记录**：两条闸门都不读它，判定也不因它而放宽。

**冻结条件（三项必须同时成立）：** ①40 位小写 commit；②该 commit 有对应 tag；③其 POM 声明 Spring Boot 3 且 JDK 要求可核对。

截至 2026-10-08 的核验结果：

| 条件         | 结论                   | 依据                                                                                                                                                                                                                                                                                                                                 |
| ------------ | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 40 位 commit | 已核验                 | `springboot3` 分支头为 `a51a838b71b446ea27256900efe7ed2faa2a02fd`；Gitee API、GitHub 镜像与仓库外只读审计副本的 `FETCH_HEAD` 三处一致；该提交在上游**未签名**（unsigned），因此只能依赖多主机一致而不能依赖签名链                                                                                                                    |
| 对应 tag     | **未确认（关键缺口）** | Gitee 与 GitHub 的 tags 端点各返回 27 个 tag（`v1.0`…`v3.9.2`），逐个比对无一指向该 commit，只读副本内 `git tag --points-at HEAD` 也为空。最新 tag `v3.9.2` 指向 `0e2d75c2…`，其树含 `ruoyi-ui` 且根 POM 为 spring-boot 4.0.3；`springboot3` 分支树不含 `ruoyi-ui`、根 POM 为 spring-boot 3.5.16，两者不是同一条线                   |
| POM/JDK      | 已核验（仓库外只读）   | 只读副本中 `git show HEAD:pom.xml` 给出 `<java.version>17</java.version>` 与 `<spring-boot.version>3.5.16</spring-boot.version>`；`HEAD:pom.xml` 的 blob SHA-1 `699a3bcc6a6df052525984b2a96628e3c6c5664e` 与 `HEAD:LICENSE` 的 `8564f294c7781cbbbdb22ae5927a96f859db0054` 与公共 tree 端点一致，证明读到的就是该公共提交的同一份内容 |

### 10.1 第二轮复核结论（2026-10-08）

第二轮用同样的公开端点重跑了全套核验，结论与第一轮一致，并补齐了三项可复核锚点：

| 复核项           | 本轮结果                                                                                                                                                                                                                                                                                        |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 分支头提交       | Gitee 分支端点、GitHub 分支端点与仓库外只读副本的 `git rev-parse HEAD` 三处一致：`a51a838b…`；其根树为 `408ccdb2…`；该提交相对父提交只改了 `README.md`（群号），不改构建配置                                                                                                                    |
| 对应 tag         | Gitee tags 端点与 GitHub `git/refs/tags` 各返回 27 条（`v1.0`…`v3.9.2`），名称与指向的 commit 逐一相同且全部为轻量 tag；**没有任何 tag 指向候选提交，连父提交 `9e3fb55f…` 也没有**                                                                                                              |
| 两条线不是同一条 | 候选根树不含 `ruoyi-ui`、根 POM blob 为 `699a3bcc…`；`v3.9.2`（`0e2d75c2…`）根树含 `ruoyi-ui`、根 POM blob 为 `8123fb86…`                                                                                                                                                                       |
| 签名             | 上游未做 GPG 签名（`verification.verified=false`、`reason=unsigned`），只能依赖多主机一致                                                                                                                                                                                                       |
| tag 关系证据范围 | tag↔commit 关系**只以两个公共主机的 27 条 refs 为证据**：只读副本是**浅克隆**（`--is-shallow-repository`=true、`rev-list --count HEAD`=1），其 `tag --contains` / `merge-base` 结果不作为关系证据；本地 `git describe --tags --exact-match HEAD` 直接报「no tag exactly matches」，与本结论一致 |
| 树一致性锚点     | 只读副本 `rev-parse HEAD^{tree}` = `408ccdb2ae9879fff34501ca7b587bfb81dff7dd`，与公共 tree 端点给出的 tree sha 完全相同，说明本地读到的就是该公共提交的同一棵树                                                                                                                                 |

### 10.2 LICENSE/NOTICE 公开元数据与摘要（第三轮：只用公开 API 复现，不复制原文）

第三轮把许可证/NOTICE 的核验从「公开元数据 + 仓库外只读副本」推进到**只用公开仓库 API 即可完整复现**：LICENSE 的字节摘要不再依赖任何本地克隆，而是在内存中取回、解码、摘要后立即丢弃。观测值如下（候选提交 `a51a838b71b446ea27256900efe7ed2faa2a02fd`）：

| 项                         | 观测值                                                                                                                                                                                                                  | 来源（公开端点）                                                                                                                                            |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 许可证类型（SPDX）         | `MIT`（`license.name` = `MIT License`）                                                                                                                                                                                 | GitHub 仓库端点 `license.spdx_id`（启发式识别）＋该提交的单文件 license 端点 `?ref=<commit>`（`path=LICENSE`、`sha=8564f294…`、`size=1071`、`spdx_id=MIT`） |
| LICENSE 路径               | `LICENSE`（候选提交**根目录**，精确文件名；根树 16 个条目中唯一的许可类文件）                                                                                                                                           | 公共根 tree 端点 ＋ 全树递归端点                                                                                                                            |
| LICENSE 网页 URL           | `https://github.com/yangzongzhuan/RuoYi-Vue/blob/a51a838b71b446ea27256900efe7ed2faa2a02fd/LICENSE`（HTTP 200）                                                                                                          | 浏览器可读；Gitee 侧对应 `https://gitee.com/y_project/RuoYi-Vue/blob/springboot3/LICENSE`（HTTP 200）                                                       |
| LICENSE blob               | `8564f294c7781cbbbdb22ae5927a96f859db0054`（size 1071）                                                                                                                                                                 | 公共 tree 端点；blob 端点 `git/blobs/8564f294…`（base64）                                                                                                   |
| LICENSE 字节 SHA-256       | `7296da00ac5dfc56c36e6ac10ce5abdb2900898c101d5c4720d7b6c1254dd993`                                                                                                                                                      | GitHub API blob 端点与 Gitee 网页 raw 端点**各自**取回字节后内存计算，两主机摘要逐字节一致（只记录摘要，不落盘）                                            |
| NOTICE 存在性              | **`absent-upstream` / `not-applicable`**（上游本就不存在）：全树 477 个条目（334 blob + 143 tree，`truncated=false`）中，精确文件名的许可类文件只有根 `LICENSE`；`NOTICE` / `NOTICE.txt` / `COPYING` / `COPYRIGHT` 均无 | 公共递归 tree 端点；11 条含 “notice” 的路径逐条核对全部是 RuoYi 业务类（`SysNotice`、`SysNoticeController` 等），与 NOTICE 合规文件无关                     |
| 两主机一致性               | Gitee 主仓库与 GitHub 镜像的全树逐条目（`type:path` → `sha`）比对：各 477 个条目、单侧独有 0 个、sha 不一致 0 个                                                                                                        | 两主机的递归 tree 端点 ＋ Gitee `contents/LICENSE?ref=springboot3`（`sha=8564f294…`、size 1071）                                                            |
| POM blob / 字节 SHA-256    | `699a3bcc6a6df052525984b2a96628e3c6c5664e`（size 8513） / `16bf030a8e4c79c978bbf11eb6f6e18475771c10f4708d9e62e219480a172c9a`                                                                                            | 公共 tree 端点（本轮核对 blob sha/size）＋ 第一/二轮的仓库外只读副本字节摘要（本轮未重算 SHA-256）                                                          |
| LICENSE 工作区字节 SHA-256 | `46973d260eabeaf43df2478bf00dacf862911988eba72387596fcafbc4888cab`（1090 B、19 组 CRLF）                                                                                                                                | 本机 `core.autocrlf=true` 检出后的工作区文件；与上一行的 blob 字节摘要**不同**，登记 `license-file-sha256` 时必须写明采用哪一种字节流                       |

复现方式（本机实测通过，命令见 `candidate-metadata.json` 的 `reproduce` 第 6–8 步）：`node -e` 一行命令访问公开 API → 递归 tree 端点统计全树条目与许可类文件 → blob 端点取 base64 字节 → 在内存中按 git 对象格式（`blob <长度>\0` + 内容）重算 blob SHA-1（与 tree 端点一致，证明取到的就是该公共提交的同一份字节）→ 对同一份字节算 SHA-256 → 在 Gitee 侧交叉核验同一 blob 与同一棵树 → 再在 **Gitee 网页 raw 端点**取回同一份 1071 B 字节并在内存计算 SHA-256，与 GitHub API blob 端点逐字节一致（第二主机字节来源）。

**环境限制（属于本机，不是上游事实）**：`raw.githubusercontent.com` 在本机 DNS 不可解析（`getaddrinfo ENOENT`），`curl.exe`（HTTP 000）与 `Invoke-RestMethod`（TLS 失败）也不可用，只有 Node 内置 `fetch` 能访问公共 API。因此取字节以 **GitHub API blob 端点**与 **Gitee 网页 raw 端点**（`https://gitee.com/y_project/RuoYi-Vue/raw/springboot3/LICENSE`，本机可达）为准，复现命令一律写成 `node -e` 形式（见 §10.3 与 `candidate-metadata.json` 的 `reproduceEnvironment`）。

**本轮只记录摘要与标识，没有把 LICENSE/POM 原文或任何 RuoYi 文件复制进本仓库**（blob 字节只在内存中摘要后丢弃），也没有创建 `compliance/` 下的任何证据文件或原文副本；`provenance-manifest.json` 的 `license-notice` 证据仍为 `pending`，不因本节而提前推进。

因此候选**保持未冻结**：`gate-manifest.json` 的 `candidate.pinned`（`tag`/`commit` 为 `null`、`resolved=false`）与 `provenance-manifest.json` 的 `candidate` 均**未改动**；准入前置 `candidate-commit` 仍为 `pending`（该前置把 commit、tag 与 POM/JDK 三项绑在一起，缺 tag 即整体未满足），`stage` 仍为 `pre-poc-gate`。不预设、不推测，也不为了推进而固定一个没有 tag 的提交。

复现步骤（只用公开元数据与仓库外只读查询，不下载源码本体）见 `candidate-metadata.json` 的 `reproduce`（共 13 步）：Gitee 分支端点 → GitHub 分支端点 → Gitee/GitHub tags 端点 → 公共 tree 端点对比两条线的根树与 POM blob → 公共 tree 端点核对 blob 摘要与 NOTICE 存在性 → **第三轮新增：公开 API 核验许可证类型（第 6 步）→ 内存中复算 LICENSE 字节摘要并统计全树 NOTICE（第 7 步）→ Gitee 主仓库交叉核验同一 blob 与同一棵树（第 8 步）** → 只读副本复核 POM/JDK、tag 与全树 NOTICE 列举（并确认它是浅克隆，不用本地祖先关系推断 tag）→ 复算 LICENSE/POM 字节摘要并区分字节流 → 运行能力探测器复核 SBOM/漏洞/PostgreSQL 前置 → 复核两条闸门仍为未准入/未就绪。

边界：本次未下载、未复制 RuoYi 源码、POM 内容或 LICENSE 原文进仓库（只记录 blob 摘要、字节 SHA-256 与 SPDX 标识），未创建 `pom.xml` 或任何 Java 源码，`apache-maven-3.9.16-bin.zip` 仍只读且不入库（解压只发生在仓库外系统临时目录，解压前后 SHA-256 不变）；本记录不承担许可证/NOTICE 原文复核、SBOM、漏洞与 PostgreSQL 兼容性证据的核验，能力探测结论（§11）同样不是证据。第三轮同样没有下载或复制任何上游文件进仓库：LICENSE 字节只在内存中解码与摘要后丢弃，未创建 `compliance/` 下的证据文件或原文副本，也未改动 `gate-manifest.json` 的任何状态；许可证/NOTICE、SBOM、漏洞与 PostgreSQL 证据一律保持 `pending`。

### 10.3 为什么 `license-notice` 仍保持 `pending`（解除条件）

第三轮把「公开元数据层面」的核验做完整了，但**证据状态不推进**：这是刻意的 fail-closed，不是遗漏。

**NOTICE 的处置口径（已记录）**：候选提交的整个树里不存在 `NOTICE` / `NOTICE.txt` / `COPYING` / `COPYRIGHT`，因此「NOTICE 是否缺失」这一项按 **`absent-upstream`**（上游本就不存在该文件）记录、并按 **`not-applicable`**（没有第三方 NOTICE 需要再分发）处置。这只是**观测口径**，不是证据状态：`license-notice` 证据在**仓库外受控目录的 LICENSE 原文证据**与**非实施方的独立复核署名**完成之前一律保持 `pending`，不因上述口径而提前推进。

1. **证据项要求原文证据与再分发说明，而本仓库明确不保存上游原文。** `provenance-manifest.json` 的 `license-notice` 要求「保留候选仓库原始 LICENSE 与 NOTICE 的证据：SPDX 标识、原文文件摘要、NOTICE 存在性与再分发说明」，与之配套的准入合规产物是 `gate-manifest.json` 的 `services/ruoyi-api/compliance/LICENSE`（「候选仓库原始许可证原文副本」）。本项目当前的边界是**不把上游 LICENSE/NOTICE 原文复制进本仓库**，因此该产物无法登记；此时把证据推进到 `present`/`verified` 会让读者以为许可证准入已就位，属于过度声明。
2. **`verified` 还有本轮不可能诚实满足的硬条件。** `check-provenance.mjs` 要求 `verified` 给出核验时间与核验署名，并与准入门禁的候选固定值交叉核验；而 `gate-manifest.json` 的 `candidate.pinned` 仍为 `tag=null` / `commit=null` / `resolved=false`（候选未冻结，缺对应 tag），且按 §3.4 的独立审查要求不由实施方自证。此时声明 `verified` 会被检查器直接判为违规（退出码 1），因此**不伪造 verified**。
3. **公开可复现的只是摘要，不等于「原文已复核」。** 本轮证明的是「该公共提交的 LICENSE 字节可被公开端点复现、许可证类型为 MIT、全树不存在 NOTICE」，不包含逐条条款复核，也不包含依赖许可证清单（那属于 `dependency-licenses` 与 `sbom` 的范围）。
4. **`absent-upstream` / `not-applicable` 只是公开摘要，不等于合规产物已核验。** 公开端点证明的只是「该提交全树不存在 `NOTICE`/`COPYING`/`COPYRIGHT`」，这只能写成「上游不存在该文件」（`absent-upstream`）一类**观测标签**；它既不等于「本项不适用」（`not-applicable`），更不等于准入门禁的合规产物 `services/ruoyi-api/compliance/NOTICE` 已 `present`/`verified`。因此 `NOTICE` 项保持 `pending`：上游没有 `NOTICE` 时**不得伪造一个 NOTICE 文件**来把该项标成 `present`/`verified`，也不得用 `absent-upstream`/`not-applicable` 这类标签替代证据——真正的再分发证据（本仓库分发哪些上游字节、依据哪条条款、由谁核验并署名）仍未登记、仍为 `pending`，只有在下面的解除条件全部满足后才会推进。

解除条件（同时满足后才推进该项，届时按 §9 提升 `provenance-manifest.json` 版本并在本节记录）：

- 明确并记录再分发策略：要么登记 `services/ruoyi-api/compliance/LICENSE` 原文副本（当前被「不复制上游原文进本仓库」的边界禁止），要么形成「本仓库不分发上游原文、仅在构建/运行时按上游 MIT 条款引用」的书面结论；
- 由非实施方的独立审查方核验并署名（`collectedAt` + `verifiedBy`），证据文件 `services/ruoyi-api/compliance/provenance/license-notice.md` 按 `requiredMarkers` 填写（`spdx-license-identifier:`、`license-file-sha256:`、`notice:`），并在 `license-file-sha256` 上写明字节流（默认用公共提交 blob 字节 `7296da00…`；本机工作区 CRLF 字节是另一个值 `46973d26…`，两者不得混用）；
- 候选 commit/tag 冻结后与门禁交叉核验（`candidate.pinned` 与 `provenance.candidate` 必须一致），才能把该项推进到 `verified`。

在这些条件满足前，`license-notice` 保持 `pending`，两条闸门（`check-gate.mjs`、`check-provenance.mjs`）继续按未准入/未就绪阻断。

## 11. 证据生成能力评估（`check-capability.mjs`）

`candidate-metadata.json` 记录「候选是什么」，§3 的门禁判定「是否允许开工」，§4 的证据检查判定「证据是否已核验」；本节回答第三个问题：**当前环境能不能产出真实证据**。`check-capability.mjs` 只做只读前置探测（只用 Node 内置模块、不联网、不下依赖、不写仓库、不生成任何证据），并在被阻断时打印可复现的下一步命令。

### 11.1 三项能力与前置

| 能力                       | 就绪的含义                   | 前置                                                                                                           |
| -------------------------- | ---------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `sbom`                     | 能生成 CycloneDX 依赖清单    | 门禁 `admitted`；`pom.xml` 就位；JDK 17+ 与 Maven 3.9+ 达标；SBOM 工具（cyclonedx / syft / cdxgen / jbom）可用 |
| `vulnerability-scan`       | 能对已锁定依赖做漏洞扫描     | 依赖清单（`pom.xml` 或已生成的 SBOM）；扫描器（trivy / grype / osv-scanner / dependency-check）可用            |
| `postgresql-compatibility` | 能起隔离实例做方言与迁移验证 | 本机 `psql` / `pg_ctl` / `pg_isready`，**或**容器运行时（Docker CLI 存在且守护进程可达）——两者任一满足即可     |

判定与退出码：`0` 三项就绪；`2` 至少一项被阻断（当前本机即为此状态）；`1` 违规（门禁清单不可用或非法，或出现「门禁未 `admitted` 却已存在 `pom.xml`」这类绕过单一闸门的事实）；`64` 用法错误。`--report` 恒以 0 结束，便于在未就绪机器上采集报告。

### 11.2 本机实测（2026-10-08）

| 能力                       | 结论   | 缺口                                                                                                                                                                                                                                         |
| -------------------------- | ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sbom`                     | 被阻断 | 门禁未 `admitted`（提升前禁止创建 `pom.xml`）、`pom.xml` 不存在、PATH 上的 java 为 1.8.0_501 且未安装 Maven、PATH 上无 SBOM 工具；带显式 `--java-home` / `--maven-home` 时 JDK 17.0.12 与 Maven 3.9.16 达标（`build-toolchain` 前置变为 ok） |
| `vulnerability-scan`       | 被阻断 | 没有可扫描的依赖清单（`pom.xml` 与 SBOM 均不存在）、无扫描器与可记录的规则库版本                                                                                                                                                             |
| `postgresql-compatibility` | 被阻断 | 无 `psql` / `pg_ctl` / `pg_isready`，本机未安装 PostgreSQL；docker CLI（29.8.0）存在但守护进程不可达                                                                                                                                         |

因此本轮**没有生成任何证据**：`provenance-manifest.json` 的五项证据仍全部为 `pending`，`stage` 仍为 `pre-poc`；能力评估结论不是证据，也不改变两条闸门的判定。

### 11.3 运行方式

```bash
# 11.1 默认探测（当前：三项全部被阻断，退出码 2；--json 可机器读取）
node services/ruoyi-api/toolchain/check-capability.mjs
node services/ruoyi-api/toolchain/check-capability.mjs --json

# 11.2 显式工具链探测：JDK 17.0.12 + 仓库外解压的 Maven 3.9.16
node services/ruoyi-api/toolchain/check-capability.mjs \
  --java-home "C:\Program Files\Java\jdk-17" \
  --maven-home "<仓库外临时目录>/apache-maven-3.9.16"

# 11.3 信息性运行：始终退出码 0
node services/ruoyi-api/toolchain/check-capability.mjs --report

# 11.4 判定规则自检：221 项（合成场景 + 探针判定、路径安全与严格版本解析 + 外部审计模式单元检查），不读磁盘、不执行探测
node services/ruoyi-api/toolchain/check-capability.mjs --self-test
```

自检覆盖：三项能力就绪与被阻断的各种组合（缺 `pom.xml`、Maven 3.8.8 与 JDK 8 不达标、缺 SBOM 工具、缺扫描器、缺依赖清单、无 PostgreSQL 但容器运行时可达、docker CLI 存在而守护进程不可达）；门禁未 `admitted` 却已存在 `pom.xml` 判违规；门禁清单不可读、`contract` 不匹配、`stage` 非法、清单不是对象均判违规（fail-closed）；工具「定位到但不可用」的六种失败路径（退出码非 0、输出为空、输出不可解析、`unsafe-path`、`timeout`、JDK 执行失败）都不得算可用；以及未知参数、缺值、相对路径、目录不存在、含 shell 元字符的显式路径、缺 `bin/` 可执行文件、重复指定与合法显式路径九类参数处理。该脚本在同一文件的并行加固轮次中继续收紧过判定（版本号形状校验、**工具特定严格版本解析**、更严格的路径拒绝）：工具侧覆盖 `garbage 999.999`、`error 1.2`、`0.0`、`Version: 1.2`、`trivy image <target>` 等不可解析输出与跨工具标识，Docker 侧覆盖 5 条合法 ServerVersion 与 10 条非法输出，并**逐工具验收** 4 款 SBOM 工具 / 4 款扫描器 / 3 款 PostgreSQL 客户端的真实 `--version` 形态（见 §11.5）。外部审计模式的覆盖见 §12.5（仓库内路径、仓库上级目录、文件系统根、短 SHA、HEAD 不匹配、dirty 工作树、缺 `pom.xml`、`pom.xml` 是目录、非 Git 仓库、符号链接逃逸、摘要不一致、隔离不通过时不执行 git、以及合法外部审计目录等合成场景与 35 项单元检查）。因此**项数与语义以脚本自身 `--self-test` 输出为准**（本节数字对应 2026-10-08 的快照）。

### 11.4 探测加固（独立审查 BLOCK 后的修复）

`check-capability.mjs` 的首版被独立审查判为 BLOCK，随后按三条意见加固，并在同一文件的并行加固轮次中继续收紧（版本号形状校验、更严格的路径拒绝、**工具特定严格版本解析**，最后一项见 §11.5）：

| 意见                   | 首版问题                                                                 | 修复                                                                                                                                                                                                                                                                                                                                                     |
| ---------------------- | ------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 可用判定 fail-open     | 只要 PATH 上存在同名文件就记为「找到」，坏掉的同名脚本也会被当成现成工具 | `classifyProbe` 要求**定位到文件 + 退出码 0 + 输出非空 + 能解析出该工具自己的严格版本行**（语义版本 `MAJOR.MINOR.PATCH`；Docker 单独要求整段输出就是合法 ServerVersion，见 §11.5）才算可用；否则记录 `exit-status:N`、`empty-output`、`output-unparsable`、`not-found` 等原因并判被阻断。只打印用法、拿不出版本号的「同名程序」不再算可用                |
| `shell: true` 路径注入 | `.cmd`/`.bat` 只有含空格时才加引号，路径里的元字符可能被 cmd 解释        | 需经 `cmd.exe` 启动的 `.cmd`/`.bat` 路径**拒绝**引号、控制字符与危险元字符（`&`、`\|`、`<`、`>`、`^`、`(`、`)`、`%`、`!`），命中即不执行（显式路径以退出码 64 结束，PATH 探测按 `unsafe-path` 判不可用）；命令行**一律加引号**作为纵深防御。`.exe` 与 POSIX 可执行文件由 Node 直接 exec（`shell: false`），只做引号/控制字符校验，因此不被元字符规则误拒 |
| 无超时                 | 探针可能挂死，检查器随之卡住                                             | 每次探测 `timeout: 15000`；超时或收到信号按不可用处理，且**不回退重试**（避免等待时间翻倍）                                                                                                                                                                                                                                                              |

**有意取舍（fail-closed）**：危险元字符只在**确实要经 shell 启动**时拒绝——`.cmd`/`.bat` 路径含 `&`、`|`、`<`、`>`、`^`、`(`、`)`、`%`、`!` 之一即拒绝执行（显式路径以退出码 64 结束，PATH 探测按 `unsafe-path` 判不可用）。这样既堵住注入面，又不误伤不经 shell 的常用路径：本机 PATH 上的 java 位于 `C:\Program Files (x86)\...\java8path\java.exe`，仍被正常探测并如实报 `JDK=java version "1.8.0_501"（major=8）`——是「版本不达标」而不是「不可用」（见 §11.2）。代价是：Maven 若解压在含括号的目录，其 `mvn.cmd` 会被拒绝，按 §11.2 的配方放到仓库外不含元字符的目录即可；显式 `--java-home "C:\Program Files\Java\jdk-17"` 与仓库外解压的 Maven 3.9.16 仍判可用（JDK 17.0.12 / Maven 3.9.16），说明收紧判定没有误伤真实工具链。

实测对照：修复前 docker CLI 在守护进程不可达时仍被记为「找到」，修复后如实报 `docker CLI 不可用：exit-status:1`；`--self-test` 覆盖退出码非 0、输出为空、输出不可解析、`unsafe-path`、`timeout` 与 JDK 执行失败六类失败路径，均不得算可用。

### 11.5 工具特定严格版本解析（第二项 BLOCK 的修复）

首轮加固只要求「输出里有 `\d+(?:\.\d+)+` 形状的数字点串」，这仍是**在整段输出里任意搜数字**：错误文本（`error code 1.2`、`garbage 999.999`）也会被当成版本号，把坏工具误报为可用；Docker 侧只判「非空且不含 daemon 失败特征」同样过宽。现改为**工具特定**解析（`check-capability.mjs` 内「严格的工具特定版本解析」一节），只承认三种版本行，且版本号本身必须是严格语义版本（`MAJOR.MINOR.PATCH`，可选 `-预发布` / `+构建元数据`）：

| 版本行形状      | 规则                                                                                                                        | 例子                                                                   |
| --------------- | --------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| A. 合法版本行   | 整行恰好是一条语义版本（commander 风格 CLI 只打印版本号）                                                                   | `11.5.1`（cdxgen）                                                     |
| B. 工具标识行   | 行首必须是**该工具自己的**标识，版本号紧随其后（允许 `:` / `version` 等连接词），行尾只允许空或 PostgreSQL 的发行版括号说明 | `trivy 0.58.0`、`osv-scanner version: 1.9.0`、`psql (PostgreSQL) 16.4` |
| C. 带标签版本行 | 整行是 `Version: X.Y.Z`，且**只对实测这样输出的工具**开放（syft / grype / trivy）                                           | `Version: 0.58.0`（trivy 首行）                                        |

- 扫描范围有界（最多前 20 行），取第一个合格版本行；解析不出一律 `output-unparsable` → 该工具不算可用（fail-closed）。
- 两段数字（`0.0` / `1.2` / `999.999`）不是语义版本；PostgreSQL 的两段式版本（10 起官方版本号只有两段）只在形状 B 内接受，且**主版本必须 ≥ 1**，因此 `psql (PostgreSQL) 0.0` 按不可解析处理。
- 工具特定：探测 trivy 时看到 `grype 0.90.0` 不会被当成版本号；`Usage: trivy [flags]` 与 `trivy image <target>` 同样解析不出。
- Docker（`docker info --format '{{.ServerVersion}}'`）走更严的规则：**整段输出必须就是一条合法版本串**（允许 `-rc.1` / `-ce` / `+dfsg1` 等常见后缀）；`error during connect: ...`、`Cannot connect to the Docker daemon ...`、`ServerVersion: 27.3.1`、`0.0`、`999.999`、版本后跟警告行、空输出一律判守护进程不可达。代价是 CLI 若同时向 stderr 打印警告也会被判不可用（fail-closed：宁可阻断，不可误报）。
- 自检新增：工具侧 `garbage 999.999`、`error 1.2`、`0.0`、`Version: 1.2`、`Usage: trivy [flags]`、`trivy image <target>`、跨工具标识与 `psql (PostgreSQL) 0.0`；**逐工具验收**（cyclonedx / syft / cdxgen / jbom / trivy / grype / osv-scanner / dependency-check 与 psql / pg_ctl / pg_isready 各一条真实输出形态都必须解析出语义版本）；以及 Docker 侧 5 条合法 ServerVersion（含后缀）与 10 条非法输出（daemon 错误文本、两段数字、带标签输出、版本后夹带文本/警告行、连接地址 `tcp://127.0.0.1:2375`、日志前缀夹版本、空输出）；`status === 0`、15 秒超时、路径安全与 `unsafe-path` 判定均保持不变。

后续建议（不在本轮改动范围）：`check-gate.mjs` 与 `check-provenance.mjs` 早先版本的 `buildInvocation` 采用同样的「含空格才加引号 + `shell: true`」写法，属同一类风险；它们已被推送且带独立自检，建议单独一次变更统一加固，避免与本次能力探测加固混在同一切片。

## 12. 外部审计模式（`check-capability.mjs --audit-root / --audit-commit`）

### 12.1 为什么需要它：先打破「证据 ↔ 准入」的循环

生成 SBOM/漏洞/PostgreSQL/许可证证据要求先有可构建的 Maven 工程（`pom.xml`），而创建 `pom.xml` 又要求门禁 `stage=admitted`，`admitted` 又要求这些证据的前置 `satisfied`——按这个顺序什么都推进不了。但真实证据**并不需要在本仓库内生成**：把候选的一份只读检出放在仓库之外（本机为 `D:\ruoyi-audit\RuoYi-Vue-springboot3-current`，浅克隆、固定到候选 commit），在它**之外的输出目录**里生成证据，再把**证据文件**回填进 `services/ruoyi-api/compliance/provenance/`。外部审计模式只回答一个问题：**这份隔离检出当前是否具备开始生成证据的前置**（即「固定 commit + 干净工作树 + 根 `pom.xml` 与输入摘要可复核」）。它不回答「证据是否已收集」（那是 `check-provenance.mjs`），也不回答「是否允许在仓库内建 Maven 工程」（那是 `check-gate.mjs`）。

**推进顺序固定且不可颠倒（这是本项目的准入顺序，不因本模式而改变）：**

1. **仓库外固定 commit 先生成真实证据**：在仓库之外的隔离检出上对固定 commit 产出许可证/NOTICE、SBOM（CycloneDX）、漏洞扫描与 PostgreSQL 兼容性四类**真实**证据（记录工具与版本、输入锁定文件、生成时间与实例版本），生成物写在检出目录之外，使检出保持干净；
2. **按唯一路径回填**：证据文件回填到 `services/ruoyi-api/compliance/provenance/` 下（唯一目标路径见 §12.6），并给出 `fileSha256` 与内容标记；
3. **由 `check-provenance.mjs` 判定**：五项来源/合规证据达到 `verified`；
4. **之后才考虑仓库内准入**：全部准入前置带证据满足、合规产物就位后，才把 `gate-manifest.json` 的 `stage` 提升为 `admitted`，也才允许在本目录出现 `pom.xml` 与 Java 源码。

**仓库内准入不是生成证据的前提，恰恰相反：先有仓库外真实证据，仓库内准入才有依据。** 本模式只负责第 1 步之前的「前置是否具备」，既不生成证据，也不推进任何状态。

### 12.2 本模式只做四类前置核验

| 类别          | 核验内容                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | 判失败                                                                                          |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| 路径与隔离    | 审计根必须是绝对路径、无引号/控制字符、无 `..` 段、不是文件系统根；其 **realpath** 必须真实位于仓库之外：不得是文件系统根、不得是边界根目录（`services/ruoyi-api`）本身、不得落在边界目录内、不得落在仓库工作树内、也不得是仓库的**上级目录**（`git -C <上级目录>` 会沿父目录找到仓库自身的 `.git`）。realpath 由 `realpathSync` 解析，因此**经符号链接/联接逃逸回仓库或边界内**会被按真实路径拦下；本模式不读、不复制工作区文件，故不存在「工作区 `pom.xml` 指向仓库内」这类读取面 | 被阻断（违规，退出码 1）；路径形状非法＝用法错误（64）                                          |
| 固定提交      | `--audit-commit` 必须是 **40 位小写十六进制 SHA**；短 SHA、分支名、`latest` 一类占位词一律拒绝                                                                                                                                                                                                                                                                                                                                                                                      | 用法错误（64）                                                                                  |
| 外部 Git 事实 | 审计根下必须有 `.git`；`git rev-parse --verify HEAD` 的输出必须**整段就是**固定 commit（不做「在文本里搜 SHA」的宽松匹配）；工作树必须**完全干净**（`git status --porcelain` 无任何条目，已跟踪改动与**未跟踪文件都算不干净**——生成物必须写到检出目录之外）；状态或 HEAD 输出里出现任何非 porcelain 文本一律按「状态不可读」fail-closed                                                                                                                                             | HEAD 不一致 / 工作树不干净 → 被阻断（违规，1）；无 `.git`、git 不可用或状态不可读 → 被阻断（2） |
| 输入与摘要    | 固定 commit 的根 `pom.xml` 必须存在（`git cat-file -e HEAD:pom.xml`）；用 `git show HEAD:pom.xml` **在内存里**取内容（`contentCopied=false`，不落盘、不复制任何文件、不看工作区文件），记录其内容 **SHA-256** 与 blob **SHA-1**；给出 `--audit-pom-sha256` 时与该内容摘要逐字节比对                                                                                                                                                                                                 | 缺 `HEAD:pom.xml` → 被阻断（2）；声明摘要与固定 commit 的内容摘要不一致 → 被阻断（违规，1）     |

判定优先级：出现**违规**即判违规（此时不再重复罗列阻断项，前置明细仍完整保留在 `preconditions` 里）；否则任一前置未满足即判**被阻断**；8 项前置全部满足才输出唯一的正向结论。**生成物不得留在审计检出内**：健康用法是在核验通过之后，把证据生成到检出目录之外的输出目录（或使用检出的一份一次性副本），使「固定 commit + 干净工作树」这一组合始终成立。

### 12.3 它不做什么（与 §11 的能力探测刻意区分）

- **不要求、也不检查仓库内门禁 stage**：完全不读 `gate-manifest.json`——外部审计正是为了在准入之前先拿到证据；
- 不创建、不复制、不移动任何源码或证据文件：既不写仓库，也不写审计目录；
- 不联网、不安装、不下载依赖，不执行任何构建目标（只执行 `git rev-parse` / `git status --porcelain` / `git cat-file -e` / `git show` 这类只读查询）；
- 不生成、不预填、不伪造证据，不推进 `provenance-manifest.json` 的任何状态；
- 所有 git 调用都带 `-C <审计根>` 与 `GIT_OPTIONAL_LOCKS=0`，因此不会抢索引锁、不会刷新或写回 `.git/index`；**隔离判定不通过时一条 git 命令都不执行**（避免 `git -C` 沿父目录误触仓库自身的 `.git`）。

### 12.4 判定与退出码

| 判定                 | 含义                                                                                                                                                | 退出码 |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | -----: |
| 外部审计前置可执行   | 8 项前置全部满足，正向结论 `verdict=external-audit-ready`；**不等于 admitted，也不等于 verified**                                                   |      0 |
| 被阻断（违规）       | 隔离被破坏（边界目录内、仓库内、仓库上级、文件系统根、符号链接逃逸回仓库）或外部事实与固定 commit 矛盾（HEAD 不一致、工作树不干净、声明摘要不匹配） |      1 |
| 被阻断（前置未满足） | 结构合法但前置未满足（无 `.git`、git 不可用、工作树状态不可读、`HEAD:pom.xml` 缺失或不可读、realpath 失败、审计根不是目录）                         |      2 |
| 用法错误             | 参数形状非法（缺 `--audit-commit`、短 SHA、相对路径、含 `..`、文件系统根、非 64 位摘要、与 `--java-home`/`--maven-home` 同用）                      |     64 |

**verdict 只有两个取值**（`external-audit-ready` 与 `blocked`）：隔离违规与「前置未满足」都落在 `blocked`，只用退出码 1/2 区分原因，明细保留在 `violations` / `preconditions` 里，**绝不**产生第三个 verdict。输出中 `admitted`、`verified`、`evidenceGenerated` 恒为 `false`，正向结论只有 `verdict=external-audit-ready`（中文表述「外部审计前置可执行」，含义是前置齐备、可以开始生成证据，**不是**「已准入」也**不是**「已核验」）；`--report` 仍恒以 0 结束。

### 12.5 运行方式与自检覆盖

```bash
# 12.1 核验仓库外固定 commit 检出（本机实测 verdict=external-audit-ready，退出码 0）
node services/ruoyi-api/toolchain/check-capability.mjs \
  --audit-root "D:\ruoyi-audit\RuoYi-Vue-springboot3-current" \
  --audit-commit a51a838b71b446ea27256900efe7ed2faa2a02fd

# 12.2 同时比对声明的输入摘要（固定 commit 中根 pom.xml 内容字节的 SHA-256）
node services/ruoyi-api/toolchain/check-capability.mjs \
  --audit-root "D:\ruoyi-audit\RuoYi-Vue-springboot3-current" \
  --audit-commit a51a838b71b446ea27256900efe7ed2faa2a02fd \
  --audit-pom-sha256 16bf030a8e4c79c978bbf11eb6f6e18475771c10f4708d9e62e219480a172c9a

# 12.3 机器可读输出（summary / statements / preconditions / audit.git / audit.pom）
node services/ruoyi-api/toolchain/check-capability.mjs --audit-root "..." --audit-commit "..." --json
```

自检（`--self-test`，只用合成输入：不读磁盘、不执行任何命令、**不为测试创建源码或 `pom.xml`**——审计根、`.git`、工作树状态、HEAD 与 pom 摘要全部由纯函数注入）覆盖：合法外部审计目录 → `external-audit-ready`；仓库内路径、边界目录内、仓库上级目录、文件系统根 → 被阻断（违规）；短 SHA → 参数层用法错误（64）与判定层被阻断；HEAD 不匹配、工作树不干净（含**只增加未跟踪生成物**）→ 被阻断（违规）；缺 `HEAD:pom.xml` → 被阻断；符号链接逃逸回仓库、声明摘要不一致或形状非法 → 被阻断（违规）；无 `.git`、审计根不是目录 → 被阻断；隔离不通过时不执行任何 git 命令；**在合法输入上叠加仓库内 `gate-manifest.json` 的 `stage=admitted` 不改变判定**（证明确实不读仓库内门禁状态）；以及 64 项单元检查（严格 40 位 SHA 解析、严格 porcelain 解析与 fail-closed、路径包含关系与大小写、文件系统根、`..` 段、隔离规则、verdict 契约与 3 项 NIST SHA-256 向量）。每一例都同时断言 `admitted`/`verified` 恒为 `false`。

本机实测（2026-10-08，可复现）：`D:\ruoyi-audit\RuoYi-Vue-springboot3-current` 的 `HEAD=a51a838b71b446ea27256900efe7ed2faa2a02fd`、工作树干净、`HEAD:pom.xml` 内容 SHA-256 为 `16bf030a…`、blob SHA-1 为 `699a3bcc…`，因此 8/8 前置满足，`verdict=external-audit-ready`（退出码 0；报告中 `admitted=verified=false`）——**同一时刻仓库内 `check-gate.mjs` 的 `stage` 仍是 `pre-poc-gate`（默认模式退出码 2）**，正好证明审计模式不依赖仓库内准入。同一命令指向另一条线的检出（`D:\ruoyi-audit\RuoYi-Vue-0e2d75c2`，`HEAD=0e2d75c2…`）判被阻断（违规，退出码 1）；指向仓库内路径（如 `services`）、边界目录 `services/ruoyi-api` 或仓库上级目录（如 `D:\WorkSpace`）判被阻断（违规，退出码 1；隔离不通过时一条 git 命令都不执行）；指向仓库外非 Git 目录（如系统临时目录）判被阻断（退出码 2）；`--audit-commit` 只给 12 位短 SHA、给分支名、`--audit-root` 给相对路径或含 `..` 段判用法错误（退出码 64）。另在系统临时目录（仓库之外）用 `git init` 造了一个一次性固定 pin 检出做端到端复核（这是本模式的真实输入形态，**不是自检的一部分**；自检本身不创建任何文件）：干净 + 声明的输入摘要 → `external-audit-ready`（0）；换成另一个 40 位 SHA → 被阻断（1）；修改已跟踪的 `pom.xml` → 被阻断（1，点名该文件）；只在检出里新增未跟踪的 `sbom.cyclonedx.json` → 同样被阻断（1，未跟踪文件也算不干净，提示把生成物写到检出目录之外）。运行前后审计检出的 `.git/index` 与 `.git/HEAD` mtime 不变，证明核验本身不写任何文件。这些都是本机实测，不是声明。

### 12.6 隔离目录可先生成哪些证据、回填到哪（`sbom` 已统一，其余四项待统一）

真实证据可以在仓库外的隔离检出**之外**生成（生成时记录工具与版本、输入锁定文件、生成时间与实例版本），但**回填前路径必须统一**，且每个证据项的唯一目标路径以 `provenance-manifest.json` 的 `evidence[].path` 为准。核验在**开始生成之前**跑：核验通过后，构建/生成过程可能让检出不再干净（例如 Maven 写 `target/`），这时的「前置可执行」结论不再成立（需重新核验），但已记录的固定 commit 与根 `pom.xml` 内容摘要仍然可复核。

| 证据项                 | 怎么生成（检出保持干净）                               | 回填目标路径（唯一）                                                   |
| ---------------------- | ------------------------------------------------------ | ---------------------------------------------------------------------- |
| SBOM（CycloneDX）      | 用 Maven CycloneDX 插件或 SBOM 工具对已锁定依赖生成    | `services/ruoyi-api/compliance/provenance/sbom.cyclonedx.json`         |
| 漏洞扫描               | 扫描已锁定依赖清单或已生成的 SBOM，逐项记录处置结论    | `services/ruoyi-api/compliance/provenance/vulnerability-scan.md`       |
| PostgreSQL 兼容性      | 在隔离 PostgreSQL 实例验证 DDL、分页、时间、事务与回滚 | `services/ruoyi-api/compliance/provenance/postgresql-compatibility.md` |
| 许可证/NOTICE          | 在隔离检出里核对候选 LICENSE/NOTICE 原文与摘要         | `services/ruoyi-api/compliance/provenance/license-notice.md`           |
| 候选来源（commit/tag） | 在隔离检出里核对 commit、tag、来源仓库与抓取时间       | `services/ruoyi-api/compliance/provenance/candidate-commit-tag.md`     |

- **回填路径必须与两条清单一致**：唯一目标路径以 `provenance-manifest.json` 的 `evidence[].path` 为准（上表）；`gate-manifest.json` 的 `complianceArtifacts` 是**并列的另一条清单**（记的是准入门禁用的合规产物），两条清单必须指向同一份证据文件——其中 `sbom` 已统一为 `services/ruoyi-api/compliance/provenance/sbom.cyclonedx.json`。其余四项（`license` / `notice` / `dependency-licenses` / `vulnerability-scan`）在两条清单里记的仍是不同的文件或粒度（例如准入门禁记「原文副本」，证据清单记「证据说明文档」），回填前必须逐项裁定并统一，**不得让同一份证据出现两条路径**。核对方式：分别运行 `node services/ruoyi-api/toolchain/check-gate.mjs --json` 与 `node services/ruoyi-api/toolchain/check-provenance.mjs --json`，逐项比对两份报告里的路径。
- 回填后逐项给出 `fileSha256` 与内容标记（如 SBOM 的 `bomFormat`/`specVersion`/`components`），由 `check-provenance.mjs` 判定；证据状态只能由实际核验推进，不能为了过检查器预先写成 `verified`。
- 摘要口径要写明字节流：外部审计模式报告的是**固定 commit 中 `pom.xml` 的内容字节**（`git show HEAD:pom.xml`，LF）的 SHA-256 与 blob SHA-1，并在给出 `--audit-pom-sha256` 时与之比对；本机 `core.autocrlf=true` 时工作区检出字节（CRLF）的 SHA-256 可能不同（§10.2 已记录 LICENSE 的两种摘要），登记证据时必须注明采用哪一种字节流。
- **只允许由真实外部审计产物回填**：这些文件必须是仓库外固定 commit 检出上**实际执行**工具/实例产出的字节（SBOM 必须是工具生成的 CycloneDX，不是手写组件列表）。**不得**由本仓库内的脚本生成、预填、推测或手写；能力探测（§11）与外部审计前置核验（本节）的结论都**不是**证据，不能充当回填来源。
- **NOTICE 处置已记录为 `absent-upstream` / `not-applicable`，但 `license-notice` 仍保持 `pending`**：候选提交全树（477 个条目）里不存在 `NOTICE` / `NOTICE.txt` / `COPYING` / `COPYRIGHT`，唯一的许可类文件是根 `LICENSE`（MIT），因此「NOTICE 缺失」这一项按 **absent-upstream**（上游本就不存在）记录、并按 **not-applicable**（无第三方 NOTICE 可再分发）处置；这**不等于**许可证证据已就位——`license-notice` 在**仓库外受控目录的 LICENSE 原文证据**与**非实施方的独立复核署名**完成之前一律保持 `pending`（理由与解除条件见 §10.3），也不因本模式而提前推进。

### 12.7 仍然保留的阻断与禁入（本模式不解除）

- **最终 tag 缺失仍是阻断**：候选 `springboot3` 分支头提交（`a51a838b…`）至今没有任何对应 tag，按 §3.2「固定 commit 必须同时固定 tag」的规则，候选仍保持**未冻结**，准入前置 `candidate-commit` 仍为 `pending`，`gate-manifest.json` 的 `stage` 仍为 `pre-poc-gate`（§10）。外部审计模式只让「先生成证据」这一步可以先走，不解除冻结条件，也不把候选标记为已固定。
- **仓库内 `pom.xml`/Java 仍禁入**：`services/ruoyi-api` 内仍不得出现 `pom.xml`、Maven 包装脚本、Java/Kotlin 源码与 RuoYi 源码副本（§2、§3.1）。外部审计目录里的 `pom.xml` 属于**仓库外**检出，不计入也不改变本仓库的边界判定。
- 本模式不改变五项证据的状态、不改变两份清单的 `stage`、不替代许可证复核与独立安全/架构评审，也不构成任何 `admitted`/`verified` 声明。

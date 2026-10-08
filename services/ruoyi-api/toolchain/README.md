# ruoyi-api 工具链与准入门禁（公开检查器）

> 状态：POC 准入前置切片。本目录只有**清单与只读检查器**，不含 Java 源码、`pom.xml`、Maven 依赖或任何 RuoYi 文件副本，也不声明可构建、可运行或生产就绪。

## 1. 本目录内容

| 文件                 | 用途                                                             | 静态校验                                            |
| -------------------- | ---------------------------------------------------------------- | --------------------------------------------------- |
| `README.md`          | 门禁语义、探测方式与运行方式说明                                 | 人工评审（本文件不参与自动校验）                    |
| `check-gate.mjs`     | 公开只读检查器（仅用 Node 内置模块，不联网、不下载、不写仓库）   | 自身即检查入口，见 §5；`--self-test` 内置 32 项自检 |
| `gate-manifest.json` | 工具链最低要求、禁止项、候选 commit 占位、准入前置与合规产物清单 | 结构、占位语义与磁盘一致性校验（§3）                |

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

## 3. 检查项

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

## 4. 本机工具链探测方式

JDK 与 Maven 的候选按 `JAVA_HOME/bin`、`MAVEN_HOME`/`M2_HOME/bin`、`PATH` 顺序解析（Windows 兼容 `java.exe`、`mvn.cmd`），逐个按三级方式取版本：

1. **管道捕获**：`spawnSync` 读取子进程输出（普通终端与 CI 的常规路径）；
2. **临时文件句柄回退**：受限沙箱会以 `EPERM` 阻止管道捕获子进程输出。此时把子进程输出重定向到系统临时目录中的一个文件句柄，读完立即删除；该文件在仓库之外，内容由子进程写入，本模块自身不写入任何文件内容；
3. **静态版本文件回退**：直接读取 JDK 安装目录的 `release` 文件（`JAVA_VERSION`）或 Maven 的 `lib/maven-core-<version>.jar` 文件名。

保证：只执行 `java -version` / `mvn -v` 这类纯查询参数，**绝不**执行任何构建目标；不联网、不安装、不下载依赖；探测不确定时按 fail-closed 视为未达标。

## 5. 运行方式

```bash
# 5.1 主门禁（任意工作目录可执行；失败时退出码 1/2，按 §2 判定）
node services/ruoyi-api/toolchain/check-gate.mjs
cd services/ruoyi-api/toolchain && node check-gate.mjs

# 5.2 机器可读输出（JSON：summary、violations、blockers、exitCode）
node services/ruoyi-api/toolchain/check-gate.mjs --json

# 5.3 信息性运行：始终退出码 0，便于在未准入机器上采集报告
node services/ruoyi-api/toolchain/check-gate.mjs --report

# 5.4 判定规则自检：32 项合成场景，不读磁盘、不执行探测
node services/ruoyi-api/toolchain/check-gate.mjs --self-test
```

`--self-test` 覆盖的合成场景包括：准入前置齐备时通过；门禁前出现 `pom.xml`/Java 源码/RuoYi 源码副本/`src/main/java`；候选 commit 为短 SHA 或分支名；`resolved` 与 `commit` 不一致；固定 commit 未固定 tag；未固定原因与未满足前置不一致；`stage=admitted` 仍有未满足前置；合规产物状态与磁盘不一致；JDK 8 与 Maven 3.8.8 不达标、Maven/JDK 未安装；清单版本非 semver；工具链要求被下调；禁止项清单被清空；清单缺失；以及导入白名单/网络模块/内部文档引用/相对导入四类源码策略。

本机当前状态（核验记录）：`java -version` 为 `1.8.0_501`，未安装 Maven，因此主门禁**按设计**返回「未准入」（退出码 2），阻断项为「JDK 版本不达标」「Maven 未找到」；此时本目录不含 `pom.xml`，也没有 Java 源码。

## 6. 与既有校验器的关系

| 检查器                     | 范围                                                                  | 输出              |
| -------------------------- | --------------------------------------------------------------------- | ----------------- |
| `contracts/validate.mjs`   | 公开契约：夹具结构、授权场景重放、OpenAPI 字段与 `$ref`、枚举交叉核对 | 失败退出 1        |
| `toolchain/check-gate.mjs` | 准入门禁：工具链可用性、候选 commit 占位、禁止项与合规产物状态        | 1 违规 / 2 未准入 |

两者互补且都只用 Node 内置模块、都不联网、都不写仓库；契约校验回答「契约是否自洽」，本检查器回答「现在是否允许开始写 Java」。

## 7. 边界与非目标

- 本目录不保存 RuoYi 源码、候选 POM 副本、依赖锁定文件或构建产物；候选观测值、哈希与许可证原文保存在本地内部审计记录中，不进入公开目录。
- 不声明可构建、可运行或生产就绪；不替代人工架构/安全评审与许可证复核。
- 不做网络检索，不把网页结果当作合规证据；不修改、不覆盖 `services/api`（NestJS 回滚基线）与既有数据迁移。
- `--self-test` 使用合成输入，不代表本机实测结论；结论只以默认模式（或 `--json`）的输出为准。

## 8. 版本规则

- 清单 `manifestVersion` 为 semver；非破坏性新增递增次版本，字段语义或闸门收紧属破坏性变更，需提升主/次版本并在本文件记录兼容性说明。
- 禁止下调 `toolchain` 的最低要求（JDK 17+ / Maven 3.9+）或关闭边界开关：检查器会直接判为清单非法。

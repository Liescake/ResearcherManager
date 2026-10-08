# RuoYi-Vue 本地只读核验报告

> 核验对象：`https://gitee.com/y_project/RuoYi-Vue.git`
> 指定分支/版本语义：`springboot3/v3.9.2/commit 0e2d75c23c0d7a1fa85f660f06a59a4dd1ba14c0`
> 核验时间：2026-10-08（本机时间，具体时间见命令输出）
> 核验性质：本地只读获取与证据采集；源码未复制到本仓库，未修改 `services/api`。

## 1. 获取与完整性

- 临时审计目录：`D:\ruoyi-audit\RuoYi-Vue-0e2d75c2`
- 获取命令：`git clone --no-checkout https://gitee.com/y_project/RuoYi-Vue.git D:\ruoyi-audit\RuoYi-Vue-0e2d75c2`；随后 `git fetch --depth 1 origin 0e2d75c23c0d7a1fa85f660f06a59a4dd1ba14c0`、`git checkout --detach 0e2d75c23c0d7a1fa85f660f06a59a4dd1ba14c0`。
- `git rev-parse HEAD`：`0e2d75c23c0d7a1fa85f660f06a59a4dd1ba14c0`。
- `git tag --points-at HEAD`：`v3.9.2`。
- 审计目录远程：`https://gitee.com/y_project/RuoYi-Vue.git`。
- 顶层存在 `pom.xml`、`ruoyi-admin`、`ruoyi-common`、`ruoyi-framework`、`ruoyi-generator`、`ruoyi-quartz`、`ruoyi-system` 和 `sql`。
- `LICENSE` SHA-256：`46973D260EABEAF43DF2478BF00DACF862911988EBA72387596FCAFBC4888CAB`。
- 顶层 `pom.xml` SHA-256：`AF0B7D7BA95F91EFD109BD42CA7F52E9C9168D2EDCB033B5DEBD1E0AE16C0B23`。

## 2. 许可证与 NOTICE

- `LICENSE` 明确为 MIT License，版权行是 `Copyright (c) 2018 RuoYi`，并要求副本或重要部分保留版权和许可声明。
- 未发现顶层 `NOTICE` 文件（按 `Get-ChildItem -Recurse -Include LICENSE,NOTICE,license,notice,README*` 检查；命中 LICENSE 和 README 文件）。
- 本次未完成传递依赖许可证清单；不得据此宣称整体许可证合规。正式引入前需生成依赖许可证/NOTICE 清单并复核第三方声明。

## 3. 版本、JDK、Spring 与构建配置

从该提交顶层 `pom.xml` 实测：

- `java.version=17`。
- `spring-boot.version=4.0.3`。
- `mybatis-spring-boot.version=4.0.1`。
- README 标示项目为 RuoYi-Vue `v3.9.2`，并说明存在 Spring Boot 2.x/3.x/4.x 并行分支；README 将 `springboot3` 标为 Spring Boot 3.x、JDK 17+。
- **重要不一致**：指定提交的当前 POM 实际解析为 Spring Boot 4.0.3、Druid Spring Boot 4 starter；不能把该提交直接称为 Spring Boot 3 基线。若目标是 `springboot3`，必须按该分支的实际 commit 重新获取并核对 SHA/POM。
- 顶层包含 Maven `pom.xml`，但本机未发现 `mvn` 命令；本机 `java -version` 为 Java 8 (`1.8.0_501`)，低于该提交 POM 要求的 JDK 17。因此本次未完成 Maven 编译、测试、依赖树或 SBOM。

## 4. 数据库与 PostgreSQL 兼容性

- `ruoyi-admin/pom.xml` 实测包含 `com.mysql:mysql-connector-j`，未发现 PostgreSQL JDBC 驱动证据。
- `sql/ry_20260320.sql` 和 `sql/quartz.sql` 实测包含 MySQL 特有语法/特征：`engine=innodb`、`auto_increment`、`bigint(20)`、`datetime`、列级 `comment`、反引号等。
- 因此不能直接宣称 PostgreSQL 兼容；需替换 JDBC 驱动、配置和分页/SQL 方言，并在 PostgreSQL 实例执行完整迁移与测试。
- 本次未执行 SQL 导入，因为当前环境未确认 PostgreSQL 实例和迁移工具可用。

## 5. 安全配置观察

- README 实测说明后端采用 Spring Security、Redis 和 JWT。
- POM 实测包含 Spring Security 与 JJWT 依赖。
- 本次未启动应用，未验证默认账号、JWT 密钥来源、Redis 密码、CORS、上传限制、日志脱敏、生产 profile 或默认密码。因此这些项目均为缺失证据，不得视为已安全配置。
- RuoYi 菜单/角色/数据权限不能直接替代本项目 `SELF/GROUP/ASSIGNED/SYSTEM/GLOBAL` 资源谓词；需在业务 Service/Interceptor 层另行实现并测试。

## 6. 依赖树、SBOM、漏洞与许可证证据

- 尝试命令：`mvn -q -DskipTests dependency:tree -DoutputFile=D:\ruoyi-audit\dependency-tree.txt`。
- 真实结果：失败，当前 Windows 环境未安装或未配置 `mvn`（`mvn: 术语 'mvn' 不会被识别`）。
- 因此本报告不伪造依赖树、SBOM、漏洞或传递依赖许可证结果；这些证据仍缺失。
- 后续需在 JDK 17 + Maven 环境中运行 Maven dependency tree、CycloneDX SBOM、漏洞扫描和许可证扫描，并保留原始输出及工具版本。

## 7. 当前结论与阻断

- 已核实：远程获取成功，HEAD 与指定 SHA 一致，指向 `v3.9.2` tag，LICENSE 为 MIT，源码位于仓库外临时目录。
- **阻断**：指定路径语义中的 `springboot3` 与该提交实际 POM 的 Spring Boot 4.0.3 不一致；不能直接作为 Spring Boot 3 依赖基线。
- **阻断**：本机只有 Java 8，无 Maven，无法完成构建、依赖树、SBOM、漏洞和许可证闭环。
- **阻断**：提交内置 MySQL 驱动和 MySQL SQL，PostgreSQL 兼容性未通过，需 POC 改造与实测。
- 当前没有 RuoYi 源码进入 `D:\WorkSpace\ReseacherManager`，没有修改 `services/api`，没有提交或推送本次核验报告。

## 8. 后续建议

1. 使用 JDK 17+ 和 Maven，重新核验实际 `springboot3` 分支的目标 commit，而不是仅凭 v3.9.2 tag 判断。
2. 先完成许可证/NOTICE、依赖许可证、SBOM、漏洞扫描和默认安全配置审查。
3. 单独建立 PostgreSQL POC，验证系统表、分页、时间类型、索引、事务和 MySQL 方言迁移。
4. POC 通过后，才创建 `services/ruoyi-api`；现有 `services/api` 保留为回滚基线。

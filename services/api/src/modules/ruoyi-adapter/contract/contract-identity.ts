/**
 * 契约标识常量（services/ruoyi-api → services/api 边界）。
 *
 * 刻意与夹具读取器分开：运行期代码（适配器、端口、Nest 模块）只依赖本文件，
 * 因此**不需要** `node:fs`/`node:path`，文件读取只发生在测试/评审流程中。
 */

export const AUTHZ_CONTRACT_FILE = 'authz-fixtures.json';

/** 契约标识：适配器用它声明自己镜像的是哪个版本的授权夹具 */
export const AUTHZ_CONTRACT_ID = 'researcher-manager.authz-fixtures';

/** 契约版本：必须等于 authz-fixtures.json 的 contractVersion */
export const AUTHZ_CONTRACT_VERSION = '0.1.0';

/** 相对仓库根；仓库根按「同时存在 package.json 与 pnpm-workspace.yaml」判定 */
export const AUTHZ_CONTRACT_RELATIVE_PATH = 'services/ruoyi-api/contracts/authz-fixtures.json';

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  AUTHZ_CONTRACT_FILE,
  AUTHZ_CONTRACT_ID,
  AUTHZ_CONTRACT_RELATIVE_PATH,
  AUTHZ_CONTRACT_VERSION,
} from './contract-identity';
import type { AuthzFixturesContract } from './authz-fixtures';

/**
 * `authz-fixtures.json` 的**读取器**（只在测试/评审流程中使用）。
 *
 * 与 `authz-fixtures.ts` 分开的原因：运行期代码只依赖契约标识与类型，
 * 因此 NestJS 应用启动路径不会引入 `node:fs`/`node:path`。
 *
 * 契约不可达时**不静默跳过**：读取器抛错，测试随之失败，
 * 避免出现「测试通过但契约其实没被读到」的假阳性。
 */

export {
  AUTHZ_CONTRACT_FILE,
  AUTHZ_CONTRACT_ID,
  AUTHZ_CONTRACT_RELATIVE_PATH,
  AUTHZ_CONTRACT_VERSION,
};

/** 已知仓库根缓存：避免每个夹具重复判定文件系统 */
let cachedRepoRoot: string | undefined;

/** 从起始目录向上查找仓库根（package.json + pnpm-workspace.yaml 同时存在） */
export function findRepoRoot(startDir: string = process.cwd()): string | undefined {
  if (cachedRepoRoot !== undefined) return cachedRepoRoot;
  let current = resolve(startDir);
  for (;;) {
    const hasManifest = existsSync(resolve(current, 'package.json'));
    const hasWorkspace = existsSync(resolve(current, 'pnpm-workspace.yaml'));
    if (hasManifest && hasWorkspace) {
      cachedRepoRoot = current;
      return current;
    }
    const parent = resolve(current, '..');
    if (parent === current) return undefined;
    current = parent;
  }
}

/** 解析契约夹具的绝对路径；找不到仓库根时返回 undefined（调用方应显式失败而不是伪造结论） */
export function resolveAuthzContractPath(startDir?: string): string | undefined {
  const root = findRepoRoot(startDir);
  if (!root) return undefined;
  const path = resolve(root, AUTHZ_CONTRACT_RELATIVE_PATH);
  return existsSync(path) ? path : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parseAuthzFixturesContract(text: string): AuthzFixturesContract {
  const parsed: unknown = JSON.parse(text);
  if (!isRecord(parsed))
    throw new Error(`authz 契约夹具必须是 JSON 对象（${AUTHZ_CONTRACT_FILE}）`);
  if (!Array.isArray(parsed.fixtures) || !Array.isArray(parsed.grantFixtures)) {
    throw new Error(`authz 契约夹具缺少 fixtures / grantFixtures 数组（${AUTHZ_CONTRACT_FILE}）`);
  }
  if (!isRecord(parsed.enums)) {
    throw new Error(`authz 契约夹具缺少 enums 快照（${AUTHZ_CONTRACT_FILE}）`);
  }
  if (parsed.contract !== AUTHZ_CONTRACT_ID) {
    throw new Error(
      `authz 契约标识不匹配：期望 ${AUTHZ_CONTRACT_ID}，实际 ${String(parsed.contract)}`,
    );
  }
  if (parsed.contractVersion !== AUTHZ_CONTRACT_VERSION) {
    throw new Error(
      `authz 契约版本不匹配：期望 ${AUTHZ_CONTRACT_VERSION}，实际 ${String(parsed.contractVersion)}`,
    );
  }
  return parsed as unknown as AuthzFixturesContract;
}

export function readAuthzFixturesContract(startDir?: string): AuthzFixturesContract {
  const path = resolveAuthzContractPath(startDir);
  if (!path) {
    throw new Error(`未找到公开契约夹具 ${AUTHZ_CONTRACT_RELATIVE_PATH}（请在仓库内运行契约测试）`);
  }
  return parseAuthzFixturesContract(readFileSync(path, 'utf8'));
}

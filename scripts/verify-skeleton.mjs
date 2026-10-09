#!/usr/bin/env node
/**
 * 工程骨架自检：验证 monorepo 关键目录、必需文件、工作区声明、工作区包元数据与根脚本是否齐全。
 *
 * 边界：
 * - 只使用 node: 内置模块，不联网、不写文件，可在本地与公开检出（CI）反复执行；
 * - 固定扫描的三份**内部**权限/契约文档（见 .gitignore，仅本机保留）只在存在时读取，
 *   缺失时只提示、不崩溃；无论是否存在，输出都只包含文件相对路径、固定检查项名称与
 *   判定结论，**不把文档内容写入输出**。
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const REQUIRED_DIRECTORIES = [
  'apps/miniapp',
  'apps/admin-web',
  'services/api',
  'packages/shared',
  'packages/ai-adapter',
  'db/migrations',
  'scripts',
];

/**
 * 仅本机保留的内部文档目录（内容见 .gitignore，不随仓库分发）。
 * 公开检出里可以不存在，因此缺失只提示、不判失败。
 */
const LOCAL_ONLY_DIRECTORIES = ['docs'];

const REQUIRED_FILES = [
  'package.json',
  'pnpm-workspace.yaml',
  'tsconfig.base.json',
  '.env.example',
  '.prettierignore',
  'eslint.config.mjs',
  'README.md',
  'apps/admin-web/index.html',
  'apps/admin-web/src/App.tsx',
  'apps/miniapp/src/app.json',
  'apps/miniapp/src/app.ts',
  'services/api/src/main.ts',
  'services/api/src/modules/health/health.controller.ts',
  'packages/shared/src/index.ts',
  'packages/ai-adapter/src/index.ts',
  'db/migrations/README.md',
];

const WORKSPACE_PACKAGES = [
  { dir: 'packages/shared', name: '@rm/shared' },
  { dir: 'packages/ai-adapter', name: '@rm/ai-adapter' },
  { dir: 'services/api', name: '@rm/api' },
  { dir: 'apps/admin-web', name: '@rm/admin-web' },
  { dir: 'apps/miniapp', name: '@rm/miniapp' },
];

const REQUIRED_ROOT_SCRIPTS = [
  'lint',
  'lint:fix',
  'format:check',
  'typecheck',
  'build',
  'test',
  'verify:skeleton',
  'verify:migrations',
  'verify:docker',
];

/**
 * 必须被 pnpm-workspace.yaml 声明的成员入口。
 *
 * 这里刻意**不**要求 `apps/*` 通配：仓库有意用显式条目声明应用（见 pnpm-workspace.yaml 注释，
 * 避免把未评估目录纳入 workspace），因此只要求「每个必需成员被显式声明或被通配覆盖」。
 */
const REQUIRED_WORKSPACE_ENTRIES = ['packages/*', 'services/*', 'apps/admin-web'];

const failures = [];
const warnings = [];

function readJson(relativePath) {
  const absolutePath = join(repoRoot, relativePath);
  try {
    return JSON.parse(readFileSync(absolutePath, 'utf8'));
  } catch (error) {
    failures.push(`无法解析 ${relativePath}: ${error.message}`);
    return null;
  }
}

/** 解析 pnpm-workspace.yaml 的 `packages:` 列表（缩进式子集，支持引号与注释） */
function parseWorkspaceEntries(yaml) {
  const entries = [];
  let inPackages = false;
  for (const rawLine of yaml.split('\n')) {
    const line = rawLine.replace(/\s+$/u, '');
    if (/^packages:\s*$/u.test(line)) {
      inPackages = true;
      continue;
    }
    if (!inPackages) {
      continue;
    }
    if (/^\S/u.test(line)) {
      // 下一个顶层键：packages 段结束
      inPackages = false;
      continue;
    }
    if (/^\s*#/u.test(line) || line.trim() === '') {
      continue;
    }
    const item = /^\s*-\s*(.+)$/u.exec(line);
    if (item) {
      entries.push(item[1].trim().replace(/^['"]|['"]$/gu, ''));
    }
  }
  return entries;
}

/** 某个目录是否被工作区条目覆盖：要么完全相同，要么被 `*` 通配覆盖（`*` 不跨越路径分隔符） */
function isWorkspaceMember(entries, directory) {
  return entries.some((entry) => {
    if (entry === directory) {
      return true;
    }
    if (!entry.includes('*')) {
      return false;
    }
    const pattern = entry
      .split('*')
      .map((part) => part.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'))
      .join('[^/]*');
    return new RegExp(`^${pattern}$`, 'u').test(directory);
  });
}

for (const directory of REQUIRED_DIRECTORIES) {
  if (!existsSync(join(repoRoot, directory))) {
    failures.push(`缺少目录: ${directory}/`);
  }
}

for (const directory of LOCAL_ONLY_DIRECTORIES) {
  if (!existsSync(join(repoRoot, directory))) {
    warnings.push(`缺少内部文档目录（公开检出正常，已跳过相关扫描）: ${directory}/`);
  }
}

for (const file of REQUIRED_FILES) {
  if (!existsSync(join(repoRoot, file))) {
    failures.push(`缺少文件: ${file}`);
  }
}

const rootPackage = readJson('package.json');
if (rootPackage) {
  for (const script of REQUIRED_ROOT_SCRIPTS) {
    if (!rootPackage.scripts?.[script]) {
      failures.push(`根 package.json 缺少脚本: ${script}`);
    }
  }
  if (rootPackage.private !== true) {
    failures.push('根 package.json 必须为 private，避免误发布到 npm');
  }
}

const workspaceYaml = existsSync(join(repoRoot, 'pnpm-workspace.yaml'))
  ? readFileSync(join(repoRoot, 'pnpm-workspace.yaml'), 'utf8')
  : '';
const workspaceEntries = parseWorkspaceEntries(workspaceYaml);
for (const entry of REQUIRED_WORKSPACE_ENTRIES) {
  if (!isWorkspaceMember(workspaceEntries, entry)) {
    failures.push(`pnpm-workspace.yaml 缺少工作区声明: ${entry}`);
  }
}

for (const { dir, name } of WORKSPACE_PACKAGES) {
  const packageJson = readJson(join(dir, 'package.json'));
  if (!packageJson) {
    continue;
  }
  if (packageJson.name !== name) {
    failures.push(`${dir}/package.json 的 name 应为 ${name}，实际为 ${packageJson.name}`);
  }
  if (packageJson.private !== true) {
    failures.push(`${dir}/package.json 必须为 private`);
  }
  if (!packageJson.scripts?.typecheck) {
    failures.push(`${dir}/package.json 缺少 typecheck 脚本`);
  }
  if (!isWorkspaceMember(workspaceEntries, dir)) {
    warnings.push(`${dir} 未纳入 workspace（其目录与 package.json 仍被本自检校验）`);
  }
}

const apiMain = join(repoRoot, 'services/api/src/main.ts');
if (existsSync(apiMain) && !readFileSync(apiMain, 'utf8').includes('API_PREFIX')) {
  warnings.push('services/api/src/main.ts 未使用统一 API_PREFIX 常量');
}

const envExample = join(repoRoot, '.env.example');
if (existsSync(envExample)) {
  const content = readFileSync(envExample, 'utf8');
  for (const key of ['DATABASE_URL', 'API_PORT', 'VITE_API_BASE_URL', 'AI_MATCHING_ENABLED']) {
    if (!content.includes(`${key}=`)) {
      warnings.push(`.env.example 缺少变量说明: ${key}`);
    }
  }
}

const localOnlyDocs = ['需求.txt', '要求.txt', 'AI开发计划表.md', '计划表待确认问题清单.md'];
const legacyPermissionTokens = [
  'audit:delete',
  'export:*',
  'membership:self:apply',
  'membership:group:review',
];
for (const relativePath of [
  'docs/P1-权限矩阵.md',
  'docs/P2-权限目录与状态机.md',
  'docs/P2-API契约基线.md',
]) {
  const absolutePath = join(repoRoot, relativePath);
  if (!existsSync(absolutePath)) {
    warnings.push(`无法执行已废弃权限字符串扫描（内部文档不在工作区）: ${relativePath}`);
    continue;
  }
  const content = readFileSync(absolutePath, 'utf8');
  for (const token of legacyPermissionTokens) {
    if (content.includes(token)) {
      failures.push(`${relativePath} 包含已废弃权限字符串: ${token}`);
    }
  }
}
for (const doc of localOnlyDocs) {
  if (!existsSync(join(repoRoot, doc))) {
    warnings.push(`本地文档不存在（可能已被移出工作区）: ${doc}`);
  }
}

console.log('工程骨架自检');
console.log(`- 仓库根目录: ${repoRoot}`);
console.log(`- 必需目录: ${REQUIRED_DIRECTORIES.length} 项`);
console.log(`- 必需文件: ${REQUIRED_FILES.length} 项`);
console.log(`- 工作区包: ${WORKSPACE_PACKAGES.map((item) => item.name).join(', ')}`);

if (warnings.length > 0) {
  console.log(`\n提示 (${warnings.length})`);
  for (const warning of warnings) {
    console.log(`  ~ ${warning}`);
  }
}

if (failures.length > 0) {
  console.error(`\n失败 (${failures.length})`);
  for (const failure of failures) {
    console.error(`  x ${failure}`);
  }
  process.exitCode = 1;
} else {
  console.log('\n结果: 通过');
}

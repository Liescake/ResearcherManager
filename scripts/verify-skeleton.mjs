#!/usr/bin/env node
/**
 * 工程骨架自检：验证 monorepo 关键目录、必需文件、工作区声明、工作区包元数据与根脚本是否齐全。
 *
 * 边界：
 * - 只使用 node: 内置模块，不联网、不写文件，可在本地与公开检出（CI）反复执行；
 * - 内部分档（docs/P1、P2、P3、需求/要求/计划表）只在存在时读取，缺失时只提示、不崩溃；
 *   无论是否存在，输出都只包含文件相对路径、固定检查项名称与判定结论，**不把文档内容写入输出**；
 * - `apps/miniapp` 是**可选本地切片**：公开策略明确它不纳入 workspace，本轮也不提交，
 *   因此其目录、入口文件与包元数据缺失时只提示、不判失败；一旦存在仍按必需包同样校验，
 *   不会因为「可选」而放过真实错误。
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** 公开检出（CI / 纯净检出 / 纯净 git archive 产物）必须存在的目录。 */
const REQUIRED_DIRECTORIES = [
  'apps/admin-web',
  'services/api',
  'packages/shared',
  'packages/ai-adapter',
  'db/migrations',
  'scripts',
];

/**
 * 可选本地切片目录（微信小程序学生端）。
 *
 * 公开策略已明确：`apps/miniapp` **不纳入 workspace**、本轮**不提交**，
 * 只作为本机先行开发的切片保留。因此公开检出里不存在属预期，缺失只提示、不判失败。
 * 对应地，`apps/*` 通配与 `REQUIRED_WORKSPACE_ENTRIES` 都刻意不覆盖它。
 */
const OPTIONAL_LOCAL_DIRECTORIES = ['apps/miniapp'];

/**
 * 仅本机保留的内部文档目录（内容见 .gitignore，不随仓库分发）。
 * 公开检出里可以不存在，因此缺失只提示、不判失败。
 */
const LOCAL_ONLY_DIRECTORIES = ['docs'];

/** 公开必需的根级与成员文件。 */
const REQUIRED_FILES = [
  'package.json',
  'pnpm-workspace.yaml',
  'tsconfig.base.json',
  '.prettierignore',
  'eslint.config.mjs',
  'README.md',
  'apps/admin-web/index.html',
  'apps/admin-web/src/App.tsx',
  'services/api/src/main.ts',
  'services/api/src/modules/health/health.controller.ts',
  'packages/shared/src/index.ts',
  'packages/ai-adapter/src/index.ts',
  'db/migrations/README.md',
];

/** 可选本地切片入口文件：与 miniapp 目录同样处理，缺失只提示。 */
const OPTIONAL_LOCAL_FILES = ['apps/miniapp/src/app.json', 'apps/miniapp/src/app.ts'];

/** 公开必需的工作区包：缺失 package.json 一律失败。 */
const WORKSPACE_PACKAGES = [
  { dir: 'packages/shared', name: '@rm/shared' },
  { dir: 'packages/ai-adapter', name: '@rm/ai-adapter' },
  { dir: 'services/api', name: '@rm/api' },
  { dir: 'apps/admin-web', name: '@rm/admin-web' },
];

/**
 * 可选本地切片包：缺失只提示；存在时仍校验 name / private / typecheck，
 * 并提示其未纳入 workspace（这是公开策略要求的状态，不是缺陷）。
 */
const OPTIONAL_LOCAL_PACKAGES = [{ dir: 'apps/miniapp', name: '@rm/miniapp' }];

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
 * 这里刻意**不**要求 `apps/*` 通配，也刻意**不**列入 `apps/miniapp`：仓库有意用显式条目
 * 声明应用（见 pnpm-workspace.yaml 注释，避免把未评估目录纳入 workspace），
 * 因此只要求「每个必需成员被显式声明或被通配覆盖」。
 */
const REQUIRED_WORKSPACE_ENTRIES = ['packages/*', 'services/*', 'apps/admin-web'];

/**
 * 公开环境模板：`.gitignore` 用 `!.env.example` 显式反选保留（第三章「只允许提交示例模板」），
 * 它记录了 API_PORT / DATABASE_URL / VITE_* / AI 开关等必需配置键，属于**公开安全基线**的一部分。
 *
 * 判定：保持**硬性必需**，缺失即失败。正确处置是把该模板**单独提交**（例如 `git add .env.example`
 * 后独立提交），而不是把它降级为可选——放宽会让「缺少环境模板」的公开检出直接通过门禁，
 * 属于凭空放宽安全模板要求。脚本只能给出可执行的补救提示，不能代替提交动作。
 */
const PUBLIC_ENV_TEMPLATE = '.env.example';

/** 公开环境模板必须包含的变量键：缺失只提示（不影响失败判定，避免文案差异误伤）。 */
const PUBLIC_ENV_TEMPLATE_KEYS = [
  'DATABASE_URL',
  'API_PORT',
  'VITE_API_BASE_URL',
  'AI_MATCHING_ENABLED',
];

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

/**
 * 校验一个包的元数据。
 *
 * - 必需包缺少 package.json → 失败；
 * - 可选本地切片缺少 package.json → 只提示（公开检出未提交 miniapp 属预期）；
 * - 包存在时，两类包都按同一套规则校验，可选切片不会豁免真实错误。
 */
function verifyPackageMetadata({ dir, name }, { optional = false } = {}) {
  const relativePath = `${dir}/package.json`;
  if (!existsSync(join(repoRoot, relativePath))) {
    if (optional) {
      warnings.push(
        `缺少可选本地切片文件（本轮不提交 apps/miniapp，公开检出缺失属预期）: ${relativePath}`,
      );
    } else {
      failures.push(`缺少文件: ${relativePath}`);
    }
    return;
  }
  const packageJson = readJson(relativePath);
  if (!packageJson) {
    return;
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

for (const directory of REQUIRED_DIRECTORIES) {
  if (!existsSync(join(repoRoot, directory))) {
    failures.push(`缺少目录: ${directory}/`);
  }
}

for (const directory of OPTIONAL_LOCAL_DIRECTORIES) {
  if (!existsSync(join(repoRoot, directory))) {
    warnings.push(
      `缺少可选本地切片目录（本轮不提交 apps/miniapp，公开检出缺失属预期）: ${directory}/`,
    );
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

for (const file of OPTIONAL_LOCAL_FILES) {
  if (!existsSync(join(repoRoot, file))) {
    warnings.push(`缺少可选本地切片文件（本轮不提交 apps/miniapp，公开检出缺失属预期）: ${file}`);
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

for (const workspacePackage of WORKSPACE_PACKAGES) {
  verifyPackageMetadata(workspacePackage);
}

for (const localPackage of OPTIONAL_LOCAL_PACKAGES) {
  verifyPackageMetadata(localPackage, { optional: true });
}

const apiMain = join(repoRoot, 'services/api/src/main.ts');
if (existsSync(apiMain) && !readFileSync(apiMain, 'utf8').includes('API_PREFIX')) {
  warnings.push('services/api/src/main.ts 未使用统一 API_PREFIX 常量');
}

const envExample = join(repoRoot, PUBLIC_ENV_TEMPLATE);
if (!existsSync(envExample)) {
  failures.push(
    `缺少公开环境模板: ${PUBLIC_ENV_TEMPLATE}（属公开安全基线，请单独提交该模板，不要降级为可选）`,
  );
} else {
  const content = readFileSync(envExample, 'utf8');
  for (const key of PUBLIC_ENV_TEMPLATE_KEYS) {
    if (!content.includes(`${key}=`)) {
      warnings.push(`${PUBLIC_ENV_TEMPLATE} 缺少变量说明: ${key}`);
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
console.log(`- 可选本地切片目录: ${OPTIONAL_LOCAL_DIRECTORIES.join(', ')}（缺失只提示，不判失败）`);
console.log(`- 必需文件: ${REQUIRED_FILES.length} 项`);
console.log(`- 可选本地切片文件: ${OPTIONAL_LOCAL_FILES.length} 项（缺失只提示，不判失败）`);
console.log(`- 必需工作区包: ${WORKSPACE_PACKAGES.map((item) => item.name).join(', ')}`);
console.log(
  `- 可选本地切片包（不纳入 workspace）: ${OPTIONAL_LOCAL_PACKAGES.map((item) => item.name).join(', ')}`,
);

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

#!/usr/bin/env node
/**
 * Docker 打包静态门禁（公开、零依赖：只用 `node:` 内置模块，不联网、不写文件、不需要
 * Docker 守护进程，可在本地与 CI 反复执行）。
 *
 * 为什么需要它：镜像/编排的正确性大多只能在「构建+运行」时暴露，而 CI 与受限沙箱里都没有
 * 可用的 Docker 守护进程。本脚本把**可以从文件本身判定的事实**固化成断言，避免这类回归：
 *   - `Dockerfile` 的工作区构建顺序（工作区依赖必须先构建，否则 api 编译报找不到 @rm/*）；
 *   - 容器启动入口（`CMD` 必须指向 `services/api/package.json` 声明的 `main` 对应产物）；
 *   - 健康检查路径必须跟随 `API_PREFIX`，不能硬编码（历史缺陷：先 init 再 setGlobalPrefix，
 *     构建产物只服务无前缀路径，容器永远不健康）；
 *   - 凭据不得有内置默认值、机密字段必须保持占位符形态、证书只挂载路径；
 *   - 生产档必须 `verify-full` + 只读挂载证书 + 显式拒绝明文连接。
 *
 * 判定：全部通过 → 退出码 0；任一断言失败 → 退出码 1（逐条打印失败原因）。
 * `--self-test`：只用内存中的合成样本验证解析器与判定规则本身（不读磁盘），
 * 全部通过 → 退出码 0，失败 → 退出码 1。用于防止「门禁自己坏掉却报通过」。
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// ---------------------------------------------------------------------------
// 纯解析工具（可被 --self-test 独立驱动）
// ---------------------------------------------------------------------------

/** 取 YAML 里某个顶层块的所有行（`key:` 之后到下一个顶层键之前） */
export function collectTopLevelSection(text, key) {
  const lines = text.split(/\r?\n/u);
  const out = [];
  let inSection = false;
  const start = new RegExp(`^${key}:(\\s.*)?$`, 'u');
  for (const line of lines) {
    if (!inSection) {
      if (start.test(line)) {
        inSection = true;
      }
      continue;
    }
    if (/^\S/u.test(line)) {
      break;
    }
    out.push(line);
  }
  return out;
}

/** 把 `services:` 块拆成 `服务名 -> 该服务的块文本`（缩进式 YAML 子集，够用于本项目编排） */
export function serviceBlocks(composeText) {
  const section = collectTopLevelSection(composeText, 'services');
  const raw = new Map();
  let current = null;
  for (const line of section) {
    const name = /^ {2}([A-Za-z0-9_.-]+):\s*$/u.exec(line);
    if (name !== null) {
      current = name[1];
      raw.set(current, []);
      continue;
    }
    if (current !== null) {
      raw.get(current).push(line);
    }
  }
  const blocks = new Map();
  for (const [name, lines] of raw) {
    blocks.set(name, lines.join('\n'));
  }
  return blocks;
}

/** 去掉 YAML 注释行（注释里的 `${VAR:?...}` 不会被 Compose 求值，不能当成必填声明） */
export function stripYamlComments(text) {
  return text
    .split(/\r?\n/u)
    .filter((line) => !line.trimStart().startsWith('#'))
    .join('\n');
}

/**
 * 解析 Compose 变量插值。
 * 返回 `{ name, operator }`：operator ∈ `required` | `defaulted` | `plain`。
 *   ${VAR:?msg} / ${VAR?msg}  → required（缺失即解析失败，fail-closed）
 *   ${VAR:-x} / ${VAR-x}      → defaulted（缺失时用默认值）
 *   ${VAR}                    → plain
 */
export function parseInterpolations(text) {
  const results = [];
  const pattern = /\$\{([A-Za-z_][A-Za-z0-9_]*)(:?[-?])?([^}]*)\}/gu;
  for (const match of text.matchAll(pattern)) {
    const operator =
      match[2] === ':?' || match[2] === '?'
        ? 'required'
        : match[2] !== undefined
          ? 'defaulted'
          : 'plain';
    results.push({ name: match[1], operator, defaultValue: match[3] ?? '' });
  }
  return results;
}

/** 解析 .env 风格文件为 Map（只认 `KEY=VALUE`，忽略注释与空行） */
export function parseEnvFile(text) {
  const entries = new Map();
  for (const line of text.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) {
      continue;
    }
    const eq = line.indexOf('=');
    if (eq <= 0) {
      continue;
    }
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1);
    }
    entries.set(key, value);
  }
  return entries;
}

/** 机密类键名判定（用于「不得有默认值」「必须是占位符」两类断言） */
export function isSecretKey(key) {
  return /PASSWORD|SECRET|API_KEY|DATABASE_URL|EVIDENCE|READINESS|CHECKED_BY|VERIFIED_BY/u.test(
    key,
  );
}

/** 占位符判定：公开模板里的机密字段只允许这种形态 */
export function isPlaceholderValue(value) {
  if (value === '') {
    return true;
  }
  return /change-me|REPLACE-ME|replace-with/iu.test(value);
}

/** 高熵线索：出现 PEM 块或超长无分隔随机串即认为「疑似真实密钥」 */
export function looksLikeRealSecret(text) {
  if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/u.test(text)) {
    return '包含 PEM 私钥块';
  }
  if (/\b(?:sk|pk)-[A-Za-z0-9_-]{20,}\b/u.test(text)) {
    return '包含疑似 API Key（sk-/pk- 前缀）';
  }
  const longToken = /\b[A-Za-z0-9+/]{40,}={0,2}\b/u.exec(text);
  if (longToken !== null) {
    return `包含疑似高熵令牌（${longToken[0].slice(0, 12)}…）`;
  }
  return null;
}

// ---------------------------------------------------------------------------
// 断言收集
// ---------------------------------------------------------------------------

const failures = [];
const warnings = [];

function check(condition, message) {
  if (!condition) {
    failures.push(message);
  }
  return condition;
}

function readTextOrNull(relativePath) {
  const absolute = join(repoRoot, relativePath);
  if (!existsSync(absolute)) {
    return null;
  }
  return readFileSync(absolute, 'utf8');
}

function readJsonOrNull(relativePath) {
  const text = readTextOrNull(relativePath);
  if (text === null) {
    return null;
  }
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** 逐条检查一个编排文件；`mode` 为 `dev` 或 `prod` */
function checkCompose(fileName, mode) {
  const text = readTextOrNull(fileName);
  if (text === null) {
    failures.push(`缺少编排文件 ${fileName}`);
    return;
  }

  const services = serviceBlocks(text);
  const names = [...services.keys()].sort();
  check(
    names.join(',') === 'api,postgres',
    `${fileName} 必须只定义 api 与 postgres 两个服务（当前: ${names.join(',') || '无'}）`,
  );

  const networksSection = collectTopLevelSection(text, 'networks').join('\n');
  check(networksSection.trim() !== '', `${fileName} 必须显式声明 networks（api 与 postgres 共用）`);
  const volumesSection = collectTopLevelSection(text, 'volumes').join('\n');
  check(volumesSection.includes('rm-postgres-data'), `${fileName} 必须声明具名卷 rm-postgres-data`);

  const postgres = services.get('postgres') ?? '';
  const api = services.get('api') ?? '';
  // 插值只在**非注释行**上解析：注释里的 ${VAR:?...} 不参与 Compose 求值
  const postgresCode = stripYamlComments(postgres);
  const apiCode = stripYamlComments(api);

  for (const [name, block] of [
    ['postgres', postgres],
    ['api', api],
  ]) {
    check(/healthcheck:/u.test(block), `${fileName} 的 ${name} 服务必须定义 healthcheck`);
    check(
      /networks:\s*\n\s*-\s*rm-internal/u.test(block),
      `${fileName} 的 ${name} 服务必须接入显式网络 rm-internal`,
    );
  }

  // ---- postgres ----
  check(
    /rm-postgres-data:\/var\/lib\/postgresql\/data/u.test(postgres),
    `${fileName}: postgres 数据必须落在具名卷上`,
  );
  check(/pg_isready/u.test(postgres), `${fileName}: postgres healthcheck 必须用 pg_isready`);

  const postgresInterpolations = parseInterpolations(postgresCode);
  for (const key of ['POSTGRES_USER', 'POSTGRES_PASSWORD']) {
    const found = postgresInterpolations.find((item) => item.name === key);
    check(found !== undefined, `${fileName}: postgres 必须通过环境变量提供 ${key}（无默认值）`);
    check(
      found === undefined || found.operator === 'required',
      `${fileName}: ${key} 必须声明为必填（\${${key}:?...}），不得有内置默认值`,
    );
  }

  // ---- api ----
  check(/context:\s*\./u.test(api), `${fileName}: api 构建上下文必须是仓库根（context: .）`);
  check(/dockerfile:\s*Dockerfile/u.test(api), `${fileName}: api 必须使用仓库根 Dockerfile`);
  check(
    /depends_on:[\s\S]{0,240}?postgres:[\s\S]{0,240}?condition:\s*service_healthy/u.test(apiCode),
    `${fileName}: api 必须 depends_on postgres 且 condition: service_healthy`,
  );
  check(
    /scripts\/docker-healthcheck\.mjs/u.test(api),
    `${fileName}: api healthcheck 必须复用 scripts/docker-healthcheck.mjs（不硬编码路径）`,
  );
  check(
    /API_HOST:\s*"?0\.0\.0\.0"?/u.test(api),
    `${fileName}: api 必须显式监听 0.0.0.0（容器内回环不可达）`,
  );

  const apiInterpolations = parseInterpolations(apiCode);
  const sessionSecret = apiInterpolations.find((item) => item.name === 'SESSION_SECRET');
  check(
    sessionSecret !== undefined && sessionSecret.operator === 'required',
    `${fileName}: SESSION_SECRET 必须声明为必填（\${SESSION_SECRET:?...}），不得有内置默认值`,
  );

  // 机密类插值不得带**非空**默认值（`${X:-}` 这种「空默认」表示可选，是允许的）；
  // 凭据/会话密钥/连接串则必须声明为必填，彻底没有默认值。
  const requiredSecretKeys = new Set([
    'POSTGRES_USER',
    'POSTGRES_PASSWORD',
    'SESSION_SECRET',
    'DATABASE_URL',
  ]);
  for (const item of [...postgresInterpolations, ...apiInterpolations]) {
    if (
      isSecretKey(item.name) &&
      item.operator === 'defaulted' &&
      item.defaultValue.trim() !== ''
    ) {
      failures.push(
        `${fileName}: 机密类变量 ${item.name} 不得带非空默认值（\${${item.name}:-${item.defaultValue}}）`,
      );
    }
  }
  if (mode === 'prod') {
    for (const item of apiInterpolations) {
      if (requiredSecretKeys.has(item.name) && item.operator !== 'required') {
        failures.push(`${fileName}: ${item.name} 在生产档必须声明为必填（\${${item.name}:?...}）`);
      }
    }
  }

  if (mode === 'dev') {
    check(
      /仅本机|仅本地|本地开发/u.test(text),
      `${fileName}: 必须在文件头明确标注「仅本机/本地开发」适用范围`,
    );
    check(
      /DATABASE_SSL_MODE:\s*disable/u.test(api),
      `${fileName}: 本地开发档必须显式 DATABASE_SSL_MODE: disable（安全默认是 require）`,
    );
    check(
      /\/docker-entrypoint-initdb\.d:ro/u.test(postgres),
      `${fileName}: 初始化脚本（额外建集成测试库）必须以只读方式挂载`,
    );
    check(
      /ports:\s*\n/u.test(postgres) || /\n\s+ports:/u.test(postgres),
      `${fileName}: 本地开发档需要把 postgres 端口发布到宿主机（集成测试从宿主机连接）`,
    );
    check(
      /\$\{POSTGRES_PORT/u.test(postgres),
      `${fileName}: 本地开发档 postgres 端口必须用 \${POSTGRES_PORT:-...} 声明（默认 55432 避开宿主机 5432）`,
    );
  }

  if (mode === 'prod') {
    check(
      !/docker-entrypoint-initdb\.d/u.test(postgres),
      `${fileName}: 生产档不得挂载初始化脚本（它会在生产库里创建 *_test 数据库）`,
    );
    check(/NODE_ENV:\s*production/u.test(api), `${fileName}: api 必须 NODE_ENV=production`);
    check(
      /DATABASE_SSL_MODE:\s*verify-full\s*$/mu.test(api),
      `${fileName}: api 必须写死 DATABASE_SSL_MODE: verify-full（不可用环境变量降级）`,
    );
    check(
      !/DATABASE_SSL_MODE:.*\$\{/u.test(api),
      `${fileName}: DATABASE_SSL_MODE 不得由环境变量插值（生产不允许降级 TLS）`,
    );
    const databaseUrl = apiInterpolations.find((item) => item.name === 'DATABASE_URL');
    check(
      databaseUrl !== undefined && databaseUrl.operator === 'required',
      `${fileName}: DATABASE_URL 必须声明为必填`,
    );
    for (const key of [
      'DATABASE_EXECUTOR_EVIDENCE_ID',
      'DATABASE_EXECUTOR_VERIFIED_BY',
      'DATABASE_EXECUTOR_VERIFIED_AT',
      'DATABASE_EXECUTOR_EVIDENCE_REF',
      'DATABASE_EXECUTOR_EVIDENCE_METHOD',
      'DATABASE_SCHEMA_READINESS_ID',
      'DATABASE_SCHEMA_CHECKED_BY',
      'DATABASE_SCHEMA_CHECKED_AT',
      'DATABASE_SCHEMA_READINESS_REF',
      'DATABASE_MIGRATION_AVAILABLE_VERSIONS',
      'DATABASE_MIGRATION_APPLIED_VERSIONS',
    ]) {
      const item = apiInterpolations.find((entry) => entry.name === key);
      check(
        item !== undefined && item.operator === 'required',
        `${fileName}: 取证事实 ${key} 必须声明为必填（缺失就要 fail-closed）`,
      );
    }
    check(
      postgres.includes('RM_TLS_DIR') && postgres.includes('/etc/rm-tls:ro'),
      `${fileName}: postgres 必须把证书目录只读挂载到 /etc/rm-tls`,
    );
    check(
      api.includes('RM_TLS_DIR') && api.includes('/etc/rm-tls:ro'),
      `${fileName}: api 必须把证书目录只读挂载到 /etc/rm-tls`,
    );
    check(
      /DATABASE_SSL_CA_PATH:\s*"\/etc\/rm-tls\//u.test(api),
      `${fileName}: api 必须登记 CA 的容器内绝对路径`,
    );
    // 生产不把数据库端口发布到宿主机
    check(
      !/^\s{4}ports:/mu.test(postgres),
      `${fileName}: 生产档不得把 postgres 端口发布到宿主机（应使用编排网络内的 expose）`,
    );
    check(/ssl=on/u.test(postgres), `${fileName}: postgres 必须启用 ssl=on`);
    check(/hba_file=/u.test(postgres), `${fileName}: postgres 必须用 hba_file 强制只接受 TLS 连接`);
    check(
      /ssl_cert_file=|\/etc\/rm-tls\/server\.crt/u.test(postgres),
      `${fileName}: postgres 必须登记服务端证书路径`,
    );
  }
}

/** 检查 Dockerfile（构建顺序、入口、健康检查、非 root、无内置机密） */
function checkDockerfile() {
  const text = readTextOrNull('Dockerfile');
  if (text === null) {
    failures.push('缺少 Dockerfile');
    return;
  }
  const apiManifest = readJsonOrNull('services/api/package.json');
  const rootManifest = readJsonOrNull('package.json');

  for (const stage of ['AS deps', 'AS build', 'AS runtime']) {
    check(text.includes(stage), `Dockerfile 必须包含多阶段构建：${stage}`);
  }
  check(/COPY\s+\.\s+\./u.test(text), 'Dockerfile 必须整体拷入仓库根上下文（monorepo 构建前提）');
  check(
    /pnpm install --frozen-lockfile/u.test(text),
    'Dockerfile 必须用 --frozen-lockfile 安装（锁文件可复现）',
  );
  check(/USER\s+node\b/u.test(text), 'Dockerfile 运行阶段必须以非 root 用户启动（USER node）');
  check(
    /HEALTHCHECK[\s\S]*scripts\/docker-healthcheck\.mjs/u.test(text),
    'Dockerfile 的 HEALTHCHECK 必须复用 scripts/docker-healthcheck.mjs',
  );

  // 工作区构建顺序：@rm/api 的每个 workspace 依赖都必须先被构建
  const apiWorkspaceDeps = Object.entries(apiManifest?.dependencies ?? {})
    .filter(([, version]) => typeof version === 'string' && version.startsWith('workspace:'))
    .map(([name]) => name);
  const buildPackages = rootManifest?.scripts?.['build:packages'] ?? '';
  for (const dep of apiWorkspaceDeps) {
    check(
      buildPackages.includes(dep),
      `root package.json 的 build:packages 必须包含 @rm/api 的工作区依赖 ${dep}`,
    );
  }
  const packagesIndex = text.indexOf('pnpm build:packages');
  const apiBuildIndex = text.indexOf('pnpm --filter @rm/api build');
  check(
    packagesIndex !== -1 && apiBuildIndex !== -1 && packagesIndex < apiBuildIndex,
    'Dockerfile 必须先构建工作区包（pnpm build:packages），再构建 @rm/api',
  );

  // 容器启动入口：CMD 必须指向 @rm/api 的 main 所对应的构建产物
  const apiEntry = apiManifest?.main;
  check(
    typeof apiEntry === 'string' && apiEntry !== '',
    'services/api/package.json 必须声明 main 入口',
  );
  if (typeof apiEntry === 'string') {
    const expectedCmd = `services/api/${apiEntry}`;
    // 只取**行首**的 CMD：`HEALTHCHECK ... CMD [...]` 里的 CMD 不是启动入口
    const cmdMatch = /^CMD\s+\[([^\]]*)\]/mu.exec(text);
    check(cmdMatch !== null, 'Dockerfile 必须用 exec 形式的 CMD 声明启动入口');
    const cmdTokens = (cmdMatch?.[1] ?? '')
      .split(',')
      .map((token) => token.trim().replace(/^"|"$/gu, ''));
    check(
      cmdTokens.includes(expectedCmd),
      `Dockerfile 的 CMD 必须包含 ${expectedCmd}（= services/api 的 main 产物），当前: ${cmdTokens.join(' ') || '无'}`,
    );
    // 构建产物是否存在只作提示：`pnpm verify` 在 CI 里先于 `pnpm build` 运行，
    // 干净检出时 dist 本来就不存在，把它当作失败会让门禁误报。
    if (!existsSync(join(repoRoot, 'services/api', apiEntry.replace(/^\.\//u, '')))) {
      warnings.push(
        `容器启动入口产物尚未构建：services/api/${apiEntry}（先执行 pnpm build；CI 中 verify 早于 build，属正常）`,
      );
    }
  }

  // 不得把机密固化进镜像
  for (const line of text.split(/\r?\n/u)) {
    if (/^\s*(ARG|ENV)\s+.*(PASSWORD|SECRET|API_KEY|TOKEN)/iu.test(line)) {
      failures.push(`Dockerfile 不得通过 ARG/ENV 固化机密：${line.trim()}`);
    }
  }
  check(
    !/COPY\s+.*\.(pem|key)\b/u.test(text),
    'Dockerfile 不得把证书/私钥拷进镜像（应运行时挂载）',
  );
}

/** 检查健康探针脚本本身 */
function checkHealthcheckScript() {
  const text = readTextOrNull('scripts/docker-healthcheck.mjs');
  if (text === null) {
    failures.push('缺少 scripts/docker-healthcheck.mjs');
    return;
  }
  const imports = [...text.matchAll(/from\s+'([^']+)'/gu)].map((match) => match[1]);
  for (const specifier of imports) {
    check(
      specifier.startsWith('node:'),
      `scripts/docker-healthcheck.mjs 只允许 node: 内置模块（发现 ${specifier}）`,
    );
  }
  check(
    /API_PREFIX/u.test(text),
    'scripts/docker-healthcheck.mjs 必须跟随 API_PREFIX，不得硬编码路径',
  );
  check(
    /process\.exit\(0\)/u.test(text) && /process\.exit\(1\)/u.test(text),
    'scripts/docker-healthcheck.mjs 必须用退出码 0/1 表达健康与否',
  );
  const code = text
    .split(/\r?\n/u)
    .filter((line) => !/^\s*(?:\*|\/\/|#)/u.test(line))
    .join('\n');
  check(
    !/\/api\/v1\/health/u.test(code),
    'scripts/docker-healthcheck.mjs 不得在代码里硬编码 /api/v1/health 路径（注释里的缺陷说明不算）',
  );
}

/** 检查公开环境变量模板：无真实密钥，且覆盖生产档所有必填变量 */
function checkEnvTemplate() {
  const text = readTextOrNull('.env.docker.example');
  if (text === null) {
    failures.push('缺少 .env.docker.example');
    return;
  }
  const secretClue = looksLikeRealSecret(text);
  check(secretClue === null, `.env.docker.example 疑似含真实密钥：${secretClue ?? ''}`);

  const entries = parseEnvFile(text);
  for (const [key, value] of entries) {
    if (isSecretKey(key)) {
      check(
        isPlaceholderValue(value),
        `.env.docker.example 的机密类字段 ${key} 必须是明确占位符（change-me / REPLACE-ME），当前: ${value === '' ? '(空)' : '(非占位符)'}`,
      );
    }
  }

  // 生产档里所有 `${VAR:?}` 必填变量都必须在模板里出现，否则 config 无法渲染
  // （注释行不算：注释里的 ${VAR:?...} 不参与 Compose 求值）
  const prod = stripYamlComments(readTextOrNull('docker-compose.prod.yml') ?? '');
  for (const item of parseInterpolations(prod)) {
    if (item.operator === 'required') {
      check(entries.has(item.name), `.env.docker.example 必须提供生产档必填变量 ${item.name}`);
    }
  }
}

/** 检查只读 TLS 认证规则文件 */
function checkPgHba() {
  const text = readTextOrNull('db/docker/prod/pg_hba.conf');
  if (text === null) {
    failures.push('缺少 db/docker/prod/pg_hba.conf');
    return;
  }
  check(/^hostssl\s/mu.test(text), 'pg_hba.conf 必须允许 hostssl（只有 TLS 连接可用）');
  check(
    /^hostnossl\s.*reject\s*$/mu.test(text),
    'pg_hba.conf 必须显式 reject 明文（hostnossl）连接',
  );
}

/** 检查忽略规则：模板可提交、证书与真实 .env 必须排除 */
function checkIgnoreFiles() {
  const gitignore = readTextOrNull('.gitignore');
  const dockerignore = readTextOrNull('.dockerignore');
  check(gitignore !== null, '缺少 .gitignore');
  check(dockerignore !== null, '缺少 .dockerignore');
  if (gitignore !== null) {
    check(
      gitignore.includes('!.env.docker.example'),
      '.gitignore 必须显式放行公开模板 .env.docker.example',
    );
    check(
      /^\*\.pem$/mu.test(gitignore) && /^\*\.key$/mu.test(gitignore),
      '.gitignore 必须排除 *.pem / *.key',
    );
    check(/^\/certs\/$/mu.test(gitignore), '.gitignore 必须排除本地证书目录 /certs/');
  }
  if (dockerignore !== null) {
    check(
      dockerignore.includes('!.env.docker.example'),
      '.dockerignore 必须放行 .env.docker.example',
    );
    check(
      /\*\.pem/u.test(dockerignore) && /\*\.key/u.test(dockerignore),
      '.dockerignore 必须排除 *.pem / *.key',
    );
    check(/\*\*\/dist/u.test(dockerignore), '.dockerignore 必须排除构建产物 **/dist');
    check(
      /^\.env$/mu.test(dockerignore) && /^\.env\.\*$/mu.test(dockerignore),
      '.dockerignore 必须排除真实 .env / .env.*',
    );
  }
}

/** 两份编排的交叉一致性：服务集合与具名卷必须一致，且不得残留旧文件名 */
function checkComposeCrossConsistency() {
  const dev = readTextOrNull('docker-compose.yml');
  const prod = readTextOrNull('docker-compose.prod.yml');
  if (dev === null || prod === null) {
    return;
  }
  const devServices = [...serviceBlocks(dev).keys()].sort().join(',');
  const prodServices = [...serviceBlocks(prod).keys()].sort().join(',');
  check(
    devServices === prodServices,
    `两份编排的服务集合必须一致（dev=${devServices} prod=${prodServices}）`,
  );

  for (const volume of ['rm-postgres-data']) {
    check(
      collectTopLevelSection(dev, 'volumes').join('\n').includes(volume) &&
        collectTopLevelSection(prod, 'volumes').join('\n').includes(volume),
      `两份编排必须声明同一个具名卷 ${volume}`,
    );
  }

  if (existsSync(join(repoRoot, 'compose.yaml'))) {
    failures.push(
      '检测到遗留的 compose.yaml：与 docker-compose.yml 并存会产生两份互相漂移的编排，请只保留一份',
    );
  }
}

function report() {
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
}

// ---------------------------------------------------------------------------
// --self-test：只验证解析器与判定规则本身（不读磁盘、不依赖仓库内容）
// ---------------------------------------------------------------------------

function selfTest() {
  const cases = [];
  const expect = (name, actual, expected) => {
    const ok = JSON.stringify(actual) === JSON.stringify(expected);
    cases.push({ name, ok, actual, expected });
  };

  expect(
    'collectTopLevelSection 只取目标块',
    collectTopLevelSection('a: 1\nservices:\n  x:\n    b: 2\nvolumes:\n  v:\n', 'services'),
    ['  x:', '    b: 2'],
  );
  expect(
    'serviceBlocks 拆分服务（含空行与注释）',
    [...serviceBlocks('services:\n  a:\n    x: 1\n\n    # c\n  b:\n    y: 2\n').keys()],
    ['a', 'b'],
  );
  expect(
    'parseInterpolations 区分必填/默认/普通',
    parseInterpolations('${A:?m} ${B:-d} ${C} ${D?m} ${E-d}').map(
      (item) => `${item.name}:${item.operator}`,
    ),
    ['A:required', 'B:defaulted', 'C:plain', 'D:required', 'E:defaulted'],
  );
  expect(
    'parseEnvFile 去引号与注释',
    [...parseEnvFile('# c\nA=1\nB="x y"\nC=\n')],
    [
      ['A', '1'],
      ['B', 'x y'],
      ['C', ''],
    ],
  );
  expect(
    'isSecretKey 命中机密字段',
    [isSecretKey('POSTGRES_PASSWORD'), isSecretKey('LOG_LEVEL')],
    [true, false],
  );
  expect(
    'isPlaceholderValue 只接受占位符/空值',
    [
      isPlaceholderValue('change-me-db-password'),
      isPlaceholderValue('REPLACE-ME-evidence-id'),
      isPlaceholderValue(''),
      isPlaceholderValue('s3cr3t-Actual-Password'),
    ],
    [true, true, true, false],
  );
  expect(
    'looksLikeRealSecret 捕获 PEM/长令牌',
    [
      looksLikeRealSecret('-----BEGIN RSA PRIVATE KEY-----\nMIIE'),
      looksLikeRealSecret('token=ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmn0123456789'),
      looksLikeRealSecret('POSTGRES_PASSWORD=change-me'),
    ],
    ['包含 PEM 私钥块', '包含疑似高熵令牌（ABCDEFGHIJKL…）', null],
  );

  const failed = cases.filter((item) => !item.ok);
  console.log('Docker 打包静态门禁 --self-test');
  console.log(`- 合成断言: ${cases.length} 项`);
  for (const item of failed) {
    console.error(
      `  x ${item.name}: 期望 ${JSON.stringify(item.expected)}，实际 ${JSON.stringify(item.actual)}`,
    );
  }
  console.log(failed.length === 0 ? '\n结果: 通过' : `\n结果: 失败 (${failed.length})`);
  if (failed.length > 0) {
    process.exitCode = 1;
  }
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

if (process.argv.includes('--self-test')) {
  selfTest();
} else {
  console.log('Docker 打包静态门禁');
  console.log(`- 仓库根目录: ${repoRoot}`);
  checkDockerfile();
  checkHealthcheckScript();
  checkCompose('docker-compose.yml', 'dev');
  checkCompose('docker-compose.prod.yml', 'prod');
  checkComposeCrossConsistency();
  checkEnvTemplate();
  checkPgHba();
  checkIgnoreFiles();
  report();
}

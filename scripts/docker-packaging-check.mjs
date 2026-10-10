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
 *   - 生产档必须 `verify-full` + 只读挂载证书 + 显式拒绝明文连接；
 *   - 生产档容器加固必须逐条显式声明：`read_only: true`、`cap_drop: [ALL]`、
 *     `security_opt: no-new-privileges:true`、显式非 root 的 `user`、只读根下**必要**的 tmpfs
 *     （api 没有可写路径，因此不许声明 tmpfs；postgres 只许**恰好** /run/postgresql 与 /tmp：
 *     缺失、额外路径、重复项、以及带 mount 覆盖的等价写法（如 `/tmp:ro`）一律判失败，且
 *     持久数据卷与证书目录绝不能被 tmpfs 覆盖或只读化）；
 *   - 生产档两个服务必须显式声明 `stop_grace_period`，且**解析后恰好 30 秒**：缺失（会静默
 *     回落到 Compose 缺省的 10s）、过短（如 15s，容器被提前 SIGKILL）、过长，以及非数值/
 *     不明确配置（裸数字 `30`、`${VAR}` 插值、未知或大写单位、空格分隔）一律判失败；
 *   - 生产档 api 的宿主端口**只许绑回环且恰好一条**：`ports` 必须用长语法逐项显式声明
 *     `host_ip` / `target` / `published` / `protocol`，且 `host_ip` 精确等于 `127.0.0.1`；
 *     短语法、`0.0.0.0`、`::` 这类通配地址、空 host、缺省 host_ip 与非 3000/tcp 一律判失败
 *     （Compose 对 host_ip 的缺省行为就是绑所有网卡）；发布映射的数量必须**恰好 1 条**，
 *     出现第 2 条起（即使第二条本身也写成回环合规）同样判失败：每多一条映射就多一个宿主暴露面；
 *     postgres 则不得发布任何宿主端口；
 *   - 「禁止机密进日志」：`command` / `entrypoint` / `healthcheck` 不得引用任何机密类变量
 *     （它们会出现在 `docker inspect` / `docker ps` / 容器日志里），生产档不得开 DEBUG 类变量、
 *     `LOG_LEVEL` 默认值不得是 debug/trace，健康探针不得输出或序列化 `process.env`。
 *
 * 判定：全部通过 → 退出码 0；任一断言失败 → 退出码 1（逐条打印失败原因）。
 * `--self-test`：只用内存中的合成样本验证解析器与判定规则本身（不读磁盘），
 * 全部通过 → 退出码 0，失败 → 退出码 1。用于防止「门禁自己坏掉却报通过」。
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

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
// 服务块字段解析（缩进式 YAML 子集；用于容器加固与「禁止机密进日志」断言）
// ---------------------------------------------------------------------------

/**
 * 取服务块内某个键的**整个子块文本**：键行本身 + 其后所有缩进更深的行。
 * 未声明该键时返回 `null`。用于 `healthcheck:` / `command:` 这类嵌套结构。
 */
export function readBlockField(block, key) {
  const lines = block.split(/\r?\n/u);
  const head = new RegExp(`^(\\s*)${key}:\\s*(.*)$`, 'u');
  for (let index = 0; index < lines.length; index += 1) {
    const match = head.exec(lines[index]);
    if (match === null) {
      continue;
    }
    const indent = match[1].length;
    const collected = [lines[index]];
    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      const line = lines[cursor];
      if (line.trim() === '') {
        collected.push(line);
        continue;
      }
      if ((/^(\s*)/u.exec(line)?.[1] ?? '').length <= indent) {
        break;
      }
      collected.push(line);
    }
    return collected.join('\n');
  }
  return null;
}

/** 取服务块内某个**标量**键的值（去掉包裹引号）；未声明返回 `null` */
export function readScalarField(block, key) {
  const match = new RegExp(`^\\s*${key}:\\s*(\\S.*)$`, 'mu').exec(block);
  if (match === null) {
    return null;
  }
  return unquoteValue(match[1].trim());
}

/**
 * 取服务块内某个列表键的条目（`key:` 之后缩进更深的 `- item` 行）。
 * 未声明该键返回 `null`；声明了但没有条目返回 `[]`。
 */
export function readListField(block, key) {
  const section = readBlockField(block, key);
  if (section === null) {
    return null;
  }
  const items = [];
  for (const line of section.split(/\r?\n/u).slice(1)) {
    const match = /^\s*-\s*(\S.*)$/u.exec(line);
    if (match !== null) {
      items.push(unquoteValue(match[1].trim()));
    }
  }
  return items;
}

/** 去掉包裹引号（`'x'` 与 `"x"` 在本子集里等价，单字符引号串保持原样） */
function unquoteValue(value) {
  if (
    ((value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))) &&
    value.length >= 2
  ) {
    return value.slice(1, -1);
  }
  return value;
}

/** 取 `key: value` 形态（key 必须是标识符）；不是该形态返回 `null` */
function splitInlineKeyValue(text) {
  const match = /^([A-Za-z_][A-Za-z0-9_-]*):\s*(.*)$/u.exec(text);
  if (match === null) {
    return null;
  }
  return { key: match[1], value: unquoteValue(match[2].trim()) };
}

/**
 * Compose `ports` **长语法**允许的键（本仓库只对这几个键做端口断言）。
 * 见 Compose 规范 long syntax：target / published / host_ip / protocol / mode / name / app_protocol。
 */
export const PORT_LONG_SYNTAX_KEYS = [
  'target',
  'published',
  'host_ip',
  'protocol',
  'mode',
  'name',
  'app_protocol',
];

/**
 * 解析服务块的 `ports:` 列表（缩进式 YAML 子集）。返回值：
 *   - `null`：该服务**没有**声明 `ports:`；
 *   - `[]`：声明了 `ports:` 但没有任何条目；
 *   - 条目数组，每项 `{ kind, raw, value?, fields }`：
 *       - `kind: 'long'`  → 长语法映射（`- host_ip: …` 及其后同级缩进的 target/published/…），
 *         `fields` 是键到值的映射（值已去引号，因此 `${VAR:-x}` 保留字面形态）；
 *       - `kind: 'short'` → 短语法字符串（`- "3000:3000"`、`- 127.0.0.1:3000:3000`、`- ${P}:3000`），
 *         这类写法**无法**声明 `host_ip`，`fields` 恒为空。
 * 只解析本项目编排用得到的子集：不处理 flow 映射（`- { host_ip: … }`）、锚点与多行标量。
 */
export function readPortMappings(block) {
  const section = readBlockField(block, 'ports');
  if (section === null) {
    return null;
  }
  const entries = [];
  let current = null;
  const flush = () => {
    if (current !== null) {
      entries.push(current);
      current = null;
    }
  };
  for (const line of section.split(/\r?\n/u).slice(1)) {
    if (line.trim() === '') {
      continue;
    }
    const item = /^\s*-\s*(.*)$/u.exec(line);
    if (item !== null) {
      flush();
      const body = item[1].trim();
      const inline = splitInlineKeyValue(body);
      if (inline !== null && PORT_LONG_SYNTAX_KEYS.includes(inline.key)) {
        current = { kind: 'long', raw: [line], fields: { [inline.key]: inline.value } };
      } else if (inline === null && body !== '') {
        // 短语法字符串：没有 `<标识符>: ` 前缀（含 `${VAR}:3000`、`127.0.0.1:3000:3000`、带引号的写法）
        entries.push({ kind: 'short', raw: [line], value: unquoteValue(body), fields: {} });
      } else {
        // `- key: value` 但不是已知长语法键（或空条目）：仍按长语法条目收集，
        // 让断言按「未知/缺失字段」判定，而不是被静默当成短语法漏过去。
        current = {
          kind: 'long',
          raw: [line],
          fields: inline === null ? {} : { [inline.key]: inline.value },
        };
      }
      continue;
    }
    if (current === null) {
      // 条目之外的缩进行（注释等）：忽略
      continue;
    }
    current.raw.push(line);
    const inline = splitInlineKeyValue(line.trim());
    if (inline !== null) {
      current.fields[inline.key] = inline.value;
    }
  }
  flush();
  return entries;
}

/** 是否等价于「以 root 运行」：未声明、`root`、uid 0（任意 gid）都算 */
export function isRootUser(value) {
  if (value === null || value.trim() === '') {
    return true;
  }
  const [uid] = value.split(':');
  return uid.trim() === '0' || uid.trim().toLowerCase() === 'root';
}

/**
 * 找出文本里对**机密类**变量的引用：`$VAR` / `${VAR}` / `$$VAR` / `$${VAR}` / `${VAR:?...}`
 * （`$$` 是 Compose 的转义，容器里仍会展开成同一个变量，所以必须一起查）。
 * 返回去重排序后的变量名数组。
 */
export function findSecretReferences(text) {
  const found = new Set();
  for (const match of text.matchAll(/\$\$?\{?([A-Za-z_][A-Za-z0-9_]*)/gu)) {
    if (isSecretKey(match[1])) {
      found.add(match[1]);
    }
  }
  for (const item of parseInterpolations(text)) {
    if (isSecretKey(item.name)) {
      found.add(item.name);
    }
  }
  return [...found].sort();
}

// ---------------------------------------------------------------------------
// 断言收集
// ---------------------------------------------------------------------------

function check(state, condition, message) {
  if (!condition) {
    state.failures.push(message);
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
function checkCompose(state, fileName, mode) {
  const text = readTextOrNull(fileName);
  if (text === null) {
    state.failures.push(`缺少编排文件 ${fileName}`);
    return;
  }

  const services = serviceBlocks(text);
  const names = [...services.keys()].sort();
  check(state,
    names.join(',') === 'api,postgres',
    `${fileName} 必须只定义 api 与 postgres 两个服务（当前: ${names.join(',') || '无'}）`,
  );

  const networksSection = collectTopLevelSection(text, 'networks').join('\n');
  check(state, networksSection.trim() !== '', `${fileName} 必须显式声明 networks（api 与 postgres 共用）`);
  const volumesSection = collectTopLevelSection(text, 'volumes').join('\n');
  check(state, volumesSection.includes('rm-postgres-data'), `${fileName} 必须声明具名卷 rm-postgres-data`);

  const postgres = services.get('postgres') ?? '';
  const api = services.get('api') ?? '';
  // 插值只在**非注释行**上解析：注释里的 ${VAR:?...} 不参与 Compose 求值
  const postgresCode = stripYamlComments(postgres);
  const apiCode = stripYamlComments(api);

  for (const [name, block] of [
    ['postgres', postgres],
    ['api', api],
  ]) {
    check(state, /healthcheck:/u.test(block), `${fileName} 的 ${name} 服务必须定义 healthcheck`);
    check(state,
      /networks:\s*\n\s*-\s*rm-internal/u.test(block),
      `${fileName} 的 ${name} 服务必须接入显式网络 rm-internal`,
    );
  }

  // ---- postgres ----
  check(state,
    /rm-postgres-data:\/var\/lib\/postgresql\/data/u.test(postgres),
    `${fileName}: postgres 数据必须落在具名卷上`,
  );
  check(state, /pg_isready/u.test(postgres), `${fileName}: postgres healthcheck 必须用 pg_isready`);

  const postgresInterpolations = parseInterpolations(postgresCode);
  for (const key of ['POSTGRES_USER', 'POSTGRES_PASSWORD']) {
    const found = postgresInterpolations.find((item) => item.name === key);
    check(state, found !== undefined, `${fileName}: postgres 必须通过环境变量提供 ${key}（无默认值）`);
    check(state,
      found === undefined || found.operator === 'required',
      `${fileName}: ${key} 必须声明为必填（\${${key}:?...}），不得有内置默认值`,
    );
  }

  // ---- api ----
  check(state, /context:\s*\./u.test(api), `${fileName}: api 构建上下文必须是仓库根（context: .）`);
  check(state, /dockerfile:\s*Dockerfile/u.test(api), `${fileName}: api 必须使用仓库根 Dockerfile`);
  check(state,
    /depends_on:[\s\S]{0,240}?postgres:[\s\S]{0,240}?condition:\s*service_healthy/u.test(apiCode),
    `${fileName}: api 必须 depends_on postgres 且 condition: service_healthy`,
  );
  check(state,
    /scripts\/docker-healthcheck\.mjs/u.test(api),
    `${fileName}: api healthcheck 必须复用 scripts/docker-healthcheck.mjs（不硬编码路径）`,
  );
  check(state,
    /API_HOST:\s*"?0\.0\.0\.0"?/u.test(api),
    `${fileName}: api 必须显式监听 0.0.0.0（容器内回环不可达）`,
  );

  const apiInterpolations = parseInterpolations(apiCode);
  const sessionSecret = apiInterpolations.find((item) => item.name === 'SESSION_SECRET');
  check(state,
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
      state.failures.push(
        `${fileName}: 机密类变量 ${item.name} 不得带非空默认值（\${${item.name}:-${item.defaultValue}}）`,
      );
    }
  }
  if (mode === 'prod') {
    for (const item of apiInterpolations) {
      if (requiredSecretKeys.has(item.name) && item.operator !== 'required') {
        state.failures.push(`${fileName}: ${item.name} 在生产档必须声明为必填（\${${item.name}:?...}）`);
      }
    }
  }

  if (mode === 'dev') {
    check(state,
      /仅本机|仅本地|本地开发/u.test(text),
      `${fileName}: 必须在文件头明确标注「仅本机/本地开发」适用范围`,
    );
    check(state,
      /DATABASE_SSL_MODE:\s*disable/u.test(api),
      `${fileName}: 本地开发档必须显式 DATABASE_SSL_MODE: disable（安全默认是 require）`,
    );
    check(state,
      /\/docker-entrypoint-initdb\.d:ro/u.test(postgres),
      `${fileName}: 初始化脚本（额外建集成测试库）必须以只读方式挂载`,
    );
    check(state,
      /ports:\s*\n/u.test(postgres) || /\n\s+ports:/u.test(postgres),
      `${fileName}: 本地开发档需要把 postgres 端口发布到宿主机（集成测试从宿主机连接）`,
    );
    check(state,
      /\$\{POSTGRES_PORT/u.test(postgres),
      `${fileName}: 本地开发档 postgres 端口必须用 \${POSTGRES_PORT:-...} 声明（默认 55432 避开宿主机 5432）`,
    );
  }

  if (mode === 'prod') {
    check(state,
      !/docker-entrypoint-initdb\.d/u.test(postgres),
      `${fileName}: 生产档不得挂载初始化脚本（它会在生产库里创建 *_test 数据库）`,
    );
    check(state, /NODE_ENV:\s*production/u.test(api), `${fileName}: api 必须 NODE_ENV=production`);
    check(state,
      /DATABASE_SSL_MODE:\s*verify-full\s*$/mu.test(api),
      `${fileName}: api 必须写死 DATABASE_SSL_MODE: verify-full（不可用环境变量降级）`,
    );
    check(state,
      !/DATABASE_SSL_MODE:.*\$\{/u.test(api),
      `${fileName}: DATABASE_SSL_MODE 不得由环境变量插值（生产不允许降级 TLS）`,
    );
    const databaseUrl = apiInterpolations.find((item) => item.name === 'DATABASE_URL');
    check(state,
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
      check(state,
        item !== undefined && item.operator === 'required',
        `${fileName}: 取证事实 ${key} 必须声明为必填（缺失就要 fail-closed）`,
      );
    }
    check(state,
      postgres.includes('RM_TLS_DIR') && postgres.includes('/etc/rm-tls:ro'),
      `${fileName}: postgres 必须把证书目录只读挂载到 /etc/rm-tls`,
    );
    check(state,
      api.includes('RM_TLS_DIR') && api.includes('/etc/rm-tls:ro'),
      `${fileName}: api 必须把证书目录只读挂载到 /etc/rm-tls`,
    );
    check(state,
      /DATABASE_SSL_CA_PATH:\s*"\/etc\/rm-tls\//u.test(api),
      `${fileName}: api 必须登记 CA 的容器内绝对路径`,
    );
    // 生产不把数据库端口发布到宿主机
    check(state,
      !/^\s{4}ports:/mu.test(postgres),
      `${fileName}: 生产档不得把 postgres 端口发布到宿主机（应使用编排网络内的 expose）`,
    );
    check(state, /ssl=on/u.test(postgres), `${fileName}: postgres 必须启用 ssl=on`);
    check(state, /hba_file=/u.test(postgres), `${fileName}: postgres 必须用 hba_file 强制只接受 TLS 连接`);
    check(state,
      /ssl_cert_file=|\/etc\/rm-tls\/server\.crt/u.test(postgres),
      `${fileName}: postgres 必须登记服务端证书路径`,
    );

    checkProductionHardening(state, fileName, api, postgres);
  }
}

/**
 * 生产档两个服务统一的优雅停止窗口（秒）。
 * Compose 的 `stop_grace_period` 缺省只有 10s（Docker 默认的 SIGTERM→SIGKILL 宽限期），
 * 对 postgres 的 smart shutdown 与 api 的请求收尾都偏短；超时即 SIGKILL，属非优雅终止，
 * 表现为编排层卡在停止阶段（shutdown BLOCK）。因此生产档必须显式声明且**恰好** 30 秒。
 */
export const PROD_STOP_GRACE_PERIOD_SECONDS = 30;

/**
 * 时长单位 → `[分子, 分母]`（秒）。写成有理数是为了用**除法**换算，避免 `30000 * 0.001`
 * 这类乘法在浮点下产生 30.000000000000004 的误差（`30000 / 1000` 则精确等于 30）。
 */
const DURATION_UNITS = Object.freeze({
  ns: [1, 1e9],
  us: [1, 1e6],
  µs: [1, 1e6],
  ms: [1, 1e3],
  s: [1, 1],
  m: [60, 1],
  h: [3600, 1],
});

/**
 * 严格解析 Compose 时长（`30s` / `30000ms` / `0.5m` / `1m30s`），返回秒数；无法严格解析返回 `null`。
 *
 * 「严格」= 整串必须由**带单位**的时长项紧密拼接而成（`1m30s`），不允许：
 *   - 裸数字（`30`）：Compose 对无单位值的解释无法从文件本身确定，属「不明确配置」；
 *   - 插值（`${GRACE:-30s}`）：运行时才会确定，等于没有显式声明；
 *   - 空格分隔（`30 s`）、未知单位（`30sec`）、大写单位（`30S`）：上游 `time.ParseDuration`
 *     不接受这些写法，放行它们等于让门禁通过一份运行时会被 Compose 拒绝的编排；
 *   - 负号/正号等其它前缀字符。
 * 单位只认小写（与上游一致），因此不做大小写归一。
 */
export function parseDurationSeconds(value) {
  if (typeof value !== 'string') {
    return null;
  }
  const text = value.trim();
  if (text === '' || text.includes('$')) {
    return null;
  }
  const token = /(\d+(?:\.\d+)?)(ns|us|µs|ms|s|m|h)/gu;
  let consumed = 0;
  let seconds = 0;
  let count = 0;
  let match = token.exec(text);
  while (match !== null) {
    // 中间出现未被消费的字符（裸数字前缀、空格、未知单位）即判「不明确」
    if (match.index !== consumed) {
      return null;
    }
    const [numerator, denominator] = DURATION_UNITS[match[2]];
    seconds += (Number(match[1]) * numerator) / denominator;
    consumed = token.lastIndex;
    count += 1;
    match = token.exec(text);
  }
  return count > 0 && consumed === text.length ? seconds : null;
}

/**
 * 计算生产档某个服务 `stop_grace_period` 的违规项（纯函数，供门禁与 --self-test 共用，不读磁盘）。
 * 合规时返回 `null`，否则返回 `{ kind, ... }`：
 *   - `missing`      ：未声明 / 空值 —— 会静默回落到 Compose 缺省的 10s，停机行为不可从文件读到；
 *   - `non-numeric`  ：非数值或不明确配置（无法严格解析的时长、裸数字、`${VAR}` 插值、未知/大写单位）；
 *   - `too-short`    ：解析后短于 30 秒（如 15s）—— 容器会被提前 SIGKILL，正是 shutdown BLOCK 的成因；
 *   - `too-long`     ：解析后长于 30 秒 —— 要求是「恰好 30 秒」，多给的窗口同样是偏离基线的声明。
 * 浮点比较用 1e-9 容差，使 `30000ms`、`0.5m`、`30000000us` 这些**语义等价**写法被接受。
 */
export function findStopGracePeriodIssues(value, expected = PROD_STOP_GRACE_PERIOD_SECONDS) {
  const declared = value === null || value === undefined ? '' : String(value).trim();
  if (declared === '') {
    return { kind: 'missing', expected };
  }
  const seconds = parseDurationSeconds(declared);
  if (seconds === null) {
    return { kind: 'non-numeric', value: declared, expected };
  }
  if (Math.abs(seconds - expected) < 1e-9) {
    return null;
  }
  return {
    kind: seconds < expected ? 'too-short' : 'too-long',
    seconds,
    value: declared,
    expected,
  };
}

/** 把 stop_grace_period 违规项渲染成一条人类可读的失败原因（文件名由调用方补上） */
function describeStopGracePeriodIssue(fileName, name, issue) {
  const expected = `stop_grace_period: ${PROD_STOP_GRACE_PERIOD_SECONDS}s`;
  switch (issue.kind) {
    case 'missing':
      return `${fileName}: ${name} 必须显式声明 ${expected}（当前未声明或为空值；Compose 缺省只有 10s，超时即 SIGKILL，属非优雅停止/shutdown BLOCK）`;
    case 'non-numeric':
      return `${fileName}: ${name} 的 stop_grace_period "${issue.value}" 是非数值或不明确配置，必须写成带单位的严格时长 ${expected}（裸数字与 \${VAR} 插值都会让停止窗口无法从文件确定）`;
    case 'too-short':
      return `${fileName}: ${name} 的 stop_grace_period ${issue.value} 解析后只有 ${issue.seconds} 秒，短于要求的 ${issue.expected} 秒：容器会被提前 SIGKILL，正是 shutdown BLOCK 的成因`;
    default:
      return `${fileName}: ${name} 的 stop_grace_period 必须是解析后恰好 ${issue.expected} 秒的时长，当前 ${issue.value}（= ${issue.seconds} 秒）偏长`;
  }
}

/** postgres 在只读根下**仅允许**存在的 tmpfs 目标：一个不能少，一个不能多 */
export const POSTGRES_TMPFS_TARGETS = ['/run/postgresql', '/tmp'];

/**
 * 拆分一条 tmpfs 声明（沿用本文件既有的解析语义）：
 * `target` 取第一个 `:` 之前的部分、去空白、去尾部 `/`，空串视为 `/`；
 * `override` 是 `:` 之后的 mount 选项（无覆盖时是空串）。
 */
function splitTmpfsEntry(entry) {
  const [rawTarget, ...rest] = String(entry).split(':');
  return {
    target: rawTarget.trim().replace(/\/+$/u, '') || '/',
    override: rest.join(':').trim(),
  };
}

/**
 * 计算 postgres tmpfs 声明的违规项（纯函数，供门禁与 --self-test 共用，不读磁盘）。
 * 判定「恰好 POSTGRES_TMPFS_TARGETS」的四种失败：
 *   - `missing`：必需目录没声明（保留原有的必需目录检查）；
 *   - `extraneous`：额外路径（归一化后不在白名单，含 `/` 这类覆盖全部写路径的声明）；
 *   - `duplicate`：重复项（归一化后同一个目标出现多次）；
 *   - `override`：带覆盖的等价项（目标合法，但多带了 `:ro` / `:size=…` 这类 mount 选项，
 *     例如 `:ro` 会让 postgres 需要的可写目录变成只读）。
 * 归一化沿用既有语义，因此 `/run/postgresql/` 这种等价的尾斜杠写法仍被接受。
 */
export function findPostgresTmpfsIssues(entries) {
  const issues = [];
  const seen = new Map();
  const present = new Set();
  entries.forEach((entry, index) => {
    const { target, override } = splitTmpfsEntry(entry);
    if (!POSTGRES_TMPFS_TARGETS.includes(target)) {
      issues.push({ kind: 'extraneous', index, entry, target });
      return;
    }
    present.add(target);
    if (override !== '') {
      issues.push({ kind: 'override', index, entry, target, override });
    }
    const firstIndex = seen.get(target);
    if (firstIndex === undefined) {
      seen.set(target, index);
    } else {
      issues.push({ kind: 'duplicate', index, entry, target, firstIndex });
    }
  });
  for (const target of POSTGRES_TMPFS_TARGETS) {
    if (!present.has(target)) {
      issues.push({ kind: 'missing', target });
    }
  }
  return issues;
}

/** 把 tmpfs 违规项渲染成一条人类可读的失败原因（文件名由调用方补上） */
function describePostgresTmpfsIssue(fileName, issue) {
  const allowed = POSTGRES_TMPFS_TARGETS.join(' 与 ');
  switch (issue.kind) {
    case 'missing':
      return `${fileName}: postgres 在只读根下必须在 ${issue.target} 提供 tmpfs（postgres 启动所需的最小可写目录）`;
    case 'extraneous':
      return `${fileName}: postgres 只允许 tmpfs 覆盖 ${allowed}，不得声明额外路径 ${issue.entry}（每多一个可写路径就多一个可写面）`;
    case 'duplicate':
      return `${fileName}: postgres 的 tmpfs ${issue.target} 重复声明（${issue.entry} 与第 ${issue.firstIndex + 1} 条重复）；每个目录必须恰好声明一次`;
    case 'override':
      return `${fileName}: postgres 的 tmpfs ${issue.entry} 是 ${issue.target} 的等价项，但携带了非法 mount 覆盖 ":${issue.override}"（如 :ro 会让 postgres 需要的可写目录变成只读）；只允许裸路径`;
    default:
      return `${fileName}: postgres tmpfs 声明非法（${issue.entry ?? issue.target ?? '未知'}）`;
  }
}

/**
 * 生产档 api 端口的期望声明：host_ip 只允许**精确回环**，另外三项固定。
 * 写成常量是为了让失败文案与断言共用同一份「期望事实」，避免两处漂移。
 */
export const API_PROD_PORT = Object.freeze({
  hostIp: '127.0.0.1',
  target: '3000',
  published: '${API_PORT:-3000}',
  protocol: 'tcp',
});

/**
 * 是否通配 / 「所有网卡」形态的 host_ip：覆盖 IPv4 wildcard、IPv6 wildcard（含方括号写法）、
 * 全零展开式与 `*`。去引号由解析器负责，这里再去掉 IPv6 方括号并做大小写归一。
 */
export function isWildcardHostIp(value) {
  const normalized = String(value)
    .trim()
    .replace(/^\[|\]$/gu, '')
    .toLowerCase();
  return [
    '0.0.0.0',
    '::',
    '::0',
    '0:0:0:0:0:0:0:0',
    '0000:0000:0000:0000:0000:0000:0000:0000',
    '*',
  ].includes(normalized);
}

/**
 * 计算 api **生产端口暴露面**的违规项（纯函数，供门禁与 --self-test 共用，不读磁盘）。
 *
 * 规则（每条都对应一次真实事故场景）：
 *   - `ports` 必须声明且至少一条：没有条目就没有显式绑定，暴露面不可复核；
 *   - 发布映射必须**恰好 1 条**：第 2 条起一律判失败（`too-many-entries`），**即使它本身也符合
 *     下面全部字段规则**（回环 + 3000/tcp）。理由：每多一条映射就多一个宿主暴露面，而「第二条
 *     看起来合规」正是最容易被评审放过、却可能绑到另一个网卡/端口的形态；暴露面必须可枚举为 1；
 *   - 每个条目必须是**长语法**：短语法（`"3000:3000"` / `${API_PORT:-3000}:3000`）无法声明
 *     `host_ip`，Compose 的缺省行为就是绑 `0.0.0.0`（所有网卡）；
 *   - 每项 `host_ip` 必须**精确**等于 127.0.0.1：通配（0.0.0.0 / :: / 全零展开 / `*`）、
 *     空值、缺省、以及任何非回环地址一律判失败；
 *   - `target` / `published` / `protocol` 必须显式写出且与期望一致：缺省值会让实际发布端口与
 *     协议只能靠推断，评审无法从文件本身看到最终事实。
 */
export function findApiPortExposureIssues(entries, expected = API_PROD_PORT) {
  const issues = [];
  if (entries === null || entries.length === 0) {
    issues.push({ kind: 'missing' });
    return issues;
  }
  // 数量断言先于逐条字段断言：先把「暴露面必须恰好一条」这条结构性事实固定下来，
  // 再逐条复核字段。这样「第二条也完全合规」时仍然必然产出一条稳定的失败原因。
  if (entries.length > 1) {
    issues.push({ kind: 'too-many-entries', count: entries.length, index: 1 });
  }
  entries.forEach((entry, index) => {
    if (entry.kind !== 'long') {
      issues.push({ kind: 'short-syntax', index, entry: (entry.raw ?? []).join(' ').trim() });
      return;
    }
    const fields = entry.fields ?? {};
    if (!Object.hasOwn(fields, 'host_ip')) {
      issues.push({ kind: 'missing-host-ip', index });
    } else {
      const hostIp = String(fields.host_ip).trim();
      if (hostIp === '') {
        issues.push({ kind: 'empty-host-ip', index });
      } else if (hostIp !== expected.hostIp) {
        issues.push({
          kind: isWildcardHostIp(hostIp) ? 'wildcard-host-ip' : 'non-loopback-host-ip',
          index,
          hostIp,
        });
      }
    }
    for (const spec of [
      { field: 'target', missing: 'missing-target', wrong: 'wrong-target' },
      { field: 'published', missing: 'missing-published', wrong: 'wrong-published' },
      { field: 'protocol', missing: 'missing-protocol', wrong: 'wrong-protocol' },
    ]) {
      if (!Object.hasOwn(fields, spec.field)) {
        issues.push({
          kind: spec.missing,
          index,
          field: spec.field,
          expected: expected[spec.field],
        });
        continue;
      }
      const actual = String(fields[spec.field]).trim();
      if (actual !== expected[spec.field]) {
        issues.push({
          kind: spec.wrong,
          index,
          field: spec.field,
          actual,
          expected: expected[spec.field],
        });
      }
    }
  });
  return issues;
}

/** 把 api 端口违规项渲染成一条人类可读的失败原因（文件名由调用方补上） */
function describeApiPortIssue(fileName, issue) {
  const expected = `host_ip: ${API_PROD_PORT.hostIp} / target: ${API_PROD_PORT.target} / published: "${API_PROD_PORT.published}" / protocol: ${API_PROD_PORT.protocol}`;
  const where = `api ports 第 ${issue.index + 1} 条`;
  switch (issue.kind) {
    case 'missing':
      return `${fileName}: api 必须用 ports 长语法把生产端口只绑回环（期望 ${expected}）；当前未声明 ports 或没有任何条目`;
    case 'short-syntax':
      return `${fileName}: ${where} ${issue.entry} 是短语法，无法声明 host_ip（Compose 缺省即绑 0.0.0.0 暴露到所有网卡）；必须改用长语法：${expected}`;
    case 'too-many-entries':
      return `${fileName}: api 的宿主端口发布映射必须恰好 1 条，当前 ${issue.count} 条（第 ${issue.index + 1} 条起一律判失败，即使它本身也是回环合规的 ${expected}）：每多一条映射就多一个宿主暴露面，必须删到只剩一条`;
    case 'missing-host-ip':
      return `${fileName}: ${where} 缺少 host_ip（缺省即绑所有网卡），必须显式写 host_ip: ${API_PROD_PORT.hostIp}`;
    case 'empty-host-ip':
      return `${fileName}: ${where} 的 host_ip 是空值（等价于绑所有网卡），必须精确写 ${API_PROD_PORT.hostIp}`;
    case 'wildcard-host-ip':
      return `${fileName}: ${where} 的 host_ip ${issue.hostIp} 是通配/所有网卡地址（含 IPv6 wildcard），禁止 0.0.0.0、::、空 host；必须精确写 ${API_PROD_PORT.hostIp}`;
    case 'non-loopback-host-ip':
      return `${fileName}: ${where} 的 host_ip 必须是精确的 ${API_PROD_PORT.hostIp}，当前: ${issue.hostIp}`;
    default:
      return issue.actual === undefined
        ? `${fileName}: ${where} 缺少 ${issue.field}，必须显式写 ${issue.field}: ${issue.expected}`
        : `${fileName}: ${where} 的 ${issue.field} 必须是 ${issue.expected}，当前: ${issue.actual}`;
  }
}

/**
 * 生产档容器加固 + 「禁止机密进日志」断言（本地开发档不受影响）。
 *
 * 加固基线（两个服务都必须显式声明，不接受「靠镜像默认」）：
 *   read_only: true / cap_drop: [ALL] / security_opt: no-new-privileges:true / user: 非 root /
 *   stop_grace_period 解析后恰好 30 秒（缺失、过短、过长、非数值或不明确配置一律失败——
 *   Compose 缺省只有 10s，超时 SIGKILL 会让 postgres 的 smart shutdown 被腰斩，即 shutdown BLOCK）。
 * 可写路径必须是最小集：
 *   - api：运行时代码只读文件、只写 stdout，探针也不写文件 → **不许**声明 tmpfs；
 *   - api 的宿主端口必须**恰好一条**、用长语法且 `host_ip` **精确等于 127.0.0.1**（禁止 0.0.0.0 /
 *     :: / 空 / 缺省 host_ip，也禁止短语法——短语法的缺省行为就是绑所有网卡），
 *     target/published/protocol 必须显式写出并与期望一致；第 2 条起的映射一律失败（即使回环合规）；
 *   - postgres：只读根下仅 /run/postgresql（Unix socket 目录）与 /tmp（TMPDIR）需要可写；
 *     持久数据卷必须保持可写、证书目录必须保持只读，二者都不得被 tmpfs 覆盖。
 * postgres 的 cap_add：非 root 启动时官方 entrypoint 不走 chown/gosu 分支，因此不需要任何能力；
 * 若将来确需添加，必须同时改这里与 docker-compose.prod.yml 文件头的能力说明（失败文案里写了）。
 */
function checkProductionHardening(state, fileName, api, postgres) {
  for (const [name, block] of [
    ['api', api],
    ['postgres', postgres],
  ]) {
    check(state,
      readScalarField(block, 'read_only') === 'true',
      `${fileName}: ${name} 必须显式 read_only: true（只读根文件系统）`,
    );
    const capDrop = readListField(block, 'cap_drop');
    check(state,
      capDrop !== null && capDrop.includes('ALL'),
      `${fileName}: ${name} 必须 cap_drop: [ALL]（去掉全部 Linux capability）`,
    );
    const securityOpt = readListField(block, 'security_opt') ?? [];
    check(state,
      securityOpt.includes('no-new-privileges:true'),
      `${fileName}: ${name} 必须声明 security_opt: no-new-privileges:true（禁止 setuid/文件能力提权）`,
    );
    const user = readScalarField(block, 'user');
    check(state, user !== null, `${fileName}: ${name} 必须显式声明 user（不许回落到镜像默认 root）`);
    check(state,
      !isRootUser(user),
      `${fileName}: ${name} 的 user 必须是非 root 且可解析的身份（当前: ${user ?? '未声明'}）`,
    );
    check(state,
      user === null || /^[A-Za-z_][A-Za-z0-9_-]*(?::[A-Za-z0-9_-]+)?$/u.test(user),
      `${fileName}: ${name} 的 user 必须是镜像内可解析的用户名（或 uid[:gid]），当前: ${user ?? '未声明'}`,
    );
    const restart = readScalarField(block, 'restart');
    check(state,
      restart !== null && restart !== 'no',
      `${fileName}: ${name} 必须保留重启策略（restart 缺失或为 no 会在故障后留下停摆容器）`,
    );
    // 优雅停止窗口：必须显式声明且解析后恰好 30 秒（缺失/过短/过长/非数值或不明确一律失败）。
    // 单一控制点 = findStopGracePeriodIssues，失败文案由 describeStopGracePeriodIssue 统一渲染。
    const graceIssue = findStopGracePeriodIssues(readScalarField(block, 'stop_grace_period'));
    if (graceIssue !== null) {
      state.failures.push(describeStopGracePeriodIssue(fileName, name, graceIssue));
    }
  }

  // api 的宿主端口绑定：必须**恰好一条**、长语法 + host_ip 精确 127.0.0.1
  // （详见 findApiPortExposureIssues）。这是「端口暴露面」断言的单一控制点：条目数量、短语法、
  // 通配、空 host、缺 host、非 3000/tcp 都在这里拦下——包括「第二条也回环合规」的额外映射。
  for (const issue of findApiPortExposureIssues(readPortMappings(api))) {
    state.failures.push(describeApiPortIssue(fileName, issue));
  }

  // api：没有可写路径，多声明一个 tmpfs 就多一个可写面
  const apiTmpfs = readListField(api, 'tmpfs');
  check(state,
    apiTmpfs === null || apiTmpfs.length === 0,
    `${fileName}: api 运行期不需要可写目录（只读文件 + 只写 stdout），不得声明 tmpfs（当前: ${(apiTmpfs ?? []).join(', ') || '无'}）`,
  );

  // postgres：只读根下必要的可写目录，**恰好** POSTGRES_TMPFS_TARGETS：
  // 一个不能少、一个不能多，也不接受重复项或带 mount 覆盖的等价写法（如 `/tmp:ro`）。
  const postgresTmpfs = readListField(postgres, 'tmpfs') ?? [];
  for (const issue of findPostgresTmpfsIssues(postgresTmpfs)) {
    state.failures.push(describePostgresTmpfsIssue(fileName, issue));
  }
  for (const entry of postgresTmpfs) {
    const { target } = splitTmpfsEntry(entry);
    for (const protectedPath of ['/var/lib/postgresql/data', '/etc/rm-tls']) {
      const shadows =
        target === '/' || target === protectedPath || protectedPath.startsWith(`${target}/`);
      check(state,
        !shadows,
        `${fileName}: tmpfs ${entry} 不得覆盖 ${protectedPath}（持久数据/证书必须是卷或只读挂载，不能是 tmpfs）`,
      );
    }
  }

  // 数据卷必须仍然可写：postgres 的数据不允许只读
  const dataMount = /rm-postgres-data:\S*/u.exec(postgres);
  check(state, dataMount !== null, `${fileName}: postgres 数据卷 rm-postgres-data 必须仍然挂载`);
  check(state,
    dataMount === null || !/:ro\b/u.test(dataMount[0]),
    `${fileName}: postgres 数据卷必须可写（不得挂成 :ro）`,
  );

  // 非 root 启动时官方 entrypoint 不需要任何能力：不给 cap_add 留模糊空间
  const capAdd = readListField(postgres, 'cap_add');
  check(state,
    capAdd === null || capAdd.length === 0,
    `${fileName}: postgres 以非 root 启动时不需要 cap_add（当前: ${(capAdd ?? []).join(', ')}）；如确需添加，必须同时更新本门禁与 docker-compose.prod.yml 文件头的能力说明`,
  );

  // ---- 禁止机密进日志 ----
  // command / entrypoint / healthcheck 的内容会出现在 docker inspect、docker ps 与容器日志里
  for (const [name, block] of [
    ['api', api],
    ['postgres', postgres],
  ]) {
    for (const field of ['command', 'entrypoint', 'healthcheck']) {
      const section = readBlockField(block, field);
      if (section === null) {
        continue;
      }
      const leaked = findSecretReferences(section);
      check(state,
        leaked.length === 0,
        `${fileName}: ${name} 的 ${field} 不得引用机密类变量 ${leaked.join(', ')}（会出现在 docker inspect / docker ps / 容器日志里；机密只允许经 environment 注入）`,
      );
    }
  }

  // 调试类环境变量会把内部细节（含库连接串等）写进日志；LOG_LEVEL 的默认档位不得是调试档
  for (const key of ['DEBUG', 'NODE_DEBUG', 'NODE_OPTIONS', 'DEBUG_FD', 'DEBUG_COLORS']) {
    const declared = readScalarField(api, key) ?? readScalarField(postgres, key);
    check(state,
      declared === null,
      `${fileName}: 生产档不得声明 ${key}（会开启内部/调试输出，可能把机密写进日志）`,
    );
  }
  const logLevel = parseInterpolations(stripYamlComments(api)).find(
    (item) => item.name === 'LOG_LEVEL',
  );
  const logLevelDefault =
    logLevel?.operator === 'defaulted' ? logLevel.defaultValue.trim().toLowerCase() : '';
  check(state,
    !/^(?:debug|trace|verbose|silly)$/u.test(logLevelDefault),
    `${fileName}: LOG_LEVEL 的默认值不得是 debug/trace/verbose（调试档会把内部细节写进日志），当前: ${logLevelDefault === '' ? '(非默认档)' : logLevelDefault}`,
  );
}

/** 检查 Dockerfile（构建顺序、入口、健康检查、非 root、无内置机密） */
function checkDockerfile(state) {
  const text = readTextOrNull('Dockerfile');
  if (text === null) {
    state.failures.push('缺少 Dockerfile');
    return;
  }
  const apiManifest = readJsonOrNull('services/api/package.json');
  const rootManifest = readJsonOrNull('package.json');

  for (const stage of ['AS deps', 'AS build', 'AS runtime']) {
    check(state, text.includes(stage), `Dockerfile 必须包含多阶段构建：${stage}`);
  }
  check(state, /COPY\s+\.\s+\./u.test(text), 'Dockerfile 必须整体拷入仓库根上下文（monorepo 构建前提）');
  check(state,
    /pnpm install --frozen-lockfile/u.test(text),
    'Dockerfile 必须用 --frozen-lockfile 安装（锁文件可复现）',
  );
  check(state, /USER\s+node\b/u.test(text), 'Dockerfile 运行阶段必须以非 root 用户启动（USER node）');
  // 运行阶段不得再切回 root（后出现的 USER root/0 会覆盖前面的非 root 声明）
  check(state,
    !/^USER\s+(?:root|0)\s*$/mu.test(text),
    'Dockerfile 不得把运行用户设回 root（USER root/0）',
  );
  // 「禁止机密进日志」：本地 .env 不得进镜像，也不得被打印到构建日志里
  // `(?<![\w.-])` 保证命中的是 `.env` 这个文件名本身，而不是 `foo.env` 这类同名后缀
  check(state,
    !/^\s*(?:COPY|ADD)\s+[^\n]*(?<![\w.-])\.env\b/mu.test(text),
    'Dockerfile 不得把 .env 拷进镜像（机密只允许运行时注入）',
  );
  check(state,
    !/^RUN[^\n]*(?<![\w.-])\.env\b/mu.test(text),
    'Dockerfile 的 RUN 不得触碰 .env（内容会留在构建日志/镜像层里）',
  );
  check(state,
    /HEALTHCHECK[\s\S]*scripts\/docker-healthcheck\.mjs/u.test(text),
    'Dockerfile 的 HEALTHCHECK 必须复用 scripts/docker-healthcheck.mjs',
  );

  // 工作区构建顺序：@rm/api 的每个 workspace 依赖都必须先被构建
  const apiWorkspaceDeps = Object.entries(apiManifest?.dependencies ?? {})
    .filter(([, version]) => typeof version === 'string' && version.startsWith('workspace:'))
    .map(([name]) => name);
  const buildPackages = rootManifest?.scripts?.['build:packages'] ?? '';
  for (const dep of apiWorkspaceDeps) {
    check(state,
      buildPackages.includes(dep),
      `root package.json 的 build:packages 必须包含 @rm/api 的工作区依赖 ${dep}`,
    );
  }
  const packagesIndex = text.indexOf('pnpm build:packages');
  const apiBuildIndex = text.indexOf('pnpm --filter @rm/api build');
  check(state,
    packagesIndex !== -1 && apiBuildIndex !== -1 && packagesIndex < apiBuildIndex,
    'Dockerfile 必须先构建工作区包（pnpm build:packages），再构建 @rm/api',
  );

  // 容器启动入口：CMD 必须指向 @rm/api 的 main 所对应的构建产物
  const apiEntry = apiManifest?.main;
  check(state,
    typeof apiEntry === 'string' && apiEntry !== '',
    'services/api/package.json 必须声明 main 入口',
  );
  if (typeof apiEntry === 'string') {
    const expectedCmd = `services/api/${apiEntry}`;
    // 只取**行首**的 CMD：`HEALTHCHECK ... CMD [...]` 里的 CMD 不是启动入口
    const cmdMatch = /^CMD\s+\[([^\]]*)\]/mu.exec(text);
    check(state, cmdMatch !== null, 'Dockerfile 必须用 exec 形式的 CMD 声明启动入口');
    const cmdTokens = (cmdMatch?.[1] ?? '')
      .split(',')
      .map((token) => token.trim().replace(/^"|"$/gu, ''));
    check(state,
      cmdTokens.includes(expectedCmd),
      `Dockerfile 的 CMD 必须包含 ${expectedCmd}（= services/api 的 main 产物），当前: ${cmdTokens.join(' ') || '无'}`,
    );
    // 构建产物是否存在只作提示：`pnpm verify` 在 CI 里先于 `pnpm build` 运行，
    // 干净检出时 dist 本来就不存在，把它当作失败会让门禁误报。
    if (!existsSync(join(repoRoot, 'services/api', apiEntry.replace(/^\.\//u, '')))) {
      state.warnings.push(
        `容器启动入口产物尚未构建：services/api/${apiEntry}（先执行 pnpm build；CI 中 verify 早于 build，属正常）`,
      );
    }
  }

  // 不得把机密固化进镜像
  for (const line of text.split(/\r?\n/u)) {
    if (/^\s*(ARG|ENV)\s+.*(PASSWORD|SECRET|API_KEY|TOKEN)/iu.test(line)) {
      state.failures.push(`Dockerfile 不得通过 ARG/ENV 固化机密：${line.trim()}`);
    }
  }
  check(state,
    !/COPY\s+.*\.(pem|key)\b/u.test(text),
    'Dockerfile 不得把证书/私钥拷进镜像（应运行时挂载）',
  );
}

/** 检查健康探针脚本本身 */
function checkHealthcheckScript(state) {
  const text = readTextOrNull('scripts/docker-healthcheck.mjs');
  if (text === null) {
    state.failures.push('缺少 scripts/docker-healthcheck.mjs');
    return;
  }
  const imports = [...text.matchAll(/from\s+'([^']+)'/gu)].map((match) => match[1]);
  for (const specifier of imports) {
    check(state,
      specifier.startsWith('node:'),
      `scripts/docker-healthcheck.mjs 只允许 node: 内置模块（发现 ${specifier}）`,
    );
  }
  check(state,
    /API_PREFIX/u.test(text),
    'scripts/docker-healthcheck.mjs 必须跟随 API_PREFIX，不得硬编码路径',
  );
  check(state,
    /process\.exit\(0\)/u.test(text) && /process\.exit\(1\)/u.test(text),
    'scripts/docker-healthcheck.mjs 必须用退出码 0/1 表达健康与否',
  );
  const code = text
    .split(/\r?\n/u)
    .filter((line) => !/^\s*(?:\*|\/\/|#)/u.test(line))
    .join('\n');
  check(state,
    !/\/api\/v1\/health/u.test(code),
    'scripts/docker-healthcheck.mjs 不得在代码里硬编码 /api/v1/health 路径（注释里的缺陷说明不算）',
  );
  // 「禁止机密进日志」：探针的输出会直接进入容器日志，因此不得整体输出环境、
  // 也不得读取任何机密类环境变量（探针只需要路径与端口）。
  check(state,
    !/JSON\.stringify\(\s*process\.env|Object\.(?:entries|keys|values)\(\s*process\.env|console\.\w+\(\s*process\.env/u.test(
      code,
    ),
    'scripts/docker-healthcheck.mjs 不得整体输出 process.env（会把环境细节/机密写进容器日志）',
  );
  const secretEnvReads = [
    ...new Set(
      [...code.matchAll(/\benv(?:ironment)?\.([A-Z_][A-Z0-9_]*)/gu)]
        .map((match) => match[1])
        .filter((name) => isSecretKey(name)),
    ),
  ];
  check(state,
    secretEnvReads.length === 0,
    `scripts/docker-healthcheck.mjs 不得读取机密类环境变量 ${secretEnvReads.join(', ')}（探针无需任何凭据）`,
  );
}

/** 检查公开环境变量模板：无真实密钥，且覆盖生产档所有必填变量 */
function checkEnvTemplate(state) {
  const text = readTextOrNull('.env.docker.example');
  if (text === null) {
    state.failures.push('缺少 .env.docker.example');
    return;
  }
  const secretClue = looksLikeRealSecret(text);
  check(state, secretClue === null, `.env.docker.example 疑似含真实密钥：${secretClue ?? ''}`);

  const entries = parseEnvFile(text);
  for (const [key, value] of entries) {
    if (isSecretKey(key)) {
      check(state,
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
      check(state, entries.has(item.name), `.env.docker.example 必须提供生产档必填变量 ${item.name}`);
    }
  }
}

/** 检查只读 TLS 认证规则文件 */
function checkPgHba(state) {
  const text = readTextOrNull('db/docker/prod/pg_hba.conf');
  if (text === null) {
    state.failures.push('缺少 db/docker/prod/pg_hba.conf');
    return;
  }
  check(state, /^hostssl\s/mu.test(text), 'pg_hba.conf 必须允许 hostssl（只有 TLS 连接可用）');
  check(state,
    /^hostnossl\s.*reject\s*$/mu.test(text),
    'pg_hba.conf 必须显式 reject 明文（hostnossl）连接',
  );
}

/** 检查忽略规则：模板可提交、证书与真实 .env 必须排除 */
function checkIgnoreFiles(state) {
  const gitignore = readTextOrNull('.gitignore');
  const dockerignore = readTextOrNull('.dockerignore');
  check(state, gitignore !== null, '缺少 .gitignore');
  check(state, dockerignore !== null, '缺少 .dockerignore');
  if (gitignore !== null) {
    check(state,
      gitignore.includes('!.env.docker.example'),
      '.gitignore 必须显式放行公开模板 .env.docker.example',
    );
    check(state,
      /^\*\.pem$/mu.test(gitignore) && /^\*\.key$/mu.test(gitignore),
      '.gitignore 必须排除 *.pem / *.key',
    );
    check(state, /^\/certs\/$/mu.test(gitignore), '.gitignore 必须排除本地证书目录 /certs/');
  }
  if (dockerignore !== null) {
    check(state,
      dockerignore.includes('!.env.docker.example'),
      '.dockerignore 必须放行 .env.docker.example',
    );
    check(state,
      /\*\.pem/u.test(dockerignore) && /\*\.key/u.test(dockerignore),
      '.dockerignore 必须排除 *.pem / *.key',
    );
    check(state, /\*\*\/dist/u.test(dockerignore), '.dockerignore 必须排除构建产物 **/dist');
    check(state,
      /^\.env$/mu.test(dockerignore) && /^\.env\.\*$/mu.test(dockerignore),
      '.dockerignore 必须排除真实 .env / .env.*',
    );
  }
}

/** 两份编排的交叉一致性：服务集合与具名卷必须一致，且不得残留旧文件名 */
function checkComposeCrossConsistency(state) {
  const dev = readTextOrNull('docker-compose.yml');
  const prod = readTextOrNull('docker-compose.prod.yml');
  if (dev === null || prod === null) {
    return;
  }
  const devServices = [...serviceBlocks(dev).keys()].sort().join(',');
  const prodServices = [...serviceBlocks(prod).keys()].sort().join(',');
  check(state,
    devServices === prodServices,
    `两份编排的服务集合必须一致（dev=${devServices} prod=${prodServices}）`,
  );

  for (const volume of ['rm-postgres-data']) {
    check(state,
      collectTopLevelSection(dev, 'volumes').join('\n').includes(volume) &&
        collectTopLevelSection(prod, 'volumes').join('\n').includes(volume),
      `两份编排必须声明同一个具名卷 ${volume}`,
    );
  }

  if (existsSync(join(repoRoot, 'compose.yaml'))) {
    state.failures.push(
      '检测到遗留的 compose.yaml：与 docker-compose.yml 并存会产生两份互相漂移的编排，请只保留一份',
    );
  }
}

function report(state) {
  if (state.warnings.length > 0) {
    console.log(`\n提示 (${state.warnings.length})`);
    for (const warning of state.warnings) {
      console.log(`  ~ ${warning}`);
    }
  }
  if (state.failures.length > 0) {
    console.error(`\n失败 (${state.failures.length})`);
    for (const failure of state.failures) {
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

function selfTest(state) {
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

  const hardeningSample = [
    '    read_only: true',
    '    user: "postgres"',
    '    cap_drop:',
    '      - ALL',
    '    security_opt:',
    '      - no-new-privileges:true',
    '    tmpfs:',
    '      - /run/postgresql',
    '      - /tmp',
    '    restart: always',
    '',
  ].join('\n');
  expect(
    'readScalarField 取标量、去引号、未声明返回 null',
    [
      readScalarField(hardeningSample, 'read_only'),
      readScalarField(hardeningSample, 'user'),
      readScalarField(hardeningSample, 'restart'),
      readScalarField(hardeningSample, 'cap_add'),
    ],
    ['true', 'postgres', 'always', null],
  );
  expect(
    'readListField 取列表条目并停在下一个键',
    [
      readListField(hardeningSample, 'cap_drop'),
      readListField(hardeningSample, 'tmpfs'),
      readListField(hardeningSample, 'entrypoint'),
    ],
    [['ALL'], ['/run/postgresql', '/tmp'], null],
  );
  expect(
    'readBlockField 取整个子块（含嵌套行，遇到同级键即停）',
    readBlockField(
      '    healthcheck:\n      test: ["CMD","node","x"]\n      interval: 20s\n    restart: always\n',
      'healthcheck',
    ),
    '    healthcheck:\n      test: ["CMD","node","x"]\n      interval: 20s',
  );
  expect(
    'isRootUser：未声明/root/0 都算 root',
    [
      isRootUser(null),
      isRootUser(''),
      isRootUser('root'),
      isRootUser('0'),
      isRootUser('0:0'),
      isRootUser('node'),
      isRootUser('70:70'),
    ],
    [true, true, true, true, true, false, false],
  );
  expect(
    'findSecretReferences 捕获 $VAR / $$VAR / $${VAR} / ${VAR:?...}',
    findSecretReferences(
      'echo "$POSTGRES_USER"\npg_isready -U "$$POSTGRES_USER"\nprintf %s $${POSTGRES_PASSWORD}\n"${SESSION_SECRET:?x}"\n-DATABASE_URL=$DATABASE_URL',
    ),
    ['DATABASE_URL', 'POSTGRES_PASSWORD', 'SESSION_SECRET'],
  );
  expect(
    'findSecretReferences 不误报非机密变量',
    findSecretReferences('pg_isready -U "$$POSTGRES_USER" -d "$$POSTGRES_DB"'),
    [],
  );

  // ---- postgres tmpfs 白名单：恰好 /run/postgresql 与 /tmp ----
  const tmpfsKinds = (entries) => findPostgresTmpfsIssues(entries).map((issue) => issue.kind);
  expect(
    'findPostgresTmpfsIssues 接受恰好两个裸路径（顺序无关）',
    [tmpfsKinds(['/run/postgresql', '/tmp']), tmpfsKinds(['/tmp', '/run/postgresql'])],
    [[], []],
  );
  expect(
    'findPostgresTmpfsIssues 按既有语义接受尾斜杠等价写法',
    tmpfsKinds(['/run/postgresql/', '/tmp']),
    [],
  );
  expect(
    'findPostgresTmpfsIssues 拒绝额外路径（含覆盖全部写路径的 /）',
    [
      tmpfsKinds(['/run/postgresql', '/tmp', '/var/tmp']),
      tmpfsKinds(['/run/postgresql', '/tmp', '/']),
    ],
    [['extraneous'], ['extraneous']],
  );
  expect(
    'findPostgresTmpfsIssues 拒绝重复项',
    [tmpfsKinds(['/run/postgresql', '/tmp', '/tmp']), tmpfsKinds(['/tmp', '/tmp'])],
    [['duplicate'], ['duplicate', 'missing']],
  );
  expect(
    'findPostgresTmpfsIssues 拒绝带 mount 覆盖的等价项',
    [tmpfsKinds(['/run/postgresql', '/tmp:ro']), tmpfsKinds(['/run/postgresql', '/tmp:size=64m'])],
    [['override'], ['override']],
  );
  expect(
    'findPostgresTmpfsIssues 检测缺失的必需目录',
    [tmpfsKinds(['/run/postgresql']), tmpfsKinds([])],
    [['missing'], ['missing', 'missing']],
  );

  // ---- api 生产端口暴露面：长语法 + host_ip 精确 127.0.0.1 ----
  const portsBlock = (lines) => ['    ports:', ...lines].join('\n');
  const portIssueKinds = (lines) =>
    findApiPortExposureIssues(readPortMappings(portsBlock(lines))).map((issue) => issue.kind);
  const compliantPort = [
    '      - host_ip: 127.0.0.1',
    '        target: 3000',
    '        published: "${API_PORT:-3000}"',
    '        protocol: tcp',
  ];
  expect(
    'readPortMappings 识别长语法条目与字段（去引号保留 ${VAR:-x} 字面形态）',
    readPortMappings(
      portsBlock([
        '      - host_ip: 127.0.0.1',
        '        target: 3000',
        '        published: "${API_PORT:-3000}"',
      ]),
    ).map((entry) => [
      entry.kind,
      entry.fields.host_ip,
      entry.fields.target,
      entry.fields.published,
    ]),
    [['long', '127.0.0.1', '3000', '${API_PORT:-3000}']],
  );
  expect(
    'readPortMappings 识别短语法条目（没有 host_ip 字段可声明）',
    readPortMappings(portsBlock(['      - "${API_PORT:-3000}:3000"'])).map((entry) => [
      entry.kind,
      entry.value,
      Object.keys(entry.fields).length,
    ]),
    [['short', '${API_PORT:-3000}:3000', 0]],
  );
  expect(
    'readPortMappings 把连续条目拆成两条（长 + 短混排）',
    readPortMappings(
      portsBlock([
        '      - host_ip: 127.0.0.1',
        '        target: 3000',
        '      - 127.0.0.1:3001:3001',
      ]),
    ).map((entry) => [entry.kind, entry.kind === 'short' ? entry.value : entry.fields.target]),
    [
      ['long', '3000'],
      ['short', '127.0.0.1:3001:3001'],
    ],
  );
  expect(
    'readPortMappings 未声明 ports 返回 null、声明但无条目返回 []',
    [readPortMappings('    image: rm-api:prod\n'), readPortMappings(portsBlock([]))],
    [null, []],
  );
  expect(
    'isWildcardHostIp 覆盖 IPv4/IPv6 通配与全零展开式',
    ['0.0.0.0', '::', '[::]', '::0', '0:0:0:0:0:0:0:0', '127.0.0.1', 'localhost'].map(
      isWildcardHostIp,
    ),
    [true, true, true, true, true, false, false],
  );
  expect(
    'findApiPortExposureIssues 接受合规声明（长语法 + 精确回环 + 三项显式）',
    portIssueKinds(compliantPort),
    [],
  );
  expect(
    'findApiPortExposureIssues 拒绝 IPv4/IPv6 通配 host_ip',
    [
      portIssueKinds(
        compliantPort.map((line) => line.replace('host_ip: 127.0.0.1', 'host_ip: 0.0.0.0')),
      ),
      portIssueKinds(
        compliantPort.map((line) => line.replace('host_ip: 127.0.0.1', 'host_ip: "::"')),
      ),
    ],
    [['wildcard-host-ip'], ['wildcard-host-ip']],
  );
  expect(
    'findApiPortExposureIssues 拒绝空 host_ip 与缺 host_ip',
    [
      portIssueKinds(
        compliantPort.map((line) => line.replace('host_ip: 127.0.0.1', 'host_ip: ""')),
      ),
      // 条目以 target 开头：host_ip 整个缺失（而不是「有键但空值」）
      portIssueKinds([
        '      - target: 3000',
        '        published: "${API_PORT:-3000}"',
        '        protocol: tcp',
      ]),
    ],
    [['empty-host-ip'], ['missing-host-ip']],
  );
  expect(
    'findApiPortExposureIssues 拒绝非回环 host_ip',
    portIssueKinds(compliantPort.map((line) => line.replace('127.0.0.1', '10.0.0.5'))),
    ['non-loopback-host-ip'],
  );
  expect(
    'findApiPortExposureIssues 拒绝短语法（缺省 host_ip 就是绑所有网卡）',
    portIssueKinds(['      - "${API_PORT:-3000}:3000"']),
    ['short-syntax'],
  );
  expect(
    'findApiPortExposureIssues 检测 target/published/protocol 的缺失与不匹配',
    [
      portIssueKinds(compliantPort.map((line) => line.replace('target: 3000', 'target: 8080'))),
      portIssueKinds(compliantPort.filter((line) => !line.includes('published'))),
      portIssueKinds(compliantPort.filter((line) => !line.includes('protocol'))),
      portIssueKinds(
        compliantPort.map((line) =>
          line.replace('published: "${API_PORT:-3000}"', 'published: 3000'),
        ),
      ),
    ],
    [['wrong-target'], ['missing-published'], ['missing-protocol'], ['wrong-published']],
  );
  expect(
    'findApiPortExposureIssues 逐条判定（一条合规 + 一条通配：数量与通配各报一条）',
    findApiPortExposureIssues(
      readPortMappings(
        portsBlock([
          ...compliantPort,
          '      - host_ip: 0.0.0.0',
          '        target: 3000',
          '        published: "${API_PORT:-3000}"',
          '        protocol: tcp',
        ]),
      ),
    ).map((issue) => [issue.index, issue.kind]),
    [
      [1, 'too-many-entries'],
      [1, 'wildcard-host-ip'],
    ],
  );
  // 「第二条完全合规」的反例：第二个映射逐项都满足回环 + 3000/tcp（只是写法上换了引号），
  // 逐条字段规则一条都不违反，因此**只有**数量断言能拦住它。
  expect(
    'findApiPortExposureIssues 拒绝第二条完全合规的回环映射（恰好一条）',
    portIssueKinds([
      ...compliantPort,
      '      - host_ip: "127.0.0.1"',
      "        target: '3000'",
      "        published: '${API_PORT:-3000}'",
      '        protocol: "tcp"',
    ]),
    ['too-many-entries'],
  );
  expect(
    'findApiPortExposureIssues 接受恰好一条时不受数量断言影响（含引号等价写法）',
    portIssueKinds([
      '      - host_ip: "127.0.0.1"',
      "        target: '3000'",
      "        published: '${API_PORT:-3000}'",
      '        protocol: "tcp"',
    ]),
    [],
  );
  expect(
    'findApiPortExposureIssues 把未声明/空 ports 判为 missing',
    [
      findApiPortExposureIssues(null).map((issue) => issue.kind),
      findApiPortExposureIssues([]).map((issue) => issue.kind),
    ],
    [['missing'], ['missing']],
  );

  // ---- stop_grace_period：必须是带单位的严格时长，且解析后恰好 30 秒 ----
  expect(
    'parseDurationSeconds 只接受带单位的严格时长（裸数字/插值/空格/未知或大写单位一律 null）',
    [
      '30s',
      '30000ms',
      '0.5m',
      '1m30s',
      '30000000us',
      '15s',
      '30',
      '${GRACE:-30s}',
      '30sec',
      '30 s',
      '30S',
      '',
    ].map(parseDurationSeconds),
    [30, 30, 30, 90, 30, 15, null, null, null, null, null, null],
  );
  expect(
    'findStopGracePeriodIssues 接受 30 秒的等价写法（含毫秒/小数分钟/微秒）',
    ['30s', '30000ms', '0.5m', '30000000us', ' 30s '].map((value) =>
      findStopGracePeriodIssues(value),
    ),
    [null, null, null, null, null],
  );
  expect(
    'findStopGracePeriodIssues 拒绝缺失（未声明/null/空值）',
    [null, undefined, '', '   '].map((value) => findStopGracePeriodIssues(value)?.kind),
    ['missing', 'missing', 'missing', 'missing'],
  );
  expect(
    'findStopGracePeriodIssues 拒绝过短（15s 反例）与过长',
    [
      findStopGracePeriodIssues('15s')?.kind,
      findStopGracePeriodIssues('29s')?.kind,
      findStopGracePeriodIssues('60s')?.kind,
      findStopGracePeriodIssues('1m30s')?.kind,
    ],
    ['too-short', 'too-short', 'too-long', 'too-long'],
  );
  expect(
    'findStopGracePeriodIssues 拒绝非数值/不明确配置（裸数字/插值/未知单位/空格/大写）',
    ['30', '${GRACE:-30s}', '$GRACE', '30sec', '30 s', '30S', 'none'].map(
      (value) => findStopGracePeriodIssues(value)?.kind,
    ),
    [
      'non-numeric',
      'non-numeric',
      'non-numeric',
      'non-numeric',
      'non-numeric',
      'non-numeric',
      'non-numeric',
    ],
  );

  // 端到端合成反例：用一份其余加固项全部合规的服务块驱动真实门禁函数，
  // 只改一个变量（tmpfs、api 端口声明或 stop_grace_period），确认「违规就必然失败」——
  // 防止门禁自己坏掉却报通过。
  const compliantApiPortLines = [
    '    ports:',
    '      - host_ip: 127.0.0.1',
    '        target: 3000',
    '        published: "${API_PORT:-3000}"',
    '        protocol: tcp',
  ];
  const hardeningProbe = (
    tmpfsEntries,
    apiPortLines = compliantApiPortLines,
    grace = { api: '30s', postgres: '30s' },
  ) => {
    // null 表示「刻意不声明该键」，用于缺失反例
    const graceLines = (value) => (value === null ? [] : [`    stop_grace_period: ${value}`]);
    const postgresBlock = [
      '    image: postgres:16-alpine',
      '    read_only: true',
      '    user: "postgres"',
      '    cap_drop:',
      '      - ALL',
      '    security_opt:',
      '      - no-new-privileges:true',
      '    volumes:',
      '      - rm-postgres-data:/var/lib/postgresql/data',
      '    tmpfs:',
      ...tmpfsEntries.map((entry) => `      - ${entry}`),
      ...graceLines(grace.postgres),
      '    restart: always',
      '',
    ].join('\n');
    const apiBlock = [
      '    image: rm-api:prod',
      '    read_only: true',
      '    user: "node"',
      '    cap_drop:',
      '      - ALL',
      '    security_opt:',
      '      - no-new-privileges:true',
      ...apiPortLines,
      ...graceLines(grace.api),
      '    restart: always',
      '',
    ].join('\n');
    const savedFailures = state.failures.splice(0, state.failures.length);
    const savedWarnings = state.warnings.splice(0, state.warnings.length);
    try {
      checkProductionHardening(state, '合成样本', apiBlock, postgresBlock);
      return { count: state.failures.length, messages: [...state.failures] };
    } finally {
      state.failures.length = 0;
      state.warnings.length = 0;
      state.failures.push(...savedFailures);
      state.warnings.push(...savedWarnings);
    }
  };
  expect(
    'checkProductionHardening 通过：postgres tmpfs 恰好两个必需目录',
    hardeningProbe(['/run/postgresql', '/tmp']).count,
    0,
  );
  expect(
    'checkProductionHardening 通过：两个服务 stop_grace_period 恰为 30s（端到端合成样本）',
    hardeningProbe(['/run/postgresql', '/tmp']).messages.length,
    0,
  );
  const missingGraceProbe = hardeningProbe(['/run/postgresql', '/tmp'], compliantApiPortLines, {
    api: null,
    postgres: null,
  });
  expect(
    'checkProductionHardening 失败：两个服务都缺 stop_grace_period（端到端合成反例）',
    [
      missingGraceProbe.count,
      missingGraceProbe.messages.filter((message) => message.includes('stop_grace_period')).length,
    ],
    [2, 2],
  );
  expect(
    'checkProductionHardening 失败：只有一个服务缺 stop_grace_period（逐服务判定）',
    hardeningProbe(['/run/postgresql', '/tmp'], compliantApiPortLines, {
      api: null,
      postgres: '30s',
    }).count,
    1,
  );
  const shortGraceProbe = hardeningProbe(['/run/postgresql', '/tmp'], compliantApiPortLines, {
    api: '15s',
    postgres: '15s',
  });
  expect(
    'checkProductionHardening 失败：stop_grace_period 只有 15s（端到端合成反例）',
    [
      shortGraceProbe.count,
      shortGraceProbe.messages.filter((message) => message.includes('短于要求的 30 秒')).length,
    ],
    [2, 2],
  );
  expect(
    'checkProductionHardening 失败：stop_grace_period 是非数值/不明确配置（端到端合成反例）',
    hardeningProbe(['/run/postgresql', '/tmp'], compliantApiPortLines, {
      api: '${GRACE:-30s}',
      postgres: '30',
    }).count,
    2,
  );
  const extraTmpfsProbe = hardeningProbe(['/run/postgresql', '/tmp', '/var/tmp']);
  expect(
    'checkProductionHardening 失败：postgres 多声明一个 tmpfs（合成反例）',
    [
      extraTmpfsProbe.count,
      extraTmpfsProbe.messages.some((message) => message.includes('额外路径 /var/tmp')),
    ],
    [1, true],
  );
  expect(
    'checkProductionHardening 失败：postgres tmpfs 重复项',
    hardeningProbe(['/run/postgresql', '/tmp', '/tmp']).count,
    1,
  );
  expect(
    'checkProductionHardening 失败：postgres tmpfs 带非法覆盖的等价项',
    hardeningProbe(['/run/postgresql', '/tmp:ro']).count,
    1,
  );
  expect(
    'checkProductionHardening 失败：postgres 缺少必需 tmpfs',
    hardeningProbe(['/run/postgresql']).count,
    1,
  );
  const rootTmpfsProbe = hardeningProbe(['/run/postgresql', '/tmp', '/']);
  expect(
    'checkProductionHardening 失败：postgres 用通配 / 作为 tmpfs（额外路径 + 覆盖数据卷与证书目录）',
    [
      rootTmpfsProbe.count,
      rootTmpfsProbe.messages.filter((message) => message.includes('不得覆盖')).length,
    ],
    [3, 2],
  );

  // api 端口暴露面的端到端合成反例：其余加固项全合规，只改端口声明一个变量
  const wildcardPortProbe = hardeningProbe(
    ['/run/postgresql', '/tmp'],
    [
      '    ports:',
      '      - host_ip: 0.0.0.0',
      '        target: 3000',
      '        published: "${API_PORT:-3000}"',
      '        protocol: tcp',
    ],
  );
  expect(
    'checkProductionHardening 失败：api 端口绑到 0.0.0.0（端到端合成反例）',
    [
      wildcardPortProbe.count,
      wildcardPortProbe.messages.some((message) => message.includes('通配/所有网卡地址')),
    ],
    [1, true],
  );
  expect(
    'checkProductionHardening 失败：api 端口用短语法（端到端合成反例）',
    hardeningProbe(['/run/postgresql', '/tmp'], ['    ports:', '      - "${API_PORT:-3000}:3000"'])
      .count,
    1,
  );
  expect(
    'checkProductionHardening 失败：api 完全没有声明 ports（端到端合成反例）',
    hardeningProbe(['/run/postgresql', '/tmp'], []).count,
    1,
  );
  expect(
    'checkProductionHardening 失败：api host_ip 为空值（端到端合成反例）',
    hardeningProbe(
      ['/run/postgresql', '/tmp'],
      [
        '    ports:',
        '      - host_ip: ""',
        '        target: 3000',
        '        published: "${API_PORT:-3000}"',
        '        protocol: tcp',
      ],
    ).count,
    1,
  );
  // 关键反例：第二条映射**逐项合规**（回环 + 3000/tcp，只是换了引号写法），
  // 逐条字段断言全都通过，必须由「恰好一条」的数量断言把它拦下。
  const secondCompliantPortProbe = hardeningProbe(
    ['/run/postgresql', '/tmp'],
    [
      ...compliantApiPortLines,
      '      - host_ip: "127.0.0.1"',
      "        target: '3000'",
      "        published: '${API_PORT:-3000}'",
      '        protocol: "tcp"',
    ],
  );
  expect(
    'checkProductionHardening 失败：api 第二条发布映射完全合规（端到端合成反例）',
    [
      secondCompliantPortProbe.count,
      secondCompliantPortProbe.messages.some((message) =>
        message.includes('必须恰好 1 条，当前 2 条'),
      ),
    ],
    [1, true],
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

function main() {
  const state = { failures: [], warnings: [] };
  if (process.argv.includes('--self-test')) {
    selfTest(state);
  } else {
    console.log('Docker 打包静态门禁');
    console.log(`- 仓库根目录: ${repoRoot}`);
    checkDockerfile(state);
    checkHealthcheckScript(state);
    checkCompose(state, 'docker-compose.yml', 'dev');
    checkCompose(state, 'docker-compose.prod.yml', 'prod');
    checkComposeCrossConsistency(state);
    checkEnvTemplate(state);
    checkPgHba(state);
    checkIgnoreFiles(state);
    report(state);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}

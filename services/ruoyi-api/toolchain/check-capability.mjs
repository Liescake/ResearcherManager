#!/usr/bin/env node
/**
 * RuoYi 证据生成能力探测（services/ruoyi-api/toolchain/check-capability.mjs）。
 *
 * 目的：回答一个与「证据是否已收集」不同的问题——**当前环境是否具备产出真实证据的能力**：
 *   1. `sbom`：依赖 SBOM（CycloneDX）；
 *   2. `vulnerability-scan`：依赖漏洞扫描；
 *   3. `postgresql-compatibility`：隔离 PostgreSQL 实例上的 DDL/分页/时间/事务/回滚验证。
 *
 * 本脚本只做能力探测：它**不生成、不预填、不伪造**任何证据，也不写任何证据文件；三项来源/
 * 合规证据的权威状态仍以 provenance-manifest.json 为准（本脚本既不读也不改它）。
 * 每项能力的结论只有两种：
 *   - `ready`   ：列出前置全部满足，可以在本机产出真实证据；
 *   - `blocked` ：列出未满足的前置，并给出可复现的下一步命令（不改仓库、不代替人工执行）。
 *
 * 判定（退出码）：
 *   0  ready     ：三项能力的前置全部满足；
 *   2  blocked   ：结构合法，但至少一项能力的前置未满足（当前本机即为此状态）；
 *   1  violation ：门禁清单不可用或非法，或出现「门禁未 admitted 却已有 pom.xml」这类矛盾事实；
 *   64 usage     ：未知参数，或显式探测路径不是可用的绝对 JDK/Maven home。
 *
 * 边界与保证：
 *   - 只用 `node:` 内置模块；不联网、不安装、不下载任何依赖；
 *   - 只读仓库：不创建、不修改、不移动、不删除仓库内任何文件（版本探测的临时文件写在系统临时目录）；
 *   - 版本探测只执行 `-v` / `--version` / `docker info` 这类纯查询参数，绝不执行任何构建目标；
 *   - 探测不确定或被环境阻止时一律 fail-closed 视为未满足；
 *   - `--self-test` 只使用合成输入，不读磁盘、不执行探测。
 *
 * 探测安全与可信（GPT6sol BLOCK 后加固，说明见 toolchain/README.md §11.4）：
 *   - 「可用」＝定位到文件 + 退出码 0 + 输出非空且有首行；只凭同名文件存在不算可用（堵住 fail-open）；
 *   - 经 shell 启动的命令一律加引号，并拒绝加引号也无法中和的字符（`"`、`%`、`!`、控制字符）；
 *   - 每次探测都有 15 秒超时，超时或收到信号按不可用处理，不回退重试。
 *
 * 用法（可在任意工作目录执行，脚本按自身位置解析同目录门禁清单）：
 *   node check-capability.mjs
 *   node check-capability.mjs --json
 *   node check-capability.mjs --report      # 信息性运行：始终以退出码 0 结束
 *   node check-capability.mjs --self-test   # 用合成输入验证判定规则（不读磁盘、不探测）
 *   node check-capability.mjs --java-home "C:\Program Files\Java\jdk-17" --maven-home "<仓库外>/apache-maven-3.9.16"
 *   node check-capability.mjs --audit-root "<仓库外绝对路径>" --audit-commit "<40 位小写 SHA>"
 *   node check-capability.mjs --audit-root="<仓库外绝对路径>" --audit-commit="<40 位小写 SHA>"
 *                                            # 外部审计模式：只读核验仓库外的固定 commit 检出
 *
 * 退出码：0 就绪；1 违规；2 被阻断；64 用法错误。
 * 审计模式（`--audit-root` + `--audit-commit`，空格与 `=` 两种写法等价）只回答一个问题：**这个仓库外的
 * 固定 commit 检出能否作为真实证据的来源**。verdict 只有两个取值：`external-audit-ready`（退出码 0）
 * 与 `blocked`（1 隔离/事实违规，2 前置未满足）；报告里 `admitted` 与 `verified` 恒为 false，并且不读取
 * 仓库内 `gate-manifest.json` 的 stage，因此仓库内门禁状态不可能影响本判定。
 * 详见「外部审计模式」一节。
 */
import {
  existsSync,
  lstatSync,
  openSync,
  closeSync,
  readFileSync,
  realpathSync,
  unlinkSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { delimiter, dirname, isAbsolute, join, parse, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/* ------------------------------------------------------------------ *
 * 常量
 * ------------------------------------------------------------------ */

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
const BOUNDARY_ROOT = resolve(MODULE_DIR, '..');
const REPO_ROOT = resolve(BOUNDARY_ROOT, '..', '..');
const GATE_MANIFEST_FILE = join(MODULE_DIR, 'gate-manifest.json');

const GATE_CONTRACT_ID = 'ruoyi-toolchain-gate';
const GATE_STAGES = ['pre-poc-gate', 'admitted'];
const ADMITTED_STAGE = 'admitted';

const CAPABILITY_IDS = ['sbom', 'vulnerability-scan', 'postgresql-compatibility'];
const RELATIVE_POM = 'services/ruoyi-api/pom.xml';
const RELATIVE_SBOM = 'services/ruoyi-api/compliance/provenance/sbom.cyclonedx.json';

const MIN_JDK_MAJOR = 17;
const MIN_MAVEN_VERSION = '3.9.0';

const EXPLICIT_FLAGS = { javaHome: '--java-home', mavenHome: '--maven-home' };
const EXECUTABLE_NAMES = {
  javaHome: () => (process.platform === 'win32' ? ['java.exe', 'java'] : ['java']),
  mavenHome: () => (process.platform === 'win32' ? ['mvn.cmd', 'mvn.exe', 'mvn'] : ['mvn']),
};

const SBOM_TOOL_SPECS = [
  { name: 'cyclonedx', args: ['--version'] },
  { name: 'syft', args: ['--version'] },
  { name: 'cdxgen', args: ['--version'] },
  { name: 'jbom', args: ['--version'] },
];
const SCANNER_SPECS = [
  { name: 'trivy', args: ['--version'] },
  { name: 'grype', args: ['--version'] },
  { name: 'osv-scanner', args: ['--version'] },
  { name: 'dependency-check', args: ['--version'] },
];
const POSTGRES_SPECS = [
  { name: 'psql', args: ['--version'] },
  { name: 'pg_ctl', args: ['--version'] },
  { name: 'pg_isready', args: ['--version'] },
];
const DOCKER_SPEC = { name: 'docker', args: ['info', '--format', '{{.ServerVersion}}'] };

/** docker 守护进程不可达时的输出特征（CLI 存在不等于运行时可用）。 */
const DAEMON_FAILURE = /(error|failed|cannot|refused|not running|no such file|is not recognized)/i;

const EXIT = { READY: 0, VIOLATION: 1, BLOCKED: 2, USAGE: 64 };

/* ------------------------------------------------------------------ *
 * 基础工具
 * ------------------------------------------------------------------ */

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function formatValue(value) {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (typeof value === 'string') return `"${value}"`;
  return String(value);
}

function compareVersions(left, right) {
  const a = String(left).split('.');
  const b = String(right).split('.');
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    const x = Number.parseInt(a[index] ?? '0', 10);
    const y = Number.parseInt(b[index] ?? '0', 10);
    const safeX = Number.isNaN(x) ? 0 : x;
    const safeY = Number.isNaN(y) ? 0 : y;
    if (safeX !== safeY) return safeX < safeY ? -1 : 1;
  }
  return 0;
}

function firstLine(text) {
  const line = String(text ?? '')
    .split(/\r?\n/)
    .map((item) => item.trim())
    .find((item) => item !== '');
  return line === undefined ? null : line.length > 160 ? `${line.slice(0, 159)}…` : line;
}

/* ------------------------------------------------------------------ *
 * 版本探测（只读；仅查询参数）
 * ------------------------------------------------------------------ */

/**
 * 探测安全与可信约束（缺一不可）：
 * - 单次探测必须有**有限超时**（`PROBE_TIMEOUT_MS`），避免探针挂死把检查器卡住；超时不重试；
 * - 所有路径先做通用校验：引号（`"` `'`）会破坏参数边界，控制字符（NUL/CR/LF/TAB/DEL）会截断或
 *   拼接命令行，命中一律拒绝执行；
 * - Windows 的 `.cmd`/`.bat` 只能经 `cmd.exe` 启动，Node 会把整条命令行交给 cmd 解析，因此这类路径
 *   还要额外拒绝**危险元字符**（fail-closed，命中即拒绝执行，而不是照常拼接命令行）：`&` `|` `<` `>`
 *   是命令分隔/管道/重定向，`^` 是转义符，`(` `)` 是命令块定界符，`%` 在引号内仍会展开，`!` 在延迟
 *   展开下会展开；
 * - 经 shell 启动时命令行**仍然额外整段加引号**（纵深防御：即使元字符校验将来被放宽，也已中和一次）；
 * - `.exe` 与 POSIX 可执行文件由 Node 直接 exec（`shell: false`），不经过任何 shell，因此只做通用校验：
 *   `C:\Program Files (x86)\...\java.exe` 这类含括号的合法路径不会被误拒（本机 java.exe 即在该目录）；
 * - 「可用」必须同时满足**定位到文件 + 确实执行成功（退出码 0）+ 输出非空且含该工具的严格版本行**。
 *   只凭「同名文件存在」就判可用是 fail-open：一个坏掉的同名脚本会被当成现成工具；只判「非空」也不够：
 *   `--version` 只打印用法说明（如 `Usage: trivy [flags]`）却返回 0 的坏工具同样会把 capability 误报为 ready；
 *   版本号只能在**该工具自己的版本行**上取（工具标识行 / 整行语义版本 / 实测的 `Version:` 行），不允许
 *   在垃圾或错误文本里任意搜「数字.数字」——规则与自检见后文「严格的工具特定版本解析」；
 * - Docker 走另一条更严的规则：`docker info --format '{{.ServerVersion}}'` 的输出必须**整段就是**一条合法
 *   ServerVersion（允许 Docker 常见后缀），出现任何垃圾或错误文本即判守护进程不可达（fail-closed）。
 */
const PROBE_TIMEOUT_MS = 15000;
// eslint-disable-next-line no-control-regex -- 安全判定：必须识别控制字符（NUL/CR/LF/TAB/DEL）并拒绝
const UNSAFE_PATH_CHARS = /["'\u0000-\u001f\u007f]/;
const SHELL_META_CHARS = /[&|<>^()%!]/;

/**
 * 严格的**工具特定**版本解析（禁止在垃圾文本里任意搜「数字.数字」）。
 *
 * 旧实现用 `\d+(?:\.\d+)+` 在整段输出里搜数字点串，于是 `error code 1.2`、`garbage 999.999`
 * 这类错误文本也会被当成版本号，把坏工具误判为可用。现只承认三种版本行，且版本号本身必须是
 * **严格语义版本**（`MAJOR.MINOR.PATCH`，可选 `-预发布` / `+构建元数据`）：
 *
 *   A. 合法版本行：整行恰好是一条语义版本（commander 风格 CLI 只打印版本号，如 cdxgen 的 `11.5.1`）；
 *   B. 工具标识行：行首必须是**该工具自己的**标识（`trivy 0.58.0`、`osv-scanner version: 1.9.0`、
 *      `psql (PostgreSQL) 16.4`），版本号紧随标识之后，行尾只允许空或 PostgreSQL 的发行版括号说明；
 *   C. 带标签版本行：整行是 `Version: X.Y.Z`，且只对该工具实测这样输出的工具开放（syft / grype / trivy）。
 *
 * 因此 `garbage 999.999`（既非工具标识行、也非整行版本）、`error 1.2`、`0.0`（只有两段，不是语义
 * 版本）与 `Usage: trivy [flags]` 都不可能再解析出版本号。PostgreSQL 的 `MAJOR.MINOR`（10 起官方
 * 版本号只有两段）只在工具标识行内接受，且主版本必须 ≥ 1：`psql (PostgreSQL) 0.0` 按不可解析
 * fail-closed 处理。
 */
const SEMVER_CORE =
  /^(?:v)?(\d+\.\d+\.\d+(?:-[0-9A-Za-z][0-9A-Za-z.-]*)?(?:\+[0-9A-Za-z][0-9A-Za-z.-]*)?)$/;
const POSTGRES_CORE = /^(\d+)\.(\d+)(?:\.\d+)?(?:-[0-9A-Za-z][0-9A-Za-z.-]*)?$/;
const LABELED_VERSION_LINE = /^version\s*[:=]\s*(\S+)$/i;
/** PostgreSQL 客户端版本号后可能追加发行版括号说明（如 Ubuntu 的 `(Ubuntu 16.4-0ubuntu0...)`）。 */
const VENDOR_SUFFIX = /^\s*\([^()]*\)\s*$/;
/** 工具标识（锚定行首）：只有这些行的行首才允许出现对应工具的版本号。 */
const TOOL_IDENTITY = {
  cyclonedx: /^cyclonedx(?:[- ]cli)?/i,
  syft: /^(?:application:\s*)?syft\b/i,
  cdxgen: /^cdxgen\b/i,
  jbom: /^jbom\b/i,
  trivy: /^trivy\b/i,
  grype: /^(?:application:\s*)?grype\b/i,
  'osv-scanner': /^osv-scanner\b/i,
  'dependency-check': /^(?:owasp\s+)?dependency-check(?:\s+core)?\b/i,
  psql: /^psql\s*\(postgresql\)/i,
  pg_ctl: /^pg_ctl\s*\(postgresql\)/i,
  pg_isready: /^pg_isready\s*\(postgresql\)/i,
};
/** 实测以 `Version: X.Y.Z` 单行打印版本的工具（syft / grype / trivy 的 `--version`）。 */
const LABELED_VERSION_TOOLS = new Set(['syft', 'grype', 'trivy']);
const POSTGRES_TOOLS = new Set(['psql', 'pg_ctl', 'pg_isready']);
/** 工具标识与版本号之间的连接词：` 0.58.0` / `: 0.58.0` / ` version 0.58.0` / `v0.58.0`。 */
const VERSION_CONNECTOR = /^\s*[:=]?\s*(?:v(?:ersion)?\b\s*[:=]?\s*)?/i;
/** 版本号 token：数字开头（允许 `v` 前缀）；token 之后若还有其他内容由行尾校验拒绝。 */
const VERSION_TOKEN = /^[vV]?\d[0-9A-Za-z.+-]*/;
/** 最多扫描的输出行数（多行 `--version` 输出的合法版本行都很靠前，避免在长输出里乱找）。 */
const MAX_VERSION_SCAN_LINES = 20;

/** 按工具要求的形状校验版本号：不属于该形状一律返回 null（fail-closed，不截取部分匹配）。 */
function validateVersion(name, candidate) {
  if (typeof candidate !== 'string' || candidate === '') return null;
  const value = /^[vV]/.test(candidate) ? candidate.slice(1) : candidate;
  if (POSTGRES_TOOLS.has(name)) {
    const match = POSTGRES_CORE.exec(value);
    if (match === null) return null;
    // PostgreSQL 主版本自 1 起；`0.0` / `0.1` 这类占位不是任何真实客户端版本，按不可解析处理
    return Number.parseInt(match[1], 10) >= 1 ? value : null;
  }
  return SEMVER_CORE.exec(value) === null ? null : value;
}

/** 从一行输出里按**工具特定**规则取版本号；该行不属于此工具的任一版本行形状即返回 null。 */
function versionFromLine(name, rawLine) {
  const line = String(rawLine ?? '').trim();
  if (line === '') return null;
  // A. 合法版本行：整行就是一条语义版本（两段的 0.0 / 1.2 / 999.999 不算）
  const bare = SEMVER_CORE.exec(line);
  if (bare !== null) return bare[1];
  // C. 带标签版本行：`Version: X.Y.Z`，仅对该工具实测这样输出时接受
  if (LABELED_VERSION_TOOLS.has(name)) {
    const labeled = LABELED_VERSION_LINE.exec(line);
    if (labeled !== null) {
      const version = validateVersion(name, labeled[1]);
      if (version !== null) return version;
    }
  }
  // B. 工具标识行：行首是该工具标识，版本号紧随其后，行尾只允许空或（PostgreSQL）发行版括号说明
  const identity = TOOL_IDENTITY[name];
  if (!identity) return null;
  const identityMatch = identity.exec(line);
  if (identityMatch === null) return null;
  const afterIdentity = line.slice(identityMatch[0].length);
  const connector = VERSION_CONNECTOR.exec(afterIdentity);
  const remainder = afterIdentity.slice(connector === null ? 0 : connector[0].length);
  const token = VERSION_TOKEN.exec(remainder);
  if (token === null) return null;
  const tail = remainder.slice(token[0].length);
  if (tail !== '' && !(POSTGRES_TOOLS.has(name) && VENDOR_SUFFIX.test(tail))) return null;
  return validateVersion(name, token[0]);
}

/** 在**有界行数**内取第一个合格版本行；解析不出来返回 null，由调用方 fail-closed 判不可用。 */
function parseToolVersion(name, text) {
  const lines = String(text ?? '')
    .split(/\r?\n/)
    .slice(0, MAX_VERSION_SCAN_LINES);
  for (const line of lines) {
    const version = versionFromLine(name, line);
    if (version !== null) return version;
  }
  return null;
}

/**
 * Docker ServerVersion：`docker info --format '{{.ServerVersion}}'` 的输出必须**整段就是**一条合法
 * 版本串（允许 Docker 常见的 `-rc.1` / `-ce` / `+dfsg1` 一类后缀），拒绝任何垃圾或错误文本：
 * `error during connect: ...`、`ServerVersion: 27.3.1`、`0.0`、`999.999`、版本后跟警告行都不算可用。
 */
const DOCKER_SERVER_VERSION =
  /^(?:v)?(\d+\.\d+\.\d+(?:-[0-9A-Za-z][0-9A-Za-z.-]*)?(?:\+[0-9A-Za-z][0-9A-Za-z.-]*)?)$/;

function parseDockerVersion(text) {
  const value = String(text ?? '').trim();
  const match = DOCKER_SERVER_VERSION.exec(value);
  return match === null ? null : match[1];
}

/** 通用路径校验：非空且不含引号与控制字符（对所有平台、是否经 shell 都成立的最低要求）。 */
function isSafeExecutablePath(target) {
  return typeof target === 'string' && target !== '' && !UNSAFE_PATH_CHARS.test(target);
}

/** 经 shell 启动的路径校验：Windows 上的 `.cmd`/`.bat` 额外拒绝危险元字符（`platform` 可注入以便自检）。 */
function isSafeShellPath(target, platform = process.platform) {
  if (platform !== 'win32' || !/\.(cmd|bat)$/i.test(String(target ?? ''))) return true;
  return !SHELL_META_CHARS.test(target);
}

/**
 * `.cmd`/`.bat` 必须经 shell 启动；命令行**始终给命令加引号**，再用空参数数组承载参数，
 * 既避免 Node 24 的 shell+args 弃用警告，也让命令路径在纵深防御层面被引号中和一次。
 * 路径或参数命中危险元字符时返回 `error`，由调用方按 `unsafe-path` fail-closed（绝不执行该命令）。
 * `platform` 可注入，便于自检在**不执行任何命令**的前提下验证 Windows 分支。
 */
function buildInvocation(command, args, platform = process.platform) {
  if (platform !== 'win32' || !/\.(cmd|bat)$/i.test(command)) {
    return { command, args, shell: false, error: null };
  }
  const unsafeArg = (args ?? []).find(
    (item) => !isSafeExecutablePath(item) || SHELL_META_CHARS.test(String(item)),
  );
  if (!isSafeShellPath(command, platform) || unsafeArg !== undefined) {
    return {
      command: null,
      args: [],
      shell: true,
      error: `拒绝经 cmd.exe 启动：路径或参数含引号、控制字符或危险元字符（${command}）`,
    };
  }
  return { command: [`"${command}"`, ...args].join(' '), args: [], shell: true, error: null };
}

/** 捕获子进程输出：先管道，被沙箱阻止时回退为临时文件句柄（临时文件写在系统临时目录）。 */
function captureOutput(command, args, environment) {
  if (!isSafeExecutablePath(command)) {
    return { ok: false, status: null, signal: null, mode: 'none', reason: 'unsafe-path', text: '' };
  }
  const invocation = buildInvocation(command, args);
  if (invocation.error !== null) {
    return { ok: false, status: null, signal: null, mode: 'none', reason: 'unsafe-path', text: '' };
  }
  const base = { windowsHide: true, shell: invocation.shell, timeout: PROBE_TIMEOUT_MS };
  if (environment) base.env = environment;
  const piped = spawnSync(invocation.command, invocation.args, { ...base, encoding: 'utf8' });
  if (!piped.error) {
    return {
      ok: true,
      status: piped.status,
      signal: piped.signal ?? null,
      mode: 'pipe',
      reason: null,
      text: `${piped.stdout ?? ''}${piped.stderr ?? ''}`,
    };
  }
  if (piped.error.code === 'ENOENT') {
    return { ok: false, status: null, signal: null, mode: 'none', reason: 'ENOENT', text: '' };
  }
  if (piped.error.code === 'ETIMEDOUT' || piped.signal) {
    return {
      ok: false,
      status: null,
      signal: piped.signal ?? null,
      mode: 'none',
      reason: piped.error.code === 'ETIMEDOUT' ? 'timeout' : 'signal',
      text: '',
    };
  }
  const tempFile = join(tmpdir(), `ruoyi-capability-probe-${process.pid}-${Date.now()}.txt`);
  let descriptor = null;
  try {
    descriptor = openSync(tempFile, 'w');
    const redirected = spawnSync(invocation.command, invocation.args, {
      ...base,
      stdio: ['ignore', descriptor, descriptor],
    });
    closeSync(descriptor);
    descriptor = null;
    if (redirected.error) {
      return {
        ok: false,
        status: null,
        signal: redirected.signal ?? null,
        mode: 'none',
        reason:
          redirected.error.code === 'ETIMEDOUT' ? 'timeout' : (redirected.error.code ?? 'unknown'),
        text: '',
      };
    }
    return {
      ok: true,
      status: redirected.status,
      signal: redirected.signal ?? null,
      mode: 'temp-fd',
      reason: null,
      text: readFileSync(tempFile, 'utf8'),
    };
  } catch (error) {
    return {
      ok: false,
      status: null,
      signal: null,
      mode: 'none',
      reason: error?.code ?? 'unknown',
      text: '',
    };
  } finally {
    if (descriptor !== null) {
      try {
        closeSync(descriptor);
      } catch {
        // 句柄可能已关闭，忽略
      }
    }
    try {
      unlinkSync(tempFile);
    } catch {
      // 临时文件可能从未创建，忽略
    }
  }
}

/** 在 PATH 中定位可执行文件（不猜路径、不做静默回退）。 */
function findOnPath(name) {
  const names =
    process.platform === 'win32' ? [`${name}.exe`, `${name}.cmd`, `${name}.bat`, name] : [name];
  for (const dir of String(process.env.PATH ?? '').split(delimiter)) {
    if (dir === '') continue;
    for (const candidate of names) {
      const full = join(dir, candidate);
      if (existsSync(full)) return full;
    }
  }
  return null;
}

/**
 * 把一次探测判成「可用 / 不可用」（纯函数，便于自检注入合成结果，不需要真的执行命令）。
 * 可用四条件：定位到文件、执行成功（退出码 0）、输出非空、输出含该工具的严格版本行（语义版本；
 * Docker 单独要求整段输出就是合法 ServerVersion）。
 */
function classifyProbe(input) {
  const { name, located, path, captured } = input ?? {};
  const record = {
    name: name ?? null,
    located: located === true && typeof path === 'string' && path !== '',
    path: typeof path === 'string' && path !== '' ? path : null,
    usable: false,
    status: null,
    signal: null,
    mode: 'none',
    text: null,
    version: null,
    failure: null,
  };
  if (!record.located) {
    record.failure = 'not-found';
    return record;
  }
  if (!captured || captured.ok !== true) {
    record.mode = captured?.mode ?? 'none';
    record.signal = captured?.signal ?? null;
    record.failure = captured?.reason ?? 'not-executed';
    return record;
  }
  record.status = captured.status ?? null;
  record.signal = captured.signal ?? null;
  record.mode = captured.mode ?? 'none';
  const line = firstLine(captured.text);
  record.text = line;
  if (record.status !== 0) {
    record.failure = `exit-status:${record.status === null ? 'null' : record.status}`;
    return record;
  }
  if (line === null) {
    record.failure = 'empty-output';
    return record;
  }
  const version =
    name === 'docker' ? parseDockerVersion(captured.text) : parseToolVersion(name, captured.text);
  if (version === null) {
    record.failure = 'output-unparsable';
    return record;
  }
  record.version = version;
  record.usable = true;
  return record;
}

/** 探测一个命令：先定位，再执行，最后按 classifyProbe 判定可用性。 */
function probeCommand(spec) {
  const explicit = typeof spec.path === 'string' && spec.path !== '' ? spec.path : null;
  const located = explicit ?? findOnPath(spec.name);
  if (!located || !existsSync(located)) {
    return classifyProbe({ name: spec.name, located: false, path: null, captured: null });
  }
  const captured = captureOutput(located, spec.args);
  return classifyProbe({ name: spec.name, located: true, path: located, captured });
}

/** 在一组候选中取第一个「确实可用」的工具，并保留全部尝试记录用于诊断。 */
function probeTools(specs) {
  const attempts = specs.map((spec) => probeCommand(spec));
  return { available: attempts.find((item) => item.usable === true) ?? null, attempts };
}

/** 把「定位到但不可用」的尝试写成诊断文本；全部未定位到时用 missingLabel。 */
function describeProbe(record, attempts, missingLabel) {
  if (record && record.usable === true) return `${record.name}（${record.path}）`;
  const located = (attempts ?? []).filter((item) => item.located === true);
  if (located.length === 0) return missingLabel;
  return located.map((item) => `${item.name}（${item.path}）不可用：${item.failure}`).join(' / ');
}

function parseJavaMajor(text) {
  const match =
    /(?:java|openjdk|jdk)\s+version\s+"([^"]+)"/i.exec(text ?? '') ??
    /JAVA_VERSION="([^"]+)"/.exec(text ?? '');
  const raw = match ? match[1] : null;
  if (!raw) return null;
  const legacy = /^1\.(\d+)/.exec(raw);
  const modern = /^(\d+)/.exec(raw);
  const digits = legacy ? legacy[1] : modern ? modern[1] : null;
  return digits === null ? null : Number(digits);
}

function parseMavenVersion(text) {
  const match = /Apache Maven\s+(\d+(?:\.\d+)*)/i.exec(text ?? '');
  return match ? match[1] : null;
}

function javaHomeFromExecutable(executablePath) {
  const binDir = dirname(executablePath);
  return dirname(binDir).length > 0 && /^bin$/i.test(binDir.split(/[\\/]/).pop() ?? '')
    ? dirname(binDir)
    : null;
}

/**
 * 探测 JDK 与 Maven（解析优先级：显式参数 → 环境变量 → PATH，与 check-gate.mjs 一致）。
 * Maven 探针需要 JAVA_HOME 才能启动，这里用同一个解析结果注入。
 */
function probeToolchain(options) {
  const jdkCandidates = [];
  if (options?.javaHome)
    jdkCandidates.push({
      path: join(options.javaHome, 'bin', EXECUTABLE_NAMES.javaHome()[0]),
      source: 'explicit-flag',
    });
  const envJava = String(process.env.JAVA_HOME ?? '').trim();
  if (envJava !== '')
    jdkCandidates.push({
      path: join(envJava, 'bin', EXECUTABLE_NAMES.javaHome()[0]),
      source: 'env:JAVA_HOME',
    });

  const jdk = {
    usable: false,
    found: false,
    path: null,
    source: null,
    major: null,
    version: null,
    status: null,
    mode: 'none',
    failure: 'not-found',
    attempts: [],
  };
  const javaOnPath = findOnPath('java');
  if (javaOnPath) jdkCandidates.push({ path: javaOnPath, source: 'path' });
  for (const candidate of jdkCandidates) {
    if (!existsSync(candidate.path)) continue;
    const captured = captureOutput(candidate.path, ['-version']);
    const major = captured.ok ? parseJavaMajor(captured.text) : null;
    const attempt = {
      path: candidate.path,
      source: candidate.source,
      major,
      version: captured.ok ? firstLine(captured.text) : null,
      status: captured.status ?? null,
      mode: captured.mode,
      failure: null,
    };
    if (major === null) {
      attempt.failure = captured.ok ? 'version-unparsable' : captured.reason;
    } else if (attempt.status !== 0) {
      attempt.failure = `exit-status:${attempt.status === null ? 'null' : attempt.status}`;
    }
    jdk.attempts.push(attempt);
    if (attempt.failure === null) {
      jdk.usable = true;
      jdk.found = true;
      jdk.path = attempt.path;
      jdk.source = attempt.source;
      jdk.major = major;
      jdk.version = attempt.version;
      jdk.status = attempt.status;
      jdk.mode = attempt.mode;
      jdk.failure = null;
      break;
    }
    // 定位到但不可用：把真实原因写回顶层记录，避免诊断只显示 not-found
    jdk.path = attempt.path;
    jdk.source = attempt.source;
    jdk.major = attempt.major;
    jdk.version = attempt.version;
    jdk.status = attempt.status;
    jdk.mode = attempt.mode;
    jdk.failure = attempt.failure;
  }

  const jdkHomeForMaven =
    options?.javaHome ??
    (envJava !== '' ? envJava : (javaHomeFromExecutable(jdk.path ?? '') ?? null));

  const mavenCandidates = [];
  if (options?.mavenHome) {
    for (const name of EXECUTABLE_NAMES.mavenHome())
      mavenCandidates.push({ path: join(options.mavenHome, 'bin', name), source: 'explicit-flag' });
  }
  for (const variable of ['MAVEN_HOME', 'M2_HOME']) {
    const value = String(process.env[variable] ?? '').trim();
    if (value !== '') {
      for (const name of EXECUTABLE_NAMES.mavenHome())
        mavenCandidates.push({ path: join(value, 'bin', name), source: `env:${variable}` });
    }
  }
  const mvnOnPath = findOnPath('mvn');
  if (mvnOnPath) mavenCandidates.push({ path: mvnOnPath, source: 'path' });

  const maven = {
    usable: false,
    found: false,
    path: null,
    source: null,
    version: null,
    status: null,
    mode: 'none',
    failure: 'not-found',
    attempts: [],
  };
  for (const candidate of mavenCandidates) {
    if (!existsSync(candidate.path)) continue;
    const environment = { ...process.env };
    if (jdkHomeForMaven) environment.JAVA_HOME = jdkHomeForMaven;
    const captured = captureOutput(candidate.path, ['-v'], environment);
    const version = captured.ok ? parseMavenVersion(captured.text) : null;
    const attempt = {
      path: candidate.path,
      source: candidate.source,
      version,
      status: captured.status ?? null,
      mode: captured.mode,
      failure: null,
    };
    if (version === null) {
      attempt.failure = captured.ok ? 'version-unparsable' : captured.reason;
    } else if (attempt.status !== 0) {
      attempt.failure = `exit-status:${attempt.status === null ? 'null' : attempt.status}`;
    }
    maven.attempts.push(attempt);
    if (attempt.failure === null) {
      maven.usable = true;
      maven.found = true;
      maven.path = attempt.path;
      maven.source = attempt.source;
      maven.version = version;
      maven.status = attempt.status;
      maven.mode = attempt.mode;
      maven.failure = null;
      break;
    }
    // 定位到但不可用：把真实原因写回顶层记录，避免诊断只显示 not-found
    maven.path = attempt.path;
    maven.source = attempt.source;
    maven.version = attempt.version;
    maven.status = attempt.status;
    maven.mode = attempt.mode;
    maven.failure = attempt.failure;
  }

  return { jdk, maven, jdkHomeForMaven };
}

/* ------------------------------------------------------------------ *
 * 显式探测路径（fail-closed）
 * ------------------------------------------------------------------ */

function defaultDirectoryExists(target) {
  try {
    return existsSync(target);
  } catch {
    return false;
  }
}

function defaultFileExists(target) {
  try {
    return existsSync(target);
  } catch {
    return false;
  }
}

function validateExplicitHome(kind, value, label, deps) {
  const flag = EXPLICIT_FLAGS[kind];
  const directoryExists = deps?.directoryExists ?? defaultDirectoryExists;
  const fileExists = deps?.fileExists ?? defaultFileExists;
  if (typeof value !== 'string' || value.trim() === '') {
    return { error: `${flag} 需要一个非空路径值` };
  }
  const target = value.trim();
  if (!isSafeExecutablePath(target)) {
    return {
      error: `${flag} 路径含引号或控制字符（拒绝执行以防命令注入）：${target}`,
    };
  }
  if (!isAbsolute(target)) {
    return { error: `${flag} 必须是绝对路径（可复现探测不接受相对路径或空值）：${target}` };
  }
  const home = resolve(target);
  if (!directoryExists(home)) {
    return { error: `${flag} 指向的目录不存在或不可读：${home}` };
  }
  const names = EXECUTABLE_NAMES[kind]();
  const executables = names.map((name) => join(home, 'bin', name));
  const present = executables.filter((executable) => fileExists(executable));
  if (present.length === 0) {
    return { error: `${flag} 不是有效的 ${label}（bin 下缺少 ${names.join(' / ')}）：${home}` };
  }
  if (!present.some((executable) => isSafeShellPath(executable))) {
    return {
      error: `${flag} 下的可执行文件需经 cmd.exe 启动，而路径含 shell 危险元字符（拒绝以防命令注入；请改用不含元字符的目录）：${present.join(' / ')}`,
    };
  }
  return { home };
}

/* ------------------------------------------------------------------ *
 * SHA-256（纯 JavaScript；仅用于外部审计模式的输入摘要核验）
 *
 * 与本目录 check-provenance.mjs 同一实现口径：不导入 node:crypto（它不在
 * boundary.allowedImportSpecifiers 白名单内），也不调用任何外部命令。两个文件各自内联一份
 * 是刻意为之——本目录的检查器都是「可单独分发的单文件 CLI」，跨文件 import 一个自身即入口的
 * 兄弟脚本会在导入时执行对方的检查流程。
 * ------------------------------------------------------------------ */

const SHA256_K = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];

function rotateRight(value, shift) {
  return ((value >>> shift) | (value << (32 - shift))) >>> 0;
}

/** 计算 SHA-256 十六进制摘要；接受字符串（UTF-8）或字节数组。 */
function sha256Hex(input) {
  const bytes =
    typeof input === 'string'
      ? new Uint8Array(Buffer.from(input, 'utf8'))
      : input instanceof Uint8Array
        ? input
        : new Uint8Array(0);
  const bitLength = bytes.length * 8;
  const paddedLength = (((bytes.length + 8) >> 6) + 1) << 6;
  const padded = new Uint8Array(paddedLength);
  padded.set(bytes);
  padded[bytes.length] = 0x80;
  const view = new DataView(padded.buffer, padded.byteOffset, padded.byteLength);
  view.setUint32(paddedLength - 8, Math.floor(bitLength / 0x100000000), false);
  view.setUint32(paddedLength - 4, bitLength % 0x100000000, false);
  const state = [
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ];
  const schedule = new Uint32Array(64);
  for (let offset = 0; offset < paddedLength; offset += 64) {
    for (let index = 0; index < 16; index += 1) {
      schedule[index] = view.getUint32(offset + index * 4, false);
    }
    for (let index = 16; index < 64; index += 1) {
      const w15 = schedule[index - 15];
      const w2 = schedule[index - 2];
      const s0 = (rotateRight(w15, 7) ^ rotateRight(w15, 18) ^ (w15 >>> 3)) >>> 0;
      const s1 = (rotateRight(w2, 17) ^ rotateRight(w2, 19) ^ (w2 >>> 10)) >>> 0;
      schedule[index] = (schedule[index - 16] + s0 + schedule[index - 7] + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, h] = state;
    for (let index = 0; index < 64; index += 1) {
      const sigma1 = (rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25)) >>> 0;
      const choose = ((e & f) ^ (~e & g)) >>> 0;
      const temp1 = (h + sigma1 + choose + SHA256_K[index] + schedule[index]) >>> 0;
      const sigma0 = (rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22)) >>> 0;
      const majority = ((a & b) ^ (a & c) ^ (b & c)) >>> 0;
      const temp2 = (sigma0 + majority) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }
    state[0] = (state[0] + a) >>> 0;
    state[1] = (state[1] + b) >>> 0;
    state[2] = (state[2] + c) >>> 0;
    state[3] = (state[3] + d) >>> 0;
    state[4] = (state[4] + e) >>> 0;
    state[5] = (state[5] + f) >>> 0;
    state[6] = (state[6] + g) >>> 0;
    state[7] = (state[7] + h) >>> 0;
  }
  return state.map((value) => value.toString(16).padStart(8, '0')).join('');
}

/* ------------------------------------------------------------------ *
 * 外部审计模式（--audit-root / --audit-commit）：仓库外固定 commit 检出的只读前置核验
 *
 * 目的：打破「证据要先有门禁 admitted、门禁又要先有证据」的循环——先在**仓库之外**的隔离检出目录里
 * 对固定 commit 生成真实证据（许可证/NOTICE、SBOM、漏洞扫描、PostgreSQL 兼容性），再把「证据文件」
 * 回填到 services/ruoyi-api/compliance/provenance/ 下，由 check-provenance.mjs 判定；只有真实外部
 * 审计产物就位后，才谈得上仓库内的准入门禁（stage=admitted）。
 *
 * 本模式**只做只读前置核验**，逐条对应契约：
 *   1. 路径与隔离：审计根必须绝对、无引号/控制字符、无 `..` 段、不是文件系统根；其 realpath 必须
 *      **完全位于仓库边界根目录（services/ruoyi-api）之外**——拒绝边界根本身与边界内任意子路径、
 *      仓库工作树内任意路径、仓库的上级目录与文件系统根；realpath 经符号链接/联接逃逸回仓库同样被拦；
 *   2. 固定提交：`--audit-commit` 必须是 40 位小写十六进制 SHA（短 SHA、分支名、占位词一律拒绝）；
 *   3. 检出：`<审计根>/.git` 必须存在，`git rev-parse --is-inside-work-tree` 必须严格输出 `true`；
 *   4. 外部事实：`git rev-parse HEAD` 必须**完全等于**固定 commit；`git status --porcelain` 必须没有
 *      任何条目（工作树干净：已跟踪改动与未跟踪文件都不算干净，生成物必须写到检出目录之外）；
 *   5. 输入与摘要：`git cat-file -e HEAD:pom.xml` 必须成功；可选读取 `git show HEAD:pom.xml` 的内存
 *      摘要（字节数、行数、artifactId、java.version、spring-boot.version 与内容 SHA-256），用于与
 *      可选的 `--audit-pom-sha256` 比对——**不复制、不落盘任何文件**。
 *
 * 本模式**不**做的事（与默认的能力探测刻意区分）：
 *   - 不要求仓库内 gate admitted，也**不读**、不改 gate-manifest.json：仓库内的 gate stage 不可能
 *     改变本判定（stage=admitted 也不会让本模式变成 ready）；
 *   - 不创建、不复制、不移动任何源码或证据文件（既不写仓库，也不写审计目录）；
 *   - 不联网、不安装、不下载依赖，也不执行任何构建目标；
 *   - 不生成、不预填、不伪造证据，不推进 provenance 清单的任何状态。
 * 判定只有两个 verdict 取值：`external-audit-ready`（退出码 0）与 `blocked`（退出码 1 违规 / 2 前置
 * 未满足）；报告里 `admitted` 与 `verified` **恒为 false**，且不出现「准入通过」「已核验」这类字样。
 *
 * Git 只读保证：所有 git 调用都带 `-C <审计根>` 与 `GIT_OPTIONAL_LOCKS=0`，因此 git 不会去抢
 * 索引锁、不会刷新或写回 .git/index；`--porcelain` 只读工作树状态。本模式也不执行任何写命令。
 * ------------------------------------------------------------------ */

/** 固定 commit：只接受 40 位小写十六进制（与 gate-manifest.json 的 commitFormat 同口径）。 */
const AUDIT_COMMIT_PATTERN = /^[0-9a-f]{40}$/;
const AUDIT_SHA256_PATTERN = /^[0-9a-f]{64}$/;
const AUDIT_ROOT_POM = 'pom.xml';
/** porcelain v1 的真实条目形状（`XY <路径>`）；git 打到 stderr 的告警行不匹配，因而不会被误当变更。 */
const AUDIT_PORCELAIN_ENTRY = /^[ MADRCU?!]{2} /;

/**
 * 外部审计模式的 verdict **只有两个取值**（契约要求）：`external-audit-ready` 与 `blocked`。
 * 隔离被破坏（审计根落在仓库边界根目录内、realpath 经符号链接/联接逃逸回仓库）或外部事实与固定
 * commit 矛盾（HEAD 不一致、工作树不干净）都归入 `blocked`：它们只作为诊断明细保留在 `violations`
 * 里，**绝不**产生第三个 verdict 取值。退出码仍分别报告 1（违规）与 2（前置未满足）以便定位原因。
 */
const AUDIT_VERDICT = {
  ready: 'external-audit-ready',
  blocked: 'blocked',
  blockedByViolation: 'blocked',
};

function realpathOrNull(target) {
  try {
    return realpathSync(target);
  } catch {
    return null;
  }
}

function lstatOrMissing(target) {
  try {
    const info = lstatSync(target);
    return {
      exists: true,
      isSymbolicLink: info.isSymbolicLink(),
      isDirectory: info.isDirectory(),
      isFile: info.isFile(),
    };
  } catch {
    return { exists: false, isSymbolicLink: false, isDirectory: false, isFile: false };
  }
}

/** 严格取一条 40 位小写 SHA：输出必须**整段就是**它（不做「在文本里任意搜 SHA」的宽松匹配）。 */
function strictSha(text) {
  const value = String(text ?? '')
    .replace(/\r/g, '')
    .trim();
  return AUDIT_COMMIT_PATTERN.test(value) ? value : null;
}

/**
 * 严格解析 `git status --porcelain`（fail-closed）：返回 `{ entries }`。
 * 输出里只要出现**非 porcelain 条目**的行（git 告警、诊断文本、进度信息），或本次探测本身失败，
 * 一律返回 `null`，由调用方按「工作树状态不可读」处理——绝不在不可信文本里挑几行当作「干净」。
 */
function strictPorcelain(text, ok) {
  if (ok !== true) return null;
  const lines = String(text ?? '')
    .split(/\r?\n/)
    .filter((line) => line !== '');
  if (lines.some((line) => !AUDIT_PORCELAIN_ENTRY.test(line))) return null;
  return { entries: lines };
}

/**
 * 从 `git show HEAD:pom.xml` 的**内存文本**取摘要：只记录统计量与声明值，**不落盘、不复制任何文件**。
 * `contentCopied` 恒为 false，作为「本模式没有把上游文件写进仓库或输出目录」的机器可读标记。
 */
function summarizePomText(text) {
  const source = typeof text === 'string' ? text : '';
  const pick = (pattern) => {
    const match = pattern.exec(source);
    return match === null ? null : match[1].trim().slice(0, 64);
  };
  return {
    bytes: Buffer.byteLength(source, 'utf8'),
    lines: source === '' ? 0 : source.split(/\r?\n/).length,
    artifactId: pick(/<artifactId>\s*([^<]{1,64})\s*<\/artifactId>/),
    javaVersion: pick(/<java\.version>\s*([^<]{1,64})\s*<\/java\.version>/),
    springBootVersion: pick(/<spring-boot\.version>\s*([^<]{1,64})\s*<\/spring-boot\.version>/),
    contentCopied: false,
  };
}
/** 路径比较基线：Windows 上大小写不敏感（同一目录不得因大小写被判成两个位置）。 */
function comparablePath(target, platform = process.platform) {
  const value = resolve(String(target ?? ''));
  return platform === 'win32' ? value.toLowerCase() : value;
}

/** child 是否等于 parent 或位于 parent 之下；两者都必须已经过 realpath 解析。 */
function pathIsInside(child, parent, platform = process.platform) {
  if (typeof child !== 'string' || child === '' || typeof parent !== 'string' || parent === '') {
    return false;
  }
  const inner = comparablePath(child, platform);
  const outer = comparablePath(parent, platform);
  if (inner === outer) return true;
  const diff = relative(outer, inner);
  return diff !== '' && !diff.startsWith('..') && !isAbsolute(diff);
}

/** 是否是文件系统根（驱动器根 / POSIX 根）：dirname(x) === x。 */
function isFileSystemRoot(target) {
  const value = resolve(String(target ?? ''));
  return value !== '' && dirname(value) === value;
}

/** 路径里是否含 `..` 段（拒绝随工作目录漂移的写法）。 */
function hasParentSegment(target) {
  return String(target ?? '')
    .split(/[\\/]+/)
    .includes('..');
}

/**
 * 隔离判定（纯函数）：审计根的 realpath 必须真实位于**仓库边界根目录（services/ruoyi-api）之外**，
 * 且不能是仓库的上级目录。规则按「最贴近的边界」排序，先判边界再判仓库：
 *   1. 解析到文件系统根 → 违规（整盘/POSIX 根不是隔离审计目录）；
 *   2. 就是边界根目录本身 → 违规（拒绝把边界目录当作外部审计目录）；
 *   3. 位于边界根目录之内（任意子路径）→ 违规；
 *   4. 位于仓库工作树内（边界之外但在仓库内）→ 违规（外部审计必须在仓库之外隔离进行）；
 *   5. 是仓库的上级目录 → 违规（`git -C <上级目录>` 会沿父目录找到仓库自身的 .git，隔离不可靠）。
 *
 * 由于符号链接/联接已由调用方用 realpathSync 解析，**符号链接逃逸回仓库**会在这里按真实路径被拦下，
 * 与「给定路径看起来在仓库外」无关。`boundaryReal` 缺省回落到 `repoReal`（旧调用点语义不变）；
 * realpath 不可得时返回空数组，由调用方另行按「被阻断」fail-closed 处理。
 */
function auditIsolationViolations(
  rootReal,
  repoReal,
  boundaryReal = null,
  platform = process.platform,
) {
  const violations = [];
  if (typeof rootReal !== 'string' || rootReal === '') return violations;
  const boundary =
    typeof boundaryReal === 'string' && boundaryReal !== '' ? boundaryReal : repoReal;
  if (isFileSystemRoot(rootReal)) {
    violations.push(`审计根解析到文件系统根 ${rootReal}：拒绝以整盘/POSIX 根作为隔离审计目录`);
    return violations;
  }
  if (comparablePath(rootReal, platform) === comparablePath(boundary, platform)) {
    violations.push(
      `审计根 ${rootReal} 就是仓库边界根目录本身：拒绝把边界目录当作外部审计目录，也拒绝在边界内生成证据`,
    );
    return violations;
  }
  if (pathIsInside(rootReal, boundary, platform)) {
    violations.push(
      `审计根 ${rootReal} 位于仓库边界根目录 ${boundary} 内：外部审计必须在边界之外隔离进行，仓库内不得生成证据`,
    );
    return violations;
  }
  if (pathIsInside(rootReal, repoReal, platform)) {
    violations.push(
      `审计根 ${rootReal} 位于仓库 ${repoReal} 内：外部审计必须在仓库之外隔离进行，仓库内不得生成证据`,
    );
  } else if (pathIsInside(repoReal, rootReal, platform)) {
    violations.push(
      `审计根 ${rootReal} 是仓库 ${repoReal} 的上级目录：git -C 会沿父目录找到仓库自身的 .git，隔离不可靠`,
    );
  }
  return violations;
}

/**
 * 外部审计前置判定（纯函数：不读磁盘、不执行命令；磁盘与 Git 事实由 collectAuditFacts 或自检注入）。
 *
 * 判定顺序与语义（与 `--audit-root` / `--audit-commit` 契约逐条对应）：
 *   1. 路径与隔离：审计根的 realpath 必须真实位于**仓库边界根目录之外**——拒绝边界根本身、边界内任意
 *      子路径、仓库工作树内任意路径、仓库的上级目录与文件系统根；realpath 与给定路径不一致时按解析后的
 *      真实路径判定，因此**符号链接/联接逃逸回仓库**同样会被拦下；
 *   2. 固定提交：`--audit-commit` 必须是 40 位小写十六进制 SHA（短 SHA、分支名、占位词一律拒绝）；
 *   3. 检出：`<审计根>/.git` 必须存在，且 `git rev-parse --is-inside-work-tree` 必须严格输出 `true`；
 *   4. 外部事实：`git rev-parse HEAD` 必须**完全等于**固定 commit；`git status --porcelain` 必须没有任何
 *      条目（工作树干净：已跟踪改动与未跟踪文件都不允许，生成物必须写到检出目录之外）；
 *   5. 输入：`git cat-file -e HEAD:pom.xml` 必须成功（固定 commit 的根 pom 存在）；可选读取
 *      `git show HEAD:pom.xml` 的**内存摘要**（字节数、行数、artifactId、java.version、
 *      spring-boot.version 与内容 SHA-256），用于与可选的 `--audit-pom-sha256` 比对——**不复制文件**。
 *
 * verdict 只有两个取值（契约要求）：
 *   - `external-audit-ready`（退出码 0）：以上全部成立；
 *   - `blocked`（退出码 1 违规 / 2 前置未满足）：任一不成立。
 * `admitted` 与 `verified` **恒为 false**：本模式不读取 `gate-manifest.json`，仓库内的 gate stage 不可能
 * 改变本判定（stage=admitted 也不会让本模式变成 ready）。
 */
function evaluateAudit(input) {
  const platform = typeof input?.platform === 'string' ? input.platform : process.platform;
  const auditRoot = typeof input?.auditRoot === 'string' ? input.auditRoot : '';
  const auditCommit = typeof input?.auditCommit === 'string' ? input.auditCommit : '';
  const declaredSha256 =
    typeof input?.auditPomSha256 === 'string' && input.auditPomSha256 !== ''
      ? input.auditPomSha256
      : null;
  const realpath = typeof input?.realpath === 'function' ? input.realpath : realpathOrNull;
  const statPath = typeof input?.statPath === 'function' ? input.statPath : lstatOrMissing;
  const git = isPlainObject(input?.git) ? input.git : {};
  const repoReal =
    typeof input?.repoReal === 'string' && input.repoReal !== ''
      ? input.repoReal
      : (realpathOrNull(REPO_ROOT) ?? REPO_ROOT);
  const boundaryReal =
    typeof input?.boundaryReal === 'string' && input.boundaryReal !== ''
      ? input.boundaryReal
      : (realpathOrNull(BOUNDARY_ROOT) ?? BOUNDARY_ROOT);

  const blocked = [];
  const report = {
    mode: 'external-audit',
    audit: {
      root: auditRoot,
      rootRealPath: null,
      rootSymlinked: false,
      repoRealPath: repoReal,
      boundaryRealPath: boundaryReal,
      commit: auditCommit,
      declaredPomSha256: declaredSha256,
      gitDir: { path: join(auditRoot, '.git'), present: false, isDirectory: false, isFile: false },
      git: {},
      pom: {},
    },
    statements: {
      admitted: false,
      verified: false,
      evidenceGenerated: false,
      inRepoGateEvaluated: false,
      gateStageConsulted: false,
      note: '本模式只报告「外部审计前置可执行（external-audit-ready）」：不要求也不声称仓库内 gate admitted，不声称 verified，不生成、不复制、不下载任何证据或源码；仓库内 gate-manifest.json 的 stage 不参与本判定。',
    },
    preconditions: [],
    violations: [],
    blocked: [],
    nextSteps: [],
  };

  // 1) 固定 commit 形状（preflight 已拦一次；这里再 fail-closed 拦一次，防绕过）
  const commitOk = AUDIT_COMMIT_PATTERN.test(auditCommit);
  if (!commitOk) {
    report.violations.push(
      `固定 commit 必须是 40 位小写十六进制 SHA（当前 ${formatValue(auditCommit)}）：不接受短 SHA、分支名或占位词`,
    );
  }
  let declaredSha256Ok = true;
  if (declaredSha256 !== null && !AUDIT_SHA256_PATTERN.test(declaredSha256)) {
    declaredSha256Ok = false;
    report.violations.push(
      `声明的根 pom 内容摘要必须是 64 位小写十六进制 SHA-256（当前 ${formatValue(declaredSha256)}）`,
    );
  }

  // 2) 隔离：realpath 的真实位置必须在仓库边界之外，且不能是仓库的上级目录
  const rootReal =
    typeof input?.rootReal === 'string' && input.rootReal !== ''
      ? input.rootReal
      : realpath(auditRoot);
  const rootStat = statPath(auditRoot);
  const rootDirectoryOk = rootStat.exists === true && rootStat.isDirectory === true;
  report.audit.rootRealPath = rootReal;
  report.audit.rootSymlinked =
    rootReal !== null && comparablePath(rootReal, platform) !== comparablePath(auditRoot, platform);
  const isolationViolations = auditIsolationViolations(rootReal, repoReal, boundaryReal, platform);
  report.violations.push(...isolationViolations);
  if (rootReal === null) {
    blocked.push(`审计根无法解析真实路径（realpathSync 失败）：${auditRoot}`);
  } else if (!rootDirectoryOk) {
    blocked.push(`审计根不是可读目录：${auditRoot}`);
  }

  // 3) 审计根必须是 Git 工作树检出：<审计根>/.git 必须存在（目录，或 worktree/submodule 的 .git 文件）
  const gitDirPath = join(auditRoot, '.git');
  const gitDirStat = statPath(gitDirPath);
  const gitDirPresent =
    gitDirStat.exists === true && (gitDirStat.isDirectory === true || gitDirStat.isFile === true);
  report.audit.gitDir = {
    path: gitDirPath,
    present: gitDirPresent,
    isDirectory: gitDirStat.isDirectory === true,
    isFile: gitDirStat.isFile === true,
  };
  if (!gitDirPresent) {
    blocked.push(
      `审计根下缺少 ${gitDirPath}：外部审计根必须是一个 Git 工作树检出（缺少 .git 无法把证据归属到固定 commit）`,
    );
  }

  // 4) 外部 Git 事实：HEAD 完全相等、工作树干净、固定 commit 的根 pom 存在
  const insideWorkTree = git.insideWorkTree === true;
  const gitHead = typeof git.head === 'string' && git.head !== '' ? git.head : null;
  const statusEntries = Array.isArray(git.statusEntries) ? git.statusEntries : null;
  const headMatches = gitHead !== null && gitHead === auditCommit;
  const worktreeClean = statusEntries !== null && statusEntries.length === 0;
  const pomAtHead = git.pomAtHead === true;
  const pomContentSha256 = typeof git.pomContentSha256 === 'string' ? git.pomContentSha256 : null;
  const pomSummary = isPlainObject(git.pomSummary) ? git.pomSummary : null;
  let digestMatches = null;
  if (declaredSha256 !== null && declaredSha256Ok && pomContentSha256 !== null) {
    digestMatches = declaredSha256 === pomContentSha256;
    if (!digestMatches) {
      report.violations.push(
        `固定 commit 根 ${AUDIT_ROOT_POM} 的内容摘要与声明值不一致：声明 ${declaredSha256}，实际 ${pomContentSha256}`,
      );
    }
  }
  if (git.skipped === true) {
    blocked.push(`未执行外部 Git 核验：${git.skippedReason ?? '隔离判定未通过'}`);
  } else if (git.available !== true) {
    blocked.push(`外部 Git 核验不可用：${git.error ?? '未找到 git 或目标目录不是 Git 仓库'}`);
  } else {
    if (!insideWorkTree) {
      blocked.push(
        `外部目录未被 git 认定为工作树：git rev-parse --is-inside-work-tree 未严格输出 true（输出 ${formatValue(git.insideWorkTreeRaw ?? null)}）`,
      );
    }
    if (gitHead === null) {
      blocked.push(
        `无法读取外部 HEAD：${git.headError ?? 'git rev-parse HEAD 未给出严格的 40 位小写 SHA'}`,
      );
    } else if (!headMatches) {
      report.violations.push(
        `外部 HEAD（${gitHead}）与固定 commit（${auditCommit}）不一致：该目录不是这个提交的检出`,
      );
    }
    if (statusEntries === null) {
      blocked.push(
        `无法严格解析工作树状态：${git.statusError ?? 'git status --porcelain 输出不可用或含非 porcelain 行'}`,
      );
    } else if (statusEntries.length > 0) {
      const shown = statusEntries.slice(0, 3).join(' / ');
      report.violations.push(
        `工作树不干净：${statusEntries.length} 个条目相对该提交发生变化（${shown}${statusEntries.length > 3 ? ' …' : ''}），证据无法归属到 ${auditCommit}；请把生成物写到检出目录之外`,
      );
    }
    if (git.pomAtHeadError) {
      blocked.push(`无法判定固定 commit 的根 ${AUDIT_ROOT_POM} 是否存在：${git.pomAtHeadError}`);
    } else if (!pomAtHead) {
      blocked.push(
        `固定 commit ${auditCommit} 的根 ${AUDIT_ROOT_POM} 不存在（git cat-file -e HEAD:${AUDIT_ROOT_POM} 非 0 退出）：没有可生成 SBOM/依赖许可证清单的输入`,
      );
    }
  }

  report.audit.git = {
    available: git.available === true,
    skipped: git.skipped === true,
    insideWorkTree,
    insideWorkTreeRaw: typeof git.insideWorkTreeRaw === 'string' ? git.insideWorkTreeRaw : null,
    head: gitHead,
    headMatches,
    statusReadable: statusEntries !== null,
    statusEntries: statusEntries === null ? null : statusEntries.length,
    pomAtHead,
    pomContentSha256,
    pomSummary,
  };
  report.audit.pom = {
    path: `HEAD:${AUDIT_ROOT_POM}`,
    presentAtHead: pomAtHead,
    contentSha256: pomContentSha256,
    summary: pomSummary,
    declaredSha256,
    declaredSha256Matches: digestMatches,
  };

  report.preconditions = [
    precondition(
      'audit-root-isolated',
      '审计根真实位于仓库边界根目录（services/ruoyi-api）之外，且不是仓库的上级目录或文件系统根',
      rootReal !== null && isolationViolations.length === 0 && rootDirectoryOk,
      [
        `realpath=${rootReal ?? 'null'}`,
        `boundary=${boundaryReal}`,
        `repo=${repoReal}`,
        report.audit.rootSymlinked
          ? '给定路径是符号链接/联接，已按解析后的真实路径判定'
          : '给定路径即真实路径',
        rootDirectoryOk ? '目录可读' : `不是可读目录（${auditRoot}）`,
      ].join('；'),
    ),
    precondition(
      'audit-commit-format',
      '固定 commit 是 40 位小写十六进制 SHA',
      commitOk,
      commitOk ? auditCommit : `非法取值 ${formatValue(auditCommit)}`,
    ),
    precondition(
      'audit-git-dir',
      '审计根下存在 .git（Git 工作树检出）',
      gitDirPresent,
      gitDirPresent ? `${gitDirPath} 存在` : `${gitDirPath} 不存在`,
    ),
    precondition(
      'audit-worktree-inside',
      'git rev-parse --is-inside-work-tree 严格输出 true',
      insideWorkTree,
      insideWorkTree ? 'true' : `不是 true（输出 ${formatValue(git.insideWorkTreeRaw ?? null)}）`,
    ),
    precondition(
      'audit-git-head',
      '外部 git rev-parse HEAD 完全等于固定 commit',
      headMatches,
      gitHead === null
        ? '未取得外部 HEAD（见阻断项）'
        : headMatches
          ? `${gitHead}`
          : `HEAD=${gitHead}，固定 commit=${auditCommit}`,
    ),
    precondition(
      'audit-worktree-clean',
      '工作树干净（git status --porcelain 无任何条目：已跟踪改动与未跟踪文件都不允许）',
      worktreeClean,
      statusEntries === null
        ? '未取得工作树状态（见阻断项）'
        : statusEntries.length === 0
          ? '条目 0 个'
          : `条目 ${statusEntries.length} 个：${statusEntries.slice(0, 3).join(' / ')}`,
    ),
    precondition(
      'audit-head-pom',
      `固定 commit 的根 ${AUDIT_ROOT_POM} 存在（git cat-file -e HEAD:${AUDIT_ROOT_POM}）`,
      pomAtHead,
      pomAtHead
        ? `HEAD:${AUDIT_ROOT_POM} 存在${
            pomSummary === null
              ? '（未取摘要）'
              : `（${pomSummary.bytes} 字节、${pomSummary.lines} 行）`
          }`
        : `HEAD:${AUDIT_ROOT_POM} 不存在或探测失败`,
    ),
    precondition(
      'audit-input-digest',
      `可选的根 pom 内容摘要比对（git show HEAD:${AUDIT_ROOT_POM} 的内存摘要，不复制文件）`,
      declaredSha256 === null ? true : declaredSha256Ok && digestMatches === true,
      declaredSha256 === null
        ? `未声明 --audit-pom-sha256（只记录实际内容摘要 sha256=${pomContentSha256 ?? 'null'}）`
        : digestMatches === null
          ? `声明值形状非法或实际摘要不可得（实际 ${pomContentSha256 ?? 'null'}）`
          : digestMatches
            ? '与声明值一致'
            : '与声明值不一致',
    ),
  ];
  const unmet = report.preconditions.filter((item) => item.ok !== true);
  const ready = report.violations.length === 0 && unmet.length === 0;

  // 违规优先：出现违规时不再重复罗列阻断项（前置明细仍完整保留在 preconditions 里）
  report.blocked = report.violations.length === 0 ? blocked : [];
  report.summary = {
    mode: 'external-audit',
    verdict: ready ? AUDIT_VERDICT.ready : AUDIT_VERDICT.blocked,
    ready,
    executable: ready,
    blockedBy: ready
      ? null
      : report.violations.length > 0
        ? AUDIT_VERDICT.blockedByViolation
        : 'precondition-unmet',
    admitted: false,
    verified: false,
    evidenceGenerated: false,
    gateStageConsulted: false,
    commit: auditCommit,
    root: auditRoot,
    rootRealPath: rootReal,
    boundaryRealPath: boundaryReal,
    gitDirPresent,
    insideWorkTree,
    head: gitHead,
    headMatches,
    worktreeClean,
    statusEntries: statusEntries === null ? null : statusEntries.length,
    pomAtHead,
    pomContentSha256,
    preconditions: report.preconditions.length,
    met: report.preconditions.length - unmet.length,
  };
  // 顶层直接给出契约要求的三个字段（JSON 与 text 输出都可直接核对）
  report.verdict = report.summary.verdict;
  report.admitted = false;
  report.verified = false;
  report.gateStageConsulted = false;
  report.nextSteps = [
    `在隔离检出目录**之外**准备输出目录（例如 ${auditRoot} 的同级 output/ 目录）：审计检出必须保持工作树干净，生成物不得写进检出目录`,
    `在该输出目录内用已锁定的 Maven 与本地工具对 ${auditRoot} 的固定 commit 生成真实证据：SBOM、漏洞扫描、依赖许可证清单、PostgreSQL 兼容性记录`,
    '证据回填前统一路径：SBOM → services/ruoyi-api/compliance/provenance/sbom.cyclonedx.json；漏洞扫描 → services/ruoyi-api/compliance/provenance/vulnerability-scan.md；PostgreSQL → services/ruoyi-api/compliance/provenance/postgresql-compatibility.md；许可证/NOTICE → services/ruoyi-api/compliance/provenance/license-notice.md；候选来源 → services/ruoyi-api/compliance/provenance/candidate-commit-tag.md',
    '回填时逐项给出 fileSha256 与内容标记，再由 check-provenance.mjs 判定；本模式不生成证据、不推进任何证据状态，也不改变 gate-manifest.json 的 stage',
  ];
  report.exitCode =
    report.violations.length > 0 ? EXIT.VIOLATION : ready ? EXIT.READY : EXIT.BLOCKED;
  return report;
}

/** 只读执行 git（不经 shell；带 -C 与 GIT_OPTIONAL_LOCKS=0，git 不会写 .git/index）。 */
function captureGit(auditRoot, args, located) {
  return captureOutput(located, ['-C', auditRoot, ...args], {
    ...process.env,
    GIT_OPTIONAL_LOCKS: '0',
  });
}

/**
 * 采集外部审计目录的 Git 事实。**只读**，每条探测都走 captureOutput（15 秒超时、拒绝含引号/控制字符
 * 的路径、不经 shell 拼接），失败一律 fail-closed 记为不可用或不可读。固定执行四条只读命令：
 *   1. `git rev-parse --is-inside-work-tree` —— 必须严格输出 `true`；
 *   2. `git rev-parse HEAD`                  —— 必须严格输出 40 位小写 SHA；
 *   3. `git status --porcelain`              —— 只接受 porcelain 条目行，出现其它文本即判不可读；
 *   4. `git cat-file -e HEAD:pom.xml`        —— 退出码 0 才算固定 commit 的根 pom 存在。
 * 另加两条**可选**只读命令，仅用于摘要（不复制任何文件）：
 *   5. `git rev-parse HEAD:pom.xml`          —— blob SHA-1；
 *   6. `git show HEAD:pom.xml`               —— 仅在内存中取字节数/行数/声明值与内容 SHA-256。
 */
function collectAuditGit(auditRoot, located) {
  const base = {
    available: false,
    error: null,
    skipped: false,
    skippedReason: null,
    insideWorkTree: false,
    insideWorkTreeRaw: null,
    head: null,
    headError: null,
    statusEntries: null,
    statusError: null,
    pomAtHead: false,
    pomAtHeadError: null,
    pomBlobSha1: null,
    pomContentSha256: null,
    pomSummary: null,
  };
  if (located === null) {
    return { ...base, error: 'PATH 上未找到 git 可执行文件' };
  }

  const insideRun = captureGit(auditRoot, ['rev-parse', '--is-inside-work-tree'], located);
  const insideRaw = insideRun.ok
    ? String(insideRun.text ?? '')
        .replace(/\r/g, '')
        .trim()
    : null;
  if (!insideRun.ok || insideRaw !== 'true') {
    return {
      ...base,
      available: true,
      insideWorkTree: false,
      insideWorkTreeRaw: insideRaw,
      error: `git rev-parse --is-inside-work-tree 未严格输出 true（${
        insideRun.ok
          ? `输出 ${formatValue(insideRaw)}，退出码 ${insideRun.status}`
          : insideRun.reason
      }）`,
    };
  }

  const headRun = captureGit(auditRoot, ['rev-parse', 'HEAD'], located);
  const head = headRun.ok && headRun.status === 0 ? strictSha(headRun.text) : null;
  const headError =
    head === null
      ? `git rev-parse HEAD 未给出严格的 40 位小写 SHA（${
          headRun.ok
            ? `退出码 ${headRun.status}，输出 ${formatValue(firstLine(headRun.text))}`
            : headRun.reason
        }）`
      : null;

  const statusRun = captureGit(auditRoot, ['status', '--porcelain'], located);
  const porcelain = strictPorcelain(statusRun.text, statusRun.ok && statusRun.status === 0);
  const statusError =
    porcelain === null
      ? `git status --porcelain 输出不可用或含非 porcelain 行（${
          statusRun.ok
            ? `退出码 ${statusRun.status}，输出 ${formatValue(firstLine(statusRun.text))}`
            : statusRun.reason
        }）`
      : null;

  const catRun = captureGit(auditRoot, ['cat-file', '-e', `HEAD:${AUDIT_ROOT_POM}`], located);
  const pomAtHead = catRun.ok === true && catRun.status === 0;
  const pomAtHeadError =
    catRun.ok === true
      ? null
      : `git cat-file -e HEAD:${AUDIT_ROOT_POM} 未能执行（${catRun.reason}）`;

  let pomBlobSha1 = null;
  let pomContentSha256 = null;
  let pomSummary = null;
  if (pomAtHead) {
    const blobRun = captureGit(auditRoot, ['rev-parse', `HEAD:${AUDIT_ROOT_POM}`], located);
    if (blobRun.ok && blobRun.status === 0) pomBlobSha1 = strictSha(blobRun.text);
    const showRun = captureGit(auditRoot, ['show', `HEAD:${AUDIT_ROOT_POM}`], located);
    if (showRun.ok && showRun.status === 0) {
      const text = String(showRun.text ?? '');
      pomContentSha256 = sha256Hex(text);
      pomSummary = summarizePomText(text);
    }
  }

  return {
    ...base,
    available: true,
    insideWorkTree: true,
    insideWorkTreeRaw: insideRaw,
    head,
    headError,
    statusEntries: porcelain === null ? null : porcelain.entries,
    statusError,
    pomAtHead,
    pomAtHeadError,
    pomBlobSha1,
    pomContentSha256,
    pomSummary,
  };
}

/**
 * 采集外部审计目录的磁盘事实。**先判隔离再执行任何 git**：realpath 失败、隔离不通过或缺少 `.git` 时
 * 都不执行 git，避免 `git -C` 沿父目录误触仓库自身的 .git（也避免对非检出目录白跑 6 条探测）。
 */
function collectAuditFacts(prepared) {
  const auditRoot = prepared.auditRoot;
  const repoReal = realpathOrNull(REPO_ROOT) ?? resolve(REPO_ROOT);
  const boundaryReal = realpathOrNull(BOUNDARY_ROOT) ?? resolve(BOUNDARY_ROOT);
  const rootReal = realpathOrNull(auditRoot);
  if (rootReal === null) {
    return {
      repoReal,
      boundaryReal,
      rootReal: null,
      git: { skipped: true, skippedReason: '审计根无法解析真实路径（realpathSync 失败）' },
    };
  }
  const isolation = auditIsolationViolations(rootReal, repoReal, boundaryReal, process.platform);
  if (isolation.length > 0) {
    return {
      repoReal,
      boundaryReal,
      rootReal,
      git: {
        skipped: true,
        skippedReason: '隔离判定未通过，未执行任何 git 命令（避免误触仓库或父目录的 .git）',
      },
    };
  }
  const gitDir = join(auditRoot, '.git');
  if (lstatOrMissing(gitDir).exists !== true) {
    return {
      repoReal,
      boundaryReal,
      rootReal,
      git: { skipped: true, skippedReason: `审计根下缺少 ${gitDir}：未执行任何 git 命令` },
    };
  }
  return { repoReal, boundaryReal, rootReal, git: collectAuditGit(auditRoot, findOnPath('git')) };
}

function renderAuditText(report, context) {
  const audit = report.audit;
  const lines = [];
  lines.push('RuoYi 外部审计检查（--audit-root / --audit-commit；只读、不生成证据、不复制文件）');
  lines.push('- 模式: external-audit（verdict 只有两个取值：external-audit-ready / blocked）');
  lines.push(`- 审计根目录: ${audit.root}`);
  lines.push(
    `- 审计根真实路径: ${audit.rootRealPath ?? 'null'}${audit.rootSymlinked ? '（给定路径是符号链接/联接，已按 realpath 判定）' : ''}`,
  );
  lines.push(`- 仓库边界根目录: ${audit.boundaryRealPath}`);
  lines.push(`- 仓库真实路径: ${audit.repoRealPath}`);
  lines.push(`- 固定 commit: ${audit.commit}`);
  lines.push(
    `- .git: ${audit.gitDir.present ? `${audit.gitDir.path} 存在` : `${audit.gitDir.path} 不存在`}`,
  );
  lines.push(
    `- git rev-parse --is-inside-work-tree: ${
      audit.git.skipped === true
        ? '未执行（见阻断项）'
        : audit.git.insideWorkTree
          ? 'true'
          : `不是 true（${formatValue(audit.git.insideWorkTreeRaw ?? null)}）`
    }`,
  );
  lines.push(
    `- 外部 HEAD: ${audit.git.head ?? 'null'}（${audit.git.headMatches ? '与固定 commit 完全一致' : '不一致或未取得'}）`,
  );
  lines.push(
    `- 工作树: ${
      audit.git.statusEntries === null
        ? '状态不可读'
        : audit.git.statusEntries === 0
          ? '干净（git status --porcelain 无条目）'
          : `${audit.git.statusEntries} 个条目（已跟踪改动或未跟踪文件都算不干净）`
    }`,
  );
  lines.push(
    `- 固定 commit 根 ${AUDIT_ROOT_POM}: ${
      audit.pom.presentAtHead
        ? `HEAD:${AUDIT_ROOT_POM} 存在`
        : `HEAD:${AUDIT_ROOT_POM} 不存在或探测失败`
    }`,
  );
  if (audit.pom.summary !== null) {
    lines.push(
      `- 根 ${AUDIT_ROOT_POM} 摘要（内存读取，未复制文件）: ${audit.pom.summary.bytes} 字节、${audit.pom.summary.lines} 行、artifactId=${audit.pom.summary.artifactId ?? 'null'}、java.version=${audit.pom.summary.javaVersion ?? 'null'}、spring-boot.version=${audit.pom.summary.springBootVersion ?? 'null'}、sha256=${audit.pom.contentSha256 ?? 'null'}`,
    );
  } else {
    lines.push(
      `- 根 ${AUDIT_ROOT_POM} 摘要: 未取得（sha256=${audit.pom.contentSha256 ?? 'null'}）`,
    );
  }
  lines.push(
    `- 前置: ${report.summary.met}/${report.summary.preconditions} 满足（verdict=${report.summary.verdict}${
      report.summary.blockedBy === null ? '' : `，blockedBy=${report.summary.blockedBy}`
    }）`,
  );
  for (const item of report.preconditions) {
    lines.push(`    ${item.ok ? 'ok ' : 'x  '} ${item.id}: ${item.detail}`);
  }
  lines.push(
    '- 声明: admitted=false、verified=false；本模式不读取 gate-manifest.json，仓库内 stage 不可能改变本判定',
  );
  lines.push(
    '- 声明: 不生成、不预填、不复制、不下载任何证据或源码；审计检出必须保持工作树干净，生成物写到检出目录之外',
  );
  lines.push(
    `- 结论: ${
      report.summary.ready
        ? 'external-audit-ready（外部审计前置可执行；不等于 admitted，也不等于 verified）'
        : `blocked（${report.exitCode === EXIT.VIOLATION ? '违规' : '前置未满足'}）`
    }（退出码 ${report.exitCode}）`,
  );
  lines.push(`- 上下文: 仓库根 ${context.repoRoot}`);
  return lines.join('\n');
}

/* ------------------------------------------------------------------ *
 * 能力判定
 * ------------------------------------------------------------------ */

/** 门禁清单：不可用或非法一律 fail-closed 判违规（无法据此推理前置）。 */
function checkGateLink(gateManifest, gateManifestError, report) {
  const result = { available: false, stage: null };
  if (gateManifestError) {
    report.violations.push(
      `gate-manifest.json: ${gateManifestError}；准入门禁不可用，无法判断证据生成前置，按 fail-closed 判违规`,
    );
    return result;
  }
  if (!isPlainObject(gateManifest)) {
    report.violations.push('gate-manifest.json: 内容必须是 JSON 对象（准入门禁不可用）');
    return result;
  }
  if (gateManifest.contract !== GATE_CONTRACT_ID) {
    report.violations.push(
      `gate-manifest.json: contract 必须为 ${GATE_CONTRACT_ID}（当前 ${formatValue(gateManifest.contract)}）`,
    );
    return result;
  }
  if (!GATE_STAGES.includes(gateManifest.stage)) {
    report.violations.push(
      `gate-manifest.json: stage 只能是 ${GATE_STAGES.join(' / ')}（当前 ${formatValue(gateManifest.stage)}）`,
    );
    return result;
  }
  result.available = true;
  result.stage = gateManifest.stage;
  return result;
}

function precondition(id, title, ok, detail, group) {
  return { id, title, ok: ok === true, detail, group: group ?? null };
}

/**
 * 前置分组语义：无 group 的前置必须全部满足；同一 group 内的前置是「任一满足即可」的替代方案
 * （例如 PostgreSQL 既可以来自本机安装，也可以来自可达的容器运行时）。
 */
function groupOutcomes(preconditions) {
  const groups = new Map();
  for (const item of preconditions) {
    if (item.group === null) continue;
    const list = groups.get(item.group) ?? [];
    list.push(item);
    groups.set(item.group, list);
  }
  const satisfied = new Map();
  for (const [id, list] of groups)
    satisfied.set(
      id,
      list.some((item) => item.ok),
    );
  return { groups, satisfied };
}

function capabilityReady(preconditions) {
  const { satisfied } = groupOutcomes(preconditions);
  for (const item of preconditions) {
    if (item.group === null) {
      if (!item.ok) return false;
    } else if (satisfied.get(item.group) !== true) {
      return false;
    }
  }
  return true;
}

/** 真正造成阻断的前置：无 group 的失败项，或整组都失败时的全部组员。 */
function unmetPreconditions(preconditions) {
  const { satisfied } = groupOutcomes(preconditions);
  return preconditions.filter(
    (item) => !item.ok && (item.group === null || satisfied.get(item.group) !== true),
  );
}

function buildCapabilities(input, gate) {
  const fileExists = typeof input.fileExists === 'function' ? input.fileExists : () => false;
  const probes = isPlainObject(input.probes) ? input.probes : {};
  const jdk = isPlainObject(probes.jdk) ? probes.jdk : {};
  const maven = isPlainObject(probes.maven) ? probes.maven : {};
  const docker = isPlainObject(probes.docker) ? probes.docker : {};

  const admitted = gate.stage === ADMITTED_STAGE;
  const pomPresent = fileExists(RELATIVE_POM) === true;
  const sbomPresent = fileExists(RELATIVE_SBOM) === true;

  const jdkOk = jdk.usable === true && typeof jdk.major === 'number' && jdk.major >= MIN_JDK_MAJOR;
  const mavenOk =
    maven.usable === true &&
    typeof maven.version === 'string' &&
    compareVersions(maven.version, MIN_MAVEN_VERSION) >= 0;
  const sbomTool = isPlainObject(probes.sbomTool) ? probes.sbomTool : null;
  const scanner = isPlainObject(probes.scanner) ? probes.scanner : null;
  const postgresTool = isPlainObject(probes.postgresTool) ? probes.postgresTool : null;
  const dockerReady = docker.cli === true && docker.daemon === true;

  const toolDetail = (record, attempts, specs) =>
    describeProbe(record, attempts, `PATH 上未发现 ${specs.map((item) => item.name).join(' / ')}`);
  const sbomToolDetail = toolDetail(sbomTool, probes.sbomAttempts, SBOM_TOOL_SPECS);
  const scannerDetail = toolDetail(scanner, probes.scannerAttempts, SCANNER_SPECS);
  const postgresToolDetail = toolDetail(postgresTool, probes.postgresAttempts, POSTGRES_SPECS);
  const describeToolchain = (record, missingLabel) => {
    if (record.usable === true) return record.version ?? missingLabel;
    return record.failure && record.failure !== 'not-found'
      ? `不可用（${record.failure}）`
      : missingLabel;
  };

  return [
    {
      id: 'sbom',
      title: '依赖 SBOM（CycloneDX）',
      requirement:
        '在门禁 admitted 后，用已锁定的 Maven 工程与达标工具链生成 CycloneDX 文件（不手写组件列表）',
      preconditions: [
        precondition(
          'gate-admitted',
          '准入门禁已 admitted',
          admitted,
          admitted
            ? 'stage=admitted，允许创建 Maven 工程'
            : `stage=${formatValue(gate.stage)}：门禁提升前禁止创建 pom.xml 与 Java 源码`,
        ),
        precondition(
          'maven-project',
          '存在可构建的 Maven 工程（pom.xml）',
          pomPresent,
          pomPresent ? `${RELATIVE_POM} 已存在` : `${RELATIVE_POM} 尚未创建`,
        ),
        precondition(
          'build-toolchain',
          `JDK ${MIN_JDK_MAJOR}+ 与 Maven ${MIN_MAVEN_VERSION}+ 达标`,
          jdkOk && mavenOk,
          `JDK=${describeToolchain(jdk, '未探测到达标 JDK')}（major=${jdk.major ?? 'null'}）、Maven=${describeToolchain(maven, '未探测到 Maven')}`,
        ),
        precondition(
          'sbom-tool',
          '可用 SBOM 生成工具（或 Maven CycloneDX 插件，需联网取插件与依赖）',
          sbomTool !== null && sbomTool.usable === true,
          sbomToolDetail,
        ),
      ],
      nextSteps: [
        'node services/ruoyi-api/toolchain/check-gate.mjs --java-home "<JDK17 home>" --maven-home "<仓库外临时目录>/apache-maven-3.9.16"',
        '先在隔离环境完成准入（stage=admitted）后再创建 pom.xml；创建后不要在门禁未通过时提交构建产物',
        '在仓库外隔离目录执行 Maven CycloneDX 插件生成 SBOM，并记录工具版本、输入锁定文件与生成时间',
      ],
    },
    {
      id: 'vulnerability-scan',
      title: '依赖漏洞扫描',
      requirement: '对已锁定依赖执行漏洞扫描，记录扫描器、规则库版本、发现项与逐项处置结论',
      preconditions: [
        precondition(
          'dependency-inventory',
          '存在依赖清单（pom.xml 或已生成的 SBOM）',
          pomPresent || sbomPresent,
          pomPresent || sbomPresent
            ? '依赖清单已就位'
            : `${RELATIVE_POM} 与 ${RELATIVE_SBOM} 均不存在：没有可扫描的依赖清单`,
        ),
        precondition(
          'scanner',
          '可用漏洞扫描器',
          scanner !== null && scanner.usable === true,
          scannerDetail,
        ),
      ],
      nextSteps: [
        '在受控环境提供扫描器（trivy / grype / osv-scanner / OWASP dependency-check 之一），并保留规则库或漏洞库版本',
        '扫描输入必须是已锁定的依赖清单或已生成的 SBOM；不得用网页检索结果充当扫描证据',
        '逐项记录发现项的处置结论（升级、排除理由或接受风险），未处置项不得写成已修复',
      ],
    },
    {
      id: 'postgresql-compatibility',
      title: 'PostgreSQL 兼容性验证',
      requirement:
        '在隔离 PostgreSQL 实例验证 DDL、分页、时间、事务、隔离级别、索引与迁移回滚，并记录实例版本',
      preconditions: [
        precondition(
          'postgres-runtime',
          '本机 PostgreSQL 客户端/服务端可执行文件存在',
          postgresTool !== null && postgresTool.usable === true,
          postgresToolDetail,
          'database-runtime',
        ),
        precondition(
          'container-runtime',
          '或容器运行时可用（Docker CLI 存在且守护进程可达）',
          dockerReady,
          docker.cli === true
            ? docker.daemon === true
              ? `docker 守护进程可达：${docker.detail}`
              : `docker CLI 存在但守护进程不可达：${docker.detail}`
            : '未发现 docker CLI',
          'database-runtime',
        ),
      ],
      nextSteps: [
        '启动容器运行时（例如本机 Docker Desktop）后，用固定小版本起隔离实例：docker run --rm -d -e POSTGRES_PASSWORD=<本地随机口令> -p 55432:5432 postgres:<固定小版本>',
        '或安装本地 PostgreSQL 并把 bin 目录加入 PATH（本脚本按 PATH 探测 psql / pg_ctl / pg_isready）',
        '逐项记录 server-version、DDL、分页、隔离级别与迁移回滚用例的实际执行结论；未执行前证据保持 pending',
      ],
    },
  ];
}

function evaluate(input) {
  const report = { violations: [], blocked: [], summary: {}, capabilities: [] };
  const gate = checkGateLink(input.gateManifest, input.gateManifestError ?? null, report);
  const fileExists = typeof input.fileExists === 'function' ? input.fileExists : () => false;

  if (gate.available && gate.stage !== ADMITTED_STAGE && fileExists(RELATIVE_POM) === true) {
    report.violations.push(
      `门禁 stage=${formatValue(gate.stage)} 却已存在 ${RELATIVE_POM}：单一闸门被绕过（必须先 admitted 才能创建 pom.xml）`,
    );
  }

  const capabilities = buildCapabilities(input, gate);
  report.capabilities = capabilities.map((capability) => ({
    id: capability.id,
    title: capability.title,
    requirement: capability.requirement,
    status: capabilityReady(capability.preconditions) ? 'ready' : 'blocked',
    unmet: unmetPreconditions(capability.preconditions).map((item) => item.id),
    preconditions: capability.preconditions,
    nextSteps: capability.nextSteps,
  }));

  for (const capability of report.capabilities) {
    if (capability.status === 'ready') continue;
    const unmet = unmetPreconditions(capability.preconditions);
    report.blocked.push(
      `能力 ${capability.id} 被阻断：未满足前置 ${unmet
        .map((item) => `${item.id}（${item.title}：${item.detail}）`)
        .join(' / ')}`,
    );
  }

  const readyCount = report.capabilities.filter((item) => item.status === 'ready').length;
  report.summary = {
    stage: gate.stage,
    capabilities: CAPABILITY_IDS.length,
    ready: readyCount,
    blocked: CAPABILITY_IDS.length - readyCount,
    verdict: readyCount === CAPABILITY_IDS.length ? 'ready' : 'blocked',
  };
  report.exitCode =
    report.violations.length > 0
      ? EXIT.VIOLATION
      : readyCount === CAPABILITY_IDS.length
        ? EXIT.READY
        : EXIT.BLOCKED;
  return report;
}

/* ------------------------------------------------------------------ *
 * 磁盘探测（真实运行）
 * ------------------------------------------------------------------ */

function loadGateManifest() {
  let text;
  try {
    text = readFileSync(GATE_MANIFEST_FILE, 'utf8');
  } catch (error) {
    return { value: null, error: `无法读取 ${GATE_MANIFEST_FILE}（${error.message}）` };
  }
  try {
    return { value: JSON.parse(text.replace(/^\uFEFF/, '')), error: null };
  } catch (error) {
    return { value: null, error: `${GATE_MANIFEST_FILE} JSON 解析失败（${error.message}）` };
  }
}

function collectProbes(prepared) {
  const toolchain = probeToolchain({
    javaHome: prepared.javaHome,
    mavenHome: prepared.mavenHome,
  });
  const dockerProbe = probeCommand(DOCKER_SPEC);
  const dockerText = dockerProbe.text ?? '';
  const dockerDaemonOk =
    dockerProbe.usable === true &&
    dockerProbe.status === 0 &&
    parseDockerVersion(dockerText) !== null &&
    !DAEMON_FAILURE.test(dockerText);
  const sbom = probeTools(SBOM_TOOL_SPECS);
  const scanner = probeTools(SCANNER_SPECS);
  const postgres = probeTools(POSTGRES_SPECS);
  return {
    toolchain,
    probes: {
      jdk: toolchain.jdk,
      maven: toolchain.maven,
      sbomTool: sbom.available,
      sbomAttempts: sbom.attempts,
      scanner: scanner.available,
      scannerAttempts: scanner.attempts,
      postgresTool: postgres.available,
      postgresAttempts: postgres.attempts,
      docker: {
        cli: dockerProbe.located === true,
        daemon: dockerDaemonOk,
        detail:
          dockerProbe.located !== true
            ? '未发现 docker CLI'
            : dockerDaemonOk
              ? dockerText
              : `docker CLI 不可用：${dockerProbe.failure ?? 'unknown'}${dockerText ? `（${dockerText}）` : ''}`,
      },
    },
  };
}

/* ------------------------------------------------------------------ *
 * 输出
 * ------------------------------------------------------------------ */

function renderText(report, context) {
  const lines = [];
  lines.push('RuoYi 证据生成能力探测（仅使用 Node 内置模块；不联网、不下载依赖、不写仓库）');
  lines.push(`- 边界根目录: ${context.boundaryRoot}`);
  lines.push(
    `- 准入门禁: ${context.gateManifestFile}（stage=${formatValue(report.summary.stage)}）`,
  );
  lines.push(
    `- 能力: ${report.summary.ready}/${report.summary.capabilities} 就绪（verdict=${report.summary.verdict}）`,
  );
  for (const capability of report.capabilities) {
    lines.push(`  - ${capability.id}: ${capability.status}（${capability.title}）`);
    for (const item of capability.preconditions) {
      lines.push(`      ${item.ok ? 'ok ' : 'x  '} ${item.id}: ${item.detail}`);
    }
  }
  lines.push('- 本脚本只做能力探测：不生成、不预填、不伪造任何证据文件');
  return lines.join('\n');
}

function printUsage() {
  console.log(
    [
      'RuoYi 证据生成能力探测（SBOM / 漏洞扫描 / PostgreSQL）与外部审计前置核验',
      '用法: node check-capability.mjs [--json] [--report] [--self-test] [--help]',
      '      [--java-home <绝对路径>] [--maven-home <绝对路径>]',
      '      --audit-root <仓库外绝对路径> --audit-commit <40 位小写 SHA> [--audit-pom-sha256 <64 位小写 SHA-256>]',
      '      --audit-root=<路径> --audit-commit=<SHA>（等价的 = 内联写法）',
      '  --json                   以 JSON 输出判定结果（机器可读）',
      '  --report                 信息性运行：始终以退出码 0 结束',
      '  --self-test              用合成输入验证判定规则（不读磁盘、不执行探测）',
      '  --java-home <绝对路径>   显式指定 JDK home（优先于 JAVA_HOME 与 PATH）',
      '  --maven-home <绝对路径>  显式指定 Maven home（优先于 MAVEN_HOME/M2_HOME 与 PATH）',
      '  --audit-root <绝对路径>  外部审计模式：仓库之外的固定 commit 检出（必须完全位于仓库边界 services/ruoyi-api 之外，且 .git 存在）',
      '  --audit-commit <SHA>     外部审计模式：固定 40 位小写十六进制 commit，必须与外部 git rev-parse HEAD 完全相等',
      '  --audit-pom-sha256 <SHA> 可选：声明固定 commit 的 pom.xml 内容（git show HEAD:pom.xml，内存读取）的 SHA-256，64 位小写',
      '审计模式 verdict 只有两个取值：external-audit-ready（退出码 0）/ blocked（1 违规、2 前置未满足）',
      '审计模式只做只读前置核验：不读取仓库内 gate-manifest.json 的 stage，不生成/复制/下载任何证据或源码，',
      'admitted 与 verified 恒为 false。退出码: 0 就绪 / 1 违规 / 2 被阻断 / 64 用法错误',
    ].join('\n'),
  );
}

function parseArgs(argv) {
  const flags = {
    json: false,
    report: false,
    selfTest: false,
    help: false,
    error: null,
    javaHome: null,
    mavenHome: null,
    auditRoot: null,
    auditCommit: null,
    auditPomSha256: null,
  };
  const valueFlags = {
    '--java-home': 'javaHome',
    '--maven-home': 'mavenHome',
    '--audit-root': 'auditRoot',
    '--audit-commit': 'auditCommit',
    '--audit-pom-sha256': 'auditPomSha256',
  };
  const fail = (message) => ({ ...flags, error: message });
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--json') flags.json = true;
    else if (arg === '--report') flags.report = true;
    else if (arg === '--self-test') flags.selfTest = true;
    else if (arg === '--help' || arg === '-h') flags.help = true;
    else {
      const separator = arg.indexOf('=');
      const name = separator === -1 ? arg : arg.slice(0, separator);
      const key = valueFlags[name];
      if (!key) return fail(`未知参数：${arg}`);
      if (flags[key] !== null) return fail(`${name} 只能指定一次`);
      const inline = separator === -1 ? null : arg.slice(separator + 1);
      const value = inline === null ? argv[index + 1] : inline;
      if (typeof value !== 'string' || value.trim() === '') return fail(`${name} 缺少路径值`);
      if (inline === null) index += 1;
      flags[key] = value.trim();
    }
  }
  return flags;
}

/**
 * 审计模式的参数校验（只看参数形状与本机目录事实，不判定隔离——隔离属「违规」而非「用法错误」）：
 * 用法错误一律 64；`..` 段、相对路径、文件系统根、含引号/控制字符、目录不存在都在这里拦住。
 */
function validateAuditInvocation(flags, deps) {
  const directoryExists = deps?.directoryExists ?? defaultDirectoryExists;
  if (flags.auditRoot === null) {
    return { error: '--audit-commit 需要与 --audit-root 同时给出（审计模式要求显式的仓库外目录）' };
  }
  if (flags.auditCommit === null) {
    return { error: '--audit-root 需要与 --audit-commit 同时给出（40 位小写十六进制 SHA）' };
  }
  if (flags.javaHome !== null || flags.mavenHome !== null) {
    return {
      error:
        '外部审计模式与 --java-home/--maven-home 不能同时使用：审计模式只核验外部目录前置，不探测本机工具链',
    };
  }
  const target = flags.auditRoot.trim();
  if (target === '') return { error: '--audit-root 需要一个非空路径值' };
  if (!isSafeExecutablePath(target)) {
    return { error: `--audit-root 路径含引号或控制字符（拒绝以防命令注入）：${target}` };
  }
  if (!isAbsolute(target)) {
    return { error: `--audit-root 必须是绝对路径（可复现核验不接受相对路径）：${target}` };
  }
  if (hasParentSegment(target)) {
    return { error: `--audit-root 不得包含 .. 路径段（避免随工作目录漂移）：${target}` };
  }
  if (isFileSystemRoot(target)) {
    return { error: `--audit-root 不能是文件系统根（整盘根不是隔离审计目录）：${target}` };
  }
  const home = resolve(target);
  if (!directoryExists(home)) {
    return { error: `--audit-root 指向的目录不存在或不可读：${home}` };
  }
  if (!AUDIT_COMMIT_PATTERN.test(flags.auditCommit)) {
    return {
      error: `--audit-commit 必须是 40 位小写十六进制 SHA（当前 ${formatValue(flags.auditCommit)}）：不接受短 SHA、分支名或占位词`,
    };
  }
  if (flags.auditPomSha256 !== null && !AUDIT_SHA256_PATTERN.test(flags.auditPomSha256)) {
    return {
      error: `--audit-pom-sha256 必须是 64 位小写十六进制 SHA-256（当前 ${formatValue(flags.auditPomSha256)}）`,
    };
  }
  return {
    values: {
      auditRoot: home,
      auditCommit: flags.auditCommit,
      auditPomSha256: flags.auditPomSha256,
    },
  };
}

function preflight(argv, deps) {
  const flags = parseArgs(argv);
  if (flags.error) return { exitCode: EXIT.USAGE, error: flags.error, flags };
  if (flags.help || flags.selfTest)
    return {
      exitCode: null,
      flags,
      javaHome: null,
      mavenHome: null,
      auditRoot: null,
      auditCommit: null,
      auditPomSha256: null,
    };
  if (flags.auditRoot !== null || flags.auditCommit !== null || flags.auditPomSha256 !== null) {
    const audit = validateAuditInvocation(flags, deps);
    if (audit.error) return { exitCode: EXIT.USAGE, error: audit.error, flags };
    return { exitCode: null, flags, javaHome: null, mavenHome: null, ...audit.values };
  }
  const java =
    flags.javaHome === null
      ? {}
      : validateExplicitHome('javaHome', flags.javaHome, 'JDK home', deps);
  if (java.error) return { exitCode: EXIT.USAGE, error: java.error, flags };
  const maven =
    flags.mavenHome === null
      ? {}
      : validateExplicitHome('mavenHome', flags.mavenHome, 'Maven home', deps);
  if (maven.error) return { exitCode: EXIT.USAGE, error: maven.error, flags };
  return {
    exitCode: null,
    flags,
    javaHome: java.home ?? null,
    mavenHome: maven.home ?? null,
    auditRoot: null,
    auditCommit: null,
    auditPomSha256: null,
  };
}

/* ------------------------------------------------------------------ *
 * 自检：合成输入验证判定规则（不读磁盘、不执行探测）
 * ------------------------------------------------------------------ */

function fixtureGate(options = {}) {
  return {
    contract: options.contract ?? GATE_CONTRACT_ID,
    manifestVersion: '0.2.0',
    stage: options.stage ?? 'pre-poc-gate',
    boundary: {},
    toolchain: {},
    candidate: { pinned: { tag: null, commit: null, resolved: false } },
    admissionPrerequisites: [],
    complianceArtifacts: [],
  };
}

/** 合成「可用工具」记录：usable 与 classifyProbe 的判定口径一致（定位到 + 退出码 0 + 输出非空）。 */
function fixtureTool(record) {
  return { usable: true, found: true, failure: null, status: 0, ...record };
}

/** 合成「定位到但不可用」记录（用于验证 fail-open 已被堵住）。 */
function fixtureUnusable(record) {
  return { usable: false, found: false, status: null, ...record };
}

function fixtureProbes(options = {}) {
  const jdk =
    options.jdk ??
    fixtureTool({ major: 17, version: 'openjdk version "17.0.12"', path: 'fixture/java' });
  const maven = options.maven ?? fixtureTool({ version: '3.9.16', path: 'fixture/mvn' });
  const sbomTool =
    options.sbomTool === undefined
      ? fixtureTool({ name: 'cyclonedx', path: 'fixture/cyclonedx' })
      : options.sbomTool;
  const scanner =
    options.scanner === undefined
      ? fixtureTool({ name: 'trivy', path: 'fixture/trivy' })
      : options.scanner;
  const postgresTool =
    options.postgresTool === undefined
      ? fixtureTool({ name: 'psql', path: 'fixture/psql' })
      : options.postgresTool;
  return {
    jdk,
    maven,
    sbomTool,
    scanner,
    postgresTool,
    sbomAttempts: options.sbomAttempts ?? (sbomTool === null ? [] : [sbomTool]),
    scannerAttempts: options.scannerAttempts ?? (scanner === null ? [] : [scanner]),
    postgresAttempts: options.postgresAttempts ?? (postgresTool === null ? [] : [postgresTool]),
    docker: options.docker ?? { cli: false, daemon: false, detail: '未发现 docker CLI' },
  };
}

function fixtureFiles(paths) {
  return (relativePath) => paths.includes(relativePath);
}

function runSelfTestScenario(scenario) {
  const gateManifest = Object.prototype.hasOwnProperty.call(scenario, 'gateManifest')
    ? scenario.gateManifest
    : fixtureGate(scenario.gate ?? {});
  const report = evaluate({
    gateManifest,
    gateManifestError: scenario.gateManifestError ?? null,
    fileExists: fixtureFiles(scenario.files ?? []),
    probes: fixtureProbes(scenario.probes ?? {}),
  });
  const messages = [...report.violations, ...report.blocked].join('\n');
  const failures = [];
  if (report.exitCode !== scenario.expectCode) {
    failures.push(`退出码期望 ${scenario.expectCode}，实际 ${report.exitCode}`);
  }
  for (const needle of scenario.expect ?? []) {
    if (!messages.includes(needle)) failures.push(`期望信息包含「${needle}」`);
  }
  for (const [id, status] of Object.entries(scenario.expectStatus ?? {})) {
    const capability = report.capabilities.find((item) => item.id === id);
    if (!capability) failures.push(`缺少能力 ${id}`);
    else if (capability.status !== status)
      failures.push(`能力 ${id} 期望 ${status}，实际 ${capability.status}`);
  }
  return { name: scenario.name, failures, report };
}

function runPreflightScenario(scenario) {
  const deps = {
    directoryExists: (target) => (scenario.directories ?? []).includes(target),
    fileExists: (target) => (scenario.files ?? []).includes(target),
  };
  const prepared = preflight(scenario.argv, deps);
  const failures = [];
  const actual = prepared.exitCode === null ? 'pass' : prepared.exitCode;
  if (actual !== scenario.expectCode) {
    failures.push(
      `期望 ${scenario.expectCode}，实际 ${actual}${prepared.error ? `（${prepared.error}）` : ''}`,
    );
  }
  if (scenario.expectError && !(prepared.error ?? '').includes(scenario.expectError)) {
    failures.push(`期望错误信息包含「${scenario.expectError}」`);
  }
  return { name: scenario.name, failures };
}

/**
 * 探针判定与路径安全的单元检查（纯函数，不执行任何命令）：
 * 覆盖「只凭文件存在就判可用」这个 fail-open，以及 shell 元字符路径必须被拒绝。
 */
function probeUnitChecks() {
  const failures = [];
  let checks = 0;
  const check = (label, actual, expected) => {
    checks += 1;
    if (actual !== expected) failures.push(`${label}：期望 ${expected}，实际 ${actual}`);
  };
  const good = {
    ok: true,
    status: 0,
    signal: null,
    mode: 'pipe',
    reason: null,
    text: 'trivy version 0.58.0',
  };
  const blocked = {
    ok: false,
    status: null,
    signal: null,
    mode: 'none',
    reason: 'EPERM',
    text: '',
  };
  const timedOut = {
    ok: false,
    status: null,
    signal: 'SIGTERM',
    mode: 'none',
    reason: 'timeout',
    text: '',
  };

  const withCaptured = (captured) =>
    classifyProbe({ name: 'trivy', located: true, path: 'fixture/trivy', captured });

  check('定位+退出码0+非空输出 → usable', withCaptured(good).usable, true);
  check('可用记录带出解析到的版本号', withCaptured(good).version, '0.58.0');
  check(
    '退出码非 0 → 不可用并记录状态',
    withCaptured({ ...good, status: 9 }).failure,
    'exit-status:9',
  );
  check(
    '退出码为 null → 不可用',
    withCaptured({ ...good, status: null }).failure,
    'exit-status:null',
  );
  check('输出为空白 → 不可用', withCaptured({ ...good, text: '  \n\t ' }).failure, 'empty-output');
  check(
    '退出码 0 但只打印用法、解析不出版本号 → 不可用（output-unparsable）',
    withCaptured({ ...good, text: 'Usage: trivy [flags]\n  trivy image <target>' }).failure,
    'output-unparsable',
  );
  check(
    '工具标识行 + 版本号（trivy version 0.58.0）→ 可用',
    withCaptured({ ...good, text: 'trivy version 0.58.0\n' }).version,
    '0.58.0',
  );
  check(
    '合法版本行（整行只有一条语义版本）→ 可用',
    withCaptured({ ...good, text: '27.3.1\n' }).version,
    '27.3.1',
  );
  check(
    '带标签版本行（trivy 实测形态 Version: X.Y.Z）→ 可用',
    withCaptured({ ...good, text: 'Version: 0.58.0\nVulnerability DB:\n  Version: 2\n' }).version,
    '0.58.0',
  );
  check(
    '多行 Application/Version（syft 实测形态）→ 可用',
    classifyProbe({
      name: 'syft',
      located: true,
      path: 'fixture/syft',
      captured: { ...good, text: 'Application: syft\nVersion: 1.14.0\nBuildDate: 2024-01-01' },
    }).version,
    '1.14.0',
  );
  check(
    'PostgreSQL 两段式版本 psql (PostgreSQL) 16.4 → 可用',
    classifyProbe({
      name: 'psql',
      located: true,
      path: 'fixture/psql',
      captured: { ...good, text: 'psql (PostgreSQL) 16.4\n' },
    }).version,
    '16.4',
  );
  check(
    'PostgreSQL 客户端带发行版括号（Ubuntu 形态）→ 仍取标识后的版本号',
    classifyProbe({
      name: 'psql',
      located: true,
      path: 'fixture/psql',
      captured: { ...good, text: 'psql (PostgreSQL) 16.4 (Ubuntu 16.4-0ubuntu0.24.04.1)' },
    }).version,
    '16.4',
  );
  // 逐工具验收：四款 SBOM 工具、四款扫描器与三款 PostgreSQL 客户端各取一条真实输出形态，
  // 成功的探测都必须解析出语义版本（缺任何一款的验收，工具标识正则写错就不会被发现）
  for (const [tool, text, expected] of [
    ['cyclonedx', 'cyclonedx-cli 0.27.2\n', '0.27.2'],
    ['cyclonedx', '5.1.0\n', '5.1.0'],
    ['syft', 'syft 1.14.0\n', '1.14.0'],
    ['syft', 'Application: syft\nVersion: 1.14.0\nBuildDate: 2024-01-01\n', '1.14.0'],
    ['cdxgen', 'cdxgen 11.5.1\n', '11.5.1'],
    ['cdxgen', '11.5.1\n', '11.5.1'],
    ['jbom', 'jbom version 1.2.3\n', '1.2.3'],
    ['trivy', 'trivy version 0.58.0\n', '0.58.0'],
    ['trivy', 'Version: 0.58.0\nVulnerability DB:\n  Version: 2\n', '0.58.0'],
    ['grype', 'grype 0.90.0\n', '0.90.0'],
    ['grype', 'Application: grype\nVersion: 0.90.0\nBuildDate: 2024-01-01\n', '0.90.0'],
    ['osv-scanner', 'osv-scanner version: 1.9.0\ncommit: 0123456789abcdef\n', '1.9.0'],
    ['dependency-check', 'Dependency-Check Core version 12.1.0\n', '12.1.0'],
    ['psql', 'psql (PostgreSQL) 16.4\n', '16.4'],
    ['pg_ctl', 'pg_ctl (PostgreSQL) 16.4\n', '16.4'],
    ['pg_isready', 'pg_isready (PostgreSQL) 16.4\n', '16.4'],
  ]) {
    check(
      `逐工具验收 ${tool}「${text.trim().split('\n')[0]}」→ 解析出 ${expected}`,
      classifyProbe({
        name: tool,
        located: true,
        path: `fixture/${tool}`,
        captured: { ...good, text },
      }).version,
      expected,
    );
  }
  /*
   * 严格版本解析（本 BLOCK 的修复点）：只在「该工具自己的版本行」上取版本号，绝不在垃圾文本里
   * 任意搜「数字.数字」；两段数字（0.0 / 1.2 / 999.999）不构成语义版本，一律不可解析。
   */
  const unparsableToolTexts = [
    ['garbage 999.999', 'garbage 999.999\n'],
    ['error 1.2', 'error 1.2\n'],
    ['0.0', '0.0\n'],
    ['多行混合 starting probe + garbage 999.999', 'starting probe\ngarbage 999.999\n'],
    ['Version: 1.2（标签后是两段数字）', 'Version: 1.2\n'],
    ['Usage: trivy [flags]', 'Usage: trivy [flags]\n'],
    ['工具标识后不是版本号 trivy image <target>', 'trivy image <target>\n'],
  ];
  for (const [label, text] of unparsableToolTexts) {
    check(
      `不可解析的工具输出「${label}」→ output-unparsable`,
      withCaptured({ ...good, text }).failure,
      'output-unparsable',
    );
  }
  check(
    '另一工具的标识行不算本工具版本（trivy 探测看到 grype 0.90.0）→ 不可用',
    withCaptured({ ...good, text: 'grype 0.90.0\n' }).failure,
    'output-unparsable',
  );
  check(
    'PostgreSQL 占位版本 psql (PostgreSQL) 0.0 → 不可用（fail-closed）',
    classifyProbe({
      name: 'psql',
      located: true,
      path: 'fixture/psql',
      captured: { ...good, text: 'psql (PostgreSQL) 0.0\n' },
    }).failure,
    'output-unparsable',
  );
  // Docker：`info --format '{{.ServerVersion}}'` 的输出必须整段就是一条合法 ServerVersion
  const withDocker = (text) =>
    classifyProbe({
      name: 'docker',
      located: true,
      path: 'fixture/docker',
      captured: { ...good, text },
    });
  for (const [label, text] of [
    ['27.3.1', '27.3.1'],
    ['行尾换行 27.3.1\\n', '27.3.1\n'],
    ['发行版后缀 24.0.7-ce', '24.0.7-ce'],
    ['预发布后缀 27.3.1-rc.1', '27.3.1-rc.1'],
    ['构建元数据 20.10.24+dfsg1', '20.10.24+dfsg1'],
  ]) {
    check(`Docker ServerVersion「${label}」→ 可用`, withDocker(text).version, text.trim());
  }
  for (const [label, text] of [
    [
      'error during connect',
      'error during connect: this error may indicate that the docker daemon is not running',
    ],
    [
      'Cannot connect 文本',
      'Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?',
    ],
    ['两段式 0.0', '0.0'],
    ['两段式 999.999', '999.999'],
    ['带标签而非纯版本 ServerVersion: 27.3.1', 'ServerVersion: 27.3.1'],
    ['版本后夹带说明 27.3.1 (build abcdef)', '27.3.1 (build abcdef)'],
    ['版本后跟警告行', '27.3.1\nWARNING: No swap limit support'],
    ['连接地址而非版本 tcp://127.0.0.1:2375', 'tcp://127.0.0.1:2375'],
    ['日志前缀夹版本 INFO[0000] 29.8.0', 'INFO[0000] 29.8.0'],
    ['空输出', '   '],
  ]) {
    check(`Docker 非法输出「${label}」→ 不算可用`, withDocker(text).usable, false);
  }
  check('执行被环境阻止 → 不可用', withCaptured(blocked).failure, 'EPERM');
  check('探针超时 → 不可用', withCaptured(timedOut).failure, 'timeout');
  check('只定位到、未执行 → 不可用（fail-open 已堵住）', withCaptured(null).usable, false);
  check(
    '未定位到 → not-found',
    classifyProbe({ name: 'trivy', located: false }).failure,
    'not-found',
  );

  check(
    '普通绝对路径 → 安全',
    isSafeExecutablePath('C:\\Program Files\\Java\\jdk-17\\bin\\java.exe'),
    true,
  );
  check(
    'Program Files (x86) 下的 .exe → 通用校验通过（不经 shell，不误拒）',
    isSafeExecutablePath(
      'C:\\Program Files (x86)\\Common Files\\Oracle\\Java\\java8path\\java.exe',
    ),
    true,
  );
  check('含双引号 → 拒绝', isSafeExecutablePath('C:\\x" & echo pwned & ".exe'), false);
  check('含单引号 → 拒绝', isSafeExecutablePath("C:\\a'b\\mvn.cmd"), false);
  check('含换行 → 拒绝', isSafeExecutablePath('C:\\a\nb\\mvn.cmd'), false);
  check('含制表符 → 拒绝', isSafeExecutablePath('C:\\a\tb\\mvn.cmd'), false);
  check('含 NUL → 拒绝', isSafeExecutablePath('C:\\a\u0000b\\mvn.cmd'), false);
  check('空路径 → 拒绝', isSafeExecutablePath(''), false);

  // 经 cmd.exe 启动的 .cmd/.bat：危险元字符一律拒绝（本 BLOCK 的注入面）
  const shellUnsafePaths = [
    ['命令分隔符 &', 'C:\\a&b\\mvn.cmd'],
    ['管道 |', 'C:\\a|b\\mvn.cmd'],
    ['重定向 >', 'C:\\a>b\\mvn.cmd'],
    ['转义符 ^', 'C:\\a^b\\mvn.cmd'],
    ['命令块括号', 'C:\\a(b)\\mvn.cmd'],
    ['变量展开 %', 'C:\\a%b\\mvn.cmd'],
    ['延迟展开 !', 'C:\\a!b\\mvn.cmd'],
    ['双引号', 'C:\\x" & echo pwned & ".cmd'],
  ];
  for (const [label, unsafePath] of shellUnsafePaths) {
    check(
      `shell 路径含${label} → 拒绝（isSafeShellPath）`,
      isSafeShellPath(unsafePath, 'win32'),
      false,
    );
    check(
      `.cmd 路径含${label} → buildInvocation 返回 error（不拼命令行）`,
      buildInvocation(unsafePath, ['-v'], 'win32').error !== null,
      true,
    );
  }
  check(
    '含括号的 Program Files (x86) 下的 .cmd → 拒绝（需经 cmd.exe 启动）',
    isSafeShellPath('C:\\Program Files (x86)\\maven\\bin\\mvn.cmd', 'win32'),
    false,
  );
  check(
    '含括号的 Program Files (x86) 下的 .exe → 允许（不经 shell，本机 java.exe 即在此）',
    isSafeShellPath(
      'C:\\Program Files (x86)\\Common Files\\Oracle\\Java\\java8path\\java.exe',
      'win32',
    ),
    true,
  );
  check(
    '普通 .cmd 路径（Program Files + 空格）→ 允许',
    isSafeShellPath('C:\\Program Files\\apache-maven-3.9.16\\bin\\mvn.cmd', 'win32'),
    true,
  );
  check(
    'POSIX 路径不受 shell 元字符校验影响（shell: false）',
    isSafeShellPath('/opt/a&b/bin/mvn', 'linux'),
    true,
  );
  check(
    '参数含危险元字符（引号之外的注入面）→ 拒绝',
    buildInvocation('C:\\mvn\\bin\\mvn.cmd', ['-v', '&calc'], 'win32').error !== null,
    true,
  );
  check(
    '.cmd 始终加引号（对合法路径的纵深防御）',
    buildInvocation('C:\\Program Files\\apache-maven-3.9.16\\bin\\mvn.cmd', ['-v'], 'win32')
      .command,
    '"C:\\Program Files\\apache-maven-3.9.16\\bin\\mvn.cmd" -v',
  );
  check(
    '.exe 不经 shell：即使路径含 & 也保持 shell=false',
    buildInvocation('C:\\a&b\\java.exe', ['-version'], 'win32').shell,
    false,
  );
  check(
    '不安全路径（双引号）不进入命令行：reason=unsafe-path（未执行任何命令）',
    captureOutput('C:\\x" & echo pwned & ".exe', []).reason,
    'unsafe-path',
  );
  if (process.platform === 'win32') {
    check(
      '.cmd 危险元字符路径 → captureOutput 直接拒绝（reason=unsafe-path，未执行）',
      captureOutput('C:\\a&b\\mvn.cmd', ['-v']).reason,
      'unsafe-path',
    );
  }
  return { checks, failures };
}

/* ------------------------------------------------------------------ *
 * 自检：外部审计模式的合成输入（纯函数；不读磁盘、不执行任何命令）
 * ------------------------------------------------------------------ */

/** SHA-256 向量（NIST）：空串 / abc / 448 位两分组。 */
const AUDIT_SHA256_VECTORS = [
  ['', 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'],
  ['abc', 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'],
  [
    'abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq',
    '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1',
  ],
];

/**
 * 合成的仓库/边界/审计根路径与合成 pom 文本。**这些只是字符串常量**：自检不会创建任何目录、
 * 源码、pom 或证据文件，也不会读磁盘、不会执行 git（契约要求「不得为测试创建源码/pom」）。
 */
const AUDIT_FIXTURE_REPO = join(tmpdir(), 'rm-audit-fixture-repo');
const AUDIT_FIXTURE_BOUNDARY = join(AUDIT_FIXTURE_REPO, 'services', 'ruoyi-api');
const AUDIT_FIXTURE_ROOT = join(tmpdir(), 'rm-audit-fixture-external', 'RuoYi-Vue-pinned');
const AUDIT_FIXTURE_GIT_DIR = join(AUDIT_FIXTURE_ROOT, '.git');
const AUDIT_FIXTURE_LINK = join(tmpdir(), 'rm-audit-fixture-link');
const AUDIT_FIXTURE_COMMIT = '0123456789abcdef0123456789abcdef01234567';
const AUDIT_FIXTURE_OTHER_COMMIT = 'fedcba9876543210fedcba9876543210fedcba98';
const AUDIT_FIXTURE_POM_TEXT =
  '<project><modelVersion>4.0.0</modelVersion><artifactId>ruoyi</artifactId><properties><java.version>17</java.version><spring-boot.version>3.5.16</spring-boot.version></properties></project>';
const AUDIT_FIXTURE_POM_SHA256 = sha256Hex(AUDIT_FIXTURE_POM_TEXT);
const AUDIT_FIXTURE_POM_BLOB_SHA1 = 'abcdef0123456789abcdef0123456789abcdef01';

function auditDirStat(exists) {
  return { exists, isDirectory: exists, isFile: false, isSymbolicLink: false };
}

function auditFileStat(exists) {
  return { exists, isDirectory: false, isFile: exists, isSymbolicLink: false };
}

/** 覆盖值取用：显式给出 null 也按「显式覆盖」处理（`??` 会把 null 当缺省，这里不允许）。 */
function auditOverride(overrides, key, fallback) {
  return Object.prototype.hasOwnProperty.call(overrides, key) ? overrides[key] : fallback;
}

/**
 * 合成一次外部审计判定所需的全部输入（realpath / stat / Git 事实都由本函数注入），因此自检
 * **不会读磁盘、不会执行 git、不会创建任何文件**：这正是「判定规则」与「磁盘事实采集」分离的目的。
 */
function auditFixtureInput(overrides = {}) {
  const root = overrides.root ?? AUDIT_FIXTURE_ROOT;
  const realpaths =
    overrides.realpaths ??
    new Map([
      [root, overrides.rootReal ?? root],
      [join(root, '.git'), join(root, '.git')],
    ]);
  const stats =
    overrides.stats ??
    new Map([
      [root, auditDirStat(true)],
      [
        join(root, '.git'),
        overrides.gitDirPresent === false ? auditDirStat(false) : auditDirStat(true),
      ],
    ]);
  return {
    auditRoot: root,
    auditCommit: overrides.commit ?? AUDIT_FIXTURE_COMMIT,
    auditPomSha256: overrides.declaredSha256 ?? null,
    repoReal: overrides.repoReal ?? AUDIT_FIXTURE_REPO,
    boundaryReal: overrides.boundaryReal ?? AUDIT_FIXTURE_BOUNDARY,
    platform: process.platform,
    realpath: (target) => realpaths.get(target) ?? null,
    statPath: (target) => stats.get(target) ?? auditFileStat(false),
    git: overrides.git ?? {
      available: true,
      insideWorkTree: overrides.insideWorkTree ?? true,
      insideWorkTreeRaw: overrides.insideWorkTree === false ? 'false' : 'true',
      head: overrides.head ?? overrides.commit ?? AUDIT_FIXTURE_COMMIT,
      headError: overrides.headError ?? null,
      statusEntries: auditOverride(overrides, 'statusEntries', []),
      statusError: overrides.statusError ?? null,
      pomAtHead: overrides.pomAtHead ?? true,
      pomAtHeadError: overrides.pomAtHeadError ?? null,
      pomBlobSha1: overrides.pomBlobSha1 ?? AUDIT_FIXTURE_POM_BLOB_SHA1,
      pomContentSha256: auditOverride(overrides, 'pomContentSha256', AUDIT_FIXTURE_POM_SHA256),
      pomSummary: auditOverride(overrides, 'pomSummary', summarizePomText(AUDIT_FIXTURE_POM_TEXT)),
    },
  };
}

function runAuditScenario(scenario) {
  const report = evaluateAudit({
    ...auditFixtureInput(scenario.input ?? {}),
    ...(scenario.extraInput ?? {}),
  });
  const messages = [...report.violations, ...report.blocked].join('\n');
  const failures = [];
  if (report.exitCode !== scenario.expectCode) {
    failures.push(`退出码期望 ${scenario.expectCode}，实际 ${report.exitCode}`);
  }
  if (scenario.expectVerdict && report.summary.verdict !== scenario.expectVerdict) {
    failures.push(`verdict 期望 ${scenario.expectVerdict}，实际 ${report.summary.verdict}`);
  }
  if (![AUDIT_VERDICT.ready, AUDIT_VERDICT.blocked].includes(report.summary.verdict)) {
    failures.push(`verdict 只有两个合法取值，实际 ${report.summary.verdict}`);
  }
  if (report.verdict !== report.summary.verdict) {
    failures.push('顶层 verdict 必须与 summary.verdict 一致');
  }
  for (const needle of scenario.expect ?? []) {
    if (!messages.includes(needle)) failures.push(`期望信息包含「${needle}」`);
  }
  for (const [id, ok] of Object.entries(scenario.expectPrecondition ?? {})) {
    const item = report.preconditions.find((entry) => entry.id === id);
    if (!item) failures.push(`缺少前置 ${id}`);
    else if (item.ok !== ok) failures.push(`前置 ${id} 期望 ${ok}，实际 ${item.ok}`);
  }
  for (const [key, value] of Object.entries(scenario.expectSummary ?? {})) {
    if (report.summary[key] !== value) {
      failures.push(`summary.${key} 期望 ${value}，实际 ${report.summary[key]}`);
    }
  }
  if (
    typeof scenario.expectBlockedCount === 'number' &&
    report.blocked.length !== scenario.expectBlockedCount
  ) {
    failures.push(`阻断项数量期望 ${scenario.expectBlockedCount}，实际 ${report.blocked.length}`);
  }
  if (
    report.statements.admitted !== false ||
    report.statements.verified !== false ||
    report.admitted !== false ||
    report.verified !== false ||
    report.summary.admitted !== false ||
    report.summary.verified !== false
  ) {
    failures.push('审计模式不得把结果标为 admitted/verified');
  }
  if (report.statements.gateStageConsulted !== false || report.gateStageConsulted !== false) {
    failures.push('审计模式不得读取仓库内 gate 清单的 stage');
  }
  return { name: scenario.name, failures, report };
}

function buildAuditScenarios() {
  const shortSha = AUDIT_FIXTURE_COMMIT.slice(0, 12);
  return [
    {
      name: '合法外部路径（40 位 SHA + .git + HEAD 完全相等 + 工作树干净 + HEAD:pom.xml + 摘要一致）→ external-audit-ready',
      input: { declaredSha256: AUDIT_FIXTURE_POM_SHA256 },
      expectCode: 0,
      expectVerdict: 'external-audit-ready',
      expectPrecondition: {
        'audit-root-isolated': true,
        'audit-commit-format': true,
        'audit-git-dir': true,
        'audit-worktree-inside': true,
        'audit-git-head': true,
        'audit-worktree-clean': true,
        'audit-head-pom': true,
        'audit-input-digest': true,
      },
      expectSummary: {
        ready: true,
        executable: true,
        admitted: false,
        verified: false,
        gateStageConsulted: false,
        pomAtHead: true,
      },
    },
    {
      name: '仓库内路径（边界之外但在仓库工作树内）→ blocked（违规）',
      input: { root: join(AUDIT_FIXTURE_REPO, 'tmp', 'audit') },
      expectCode: 1,
      expectVerdict: 'blocked',
      expect: ['位于仓库'],
      expectPrecondition: { 'audit-root-isolated': false },
    },
    {
      name: '同路径：审计根 realpath 就是仓库边界根目录本身 → blocked（违规）',
      input: { root: AUDIT_FIXTURE_BOUNDARY },
      expectCode: 1,
      expectVerdict: 'blocked',
      expect: ['就是仓库边界根目录本身'],
      expectPrecondition: { 'audit-root-isolated': false },
    },
    {
      name: 'boundary 子路径：审计根位于 services/ruoyi-api 之内 → blocked（违规）',
      input: { root: join(AUDIT_FIXTURE_BOUNDARY, 'compliance', 'external') },
      expectCode: 1,
      expectVerdict: 'blocked',
      expect: ['位于仓库边界根目录'],
      expectPrecondition: { 'audit-root-isolated': false },
    },
    {
      name: '同路径：审计根 realpath 就是仓库工作树根目录本身 → blocked（违规）',
      input: { root: AUDIT_FIXTURE_REPO },
      expectCode: 1,
      expectVerdict: 'blocked',
      expect: ['位于仓库'],
      expectPrecondition: { 'audit-root-isolated': false },
    },
    {
      name: '符号链接逃逸：给定路径在仓库外，realpath 解析回仓库内 → blocked（违规）',
      input: {
        root: AUDIT_FIXTURE_LINK,
        realpaths: new Map([
          [AUDIT_FIXTURE_LINK, join(AUDIT_FIXTURE_REPO, 'escaped')],
          [join(AUDIT_FIXTURE_LINK, '.git'), join(AUDIT_FIXTURE_REPO, 'escaped', '.git')],
        ]),
      },
      expectCode: 1,
      expectVerdict: 'blocked',
      expect: ['位于仓库'],
      expectPrecondition: { 'audit-root-isolated': false },
    },
    {
      name: '短 SHA（12 位）→ blocked（固定 commit 形状非法）',
      input: { commit: shortSha, head: shortSha },
      expectCode: 1,
      expectVerdict: 'blocked',
      expect: ['40 位'],
      expectPrecondition: { 'audit-commit-format': false },
    },
    {
      name: 'HEAD mismatch：外部 HEAD 与固定 commit 不一致 → blocked（违规）',
      input: { head: AUDIT_FIXTURE_OTHER_COMMIT },
      expectCode: 1,
      expectVerdict: 'blocked',
      expect: ['不一致'],
      expectPrecondition: { 'audit-git-head': false },
    },
    {
      name: 'dirty：工作树有已跟踪变更 → blocked（违规）',
      input: { statusEntries: [' M pom.xml'] },
      expectCode: 1,
      expectVerdict: 'blocked',
      expect: ['工作树不干净'],
      expectPrecondition: { 'audit-worktree-clean': false },
    },
    {
      name: 'dirty：未跟踪生成物同样算不干净（生成物必须写到检出目录之外）→ blocked（违规）',
      input: { statusEntries: ['?? sbom.cyclonedx.json', '?? target/'] },
      expectCode: 1,
      expectVerdict: 'blocked',
      expect: ['工作树不干净'],
      expectPrecondition: { 'audit-worktree-clean': false },
    },
    {
      name: 'missing pom：固定 commit 的根 pom.xml 不存在 → blocked（前置未满足）',
      input: {
        pomAtHead: false,
        pomContentSha256: null,
        pomSummary: null,
        declaredSha256: AUDIT_FIXTURE_POM_SHA256,
      },
      expectCode: 2,
      expectVerdict: 'blocked',
      expect: ['cat-file -e HEAD:pom.xml'],
      expectPrecondition: { 'audit-head-pom': false, 'audit-input-digest': false },
    },
    {
      name: '缺少 .git（不是 Git 工作树检出）→ blocked（前置未满足）',
      input: { gitDirPresent: false },
      expectCode: 2,
      expectVerdict: 'blocked',
      expect: ['缺少'],
      expectPrecondition: { 'audit-git-dir': false },
    },
    {
      name: 'git rev-parse --is-inside-work-tree 不是 true → blocked（前置未满足）',
      input: { insideWorkTree: false },
      expectCode: 2,
      expectVerdict: 'blocked',
      expect: ['--is-inside-work-tree'],
      expectPrecondition: { 'audit-worktree-inside': false },
    },
    {
      name: 'Git 核验不可用（不是仓库或未找到 git）→ blocked（前置未满足）',
      input: { git: { available: false, error: '目标目录不是 Git 仓库（fixture）' } },
      expectCode: 2,
      expectVerdict: 'blocked',
      expect: ['不是 Git 仓库'],
      expectPrecondition: { 'audit-git-head': false },
    },
    {
      name: '工作树状态含非 porcelain 行（不可严格解析）→ blocked（fail-closed，不当作干净）',
      input: { statusEntries: null, statusError: 'git status --porcelain 含非 porcelain 行' },
      expectCode: 2,
      expectVerdict: 'blocked',
      expect: ['无法严格解析工作树状态'],
      expectPrecondition: { 'audit-worktree-clean': false },
    },
    {
      name: '隔离判定未通过时不执行 git（skipped）：只报违规、不重复罗列阻断项',
      input: {
        root: join(AUDIT_FIXTURE_REPO, 'external'),
        git: { skipped: true, skippedReason: '隔离判定未通过，未执行任何 git 命令' },
      },
      expectCode: 1,
      expectVerdict: 'blocked',
      expect: ['位于仓库'],
      expectBlockedCount: 0,
    },
    {
      name: '审计根无法解析真实路径（realpathSync 失败）→ blocked（前置未满足）',
      input: {
        realpaths: new Map([
          [AUDIT_FIXTURE_ROOT, null],
          [AUDIT_FIXTURE_GIT_DIR, null],
        ]),
      },
      expectCode: 2,
      expectVerdict: 'blocked',
      expect: ['真实路径'],
      expectPrecondition: { 'audit-root-isolated': false },
    },
    {
      name: '声明的根 pom 内容摘要与实际不一致 → blocked（违规）',
      input: { declaredSha256: 'f'.repeat(64) },
      expectCode: 1,
      expectVerdict: 'blocked',
      expect: ['内容摘要与声明值不一致'],
      expectPrecondition: { 'audit-input-digest': false },
    },
    {
      name: '声明摘要形状非法（非 64 位小写）→ blocked（违规）',
      input: { declaredSha256: 'ABC' },
      expectCode: 1,
      expectVerdict: 'blocked',
      expect: ['64 位'],
      expectPrecondition: { 'audit-input-digest': false },
    },
    {
      name: '审计根是仓库的上级目录（git -C 会找到仓库自身的 .git）→ blocked（违规）',
      input: { root: tmpdir(), repoReal: AUDIT_FIXTURE_REPO },
      expectCode: 1,
      expectVerdict: 'blocked',
      expect: ['上级目录'],
    },
    {
      name: '审计根解析到文件系统根 → blocked（违规）',
      input: {
        root: join(tmpdir(), 'rm-audit-fixture-drive-root'),
        realpaths: new Map([
          [join(tmpdir(), 'rm-audit-fixture-drive-root'), parse(tmpdir()).root],
          [
            join(tmpdir(), 'rm-audit-fixture-drive-root', '.git'),
            join(tmpdir(), 'rm-audit-fixture-drive-root', '.git'),
          ],
        ]),
      },
      expectCode: 1,
      expectVerdict: 'blocked',
      expect: ['文件系统根'],
    },
    {
      name: '同一份输入叠加仓库内 gate stage=admitted 不改变外部审计判定（verdict 仍为 blocked）',
      input: { head: AUDIT_FIXTURE_OTHER_COMMIT },
      extraInput: { gateStage: 'admitted' },
      expectCode: 1,
      expectVerdict: 'blocked',
      expectSummary: { gateStageConsulted: false, admitted: false, verified: false },
    },
  ];
}

/** 审计模式的参数处理场景（只走 preflight，不读磁盘、不执行命令）。 */
function buildAuditPreflightScenarios() {
  const commit = AUDIT_FIXTURE_COMMIT;
  const root = join(tmpdir(), 'rm-audit-preflight');
  return [
    {
      name: '审计模式：--audit-root 相对路径被拒绝',
      argv: ['--audit-root', 'audit-dir', '--audit-commit', commit],
      expectCode: 64,
      expectError: '绝对路径',
    },
    {
      name: '审计模式：只给 --audit-root（缺 --audit-commit）被拒绝',
      argv: ['--audit-root', root],
      directories: [root],
      expectCode: 64,
      expectError: '同时给出',
    },
    {
      name: '审计模式：只给 --audit-commit（缺 --audit-root）被拒绝',
      argv: ['--audit-commit', commit],
      expectCode: 64,
      expectError: '同时给出',
    },
    {
      name: '审计模式：--audit-commit 为短 SHA（12 位）被拒绝',
      argv: ['--audit-root', root, '--audit-commit', commit.slice(0, 12)],
      directories: [root],
      expectCode: 64,
      expectError: '40 位',
    },
    {
      name: '审计模式：--audit-commit 为分支名被拒绝',
      argv: ['--audit-root', root, '--audit-commit', 'springboot3'],
      directories: [root],
      expectCode: 64,
      expectError: '40 位',
    },
    {
      name: '审计模式：--audit-commit 含大写十六进制被拒绝（只接受小写）',
      argv: ['--audit-root', root, '--audit-commit', commit.toUpperCase()],
      directories: [root],
      expectCode: 64,
      expectError: '40 位',
    },
    {
      name: '审计模式：--audit-root 含引号/控制字符被拒绝（命令注入守卫）',
      argv: ['--audit-root', 'C:\\x" & echo pwned & "', '--audit-commit', commit],
      expectCode: 64,
      expectError: '引号或控制字符',
    },
    {
      name: '审计模式：--audit-pom-sha256 形状非法被拒绝',
      argv: ['--audit-root', root, '--audit-commit', commit, '--audit-pom-sha256', 'abc'],
      directories: [root],
      expectCode: 64,
      expectError: '64 位',
    },
    {
      name: '审计模式：与 --java-home 同时使用被拒绝（语义不混用）',
      argv: ['--audit-root', root, '--audit-commit', commit, '--java-home', 'C:\\jdk'],
      directories: [root],
      expectCode: 64,
      expectError: '不能同时使用',
    },
    {
      name: '审计模式：--audit-root 含 .. 路径段被拒绝',
      argv: ['--audit-root', 'C:\\a\\..\\b', '--audit-commit', commit],
      expectCode: 64,
      expectError: '..',
    },
    {
      name: '审计模式：--audit-root 为文件系统根被拒绝',
      argv: ['--audit-root', parse(root).root, '--audit-commit', commit],
      expectCode: 64,
      expectError: '文件系统根',
    },
    {
      name: '审计模式：--audit-root 目录不存在被拒绝',
      argv: ['--audit-root', join(tmpdir(), 'rm-audit-absent'), '--audit-commit', commit],
      expectCode: 64,
      expectError: '不存在',
    },
    {
      name: '审计模式：--audit-commit 缺值被拒绝',
      argv: ['--audit-root', root, '--audit-commit'],
      expectCode: 64,
      expectError: '缺少路径值',
    },
    {
      name: '审计模式：--audit-root 重复指定被拒绝',
      argv: ['--audit-root', root, '--audit-root', root, '--audit-commit', commit],
      expectCode: 64,
      expectError: '只能指定一次',
    },
    {
      name: '审计模式：合法的 --audit-root/--audit-commit/--audit-pom-sha256 组合（含 = 内联形式）',
      argv: [
        `--audit-root=${root}`,
        `--audit-commit=${commit}`,
        `--audit-pom-sha256=${AUDIT_FIXTURE_POM_SHA256}`,
      ],
      directories: [root],
      expectCode: 'pass',
    },
  ];
}

/** 外部审计模式的单元检查：路径隔离、严格解析、verdict 取值与探测超时（全部纯函数）。 */
function auditUnitChecks() {
  const failures = [];
  let checks = 0;
  const check = (label, actual, expected) => {
    checks += 1;
    if (actual !== expected) failures.push(`${label}：期望 ${expected}，实际 ${actual}`);
  };
  const fsRoot = parse(process.cwd()).root;
  const repo = join(tmpdir(), 'rm-audit-unit-repo');
  const boundary = join(repo, 'services', 'ruoyi-api');
  const outside = join(tmpdir(), 'rm-audit-unit-external');

  for (const [text, digest] of AUDIT_SHA256_VECTORS) {
    check(`SHA-256 向量「${text.slice(0, 12)}」`, sha256Hex(text), digest);
  }
  check(
    'UTF-8 中文输入的摘要与字节数组一致',
    sha256Hex('摘要'),
    sha256Hex(Buffer.from('摘要', 'utf8')),
  );
  check('路径位于仓库内 → pathIsInside 为真', pathIsInside(join(repo, 'services'), repo), true);
  check('路径等于仓库根 → pathIsInside 为真', pathIsInside(repo, repo), true);
  check('同前缀的兄弟目录（rm-repo 与 rm-repo-x）→ 为假', pathIsInside(`${repo}-x`, repo), false);
  check('仓库外兄弟目录 → 为假', pathIsInside(outside, repo), false);
  check('上级目录不算位于下级内 → 为假', pathIsInside(repo, outside), false);
  check('空路径 → 为假（fail-closed）', pathIsInside('', repo), false);
  check('文件系统根 → isFileSystemRoot 为真', isFileSystemRoot(fsRoot), true);
  check('普通目录 → isFileSystemRoot 为假', isFileSystemRoot(join(fsRoot, 'x')), false);
  check('含 .. 段 → 为真', hasParentSegment('C:\\a\\..\\b'), true);
  check('含 .. 段（正斜杠）→ 为真', hasParentSegment('/a/../b'), true);
  check('不含 .. 段 → 为假', hasParentSegment(join(fsRoot, 'a', 'b')), false);
  check(
    'win32 路径比较大小写不敏感',
    comparablePath(join(fsRoot, 'AbC'), 'win32'),
    comparablePath(join(fsRoot, 'abc'), 'win32'),
  );
  check('隔离：仓库内子目录 → 1 条违规', auditIsolationViolations(join(repo, 'x'), repo).length, 1);
  check('隔离：仓库根自身 → 1 条违规', auditIsolationViolations(repo, repo).length, 1);
  check('隔离：仓库的上级目录 → 1 条违规', auditIsolationViolations(tmpdir(), repo).length, 1);
  check('隔离：文件系统根 → 1 条违规', auditIsolationViolations(fsRoot, repo).length, 1);
  check('隔离：仓库外兄弟目录 → 0 条违规', auditIsolationViolations(outside, repo).length, 0);
  check('隔离：realpath 不可得 → 不误判违规', auditIsolationViolations(null, repo).length, 0);
  check(
    '隔离：仓库内违规信息含「位于仓库」',
    auditIsolationViolations(join(repo, 'x'), repo)[0].includes('位于仓库'),
    true,
  );
  check(
    '隔离：上级违规信息含「上级目录」',
    auditIsolationViolations(tmpdir(), repo)[0].includes('上级目录'),
    true,
  );
  check(
    '隔离：边界根目录本身 → 1 条违规且说明「边界根目录本身」',
    auditIsolationViolations(boundary, repo, boundary).length === 1 &&
      auditIsolationViolations(boundary, repo, boundary)[0].includes('边界根目录本身'),
    true,
  );
  check(
    '隔离：边界根目录内的子路径 → 1 条违规且说明「边界根目录」',
    auditIsolationViolations(join(boundary, 'x'), repo, boundary).length === 1 &&
      auditIsolationViolations(join(boundary, 'x'), repo, boundary)[0].includes('边界根目录'),
    true,
  );
  check(
    '隔离：仓库内但在边界之外 → 1 条违规且说明「位于仓库」',
    auditIsolationViolations(join(repo, 'tmp'), repo, boundary)[0].includes('位于仓库'),
    true,
  );
  check(
    '隔离：边界之外的仓库外目录 → 0 条违规',
    auditIsolationViolations(outside, repo, boundary).length,
    0,
  );
  check(
    '隔离：符号链接逃逸（realpath 落在边界内）→ 1 条违规',
    auditIsolationViolations(join(boundary, 'escaped'), repo, boundary).length,
    1,
  );
  check(
    '固定 commit 形状：40 位小写 → 接受',
    AUDIT_COMMIT_PATTERN.test(AUDIT_FIXTURE_COMMIT),
    true,
  );
  check(
    '固定 commit 形状：短 SHA → 拒绝',
    AUDIT_COMMIT_PATTERN.test(AUDIT_FIXTURE_COMMIT.slice(0, 12)),
    false,
  );
  check(
    '固定 commit 形状：大写 → 拒绝',
    AUDIT_COMMIT_PATTERN.test(AUDIT_FIXTURE_COMMIT.toUpperCase()),
    false,
  );
  check('固定 commit 形状：分支名 → 拒绝', AUDIT_COMMIT_PATTERN.test('springboot3'), false);
  check(
    '固定 commit 形状：占位词 → 拒绝',
    AUDIT_COMMIT_PATTERN.test('latest'.padEnd(40, '0')),
    false,
  );
  check(
    '输入摘要形状：64 位小写 → 接受',
    AUDIT_SHA256_PATTERN.test(AUDIT_FIXTURE_POM_SHA256),
    true,
  );
  check(
    '输入摘要形状：63 位 → 拒绝',
    AUDIT_SHA256_PATTERN.test(AUDIT_FIXTURE_POM_SHA256.slice(0, 63)),
    false,
  );
  check('verdict 只有两个取值', new Set(Object.values(AUDIT_VERDICT)).size, 2);
  check('ready verdict 名称', AUDIT_VERDICT.ready, 'external-audit-ready');
  check('blocked verdict 名称', AUDIT_VERDICT.blocked, 'blocked');
  check(
    '违规同样归入 blocked（不产生第三个 verdict）',
    AUDIT_VERDICT.blockedByViolation,
    'blocked',
  );
  check('单次探测超时为 15 秒', PROBE_TIMEOUT_MS, 15000);
  check('HEAD 严格解析：整段 40 位小写 → 接受', strictSha('a'.repeat(40)), 'a'.repeat(40));
  check('HEAD 严格解析：带前后噪声 → 拒绝', strictSha(`head is ${'a'.repeat(40)}`), null);
  check('HEAD 严格解析：大写 → 拒绝', strictSha('A'.repeat(40)), null);
  check('HEAD 严格解析：短 SHA → 拒绝', strictSha('a'.repeat(12)), null);
  check('porcelain 严格解析：空输出 → 0 条目', strictPorcelain('', true).entries.length, 0);
  check(
    'porcelain 严格解析：未跟踪+已跟踪两条 → 2',
    strictPorcelain('?? a\n M b\n', true).entries.length,
    2,
  );
  check(
    'porcelain 严格解析：含非条目行 → null（fail-closed）',
    strictPorcelain('warning: LF will be replaced\n', true),
    null,
  );
  check('porcelain 严格解析：探测失败 → null', strictPorcelain('', false), null);
  check('porcelain 条目：已跟踪修改被识别', AUDIT_PORCELAIN_ENTRY.test(' M pom.xml'), true);
  check('porcelain 条目：未跟踪生成物被识别', AUDIT_PORCELAIN_ENTRY.test('?? target/'), true);
  check(
    'porcelain 条目：git 告警行不被误判为变更',
    AUDIT_PORCELAIN_ENTRY.test('warning: LF will be replaced by CRLF'),
    false,
  );
  check('porcelain 条目：空行不被识别', AUDIT_PORCELAIN_ENTRY.test(''), false);
  check('pom 摘要：读取 artifactId', summarizePomText(AUDIT_FIXTURE_POM_TEXT).artifactId, 'ruoyi');
  check('pom 摘要：读取 java.version', summarizePomText(AUDIT_FIXTURE_POM_TEXT).javaVersion, '17');
  check(
    'pom 摘要：读取 spring-boot.version',
    summarizePomText(AUDIT_FIXTURE_POM_TEXT).springBootVersion,
    '3.5.16',
  );
  check(
    'pom 摘要：contentCopied 恒为 false（不复制文件）',
    summarizePomText(AUDIT_FIXTURE_POM_TEXT).contentCopied,
    false,
  );
  check('pom 摘要：空文本仍返回结构化摘要', summarizePomText('').lines, 0);
  const baseVerdict = evaluateAudit(auditFixtureInput({}));
  check(
    '合法合成输入的 verdict 为 external-audit-ready',
    baseVerdict.summary.verdict,
    'external-audit-ready',
  );
  check('合法合成输入的退出码为 0', baseVerdict.exitCode, 0);
  const withStage = evaluateAudit({ ...auditFixtureInput({}), gateStage: 'admitted' });
  check(
    '仓库内 stage=admitted 不改变外部审计判定',
    `${withStage.summary.verdict}|${withStage.exitCode}`,
    `${baseVerdict.summary.verdict}|${baseVerdict.exitCode}`,
  );
  check('外部审计判定声明不读取门禁清单', withStage.gateStageConsulted, false);
  check('external-audit-ready 时 admitted 仍为 false', baseVerdict.admitted, false);
  check('external-audit-ready 时 verified 仍为 false', baseVerdict.verified, false);
  return { checks, failures };
}

function selfTest() {
  console.log('RuoYi 证据生成能力探测自检（合成输入；不读磁盘、不执行任何命令）');
  let failed = 0;

  const POM = RELATIVE_POM;
  const SBOM = RELATIVE_SBOM;
  const scenarios = [
    {
      name: '当前本机形态：未 admitted、无 pom、无任何证据工具 → 三项全部 blocked',
      files: [],
      probes: fixtureProbes({
        jdk: { found: true, major: 17, version: '17.0.12', path: 'fixture/java' },
        maven: { found: false, version: null, path: null },
        sbomTool: null,
        scanner: null,
        postgresTool: null,
        docker: { cli: true, daemon: false, detail: 'failed to connect to the docker API' },
      }),
      expectCode: 2,
      expectStatus: {
        sbom: 'blocked',
        'vulnerability-scan': 'blocked',
        'postgresql-compatibility': 'blocked',
      },
      expect: ['能力 sbom 被阻断', 'postgresql-compatibility'],
    },
    {
      name: '全部前置满足（admitted + pom + 工具链 + SBOM 工具 + 扫描器 + psql）→ 就绪',
      gate: { stage: 'admitted' },
      files: [POM],
      expectCode: 0,
      expectStatus: {
        sbom: 'ready',
        'vulnerability-scan': 'ready',
        'postgresql-compatibility': 'ready',
      },
    },
    {
      name: 'admitted 且 pom/SBOM 就位，但缺 SBOM 工具 → sbom blocked，扫描可用',
      gate: { stage: 'admitted' },
      files: [POM, SBOM],
      probes: fixtureProbes({ sbomTool: null }),
      expectCode: 2,
      expectStatus: { sbom: 'blocked', 'vulnerability-scan': 'ready' },
      expect: ['sbom-tool'],
    },
    {
      name: 'admitted 且 pom 就位，但 Maven 版本不达标（3.8.8）→ sbom blocked',
      gate: { stage: 'admitted' },
      files: [POM],
      probes: fixtureProbes({ maven: { found: true, version: '3.8.8', path: 'fixture/mvn' } }),
      expectCode: 2,
      expectStatus: { sbom: 'blocked' },
      expect: ['3.9.0'],
    },
    {
      name: 'admitted 且 pom 就位，但 JDK 主版本为 8 → sbom blocked',
      gate: { stage: 'admitted' },
      files: [POM],
      probes: fixtureProbes({
        jdk: { found: true, major: 8, version: '1.8.0_501', path: 'fixture/java' },
      }),
      expectCode: 2,
      expectStatus: { sbom: 'blocked' },
      expect: ['build-toolchain'],
    },
    {
      name: 'PostgreSQL 经容器运行时达成就绪（无 psql、docker 守护进程可达）',
      gate: { stage: 'admitted' },
      files: [POM],
      probes: fixtureProbes({
        postgresTool: null,
        docker: { cli: true, daemon: true, detail: '29.8.0' },
      }),
      expectCode: 0,
      expectStatus: { 'postgresql-compatibility': 'ready' },
    },
    {
      name: 'docker CLI 存在但守护进程不可达 → PostgreSQL blocked 并列出原因',
      gate: { stage: 'admitted' },
      files: [POM],
      probes: fixtureProbes({
        postgresTool: null,
        docker: { cli: true, daemon: false, detail: 'failed to connect to the docker API' },
      }),
      expectCode: 2,
      expectStatus: { 'postgresql-compatibility': 'blocked' },
      expect: ['守护进程不可达'],
    },
    {
      name: '无依赖清单（pom 与 SBOM 均缺失）→ 漏洞扫描 blocked',
      gate: { stage: 'admitted' },
      files: [],
      expectCode: 2,
      expectStatus: { 'vulnerability-scan': 'blocked' },
      expect: ['dependency-inventory'],
    },
    {
      name: '门禁未 admitted 却已存在 pom.xml → 违规（单一闸门被绕过）',
      files: [POM],
      expectCode: 1,
      expect: ['单一闸门被绕过', 'pom.xml'],
    },
    {
      name: '门禁清单不可读 → 违规（fail-closed）',
      gateManifestError: '无法读取 gate-manifest.json（fixture）',
      expectCode: 1,
      expect: ['fail-closed'],
    },
    {
      name: '门禁 contract 不匹配 → 违规',
      gate: { contract: 'ruoyi-gate' },
      expectCode: 1,
      expect: [GATE_CONTRACT_ID],
    },
    {
      name: '门禁 stage 取值非法 → 违规',
      gate: { stage: 'verified' },
      expectCode: 1,
      expect: ['stage'],
    },
    {
      name: '门禁清单不是对象 → 违规',
      gateManifest: null,
      expectCode: 1,
      expect: ['JSON 对象'],
    },
    {
      name: 'admitted 且工具齐备但无 pom.xml → sbom/扫描 blocked（PostgreSQL 仍就绪）',
      gate: { stage: 'admitted' },
      files: [],
      expectCode: 2,
      expectStatus: {
        sbom: 'blocked',
        'vulnerability-scan': 'blocked',
        'postgresql-compatibility': 'ready',
      },
      expect: ['maven-project'],
    },
    {
      name: '扫描器存在但执行失败（退出码 9）→ 漏洞扫描 blocked，并显示失败原因',
      gate: { stage: 'admitted' },
      files: [POM],
      probes: fixtureProbes({
        scanner: null,
        scannerAttempts: [
          fixtureUnusable({
            name: 'trivy',
            path: 'fixture/trivy',
            located: true,
            failure: 'exit-status:9',
          }),
        ],
      }),
      expectCode: 2,
      expectStatus: { 'vulnerability-scan': 'blocked' },
      expect: ['exit-status:9'],
    },
    {
      name: 'SBOM 工具存在但输出为空 → sbom blocked（不算可用）',
      gate: { stage: 'admitted' },
      files: [POM],
      probes: fixtureProbes({
        sbomTool: null,
        sbomAttempts: [
          fixtureUnusable({
            name: 'syft',
            path: 'fixture/syft',
            located: true,
            failure: 'empty-output',
          }),
        ],
      }),
      expectCode: 2,
      expectStatus: { sbom: 'blocked' },
      expect: ['empty-output'],
    },
    {
      name: 'SBOM 工具退出码 0 但只打印用法、解析不出版本号（output-unparsable）→ sbom blocked',
      gate: { stage: 'admitted' },
      files: [POM],
      probes: fixtureProbes({
        sbomTool: null,
        sbomAttempts: [
          fixtureUnusable({
            name: 'cdxgen',
            path: 'fixture/cdxgen',
            located: true,
            failure: 'output-unparsable',
          }),
        ],
      }),
      expectCode: 2,
      expectStatus: { sbom: 'blocked' },
      expect: ['output-unparsable'],
    },
    {
      name: '工具路径含 shell 元字符（unsafe-path）→ 不算可用，并提示拒绝执行',
      gate: { stage: 'admitted' },
      files: [POM],
      probes: fixtureProbes({
        scanner: null,
        scannerAttempts: [
          fixtureUnusable({
            name: 'trivy',
            path: 'C:\\a%b\\trivy.exe',
            located: true,
            failure: 'unsafe-path',
          }),
        ],
      }),
      expectCode: 2,
      expectStatus: { 'vulnerability-scan': 'blocked' },
      expect: ['unsafe-path'],
    },
    {
      name: '探针超时（timeout）→ 不算可用，capability 保持 blocked',
      gate: { stage: 'admitted' },
      files: [POM],
      probes: fixtureProbes({
        scanner: null,
        scannerAttempts: [
          fixtureUnusable({
            name: 'grype',
            path: 'fixture/grype',
            located: true,
            failure: 'timeout',
          }),
        ],
      }),
      expectCode: 2,
      expectStatus: { 'vulnerability-scan': 'blocked' },
      expect: ['timeout'],
    },
    {
      name: 'JDK 定位到但执行失败 → build-toolchain 不可用（不是仅凭文件存在）',
      gate: { stage: 'admitted' },
      files: [POM],
      probes: fixtureProbes({
        jdk: { usable: false, found: false, failure: 'exit-status:1', major: null, version: null },
      }),
      expectCode: 2,
      expectStatus: { sbom: 'blocked' },
      expect: ['exit-status:1'],
    },
  ];

  for (const scenario of scenarios) {
    const result = runSelfTestScenario(scenario);
    if (result.failures.length === 0) {
      console.log(`  ok ${scenario.name}（退出码 ${result.report.exitCode}）`);
      continue;
    }
    failed += 1;
    console.error(`  x ${scenario.name}：${result.failures.join('；')}`);
  }

  const preflightScenarios = [
    {
      name: '未知参数 --nope',
      argv: ['--nope'],
      expectCode: 64,
      expectError: '未知参数',
    },
    {
      name: '--java-home 缺少路径值',
      argv: ['--java-home'],
      expectCode: 64,
      expectError: '缺少路径值',
    },
    {
      name: '--java-home 相对路径被拒绝',
      argv: ['--java-home', 'jdk17'],
      expectCode: 64,
      expectError: '绝对路径',
    },
    {
      name: '--java-home 目录不存在被拒绝',
      argv: ['--java-home', 'C:\\no-such-jdk'],
      expectCode: 64,
      expectError: '目录不存在',
    },
    {
      name: '--java-home 缺 bin/java 被拒绝',
      argv: ['--java-home', 'C:\\empty-home'],
      directories: ['C:\\empty-home'],
      expectCode: 64,
      expectError: 'bin 下缺少',
    },
    {
      name: '--maven-home 缺 bin/mvn 被拒绝',
      argv: ['--maven-home', 'C:\\empty-maven'],
      directories: ['C:\\empty-maven'],
      expectCode: 64,
      expectError: 'bin 下缺少',
    },
    {
      name: '--java-home/--maven-home 重复指定被拒绝',
      argv: ['--java-home', 'C:\\a', '--java-home', 'C:\\b'],
      expectCode: 64,
      expectError: '只能指定一次',
    },
    {
      name: '合法的显式 --java-home 与 --maven-home',
      argv: ['--java-home', 'C:\\jdk', '--maven-home', 'C:\\mvn'],
      directories: ['C:\\jdk', 'C:\\mvn'],
      files: ['C:\\jdk\\bin\\java.exe', 'C:\\mvn\\bin\\mvn.cmd'],
      expectCode: 'pass',
    },
    {
      name: '--java-home 含引号或控制字符被拒绝（命令注入守卫）',
      argv: ['--java-home', 'C:\\x" & echo pwned & "\\jdk'],
      expectCode: 64,
      expectError: '引号或控制字符',
    },
    {
      name: '--java-home 位于 Program Files (x86)（仅 bin/java.exe）→ 允许（.exe 不经 shell，不误拒）',
      argv: ['--java-home', 'C:\\Program Files (x86)\\Java\\jdk-17'],
      directories: ['C:\\Program Files (x86)\\Java\\jdk-17'],
      files: ['C:\\Program Files (x86)\\Java\\jdk-17\\bin\\java.exe'],
      expectCode: 'pass',
    },
    {
      name: '--maven-home 需经 cmd.exe 启动且路径含危险元字符 → 拒绝（fail-closed）',
      argv: ['--maven-home', 'C:\\Program Files (x86)\\apache-maven-3.9.16'],
      directories: ['C:\\Program Files (x86)\\apache-maven-3.9.16'],
      files: ['C:\\Program Files (x86)\\apache-maven-3.9.16\\bin\\mvn.cmd'],
      expectCode: 64,
      expectError: '危险元字符',
    },
  ];

  for (const scenario of preflightScenarios) {
    const result = runPreflightScenario(scenario);
    if (result.failures.length === 0) {
      console.log(`  ok ${scenario.name}（${scenario.expectCode}）`);
      continue;
    }
    failed += 1;
    console.error(`  x ${scenario.name}：${result.failures.join('；')}`);
  }

  const auditPreflightScenarios = buildAuditPreflightScenarios();

  for (const scenario of auditPreflightScenarios) {
    const result = runPreflightScenario(scenario);
    if (result.failures.length === 0) {
      console.log(`  ok ${scenario.name}（${scenario.expectCode}）`);
      continue;
    }
    failed += 1;
    console.error(`  x ${scenario.name}：${result.failures.join('；')}`);
  }

  const auditScenarios = buildAuditScenarios();

  for (const scenario of auditScenarios) {
    const result = runAuditScenario(scenario);
    if (result.failures.length === 0) {
      console.log(`  ok ${scenario.name}（退出码 ${result.report.exitCode}）`);
      continue;
    }
    failed += 1;
    console.error(`  x ${scenario.name}：${result.failures.join('；')}`);
  }

  const unit = probeUnitChecks();
  if (unit.failures.length === 0) {
    console.log(`  ok 探针判定与路径安全单元检查（${unit.checks} 项）`);
  } else {
    failed += unit.failures.length;
    for (const message of unit.failures) console.error(`  x 探针判定与路径安全：${message}`);
  }

  const auditUnit = auditUnitChecks();
  if (auditUnit.failures.length === 0) {
    console.log(`  ok 外部审计模式单元检查（${auditUnit.checks} 项）`);
  } else {
    failed += auditUnit.failures.length;
    for (const message of auditUnit.failures) console.error(`  x 外部审计模式：${message}`);
  }

  const total =
    scenarios.length +
    preflightScenarios.length +
    auditPreflightScenarios.length +
    auditScenarios.length +
    unit.checks +
    auditUnit.checks;
  console.log(`\n自检: ${total - failed}/${total} 通过`);
  return failed === 0 ? EXIT.READY : EXIT.VIOLATION;
}

/* ------------------------------------------------------------------ *
 * 主流程
 * ------------------------------------------------------------------ */

function main(argv) {
  const prepared = preflight(argv);
  if (prepared.error) {
    console.error(prepared.error);
    printUsage();
    return EXIT.USAGE;
  }
  const flags = prepared.flags;
  if (flags.help) {
    printUsage();
    return EXIT.READY;
  }
  if (flags.selfTest) return selfTest();

  // 外部审计模式：只核验仓库外固定 commit 目录的前置，不读门禁清单、不探测本机工具链
  if (prepared.auditRoot !== null) {
    const collected = collectAuditFacts(prepared);
    const report = evaluateAudit({
      auditRoot: prepared.auditRoot,
      auditCommit: prepared.auditCommit,
      auditPomSha256: prepared.auditPomSha256,
      repoReal: collected.repoReal,
      boundaryReal: collected.boundaryReal,
      rootReal: collected.rootReal,
      platform: process.platform,
      git: collected.git,
    });
    const auditContext = {
      mode: 'external-audit',
      repoRoot: REPO_ROOT,
      auditRoot: prepared.auditRoot,
      auditCommit: prepared.auditCommit,
      auditPomSha256: prepared.auditPomSha256,
    };
    if (flags.json) {
      console.log(JSON.stringify({ ...report, context: auditContext }, null, 2));
    } else {
      console.log(renderAuditText(report, auditContext));
      if (report.violations.length > 0) {
        console.error(`\n违规 (${report.violations.length})`);
        for (const message of report.violations) console.error(`  x ${message}`);
      }
      if (report.blocked.length > 0) {
        console.error(`\n被阻断 (${report.blocked.length})`);
        for (const message of report.blocked) console.error(`  ! ${message}`);
        console.error('\n可复现的下一步（不在本脚本内执行）：');
        for (const step of report.nextSteps) console.error(`  - ${step}`);
      }
    }
    return flags.report ? EXIT.READY : report.exitCode;
  }

  const loaded = loadGateManifest();
  const collected = collectProbes(prepared);
  const context = {
    boundaryRoot: BOUNDARY_ROOT,
    repoRoot: REPO_ROOT,
    gateManifestFile: GATE_MANIFEST_FILE,
    mode: flags.report ? 'report' : 'probe',
    probe: {
      javaHome: prepared.javaHome,
      mavenHome: prepared.mavenHome,
      jdk: collected.probes.jdk,
      maven: collected.probes.maven,
      sbomTool: collected.probes.sbomTool,
      scanner: collected.probes.scanner,
      postgresTool: collected.probes.postgresTool,
      docker: collected.probes.docker,
    },
  };
  const report = evaluate({
    gateManifest: loaded.value,
    gateManifestError: loaded.error,
    fileExists: (relativePath) => existsSync(resolve(REPO_ROOT, relativePath)),
    probes: collected.probes,
  });

  if (flags.json) {
    console.log(JSON.stringify({ ...report, context, exitCode: report.exitCode }, null, 2));
  } else {
    console.log(renderText(report, context));
    if (report.violations.length > 0) {
      console.error(`\n违规 (${report.violations.length})`);
      for (const message of report.violations) console.error(`  x ${message}`);
    }
    if (report.blocked.length > 0) {
      console.error(`\n被阻断 (${report.blocked.length})`);
      for (const message of report.blocked) console.error(`  ! ${message}`);
      console.error('\n可复现的下一步（不在本脚本内执行）：');
      for (const capability of report.capabilities) {
        if (capability.status === 'ready') continue;
        console.error(`  [${capability.id}]`);
        for (const step of capability.nextSteps) console.error(`    - ${step}`);
      }
    }
    const verdict =
      report.exitCode === EXIT.READY
        ? '就绪'
        : report.exitCode === EXIT.VIOLATION
          ? '违规'
          : '被阻断';
    console.log(`\n结果: ${verdict}（退出码 ${report.exitCode}）`);
  }
  return flags.report ? EXIT.READY : report.exitCode;
}

process.exitCode = main(process.argv.slice(2));

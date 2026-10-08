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
 *
 * 退出码：0 就绪；1 违规；2 被阻断；64 用法错误。
 */
import { existsSync, openSync, closeSync, readFileSync, unlinkSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { delimiter, dirname, isAbsolute, join, resolve } from 'node:path';
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
const RELATIVE_SBOM = 'services/ruoyi-api/compliance/sbom.cyclonedx.json';

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
 * - 「可用」必须同时满足**定位到文件 + 确实执行成功（退出码 0）+ 输出非空且可解析出版本号**。
 *   只凭「同名文件存在」就判可用是 fail-open：一个坏掉的同名脚本会被当成现成工具；只判「非空」也不够：
 *   `--version` 只打印用法说明（如 `Usage: trivy [flags]`）却返回 0 的坏工具同样会把 capability 误报为 ready。
 */
const PROBE_TIMEOUT_MS = 15000;
const UNSAFE_PATH_CHARS = /["'\u0000-\u001f\u007f]/;
const SHELL_META_CHARS = /[&|<>^()%!]/;

/** 可解析的版本号形状：至少两段点分数字（`1.2`、`1.2.3`）；读不出来即视为「输出不可解析」。 */
const VERSION_SHAPE = /\d+(?:\.\d+)+/;

/** 从探针输出里解析版本号形状（只做形状校验，不猜工具语义；解析不出返回 null 交调用方 fail-closed）。 */
function parseToolVersion(text) {
  const match = VERSION_SHAPE.exec(String(text ?? ''));
  return match === null ? null : match[0];
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
 * 可用四条件：定位到文件、执行成功（退出码 0）、输出非空、输出能解析出版本号形状。
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
  const version = parseToolVersion(captured.text);
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
    dockerText.trim() !== '' &&
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
      'RuoYi 证据生成能力探测（SBOM / 漏洞扫描 / PostgreSQL 兼容性）',
      '用法: node check-capability.mjs [--json] [--report] [--self-test] [--help]',
      '      [--java-home <绝对路径>] [--maven-home <绝对路径>]',
      '  --json                   以 JSON 输出判定结果（机器可读）',
      '  --report                 信息性运行：始终以退出码 0 结束',
      '  --self-test              用合成输入验证判定规则（不读磁盘、不执行探测）',
      '  --java-home <绝对路径>   显式指定 JDK home（优先于 JAVA_HOME 与 PATH）',
      '  --maven-home <绝对路径>  显式指定 Maven home（优先于 MAVEN_HOME/M2_HOME 与 PATH）',
      '退出码: 0 就绪 / 1 违规 / 2 被阻断 / 64 用法错误',
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
  };
  const valueFlags = { '--java-home': 'javaHome', '--maven-home': 'mavenHome' };
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

function preflight(argv, deps) {
  const flags = parseArgs(argv);
  if (flags.error) return { exitCode: EXIT.USAGE, error: flags.error, flags };
  if (flags.help || flags.selfTest)
    return { exitCode: null, flags, javaHome: null, mavenHome: null };
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
  return { exitCode: null, flags, javaHome: java.home ?? null, mavenHome: maven.home ?? null };
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
    text: 'trivy 0.58.0',
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
    '退出码 0 且输出版本号（无前缀）→ 可用',
    withCaptured({ ...good, text: '27.3.1\n' }).version,
    '27.3.1',
  );
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

  const unit = probeUnitChecks();
  if (unit.failures.length === 0) {
    console.log(`  ok 探针判定与路径安全单元检查（${unit.checks} 项）`);
  } else {
    failed += unit.failures.length;
    for (const message of unit.failures) console.error(`  x 探针判定与路径安全：${message}`);
  }

  const total = scenarios.length + preflightScenarios.length + unit.checks;
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

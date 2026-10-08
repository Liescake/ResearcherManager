#!/usr/bin/env node
/**
 * RuoYi 工具链与准入合规门禁（services/ruoyi-api/toolchain/check-gate.mjs）。
 *
 * 目的：在创建 `pom.xml` 或任何 Java 源码之前，对 `services/ruoyi-api` 边界做一次只读的
 * 准入检查。三类判定互相独立：
 *   1. 边界（违规）：门禁前不得出现 Maven 工程、Java/Kotlin 源码、构建产物或 RuoYi 源码副本；
 *   2. 清单（违规）：`gate-manifest.json` 的候选 commit 占位必须显式、合法、不可伪造；准入前置、
 *      合规产物的状态必须同时与本机实测和磁盘事实一致；
 *   3. 工具链（未准入）：本机 JDK 17+ / Maven 3.9+ 是否可用（版本探测）。
 *
 * 边界与保证：
 *   - 只用 `node:` 内置模块；不联网、不安装、不下载任何依赖；
 *   - 只读仓库：不创建、不修改、不移动、不删除仓库内任何文件；
 *   - 只以 `-version` / `-v` 之类的纯查询参数调用 `java` 与 `mvn`，绝不执行构建目标；
 *   - 受限环境可能阻止管道捕获子进程输出（Windows 沙箱为 EPERM）。此时回退为把子进程输出
 *     重定向到系统临时目录中的一个文件句柄，读完立即删除；该文件位于仓库之外，内容由子进程
 *     写入，本模块自身不写入任何文件内容；
 *   - 两级探测之外还有第三级静态回退：只读读取 JDK 的 `release` 文件或 Maven 的
 *     `lib/maven-core-<version>.jar` 文件名。
 *
 * 退出码：0 通过；1 违规（禁止项或清单非法）；2 未准入（前置或工具链未满足）；64 用法错误。
 *
 * 用法（可在任意工作目录执行，脚本按自身位置解析同目录清单）：
 *   node check-gate.mjs
 *   node check-gate.mjs --json
 *   node check-gate.mjs --report      # 信息性运行：始终以退出码 0 结束
 *   node check-gate.mjs --self-test   # 用合成输入验证判定规则（不读磁盘、不执行探测）
 */
import { closeSync, existsSync, openSync, readdirSync, readFileSync, unlinkSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/* ------------------------------------------------------------------ *
 * 常量
 * ------------------------------------------------------------------ */

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
const GATE_ROOT = resolve(MODULE_DIR, '..');
const REPO_ROOT = resolve(GATE_ROOT, '..', '..');
const MANIFEST_FILE = join(MODULE_DIR, 'gate-manifest.json');

const CONTRACT_ID = 'ruoyi-toolchain-gate';
const STAGES = ['pre-poc-gate', 'admitted'];
const ARTIFACT_STATUS = ['pending', 'present', 'verified'];
const PREREQUISITE_STATUS = ['pending', 'satisfied'];

/** 必需前置：缺少任一项即判清单非法（防止删除前置使门禁失效）。 */
const REQUIRED_PREREQUISITE_IDS = [
  'toolchain-jdk',
  'toolchain-maven',
  'candidate-commit',
  'license-notice',
  'dependency-licenses',
  'sbom',
  'vulnerability-scan',
  'postgresql-compatibility',
  'security-review',
  'final-review',
];

/** 已文档化的最低基线（services/ruoyi-api/README.md「当前环境门禁」）；清单不得下调。 */
const DOCUMENTED_BASELINE = { jdkMinMajor: 17, mavenMinVersion: '3.9.0' };

const SEMVER = /^\d+\.\d+\.\d+$/;
const FULL_SHA = /^[0-9a-f]{40}$/;
const FABRICATED_REFERENCE =
  /^(latest|head|main|master|dev|develop|trunk|tbd|todo|pending|placeholder|none|null|n\/?a|xxx+)$/i;
const NETWORK_SPECIFIERS = new Set([
  'node:http',
  'node:https',
  'node:net',
  'node:dgram',
  'node:tls',
  'node:dns',
]);

const SKIP_DIRS = new Set([
  'node_modules',
  'target',
  '.git',
  'dist',
  'coverage',
  '.pnpm-store',
  '.pnpm-cache',
  '_acl-recovery',
]);
const MAX_DEPTH = 12;

const CODE_EXTENSIONS = ['.mjs', '.cjs', '.js', '.mts', '.cts', '.ts'];
const DOCUMENT_EXTENSIONS = ['.md'];

const EXIT = { PASS: 0, VIOLATION: 1, NOT_READY: 2, USAGE: 64, SELF_TEST_FAILED: 1 };

/* ------------------------------------------------------------------ *
 * 基础工具
 * ------------------------------------------------------------------ */

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toPosix(value) {
  return value.split('\\').join('/');
}

function relPosix(root, absolutePath) {
  return toPosix(relative(root, absolutePath));
}

function formatValue(value) {
  if (value === null) return 'null';
  if (typeof value === 'string') return `"${value}"`;
  return String(value);
}

function sameList(left, right) {
  return left.length === right.length && left.every((item, index) => item === right[index]);
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

/* ------------------------------------------------------------------ *
 * 目录扫描（只读）
 * ------------------------------------------------------------------ */

function scanTree(root, options) {
  const files = [];
  const dirs = [];
  let skipped = 0;
  let truncated = false;
  const walk = (dir, depth) => {
    if (depth > options.maxDepth) {
      truncated = true;
      return;
    }
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      // 目录不可读（权限或被移除）：计入跳过，不中断整体扫描
      skipped += 1;
      return;
    }
    for (const entry of entries) {
      const absolutePath = join(dir, entry.name);
      if (entry.isSymbolicLink()) {
        skipped += 1;
        continue;
      }
      if (entry.isDirectory()) {
        if (options.skipDirs.has(entry.name)) {
          skipped += 1;
          continue;
        }
        dirs.push(absolutePath);
        walk(absolutePath, depth + 1);
      } else if (entry.isFile()) {
        files.push(absolutePath);
      } else {
        skipped += 1;
      }
    }
  };
  walk(root, 0);
  return { files, dirs, skipped, truncated };
}

function readSourceEntries(root) {
  const scan = scanTree(root, { skipDirs: SKIP_DIRS, maxDepth: MAX_DEPTH });
  const entries = [];
  for (const absolutePath of scan.files) {
    const file = relPosix(root, absolutePath);
    const lower = file.toLowerCase();
    const isCode = CODE_EXTENSIONS.some((extension) => lower.endsWith(extension));
    const isDocument = DOCUMENT_EXTENSIONS.some((extension) => lower.endsWith(extension));
    if (!isCode && !isDocument) continue;
    try {
      entries.push({ file, isCode, text: readFileSync(absolutePath, 'utf8') });
    } catch {
      // 读取失败的文件按缺失处理，其余检查继续
    }
  }
  return entries;
}

/* ------------------------------------------------------------------ *
 * 工具链探测（只读；仅查询版本）
 * ------------------------------------------------------------------ */

function executableCandidates(names, homes) {
  const candidates = [];
  for (const home of homes) {
    if (typeof home !== 'string' || home.trim() === '') continue;
    for (const name of names) candidates.push(join(home, 'bin', name));
  }
  for (const dir of String(process.env.PATH ?? '').split(delimiter)) {
    if (!dir) continue;
    for (const name of names) candidates.push(join(dir, name));
  }
  const seen = new Set();
  const unique = [];
  for (const candidate of candidates) {
    const key = process.platform === 'win32' ? candidate.toLowerCase() : candidate;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(candidate);
  }
  return unique.slice(0, 60);
}

function javaCandidates() {
  const names = process.platform === 'win32' ? ['java.exe', 'java'] : ['java'];
  return executableCandidates(names, [process.env.JAVA_HOME]);
}

function mavenCandidates() {
  const names = process.platform === 'win32' ? ['mvn.cmd', 'mvn.exe', 'mvn'] : ['mvn'];
  return executableCandidates(names, [process.env.MAVEN_HOME, process.env.M2_HOME]);
}

/**
 * 捕获子进程输出：先管道，被环境阻止时回退为临时文件句柄（均只读仓库）。
 * 返回 { ok, mode: 'pipe'|'temp-fd', text } 或 { ok: false, reason }。
 */
function captureOutput(command, args) {
  const baseOptions = { windowsHide: true, shell: /\.(cmd|bat)$/i.test(command) };
  const piped = spawnSync(command, args, { ...baseOptions, encoding: 'utf8' });
  if (!piped.error) {
    return { ok: true, mode: 'pipe', text: `${piped.stdout ?? ''}${piped.stderr ?? ''}` };
  }
  if (piped.error.code === 'ENOENT') return { ok: false, mode: 'none', reason: 'ENOENT' };

  const tempFile = join(tmpdir(), `ruoyi-toolchain-probe-${process.pid}-${Date.now()}.txt`);
  let descriptor = null;
  try {
    descriptor = openSync(tempFile, 'w');
    const redirected = spawnSync(command, args, {
      ...baseOptions,
      stdio: ['ignore', descriptor, descriptor],
    });
    closeSync(descriptor);
    descriptor = null;
    if (redirected.error) {
      return { ok: false, mode: 'none', reason: redirected.error.code ?? 'unknown' };
    }
    return { ok: true, mode: 'temp-fd', text: readFileSync(tempFile, 'utf8') };
  } catch (error) {
    return { ok: false, mode: 'none', reason: error?.code ?? 'unknown' };
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

function parseJavaVersion(text) {
  const match =
    /(?:java|openjdk|jdk)\s+version\s+"([^"]+)"/i.exec(text) ?? /JAVA_VERSION="([^"]+)"/.exec(text);
  const raw = match ? match[1] : null;
  if (!raw) return null;
  const legacy = /^1\.(\d+)/.exec(raw);
  const modern = /^(\d+)/.exec(raw);
  const digits = legacy ? legacy[1] : modern ? modern[1] : null;
  return { raw, major: digits === null ? null : Number(digits) };
}

function parseMavenVersion(text) {
  const match = /Apache Maven\s+(\d+(?:\.\d+)*)/i.exec(text);
  if (!match) return null;
  return { raw: match[1], major: Number(match[1].split('.')[0]) };
}

function javaHomeFromExecutable(executablePath) {
  const binDir = dirname(executablePath);
  return basename(binDir).toLowerCase() === 'bin' ? dirname(binDir) : null;
}

function javaStaticVersion(executablePath) {
  const home = javaHomeFromExecutable(executablePath);
  if (!home) return null;
  try {
    return parseJavaVersion(readFileSync(join(home, 'release'), 'utf8'));
  } catch {
    // 无 release 文件（JRE 或非标准布局）：静态回退不可用
    return null;
  }
}

function mavenStaticVersion(executablePath) {
  const binDir = dirname(executablePath);
  if (basename(binDir).toLowerCase() !== 'bin') return null;
  try {
    for (const entry of readdirSync(join(dirname(binDir), 'lib'))) {
      const match = /^maven-core-(\d+(?:\.\d+)*)\.jar$/i.exec(entry);
      if (match) return { raw: match[1], major: Number(match[1].split('.')[0]) };
    }
  } catch {
    // lib 目录不可读：静态回退不可用
  }
  return null;
}

function probeTool(probe) {
  const record = {
    name: probe.name,
    path: null,
    version: null,
    major: null,
    mode: 'none',
    found: false,
    checked: [],
    note: null,
  };
  for (const candidate of probe.candidates()) {
    record.checked.push(candidate);
    if (!existsSync(candidate)) continue;
    const captured = captureOutput(candidate, probe.args);
    let parsed = captured.ok ? probe.parse(captured.text) : null;
    let mode = captured.ok ? captured.mode : 'none';
    let note = null;
    if (!parsed) {
      const fallback = probe.staticVersion(candidate);
      if (fallback) {
        parsed = fallback;
        mode = 'static-file';
        note = null;
      } else if (!captured.ok) {
        note = `执行被环境阻止（${captured.reason}）`;
      } else {
        note = '命令输出无法解析出版本';
      }
    }
    if (parsed) {
      record.path = candidate;
      record.version = parsed.raw;
      record.major = parsed.major ?? null;
      record.mode = mode;
      record.found = true;
      record.note = null;
      return record;
    }
    record.note = note;
  }
  return record;
}

const JDK_PROBE = {
  name: 'JDK',
  args: ['-version'],
  candidates: javaCandidates,
  parse: parseJavaVersion,
  staticVersion: javaStaticVersion,
};

const MAVEN_PROBE = {
  name: 'Maven',
  args: ['-v'],
  candidates: mavenCandidates,
  parse: parseMavenVersion,
  staticVersion: mavenStaticVersion,
};

function jdkReady(record, minimumMajor) {
  return Boolean(
    record && record.path && typeof record.major === 'number' && record.major >= minimumMajor,
  );
}

function mavenReady(record, minimumVersion) {
  return Boolean(
    record &&
    record.path &&
    typeof record.version === 'string' &&
    compareVersions(record.version, minimumVersion) >= 0,
  );
}

/* ------------------------------------------------------------------ *
 * 检查：边界、清单、工具链
 * ------------------------------------------------------------------ */

function checkBoundaryShape(boundary, report) {
  if (!isPlainObject(boundary)) {
    report.violations.push('gate-manifest.json: boundary 必须是对象');
    return;
  }
  const requiredLists = [
    'forbiddenFiles',
    'forbiddenExtensions',
    'forbiddenDirectories',
    'ruoyiSourceMarkers',
    'forbiddenTextMarkers',
    'frozenPaths',
    'allowedImportSpecifiers',
  ];
  for (const key of requiredLists) {
    const value = boundary[key];
    const valid =
      Array.isArray(value) &&
      value.length > 0 &&
      value.every((item) => typeof item === 'string' && item.trim() !== '');
    if (!valid) {
      report.violations.push(
        `gate-manifest.json: boundary.${key} 必须是非空字符串数组（禁止通过清空清单使门禁失效）`,
      );
    }
  }
  if (Array.isArray(boundary.allowedImportSpecifiers)) {
    for (const specifier of boundary.allowedImportSpecifiers) {
      if (typeof specifier === 'string' && !specifier.startsWith('node:')) {
        report.violations.push(
          `gate-manifest.json: boundary.allowedImportSpecifiers 只允许 node: 内置模块（发现 ${specifier}）`,
        );
      }
    }
  }
  const flags = [
    boundary.forbidNetworkAccess,
    boundary.forbidDependencyDownload,
    boundary.forbidInternalDocumentReferences,
  ];
  if (flags.some((flag) => flag !== true)) {
    report.violations.push(
      'gate-manifest.json: boundary 的网络访问、依赖下载与内部文档引用禁止开关必须为 true',
    );
  }
}

function collectBoundaryViolations(paths, boundary, label) {
  const violations = [];
  const forbiddenFiles = new Set(
    (boundary.forbiddenFiles ?? [])
      .filter((item) => typeof item === 'string')
      .map((item) => item.toLowerCase()),
  );
  const forbiddenExtensions = (boundary.forbiddenExtensions ?? [])
    .filter((item) => typeof item === 'string')
    .map((item) => item.toLowerCase());
  const forbiddenDirectories = (boundary.forbiddenDirectories ?? [])
    .filter((item) => typeof item === 'string')
    .map((item) => item.toLowerCase());
  const markers = (boundary.ruoyiSourceMarkers ?? [])
    .filter((item) => typeof item === 'string')
    .map((item) => item.toLowerCase());
  for (const entry of paths) {
    const lower = entry.toLowerCase();
    const segments = lower.split('/');
    const base = segments[segments.length - 1];
    if (forbiddenFiles.has(base)) {
      violations.push(`${label}/${entry}: 门禁前禁止创建构建文件 ${base}`);
    }
    for (const extension of forbiddenExtensions) {
      if (lower.endsWith(extension)) {
        violations.push(`${label}/${entry}: 门禁前禁止创建 ${extension} 源码或构建产物`);
      }
    }
    for (const directory of forbiddenDirectories) {
      if (
        lower === directory ||
        lower.startsWith(`${directory}/`) ||
        lower.includes(`/${directory}/`)
      ) {
        violations.push(`${label}/${entry}: 门禁前禁止创建 ${directory} 目录内容`);
      }
    }
    for (const marker of markers) {
      if (segments.includes(marker)) {
        violations.push(
          `${label}/${entry}: 疑似 RuoYi 源码副本（路径段 ${marker}），禁止复制进本仓库`,
        );
      }
    }
  }
  return violations;
}

function checkBoundaryScan(paths, boundary, report, scanRoot) {
  if (!isPlainObject(boundary)) return;
  const label = scanRoot ?? 'services/ruoyi-api';
  const stage = report.summary.manifest?.stage ?? 'pre-poc-gate';
  const violations = collectBoundaryViolations(paths, boundary, label);
  if (violations.length > 0) {
    report.violations.push(...violations);
    report.violations.push(
      `边界违规合计 ${violations.length} 项：stage=${stage} 时 ${label} 内不得出现 Maven 工程、Java 源码或 RuoYi 源码副本`,
    );
  }
  report.summary.boundary = { scanned: paths.length, forbiddenHits: violations.length };
}

function collectImportSpecifiers(text) {
  const found = new Set();
  const patterns = [
    /\bimport\s+(?:[^'"();]*?\sfrom\s*)?['"]([^'"]+)['"]/g,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  ];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) found.add(match[1]);
  }
  return [...found];
}

function checkSourcePolicy(sources, boundary, report) {
  if (!isPlainObject(boundary)) return;
  const allowed = new Set(
    Array.isArray(boundary.allowedImportSpecifiers) ? boundary.allowedImportSpecifiers : [],
  );
  const textMarkers = (boundary.forbiddenTextMarkers ?? []).filter(
    (item) => typeof item === 'string' && item !== '',
  );
  let codeFiles = 0;
  let specifierCount = 0;
  for (const source of sources) {
    const text = typeof source?.text === 'string' ? source.text : '';
    if (source?.isCode === true) {
      codeFiles += 1;
      for (const specifier of collectImportSpecifiers(text)) {
        specifierCount += 1;
        if (NETWORK_SPECIFIERS.has(specifier)) {
          report.violations.push(`${source.file}: 禁止网络访问（导入 ${specifier}）`);
          continue;
        }
        if (specifier.startsWith('node:')) {
          if (!allowed.has(specifier)) {
            report.violations.push(
              `${source.file}: 导入 ${specifier} 不在 boundary.allowedImportSpecifiers 允许清单内`,
            );
          }
          continue;
        }
        const isSibling = specifier.startsWith('./') && !specifier.includes('..');
        if (!isSibling) {
          report.violations.push(
            `${source.file}: 只允许 Node 内置模块或同目录相对导入（发现 ${specifier}）`,
          );
        }
      }
    }
    for (const marker of textMarkers) {
      if (text.includes(marker)) {
        report.violations.push(`${source.file}: 公开材料不得引用内部文档（命中标记 ${marker}）`);
      }
    }
  }
  report.summary.sourcePolicy = {
    files: sources.length,
    codeFiles,
    importSpecifiers: specifierCount,
    forbiddenTextMarkers: textMarkers.length,
  };
}

function checkPrerequisites(prerequisites, report) {
  const byId = new Map();
  if (!Array.isArray(prerequisites) || prerequisites.length === 0) {
    report.violations.push('gate-manifest.json: admissionPrerequisites 必须是非空数组');
    return byId;
  }
  let satisfied = 0;
  for (const entry of prerequisites) {
    if (!isPlainObject(entry)) {
      report.violations.push('admissionPrerequisites 的每一项必须是对象');
      continue;
    }
    const id = entry.id;
    if (typeof id !== 'string' || id.trim() === '') {
      report.violations.push('admissionPrerequisites 每项必须有非空 id');
      continue;
    }
    if (byId.has(id)) report.violations.push(`admissionPrerequisites 的 id 重复：${id}`);
    if (!PREREQUISITE_STATUS.includes(entry.status)) {
      report.violations.push(
        `前置 ${id} 的 status 只能是 ${PREREQUISITE_STATUS.join(' / ')}（当前 ${formatValue(entry.status)}）`,
      );
    }
    if (typeof entry.requirement !== 'string' || entry.requirement.trim() === '') {
      report.violations.push(`前置 ${id} 必须有非空 requirement`);
    }
    if (entry.status === 'satisfied') {
      satisfied += 1;
      if (typeof entry.evidence !== 'string' || entry.evidence.trim() === '') {
        report.violations.push(`前置 ${id} 标记 satisfied 必须提供非空 evidence`);
      }
    }
    byId.set(id, entry);
  }
  for (const required of REQUIRED_PREREQUISITE_IDS) {
    if (!byId.has(required)) {
      report.violations.push(`admissionPrerequisites 缺少必需前置：${required}`);
    }
  }
  report.summary.prerequisites = {
    total: byId.size,
    satisfied,
    unsatisfied: byId.size - satisfied,
  };
  return byId;
}

function checkCandidate(candidate, prerequisites, report) {
  if (!isPlainObject(candidate)) {
    report.violations.push('gate-manifest.json: candidate 必须是对象');
    return;
  }
  const pinned = candidate.pinned;
  if (!isPlainObject(pinned)) {
    report.violations.push('gate-manifest.json: candidate.pinned 必须是对象');
    return;
  }
  const commit = pinned.commit;
  const tag = pinned.tag;
  const resolved = pinned.resolved;
  const expect = (condition, message) => {
    if (!condition) report.violations.push(message);
  };

  if (commit !== null && !(typeof commit === 'string' && FULL_SHA.test(commit))) {
    report.violations.push(
      `candidate.pinned.commit 必须是 40 位小写十六进制 SHA 或显式 null（当前 ${formatValue(commit)}）`,
    );
  }
  if (typeof commit === 'string' && FABRICATED_REFERENCE.test(commit)) {
    report.violations.push(`candidate.pinned.commit 不得使用分支名或占位词（当前 ${commit}）`);
  }
  if (tag !== null && !(typeof tag === 'string' && tag.trim() !== '')) {
    report.violations.push(
      `candidate.pinned.tag 必须是非空标签字符串或显式 null（当前 ${formatValue(tag)}）`,
    );
  }
  if (typeof tag === 'string' && FABRICATED_REFERENCE.test(tag)) {
    report.violations.push(`candidate.pinned.tag 不得使用分支名或占位词（当前 ${tag}）`);
  }
  expect(typeof resolved === 'boolean', 'candidate.pinned.resolved 必须是布尔值');
  if (typeof resolved === 'boolean') {
    expect(
      resolved === (commit !== null),
      `candidate.pinned: resolved 必须严格等于 (commit !== null)（当前 resolved=${resolved}, commit=${formatValue(commit)}）`,
    );
  }
  if (typeof commit === 'string') {
    expect(tag !== null, 'candidate.pinned: 固定 commit 必须同时固定 tag');
  }

  const unsatisfied = [...prerequisites.values()]
    .filter((entry) => entry?.status !== 'satisfied')
    .map((entry) => entry.id)
    .sort();
  if (!Array.isArray(candidate.unresolvedReasons)) {
    report.violations.push('candidate.unresolvedReasons 必须是数组');
  } else {
    const declared = [...new Set(candidate.unresolvedReasons)].sort();
    for (const reason of declared) {
      expect(
        prerequisites.has(reason),
        `candidate.unresolvedReasons 引用了未登记的前置：${reason}`,
      );
    }
    expect(
      sameList(declared, unsatisfied),
      `candidate.unresolvedReasons 必须等于当前未满足的前置集合（声明：${declared.join(',') || '(空)'}；未满足：${unsatisfied.join(',') || '(空)'}）`,
    );
  }

  const candidatePrerequisite = prerequisites.get('candidate-commit');
  if (resolved === true) {
    expect(
      candidatePrerequisite?.status === 'satisfied',
      'candidate.pinned: 固定候选 commit 前必须先把前置 candidate-commit 标记 satisfied 并记录证据',
    );
  }
  if (candidatePrerequisite?.status === 'satisfied') {
    expect(
      resolved === true,
      'candidate.pinned: 前置 candidate-commit 已标记 satisfied 时，candidate.pinned.resolved 必须为 true',
    );
  }

  report.summary.candidate = {
    resolved: resolved === true,
    commit: typeof commit === 'string' ? commit : null,
    tag: typeof tag === 'string' ? tag : null,
    unsatisfiedReasons: unsatisfied.length,
  };
}

function checkArtifacts(artifacts, report, context) {
  if (!Array.isArray(artifacts) || artifacts.length === 0) {
    report.violations.push('gate-manifest.json: complianceArtifacts 必须是非空数组');
    return;
  }
  const byStatus = {};
  for (const artifact of artifacts) {
    if (!isPlainObject(artifact)) {
      report.violations.push('complianceArtifacts 的每一项必须是对象');
      continue;
    }
    const artifactId =
      typeof artifact.id === 'string' && artifact.id.trim() !== '' ? artifact.id : '(未命名)';
    const artifactPath = artifact.path;
    if (typeof artifact.id !== 'string' || artifact.id.trim() === '') {
      report.violations.push('complianceArtifacts 每项必须有非空 id');
    }
    const relativeSegments =
      typeof artifactPath === 'string' ? toPosix(artifactPath).split('/') : [];
    const pathValid =
      typeof artifactPath === 'string' &&
      artifactPath.trim() !== '' &&
      !isAbsolute(artifactPath) &&
      !relativeSegments.includes('..');
    if (!pathValid) {
      report.violations.push(`合规产物 ${artifactId} 的 path 必须是仓库内相对路径且不得包含 ..`);
    }
    if (!ARTIFACT_STATUS.includes(artifact.status)) {
      report.violations.push(
        `合规产物 ${artifactId} 的 status 只能是 ${ARTIFACT_STATUS.join(' / ')}（当前 ${formatValue(artifact.status)}）`,
      );
      continue;
    }
    byStatus[artifact.status] = (byStatus[artifact.status] ?? 0) + 1;
    if (!pathValid) continue;
    let onDisk = false;
    try {
      onDisk = Boolean(context?.fileExists?.(artifactPath));
    } catch {
      // 磁盘检查异常按「不存在」处理（fail-closed），onDisk 保持初始 false
    }
    if (artifact.status === 'pending' && onDisk) {
      report.violations.push(
        `合规产物 ${artifactId} 标记 pending 但磁盘已存在 ${artifactPath}（状态与证据不一致）`,
      );
    }
    if (artifact.status !== 'pending' && !onDisk) {
      report.violations.push(
        `合规产物 ${artifactId} 标记 ${artifact.status} 但磁盘不存在 ${artifactPath}`,
      );
    }
  }
  report.summary.complianceArtifacts = { total: artifacts.length, byStatus };
}

function checkStage(manifest, report, prerequisites, artifacts) {
  if (manifest.stage !== 'admitted') return;
  const unsatisfied = [...prerequisites.values()].filter((entry) => entry?.status !== 'satisfied');
  if (unsatisfied.length > 0) {
    report.violations.push(
      `stage=admitted 要求全部准入前置 satisfied，当前仍有 ${unsatisfied.length} 项未满足：${unsatisfied.map((entry) => entry.id).join(',')}`,
    );
  }
  if (manifest.candidate?.pinned?.resolved !== true) {
    report.violations.push(
      'stage=admitted 要求在冻结候选 commit（resolved=true）后才能创建 Maven/Java 工程',
    );
  }
  const pending = Array.isArray(artifacts)
    ? artifacts.filter((item) => item?.status === 'pending')
    : [];
  if (pending.length > 0) {
    report.violations.push(
      `stage=admitted 要求合规产物全部就位，当前仍有 ${pending.length} 项 pending`,
    );
  }
}

function checkManifestContent(manifest, report, context) {
  if (!isPlainObject(manifest)) {
    report.violations.push('gate-manifest.json: 内容必须是 JSON 对象');
    return;
  }
  const expect = (condition, message) => {
    if (!condition) report.violations.push(message);
  };
  expect(manifest.contract === CONTRACT_ID, `gate-manifest.json: contract 必须为 ${CONTRACT_ID}`);
  expect(
    typeof manifest.manifestVersion === 'string' && SEMVER.test(manifest.manifestVersion),
    'gate-manifest.json: manifestVersion 必须是 semver（如 0.1.0）',
  );
  expect(
    STAGES.includes(manifest.stage),
    `gate-manifest.json: stage 只能是 ${STAGES.join(' / ')}（当前 ${formatValue(manifest.stage)}）`,
  );

  const jdkMin = manifest.toolchain?.jdk?.minMajor;
  const mavenMin = manifest.toolchain?.maven?.minVersion;
  expect(
    Number.isInteger(jdkMin) && jdkMin >= DOCUMENTED_BASELINE.jdkMinMajor,
    `gate-manifest.json: toolchain.jdk.minMajor 不得低于已文档化的 JDK ${DOCUMENTED_BASELINE.jdkMinMajor}+`,
  );
  expect(
    typeof mavenMin === 'string' &&
      SEMVER.test(mavenMin) &&
      compareVersions(mavenMin, DOCUMENTED_BASELINE.mavenMinVersion) >= 0,
    `gate-manifest.json: toolchain.maven.minVersion 不得低于已文档化的 Maven ${DOCUMENTED_BASELINE.mavenMinVersion}+`,
  );

  checkBoundaryShape(manifest.boundary, report);
  const prerequisites = checkPrerequisites(manifest.admissionPrerequisites, report);
  checkCandidate(manifest.candidate, prerequisites, report);
  checkArtifacts(manifest.complianceArtifacts, report, context);
  checkStage(manifest, report, prerequisites, manifest.complianceArtifacts);

  const pinned = isPlainObject(manifest.candidate?.pinned) ? manifest.candidate.pinned : {};
  report.summary.manifest = {
    contract: manifest.contract ?? null,
    version: manifest.manifestVersion ?? null,
    stage: manifest.stage ?? null,
    pinned: {
      tag: pinned.tag ?? null,
      commit: pinned.commit ?? null,
      resolved: pinned.resolved === true,
    },
  };
}

function checkToolchain(toolchain, requirements, report) {
  if (!isPlainObject(toolchain)) {
    report.violations.push('工具链探测结果缺失：无法核验 JDK 与 Maven');
    return;
  }
  const jdkMin = Number.isInteger(requirements?.jdk?.minMajor)
    ? requirements.jdk.minMajor
    : DOCUMENTED_BASELINE.jdkMinMajor;
  const mavenMin =
    typeof requirements?.maven?.minVersion === 'string'
      ? requirements.maven.minVersion
      : DOCUMENTED_BASELINE.mavenMinVersion;
  const jdk = isPlainObject(toolchain.jdk) ? toolchain.jdk : {};
  const maven = isPlainObject(toolchain.maven) ? toolchain.maven : {};
  const checkedJdk = Array.isArray(jdk.checked) ? jdk.checked.length : 0;
  const checkedMaven = Array.isArray(maven.checked) ? maven.checked.length : 0;

  if (!jdk.path) {
    const suffix = jdk.note ? `；${jdk.note}` : '';
    report.blockers.push(
      `JDK 未找到或无法核验（要求 ${jdkMin}+）：已检查 ${checkedJdk} 个候选路径（JAVA_HOME/bin 与 PATH 中的 java）${suffix}`,
    );
  } else if (typeof jdk.major !== 'number') {
    report.blockers.push(
      `JDK 版本无法核验（${jdk.path}；${jdk.note ?? '未知原因'}）：按 fail-closed 视为未达标`,
    );
  } else if (jdk.major < jdkMin) {
    report.blockers.push(
      `JDK 版本不达标：${jdk.version}（要求 ${jdkMin}+，探测方式 ${jdk.mode}，路径 ${jdk.path}）`,
    );
  }

  if (!maven.path) {
    const suffix = maven.note ? `；${maven.note}` : '';
    report.blockers.push(
      `Maven 未找到或无法核验（要求 ${mavenMin}+）：已检查 ${checkedMaven} 个候选路径（MAVEN_HOME/M2_HOME/bin 与 PATH 中的 mvn）${suffix}`,
    );
  } else if (typeof maven.version !== 'string') {
    report.blockers.push(
      `Maven 版本无法核验（${maven.path}；${maven.note ?? '未知原因'}）：按 fail-closed 视为未达标`,
    );
  } else if (compareVersions(maven.version, mavenMin) < 0) {
    report.blockers.push(
      `Maven 版本不达标：${maven.version}（要求 ${mavenMin}+，探测方式 ${maven.mode}，路径 ${maven.path}）`,
    );
  }

  report.summary.toolchain = {
    requirements: { jdkMinMajor: jdkMin, mavenMinVersion: mavenMin },
    jdk: {
      path: jdk.path ?? null,
      version: jdk.version ?? null,
      major: typeof jdk.major === 'number' ? jdk.major : null,
      mode: jdk.mode ?? 'none',
      checked: checkedJdk,
      ready: jdkReady(jdk, jdkMin),
    },
    maven: {
      path: maven.path ?? null,
      version: maven.version ?? null,
      mode: maven.mode ?? 'none',
      checked: checkedMaven,
      ready: mavenReady(maven, mavenMin),
    },
  };
}

/** 清单里的工具链前置状态必须与本机实测一致（双向校验，防止只写声明不写证据）。 */
function checkToolchainConsistency(manifest, toolchain, report) {
  const prerequisites = Array.isArray(manifest?.admissionPrerequisites)
    ? manifest.admissionPrerequisites
    : null;
  if (!prerequisites || !isPlainObject(toolchain)) return;
  const jdkMin = Number.isInteger(manifest?.toolchain?.jdk?.minMajor)
    ? manifest.toolchain.jdk.minMajor
    : DOCUMENTED_BASELINE.jdkMinMajor;
  const mavenMin =
    typeof manifest?.toolchain?.maven?.minVersion === 'string'
      ? manifest.toolchain.maven.minVersion
      : DOCUMENTED_BASELINE.mavenMinVersion;
  const pairs = [
    {
      id: 'toolchain-jdk',
      label: 'JDK',
      ready: jdkReady(toolchain.jdk, jdkMin),
      detail: toolchain.jdk?.version ?? '未找到',
    },
    {
      id: 'toolchain-maven',
      label: 'Maven',
      ready: mavenReady(toolchain.maven, mavenMin),
      detail: toolchain.maven?.version ?? '未找到',
    },
  ];
  for (const pair of pairs) {
    const entry = prerequisites.find((item) => item?.id === pair.id);
    if (!entry || !PREREQUISITE_STATUS.includes(entry.status)) continue;
    const satisfied = entry.status === 'satisfied';
    if (pair.ready && !satisfied) {
      report.violations.push(
        `清单状态漂移：本机 ${pair.label} 已达要求（${pair.detail}），但前置 ${pair.id} 仍为 pending；必须更新状态并记录证据`,
      );
    }
    if (!pair.ready && satisfied) {
      report.violations.push(
        `清单状态漂移：前置 ${pair.id} 标记 satisfied，但本机 ${pair.label} 探测未达标（${pair.detail}）`,
      );
    }
  }
  report.summary.toolchainConsistency = pairs.map((pair) => ({ id: pair.id, ready: pair.ready }));
}

/* ------------------------------------------------------------------ *
 * 判定汇总
 * ------------------------------------------------------------------ */

function evaluate(input) {
  const report = { violations: [], blockers: [], summary: {} };
  const manifest = input.manifest;
  const boundary = isPlainObject(manifest) ? manifest.boundary : null;
  if (input.manifestError) {
    report.violations.push(`gate-manifest.json: ${input.manifestError}`);
  }
  checkManifestContent(manifest, report, input.manifestContext ?? {});
  const paths = Array.isArray(input.paths) ? input.paths : [];
  checkBoundaryScan(paths, boundary, report, input.scanRoot);
  if (!isPlainObject(manifest)) {
    report.summary.boundary = { scanned: paths.length, forbiddenHits: 0, skipped: '清单不可用' };
  }
  checkSourcePolicy(Array.isArray(input.sources) ? input.sources : [], boundary, report);
  checkToolchain(input.toolchain, isPlainObject(manifest) ? manifest.toolchain : null, report);
  checkToolchainConsistency(manifest, input.toolchain, report);
  report.exitCode =
    report.violations.length > 0
      ? EXIT.VIOLATION
      : report.blockers.length > 0
        ? EXIT.NOT_READY
        : EXIT.PASS;
  return report;
}

/* ------------------------------------------------------------------ *
 * 输出
 * ------------------------------------------------------------------ */

function describeTool(record, requirement) {
  const verdict = record.ready ? '达标' : '未达标';
  const found = record.path ? record.path : '未找到';
  return `${record.version ?? '未找到版本'}（要求 ${requirement}）→ ${verdict} [探测方式 ${record.mode}；${found}]`;
}

function formatCounts(counts) {
  const entries = Object.entries(counts ?? {});
  if (entries.length === 0) return '无';
  return entries.map(([status, count]) => `${status} ${count}`).join(' / ');
}

function renderText(report, context) {
  const lines = [];
  lines.push('RuoYi 工具链与准入合规门禁（仅使用 Node 内置模块；不联网、不下载依赖、不写仓库）');
  lines.push(`- 检查根目录: ${context.gateRoot}`);
  const manifestSummary = report.summary.manifest;
  lines.push(
    `- 清单: ${context.manifestFile}${
      manifestSummary
        ? `（contract=${manifestSummary.contract}, manifestVersion=${manifestSummary.version}, stage=${manifestSummary.stage}）`
        : '（未能解析）'
    }`,
  );
  lines.push(
    `- 扫描: 文件 ${context.scannedFiles} 个 / 目录 ${context.scannedDirs} 个（跳过 ${context.skipped} 项${
      context.truncated ? '；已达深度上限' : ''
    }）`,
  );
  lines.push(
    `- 源码自审: ${context.sourceFiles} 个公开文件（导入白名单 + 网络模块 + 内部文档引用）`,
  );
  const toolchain = report.summary.toolchain;
  if (toolchain) {
    lines.push(
      `- 工具链 JDK: ${describeTool(toolchain.jdk, `>= ${toolchain.requirements.jdkMinMajor}`)}`,
    );
    lines.push(
      `- 工具链 Maven: ${describeTool(toolchain.maven, `>= ${toolchain.requirements.mavenMinVersion}`)}`,
    );
  }
  const candidate = report.summary.candidate;
  if (candidate) {
    lines.push(
      `- 候选 commit 占位: tag=${candidate.tag ?? 'null'}, commit=${candidate.commit ?? 'null'}, resolved=${candidate.resolved}（未满足前置 ${candidate.unsatisfiedReasons} 项）`,
    );
  }
  const prerequisites = report.summary.prerequisites;
  if (prerequisites) {
    lines.push(`- 准入前置: ${prerequisites.satisfied}/${prerequisites.total} 已满足`);
  }
  const artifacts = report.summary.complianceArtifacts;
  if (artifacts) {
    lines.push(`- 合规产物: ${artifacts.total} 项（${formatCounts(artifacts.byStatus)}）`);
  }
  const boundary = report.summary.boundary;
  if (boundary) {
    lines.push(`- 边界扫描: ${boundary.scanned} 个条目，违规 ${boundary.forbiddenHits} 项`);
  }
  return lines.join('\n');
}

function printUsage() {
  console.log(
    [
      'RuoYi 工具链与准入合规门禁',
      '用法: node check-gate.mjs [--json] [--report] [--self-test] [--help]',
      '  --json       以 JSON 输出判定结果（机器可读）',
      '  --report     信息性运行：始终以退出码 0 结束',
      '  --self-test  用合成输入验证判定规则（不读磁盘、不执行探测）',
      '退出码: 0 通过 / 1 违规 / 2 未准入 / 64 用法错误',
    ].join('\n'),
  );
}

function parseArgs(argv) {
  const flags = { json: false, report: false, selfTest: false, help: false, error: null };
  for (const arg of argv) {
    if (arg === '--json') flags.json = true;
    else if (arg === '--report') flags.report = true;
    else if (arg === '--self-test') flags.selfTest = true;
    else if (arg === '--help' || arg === '-h') flags.help = true;
    else flags.error = `未知参数：${arg}`;
  }
  return flags;
}

function loadManifest() {
  let text;
  try {
    text = readFileSync(MANIFEST_FILE, 'utf8');
  } catch (error) {
    return { manifest: null, error: `无法读取 ${MANIFEST_FILE}（${error.message}）` };
  }
  try {
    return { manifest: JSON.parse(text.replace(/^\uFEFF/, '')), error: null };
  } catch (error) {
    return { manifest: null, error: `JSON 解析失败（${error.message}）` };
  }
}

/* ------------------------------------------------------------------ *
 * 自检：合成输入验证判定规则
 * ------------------------------------------------------------------ */

const SELF_TEST_MARKER = 'internal-notes/';

const FIXTURE_BOUNDARY = {
  rule: 'fixture',
  scanRoot: 'services/ruoyi-api',
  forbiddenFiles: ['pom.xml'],
  forbiddenExtensions: ['.java'],
  forbiddenDirectories: ['src/main/java'],
  ruoyiSourceMarkers: ['ruoyi-admin'],
  forbiddenTextMarkers: [SELF_TEST_MARKER],
  frozenPaths: ['services/api', 'db/migrations'],
  allowedImportSpecifiers: ['node:fs', 'node:path'],
  forbidNetworkAccess: true,
  forbidDependencyDownload: true,
  forbidInternalDocumentReferences: true,
};

const FIXTURE_COMMIT = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4';

function fixtureJdk({ version = '17.0.9', major = 17, found = true, mode = 'temp-fd' } = {}) {
  return {
    name: 'JDK',
    path: found ? 'C:/jdk-17/bin/java.exe' : null,
    version: found ? version : null,
    major: found ? major : null,
    mode: found ? mode : 'none',
    found,
    checked: ['C:/jdk-17/bin/java.exe'],
    note: null,
  };
}

function fixtureMaven({ version = '3.9.6', found = true, mode = 'temp-fd' } = {}) {
  return {
    name: 'Maven',
    path: found ? 'C:/maven/bin/mvn.cmd' : null,
    version: found ? version : null,
    major: found ? 3 : null,
    mode: found ? mode : 'none',
    found,
    checked: ['C:/maven/bin/mvn.cmd'],
    note: null,
  };
}

function fixtureManifest(options = {}) {
  const satisfiedSet = new Set(options.satisfied ?? []);
  const prerequisites = REQUIRED_PREREQUISITE_IDS.map((id) => {
    const entry = {
      id,
      status: satisfiedSet.has(id) ? 'satisfied' : 'pending',
      requirement: `fixture:${id}`,
    };
    if (satisfiedSet.has(id)) entry.evidence = `fixture-evidence:${id}`;
    return entry;
  });
  const pinned = options.pinned ?? {};
  const commit = Object.prototype.hasOwnProperty.call(pinned, 'commit') ? pinned.commit : null;
  const tag = Object.prototype.hasOwnProperty.call(pinned, 'tag') ? pinned.tag : null;
  const resolved = Object.prototype.hasOwnProperty.call(pinned, 'resolved')
    ? pinned.resolved
    : commit !== null;
  const manifest = {
    contract: CONTRACT_ID,
    manifestVersion: '0.1.0',
    stage: options.stage ?? 'pre-poc-gate',
    boundary: { ...FIXTURE_BOUNDARY, ...(options.boundary ?? {}) },
    toolchain: { jdk: { minMajor: 17 }, maven: { minVersion: '3.9.0' } },
    candidate: {
      target: { project: 'RuoYi-Vue', line: 'spring-boot-3', minJdkMajor: 17 },
      pinned: { tag, commit, resolved },
      unresolvedReasons: REQUIRED_PREREQUISITE_IDS.filter((id) => !satisfiedSet.has(id)),
    },
    admissionPrerequisites: prerequisites,
    complianceArtifacts: options.artifacts ?? [
      { id: 'license', path: 'services/ruoyi-api/compliance/LICENSE', status: 'verified' },
    ],
  };
  if (options.manifestVersion) manifest.manifestVersion = options.manifestVersion;
  if (options.toolchain) manifest.toolchain = options.toolchain;
  if (options.candidate) manifest.candidate = { ...manifest.candidate, ...options.candidate };
  return manifest;
}

function fixtureSource(file, text) {
  const lower = file.toLowerCase();
  return { file, text, isCode: CODE_EXTENSIONS.some((extension) => lower.endsWith(extension)) };
}

/**
 * 自检样本：引号以构造方式拼出，样本在运行期才是完整的导入语句。
 * 否则校验器会命中自身源码中的样本，把自检夹具误判为真实导入。
 */
const FIXTURE_QUOTE = String.fromCharCode(39);

function fixtureStaticImport(specifier) {
  return `import { sample } from ${FIXTURE_QUOTE}${specifier}${FIXTURE_QUOTE};`;
}

function fixtureDynamicImport(specifier) {
  return `import(${FIXTURE_QUOTE}${specifier}${FIXTURE_QUOTE});`;
}

function fixtureRequire(specifier) {
  return `require(${FIXTURE_QUOTE}${specifier}${FIXTURE_QUOTE});`;
}

function runSelfTestScenario(scenario) {
  const report = evaluate({
    manifest: scenario.manifest === undefined ? fixtureManifest(scenario) : scenario.manifest,
    manifestError: scenario.manifestError ?? null,
    paths: scenario.paths ?? [],
    sources: scenario.sources ?? [],
    toolchain: scenario.probe ?? { jdk: fixtureJdk(), maven: fixtureMaven() },
    scanRoot: 'services/ruoyi-api',
    manifestContext: { fileExists: scenario.fileExists ?? (() => true) },
  });
  const messages = [...report.violations, ...report.blockers].join('\n');
  const failures = [];
  if (report.exitCode !== scenario.expectCode) {
    failures.push(`退出码期望 ${scenario.expectCode}，实际 ${report.exitCode}`);
  }
  for (const needle of scenario.expect ?? []) {
    if (!messages.includes(needle)) failures.push(`期望信息包含「${needle}」`);
  }
  return { name: scenario.name, failures, report };
}

function selfTest() {
  const allIds = [...REQUIRED_PREREQUISITE_IDS];
  const withoutJdk = allIds.filter((id) => id !== 'toolchain-jdk');
  const withoutMaven = allIds.filter((id) => id !== 'toolchain-maven');
  const greenPinned = { commit: FIXTURE_COMMIT, tag: 'v3.9.2', resolved: true };
  const green = { satisfied: allIds, pinned: greenPinned };

  const scenarios = [
    { name: '准入前置齐备 + JDK17.0.9 + Maven3.9.6 → 通过', ...green, expectCode: 0 },
    {
      name: '门禁前出现 pom.xml',
      ...green,
      paths: ['pom.xml'],
      expectCode: 1,
      expect: ['pom.xml'],
    },
    {
      name: '门禁前出现 Java 源码',
      ...green,
      paths: ['legacy/App.java'],
      expectCode: 1,
      expect: ['.java'],
    },
    {
      name: '门禁前出现 RuoYi 源码副本',
      ...green,
      paths: ['ruoyi-admin/src/main/resources/application.yml'],
      expectCode: 1,
      expect: ['ruoyi-admin'],
    },
    {
      name: '门禁前出现 src/main/java 目录',
      ...green,
      paths: ['src/main/java'],
      expectCode: 1,
      expect: ['src/main/java'],
    },
    {
      name: '候选 commit 为短 SHA',
      satisfied: allIds,
      pinned: { commit: '0e2d75c', tag: 'v3.9.2', resolved: true },
      expectCode: 1,
      expect: ['40 位'],
    },
    {
      name: '候选 commit 伪造为分支名',
      satisfied: allIds,
      pinned: { commit: 'latest', tag: 'v3.9.2', resolved: true },
      expectCode: 1,
      expect: ['commit'],
    },
    {
      name: 'resolved 与 commit 不一致',
      ...green,
      pinned: { commit: null, tag: null, resolved: true },
      expectCode: 1,
      expect: ['resolved'],
    },
    {
      name: '固定 commit 未同时固定 tag',
      ...green,
      pinned: { commit: FIXTURE_COMMIT, tag: null, resolved: true },
      expectCode: 1,
      expect: ['tag'],
    },
    {
      name: '前置 candidate-commit 已满足但未固定 commit',
      ...green,
      pinned: { commit: null, tag: null, resolved: false },
      expectCode: 1,
      expect: ['candidate-commit'],
    },
    {
      name: '未固定原因与未满足前置不一致',
      satisfied: [],
      pinned: { commit: null, tag: null, resolved: false },
      candidate: { unresolvedReasons: ['toolchain-jdk'] },
      expectCode: 1,
      expect: ['unresolvedReasons'],
    },
    {
      name: '未固定原因引用未登记前置',
      satisfied: allIds,
      pinned: greenPinned,
      candidate: { unresolvedReasons: ['not-registered'] },
      expectCode: 1,
      expect: ['未登记的前置'],
    },
    {
      name: 'admitted 阶段仍有未满足前置',
      satisfied: ['candidate-commit'],
      pinned: greenPinned,
      stage: 'admitted',
      expectCode: 1,
      expect: ['admitted'],
    },
    {
      name: 'stage 取值非法',
      ...green,
      stage: 'poc',
      expectCode: 1,
      expect: ['stage'],
    },
    {
      name: '合规产物标记 verified 但磁盘不存在',
      ...green,
      fileExists: () => false,
      expectCode: 1,
      expect: ['合规产物'],
    },
    {
      name: '合规产物标记 pending 但磁盘已存在',
      ...green,
      artifacts: [
        { id: 'license', path: 'services/ruoyi-api/compliance/LICENSE', status: 'pending' },
      ],
      fileExists: () => true,
      expectCode: 1,
      expect: ['合规产物'],
    },
    {
      name: 'JDK 8 不达标',
      satisfied: withoutJdk,
      pinned: greenPinned,
      probe: { jdk: fixtureJdk({ version: '1.8.0_501', major: 8 }), maven: fixtureMaven() },
      expectCode: 2,
      expect: ['JDK 版本不达标'],
    },
    {
      name: 'Maven 3.8.8 不达标',
      satisfied: withoutMaven,
      pinned: greenPinned,
      probe: { jdk: fixtureJdk(), maven: fixtureMaven({ version: '3.8.8' }) },
      expectCode: 2,
      expect: ['Maven 版本不达标'],
    },
    {
      name: 'Maven 未安装',
      satisfied: withoutMaven,
      pinned: greenPinned,
      probe: { jdk: fixtureJdk(), maven: fixtureMaven({ found: false }) },
      expectCode: 2,
      expect: ['Maven 未找到'],
    },
    {
      name: 'JDK 未安装',
      satisfied: withoutJdk,
      pinned: greenPinned,
      probe: { jdk: fixtureJdk({ found: false }), maven: fixtureMaven() },
      expectCode: 2,
      expect: ['JDK 未找到'],
    },
    {
      name: '清单状态漂移：JDK 达标但前置仍 pending',
      satisfied: withoutJdk,
      pinned: greenPinned,
      expectCode: 1,
      expect: ['状态漂移'],
    },
    {
      name: '清单版本非 semver',
      ...green,
      manifestVersion: 'v1',
      expectCode: 1,
      expect: ['semver'],
    },
    {
      name: '工具链要求被下调到 JDK 8',
      ...green,
      toolchain: { jdk: { minMajor: 8 }, maven: { minVersion: '3.9.0' } },
      expectCode: 1,
      expect: ['17'],
    },
    {
      name: '禁止项清单被清空',
      ...green,
      boundary: { forbiddenFiles: [] },
      expectCode: 1,
      expect: ['forbiddenFiles'],
    },
    {
      name: '清单缺失或不可解析',
      manifestError: '无法读取 gate-manifest.json（fixture）',
      expectCode: 1,
      expect: ['gate-manifest.json'],
    },
    {
      name: '公开材料引用内部文档',
      ...green,
      sources: [fixtureSource('README.md', 'see internal-notes/P3.md for details')],
      expectCode: 1,
      expect: ['内部文档'],
    },
    {
      name: '第三方依赖导入',
      ...green,
      sources: [fixtureSource('x.mjs', fixtureStaticImport('yaml'))],
      expectCode: 1,
      expect: ['内置模块'],
    },
    {
      name: '网络模块导入',
      ...green,
      sources: [fixtureSource('x.mjs', fixtureStaticImport('node:http'))],
      expectCode: 1,
      expect: ['网络访问'],
    },
    {
      name: '导入不在允许清单内',
      ...green,
      sources: [fixtureSource('x.mjs', fixtureStaticImport('node:vm'))],
      expectCode: 1,
      expect: ['允许清单'],
    },
    {
      name: '动态导入第三方依赖',
      ...green,
      sources: [fixtureSource('x.mjs', fixtureDynamicImport('yaml'))],
      expectCode: 1,
      expect: ['内置模块'],
    },
    {
      name: 'CommonJS require 第三方依赖',
      ...green,
      sources: [fixtureSource('x.cjs', fixtureRequire('lodash'))],
      expectCode: 1,
      expect: ['内置模块'],
    },
    {
      name: '同目录相对导入放行',
      ...green,
      sources: [fixtureSource('x.mjs', fixtureStaticImport('./helper.mjs'))],
      expectCode: 0,
    },
  ];

  console.log('RuoYi 工具链门禁自检（合成输入；不读磁盘、不执行探测器）');
  let failed = 0;
  for (const scenario of scenarios) {
    const result = runSelfTestScenario(scenario);
    if (result.failures.length === 0) {
      console.log(`  ok ${scenario.name}（退出码 ${result.report.exitCode}）`);
      continue;
    }
    failed += 1;
    console.error(`  x ${scenario.name}：${result.failures.join('；')}`);
    for (const message of [...result.report.violations, ...result.report.blockers].slice(0, 4)) {
      console.error(`      - ${message}`);
    }
  }
  console.log(`\n自检: ${scenarios.length - failed}/${scenarios.length} 通过`);
  return failed === 0 ? EXIT.PASS : EXIT.SELF_TEST_FAILED;
}

/* ------------------------------------------------------------------ *
 * 主流程
 * ------------------------------------------------------------------ */

function main(argv) {
  const flags = parseArgs(argv);
  if (flags.error) {
    console.error(flags.error);
    printUsage();
    return EXIT.USAGE;
  }
  if (flags.help) {
    printUsage();
    return EXIT.PASS;
  }
  if (flags.selfTest) return selfTest();

  const loaded = loadManifest();
  const manifest = loaded.manifest;
  const scan = scanTree(GATE_ROOT, { skipDirs: SKIP_DIRS, maxDepth: MAX_DEPTH });
  const paths = [...scan.files, ...scan.dirs].map((absolutePath) =>
    relPosix(GATE_ROOT, absolutePath),
  );
  const sources = readSourceEntries(GATE_ROOT);
  const toolchain = { jdk: probeTool(JDK_PROBE), maven: probeTool(MAVEN_PROBE) };
  const context = {
    gateRoot: GATE_ROOT,
    manifestFile: MANIFEST_FILE,
    scannedFiles: scan.files.length,
    scannedDirs: scan.dirs.length,
    skipped: scan.skipped,
    truncated: scan.truncated,
    sourceFiles: sources.length,
    mode: flags.report ? 'report' : 'gate',
  };
  const report = evaluate({
    manifest,
    manifestError: loaded.error,
    paths,
    sources,
    toolchain,
    scanRoot: relPosix(REPO_ROOT, GATE_ROOT),
    manifestContext: {
      fileExists: (artifactPath) => existsSync(resolve(REPO_ROOT, artifactPath)),
    },
  });

  if (flags.json) {
    console.log(JSON.stringify({ ...report, context, exitCode: report.exitCode }, null, 2));
  } else {
    console.log(renderText(report, context));
    if (report.violations.length > 0) {
      console.error(`\n违规 (${report.violations.length})`);
      for (const message of report.violations) console.error(`  x ${message}`);
    }
    if (report.blockers.length > 0) {
      console.error(`\n未准入 (${report.blockers.length})`);
      for (const message of report.blockers) console.error(`  ! ${message}`);
    }
    const verdict =
      report.exitCode === EXIT.PASS
        ? '通过'
        : report.exitCode === EXIT.VIOLATION
          ? '违规'
          : '未准入';
    console.log(`\n结果: ${verdict}（退出码 ${report.exitCode}）`);
  }
  return flags.report ? EXIT.PASS : report.exitCode;
}

process.exitCode = main(process.argv.slice(2));

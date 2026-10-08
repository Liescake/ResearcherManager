#!/usr/bin/env node
/**
 * RuoYi 来源与合规证据清单检查器（services/ruoyi-api/toolchain/check-provenance.mjs）。
 *
 * 目的：在真实 RuoYi POC 之前，验证候选来源与合规证据（候选 commit/tag、许可证/NOTICE、SBOM、
 * 漏洞扫描、PostgreSQL 兼容性）是否达到 `verified` 且证据文件真实存在；同时保证「声明」不能被
 * 伪造：非 pending 的证据必须给出与磁盘文件实际字节一致的 SHA-256 摘要、必需的内容标记，
 * `verified` 还必须给出核验时间与核验署名。
 *
 * 三类判定互相独立：
 *   1. 违规（退出码 1）：清单结构非法、状态漂移（pending 却已有文件 / present|verified 却无文件）、
 *      摘要或内容标记不匹配、占位摘要、poc-ready 时证据未 verified，或与准入门禁
 *      （同目录 gate-manifest.json）的候选固定值/阶段/合规产物状态不一致；
 *   2. 未就绪（退出码 2）：结构合法且未发现伪造，但证据仍未 verified、候选未冻结或门禁未 admitted；
 *   3. 通过（退出码 0）：五项证据全部 verified 且文件存在、摘要与标记匹配，stage=poc-ready，
 *      候选已冻结，且 gate-manifest.json 已 admitted 且无 pending 合规产物。
 *
 * 边界与保证：
 *   - 只用 `node:` 内置模块；不联网、不安装、不下载任何依赖；
 *   - 只读仓库：不创建、不修改、不移动、不删除仓库内任何文件；清单保持 pending 由人工推进；
 *   - SHA-256 为纯 JavaScript 实现（不导入 node:crypto，也不调用外部命令），用于校验证据文件摘要；
 *   - 默认运行读取磁盘；`--self-test` 只使用合成输入，不读磁盘、不写入任何文件。
 *
 * 用法（可在任意工作目录执行，脚本按自身位置解析同目录清单）：
 *   node check-provenance.mjs
 *   node check-provenance.mjs --json
 *   node check-provenance.mjs --report      # 信息性运行：始终以退出码 0 结束
 *   node check-provenance.mjs --self-test   # 用合成输入验证判定规则与 SHA-256（不读磁盘）
 *
 * 退出码：0 通过；1 违规；2 未就绪（证据待补齐）；64 用法错误。
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/* ------------------------------------------------------------------ *
 * 常量
 * ------------------------------------------------------------------ */

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
const BOUNDARY_ROOT = resolve(MODULE_DIR, '..');
const REPO_ROOT = resolve(BOUNDARY_ROOT, '..', '..');
const MANIFEST_FILE = join(MODULE_DIR, 'provenance-manifest.json');
const GATE_MANIFEST_FILE = join(MODULE_DIR, 'gate-manifest.json');

const CONTRACT_ID = 'ruoyi-provenance-manifest';
const GATE_CONTRACT_ID = 'ruoyi-toolchain-gate';
const STAGES = ['pre-poc', 'poc-ready'];
const POC_STAGE = 'poc-ready';
const GATE_ADMITTED_STAGE = 'admitted';
const EVIDENCE_STATUS = ['pending', 'present', 'verified'];
const EVIDENCE_PATH_PREFIX = 'services/ruoyi-api/';

/** 必需证据：缺少任一项即判清单非法（防止删除证据项使门禁失效）。 */
const REQUIRED_EVIDENCE_IDS = [
  'candidate-commit-tag',
  'license-notice',
  'sbom',
  'vulnerability-scan',
  'postgresql-compatibility',
];

/** 清单不得关闭的强制开关：任何一项缺失或不为 true 都判清单非法。 */
const REQUIRED_POC_GATE_FLAGS = [
  'requireAllEvidenceVerified',
  'requireEvidenceFilesExist',
  'requireDigestMatch',
  'requireContentMarkers',
  'requireAttestation',
  'crossCheckToolchainGate',
  'rejectFabricatedEvidence',
];

const SEMVER = /^\d+\.\d+\.\d+$/;
const FULL_SHA = /^[0-9a-f]{40}$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})?)?$/;
const FABRICATED_REFERENCE =
  /^(latest|head|main|master|dev|develop|trunk|tbd|todo|pending|placeholder|none|null|n\/?a|unknown|sample|dummy|test|fixme|xxx+)$/i;

const EXIT = { PASS: 0, VIOLATION: 1, NOT_READY: 2, USAGE: 64 };

/* ------------------------------------------------------------------ *
 * 基础工具
 * ------------------------------------------------------------------ */

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toPosix(value) {
  return value.split('\\').join('/');
}

function formatValue(value) {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (typeof value === 'string') return `"${value}"`;
  return String(value);
}

function normalizeOptional(value) {
  return value === undefined ? null : value;
}

function isPlaceholderDigest(digest) {
  return new Set(digest).size === 1;
}

/* ------------------------------------------------------------------ *
 * SHA-256（纯 JavaScript；不依赖 node:crypto，也不调用外部命令）
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

function rotr(value, shift) {
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
      const s0 = (rotr(w15, 7) ^ rotr(w15, 18) ^ (w15 >>> 3)) >>> 0;
      const s1 = (rotr(w2, 17) ^ rotr(w2, 19) ^ (w2 >>> 10)) >>> 0;
      schedule[index] = (schedule[index - 16] + s0 + schedule[index - 7] + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, h] = state;
    for (let index = 0; index < 64; index += 1) {
      const sigma1 = (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) >>> 0;
      const choose = ((e & f) ^ (~e & g)) >>> 0;
      const temp1 = (h + sigma1 + choose + SHA256_K[index] + schedule[index]) >>> 0;
      const sigma0 = (rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) >>> 0;
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
 * 检查：清单结构 / 候选固定值 / 准入门禁交叉核验 / 证据 / 阶段闸门
 * ------------------------------------------------------------------ */

function checkManifestShape(manifest, report) {
  if (!isPlainObject(manifest)) {
    report.violations.push('provenance-manifest.json: 内容必须是 JSON 对象（缺失或不可解析）');
    return;
  }
  const fail = (message) => report.violations.push(message);
  if (manifest.contract !== CONTRACT_ID) {
    fail(`provenance-manifest.json: contract 必须为 ${CONTRACT_ID}`);
  }
  if (typeof manifest.manifestVersion !== 'string' || !SEMVER.test(manifest.manifestVersion)) {
    fail('provenance-manifest.json: manifestVersion 必须是 semver（如 0.1.0）');
  }
  if (!STAGES.includes(manifest.stage)) {
    fail(
      `provenance-manifest.json: stage 只能是 ${STAGES.join(' / ')}（当前 ${formatValue(manifest.stage)}）`,
    );
  }
  if (typeof manifest.purpose !== 'string' || manifest.purpose.trim() === '') {
    fail('provenance-manifest.json: purpose 必须是非空字符串');
  }
  if (!isPlainObject(manifest.pocGate)) {
    fail('provenance-manifest.json: pocGate 必须是对象');
  } else {
    const disabled = REQUIRED_POC_GATE_FLAGS.filter((flag) => manifest.pocGate[flag] !== true);
    if (disabled.length > 0) {
      fail(
        `provenance-manifest.json: pocGate 的强制开关必须全部为 true，当前缺失或被关闭：${disabled.join(' / ')}`,
      );
    }
  }
  if (
    !Array.isArray(manifest.nonGoals) ||
    manifest.nonGoals.length === 0 ||
    !manifest.nonGoals.every((item) => typeof item === 'string' && item.trim() !== '')
  ) {
    fail('provenance-manifest.json: nonGoals 必须是非空字符串数组');
  }
  report.summary.manifest = {
    contract: manifest.contract ?? null,
    version: manifest.manifestVersion ?? null,
    stage: manifest.stage ?? null,
  };
}

/** 读取并核验同目录准入门禁清单；不可用时按 fail-closed 判违规。 */
function checkGateLink(gateManifest, gateManifestError, report) {
  const result = { available: false, stage: null, pinned: null, pendingArtifacts: 0 };
  if (gateManifestError) {
    report.violations.push(
      `gate-manifest.json: ${gateManifestError}；准入门禁不可用，来源与合规证据无法与门禁交叉核验，按 fail-closed 判违规`,
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
  }
  const pinned = isPlainObject(gateManifest.candidate?.pinned)
    ? gateManifest.candidate.pinned
    : null;
  if (!pinned) {
    report.violations.push(
      'gate-manifest.json: candidate.pinned 必须是对象（准入门禁的候选固定值缺失，无法交叉核验）',
    );
  }
  const artifacts = Array.isArray(gateManifest.complianceArtifacts)
    ? gateManifest.complianceArtifacts
    : [];
  result.pendingArtifacts = artifacts.filter((entry) => entry?.status === 'pending').length;
  result.available = true;
  result.stage = typeof gateManifest.stage === 'string' ? gateManifest.stage : null;
  result.pinned = pinned;
  report.summary.gate = {
    contract: gateManifest.contract ?? null,
    stage: result.stage,
    pendingArtifacts: result.pendingArtifacts,
    pinned: pinned
      ? {
          tag: normalizeOptional(pinned.tag),
          commit: normalizeOptional(pinned.commit),
          resolved: pinned.resolved === true,
        }
      : null,
  };
  return result;
}

/** 候选 commit/tag 占位必须显式、不可伪造，且必须与准入门禁清单完全一致。 */
function checkCandidate(candidate, gate, report) {
  const result = { commit: null, tag: null, resolved: false };
  if (!isPlainObject(candidate)) {
    report.violations.push('provenance-manifest.json: candidate 必须是对象');
    return result;
  }
  const fail = (message) => report.violations.push(message);
  const commit = candidate.commit;
  const tag = candidate.tag;
  const resolved = candidate.resolved;

  if (commit !== null && !(typeof commit === 'string' && FULL_SHA.test(commit))) {
    fail(
      `provenance-manifest.json: candidate.commit 必须是 40 位小写十六进制 SHA 或显式 null（当前 ${formatValue(commit)}）`,
    );
  }
  if (typeof commit === 'string' && FABRICATED_REFERENCE.test(commit)) {
    fail(`provenance-manifest.json: candidate.commit 不得使用分支名或占位词（当前 ${commit}）`);
  }
  if (tag !== null && !(typeof tag === 'string' && tag.trim() !== '')) {
    fail(
      `provenance-manifest.json: candidate.tag 必须是非空标签字符串或显式 null（当前 ${formatValue(tag)}）`,
    );
  }
  if (typeof tag === 'string' && FABRICATED_REFERENCE.test(tag)) {
    fail(`provenance-manifest.json: candidate.tag 不得使用分支名或占位词（当前 ${tag}）`);
  }
  if (typeof resolved !== 'boolean') {
    fail('provenance-manifest.json: candidate.resolved 必须是布尔值');
  } else if (resolved !== (commit !== null)) {
    fail(
      `provenance-manifest.json: candidate.resolved 必须严格等于 (commit !== null)（当前 resolved=${resolved}, commit=${formatValue(commit)}）`,
    );
  }
  if (typeof commit === 'string' && tag === null) {
    fail('provenance-manifest.json: candidate 固定 commit 时必须同时固定 tag');
  }

  if (gate.available && isPlainObject(gate.pinned)) {
    const same =
      normalizeOptional(gate.pinned.tag) === normalizeOptional(tag) &&
      normalizeOptional(gate.pinned.commit) === normalizeOptional(commit) &&
      (gate.pinned.resolved === true) === (resolved === true);
    if (!same) {
      fail(
        `provenance-manifest.json 与 gate-manifest.json 的候选固定值不一致：来源清单 tag=${formatValue(normalizeOptional(tag))}, commit=${formatValue(normalizeOptional(commit))}, resolved=${resolved === true}；准入门禁 tag=${formatValue(normalizeOptional(gate.pinned.tag))}, commit=${formatValue(normalizeOptional(gate.pinned.commit))}, resolved=${gate.pinned.resolved === true}`,
      );
    }
  }

  result.commit = typeof commit === 'string' ? commit : null;
  result.tag = typeof tag === 'string' ? tag : null;
  result.resolved = resolved === true;
  report.summary.candidate = result;
  return result;
}

function inspectEvidencePath(inspect, relativePath) {
  try {
    const result = inspect(relativePath);
    if (isPlainObject(result)) {
      return {
        exists: result.exists === true,
        bytes: result.bytes instanceof Uint8Array ? result.bytes : null,
        error: typeof result.error === 'string' ? result.error : null,
      };
    }
  } catch {
    // 磁盘检查异常一律按「不可用」处理（fail-closed）
  }
  return { exists: false, bytes: null, error: null };
}

/** 证据项：结构、状态与磁盘事实、摘要、内容标记、核验署名。 */
function checkEvidence(evidence, report, inspect) {
  const byId = new Map();
  const admissibleIds = new Set();
  const items = [];
  const byStatus = { pending: 0, present: 0, verified: 0 };
  if (!Array.isArray(evidence) || evidence.length === 0) {
    report.violations.push('provenance-manifest.json: evidence 必须是非空数组');
    report.summary.evidence = { total: 0, byStatus, admissible: 0, items };
    return { byId, admissibleIds };
  }
  const pathOwners = new Map();
  for (const entry of evidence) {
    if (!isPlainObject(entry)) {
      report.violations.push('evidence 的每一项必须是对象');
      continue;
    }
    const id = typeof entry.id === 'string' && entry.id.trim() !== '' ? entry.id : '(未命名)';
    const item = {
      id,
      status: entry.status,
      path: typeof entry.path === 'string' ? entry.path : null,
      fileExists: false,
      ok: true,
    };
    const fail = (message) => {
      item.ok = false;
      report.violations.push(message);
    };

    if (typeof entry.id !== 'string' || entry.id.trim() === '') {
      fail('evidence 每项必须有非空 id');
    } else if (!REQUIRED_EVIDENCE_IDS.includes(id)) {
      fail(
        `evidence 含未登记的证据 id：${id}（必需 id 固定为 ${REQUIRED_EVIDENCE_IDS.join(' / ')}，不得改名或新增项绕过门禁）`,
      );
    }
    if (byId.has(id)) fail(`evidence 的 id 重复：${id}`);
    if (typeof entry.requirement !== 'string' || entry.requirement.trim() === '') {
      fail(`证据 ${id} 必须有非空 requirement`);
    }
    const markers = entry.requiredMarkers;
    if (
      !Array.isArray(markers) ||
      markers.length === 0 ||
      !markers.every((marker) => typeof marker === 'string' && marker.trim() !== '')
    ) {
      fail(`证据 ${id} 的 requiredMarkers 必须是非空字符串数组（不得清空以弱化内容校验）`);
    }
    if (
      Object.prototype.hasOwnProperty.call(entry, 'howToObtain') &&
      (typeof entry.howToObtain !== 'string' || entry.howToObtain.trim() === '')
    ) {
      fail(`证据 ${id} 的 howToObtain 若存在必须是非空字符串`);
    }

    const posixPath = typeof entry.path === 'string' ? toPosix(entry.path) : '';
    const pathValid =
      typeof entry.path === 'string' &&
      entry.path.trim() !== '' &&
      !isAbsolute(entry.path) &&
      !posixPath.split('/').includes('..') &&
      posixPath.startsWith(EVIDENCE_PATH_PREFIX);
    if (!pathValid) {
      fail(
        `证据 ${id} 的 path 必须是 ${EVIDENCE_PATH_PREFIX} 边界内的仓库相对路径（不得为绝对路径、不得含 ..）`,
      );
    } else if (pathOwners.has(posixPath)) {
      fail(
        `证据 ${id} 与证据 ${pathOwners.get(posixPath)} 共用同一路径 ${posixPath}（不得让一个文件充当多项证据）`,
      );
    } else {
      pathOwners.set(posixPath, id);
    }

    const statusValid = EVIDENCE_STATUS.includes(entry.status);
    if (!statusValid) {
      fail(
        `证据 ${id} 的 status 只能是 ${EVIDENCE_STATUS.join(' / ')}（当前 ${formatValue(entry.status)}）`,
      );
    } else {
      byStatus[entry.status] += 1;
    }

    if (statusValid && pathValid) {
      const file = inspectEvidencePath(inspect, entry.path);
      item.fileExists = file.exists;
      if (entry.status === 'pending' && file.exists) {
        fail(
          `证据 ${id} 标记 pending 但磁盘已存在 ${entry.path}（状态与证据不一致：必须改为 present 或 verified 并补齐摘要、标记与署名）`,
        );
      }
      if (entry.status !== 'pending' && !file.exists) {
        fail(`证据 ${id} 标记 ${entry.status} 但磁盘不存在 ${entry.path}`);
      }
      if (entry.status !== 'pending' && file.exists) {
        if (file.bytes === null) {
          fail(`证据 ${id} 的证据文件不可读（${file.error ?? '未知原因'}）`);
        } else {
          const text = file.bytes.toString('utf8');
          if (file.bytes.length === 0) {
            fail(`证据 ${id} 的证据文件为空（空文件不能作为合规证据）`);
          }
          if (
            typeof entry.method !== 'string' ||
            entry.method.trim() === '' ||
            FABRICATED_REFERENCE.test(entry.method.trim())
          ) {
            fail(`证据 ${id} 标记 ${entry.status} 必须记录非占位的 method（证据收集方式）`);
          }
          const declared = entry.fileSha256;
          if (typeof declared !== 'string' || !SHA256_HEX.test(declared)) {
            fail(
              `证据 ${id} 的 fileSha256 必须是 64 位小写十六进制摘要（当前 ${formatValue(declared)}）`,
            );
          } else if (isPlaceholderDigest(declared)) {
            fail(`证据 ${id} 的 fileSha256 是占位摘要（${declared.slice(0, 8)}…），不得伪造`);
          } else {
            const actual = sha256Hex(file.bytes);
            if (declared !== actual) {
              fail(
                `证据 ${id} 的 fileSha256 与证据文件实际摘要不匹配（声明 ${declared}；实际 ${actual}）`,
              );
            }
          }
          if (Array.isArray(markers)) {
            const missing = markers.filter(
              (marker) => typeof marker === 'string' && marker !== '' && !text.includes(marker),
            );
            if (missing.length > 0) {
              fail(`证据 ${id} 的证据文件缺少必需内容标记：${missing.join(' / ')}`);
            }
          }
        }
      }
      if (entry.status === 'verified') {
        if (typeof entry.collectedAt !== 'string' || !ISO_DATE.test(entry.collectedAt)) {
          fail(`证据 ${id} 标记 verified 必须记录 collectedAt（ISO 日期或时间戳）`);
        }
        if (
          typeof entry.verifiedBy !== 'string' ||
          entry.verifiedBy.trim() === '' ||
          FABRICATED_REFERENCE.test(entry.verifiedBy.trim())
        ) {
          fail(`证据 ${id} 标记 verified 必须记录非占位的 verifiedBy（核验署名）`);
        }
      }
    }

    if (item.status === 'verified' && item.ok && !admissibleIds.has(id)) {
      admissibleIds.add(id);
    }
    if (!byId.has(id)) byId.set(id, item);
    items.push(item);
  }

  const absent = REQUIRED_EVIDENCE_IDS.filter((id) => !byId.has(id));
  if (absent.length > 0) {
    report.violations.push(
      `evidence 缺少必需证据项：${absent.join(' / ')}（必需 id 固定为 ${REQUIRED_EVIDENCE_IDS.join(' / ')}，不得删除以绕过证据门禁）`,
    );
  }
  report.summary.evidence = {
    total: items.length,
    byStatus,
    admissible: admissibleIds.size,
    items,
  };
  return { byId, admissibleIds };
}

/** 真实 POC 闸门：poc-ready 要求全部证据 verified；pre-poc 下未齐备属「未就绪」。 */
function checkStage(manifest, report, evidence, candidate, gate) {
  const stage = isPlainObject(manifest) ? manifest.stage : null;
  const pocReady = stage === POC_STAGE;
  const missing = REQUIRED_EVIDENCE_IDS.filter((id) => !evidence.admissibleIds.has(id));
  const candidateVerified = evidence.admissibleIds.has('candidate-commit-tag');
  const resolved = candidate.resolved === true;

  if (candidateVerified && !resolved) {
    report.violations.push(
      '证据 candidate-commit-tag 已 verified，但 candidate.resolved 仍为 false：必须先冻结 40 位 SHA 与对应 tag，才能声明来源证据已验证',
    );
  }
  if (resolved && !candidateVerified) {
    report.violations.push(
      'candidate.resolved=true，但证据 candidate-commit-tag 未 verified 或证据文件未就位：不得先固定候选再补证据',
    );
  }

  if (pocReady) {
    for (const id of missing) {
      const item = evidence.byId.get(id);
      report.violations.push(
        `stage=poc-ready 要求证据 ${id} 为 verified 且证据文件存在、摘要与内容标记匹配（当前 ${item ? `status=${formatValue(item.status)}` : '未登记'}）`,
      );
    }
    if (!resolved) {
      report.violations.push(
        'stage=poc-ready 要求候选 commit/tag 已冻结（candidate.resolved=true）',
      );
    }
    if (gate.available && gate.stage !== GATE_ADMITTED_STAGE) {
      report.violations.push(
        `stage=poc-ready 要求准入门禁已 admitted（gate-manifest.json stage=${formatValue(gate.stage)}）`,
      );
    }
    if (gate.available && gate.pendingArtifacts > 0) {
      report.violations.push(
        `stage=poc-ready 要求准入门禁的合规产物全部就位（gate-manifest.json 仍有 ${gate.pendingArtifacts} 项 pending）`,
      );
    }
  } else {
    for (const id of REQUIRED_EVIDENCE_IDS) {
      if (evidence.admissibleIds.has(id)) continue;
      const item = evidence.byId.get(id);
      const status = item ? formatValue(item.status) : '未登记';
      const where = item?.path ?? '(未声明路径)';
      const disk = item ? (item.fileExists ? '文件已存在' : '文件尚未创建') : '路径未登记';
      report.blockers.push(`来源证据 ${id} 尚未 verified（当前 ${status}；${where}，${disk}）`);
    }
    if (missing.length === 0) {
      report.blockers.push(
        `五项来源证据均已达 verified，但 stage 仍为 ${formatValue(stage)}：必须人工复核后显式提升为 ${POC_STAGE}，检查器不会自动提升`,
      );
    }
    if (!resolved) {
      report.blockers.push(
        '候选 commit/tag 尚未冻结（candidate.resolved=false）：真实 POC 前必须固定 40 位 SHA 与对应 tag',
      );
    }
    if (gate.available && gate.stage !== GATE_ADMITTED_STAGE) {
      report.blockers.push(
        `准入门禁尚未 admitted（gate-manifest.json stage=${formatValue(gate.stage)}）：证据与工具链全部达标前禁止创建 pom.xml 与 Java 源码`,
      );
    }
  }
  report.summary.stage = {
    stage,
    pocReady,
    admissible: evidence.admissibleIds.size,
    missing: missing.length,
  };
}

/* ------------------------------------------------------------------ *
 * 判定汇总
 * ------------------------------------------------------------------ */

function evaluate(input) {
  const report = { violations: [], blockers: [], summary: {} };
  const manifest = input.manifest;
  if (input.manifestError) {
    report.violations.push(`provenance-manifest.json: ${input.manifestError}`);
  }
  const inspect =
    typeof input.inspectFile === 'function'
      ? input.inspectFile
      : () => ({ exists: false, bytes: null, error: null });

  checkManifestShape(manifest, report);
  const gate = checkGateLink(input.gateManifest, input.gateManifestError ?? null, report);
  const candidate = checkCandidate(
    isPlainObject(manifest) ? manifest.candidate : null,
    gate,
    report,
  );
  const evidence = checkEvidence(
    isPlainObject(manifest) ? manifest.evidence : null,
    report,
    inspect,
  );
  checkStage(manifest, report, evidence, candidate, gate);

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

function formatCounts(counts) {
  const entries = Object.entries(counts ?? {});
  if (entries.length === 0) return '无';
  return entries.map(([status, count]) => `${status} ${count}`).join(' / ');
}

function renderText(report, context) {
  const lines = [];
  lines.push('RuoYi 来源与合规证据清单检查（仅使用 Node 内置模块；不联网、不下载依赖、不写仓库）');
  lines.push(`- 边界根目录: ${context.boundaryRoot}`);
  const manifestSummary = report.summary.manifest;
  lines.push(
    `- 清单: ${context.manifestFile}${
      manifestSummary
        ? `（contract=${manifestSummary.contract}, manifestVersion=${manifestSummary.version}, stage=${manifestSummary.stage}）`
        : '（未能解析）'
    }`,
  );
  const gate = report.summary.gate;
  lines.push(
    `- 准入门禁: ${context.gateManifestFile}${
      gate
        ? `（stage=${gate.stage}，候选 tag=${formatValue(gate.pinned?.tag ?? null)}, commit=${formatValue(gate.pinned?.commit ?? null)}, resolved=${gate.pinned?.resolved === true}；合规产物 pending ${gate.pendingArtifacts} 项）`
        : '（不可用：无法交叉核验）'
    }`,
  );
  const candidate = report.summary.candidate;
  if (candidate) {
    lines.push(
      `- 候选固定: tag=${formatValue(candidate.tag)}, commit=${formatValue(candidate.commit)}, resolved=${candidate.resolved}`,
    );
  }
  const evidence = report.summary.evidence;
  if (evidence) {
    lines.push(
      `- 来源证据: ${evidence.total} 项（${formatCounts(evidence.byStatus)}；verified 达标 ${evidence.admissible}/${REQUIRED_EVIDENCE_IDS.length}）`,
    );
    for (const item of evidence.items) {
      const disk = item.fileExists ? '文件已存在' : '文件尚未创建';
      lines.push(
        `  - ${item.id}: ${formatValue(item.status)}（${disk}）${item.path ?? '(未声明路径)'}`,
      );
    }
  }
  lines.push(
    '- SHA-256: 纯 JavaScript 实现（不导入 node:crypto、不调用外部命令），用于校验证据文件摘要',
  );
  return lines.join('\n');
}

function printUsage() {
  console.log(
    [
      'RuoYi 来源与合规证据清单检查',
      '用法: node check-provenance.mjs [--json] [--report] [--self-test] [--help]',
      '  --json       以 JSON 输出判定结果（机器可读）',
      '  --report     信息性运行：始终以退出码 0 结束',
      '  --self-test  用合成输入验证判定规则与 SHA-256（不读磁盘）',
      '退出码: 0 通过 / 1 违规 / 2 未就绪（证据待补齐） / 64 用法错误',
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

function loadJson(file) {
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch (error) {
    return { value: null, error: `无法读取 ${file}（${error.message}）` };
  }
  try {
    return { value: JSON.parse(text.replace(/^\uFEFF/, '')), error: null };
  } catch (error) {
    return { value: null, error: `${file} JSON 解析失败（${error.message}）` };
  }
}

function inspectRepoFile(relativePath) {
  const absolutePath = resolve(REPO_ROOT, relativePath);
  if (!existsSync(absolutePath)) return { exists: false, bytes: null, error: null };
  try {
    return { exists: true, bytes: readFileSync(absolutePath), error: null };
  } catch (error) {
    return { exists: true, bytes: null, error: error?.code ?? 'unreadable' };
  }
}

/* ------------------------------------------------------------------ *
 * 自检：SHA-256 向量 + 合成输入验证判定规则
 * ------------------------------------------------------------------ */

const SHA_VECTORS = [
  ['', 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'],
  ['abc', 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'],
  [
    'abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq',
    '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1',
  ],
];

const FIXTURE_COMMIT = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4';
const FIXTURE_LICENSE_PATH = 'services/ruoyi-api/compliance/provenance/license-notice.md';
const FIXTURE_SBOM_PATH = 'services/ruoyi-api/compliance/provenance/sbom.cyclonedx.json';
const FIXTURE_VULN_PATH = 'services/ruoyi-api/compliance/provenance/vulnerability-scan.md';

const FIXTURE_EVIDENCE_SPECS = [
  {
    id: 'candidate-commit-tag',
    path: 'services/ruoyi-api/compliance/provenance/candidate-commit-tag.md',
    markers: ['repository:', 'commit:', 'tag:'],
  },
  {
    id: 'license-notice',
    path: FIXTURE_LICENSE_PATH,
    markers: ['spdx-license-identifier:', 'notice:'],
  },
  { id: 'sbom', path: FIXTURE_SBOM_PATH, markers: ['bomFormat', 'components'] },
  { id: 'vulnerability-scan', path: FIXTURE_VULN_PATH, markers: ['scanner:', 'conclusion:'] },
  {
    id: 'postgresql-compatibility',
    path: 'services/ruoyi-api/compliance/provenance/postgresql-compatibility.md',
    markers: ['server-version:', 'rollback:'],
  },
];

function fixtureEvidenceText(markers) {
  return `${markers.map((marker) => `${marker} fixture-value`).join('\n')}\n`;
}

function fixturePocGate() {
  const flags = {};
  for (const flag of REQUIRED_POC_GATE_FLAGS) flags[flag] = true;
  return flags;
}

function fixtureGate(options = {}) {
  const pinned = options.pinned ?? { tag: null, commit: null, resolved: false };
  return {
    contract: options.contract ?? GATE_CONTRACT_ID,
    manifestVersion: '0.1.0',
    stage: options.stage ?? 'pre-poc-gate',
    candidate: { target: {}, pinned },
    admissionPrerequisites: [],
    complianceArtifacts: options.artifacts ?? [],
  };
}

/**
 * 构造合成清单与合成磁盘：status 非 pending 的证据项默认配一份含全部必需标记的文件，
 * 摘要默认等于该文件内容的真实 SHA-256，以便逐项验证「声明必须与磁盘一致」的规则。
 */
function fixtureBundle(options = {}) {
  const statuses = options.statuses ?? {};
  const texts = options.texts ?? {};
  const digests = options.digests ?? {};
  const overrides = options.evidenceOverrides ?? {};
  const files = {};
  const evidence =
    options.evidence ??
    FIXTURE_EVIDENCE_SPECS.map((spec) => {
      const status = statuses[spec.id] ?? 'pending';
      const text = texts[spec.id] ?? fixtureEvidenceText(spec.markers);
      const entry = {
        id: spec.id,
        requirement: `fixture-requirement:${spec.id}`,
        status,
        path: spec.path,
        requiredMarkers: [...spec.markers],
        howToObtain: `fixture-how:${spec.id}`,
      };
      if (status !== 'pending') {
        entry.method = 'fixture-method';
        entry.fileSha256 = digests[spec.id] ?? sha256Hex(text);
        files[spec.path] = text;
        if (status === 'verified') {
          entry.collectedAt = '2026-10-08';
          entry.verifiedBy = 'fixture-verifier';
        }
      }
      return { ...entry, ...(overrides[spec.id] ?? {}) };
    });
  for (const [path, text] of Object.entries(options.extraFiles ?? {})) files[path] = text;
  for (const [path, text] of Object.entries(options.overrideFiles ?? {})) files[path] = text;
  for (const path of options.removeFiles ?? []) delete files[path];

  const manifest = {
    contract: options.contract ?? CONTRACT_ID,
    manifestVersion: options.manifestVersion ?? '0.1.0',
    stage: options.stage ?? 'pre-poc',
    purpose: 'fixture-purpose',
    pocGate: { ...fixturePocGate(), ...(options.pocGate ?? {}) },
    candidate: {
      project: 'RuoYi-Vue',
      line: 'spring-boot-3',
      tag: null,
      commit: null,
      resolved: false,
      ...(options.candidate ?? {}),
    },
    evidence,
    nonGoals: ['fixture-non-goal'],
  };
  return { manifest, files };
}

/** 合成磁盘：值为字符串表示普通文件，值为 null 表示存在但不可读。 */
function fixtureInspector(files) {
  return (relativePath) => {
    if (!Object.prototype.hasOwnProperty.call(files, relativePath)) {
      return { exists: false, bytes: null, error: null };
    }
    const text = files[relativePath];
    if (text === null) return { exists: true, bytes: null, error: 'EISDIR' };
    return { exists: true, bytes: Buffer.from(text, 'utf8'), error: null };
  };
}

function runSelfTestScenario(scenario) {
  const bundle =
    scenario.manifest !== undefined
      ? { manifest: scenario.manifest, files: scenario.files ?? {} }
      : fixtureBundle(scenario);
  const gate =
    scenario.gateManifest !== undefined ? scenario.gateManifest : fixtureGate(scenario.gate ?? {});
  const report = evaluate({
    manifest: bundle.manifest,
    manifestError: scenario.manifestError ?? null,
    gateManifest: gate,
    gateManifestError: scenario.gateManifestError ?? null,
    inspectFile: fixtureInspector(bundle.files),
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
  console.log('RuoYi 来源与合规证据清单自检（合成输入；不读磁盘、不执行任何命令）');
  let failed = 0;

  for (const [input, expected] of SHA_VECTORS) {
    const actual = sha256Hex(input);
    if (actual === expected) {
      console.log(`  ok SHA-256("${input.slice(0, 20)}")=${actual}`);
      continue;
    }
    failed += 1;
    console.error(`  x SHA-256("${input.slice(0, 20)}") 期望 ${expected}，实际 ${actual}`);
  }

  const allPending = fixtureBundle().manifest.evidence;
  const allVerified = {};
  for (const spec of FIXTURE_EVIDENCE_SPECS) allVerified[spec.id] = 'verified';
  const greenCandidate = { tag: 'v3.9.2', commit: FIXTURE_COMMIT, resolved: true };
  const greenGate = {
    stage: 'admitted',
    pinned: greenCandidate,
    artifacts: [
      { id: 'license', path: 'services/ruoyi-api/compliance/LICENSE', status: 'verified' },
    ],
  };

  const scenarios = [
    {
      name: '当前状态：五项证据 pending、证据文件不存在 → 未就绪',
      expectCode: 2,
      expect: ['尚未 verified', 'candidate-commit-tag'],
    },
    {
      name: '五项 verified + 文件存在 + 摘要与标记匹配 + 门禁 admitted → 通过',
      statuses: allVerified,
      stage: 'poc-ready',
      candidate: greenCandidate,
      gate: greenGate,
      expectCode: 0,
    },
    {
      name: '证据齐备但 stage 仍为 pre-poc',
      statuses: allVerified,
      candidate: greenCandidate,
      gate: { pinned: greenCandidate },
      expectCode: 2,
      expect: ['显式提升'],
    },
    {
      name: 'stage=poc-ready 但证据仍 pending',
      stage: 'poc-ready',
      expectCode: 1,
      expect: ['poc-ready'],
    },
    {
      name: '证据标记 verified 但磁盘不存在',
      statuses: { sbom: 'verified' },
      removeFiles: [FIXTURE_SBOM_PATH],
      expectCode: 1,
      expect: ['磁盘不存在'],
    },
    {
      name: '证据标记 pending 但磁盘已存在',
      extraFiles: { [FIXTURE_LICENSE_PATH]: 'spdx-license-identifier: fixture\nnotice: fixture\n' },
      expectCode: 1,
      expect: ['状态与证据不一致'],
    },
    {
      name: '摘要与证据文件实际内容不匹配',
      statuses: { sbom: 'verified' },
      digests: { sbom: `${'0'.repeat(63)}1` },
      expectCode: 1,
      expect: ['摘要不匹配'],
    },
    {
      name: '摘要格式非法（非 64 位十六进制）',
      statuses: { sbom: 'verified' },
      digests: { sbom: 'tbd' },
      expectCode: 1,
      expect: ['64 位小写十六进制'],
    },
    {
      name: '摘要为占位（全 0）',
      statuses: { sbom: 'verified' },
      digests: { sbom: '0'.repeat(64) },
      expectCode: 1,
      expect: ['占位摘要'],
    },
    {
      name: '证据文件缺少必需内容标记',
      statuses: { 'vulnerability-scan': 'verified' },
      texts: { 'vulnerability-scan': 'scanner: fixture-value\n' },
      expectCode: 1,
      expect: ['缺少必需内容标记', 'conclusion:'],
    },
    {
      name: '证据文件为空',
      statuses: { sbom: 'verified' },
      texts: { sbom: '' },
      expectCode: 1,
      expect: ['证据文件为空'],
    },
    {
      name: '证据文件存在但不可读',
      statuses: { sbom: 'verified' },
      overrideFiles: { [FIXTURE_SBOM_PATH]: null },
      expectCode: 1,
      expect: ['不可读'],
    },
    {
      name: 'verified 缺少 collectedAt',
      statuses: { sbom: 'verified' },
      evidenceOverrides: { sbom: { collectedAt: undefined } },
      expectCode: 1,
      expect: ['collectedAt'],
    },
    {
      name: 'verified 缺少 verifiedBy',
      statuses: { sbom: 'verified' },
      evidenceOverrides: { sbom: { verifiedBy: undefined } },
      expectCode: 1,
      expect: ['verifiedBy'],
    },
    {
      name: 'verifiedBy 为占位词',
      statuses: { sbom: 'verified' },
      evidenceOverrides: { sbom: { verifiedBy: 'TBD' } },
      expectCode: 1,
      expect: ['verifiedBy'],
    },
    {
      name: 'method 为占位词',
      statuses: { sbom: 'verified' },
      evidenceOverrides: { sbom: { method: 'placeholder' } },
      expectCode: 1,
      expect: ['method'],
    },
    {
      name: '缺少必需证据项',
      evidence: allPending.filter((item) => item.id !== 'sbom'),
      expectCode: 1,
      expect: ['缺少必需证据项', 'sbom'],
    },
    {
      name: '出现未登记的证据 id',
      evidence: [
        ...allPending,
        { id: 'extra-proof', requirement: 'fixture', status: 'pending', path: FIXTURE_SBOM_PATH },
      ],
      expectCode: 1,
      expect: ['未登记的证据 id'],
    },
    {
      name: '证据 id 重复',
      evidence: [...allPending, allPending[0]],
      expectCode: 1,
      expect: ['id 重复'],
    },
    {
      name: '证据路径为绝对路径',
      evidenceOverrides: { 'license-notice': { path: 'C:/tmp/license-notice.md' } },
      expectCode: 1,
      expect: ['边界内'],
    },
    {
      name: '证据路径包含 ..',
      evidenceOverrides: { sbom: { path: 'services/ruoyi-api/../compliance/sbom.json' } },
      expectCode: 1,
      expect: ['不得含 ..'],
    },
    {
      name: '证据路径越出 services/ruoyi-api 边界',
      evidenceOverrides: { sbom: { path: 'contracts/sbom.cyclonedx.json' } },
      expectCode: 1,
      expect: ['边界内'],
    },
    {
      name: '两项证据共用同一路径',
      evidenceOverrides: { sbom: { path: FIXTURE_LICENSE_PATH } },
      expectCode: 1,
      expect: ['共用同一路径'],
    },
    {
      name: '证据状态非法',
      evidenceOverrides: { sbom: { status: 'ok' } },
      expectCode: 1,
      expect: ['status'],
    },
    {
      name: 'requiredMarkers 被清空',
      evidenceOverrides: { sbom: { requiredMarkers: [] } },
      expectCode: 1,
      expect: ['requiredMarkers'],
    },
    {
      name: 'howToObtain 为空字符串',
      evidenceOverrides: { sbom: { howToObtain: '   ' } },
      expectCode: 1,
      expect: ['howToObtain'],
    },
    {
      name: '证据项不是对象',
      evidence: [...allPending, 'sbom'],
      expectCode: 1,
      expect: ['每一项必须是对象'],
    },
    {
      name: 'evidence 为空数组',
      manifest: { ...fixtureBundle().manifest, evidence: [] },
      expectCode: 1,
      expect: ['非空数组'],
    },
    {
      name: 'pocGate 强制开关被关闭',
      pocGate: { requireDigestMatch: false },
      expectCode: 1,
      expect: ['强制开关'],
    },
    {
      name: 'stage 取值非法',
      stage: 'verified',
      expectCode: 1,
      expect: ['stage'],
    },
    {
      name: 'manifestVersion 非 semver',
      manifestVersion: 'v1',
      expectCode: 1,
      expect: ['semver'],
    },
    {
      name: 'contract 不匹配',
      contract: 'ruoyi-provenance',
      expectCode: 1,
      expect: ['contract'],
    },
    {
      name: 'purpose 为空',
      manifest: { ...fixtureBundle().manifest, purpose: '' },
      expectCode: 1,
      expect: ['purpose'],
    },
    {
      name: 'nonGoals 被清空',
      manifest: { ...fixtureBundle().manifest, nonGoals: [] },
      expectCode: 1,
      expect: ['nonGoals'],
    },
    {
      name: '候选 commit 为短 SHA',
      candidate: { tag: 'v3.9.2', commit: '0e2d75c', resolved: true },
      gate: { pinned: { tag: 'v3.9.2', commit: '0e2d75c', resolved: true } },
      expectCode: 1,
      expect: ['40 位'],
    },
    {
      name: '候选 commit 伪造为分支名',
      candidate: { tag: 'v3.9.2', commit: 'main', resolved: true },
      gate: { pinned: { tag: 'v3.9.2', commit: 'main', resolved: true } },
      expectCode: 1,
      expect: ['40 位'],
    },
    {
      name: 'candidate.resolved 与 commit 不一致',
      candidate: { tag: null, commit: null, resolved: true },
      gate: { pinned: { tag: null, commit: null, resolved: true } },
      expectCode: 1,
      expect: ['resolved 必须严格等于'],
    },
    {
      name: '固定 commit 未同时固定 tag',
      candidate: { tag: null, commit: FIXTURE_COMMIT, resolved: true },
      gate: { pinned: { tag: null, commit: FIXTURE_COMMIT, resolved: true } },
      expectCode: 1,
      expect: ['必须同时固定 tag'],
    },
    {
      name: '与 gate-manifest.json 的候选固定值不一致',
      candidate: { tag: 'v9.9.9', commit: FIXTURE_COMMIT, resolved: true },
      gate: greenGate,
      expectCode: 1,
      expect: ['候选固定值不一致'],
    },
    {
      name: '候选未冻结但来源证据已 verified',
      statuses: { 'candidate-commit-tag': 'verified' },
      expectCode: 1,
      expect: ['candidate-commit-tag'],
    },
    {
      name: '候选已冻结但来源证据未 verified',
      candidate: greenCandidate,
      gate: { pinned: greenCandidate },
      expectCode: 1,
      expect: ['不得先固定候选再补证据'],
    },
    {
      name: 'stage=poc-ready 但准入门禁仍 pre-poc-gate',
      statuses: allVerified,
      stage: 'poc-ready',
      candidate: greenCandidate,
      gate: { stage: 'pre-poc-gate', pinned: greenCandidate },
      expectCode: 1,
      expect: ['admitted'],
    },
    {
      name: 'stage=poc-ready 且门禁合规产物仍 pending',
      statuses: allVerified,
      stage: 'poc-ready',
      candidate: greenCandidate,
      gate: {
        stage: 'admitted',
        pinned: greenCandidate,
        artifacts: [{ id: 'license', path: FIXTURE_LICENSE_PATH, status: 'pending' }],
      },
      expectCode: 1,
      expect: ['合规产物'],
    },
    {
      name: 'gate-manifest.json 不可读（fail-closed）',
      gateManifestError: '无法读取 gate-manifest.json（fixture）',
      expectCode: 1,
      expect: ['fail-closed'],
    },
    {
      name: 'gate-manifest.json contract 不匹配',
      gate: { contract: 'ruoyi-gate' },
      expectCode: 1,
      expect: ['ruoyi-toolchain-gate'],
    },
    {
      name: 'gate-manifest.json 缺少 candidate.pinned',
      gateManifest: { ...fixtureGate(), candidate: {} },
      expectCode: 1,
      expect: ['candidate.pinned'],
    },
    {
      name: '清单缺失或不可解析',
      manifest: null,
      manifestError: 'JSON 解析失败（fixture）',
      expectCode: 1,
      expect: ['provenance-manifest.json'],
    },
    {
      name: '证据 status=present + 文件已就位 → 结构合法但未就绪',
      statuses: { sbom: 'present' },
      expectCode: 2,
      expect: ['尚未 verified', 'present'],
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
    for (const message of [...result.report.violations, ...result.report.blockers].slice(0, 4)) {
      console.error(`      - ${message}`);
    }
  }

  const total = scenarios.length + SHA_VECTORS.length;
  console.log(
    `\n自检: ${total - failed}/${total} 通过（含 ${SHA_VECTORS.length} 项 SHA-256 向量）`,
  );
  return failed === 0 ? EXIT.PASS : EXIT.VIOLATION;
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

  const loaded = loadJson(MANIFEST_FILE);
  const gateLoaded = loadJson(GATE_MANIFEST_FILE);
  const report = evaluate({
    manifest: loaded.value,
    manifestError: loaded.error,
    gateManifest: gateLoaded.value,
    gateManifestError: gateLoaded.error,
    inspectFile: inspectRepoFile,
  });
  const context = {
    boundaryRoot: BOUNDARY_ROOT,
    repoRoot: REPO_ROOT,
    manifestFile: MANIFEST_FILE,
    gateManifestFile: GATE_MANIFEST_FILE,
    mode: flags.report ? 'report' : 'check',
  };

  if (flags.json) {
    console.log(JSON.stringify({ ...report, context, exitCode: report.exitCode }, null, 2));
  } else {
    console.log(renderText(report, context));
    if (report.violations.length > 0) {
      console.error(`\n违规 (${report.violations.length})`);
      for (const message of report.violations) console.error(`  x ${message}`);
    }
    if (report.blockers.length > 0) {
      console.error(`\n未就绪 (${report.blockers.length})`);
      for (const message of report.blockers) console.error(`  ! ${message}`);
    }
    const verdict =
      report.exitCode === EXIT.PASS
        ? '通过'
        : report.exitCode === EXIT.VIOLATION
          ? '违规'
          : '未就绪（证据待补齐）';
    console.log(`\n结果: ${verdict}（退出码 ${report.exitCode}）`);
  }
  return flags.report ? EXIT.PASS : report.exitCode;
}

process.exitCode = main(process.argv.slice(2));

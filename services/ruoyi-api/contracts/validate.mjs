#!/usr/bin/env node
/**
 * RuoYi 公开契约（services/ruoyi-api/contracts）静态校验器。
 *
 * 目的：在提交前对公开契约做**结构与授权场景**门禁，不依赖任何第三方包，也不联网、不写文件：
 *   1. `authz-fixtures.json`：JSON 解析、顶层字段、枚举快照一致性、逐条夹具结构，
 *      并以内置参考执行器逐条重放授权场景；
 *   2. `health.openapi.yaml`：必要字段、路径/操作、信封 required、`$ref` 可解析；
 *   3. 两个契约的版本与边界声明保持一致（`x-boundary`）。
 *
 * 边界：
 *   - 本脚本只用 `node:` 内置模块；YAML 只解析本契约使用的缩进式子集
 *     （块映射、块序列、字面量块、引号标量、JSON 兼容流式集合），
 *     遇到不支持的写法（制表符缩进、锚点/别名/标签、跨行流式集合、多文档）
 *     直接判定失败，而不是静默按「宽松」处理（fail-closed）。
 *   - 授权场景重放使用**内置参考执行器**（镜像 packages/shared/src/enums/authorization.ts
 *     的判定语义）：它只是把夹具断言到文档语义的静态断言目标，不是第二事实来源——本目录
 *     的 enums 快照会与 packages/shared/src/enums/permission.ts 交叉核对，任何漂移都会失败。
 *     与基线共享包（packages/shared/dist/index.js）的独立谓词回归见 README §7.4。
 *
 * 用法（可在任意工作目录执行，脚本按自身位置解析同目录契约文件）：
 *   node validate.mjs
 *   node services/ruoyi-api/contracts/validate.mjs
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const contractDir = dirname(fileURLToPath(import.meta.url));
const FIXTURES_FILE = join(contractDir, 'authz-fixtures.json');
const OPENAPI_FILE = join(contractDir, 'health.openapi.yaml');

const SEMVER = /^\d+\.\d+\.\d+$/;
const REQUIRED_PATHS = ['/health', '/health/ready'];
const ENVELOPE_FIELDS = ['data', 'meta', 'error'];

/**
 * 冻结快照：镜像 packages/shared/src/enums/permission.ts。
 * 它只是本校验器的断言目标（契约锁），不是第二事实来源——运行时会与
 * permission.ts 派生出的权限目录交叉核对，任何漂移都会导致失败。
 */
const REGISTERED_ROLES = ['student', 'group_leader', 'admin', 'system_admin', 'super_admin'];

const REGISTERED_SCOPES = ['SELF', 'GROUP', 'ASSIGNED', 'GLOBAL', 'SYSTEM'];

const ROLE_DEFAULT_SCOPE = {
  student: 'SELF',
  group_leader: 'GROUP',
  admin: 'ASSIGNED',
  system_admin: 'SYSTEM',
  super_admin: 'GLOBAL',
};

const PERMISSION_REGISTRY = [
  'profile:self:read',
  'profile:self:update',
  'profile:admin:read',
  'profile:admin:correct',
  'group:read:open',
  'group:manage',
  'membership:self:create',
  'membership:self:withdraw',
  'membership:review:group',
  'membership:review:global',
  'achievement:self:create',
  'achievement:self:update',
  'achievement:self:read',
  'achievement:review',
  'education:self:create',
  'education:self:update',
  'education:self:read',
  'education:review',
  'matching:self:request',
  'matching:records:read',
  'statistics:flow:read',
  'statistics:achievement:read',
  'statistics:education:read',
  'export:profile:create',
  'export:profile:download',
  'export:achievement:create',
  'export:achievement:download',
  'export:education:create',
  'export:education:download',
  'export:statistics:create',
  'export:statistics:download',
  'announcement:manage',
  'user:manage',
  'role:assign',
  'permission:configure',
  'audit:read',
];

const GRANT_RESTRICTED_PERMISSIONS = ['role:assign', 'permission:configure'];

/** 镜像 DEFAULT_ROLE_PERMISSIONS；super_admin 为「全部业务权限 − role:assign」。 */
const ROLE_PERMISSIONS = {
  student: [
    'profile:self:read',
    'profile:self:update',
    'group:read:open',
    'membership:self:create',
    'membership:self:withdraw',
    'achievement:self:create',
    'achievement:self:update',
    'achievement:self:read',
    'education:self:create',
    'education:self:update',
    'education:self:read',
    'matching:self:request',
  ],
  group_leader: [
    'profile:self:read',
    'profile:self:update',
    'profile:admin:read',
    'group:read:open',
    'membership:review:group',
    'achievement:self:read',
    'achievement:review',
    'education:self:read',
    'education:review',
    'statistics:flow:read',
    'statistics:achievement:read',
    'statistics:education:read',
    'matching:self:request',
  ],
  admin: [
    'profile:self:read',
    'profile:self:update',
    'profile:admin:read',
    'group:read:open',
    'matching:self:request',
  ],
  system_admin: [
    'profile:self:read',
    'profile:self:update',
    'group:read:open',
    'user:manage',
    'permission:configure',
    'audit:read',
  ],
  super_admin: PERMISSION_REGISTRY.filter((permission) => permission !== 'role:assign'),
};

const ROLE_SET = new Set(REGISTERED_ROLES);
const SCOPE_SET = new Set(REGISTERED_SCOPES);
const PERMISSION_SET = new Set(PERMISSION_REGISTRY);
const RESTRICTED_SET = new Set(GRANT_RESTRICTED_PERMISSIONS);

/** 判定输入字段白名单：客户端声明只允许出现在 clientClaims。 */
const SUBJECT_KEYS = ['userId', 'roles', 'groupIds', 'assignedResourceIds'];
const REQUEST_KEYS = ['permission', 'scope', 'groupId', 'resourceUserId', 'assignedResourceIds'];
const GRANT_KEYS = ['targetUserId', ...REQUEST_KEYS];
const CLIENT_CLAIM_KEYS = [
  'role',
  'roles',
  'scope',
  'groupId',
  'groupIds',
  'userId',
  'permission',
  'assignedResourceIds',
];

/** expect.deniedBy 只是定位标签（不参与断言）；未登记标签只提示，不判失败。 */
const DENIED_BY_LABELS = new Set([
  'actor-not-configurator',
  'groupId-not-owned',
  'invalid-request',
  'invalid-subject',
  'missing-group-id',
  'no-role-match',
  'permission-not-in-role',
  'resource-not-assigned',
  'restricted-permission',
  'scope-above-actor',
  'scope-role-mismatch',
  'scope-self-not-owner',
  'unlisted-permission',
  'unlisted-role',
  'unlisted-scope',
]);

/** README §5 要求覆盖的负向场景：必须至少有一条对应的拒绝用例。 */
const REQUIRED_NEGATIVE_TAGS = new Map([
  ['cross-user', '学生访问他人 SELF 资源'],
  ['cross-group', '负责人访问非所属 GROUP'],
  ['cross-resource', '普通管理员访问未分配的 ASSIGNED 资源'],
  ['forged-client-claim', '客户端伪造 scope/groupId/role'],
  ['unlisted-permission', '未登记权限或通配权限'],
  ['restricted-permission', 'role:assign / permission:configure 的非法授予'],
  ['scope-escalation', '越过角色默认范围的请求或授权'],
  ['unlisted-role', '未登记角色'],
  ['unlisted-scope', '未登记数据范围'],
  ['actor-not-configurator', '不具配置资格的主体执行授权配置'],
  ['fail-closed', '缺少服务端解析信息时默认拒绝'],
]);

/** `clientClaims` 与解析字段的对应关系（用于证明声明确实与服务端结果不同）。 */
const CLAIM_TARGETS = [
  { claim: 'role', holder: 'subject', field: 'roles', many: true },
  { claim: 'roles', holder: 'subject', field: 'roles' },
  { claim: 'userId', holder: 'subject', field: 'userId' },
  { claim: 'groupIds', holder: 'subject', field: 'groupIds' },
  { claim: 'assignedResourceIds', holder: 'subject', field: 'assignedResourceIds' },
  { claim: 'scope', holder: 'request', field: 'scope' },
  { claim: 'groupId', holder: 'request', field: 'groupId' },
  { claim: 'permission', holder: 'request', field: 'permission' },
];

const PERMISSION_SOURCE_FILE = join(
  contractDir,
  '..',
  '..',
  '..',
  'packages',
  'shared',
  'src',
  'enums',
  'permission.ts',
);

const issues = [];
const warnings = [];
let checkCount = 0;
const stats = {
  authorize: 0,
  grant: 0,
  refs: 0,
  paths: [],
  scenarios: 0,
  unregistered: 0,
  negativeTags: new Set(),
  permissionSource: false,
};

function expect(condition, message) {
  checkCount += 1;
  if (!condition) {
    issues.push(message);
  }
  return Boolean(condition);
}

function warn(message) {
  warnings.push(message);
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function expectString(value, label, { allowEmpty = false } = {}) {
  const ok = typeof value === 'string' && (allowEmpty || value.length > 0);
  return expect(ok, `${label} 必须为${allowEmpty ? '字符串' : '非空字符串'}`);
}

function expectStringArray(value, label, { allowEmpty = true, unique = false } = {}) {
  if (!expect(Array.isArray(value), `${label} 必须是数组`)) {
    return false;
  }
  let ok = expect(
    value.every((item) => typeof item === 'string' && item.length > 0),
    `${label} 的元素必须都是非空字符串`,
  );
  if (!allowEmpty) {
    ok = expect(value.length > 0, `${label} 不得为空数组`) && ok;
  }
  if (unique) {
    ok = expect(new Set(value).size === value.length, `${label} 的元素不得重复`) && ok;
  }
  return ok;
}

/* ------------------------------------------------------------------ *
 * 无依赖 YAML 子集解析器（fail-closed：不支持的写法直接报错）
 * ------------------------------------------------------------------ */

class ContractError extends Error {}

function stripComment(text) {
  let quote = null;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quote) {
      if (quote === '"' && char === '\\') {
        index += 1;
        continue;
      }
      if (char === quote) {
        quote = null;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === '#' && (index === 0 || /\s/.test(text[index - 1]))) {
      return text.slice(0, index);
    }
  }
  return text;
}

function isBlockScalarIndicator(text) {
  return /^[|>][+-]?\d?$/.test(text);
}

function isFlowCollection(text) {
  return text.startsWith('[') || text.startsWith('{');
}

/**
 * 拆出 `key: rest`；不构成映射行时返回 null。
 */
function splitKey(text) {
  if (text.startsWith('"') || text.startsWith("'")) {
    const quote = text[0];
    let index = 1;
    let key = '';
    while (index < text.length) {
      const char = text[index];
      if (quote === '"' && char === '\\') {
        key += text[index + 1] ?? '';
        index += 2;
        continue;
      }
      if (char === quote) {
        index += 1;
        break;
      }
      key += char;
      index += 1;
    }
    if (text[index] !== ':') {
      return null;
    }
    return { key, rest: text.slice(index + 1).trim() };
  }
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] !== ':') {
      continue;
    }
    const next = text[index + 1];
    if (next === undefined || next === ' ') {
      const key = text.slice(0, index).trim();
      if (key === '' || /\s/.test(key)) {
        return null;
      }
      return { key, rest: text.slice(index + 1).trim() };
    }
  }
  return null;
}

function parseYamlSubset(text, label) {
  const lines = text
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/)
    .map((raw, index) => {
      const indentText = raw.match(/^[ \t]*/)[0];
      if (indentText.includes('\t')) {
        throw new ContractError(
          `${label}:${index + 1}: 缩进不得使用制表符（本校验器只支持空格缩进）`,
        );
      }
      return {
        lineNo: index + 1,
        raw,
        indent: indentText.length,
        content: stripComment(raw.slice(indentText.length)).trimEnd(),
      };
    });

  let cursor = 0;

  function skipBlank() {
    while (cursor < lines.length && lines[cursor].content === '') {
      cursor += 1;
    }
  }

  function peekLine() {
    let index = cursor;
    while (index < lines.length && lines[index].content === '') {
      index += 1;
    }
    return index < lines.length ? lines[index] : null;
  }

  /** 读取 `|` / `>` 块标量：收集比 key 更深缩进的原始行。 */
  function readBlockScalar(keyIndent, lineNo) {
    const collected = [];
    let blockIndent = null;
    let index = cursor;
    while (index < lines.length) {
      const line = lines[index];
      if (line.content === '') {
        collected.push('');
        index += 1;
        continue;
      }
      if (line.indent <= keyIndent) {
        break;
      }
      if (blockIndent === null) {
        blockIndent = line.indent;
      }
      collected.push(line.raw.slice(blockIndent));
      index += 1;
    }
    cursor = index;
    while (collected.length > 0 && collected[collected.length - 1] === '') {
      collected.pop();
    }
    if (blockIndent === null) {
      throw new ContractError(`${label}:${lineNo}: 块标量缺少内容行`);
    }
    return collected.join('\n');
  }

  function parseScalar(text, lineNo) {
    if (text === '' || text === 'null' || text === '~') {
      return null;
    }
    if (text === 'true') {
      return true;
    }
    if (text === 'false') {
      return false;
    }
    if (/^-?\d+$/.test(text) || /^-?\d+\.\d+$/.test(text)) {
      return Number(text);
    }
    if (text.startsWith('"')) {
      try {
        return JSON.parse(text);
      } catch {
        throw new ContractError(`${label}:${lineNo}: 双引号标量不是合法 JSON 字符串: ${text}`);
      }
    }
    if (text.startsWith("'")) {
      if (!text.endsWith("'") || text.length < 2) {
        throw new ContractError(`${label}:${lineNo}: 单引号标量未正确闭合: ${text}`);
      }
      return text.slice(1, -1).replace(/''/g, "'");
    }
    if (/^[&*!]/.test(text)) {
      throw new ContractError(`${label}:${lineNo}: 不支持锚点/别名/标签写法: ${text}`);
    }
    return text;
  }

  function parseInline(text, lineNo) {
    if (isFlowCollection(text)) {
      try {
        return JSON.parse(text);
      } catch {
        throw new ContractError(
          `${label}:${lineNo}: 流式集合只支持 JSON 兼容写法（空集合或全引号），收到: ${text}`,
        );
      }
    }
    return parseScalar(text, lineNo);
  }

  function parseKeyedValue(rest, keyIndent, lineNo) {
    if (rest === '') {
      const next = peekLine();
      if (next && next.indent > keyIndent) {
        return parseBlock(next.indent);
      }
      if (
        next &&
        next.indent === keyIndent &&
        (next.content === '-' || next.content.startsWith('- '))
      ) {
        return parseSequence(keyIndent);
      }
      return null;
    }
    if (isBlockScalarIndicator(rest)) {
      return readBlockScalar(keyIndent, lineNo);
    }
    return parseInline(rest, lineNo);
  }

  function parseMapping(indent) {
    const result = {};
    for (;;) {
      skipBlank();
      if (cursor >= lines.length) {
        break;
      }
      const line = lines[cursor];
      if (line.indent < indent || line.content === '-' || line.content.startsWith('- ')) {
        break;
      }
      if (line.indent > indent) {
        throw new ContractError(`${label}:${line.lineNo}: 意外的缩进层级（期望 ${indent}）`);
      }
      const split = splitKey(line.content);
      if (!split) {
        throw new ContractError(`${label}:${line.lineNo}: 无法解析的映射行: ${line.content}`);
      }
      if (hasOwn(result, split.key)) {
        throw new ContractError(`${label}:${line.lineNo}: 重复键 ${split.key}`);
      }
      cursor += 1;
      result[split.key] = parseKeyedValue(split.rest, indent, line.lineNo);
    }
    return result;
  }

  function parseSequence(indent) {
    const items = [];
    for (;;) {
      skipBlank();
      if (cursor >= lines.length) {
        break;
      }
      const line = lines[cursor];
      if (line.indent !== indent) {
        if (line.indent > indent) {
          throw new ContractError(`${label}:${line.lineNo}: 序列项缩进不一致（期望 ${indent}）`);
        }
        break;
      }
      if (line.content !== '-' && !line.content.startsWith('- ')) {
        break;
      }
      const rest = line.content === '-' ? '' : line.content.slice(2).trim();
      cursor += 1;
      const itemIndent = indent + 2;
      if (rest === '') {
        const next = peekLine();
        items.push(next && next.indent > indent ? parseBlock(next.indent) : null);
        continue;
      }
      if (isBlockScalarIndicator(rest)) {
        items.push(readBlockScalar(indent, line.lineNo));
        continue;
      }
      const split = splitKey(rest);
      if (!split) {
        items.push(parseInline(rest, line.lineNo));
        continue;
      }
      const item = {};
      item[split.key] = parseKeyedValue(split.rest, itemIndent, line.lineNo);
      const next = peekLine();
      const nextIsSequenceItem = next && (next.content === '-' || next.content.startsWith('- '));
      if (next && next.indent === itemIndent && !nextIsSequenceItem) {
        Object.assign(item, parseMapping(itemIndent));
      } else if (next && next.indent > itemIndent) {
        throw new ContractError(`${label}:${next.lineNo}: 不支持的序列项嵌套结构`);
      }
      items.push(item);
    }
    return items;
  }

  function parseBlock(indent) {
    skipBlank();
    if (cursor >= lines.length) {
      throw new ContractError(`${label}: 内容在预期位置提前结束`);
    }
    const line = lines[cursor];
    if (line.indent !== indent) {
      throw new ContractError(`${label}:${line.lineNo}: 缩进与上层不一致（期望 ${indent}）`);
    }
    if (line.content === '-' || line.content.startsWith('- ')) {
      return parseSequence(indent);
    }
    return parseMapping(indent);
  }

  skipBlank();
  if (cursor >= lines.length) {
    throw new ContractError(`${label}: 文件为空`);
  }
  if (lines[cursor].indent !== 0) {
    throw new ContractError(`${label}:${lines[cursor].lineNo}: 顶层内容必须从第 1 列开始`);
  }
  const document = parseBlock(0);
  skipBlank();
  if (cursor < lines.length) {
    throw new ContractError(`${label}:${lines[cursor].lineNo}: 存在多余内容（不支持多文档 YAML）`);
  }
  return document;
}

/* ------------------------------------------------------------------ *
 * authz-fixtures.json 结构校验
 * ------------------------------------------------------------------ */

function checkFixtureKeys(fixture, label, allowedKeys) {
  const unknown = Object.keys(fixture).filter((key) => !allowedKeys.includes(key));
  expect(unknown.length === 0, `${label}: 出现契约未允许的字段: ${unknown.join(', ')}`);
  if (hasOwn(fixture, 'title')) {
    expectString(fixture.title, `${label}.title`);
  }
  if (hasOwn(fixture, 'tags')) {
    expectStringArray(fixture.tags, `${label}.tags`, { allowEmpty: false });
  }
  if (hasOwn(fixture, 'rationale')) {
    expectString(fixture.rationale, `${label}.rationale`);
  }
  if (hasOwn(fixture, 'clientClaims')) {
    expect(isPlainObject(fixture.clientClaims), `${label}.clientClaims 必须是对象`);
  }
}

function checkExpectation(fixture, label) {
  if (!expect(isPlainObject(fixture.expect), `${label}.expect 必须是对象`)) {
    return;
  }
  expect(typeof fixture.expect.allowed === 'boolean', `${label}.expect.allowed 必须是布尔值`);
  if (fixture.expect.allowed === false) {
    expectString(fixture.expect.deniedBy, `${label}.expect.deniedBy（拒绝用例必须给出分类标签）`);
  } else if (fixture.expect.allowed === true) {
    expect(!hasOwn(fixture.expect, 'deniedBy'), `${label}.expect: 放行用例不得携带 deniedBy`);
  }
}

function checkFixtureEnums(data) {
  const enums = data.enums;
  if (!expect(isPlainObject(enums), 'enums 必须是对象')) {
    return;
  }
  const rolesOk = expectStringArray(enums.roles, 'enums.roles', {
    allowEmpty: false,
    unique: true,
  });
  const scopesOk = expectStringArray(enums.dataScopes, 'enums.dataScopes', {
    allowEmpty: false,
    unique: true,
  });
  const permissionsOk = expectStringArray(enums.permissions, 'enums.permissions', {
    allowEmpty: false,
    unique: true,
  });
  expect(
    Array.isArray(enums.permissions) && enums.permissions.every((item) => !item.includes('*')),
    'enums.permissions 不得包含通配形式（原子权限必须精确匹配）',
  );

  if (!expect(isPlainObject(enums.roleDefaultScope), 'enums.roleDefaultScope 必须是对象')) {
    return;
  }
  const roleDefaultScope = enums.roleDefaultScope;
  if (rolesOk) {
    expect(
      Object.keys(roleDefaultScope).length === enums.roles.length &&
        enums.roles.every((role) => hasOwn(roleDefaultScope, role)),
      'enums.roleDefaultScope 的键必须与 enums.roles 完全一致',
    );
  }
  if (scopesOk) {
    for (const [role, scope] of Object.entries(roleDefaultScope)) {
      expect(
        enums.dataScopes.includes(scope),
        `enums.roleDefaultScope.${role} 的取值必须属于 enums.dataScopes`,
      );
    }
  }

  const restricted = expectStringArray(
    enums.grantRestrictedPermissions,
    'enums.grantRestrictedPermissions',
    {
      allowEmpty: false,
      unique: true,
    },
  );
  if (restricted && permissionsOk) {
    for (const permission of enums.grantRestrictedPermissions) {
      expect(
        enums.permissions.includes(permission),
        `enums.grantRestrictedPermissions 的 ${permission} 必须同时登记在 enums.permissions`,
      );
    }
  }
}

/* ------------------------------------------------------------------ *
 * 授权场景重放（内置参考执行器）
 *
 * 参考执行器镜像 packages/shared/src/enums/authorization.ts 的判定语义，
 * 用于把夹具本身断言到文档语义；它不是第二事实来源（见文件头「边界」）。
 * ------------------------------------------------------------------ */

function tryReadText(path) {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

function isRegisteredRole(value) {
  return typeof value === 'string' && ROLE_SET.has(value);
}

function isRegisteredScope(value) {
  return typeof value === 'string' && SCOPE_SET.has(value);
}

function isRegisteredPermission(value) {
  return typeof value === 'string' && PERMISSION_SET.has(value);
}

/** 镜像 isAuthorized：默认拒绝 + 单角色严格范围相等 + 服务端归属绑定。 */
function authorizeReference(subject, request) {
  if (!isPlainObject(subject) || !isPlainObject(request)) {
    return false;
  }
  if (
    !subject.userId ||
    !isRegisteredPermission(request.permission) ||
    !isRegisteredScope(request.scope)
  ) {
    return false;
  }
  if (!Array.isArray(subject.roles) || !subject.roles.every(isRegisteredRole)) {
    return false;
  }
  return subject.roles.some((role) => {
    if (!ROLE_PERMISSIONS[role].includes(request.permission)) {
      return false;
    }
    if (request.scope !== ROLE_DEFAULT_SCOPE[role]) {
      return false;
    }
    if (request.scope === 'SELF' && request.resourceUserId !== subject.userId) {
      return false;
    }
    if (request.scope === 'ASSIGNED') {
      const assigned = Array.isArray(subject.assignedResourceIds)
        ? subject.assignedResourceIds
        : [];
      if (!request.resourceUserId || !assigned.includes(request.resourceUserId)) {
        return false;
      }
    }
    if (role === 'group_leader') {
      const owned = Array.isArray(subject.groupIds) ? subject.groupIds : [];
      return (
        request.scope === 'GROUP' && Boolean(request.groupId) && owned.includes(request.groupId)
      );
    }
    return true;
  });
}

/** 镜像 canGrantPermissions：只有系统/超级管理员可配置，且不得越权或授予受限权限。 */
function canGrantReference(actor, grants) {
  if (!isPlainObject(actor) || !Array.isArray(grants)) {
    return false;
  }
  if (!actor.userId || !Array.isArray(actor.roles) || !actor.roles.every(isRegisteredRole)) {
    return false;
  }
  const isSuperAdmin = actor.roles.includes('super_admin');
  const isSystemAdmin = actor.roles.includes('system_admin');
  if (!isSuperAdmin && !isSystemAdmin) {
    return false;
  }
  return grants.every((grant) => {
    if (!isPlainObject(grant)) {
      return false;
    }
    if (!grant.targetUserId) {
      return false;
    }
    if (!isRegisteredPermission(grant.permission) || !isRegisteredScope(grant.scope)) {
      return false;
    }
    if (RESTRICTED_SET.has(grant.permission)) {
      return false;
    }
    if (grant.scope === 'GLOBAL' && !isSuperAdmin) {
      return false;
    }
    if (grant.scope === 'SYSTEM' && !isSuperAdmin) {
      return false;
    }
    if (actor.roles.includes('group_leader')) {
      const owned = Array.isArray(actor.groupIds) ? actor.groupIds : [];
      if (grant.scope !== 'GROUP' || !grant.groupId || !owned.includes(grant.groupId)) {
        return false;
      }
    }
    return true;
  });
}

function checkKnownKeys(object, allowedKeys, label) {
  const unknown = Object.keys(object).filter((key) => !allowedKeys.includes(key));
  expect(unknown.length === 0, `${label}: 出现契约未登记的字段: ${unknown.join(', ')}`);
}

function checkOptionalStringList(object, key, label) {
  if (hasOwn(object, key)) {
    expectStringArray(object[key], `${label}.${key}`);
  }
}

function checkDeniedByLabel(fixture, label) {
  const deniedBy = fixture.expect?.deniedBy;
  if (typeof deniedBy !== 'string' || deniedBy === '') {
    return;
  }
  if (!DENIED_BY_LABELS.has(deniedBy)) {
    warn(`${label}.expect.deniedBy 使用了未登记的标签: ${deniedBy}（标签不参与断言）`);
  }
}

function checkClientClaims(fixture, label) {
  if (!hasOwn(fixture, 'clientClaims')) {
    return;
  }
  if (!expect(isPlainObject(fixture.clientClaims), `${label}.clientClaims 必须是对象`)) {
    return;
  }
  const claims = fixture.clientClaims;
  checkKnownKeys(claims, CLIENT_CLAIM_KEYS, `${label}.clientClaims`);
  for (const [key, value] of Object.entries(claims)) {
    expect(
      typeof value === 'string' ||
        (Array.isArray(value) && value.every((item) => typeof item === 'string')),
      `${label}.clientClaims.${key} 必须是字符串或字符串数组`,
    );
  }
}

/** 执行规则 3：忽略 clientClaims 前后结论必须一致。 */
function checkClientClaimsIgnored(fixture, label, evaluate) {
  if (!hasOwn(fixture, 'clientClaims')) {
    return;
  }
  const withoutClaims = { ...fixture };
  delete withoutClaims.clientClaims;
  expect(
    evaluate(fixture) === evaluate(withoutClaims),
    `${label}: 忽略 clientClaims 后结论发生变化（执行器不得读取客户端声明）`,
  );
}

/** 负向 clientClaims 夹具必须真的在伪造声明，否则无法证明声明被忽略。 */
function checkClientClaimsAreForged(fixture, label) {
  if (!hasOwn(fixture, 'clientClaims') || !isPlainObject(fixture.clientClaims)) {
    return;
  }
  if (!isPlainObject(fixture.subject) || !isPlainObject(fixture.request)) {
    return;
  }
  const claims = fixture.clientClaims;
  let contradictions = 0;
  for (const target of CLAIM_TARGETS) {
    if (!hasOwn(claims, target.claim)) {
      continue;
    }
    const holder = target.holder === 'subject' ? fixture.subject : fixture.request;
    const claimed = target.many ? [claims[target.claim]] : claims[target.claim];
    const resolved = holder[target.field] ?? null;
    if (JSON.stringify(claimed) !== JSON.stringify(resolved)) {
      contradictions += 1;
    }
  }
  expect(
    contradictions > 0,
    `${label}: clientClaims 至少应有一项与服务端解析结果不同（否则无法证明客户端声明被忽略）`,
  );
}

function checkEnumReferences(roles, request, expected, label) {
  let unregistered = 0;
  if (Array.isArray(roles)) {
    unregistered += roles.filter(
      (role) => typeof role === 'string' && !isRegisteredRole(role),
    ).length;
  }
  if (
    typeof request.scope === 'string' &&
    request.scope !== '' &&
    !isRegisteredScope(request.scope)
  ) {
    unregistered += 1;
  }
  if (
    typeof request.permission === 'string' &&
    request.permission !== '' &&
    !isRegisteredPermission(request.permission)
  ) {
    unregistered += 1;
  }
  stats.unregistered += unregistered;
  expect(
    unregistered === 0 || expected?.allowed === false,
    `${label}: 放行用例不得引用未登记的角色/范围/权限（未登记值只允许出现在拒绝用例中）`,
  );
}

function checkGrantEnumReferences(actor, grants, expected, label) {
  let unregistered = 0;
  if (Array.isArray(actor.roles)) {
    unregistered += actor.roles.filter(
      (role) => typeof role === 'string' && !isRegisteredRole(role),
    ).length;
  }
  for (const grant of Array.isArray(grants) ? grants : []) {
    if (!isPlainObject(grant)) {
      continue;
    }
    if (typeof grant.scope === 'string' && grant.scope !== '' && !isRegisteredScope(grant.scope)) {
      unregistered += 1;
    }
    if (
      typeof grant.permission === 'string' &&
      grant.permission !== '' &&
      !isRegisteredPermission(grant.permission)
    ) {
      unregistered += 1;
    }
  }
  stats.unregistered += unregistered;
  expect(
    unregistered === 0 || expected?.allowed === false,
    `${label}: 放行用例不得引用未登记的角色/范围/权限（未登记值只允许出现在拒绝用例中）`,
  );
}

function compareOutcome(fixture, label, computed, entrypoint) {
  if (!isPlainObject(fixture.expect) || typeof fixture.expect.allowed !== 'boolean') {
    return;
  }
  stats.scenarios += 1;
  expect(
    computed === fixture.expect.allowed,
    `${label}: 参考执行器 ${entrypoint} 返回 ${computed}，与 expect.allowed=${fixture.expect.allowed} 不一致`,
  );
}

function checkAuthorizeScenario(fixture, label) {
  if (!isPlainObject(fixture.subject) || !isPlainObject(fixture.request)) {
    return;
  }
  checkKnownKeys(fixture.subject, SUBJECT_KEYS, `${label}.subject`);
  checkKnownKeys(fixture.request, REQUEST_KEYS, `${label}.request`);
  checkOptionalStringList(fixture.subject, 'groupIds', `${label}.subject`);
  checkOptionalStringList(fixture.subject, 'assignedResourceIds', `${label}.subject`);
  checkOptionalStringList(fixture.request, 'assignedResourceIds', `${label}.request`);
  checkClientClaims(fixture, label);
  checkDeniedByLabel(fixture, label);
  checkEnumReferences(fixture.subject.roles, fixture.request, fixture.expect, label);
  compareOutcome(
    fixture,
    label,
    authorizeReference(fixture.subject, fixture.request),
    'isAuthorized',
  );
  checkClientClaimsIgnored(fixture, label, (item) =>
    authorizeReference(item.subject, item.request),
  );
  checkClientClaimsAreForged(fixture, label);
}

function checkGrantScenario(fixture, label) {
  if (!isPlainObject(fixture.actor) || !Array.isArray(fixture.grants)) {
    return;
  }
  checkKnownKeys(fixture.actor, SUBJECT_KEYS, `${label}.actor`);
  checkOptionalStringList(fixture.actor, 'groupIds', `${label}.actor`);
  checkOptionalStringList(fixture.actor, 'assignedResourceIds', `${label}.actor`);
  fixture.grants.forEach((grant, index) => {
    if (isPlainObject(grant)) {
      checkKnownKeys(grant, GRANT_KEYS, `${label}.grants[${index}]`);
    }
  });
  checkClientClaims(fixture, label);
  checkDeniedByLabel(fixture, label);
  checkGrantEnumReferences(fixture.actor, fixture.grants, fixture.expect, label);
  compareOutcome(
    fixture,
    label,
    canGrantReference(fixture.actor, fixture.grants),
    'canGrantPermissions',
  );
  checkClientClaimsIgnored(fixture, label, (item) => canGrantReference(item.actor, item.grants));
}

/** README §5 的负向场景覆盖门禁。 */
function checkNegativeCoverage() {
  for (const [tag, description] of REQUIRED_NEGATIVE_TAGS) {
    expect(
      stats.negativeTags.has(tag),
      `夹具负向覆盖不足：缺少「${description}」的拒绝用例（标签 ${tag}）`,
    );
  }
}

function assertSameSet(actual, expected, label) {
  if (!expectStringArray(actual, label, { allowEmpty: false, unique: true })) {
    return;
  }
  const missing = expected.filter((item) => !actual.includes(item));
  const extra = actual.filter((item) => !expected.includes(item));
  expect(missing.length === 0, `${label} 缺少基线快照值: ${missing.join(', ')}`);
  expect(extra.length === 0, `${label} 含基线快照之外的值: ${extra.join(', ')}`);
}

/** 冻结快照与单一事实来源的一致性，外加权限目录的可推导不变式。 */
function checkEnumsSnapshot(data) {
  const enums = data.enums;
  if (!isPlainObject(enums)) {
    return;
  }
  assertSameSet(enums.roles, REGISTERED_ROLES, 'enums.roles');
  assertSameSet(enums.dataScopes, REGISTERED_SCOPES, 'enums.dataScopes');
  assertSameSet(enums.permissions, PERMISSION_REGISTRY, 'enums.permissions');
  assertSameSet(
    enums.grantRestrictedPermissions,
    GRANT_RESTRICTED_PERMISSIONS,
    'enums.grantRestrictedPermissions',
  );
  if (isPlainObject(enums.roleDefaultScope)) {
    for (const role of REGISTERED_ROLES) {
      expect(
        enums.roleDefaultScope[role] === ROLE_DEFAULT_SCOPE[role],
        `enums.roleDefaultScope.${role} 必须为 ${ROLE_DEFAULT_SCOPE[role]}，实际 ${String(
          enums.roleDefaultScope[role],
        )}`,
      );
    }
  }

  const union = new Set(GRANT_RESTRICTED_PERMISSIONS);
  for (const role of REGISTERED_ROLES) {
    for (const permission of ROLE_PERMISSIONS[role]) {
      union.add(permission);
    }
  }
  expect(
    union.size === PERMISSION_REGISTRY.length &&
      PERMISSION_REGISTRY.every((item) => union.has(item)),
    '冻结快照自检失败：角色默认权限集合 ∪ 受限权限应恰好等于权限目录',
  );

  const source = tryReadText(PERMISSION_SOURCE_FILE);
  stats.permissionSource = source !== null;
  if (source === null) {
    return;
  }
  const derived = new Set(
    [...source.matchAll(/'([a-z][a-z0-9]*(?::[a-z0-9]+)+)'/g)].map((match) => match[1]),
  );
  const missing = PERMISSION_REGISTRY.filter((permission) => !derived.has(permission));
  const extra = [...derived].filter((permission) => !PERMISSION_SET.has(permission));
  expect(
    derived.size > 0 && missing.length === 0,
    `权限目录与 packages/shared/src/enums/permission.ts 不一致：缺少 ${
      missing.join(', ') || '(未解析出任何权限点)'
    }`,
  );
  expect(
    extra.length === 0,
    `权限目录与 packages/shared/src/enums/permission.ts 不一致：多出 ${extra.join(', ')}`,
  );
}

function checkAuthzFixtures(data, label) {
  if (!expect(isPlainObject(data), `${label}: 顶层必须是对象`)) {
    return;
  }
  for (const field of [
    'contract',
    'contractVersion',
    'module',
    'slice',
    'binding',
    'evaluation',
    'enums',
    'fixtures',
    'grantFixtures',
    'nonGoals',
  ]) {
    expect(hasOwn(data, field), `${label}: 缺少顶层字段 ${field}`);
  }
  expectString(data.contract, `${label}.contract`);
  expectString(data.module, `${label}.module`);
  expectString(data.slice, `${label}.slice`);
  expect(
    typeof data.contractVersion === 'string' && SEMVER.test(data.contractVersion),
    `${label}.contractVersion 必须是 semver（x.y.z）`,
  );

  if (expect(isPlainObject(data.binding), `${label}.binding 必须是对象`)) {
    for (const field of [
      'referenceImplementation',
      'baselineConsumer',
      'authorizeEntrypoint',
      'grantEntrypoint',
      'policy',
    ]) {
      expectString(data.binding[field], `${label}.binding.${field}`);
    }
    expectStringArray(data.binding.serverResolvedFields, `${label}.binding.serverResolvedFields`, {
      allowEmpty: false,
      unique: true,
    });
  }

  let additionalAllowedKeys = [];
  if (expect(isPlainObject(data.evaluation), `${label}.evaluation 必须是对象`)) {
    for (const field of ['authorize', 'grant', 'clientClaims', 'deniedBy']) {
      expectString(data.evaluation[field], `${label}.evaluation.${field}`);
    }
    const allowed = expectStringArray(
      data.evaluation.additionalAllowedKeys,
      `${label}.evaluation.additionalAllowedKeys`,
      { unique: true },
    );
    if (allowed) {
      additionalAllowedKeys = data.evaluation.additionalAllowedKeys;
      expect(
        additionalAllowedKeys.includes('clientClaims'),
        `${label}.evaluation.additionalAllowedKeys 必须允许 clientClaims（夹具中存在该字段）`,
      );
    }
  }

  checkFixtureEnums(data);
  checkEnumsSnapshot(data);

  expectStringArray(data.nonGoals, `${label}.nonGoals`, { allowEmpty: false });

  const seenIds = new Set();
  const authorizeAllowed = ['id', 'kind', 'subject', 'request', 'expect', ...additionalAllowedKeys];
  const grantAllowed = ['id', 'kind', 'actor', 'grants', 'expect', ...additionalAllowedKeys];

  if (expect(Array.isArray(data.fixtures), `${label}.fixtures 必须是数组`)) {
    expect(data.fixtures.length > 0, `${label}.fixtures 不得为空`);
    data.fixtures.forEach((fixture, index) => {
      const itemLabel = `${label}.fixtures[${index}]`;
      if (!expect(isPlainObject(fixture), `${itemLabel} 必须是对象`)) {
        return;
      }
      const fixtureLabel = `${itemLabel}(${fixture.id ?? '缺少 id'})`;
      if (expectString(fixture.id, `${itemLabel}.id`)) {
        expect(!seenIds.has(fixture.id), `${itemLabel}.id 重复: ${fixture.id}`);
        seenIds.add(fixture.id);
      }
      expect(fixture.kind === 'authorize', `${fixtureLabel}.kind 必须是 authorize`);
      if (expect(isPlainObject(fixture.subject), `${fixtureLabel}.subject 必须是对象`)) {
        expectString(fixture.subject.userId, `${fixtureLabel}.subject.userId`, {
          allowEmpty: true,
        });
        expectStringArray(fixture.subject.roles, `${fixtureLabel}.subject.roles`);
      }
      if (expect(isPlainObject(fixture.request), `${fixtureLabel}.request 必须是对象`)) {
        expectString(fixture.request.permission, `${fixtureLabel}.request.permission`);
        expectString(fixture.request.scope, `${fixtureLabel}.request.scope`);
      }
      checkExpectation(fixture, fixtureLabel);
      checkFixtureKeys(fixture, fixtureLabel, authorizeAllowed);
      if (fixture.expect?.allowed === false && Array.isArray(fixture.tags)) {
        for (const tag of fixture.tags) {
          stats.negativeTags.add(tag);
        }
      }
      checkAuthorizeScenario(fixture, fixtureLabel);
      stats.authorize += 1;
    });
  }

  if (expect(Array.isArray(data.grantFixtures), `${label}.grantFixtures 必须是数组`)) {
    expect(data.grantFixtures.length > 0, `${label}.grantFixtures 不得为空`);
    data.grantFixtures.forEach((fixture, index) => {
      const itemLabel = `${label}.grantFixtures[${index}]`;
      if (!expect(isPlainObject(fixture), `${itemLabel} 必须是对象`)) {
        return;
      }
      const fixtureLabel = `${itemLabel}(${fixture.id ?? '缺少 id'})`;
      if (expectString(fixture.id, `${itemLabel}.id`)) {
        expect(!seenIds.has(fixture.id), `${itemLabel}.id 重复: ${fixture.id}`);
        seenIds.add(fixture.id);
      }
      expect(fixture.kind === 'grant', `${fixtureLabel}.kind 必须是 grant`);
      if (expect(isPlainObject(fixture.actor), `${fixtureLabel}.actor 必须是对象`)) {
        expectString(fixture.actor.userId, `${fixtureLabel}.actor.userId`, { allowEmpty: true });
        expectStringArray(fixture.actor.roles, `${fixtureLabel}.actor.roles`);
      }
      if (expect(Array.isArray(fixture.grants), `${fixtureLabel}.grants 必须是数组`)) {
        fixture.grants.forEach((grant, grantIndex) => {
          const grantLabel = `${fixtureLabel}.grants[${grantIndex}]`;
          if (!expect(isPlainObject(grant), `${grantLabel} 必须是对象`)) {
            return;
          }
          expectString(grant.targetUserId, `${grantLabel}.targetUserId`, { allowEmpty: true });
          expectString(grant.permission, `${grantLabel}.permission`);
          expectString(grant.scope, `${grantLabel}.scope`);
        });
      }
      checkExpectation(fixture, fixtureLabel);
      checkFixtureKeys(fixture, fixtureLabel, grantAllowed);
      if (fixture.expect?.allowed === false && Array.isArray(fixture.tags)) {
        for (const tag of fixture.tags) {
          stats.negativeTags.add(tag);
        }
      }
      checkGrantScenario(fixture, fixtureLabel);
      stats.grant += 1;
    });
  }

  checkNegativeCoverage();
}

/* ------------------------------------------------------------------ *
 * health.openapi.yaml 结构校验
 * ------------------------------------------------------------------ */

function resolvePointer(document, pointer) {
  if (!pointer.startsWith('#/')) {
    return { found: false, reason: '必须使用本文档内的 #/ 引用（不允许外部文件或 URL 引用）' };
  }
  let node = document;
  for (const rawToken of pointer.slice(2).split('/')) {
    const token = rawToken.replace(/~1/g, '/').replace(/~0/g, '~');
    if (isPlainObject(node) && hasOwn(node, token)) {
      node = node[token];
      continue;
    }
    if (Array.isArray(node) && /^\d+$/.test(token) && Number(token) < node.length) {
      node = node[Number(token)];
      continue;
    }
    return { found: false, reason: `无法解析 #/ 路径段: ${token}` };
  }
  return { found: true, node };
}

function collectRefs(node, refs) {
  if (Array.isArray(node)) {
    for (const item of node) {
      collectRefs(item, refs);
    }
    return refs;
  }
  if (!isPlainObject(node)) {
    return refs;
  }
  if (hasOwn(node, '$ref')) {
    refs.push({ ref: node.$ref, siblingKeys: Object.keys(node).filter((key) => key !== '$ref') });
    return refs;
  }
  for (const value of Object.values(node)) {
    collectRefs(value, refs);
  }
  return refs;
}

function checkOpenApi(document, label) {
  if (!expect(isPlainObject(document), `${label}: 顶层必须是对象`)) {
    return;
  }
  for (const field of ['openapi', 'info', 'servers', 'paths', 'components']) {
    expect(hasOwn(document, field), `${label}: 缺少顶层字段 ${field}`);
  }
  expect(
    typeof document.openapi === 'string' && /^3\.\d+\.\d+$/.test(document.openapi),
    `${label}.openapi 必须是 OpenAPI 3.x 版本号`,
  );

  if (expect(isPlainObject(document.info), `${label}.info 必须是对象`)) {
    expectString(document.info.title, `${label}.info.title`);
    expect(
      typeof document.info.version === 'string' && SEMVER.test(document.info.version),
      `${label}.info.version 必须是 semver（x.y.z）`,
    );
    if (expect(isPlainObject(document.info.license), `${label}.info.license 必须是对象`)) {
      expect(
        document.info.license.name === 'UNLICENSED',
        `${label}.info.license.name 必须为 UNLICENSED（公开契约不得声明未核验的许可证）`,
      );
    }
  }

  if (expect(Array.isArray(document.servers), `${label}.servers 必须是数组`)) {
    expect(
      document.servers.length > 0 && document.servers[0]?.url === '/api/v1',
      `${label}.servers[0].url 必须为 /api/v1（与基线 API_PREFIX 一致）`,
    );
  }

  if (expect(isPlainObject(document.paths), `${label}.paths 必须是对象`)) {
    const paths = Object.keys(document.paths);
    stats.paths = paths;
    expect(paths.length > 0, `${label}.paths 不得为空`);
    for (const path of paths) {
      expect(path.startsWith('/'), `${label}.paths 的键必须以 / 开头: ${path}`);
      const pathItem = document.paths[path];
      const pathLabel = `${label}.paths.${path}`;
      if (!expect(isPlainObject(pathItem), `${pathLabel} 必须是对象`)) {
        continue;
      }
      const operations = Object.keys(pathItem).filter((key) =>
        ['get', 'put', 'post', 'delete', 'patch', 'head', 'options', 'trace'].includes(key),
      );
      expect(operations.length > 0, `${pathLabel} 至少需要一个 HTTP 操作`);
      for (const method of operations) {
        const operation = pathItem[method];
        const operationLabel = `${pathLabel}.${method}`;
        if (!expect(isPlainObject(operation), `${operationLabel} 必须是对象`)) {
          continue;
        }
        expectString(operation.operationId, `${operationLabel}.operationId`);
        expectString(operation.summary, `${operationLabel}.summary`);
        if (expect(isPlainObject(operation.responses), `${operationLabel}.responses 必须是对象`)) {
          const statuses = Object.keys(operation.responses);
          expect(statuses.length > 0, `${operationLabel}.responses 不得为空`);
          for (const status of statuses) {
            const response = operation.responses[status];
            const responseLabel = `${operationLabel}.responses.${status}`;
            expect(
              /^[1-5]\d\d$/.test(status) || status === 'default',
              `${responseLabel} 的状态码必须是 HTTP 状态码或 default`,
            );
            if (expect(isPlainObject(response), `${responseLabel} 必须是对象`)) {
              if (!hasOwn(response, '$ref')) {
                expectString(response.description, `${responseLabel}.description`);
              }
            }
          }
        }
      }
    }

    for (const path of REQUIRED_PATHS) {
      if (!expect(hasOwn(document.paths, path), `${label}.paths 缺少必需路径 ${path}`)) {
        continue;
      }
      const operation = document.paths[path]?.get;
      const operationLabel = `${label}.paths.${path}.get`;
      if (!expect(isPlainObject(operation), `${operationLabel} 必须是对象`)) {
        continue;
      }
      expect(
        Array.isArray(operation.security) && operation.security.length === 0,
        `${operationLabel}.security 必须为 []（公开探活端点不要求会话）`,
      );
      const ok = operation.responses?.['200'];
      if (expect(isPlainObject(ok), `${operationLabel}.responses.200 必须是对象`)) {
        const schema = ok.content?.['application/json']?.schema;
        expect(
          isPlainObject(schema),
          `${operationLabel}.responses.200.content.application/json.schema 必须存在`,
        );
      }
    }
  }

  if (expect(isPlainObject(document.components), `${label}.components 必须是对象`)) {
    if (
      expect(isPlainObject(document.components.schemas), `${label}.components.schemas 必须是对象`)
    ) {
      const schemas = Object.keys(document.components.schemas);
      expect(schemas.length > 0, `${label}.components.schemas 不得为空`);
      const envelopes = schemas.filter((name) => name.endsWith('Envelope'));
      expect(envelopes.length >= 3, `${label}.components.schemas 至少需要三个 *Envelope 定义`);
      for (const name of envelopes) {
        const schema = document.components.schemas[name];
        const schemaLabel = `${label}.components.schemas.${name}`;
        if (!expect(isPlainObject(schema), `${schemaLabel} 必须是对象`)) {
          continue;
        }
        for (const field of ENVELOPE_FIELDS) {
          expect(
            Array.isArray(schema.required) && schema.required.includes(field),
            `${schemaLabel}.required 必须包含 ${field}（统一信封 { data, meta, error }）`,
          );
        }
        expect(
          schema.additionalProperties === false,
          `${schemaLabel}.additionalProperties 必须为 false（信封字段封闭）`,
        );
      }
    }
    expect(
      isPlainObject(document.components.securitySchemes) &&
        hasOwn(document.components.securitySchemes, 'bearerAuth'),
      `${label}.components.securitySchemes.bearerAuth 必须存在`,
    );
  }

  const refs = collectRefs(document, []);
  stats.refs = refs.length;
  expect(refs.length > 0, `${label}: 未发现任何 $ref（结构可能被改写）`);
  for (const { ref, siblingKeys } of refs) {
    if (typeof ref !== 'string') {
      expect(false, `${label}: $ref 的值必须是字符串`);
      continue;
    }
    expect(
      siblingKeys.length === 0,
      `${label}: $ref ${ref} 不得携带同级字段（OpenAPI 3.0 忽略同级键）`,
    );
    const resolved = resolvePointer(document, ref);
    expect(resolved.found, `${label}: $ref 无法解析: ${ref}（${resolved.reason ?? ''}）`);
    if (resolved.found) {
      expect(isPlainObject(resolved.node), `${label}: $ref ${ref} 必须指向对象节点`);
    }
  }

  if (expect(isPlainObject(document['x-boundary']), `${label}.x-boundary 必须是对象`)) {
    const boundary = document['x-boundary'];
    expectString(boundary.module, `${label}.x-boundary.module`);
    expectString(boundary.slice, `${label}.x-boundary.slice`);
    expectString(boundary.baseline, `${label}.x-boundary.baseline`);
    expect(
      boundary.ruoyiSourceIncluded === false,
      `${label}.x-boundary.ruoyiSourceIncluded 必须为 false（边界内不得包含 RuoYi/Java 源码）`,
    );
    expect(
      boundary.mavenDependencyIntroduced === false,
      `${label}.x-boundary.mavenDependencyIntroduced 必须为 false（不得引入 Maven 依赖）`,
    );
    expectString(boundary.contractsVersion, `${label}.x-boundary.contractsVersion`);
    expect(
      boundary.contractsVersion === document.info?.version,
      `${label}.x-boundary.contractsVersion 必须等于 info.version`,
    );
  }
}

/* ------------------------------------------------------------------ *
 * 主流程
 * ------------------------------------------------------------------ */

function readText(path, label) {
  try {
    return readFileSync(path, 'utf8');
  } catch (error) {
    issues.push(`${label}: 无法读取 ${path}（${error.message}）`);
    return null;
  }
}

const fixturesText = readText(FIXTURES_FILE, 'authz-fixtures');
const openApiText = readText(OPENAPI_FILE, 'health.openapi');

let fixtures = null;
if (fixturesText !== null) {
  try {
    fixtures = JSON.parse(fixturesText.replace(/^\uFEFF/, ''));
  } catch (error) {
    issues.push(`authz-fixtures.json: JSON 解析失败（${error.message}）`);
  }
}

let openApi = null;
if (openApiText !== null) {
  try {
    openApi = parseYamlSubset(openApiText, 'health.openapi.yaml');
  } catch (error) {
    issues.push(
      error instanceof ContractError
        ? error.message
        : `health.openapi.yaml: 解析异常（${error.message}）`,
    );
  }
}

if (fixtures) {
  checkAuthzFixtures(fixtures, 'authz-fixtures.json');
}
if (openApi) {
  checkOpenApi(openApi, 'health.openapi.yaml');
}
if (fixtures && openApi && isPlainObject(openApi.info) && fixtures.contractVersion) {
  expect(
    fixtures.contractVersion === openApi.info.version,
    'authz-fixtures.json 与 health.openapi.yaml 的契约版本必须一致',
  );
}

console.log('RuoYi 公开契约静态校验（仅使用 Node 内置模块，无第三方依赖）');
console.log(`- 夹具契约: ${FIXTURES_FILE}`);
console.log(`- OpenAPI 契约: ${OPENAPI_FILE}`);
console.log(`- 检查项: ${checkCount}`);
console.log(`- 夹具: authorize ${stats.authorize} 条 / grant ${stats.grant} 条`);
console.log(`- OpenAPI 路径: ${stats.paths.length > 0 ? stats.paths.join(', ') : '(未解析)'}`);
console.log(`- $ref: ${stats.refs} 处（要求均为文档内引用且可解析）`);
console.log(`- 授权场景重放: ${stats.scenarios} 条（内置参考执行器，镜像 authorization.ts）`);
console.log(
  `- 权限目录交叉核对: ${
    stats.permissionSource
      ? 'packages/shared/src/enums/permission.ts'
      : '跳过（单一事实来源文件不可读）'
  }`,
);
console.log(`- 未登记枚举引用: ${stats.unregistered} 处（只允许出现在拒绝用例中）`);

if (warnings.length > 0) {
  console.log(`\n提示 (${warnings.length})`);
  for (const warning of warnings) {
    console.log(`  ~ ${warning}`);
  }
}

if (issues.length > 0) {
  console.error(`\n失败 (${issues.length})`);
  for (const issue of issues) {
    console.error(`  x ${issue}`);
  }
  process.exitCode = 1;
} else {
  console.log('\n结果: 通过');
}

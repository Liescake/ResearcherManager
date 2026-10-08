import {
  DATA_SCOPE_VALUES,
  DEFAULT_ROLE_DATA_SCOPE,
  PERMISSION_POINT_VALUES,
  ROLE_VALUES,
  isDataScope,
  isPermissionPoint,
  isRole,
  type AuthorizationRequest,
  type AuthorizationSubject,
  type DataScope,
  type PermissionGrant,
  type Role,
} from '@rm/shared';

/**
 * `authz-fixtures.json` 契约适配器（services/ruoyi-api → services/api 边界）。
 *
 * 单一事实来源：`services/ruoyi-api/contracts/authz-fixtures.json`。
 * 本文件只包含**类型与纯函数**：把它读成强类型结构，并提供跨边界强制转换——只有登记在
 * `packages/shared/src/enums/permission.ts` 里的角色/数据范围/原子权限才会被转换成
 * 谓词入参；未登记值一律返回 undefined，由适配器判为拒绝（fail-closed）。
 *
 * 文件读取在 `authz-fixtures-reader.ts`，只在测试/评审流程中发生：应用启动不读取契约文件，
 * 因此契约目录对运行期不是依赖（契约不可达时 API 仍可独立启动）。
 */

export {
  AUTHZ_CONTRACT_FILE,
  AUTHZ_CONTRACT_ID,
  AUTHZ_CONTRACT_RELATIVE_PATH,
  AUTHZ_CONTRACT_VERSION,
} from './contract-identity';

export interface AuthzFixtureClientClaims {
  role?: unknown;
  roles?: readonly unknown[];
  scope?: unknown;
  groupId?: unknown;
  resourceUserId?: unknown;
  assignedResourceIds?: unknown;
  permission?: unknown;
}

export interface AuthzRawSubject {
  userId?: unknown;
  roles?: readonly unknown[];
  groupIds?: readonly unknown[];
  assignedResourceIds?: readonly unknown[];
}

export interface AuthzRawRequest {
  permission?: unknown;
  scope?: unknown;
  groupId?: unknown;
  resourceUserId?: unknown;
  assignedResourceIds?: readonly unknown[];
}

export interface AuthzRawFixture {
  id: string;
  kind: string;
  title?: string;
  tags?: readonly string[];
  subject: AuthzRawSubject;
  request: AuthzRawRequest;
  expect: { allowed: boolean; deniedBy?: string };
  rationale?: string;
  clientClaims?: AuthzFixtureClientClaims;
}

export interface AuthzRawGrantFixture {
  id: string;
  kind: string;
  title?: string;
  tags?: readonly string[];
  actor: AuthzRawSubject;
  grants: readonly (AuthzRawRequest & { targetUserId?: unknown })[];
  expect: { allowed: boolean; deniedBy?: string };
  rationale?: string;
}

export interface AuthzFixturesContract {
  contract: string;
  contractVersion: string;
  module: string;
  slice: string;
  binding: {
    referenceImplementation?: string;
    baselineConsumer?: string;
    authorizeEntrypoint?: string;
    grantEntrypoint?: string;
    policy?: string;
    ruoyiMapping?: string;
  };
  enums: {
    roles: readonly unknown[];
    dataScopes: readonly unknown[];
    roleDefaultScope: Record<string, unknown>;
    permissions: readonly unknown[];
    grantRestrictedPermissions: readonly unknown[];
  };
  fixtures: readonly AuthzRawFixture[];
  grantFixtures: readonly AuthzRawGrantFixture[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toIdList(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter((item): item is string => typeof item === 'string');
}

function asUnknownArray(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

function rolesOf(raw: readonly unknown[] | undefined): readonly Role[] {
  return asUnknownArray(raw).filter((role): role is Role => isRole(role));
}

function stringIdsOf(raw: readonly unknown[] | undefined): readonly string[] {
  return asUnknownArray(raw).filter((id): id is string => typeof id === 'string');
}

/**
 * 跨边界强制转换：未登记值返回 undefined。
 * 夹具里的 `unlisted-role` / `unlisted-scope` / `unlisted-permission` 负向用例
 * 正是靠这里转成 undefined 后被判为拒绝，而不是抛异常。
 */
export function toAuthorizationSubject(raw: AuthzRawSubject): AuthorizationSubject | undefined {
  if (!isRecord(raw) || typeof raw.userId !== 'string' || raw.userId.length === 0) return undefined;
  const roleInputs = asUnknownArray(raw.roles);
  const roles: Role[] = [];
  for (const role of roleInputs) {
    if (!isRole(role)) return undefined;
    roles.push(role);
  }
  const groupIds = toIdList(raw.groupIds);
  const assignedResourceIds = toIdList(raw.assignedResourceIds);
  return {
    userId: raw.userId,
    roles,
    ...(groupIds ? { groupIds } : {}),
    ...(assignedResourceIds ? { assignedResourceIds } : {}),
  };
}

export function toAuthorizationRequest(raw: AuthzRawRequest): AuthorizationRequest | undefined {
  if (!isRecord(raw) || !isPermissionPoint(raw.permission) || !isDataScope(raw.scope))
    return undefined;
  const groupId = typeof raw.groupId === 'string' ? raw.groupId : undefined;
  const resourceUserId = typeof raw.resourceUserId === 'string' ? raw.resourceUserId : undefined;
  const assignedResourceIds = toIdList(raw.assignedResourceIds);
  return {
    permission: raw.permission,
    scope: raw.scope,
    ...(groupId ? { groupId } : {}),
    ...(resourceUserId ? { resourceUserId } : {}),
    ...(assignedResourceIds ? { assignedResourceIds } : {}),
  };
}

export function toPermissionGrants(
  raw: readonly (AuthzRawRequest & { targetUserId?: unknown })[],
): readonly PermissionGrant[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const grants: PermissionGrant[] = [];
  for (const grant of raw) {
    if (!isRecord(grant)) return undefined;
    if (typeof grant.targetUserId !== 'string' || grant.targetUserId.length === 0) return undefined;
    const request = toAuthorizationRequest(grant);
    if (!request) return undefined;
    grants.push({ ...request, targetUserId: grant.targetUserId });
  }
  return grants;
}

/**
 * 快照交叉核对：契约 enums 必须等于 packages/shared 的登记值。
 * 返回差异描述数组（空数组＝一致）。
 */
export function diffEnumsSnapshot(enums: AuthzFixturesContract['enums']): string[] {
  const differences: string[] = [];
  const compare = (
    label: string,
    actual: readonly unknown[],
    expected: readonly string[],
  ): void => {
    const actualSet = new Set(actual);
    const expectedSet = new Set(expected);
    const missing = expected.filter((value) => !actualSet.has(value));
    const extra = [...actualSet].filter(
      (value) => typeof value !== 'string' || !expectedSet.has(value),
    );
    if (missing.length > 0) differences.push(`${label} 缺少: ${missing.join(', ')}`);
    if (extra.length > 0) differences.push(`${label} 多出: ${extra.map(String).join(', ')}`);
  };

  compare('roles', enums.roles, ROLE_VALUES);
  compare('dataScopes', enums.dataScopes, DATA_SCOPE_VALUES);
  compare('permissions', enums.permissions, PERMISSION_POINT_VALUES);

  for (const role of ROLE_VALUES) {
    const expectedScope = DEFAULT_ROLE_DATA_SCOPE[role];
    if (enums.roleDefaultScope[role] !== expectedScope) {
      differences.push(
        `roleDefaultScope.${role} 期望 ${expectedScope}，实际 ${String(enums.roleDefaultScope[role])}`,
      );
    }
  }
  return differences;
}

/** 夹具 id 必须唯一：重放时按 id 定位失败项 */
export function assertUniqueFixtureIds(contract: AuthzFixturesContract): void {
  const seen = new Set<string>();
  for (const fixture of [...contract.fixtures, ...contract.grantFixtures]) {
    if (seen.has(fixture.id)) throw new Error(`authz 契约夹具 id 重复: ${fixture.id}`);
    seen.add(fixture.id);
  }
}

/**
 * 仅用于测试断言：确认夹具自带的客户端声明确实与服务端解析结果不同（即确实是伪造）。
 *
 * 契约里的 `forged-client-claim` 夹具存在两种形态：声明单数 `role`（声称自己是负责人），
 * 或声明复数 `roles` 数组（声称自己是超管）。两者都必须被识别为「与服务端解析结果不同」，
 * 否则「客户端声明被忽略」这条断言会退化为恒真。
 */
export function clientClaimsLookForged(fixture: AuthzRawFixture): boolean {
  const claims = fixture.clientClaims;
  if (!claims) return false;

  const serverRoles = rolesOf(fixture.subject.roles);
  const claimedSingularRole: Role | undefined = isRole(claims.role) ? claims.role : undefined;
  const claimedPluralRoles = rolesOf(claims.roles);
  const roleDiffers =
    (claimedSingularRole !== undefined && !serverRoles.includes(claimedSingularRole)) ||
    claimedPluralRoles.some((role) => !serverRoles.includes(role));

  const serverScope: DataScope | undefined = isDataScope(fixture.request.scope)
    ? fixture.request.scope
    : undefined;
  const claimedScope: DataScope | undefined = isDataScope(claims.scope) ? claims.scope : undefined;
  const scopeDiffers = claimedScope !== undefined && claimedScope !== serverScope;

  // 伪造的组关系或资源归属同样算伪造：客户端不得自带归属信息
  const serverGroupIds = stringIdsOf(fixture.subject.groupIds);
  const claimedGroupDiffers =
    typeof claims.groupId === 'string' && !serverGroupIds.includes(claims.groupId);
  const serverResourceIds = stringIdsOf(fixture.subject.assignedResourceIds);
  const claimedResourceDiffers = asUnknownArray(claims.assignedResourceIds).some(
    (id) => typeof id !== 'string' || !serverResourceIds.includes(id),
  );

  return roleDiffers || scopeDiffers || claimedGroupDiffers || claimedResourceDiffers;
}

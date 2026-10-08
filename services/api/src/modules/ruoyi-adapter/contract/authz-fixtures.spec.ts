import { describe, expect, it } from 'vitest';
import {
  DEFAULT_ROLE_DATA_SCOPE,
  DATA_SCOPE_VALUES,
  PERMISSION_POINT_VALUES,
  ROLE_VALUES,
  canGrantPermissions,
  isAuthorized,
} from '@rm/shared';
import { AuthorizationPolicy } from '../../access-control/authorization-policy';
import { BaselineRuoYiAuthzAdapter } from '../ruoyi-adapter.baseline';
import { AUTHZ_CONTRACT_ID, AUTHZ_CONTRACT_VERSION } from './contract-identity';
import type { AuthzFixturesContract } from './authz-fixtures';
import {
  assertUniqueFixtureIds,
  clientClaimsLookForged,
  diffEnumsSnapshot,
  toAuthorizationRequest,
  toAuthorizationSubject,
  toPermissionGrants,
} from './authz-fixtures';
import { readAuthzFixturesContract } from './authz-fixtures-reader';

/**
 * 契约重放：把 services/ruoyi-api/contracts/authz-fixtures.json 的每条夹具
 * 同时喂给「基线谓词直调」与「RuoYi 兼容适配器」，断言两者都等于 expect.allowed。
 *
 * 这既是契约被真实执行的证据（而不是只被静态校验），也是「适配器只做委托、
 * 不引入第二套规则」的回归护栏：任何一侧偏离契约都会在这里失败。
 */

const contract: AuthzFixturesContract = readAuthzFixturesContract();
const policy = new AuthorizationPolicy();
const adapter = new BaselineRuoYiAuthzAdapter(policy);

function replayAuthorize(fixture: AuthzFixturesContract['fixtures'][number]): {
  direct: boolean;
  viaAdapter: boolean;
} {
  const subject = toAuthorizationSubject(fixture.subject);
  const request = toAuthorizationRequest(fixture.request);
  const direct =
    subject !== undefined && request !== undefined ? isAuthorized(subject, request) : false;
  const viaAdapter =
    subject !== undefined && request !== undefined
      ? adapter.checkAuthorization(subject, request).allowed
      : false;
  return { direct, viaAdapter };
}

function replayGrant(fixture: AuthzFixturesContract['grantFixtures'][number]): {
  direct: boolean;
  viaAdapter: boolean;
} {
  const actor = toAuthorizationSubject(fixture.actor);
  const grants = toPermissionGrants(fixture.grants);
  const direct =
    actor !== undefined && grants !== undefined ? canGrantPermissions(actor, grants) : false;
  const viaAdapter =
    actor !== undefined && grants !== undefined ? adapter.checkGrant(actor, grants).allowed : false;
  return { direct, viaAdapter };
}

describe('authz 契约夹具本身', () => {
  it('契约标识与版本符合适配器声明', () => {
    expect(contract.contract).toBe(AUTHZ_CONTRACT_ID);
    expect(contract.contractVersion).toBe(AUTHZ_CONTRACT_VERSION);
    expect(contract.contractVersion).toMatch(/^\d+\.\d+\.\d+$/u);
  });

  it('夹具 id 唯一且非空', () => {
    expect(() => assertUniqueFixtureIds(contract)).not.toThrow();
    expect(contract.fixtures.length).toBeGreaterThan(0);
    expect(contract.grantFixtures.length).toBeGreaterThan(0);
  });

  it('enums 快照与 packages/shared 的单一事实来源完全一致', () => {
    expect(diffEnumsSnapshot(contract.enums)).toEqual([]);
    expect([...contract.enums.roles]).toEqual([...ROLE_VALUES]);
    expect([...contract.enums.dataScopes]).toEqual([...DATA_SCOPE_VALUES]);
    expect([...contract.enums.permissions]).toEqual([...PERMISSION_POINT_VALUES]);
    for (const role of ROLE_VALUES) {
      expect(contract.enums.roleDefaultScope[role]).toBe(DEFAULT_ROLE_DATA_SCOPE[role]);
    }
  });

  it('每条夹具都带有 expect.allowed 与可读的 title', () => {
    for (const fixture of [...contract.fixtures, ...contract.grantFixtures]) {
      expect(typeof fixture.expect.allowed, `${fixture.id}.expect.allowed`).toBe('boolean');
      expect(typeof fixture.title, `${fixture.id}.title`).toBe('string');
    }
  });

  it('越权/非法用例都带 deniedBy 分类标签', () => {
    for (const fixture of [...contract.fixtures, ...contract.grantFixtures]) {
      if (!fixture.expect.allowed) {
        expect(typeof fixture.expect.deniedBy, `${fixture.id}.expect.deniedBy`).toBe('string');
      }
    }
  });
});

describe('授权契约重放（基线谓词 + RuoYi 兼容适配器）', () => {
  for (const fixture of contract.fixtures) {
    it(`authorize: ${fixture.id} → ${fixture.expect.allowed ? 'allow' : 'deny'}`, () => {
      const { direct, viaAdapter } = replayAuthorize(fixture);
      expect(direct, `${fixture.id} 基线谓词结果`).toBe(fixture.expect.allowed);
      expect(viaAdapter, `${fixture.id} 适配器结果`).toBe(fixture.expect.allowed);
    });
  }

  for (const fixture of contract.grantFixtures) {
    it(`grant: ${fixture.id} → ${fixture.expect.allowed ? 'allow' : 'deny'}`, () => {
      const { direct, viaAdapter } = replayGrant(fixture);
      expect(direct, `${fixture.id} 基线谓词结果`).toBe(fixture.expect.allowed);
      expect(viaAdapter, `${fixture.id} 适配器结果`).toBe(fixture.expect.allowed);
    });
  }
});

describe('客户端声明永不参与判定', () => {
  const forged = contract.fixtures.filter((fixture) => fixture.clientClaims !== undefined);

  it('夹具中确实存在伪造声明，且与服务端解析结果不同', () => {
    expect(forged.length).toBeGreaterThan(0);
    for (const fixture of forged) {
      expect(clientClaimsLookForged(fixture), `${fixture.id} 应当是伪造声明`).toBe(true);
    }
  });

  for (const fixture of forged) {
    it(`${fixture.id} 的判定与 clientClaims 无关`, () => {
      const subject = toAuthorizationSubject(fixture.subject);
      const request = toAuthorizationRequest(fixture.request);
      expect(subject).toBeDefined();
      expect(request).toBeDefined();
      if (!subject || !request) return;

      const withClaims = adapter.checkAuthorization(subject, request);
      const { clientClaims: _claims, ...withoutClaims } = fixture;
      const stripped = replayAuthorize(withoutClaims as typeof fixture);

      expect(withClaims.allowed).toBe(fixture.expect.allowed);
      expect(stripped.viaAdapter).toBe(withClaims.allowed);
      // 该夹具的判定必须实际被拒绝，才说明伪造声明没有生效
      expect(fixture.expect.allowed).toBe(false);
    });
  }
});

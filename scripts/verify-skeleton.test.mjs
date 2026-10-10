import test from 'node:test';
import assert from 'node:assert/strict';

import {
  containsForbiddenLegacyPermissionUsage,
  findLegacyPermissionTokens,
  runVerification,
} from './verify-skeleton.mjs';

test('ignores only an explicit prohibition reference', () => {
  assert.equal(
    containsForbiddenLegacyPermissionUsage('运行时不得使用 `export:*`。', 'export:*'),
    false,
  );
  assert.equal(
    containsForbiddenLegacyPermissionUsage('服务端不接受 `export:*` 作为运行时权限。', 'export:*'),
    false,
  );
});

test('two prohibited quoted references are both ignored', () => {
  assert.equal(
    containsForbiddenLegacyPermissionUsage(
      '运行时不得使用 `audit:delete`，也不得使用 `membership:group:review`。',
      'audit:delete',
    ),
    false,
  );
  assert.equal(
    containsForbiddenLegacyPermissionUsage(
      '运行时不得使用 `audit:delete`，也不得使用 `membership:group:review`。',
      'membership:group:review',
    ),
    false,
  );
});

test('mixed code and comment remains a real legacy permission use', () => {
  assert.equal(
    containsForbiddenLegacyPermissionUsage(
      'requiredPermission="export:*"; // export:*已废弃',
      'export:*',
    ),
    true,
  );
});

test('fails closed for legacy permissions used without prohibition', () => {
  assert.equal(
    containsForbiddenLegacyPermissionUsage('requiredPermission = "export:*";', 'export:*'),
    true,
  );
  assert.equal(
    containsForbiddenLegacyPermissionUsage('requiredPermission = "audit:delete";', 'audit:delete'),
    true,
  );
  assert.equal(
    containsForbiddenLegacyPermissionUsage(
      'grant membership:self:apply to the caller',
      'membership:self:apply',
    ),
    true,
  );
  assert.equal(
    containsForbiddenLegacyPermissionUsage(
      'grant membership:group:review to the caller',
      'membership:group:review',
    ),
    true,
  );
});

test('runVerification returns isolated results without CLI logging when requested', () => {
  const first = runVerification({ log: false });
  const second = runVerification({ log: false });
  assert.deepEqual(second, first);
  assert.notStrictEqual(second.failures, first.failures);
  assert.notStrictEqual(second.warnings, first.warnings);
});

test('importing the verifier does not set a CLI exit code', () => {
  assert.equal(process.exitCode, undefined);
});

test('does not treat unrelated strings or longer identifiers as token hits', () => {
  assert.equal(
    containsForbiddenLegacyPermissionUsage('export:profile:create is allowed.', 'export:*'),
    false,
  );
  assert.equal(containsForbiddenLegacyPermissionUsage('legacy_export:*_suffix', 'export:*'), false);
  assert.equal(findLegacyPermissionTokens('export:* export:*:extra', 'export:*').length, 1);
});

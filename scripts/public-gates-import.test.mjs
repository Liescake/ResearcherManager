import test from 'node:test';
import assert from 'node:assert/strict';

for (const script of [
  './db-migrations-lint.mjs',
  './openapi-contract-lint.mjs',
  './docker-packaging-check.mjs',
]) {
  test(`${script} import has no CLI side effects`, async () => {
    const before = process.exitCode;
    const first = await import(`${script}?test=first-${encodeURIComponent(script)}`);
    const second = await import(`${script}?test=second-${encodeURIComponent(script)}`);
    assert.ok(first);
    assert.ok(second);
    assert.equal(process.exitCode, before);
  });
}

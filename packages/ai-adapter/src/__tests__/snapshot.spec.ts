import { describe, expect, it } from 'vitest';
import { computeInputSnapshotHash, stableStringify } from '../audit/snapshot';
import { validBundle } from './fixtures';

describe('输入快照摘要', () => {
  it('对象键顺序不影响摘要（同一输入同一摘要）', () => {
    expect(computeInputSnapshotHash({ a: 1, b: { c: 2, d: 3 } })).toBe(
      computeInputSnapshotHash({ b: { d: 3, c: 2 }, a: 1 }),
    );
  });

  it('内容变化会改变摘要', () => {
    expect(computeInputSnapshotHash({ a: 1 })).not.toBe(computeInputSnapshotHash({ a: 2 }));
  });

  it('对匹配输入产出稳定的 64 位十六进制摘要', () => {
    const hash = computeInputSnapshotHash(validBundle());
    expect(hash).toMatch(/^[0-9a-f]{64}$/u);
    expect(hash).toBe(computeInputSnapshotHash(validBundle()));
  });

  it('稳定序列化忽略 undefined 字段但保留数组顺序', () => {
    expect(stableStringify({ a: undefined, b: [2, 1] })).toBe('{"b":[2,1]}');
  });
});

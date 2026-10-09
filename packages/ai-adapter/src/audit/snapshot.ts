import { createHash } from 'node:crypto';

function sha256(value: string): string {
  // Node's statically imported implementation works in both Node and Vitest.
  return createHash('sha256').update(value).digest('hex');
}

/**
 * 输入快照摘要（ai_match_records.input_snapshot_hash）：
 * 只保存摘要，不保存原始画像或提示词原文（P2 §6 安全边界）。
 */

/** 稳定序列化：对象键排序、数组保持顺序，保证同一输入得到同一摘要 */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value) ?? 'null';
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return `{${entries
    .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`)
    .join(',')}}`;
}

export function computeInputSnapshotHash(snapshot: unknown): string {
  return sha256(stableStringify(snapshot));
}

import { describe, expect, it } from 'vitest';
import { formatDateTime, formatPercent, formatShortId, formatUptimeSeconds } from './format';

describe('展示格式化', () => {
  it('运行时长按量级展示', () => {
    expect(formatUptimeSeconds(45)).toBe('45 秒');
    expect(formatUptimeSeconds(125)).toBe('2 分 5 秒');
    expect(formatUptimeSeconds(3725)).toBe('1 小时 2 分');
    expect(formatUptimeSeconds(90000)).toBe('1 天 1 小时');
    expect(formatUptimeSeconds(Number.NaN)).toBe('未知');
    expect(formatUptimeSeconds(-1)).toBe('未知');
  });

  it('分母为 0 的比率显示「暂无数据」而不是 0%', () => {
    expect(formatPercent(null)).toBe('暂无数据');
    expect(formatPercent(0)).toBe('0.0%');
    expect(formatPercent(2 / 3)).toBe('66.7%');
    expect(formatPercent(1, 0)).toBe('100%');
  });

  it('时间格式非法时显示占位符', () => {
    expect(formatDateTime(null)).toBe('—');
    expect(formatDateTime('not-a-date')).toBe('—');
    expect(formatDateTime('2026-01-01T00:00:00.000Z')).toContain('2026');
  });

  it('长 ID 截断展示，空值显示占位符', () => {
    expect(formatShortId('00000000-0000-4000-8000-000000000001')).toBe('00000000…');
    expect(formatShortId('short')).toBe('short');
    expect(formatShortId('')).toBe('—');
    expect(formatShortId(null)).toBe('—');
    expect(formatShortId('abcdefghij', 3)).toBe('abc…');
  });
});

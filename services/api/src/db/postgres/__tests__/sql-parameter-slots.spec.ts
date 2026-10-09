import { describe, expect, it } from 'vitest';
import {
  assertQueryParameterSlots,
  inspectSqlParameterSlots,
  SqlParameterSlotError,
} from '../sql-parameter-slots';

/**
 * 参数槽静态检查：本文件把「值只走占位符绑定」从口号变成可机器判定的事实。
 *
 * 用例覆盖三类真实事故：
 * 1. **参数错位**（`$3` 与 `$1` 混用）：在数据上表现为「读到了别人的行」，而不是报错；
 * 2. **静默 NULL**（声明 2 个槽只传 1 个参数）：多数驱动不报错；
 * 3. **误判**（字符串字面量 / 注释 / dollar-quoted 块里的 `$1` 被当成占位符）：
 *    会造成「合法 SQL 被拒绝」或「真正缺失的槽位被掩盖」。
 */
describe('inspectSqlParameterSlots：占位符识别', () => {
  it('识别连续占位符并按序号去重升序', () => {
    const report = inspectSqlParameterSlots('SELECT $1, $2, $1 FROM t WHERE a = $3');
    expect(report.slots).toEqual([1, 2, 3]);
    expect(report.occurrences).toBe(4);
    expect(report.duplicates).toEqual([1]);
    expect(report.contiguous).toBe(false);
  });

  it('字符串字面量 / 行注释 / 块注释 / 双引号标识符 / dollar-quoted 块里的 $n 都不算占位符', () => {
    const sql = [
      'SELECT \'$1 is literal\' AS a, "$2col" AS b -- $3 comment',
      '/* $4 block comment */',
      '$$ $5 dollar quoted $$',
      '$tag$ $6 tagged $tag$',
      'FROM t WHERE id = $1',
    ].join('\n');
    const report = inspectSqlParameterSlots(sql);
    expect(report.slots).toEqual([1]);
    expect(report.occurrences).toBe(1);
  });

  it('${...} 模板占位符与 $identifier 不被当成绑定槽位', () => {
    const report = inspectSqlParameterSlots('SELECT ${injected}, $foo, $1 FROM t');
    expect(report.slots).toEqual([1]);
  });
});

describe('assertQueryParameterSlots：fail-closed 配对', () => {
  it('合法配对（含省略参数）放行', () => {
    expect(() => assertQueryParameterSlots('SELECT 1', undefined)).not.toThrow();
    expect(() => assertQueryParameterSlots('SELECT $1, $2', ['a', 'b'])).not.toThrow();
  });

  it('$0 与重复序号一律拒绝', () => {
    expect(() => assertQueryParameterSlots('SELECT $0', [1])).toThrow(SqlParameterSlotError);
    try {
      assertQueryParameterSlots('SELECT $1, $1', ['a', 'b']);
      throw new Error('期望抛错');
    } catch (error) {
      expect(error).toBeInstanceOf(SqlParameterSlotError);
      expect((error as SqlParameterSlotError).issues.map((item) => item.code)).toContain(
        'PARAMETER_SLOT_DUPLICATE',
      );
    }
  });

  it('缺号（$1 与 $3 混用）判 PARAMETER_SLOT_GAP，不把值绑到不确定的槽位', () => {
    try {
      assertQueryParameterSlots('SELECT $1, $3', ['a', 'b']);
      throw new Error('期望抛错');
    } catch (error) {
      expect(error).toBeInstanceOf(SqlParameterSlotError);
      const codes = (error as SqlParameterSlotError).issues.map((item) => item.code);
      expect(codes).toContain('PARAMETER_SLOT_GAP');
    }
  });

  it('声明槽位与传入参数数量不符判 PARAMETER_COUNT_MISMATCH（两个方向都要拦）', () => {
    for (const [sql, parameters] of [
      ['SELECT $1, $2', ['only-one']],
      ['SELECT $1', ['a', 'b']],
      ['SELECT 1', ['unexpected']],
    ] as const) {
      try {
        assertQueryParameterSlots(sql, parameters);
        throw new Error('期望抛错');
      } catch (error) {
        expect(error).toBeInstanceOf(SqlParameterSlotError);
        expect((error as SqlParameterSlotError).issues.map((item) => item.code)).toContain(
          'PARAMETER_COUNT_MISMATCH',
        );
      }
    }
  });

  it('错误信息只含序号与个数，不回显 SQL 文本或参数取值', () => {
    try {
      assertQueryParameterSlots('SELECT $1 -- secret-table', ['13800000000', 'second']);
      throw new Error('期望抛错');
    } catch (error) {
      const message = (error as Error).message;
      expect(message).not.toContain('secret-table');
      expect(message).not.toContain('13800000000');
      expect(message).toContain('PARAMETER_COUNT_MISMATCH');
    }
  });
});

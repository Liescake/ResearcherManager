import { describe, expect, it } from 'vitest';
import {
  describeRedactedError,
  redactPostgresError,
  redactPostgresErrorText,
} from '../postgres-error';

/**
 * 统一错误脱敏：把「驱动异常里什么可以外发」固定下来。
 *
 * 真实的 `pg` 异常会带 `message` / `detail` / `hint` / `where` / `query`：其中 `detail` 与 `where`
 * 可能直接**包含行取值**（唯一约束冲突会报 `<value> already exists`），`message` 在连接失败时
 * 可能包含连接串。这些字段进入了会冒泡到 500 响应与日志的路径，因此必须逐项验证被剥离。
 */
const FAKE_URL = 'postgresql://rm_user:sup3r-s3cret@db.example.com:5432/researcher_manager';
const FAKE_PASSWORD = 'sup3r-s3cret';

describe('redactPostgresErrorText：擦除机密与截断', () => {
  it('擦除连接串 userinfo 与查询串口令键值', () => {
    expect(redactPostgresErrorText(FAKE_URL)).toBe(
      'postgresql://***@db.example.com:5432/researcher_manager',
    );
    expect(redactPostgresErrorText('failed password=abc123 host=x')).toContain('password=***');
    expect(redactPostgresErrorText('failed password=abc123 host=x')).not.toContain('abc123');
  });

  it('擦除调用方登记的秘密片段（同一片段出现多次也全部替换）', () => {
    const text = `auth failed for ${FAKE_PASSWORD} (${FAKE_PASSWORD})`;
    const redacted = redactPostgresErrorText(text, [FAKE_PASSWORD]);
    expect(redacted).not.toContain(FAKE_PASSWORD);
    expect(redacted).toContain('***');
  });

  it('折叠空白并截断超长文本（避免把整段 SQL 带出来）', () => {
    const long = `x ${'y'.repeat(500)}`;
    const redacted = redactPostgresErrorText(long);
    expect(redacted.length).toBeLessThanOrEqual(241);
    expect(redacted).not.toContain('\n');
  });
});

describe('redactPostgresError：只保留可外发的结构事实', () => {
  it('保留 SQLSTATE / severity / routine 与结构名，丢弃 detail / hint / where / query', () => {
    const redacted = redactPostgresError(
      {
        code: '23505',
        severity: 'ERROR',
        routine: '_bt_check_unique',
        schema: 'public',
        table: 'achievements',
        column: 'user_id',
        constraint: 'achievements_pkey',
        message: 'duplicate key value violates unique constraint "achievements_pkey"',
        detail: 'Key (id)=(11111111-1111-1111-1111-111111111111) already exists.',
        hint: 'hint-with-value 13800000000',
        where: 'SQL statement "INSERT ... VALUES (13800000000)"',
        query: 'INSERT INTO achievements VALUES ($1)',
      },
      [FAKE_PASSWORD],
    );

    expect(redacted.sqlState).toBe('23505');
    expect(redacted.severity).toBe('ERROR');
    expect(redacted.constraint).toBe('achievements_pkey');
    expect(redacted.table).toBe('achievements');

    const serialized = JSON.stringify(redacted);
    for (const leaked of [
      '11111111-1111-1111-1111-111111111111',
      '13800000000',
      'INSERT INTO',
      'hint-with-value',
    ]) {
      expect(serialized).not.toContain(leaked);
    }
    expect(redacted).not.toHaveProperty('detail');
    expect(redacted).not.toHaveProperty('hint');
    expect(redacted).not.toHaveProperty('where');
    expect(redacted).not.toHaveProperty('query');
  });

  it('连接失败信息里的口令被擦除', () => {
    const redacted = redactPostgresError({
      code: 'ECONNREFUSED',
      message: `connect ECONNREFUSED for ${FAKE_URL}`,
    });
    expect(redacted.description).not.toContain(FAKE_PASSWORD);
    expect(redacted.description).not.toContain('rm_user');
  });

  it('非对象 / 字符串 / null 输入都安全降级，不回显原文结构之外的内容', () => {
    expect(redactPostgresError(undefined).description).toBe('数据库驱动抛出未识别错误');
    expect(redactPostgresError('boom').description).toBe('boom');
    expect(redactPostgresError({}).description).toBe('数据库驱动抛出未识别错误');
  });

  it('describeRedactedError 只产出 SQLSTATE 与结构名（无自由文本）', () => {
    const issue = describeRedactedError(
      redactPostgresError({ code: '42P01', table: 'missing_table', message: 'relation missing' }),
    );
    expect(issue.code).toBe('42P01');
    expect(issue.detail).toContain('table=missing_table');
    expect(issue.detail).not.toContain('relation missing');
  });
});

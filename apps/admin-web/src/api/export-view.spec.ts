import { describe, expect, it } from 'vitest';
import { INVALID_RESPONSE_CODE } from './client';
import {
  buildExportCursorQuery,
  contractError,
  mergeRevokedViews,
  readExportPage,
  readExportView,
} from './export-view';
import { EXPORT_STATUS_LABELS, exportStatusLabel, isExportRevocableStatus } from './types';
import type { ExportRequestView } from './types';

const VIEW: ExportRequestView = {
  id: '00000000-0000-4000-8000-000000000001',
  resource: 'profile',
  fields: ['name', 'grade'],
  status: 'pending',
  createdAt: '2026-10-10T01:00:00.000Z',
  updatedAt: '2026-10-10T02:00:00.000Z',
};

function view(overrides: Partial<ExportRequestView> = {}): ExportRequestView {
  return { ...VIEW, fields: [...VIEW.fields], ...overrides };
}

describe('导出视图白名单读取', () => {
  it('只保留白名单字段：归属 / 产物句柄 / 路径 / 有效期即使出现也不进入界面', () => {
    const parsed = readExportView({
      ...VIEW,
      ownerUserId: '99999999-0000-4000-8000-000000000001',
      artifactId: 'aaaaaaaa-0000-4000-8000-000000000001',
      expiresAt: '2026-11-01T00:00:00.000Z',
      fileUrl: 'https://example.invalid/secret.zip',
      downloadUrl: '/api/v1/me/exports/x/download',
      path: '/var/artifacts/1.zip',
      revokedAt: '2026-10-11T00:00:00.000Z',
    });

    expect(parsed).not.toBeNull();
    expect(Object.keys(parsed ?? {}).sort()).toEqual([
      'createdAt',
      'fields',
      'id',
      'resource',
      'status',
      'updatedAt',
    ]);
    // 额外字段的**取值**一个都没有被带进来
    expect(JSON.stringify(parsed)).not.toContain('artifact');
    expect(JSON.stringify(parsed)).not.toContain('example.invalid');
    expect(JSON.stringify(parsed)).not.toContain('99999999');
  });

  it('fields 返回副本：就地修改不污染上游对象', () => {
    const parsed = readExportView(VIEW);
    parsed?.fields.push('注入字段');
    expect(VIEW.fields).toEqual(['name', 'grade']);
  });

  it('形态非法一律返回 null（fail-closed），绝不当成一条合法记录', () => {
    expect(readExportView(null)).toBeNull();
    expect(readExportView([])).toBeNull();
    expect(readExportView('pending')).toBeNull();
    expect(readExportView({ ...VIEW, id: '' })).toBeNull();
    expect(readExportView({ ...VIEW, status: 1 })).toBeNull();
    expect(readExportView({ ...VIEW, fields: [] })).toBeNull();
    expect(readExportView({ ...VIEW, fields: ['name', 2] })).toBeNull();
    const missing: Record<string, unknown> = { ...VIEW };
    delete missing['updatedAt'];
    expect(readExportView(missing)).toBeNull();
  });
});

describe('导出列表一页的读取', () => {
  it('采信服务端 meta（limit / hasNext / nextCursor）', () => {
    const page = readExportPage([VIEW], { limit: 20, hasNext: true, nextCursor: 'opaque-cursor' });
    expect(page).not.toBeNull();
    expect(page?.items).toHaveLength(1);
    expect(page?.limit).toBe(20);
    expect(page?.hasNext).toBe(true);
    expect(page?.nextCursor).toBe('opaque-cursor');
  });

  it('meta 缺失时 limit 为 null、hasNext 为 false、nextCursor 为 null（不推算）', () => {
    const page = readExportPage([VIEW], {});
    expect(page?.limit).toBeNull();
    expect(page?.hasNext).toBe(false);
    expect(page?.nextCursor).toBeNull();
  });

  it('data 为 null 是空集（服务端空页），不是崩溃', () => {
    const page = readExportPage(null, { hasNext: false, nextCursor: null });
    expect(page?.items).toEqual([]);
  });

  it('任一行非法即整页拒绝：绝不「悄悄少展示一条记录」', () => {
    expect(readExportPage([VIEW, { ...VIEW, id: 7 }], {})).toBeNull();
    expect(readExportPage({ items: [VIEW] }, {})).toBeNull();
  });

  it('hasNext 与 nextCursor 不自洽即按契约违规拒绝（不猜还有没有下一页）', () => {
    expect(readExportPage([VIEW], { hasNext: true, nextCursor: null })).toBeNull();
    expect(readExportPage([VIEW], { hasNext: false, nextCursor: 'cursor' })).toBeNull();
  });

  it('非法 limit（0 / 负数 / 小数 / 字符串）不进入界面：显示为「未提供」', () => {
    for (const limit of [0, -1, 1.5, '20']) {
      expect(readExportPage([VIEW], { limit })?.limit).toBeNull();
    }
  });
});

describe('契约错误与游标查询串', () => {
  it('契约违规复用既有稳定错误码（HTTP 层可能仍是 200）', () => {
    const error = contractError();
    expect(error.code).toBe(INVALID_RESPONSE_CODE);
    expect(error.status).toBe(200);
  });

  it('无游标时**不带查询串**；有游标时只带 cursor（服务端没有别的列表参数）', () => {
    expect(buildExportCursorQuery({})).toBe('');
    expect(buildExportCursorQuery({ cursor: '   ' })).toBe('');
    expect(buildExportCursorQuery({ cursor: 'a/b+c' })).toBe('?cursor=a%2Fb%2Bc');
    // 刻意没有 limit / status / userId 的口子
    expect(buildExportCursorQuery({ cursor: 'c' })).not.toContain('limit');
  });
});

describe('撤销结果的本地合并', () => {
  it('按 id 用服务端返回的视图覆盖原条目，其它条目原样保留', () => {
    const other = view({ id: '00000000-0000-4000-8000-000000000002', status: 'failed' });
    const revoked = view({ status: 'revoked' });
    const merged = mergeRevokedViews([VIEW, other], { [VIEW.id]: revoked });
    expect(merged[0]?.status).toBe('revoked');
    expect(merged[1]).toBe(other);
  });

  it('没有本地撤销记录时返回等价内容（不改变顺序）', () => {
    const merged = mergeRevokedViews([VIEW], {});
    expect(merged).toHaveLength(1);
    expect(merged[0]?.status).toBe('pending');
  });
});

describe('导出状态与可撤销闭集', () => {
  it('只有 pending / completed 可撤销，failed / expired / revoked / 未知取值都不可以', () => {
    expect(isExportRevocableStatus('pending')).toBe(true);
    expect(isExportRevocableStatus('completed')).toBe(true);
    for (const status of ['failed', 'expired', 'revoked', 'cancelled', '', undefined, null, 1]) {
      expect(isExportRevocableStatus(status)).toBe(false);
    }
  });

  it('已知状态有确定文案；未知取值按「未知状态（原值）」呈现，不猜成已知结论', () => {
    expect(exportStatusLabel('revoked')).toBe(EXPORT_STATUS_LABELS.revoked);
    expect(exportStatusLabel('failed')).toBe('生成失败');
    expect(exportStatusLabel('expired')).toBe('已过期');
    expect(exportStatusLabel('cancelled')).toBe('未知状态（cancelled）');
  });
});

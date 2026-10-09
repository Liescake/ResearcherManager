import {
  APPLICATION_STATUS_LABELS,
  APPLICATION_STATUS_VALUES,
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  applicationStatusLabel,
} from '@rm/shared';
import type { ApplicationStatus } from '@rm/shared';
import { useState, type ReactNode } from 'react';
import { ENDPOINTS, endpointRef } from '../api/endpoints';
import type { AdminApplicationListItem } from '../api/types';
import { useAuth } from '../auth/AuthContext';
import { AsyncStateView } from '../components/AsyncStateView';
import { useLoader } from '../state/useLoader';
import { buildHash } from '../router/hash-router';
import { ROUTES } from '../router/routes';
import { formatDateTime, formatShortId } from '../lib/format';

/** 申请类型没有共享标签（共享只提供枚举），展示文案在本地集中维护 */
const KIND_LABELS: Readonly<Record<string, string>> = {
  join: '入组申请',
  leave: '退组申请',
};

function reviewHash(applicationId: string): string {
  return buildHash(`${ROUTES.reviews.path}/${encodeURIComponent(applicationId)}`);
}

/**
 * 管理端申请列表页。
 *
 * 关键约定：
 * - 过滤/分页参数全部由**服务端**解释（这里只是把它们拼进查询串），演示模式走与后端同构的分页语义；
 * - 「总数」在响应 meta 缺失时显示「未提供」，绝不用当前页条数冒充总数；
 * - 每行的「审核」只是跳到预留路由，**不在这里提交任何审核动作**：
 *   审核是写操作，必须由后端审核切片定义决策、理由与资源版本后接入。
 */
export function ApplicationsPage(): ReactNode {
  const { gateway } = useAuth();
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState<number>(DEFAULT_PAGE_SIZE);
  const [status, setStatus] = useState<'' | ApplicationStatus>('');
  const [keyword, setKeyword] = useState('');

  const applications = useLoader(
    () =>
      gateway.loadApplications({
        page,
        pageSize,
        ...(status === '' ? {} : { status }),
        ...(keyword.trim() === '' ? {} : { keyword: keyword.trim() }),
      }),
    [gateway, page, pageSize, status, keyword],
    { endpoint: endpointRef(ENDPOINTS.adminApplications) },
  );

  const filtered = status !== '' || keyword.trim() !== '';

  return (
    <div className="page">
      <header className="page__header">
        <div>
          <h1>申请列表</h1>
          <p className="muted">
            <code>{endpointRef(ENDPOINTS.adminApplications)}</code>
            ：后端审核切片实现中，联调模式下这里会如实显示「端点尚未实现」。
          </p>
        </div>
      </header>

      <section className="card" aria-labelledby="filter-title">
        <h2 id="filter-title">筛选</h2>
        <form
          className="filter"
          onSubmit={(event) => {
            event.preventDefault();
            setPage(1);
            applications.reload();
          }}
        >
          <label htmlFor="status-filter">状态</label>
          <select
            id="status-filter"
            value={status}
            onChange={(event) => {
              setStatus(event.target.value === '' ? '' : (event.target.value as ApplicationStatus));
              setPage(1);
            }}
          >
            <option value="">全部</option>
            {APPLICATION_STATUS_VALUES.map((value) => (
              <option key={value} value={value}>
                {APPLICATION_STATUS_LABELS[value]}
              </option>
            ))}
          </select>

          <label htmlFor="keyword-filter">关键词</label>
          <input
            id="keyword-filter"
            value={keyword}
            maxLength={50}
            placeholder="申请人 / 小组 / 备注（最多 50 字）"
            onChange={(event) => {
              setKeyword(event.target.value);
              setPage(1);
            }}
          />

          <label htmlFor="page-size-filter">每页</label>
          <select
            id="page-size-filter"
            value={String(pageSize)}
            onChange={(event) => {
              setPageSize(Number(event.target.value));
              setPage(1);
            }}
          >
            {[20, 50, MAX_PAGE_SIZE].map((size) => (
              <option key={size} value={String(size)}>
                {size}
              </option>
            ))}
          </select>

          <button type="submit" className="button--secondary">
            重新加载
          </button>
        </form>
        <p className="muted">
          服务端强制 pageSize 上限 <strong>{MAX_PAGE_SIZE}</strong>
          ；前端不做任何过滤或排序的本地兜底， 以免与服务端口径不一致。
        </p>
      </section>

      <section className="card" aria-labelledby="list-title">
        <h2 id="list-title">申请记录</h2>
        <AsyncStateView
          state={applications.state}
          descriptor={ENDPOINTS.adminApplications}
          label="申请列表"
          notFound="pending"
          onRetry={applications.reload}
          isEmpty={(data) => data.items.length === 0}
          emptyTitle={filtered ? '没有符合筛选条件的申请' : '当前没有申请记录'}
          emptyDescription={
            filtered
              ? '尝试放宽状态或关键词；空结果也可能是数据范围（scope）内确实没有记录。'
              : '服务端在授权范围内返回了 0 条记录，这是合法的空集，不是错误。'
          }
        >
          {(data) => (
            <>
              <p className="muted">
                第 {data.page} 页
                {data.total === null ? (
                  <>
                    ，<strong>总数未提供</strong>（响应 meta 缺少 total，前端不推算）
                  </>
                ) : (
                  <>
                    ，共 {data.total} 条（
                    {data.totalPages === null ? '总页数未提供' : `${data.totalPages} 页`}）
                  </>
                )}
              </p>
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>申请 ID</th>
                      <th>申请人</th>
                      <th>申请小组</th>
                      <th>类型</th>
                      <th>状态</th>
                      <th>备注</th>
                      <th>创建时间</th>
                      <th>操作</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.items.map((item) => (
                      <ApplicationRow key={item.id} item={item} />
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="pager">
                <button
                  type="button"
                  className="button--secondary"
                  onClick={() => setPage((value) => Math.max(1, value - 1))}
                  disabled={data.page <= 1}
                >
                  上一页
                </button>
                <button
                  type="button"
                  className="button--secondary"
                  onClick={() => setPage((value) => value + 1)}
                  disabled={
                    data.totalPages === null
                      ? data.items.length < data.pageSize
                      : data.page >= data.totalPages
                  }
                >
                  下一页
                </button>
                {data.totalPages !== null && data.totalPages > 1 && (
                  <span className="muted">
                    第 {data.page} / {data.totalPages} 页
                  </span>
                )}
              </div>
            </>
          )}
        </AsyncStateView>
      </section>

      <details className="card">
        <summary>申请状态机参考（来自 @rm/shared，只读）</summary>
        <p className="muted">
          后端按白名单校验状态转移；前端按钮状态不构成控制。审核动作属于后端审核切片。
        </p>
        <table>
          <thead>
            <tr>
              <th>状态</th>
              <th>中文</th>
            </tr>
          </thead>
          <tbody>
            {APPLICATION_STATUS_VALUES.map((value) => (
              <tr key={value}>
                <td>
                  <code>{value}</code>
                </td>
                <td>{APPLICATION_STATUS_LABELS[value]}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </div>
  );
}

function ApplicationRow({ item }: { item: AdminApplicationListItem }): ReactNode {
  return (
    <tr>
      <td>
        <code title={item.id}>{formatShortId(item.id)}</code>
      </td>
      <td>{item.applicantName ?? '—'}</td>
      <td>{item.groupName ?? '—'}</td>
      <td>{KIND_LABELS[item.kind] ?? item.kind}</td>
      <td>{applicationStatusLabel(item.status)}</td>
      <td>{item.note ?? '—'}</td>
      <td>{formatDateTime(item.createdAt)}</td>
      <td>
        <a href={reviewHash(item.id)}>审核（预留）</a>
      </td>
    </tr>
  );
}

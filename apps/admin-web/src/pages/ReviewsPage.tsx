import {
  APPLICATION_STATUS_LABELS,
  ApplicationStatus,
  ReviewDecision,
  REVIEW_DECISION_LABELS,
  applicationStatusLabel,
} from '@rm/shared';
import { useState, type ReactNode } from 'react';
import { ENDPOINTS, endpointRef } from '../api/endpoints';
import { useAuth } from '../auth/AuthContext';
import { AsyncStateView } from '../components/AsyncStateView';
import { PendingEndpointPanel } from '../components/StatePanel';
import { useLoader } from '../state/useLoader';
import { buildHash } from '../router/hash-router';
import { ROUTES } from '../router/routes';
import { formatDateTime, formatShortId } from '../lib/format';

/**
 * 预留的审核路由（列表 + 详情）。
 *
 * 为什么是「预留」而不是「先做出来」：审核是**写操作**，契约要求提交
 * `decision` + `reason`（驳回必填）+ 资源版本，并返回成员关系变化摘要与审计事件 ID。
 * 这些语义由并行的后端审核切片定义；在前端提前实现只会造出「点了按钮显示成功但没有写入」的假象，
 * 那正是本项目明确禁止的。
 *
 * 本页因此只做三件真实的事：
 * 1. 把待审核队列的**读取**入口准备好（演示模式下用夹具只读展示）；
 * 2. 把审核动作的**契约要求**摆在界面上，供后端切片对齐；
 * 3. 明确标注哪些能力尚未接入，绝不出现可提交却无效果的按钮。
 */

const KIND_LABELS: Readonly<Record<string, string>> = {
  join: '入组申请',
  leave: '退组申请',
};

export function ReviewsPage(): ReactNode {
  const { gateway } = useAuth();

  const queue = useLoader(
    () => gateway.loadApplications({ page: 1, pageSize: 20, status: ApplicationStatus.Pending }),
    [gateway],
    { endpoint: endpointRef(ENDPOINTS.adminApplications) },
  );

  return (
    <div className="page">
      <header className="page__header">
        <div>
          <h1>申请审核（预留）</h1>
          <p className="muted">
            路由与读取入口已就绪；审核动作等待后端审核切片落地后接入，当前不提供任何提交入口。
          </p>
        </div>
      </header>

      <section className="card" aria-labelledby="review-boundary-title">
        <h2 id="review-boundary-title">审核边界</h2>
        <PendingEndpointPanel descriptor={ENDPOINTS.adminApplicationReview} />
        <ul className="muted">
          <li>
            请求必须包含 <code>decision</code>、<code>reason</code>（驳回必填）与资源版本；
          </li>
          <li>响应返回申请状态、成员关系变化摘要与审计事件 ID；</li>
          <li>
            注意口径差异：契约基线写作 <code>decision=approved|rejected</code>，而共享枚举
            <code>ReviewDecision</code> 的取值是
            {REVIEW_DECISION_VALUES_TEXT}（{REVIEW_DECISION_LABELS[ReviewDecision.Approve]}、
            {REVIEW_DECISION_LABELS[ReviewDecision.Reject]}）——两者需要在后端切片落地时对齐，
            前端不擅自选择其一。
          </li>
          <li>
            权限点：<code>{ENDPOINTS.adminApplicationReview.permissions.join(' 或 ')}</code>
            ，数据范围由服务端计算。
          </li>
        </ul>
      </section>

      <section className="card" aria-labelledby="review-queue-title">
        <h2 id="review-queue-title">待审核队列（只读）</h2>
        <p className="muted">
          <code>{endpointRef(ENDPOINTS.adminApplications)}?status=pending</code>
          ：只读取，不提供审核动作。
        </p>
        <AsyncStateView
          state={queue.state}
          descriptor={ENDPOINTS.adminApplications}
          label="待审核队列"
          notFound="pending"
          onRetry={queue.reload}
          isEmpty={(data) => data.items.length === 0}
          emptyTitle="当前没有待审核申请"
          emptyDescription="服务端在授权范围内返回了 0 条待审核记录。"
        >
          {(data) => (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>申请 ID</th>
                    <th>申请人</th>
                    <th>申请小组</th>
                    <th>类型</th>
                    <th>状态</th>
                    <th>提交时间</th>
                    <th>详情</th>
                  </tr>
                </thead>
                <tbody>
                  {data.items.map((item) => (
                    <tr key={item.id}>
                      <td>
                        <code title={item.id}>{formatShortId(item.id)}</code>
                      </td>
                      <td>{item.applicantName ?? '—'}</td>
                      <td>{item.groupName ?? '—'}</td>
                      <td>{KIND_LABELS[item.kind] ?? item.kind}</td>
                      <td>{applicationStatusLabel(item.status)}</td>
                      <td>{formatDateTime(item.createdAt)}</td>
                      <td>
                        <a
                          href={buildHash(`${ROUTES.reviews.path}/${encodeURIComponent(item.id)}`)}
                        >
                          查看（预留）
                        </a>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </AsyncStateView>
      </section>
    </div>
  );
}

/** 契约基线与共享枚举的口径差异：只陈述事实，不在前端选定口径 */
const REVIEW_DECISION_VALUES_TEXT = 'approve / reject';

export function ReviewDetailPage({ applicationId }: { applicationId: string }): ReactNode {
  const [decision, setDecision] = useState<ReviewDecision>(ReviewDecision.Approve);
  const [reason, setReason] = useState('');

  return (
    <div className="page">
      <header className="page__header">
        <div>
          <h1>审核详情（预留）</h1>
          <p className="muted">
            申请 <code title={applicationId}>{formatShortId(applicationId)}</code>
            ：本页只呈现审核动作的契约要求，提交入口在审核切片落地前保持禁用。
          </p>
        </div>
        <a href={buildHash(ROUTES.reviews.path)}>← 返回待审核队列</a>
      </header>

      <section className="card" aria-labelledby="detail-boundary-title">
        <h2 id="detail-boundary-title">尚未接入的端点</h2>
        <PendingEndpointPanel descriptor={ENDPOINTS.adminApplicationReview} />
        <p className="muted">
          契约基线未定义申请详情读取端点（只有列表与审核动作），因此本页不显示任何申请内容——
          没有数据来源时用占位数据填充，等于伪造业务事实。
        </p>
      </section>

      <section className="card" aria-labelledby="detail-form-title">
        <h2 id="detail-form-title">审核表单（预览，不可提交）</h2>
        <form className="form" onSubmit={(event) => event.preventDefault()}>
          <label htmlFor="decision">审核决定</label>
          <select
            id="decision"
            value={decision}
            disabled
            onChange={(event) => setDecision(event.target.value as ReviewDecision)}
          >
            <option value={ReviewDecision.Approve}>
              {REVIEW_DECISION_LABELS[ReviewDecision.Approve]}
            </option>
            <option value={ReviewDecision.Reject}>
              {REVIEW_DECISION_LABELS[ReviewDecision.Reject]}
            </option>
          </select>

          <label htmlFor="reason">审核理由（驳回必填）</label>
          <textarea
            id="reason"
            value={reason}
            rows={3}
            maxLength={500}
            disabled
            placeholder="审核切片上线后填写；服务端会校验长度与内容安全"
            onChange={(event) => setReason(event.target.value)}
          />

          <p className="muted">
            待接入字段：资源版本（乐观锁）、幂等键 <code>Idempotency-Key</code>、审计事件 ID 回执。
          </p>
          <button type="submit" disabled title="后端审核切片未上线">
            提交审核（后端未接入）
          </button>
        </form>
        <p className="muted">
          按钮为禁用状态是刻意设计：宁可让使用者看到「还不能用」，也不制造「点了就成功」的假象。
          当前申请状态：{APPLICATION_STATUS_LABELS[ApplicationStatus.Pending]}
          （状态机由服务端裁决）。
        </p>
      </section>
    </div>
  );
}

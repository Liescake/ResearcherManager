import {
  API_PREFIX,
  MATCHING_MAX_RECOMMENDATIONS,
  MAX_PAGE_SIZE,
  computeAdmissionRate,
} from '@rm/shared';
import { useRef, useState, type ReactNode } from 'react';
import { ENDPOINTS, endpointRef } from '../api/endpoints';
import { DEMO_EDUCATION_RECORDS } from '../api/demo-data';
import { ADMIN_STATISTICS_SOURCES, type StatisticsSourceResult } from '../api/types';
import { useAuth } from '../auth/AuthContext';
import { AsyncStateView } from '../components/AsyncStateView';
import { MyExportsPanel } from '../components/MyExportsPanel';
import {
  EmptyPanel,
  ErrorPanel,
  LoadingPanel,
  PendingEndpointPanel,
} from '../components/StatePanel';
import { useLoader } from '../state/useLoader';
import {
  INITIAL_REVOKE_FLOW,
  cancelRevoke,
  confirmRevoke,
  dismissRevokeNotice,
  requestRevoke,
  revokeFailed,
  revokeSucceeded,
  type RevokeFlowState,
} from '../state/revoke-flow';
import { formatDateTime, formatPercent, formatUptimeSeconds } from '../lib/format';

const SELF_STATISTIC_FIELDS = [
  { key: 'educationRecords', label: '升学记录' },
  { key: 'applications', label: '申请记录' },
  { key: 'achievements', label: '成果记录' },
  { key: 'matchingRequests', label: '匹配请求' },
] as const;

const SOURCE_LABELS: Readonly<Record<(typeof ADMIN_STATISTICS_SOURCES)[number], string>> = {
  flow: '人员流动',
  achievements: '成果统计',
  education: '升学统计',
};

function sourceDescriptor(source: (typeof ADMIN_STATISTICS_SOURCES)[number]) {
  if (source === 'flow') return ENDPOINTS.adminStatisticsFlow;
  if (source === 'achievements') return ENDPOINTS.adminStatisticsAchievements;
  return ENDPOINTS.adminStatisticsEducation;
}

function AdminStatisticsSection({ result }: { result: StatisticsSourceResult }): ReactNode {
  const descriptor = sourceDescriptor(result.source);
  const title = SOURCE_LABELS[result.source];

  return (
    <article className="card card--sub">
      <h3>{title}</h3>
      <p className="muted">
        <code>{endpointRef(descriptor)}</code>
      </p>
      {result.status === 'pending' && (
        <>
          <p className="state state--pending">{result.reason}</p>
          {result.metrics.length > 0 && <MetricsList metrics={result.metrics} demo />}
        </>
      )}
      {result.status === 'error' && <ErrorPanel error={result.error} />}
      {result.status === 'ready' &&
        (result.metrics.length > 0 ? (
          <MetricsList metrics={result.metrics} demo />
        ) : (
          <EmptyPanel
            title="端点已响应，但字段形状尚未确认"
            description="前端不解析未确认字段，以免把字段名写死成界面逻辑；形状确认后在此展示真实指标。"
          />
        ))}
    </article>
  );
}

function MetricsList({
  metrics,
  demo = false,
}: {
  metrics: readonly { key: string; label: string; value: number; hint?: string }[];
  demo?: boolean;
}): ReactNode {
  return (
    <div className="metrics">
      {metrics.map((metric) => (
        <div className="metric" key={metric.key}>
          <span className="metric__value">{metric.value}</span>
          <span className="metric__label">
            {metric.label}
            {demo && <span className="tag tag--demo">演示</span>}
          </span>
          {metric.hint !== undefined && <span className="muted">{metric.hint}</span>}
        </div>
      ))}
    </div>
  );
}

/**
 * 统计概览页。
 *
 * 分区刻意分开，因为它们的「可信度」不同：
 * - 本人记录概览：`GET /me/statistics` 已实现，取到多少就展示多少（含 0，0 是合法事实）；
 * - 管理端统计：三个端点尚未实现，逐来源展示 pending/错误，而不是合并成一个「暂无数据」；
 * - 升学率口径：公式与计算**只能**来自共享 `computeAdmissionRate`；服务端未提供数据时显示
 *   「暂无数据」而不是 0%，也不在前端自行推导分子分母；
 * - 系统与契约自检：健康检查与共享常量，用于联调排障。
 */
export function OverviewPage(): ReactNode {
  const { gateway, apiBaseUrl } = useAuth();

  const selfStatistics = useLoader(() => gateway.loadSelfStatistics(), [gateway], {
    endpoint: endpointRef(ENDPOINTS.selfStatistics),
  });
  const adminStatistics = useLoader(() => gateway.loadAdminStatistics(), [gateway], {
    endpoint: 'GET /admin/statistics/*',
  });
  const health = useLoader(() => gateway.loadHealth(), [gateway], {
    endpoint: endpointRef(ENDPOINTS.health),
  });
  const myExports = useLoader(() => gateway.loadMyExports(), [gateway], {
    endpoint: endpointRef(ENDPOINTS.myExports),
  });

  /**
   * 撤销流程状态。持有它的原因：撤销是写操作，它的时序（确认、提交中、成功、失败）
   * 必须与渲染分离——状态机在 `state/revoke-flow.ts`（纯函数）里，并已被单测固定。
   */
  const [revokeFlow, setRevokeFlow] = useState<RevokeFlowState>(INITIAL_REVOKE_FLOW);
  /**
   * 防重复提交的**同步保险**：`revokeFlow.pendingId` 要等下一次渲染才生效，
   * 因此一次极快的双击仍可能在上一次 setState 生效之前进入提交路径。ref 在同一 tick 内即可挡住。
   * 它只是纵深防御：真正的幂等判定在服务端（重复撤销同样返回已撤销，不会改写撤销时刻）。
   */
  const revokeInFlight = useRef(false);

  const submitRevoke = async (exportId: string): Promise<void> => {
    if (revokeInFlight.current) return;
    revokeInFlight.current = true;
    try {
      // 只提交路径参数：不发请求体、不带查询串，票据由 api client 注入（前端不读也不存）
      const view = await gateway.revokeExport(exportId);
      setRevokeFlow((current) => revokeSucceeded(current, view));
    } catch (caught) {
      setRevokeFlow((current) => revokeFailed(current, caught));
    } finally {
      revokeInFlight.current = false;
    }
  };

  const handleConfirmRevoke = (): void => {
    const outcome = confirmRevoke(revokeFlow);
    // 未确认或已在提交中时 outcome.exportId 为 null：**不发出任何请求**
    if (outcome.exportId === null) return;
    setRevokeFlow(outcome.state);
    void submitRevoke(outcome.exportId);
  };

  const isDemo = gateway.mode === 'demo';
  const admission = computeAdmissionRate(isDemo ? DEMO_EDUCATION_RECORDS : []);

  return (
    <div className="page">
      <header className="page__header">
        <div>
          <h1>统计概览</h1>
          <p className="muted">
            本人记录概览来自已实现的端点；管理端统计端点尚未实现，按来源分别标注。
          </p>
        </div>
      </header>

      <section className="card" aria-labelledby="self-stats-title">
        <h2 id="self-stats-title">本人记录概览</h2>
        <p className="muted">
          <code>{endpointRef(ENDPOINTS.selfStatistics)}</code>
          ：服务端返回四个计数的白名单闭集，不含任何记录内容（0 是合法事实，不是「无数据」）。
        </p>
        <AsyncStateView
          state={selfStatistics.state}
          descriptor={ENDPOINTS.selfStatistics}
          label="本人记录统计"
          onRetry={selfStatistics.reload}
        >
          {(data) => (
            <div className="metrics">
              {SELF_STATISTIC_FIELDS.map((field) => (
                <div className="metric" key={field.key}>
                  <span className="metric__value">{data[field.key]}</span>
                  <span className="metric__label">{field.label}</span>
                </div>
              ))}
            </div>
          )}
        </AsyncStateView>
      </section>

      <MyExportsPanel
        state={myExports.state}
        mode={isDemo ? 'demo' : 'live'}
        flow={revokeFlow}
        onRequestRevoke={(target) => setRevokeFlow((current) => requestRevoke(current, target))}
        onCancelRevoke={() => setRevokeFlow((current) => cancelRevoke(current))}
        onConfirmRevoke={handleConfirmRevoke}
        onDismissNotice={() => setRevokeFlow((current) => dismissRevokeNotice(current))}
        onRetry={myExports.reload}
      />

      <section className="card" aria-labelledby="admin-stats-title">
        <h2 id="admin-stats-title">管理端统计（后端切片未实现）</h2>
        <p className="muted">
          契约基线定义了三个统计端点，均需对应 <code>statistics:*:read</code>{' '}
          权限；前端不假定响应形状。
        </p>
        {adminStatistics.state.status === 'loading' && <LoadingPanel label="管理端统计" />}
        {adminStatistics.state.status === 'error' && (
          <ErrorPanel error={adminStatistics.state.error} onRetry={adminStatistics.reload} />
        )}
        {adminStatistics.state.status === 'ready' && (
          <div className="grid">
            {adminStatistics.state.data.map((result) => (
              <AdminStatisticsSection key={result.source} result={result} />
            ))}
          </div>
        )}
      </section>

      <section className="card" aria-labelledby="education-title">
        <h2 id="education-title">升学率口径</h2>
        <p className="muted">{admission.formula}</p>
        {isDemo ? (
          <>
            <dl className="kv">
              <dt>分子（已录取）</dt>
              <dd>{admission.numerator}</dd>
              <dt>分母（已录取 + 未上岸）</dt>
              <dd>{admission.denominator}</dd>
              <dt>升学率</dt>
              <dd>{formatPercent(admission.rate)}</dd>
              <dt>被排除</dt>
              <dd>
                备考中 {admission.excludedPreparing} 条；未审核/驳回 {admission.excludedNotApproved}{' '}
                条
              </dd>
            </dl>
            <p className="muted">
              以上为<strong>演示夹具</strong>
              按共享口径计算的结果，用于验证展示规则；真实升学率必须由
              服务端计算（前端不自行推导）。
            </p>
          </>
        ) : (
          <EmptyPanel
            title="暂无数据"
            description="升学统计端点尚未实现，且前端不会用本地样本冒充统计结果；端点上线后此处展示服务端口径的结果。"
          />
        )}
      </section>

      <section className="card" aria-labelledby="health-title">
        <h2 id="health-title">API 连通性</h2>
        <dl className="kv">
          <dt>请求地址</dt>
          <dd>
            {/* 显示实际生效的基地址（与票据去向一致），而不是只显示约定的常量前缀 */}
            <code>
              {gateway.mode === 'demo'
                ? '（演示模式不发起请求）'
                : `${apiBaseUrl}${ENDPOINTS.health.path}`}
            </code>
          </dd>
          <dt>约定前缀</dt>
          <dd>
            <code>{API_PREFIX}</code>
          </dd>
          <dt>当前模式</dt>
          <dd>{gateway.mode === 'demo' ? '演示模式（不发请求）' : '联调模式（真实请求）'}</dd>
        </dl>
        <AsyncStateView
          state={health.state}
          descriptor={ENDPOINTS.health}
          label="服务健康状态"
          onRetry={health.reload}
        >
          {(data) =>
            data === null ? (
              <EmptyPanel
                title="演示模式未探测后端"
                description="演示模式不连接后端，因此不会编造一份健康状态。切到联调模式后此处显示真实结果。"
              />
            ) : (
              <dl className="kv">
                <dt>状态</dt>
                <dd className="ok">{data.status}</dd>
                <dt>服务</dt>
                <dd>
                  {data.service} v{data.version}
                </dd>
                <dt>运行时长</dt>
                <dd>{formatUptimeSeconds(data.uptimeSeconds)}</dd>
                <dt>服务端时间</dt>
                <dd>{formatDateTime(data.timestamp)}</dd>
              </dl>
            )
          }
        </AsyncStateView>
      </section>

      <section className="card" aria-labelledby="contract-title">
        <h2 id="contract-title">关键契约参数（来自 @rm/shared）</h2>
        <ul>
          <li>
            列表分页 pageSize 上限：<strong>{MAX_PAGE_SIZE}</strong>
          </li>
          <li>
            匹配推荐条数上限：<strong>{MATCHING_MAX_RECOMMENDATIONS}</strong>
          </li>
          <li>统一响应信封：data / meta / error；错误码稳定可编程分支</li>
          <li>分页 meta 缺失时界面显示「总数未提供」，绝不用当前页条数冒充总数</li>
        </ul>
      </section>

      <section className="card" aria-labelledby="boundary-title">
        <h2 id="boundary-title">待后端切片</h2>
        <PendingEndpointPanel descriptor={ENDPOINTS.adminApplications} />
      </section>
    </div>
  );
}

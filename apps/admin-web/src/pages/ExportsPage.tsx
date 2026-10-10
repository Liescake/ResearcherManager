import { useRef, useState, type ReactNode } from 'react';
import { ENDPOINTS, endpointRef } from '../api/endpoints';
import type { MyExportPage } from '../api/types';
import { useAuth } from '../auth/AuthContext';
import { MyExportsPanel } from '../components/MyExportsPanel';
import { PageHeader } from '../components/PageHeader';
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

export function ExportsPage(): ReactNode {
  const { gateway } = useAuth();
  const [cursor, setCursor] = useState<string | undefined>(undefined);
  const exportsState = useLoader(
    () => gateway.loadMyExports(cursor === undefined ? {} : { cursor }),
    [gateway, cursor],
    {
      endpoint: endpointRef(ENDPOINTS.myExports),
    },
  );
  const [flow, setFlow] = useState<RevokeFlowState>(INITIAL_REVOKE_FLOW);
  const inFlight = useRef(false);
  const submit = async (id: string): Promise<void> => {
    if (inFlight.current) return;
    inFlight.current = true;
    try {
      const view = await gateway.revokeExport(id);
      setFlow((current) => revokeSucceeded(current, view));
    } catch (caught) {
      setFlow((current) => revokeFailed(current, caught));
    } finally {
      inFlight.current = false;
    }
  };
  const handleConfirm = (): void => {
    const outcome = confirmRevoke(flow);
    if (outcome.exportId === null) return;
    setFlow(outcome.state);
    void submit(outcome.exportId);
  };
  return (
    <div className="page">
      <PageHeader
        title="我的导出"
        description={
          <>
            本人导出状态来自 <code>{endpointRef(ENDPOINTS.myExports)}</code>
            ；本轮只接入状态展示与本人撤销，不提供下载入口。
          </>
        }
        actions={
          <button
            type="button"
            className="button--secondary"
            onClick={exportsState.reload}
            disabled={exportsState.state.status === 'loading' || flow.pendingId !== null}
          >
            刷新列表
          </button>
        }
        meta={<span className="page__eyebrow">个人中心 · 撤销操作需要确认</span>}
      />
      <MyExportsPanel
        state={exportsState.state}
        mode={gateway.mode}
        flow={flow}
        onRequestRevoke={(target) => setFlow((current) => requestRevoke(current, target))}
        onCancelRevoke={() => setFlow((current) => cancelRevoke(current))}
        onConfirmRevoke={handleConfirm}
        onDismissNotice={() => setFlow((current) => dismissRevokeNotice(current))}
        onRetry={exportsState.reload}
      />
      {exportsState.state.status === 'ready' &&
      exportsState.state.data.hasNext &&
      exportsState.state.data.nextCursor !== null ? (
        <div className="pager pager--page">
          <button
            type="button"
            className="button--secondary"
            onClick={() =>
              setCursor(
                exportsState.state.status === 'ready'
                  ? (exportsState.state.data.nextCursor ?? undefined)
                  : undefined,
              )
            }
            disabled={flow.pendingId !== null}
          >
            下一页
          </button>
          {cursor !== undefined && (
            <button
              type="button"
              className="button--ghost"
              onClick={() => setCursor(undefined)}
              disabled={flow.pendingId !== null}
            >
              第一页
            </button>
          )}
        </div>
      ) : null}
    </div>
  );
}

export function mergeExportPages(pages: readonly MyExportPage[]): MyExportPage {
  const seen = new Set<string>();
  const items = pages
    .flatMap((page) => page.items)
    .filter((item) => !seen.has(item.id) && seen.add(item.id));
  const last = pages.at(-1);
  return {
    items,
    limit: last?.limit ?? null,
    hasNext: last?.hasNext ?? false,
    nextCursor: last?.nextCursor ?? null,
  };
}

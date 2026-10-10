import { INVALID_RESPONSE_CODE, INVALID_RESPONSE_MESSAGE, ApiClientError } from './client';
import type { ExportRequestView, MyExportPage } from './types';

/**
 * 导出响应的**出口白名单读取器**（纯函数，无 React / 无网络依赖）。
 *
 * 为什么需要它，而不是 `data as ExportRequestView[]`：
 * 1. **只读白名单字段**：服务端视图的闭集是 `id / resource / fields / status / createdAt / updatedAt`，
 *    这里逐字段显式赋值，永远不把响应里的其它键（归属、产物句柄、路径、有效期、下载地址）带进界面——
 *    即使服务端将来多下发一个字段，界面也不会把它渲染出来或据它做判定；
 * 2. **契约漂移 fail-closed**：任何一行形态非法都返回 `null`（而不是悄悄丢掉那一行），
 *    调用方据此抛 `INVALID_RESPONSE_CODE`：把「少展示一条记录」变成一次可排查的契约故障，
 *    绝不把「解析失败」伪装成「没有这条记录」；
 * 3. **分页元数据不自洽也算违约**：`hasNext === true` 与 `nextCursor !== null` 在服务端互为
 *    充要条件（`toExportPageMeta` 强制）。前端不猜、不补默认值，不自洽即拒绝，
 *    否则界面会显示「还有下一页」却没有可续页的游标。
 */

const EXPORT_VIEW_STRING_FIELDS = ['id', 'resource', 'status', 'createdAt', 'updatedAt'] as const;

/** 读取一条导出视图；形态非法（含多出字段以外的任何缺失/类型错误）返回 `null` */
export function readExportView(raw: unknown): ExportRequestView | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return null;
  }
  const record = raw as Record<string, unknown>;

  for (const field of EXPORT_VIEW_STRING_FIELDS) {
    const value = record[field];
    if (typeof value !== 'string' || value === '') {
      return null;
    }
  }

  const fields = record['fields'];
  if (!Array.isArray(fields) || fields.length === 0) {
    return null;
  }
  if (fields.some((field) => typeof field !== 'string')) {
    return null;
  }

  // 逐字段显式赋值（不用展开）：白名单之外的键一个都不进入界面
  return {
    id: record['id'] as string,
    resource: record['resource'] as string,
    fields: [...(fields as string[])],
    status: record['status'] as string,
    createdAt: record['createdAt'] as string,
    updatedAt: record['updatedAt'] as string,
  };
}

/**
 * 读取导出列表的一页；任何一行非法或分页元数据不自洽都返回 `null`。
 * `data === null` 按空数组处理（与申请列表网关同口径：服务端空集可能表现为 null）。
 */
export function readExportPage(
  data: unknown,
  meta: Readonly<Record<string, unknown>>,
): MyExportPage | null {
  const rows = data === null ? [] : data;
  if (!Array.isArray(rows)) {
    return null;
  }

  const items: ExportRequestView[] = [];
  for (const row of rows) {
    const view = readExportView(row);
    if (view === null) {
      return null;
    }
    items.push(view);
  }

  const hasNext = meta['hasNext'] === true;
  const rawCursor = meta['nextCursor'];
  const nextCursor = typeof rawCursor === 'string' && rawCursor !== '' ? rawCursor : null;
  if (hasNext !== (nextCursor !== null)) {
    return null;
  }

  const rawLimit = meta['limit'];
  const limit =
    typeof rawLimit === 'number' && Number.isInteger(rawLimit) && rawLimit > 0 ? rawLimit : null;

  return { items, limit, hasNext, nextCursor };
}

/** 往返相同：把读取失败统一收敛为既有契约违规错误（HTTP 层可能仍是 200） */
export function contractError(message: string = INVALID_RESPONSE_MESSAGE): ApiClientError {
  return new ApiClientError(INVALID_RESPONSE_CODE, message, { status: 200 });
}

/**
 * 本人在列表端点声明的**唯一**查询参数是 `cursor`（`limit` 由服务端默认值决定，前端不提交）。
 * 因此这里的拼接只有两种结果：`''`（无游标，不带查询串）或 `?cursor=<编码后的不透明串>`。
 *
 * 刻意不提供「顺手加个 limit / status / userId」的口子：服务端的查询串闭集是 `cursor` / `limit`，
 * 其余参数一律 400，前端不可能通过拼查询串影响归属或过滤口径。
 */
export function buildExportCursorQuery(options: { readonly cursor?: string | undefined }): string {
  const cursor = typeof options.cursor === 'string' ? options.cursor.trim() : '';
  return cursor === '' ? '' : `?cursor=${encodeURIComponent(cursor)}`;
}

/**
 * 把本地已确认撤销的记录合并进列表项：**成功即以服务端返回的视图为准**更新本地视图，
 * 不重新拉整页（避免请求失败时把已确认的撤销结果一起丢掉）。
 * 合并只认 `id`，不按位置——列表顺序由服务端决定，前端不假设它稳定。
 */
export function mergeRevokedViews(
  items: readonly ExportRequestView[],
  revoked: Readonly<Record<string, ExportRequestView>>,
): ExportRequestView[] {
  return items.map((item) => revoked[item.id] ?? item);
}

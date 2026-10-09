/** 展示层格式化：纯函数，便于单测；不做任何数据加工或授权判断 */

export function formatUptimeSeconds(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) {
    return '未知';
  }
  const total = Math.floor(seconds);
  const days = Math.floor(total / 86400);
  const hours = Math.floor((total % 86400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;

  if (days > 0) {
    return `${days} 天 ${hours} 小时`;
  }
  if (hours > 0) {
    return `${hours} 小时 ${minutes} 分`;
  }
  if (minutes > 0) {
    return `${minutes} 分 ${secs} 秒`;
  }
  return `${secs} 秒`;
}

/** 升学率等比例展示：分母为 0 时必须显示「暂无数据」，不得显示 0% */
export function formatPercent(rate: number | null, digits = 1): string {
  return rate === null ? '暂无数据' : `${(rate * 100).toFixed(digits)}%`;
}

export function formatDateTime(value: string | Date | null | undefined): string {
  if (value === null || value === undefined) {
    return '—';
  }
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    return '—';
  }
  return date.toLocaleString('zh-CN', { hour12: false });
}

/**
 * 长 ID 截断展示：列表里显示短 ID（完整值仍在 `title`/文本里可复制），
 * 避免 UUID 把表格挤到只有 ID 一列。非字符串或过短的输入原样返回。
 */
export function formatShortId(value: string | null | undefined, head = 8): string {
  if (typeof value !== 'string' || value === '') {
    return '—';
  }
  if (value.length <= head + 1) {
    return value;
  }
  return `${value.slice(0, head)}…`;
}

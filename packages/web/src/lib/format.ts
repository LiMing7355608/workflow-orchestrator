const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export function formatRelativeTime(iso: string, now = Date.now()): string {
  const timestamp = new Date(iso).getTime();
  if (Number.isNaN(timestamp)) {
    return '未知时间';
  }

  const diff = Math.max(0, now - timestamp);

  if (diff < MINUTE) {
    return '刚刚';
  }
  if (diff < HOUR) {
    return `${Math.floor(diff / MINUTE)} 分钟前`;
  }
  if (diff < DAY) {
    return `${Math.floor(diff / HOUR)} 小时前`;
  }
  if (diff < 2 * DAY) {
    return '昨天';
  }
  if (diff < 7 * DAY) {
    return `${Math.floor(diff / DAY)} 天前`;
  }

  return new Intl.DateTimeFormat('zh-CN', {
    month: 'numeric',
    day: 'numeric',
  }).format(new Date(iso));
}

export function formatDateTime(iso: string): string {
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(iso));
}

export function formatFileSize(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function formatDuration(ms?: number): string {
  if (!ms || ms <= 0) {
    return '—';
  }
  if (ms < 1000) {
    return `${ms}ms`;
  }
  if (ms < 60_000) {
    return `${(ms / 1000).toFixed(1)}s`;
  }

  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return `${minutes}m ${seconds}s`;
}

import { ArrowUpRight, MessagesSquare } from 'lucide-react';
import { Link } from 'react-router-dom';
import { fetchInterviews } from '../../lib/api';
import { formatDateTime } from '../../lib/format';
import { useApiResource, useLiveRefresh } from '../../lib/use-api';
import type { InterviewSummary } from '../../types/operations';
import { Badge } from '../ui/Badge';
import { Card } from '../ui/Card';

const labels: Record<InterviewSummary['status'], string> = {
  thinking: 'Agent 处理中', question: '等你回答', ready: '待确认规格', error: '可重试',
};

export function RecentInterviews({ currentId, limit }: { currentId?: string | null; limit?: number }) {
  const { data, source, reload } = useApiResource(fetchInterviews, []);
  useLiveRefresh(source === 'live', reload, { refreshIntervalMs: 750 });
  const entries = data.filter(({ id }) => id !== currentId);
  if (!entries.length) return null;
  return <Card className="divide-y divide-line" aria-label="规格访谈记录">
    <div className="flex items-center gap-2 px-4 py-3 text-sm font-semibold text-ink">
      <MessagesSquare className="size-4 text-accent" />规格访谈
    </div>
    {entries.slice(0, limit).map((entry) => <Link key={entry.id} to={'/new?spec=' + entry.id}
      className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5 text-xs hover:bg-subtle/50">
      <span className="min-w-0 flex-1 break-words font-medium text-ink">{entry.title}</span>
      <Badge tone={entry.status === 'thinking' ? 'blue' : entry.status === 'error' ? 'red' : 'neutral'} dot>{labels[entry.status]}</Badge>
      <time className="hidden text-muted sm:inline" dateTime={entry.updatedAt}>{formatDateTime(entry.updatedAt)}</time>
      <ArrowUpRight className="size-3.5 shrink-0 text-muted" aria-hidden="true" />
    </Link>)}
  </Card>;
}

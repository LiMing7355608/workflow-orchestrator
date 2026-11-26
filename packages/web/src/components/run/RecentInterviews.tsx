import { ArrowUpRight, MessagesSquare } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { fetchInterviews } from '../../lib/api';
import { formatDateTime } from '../../lib/format';
import { useApiResource, useLiveRefresh } from '../../lib/use-api';
import type { InterviewSummary } from '../../types/operations';
import { Badge } from '../ui/Badge';
import { Card } from '../ui/Card';
import { DeleteInterviewButton } from './DeleteInterviewButton';

const labels: Record<InterviewSummary['status'], string> = {
  thinking: 'Agent 处理中', question: '等你回答', ready: '待确认规格', error: '可重试',
};

export function RecentInterviews({ currentId, limit, includeLinked }: { currentId?: string | null; limit?: number; includeLinked?: boolean }) {
  const { data, source, reload } = useApiResource(() => fetchInterviews(includeLinked), []);
  useLiveRefresh(source === 'live', reload, { refreshIntervalMs: 750 });
  const [removed, setRemoved] = useState<string[]>([]);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const entries = data.filter(({ id }) => id !== currentId && !removed.includes(id));
  if (!entries.length && !notice && !error) return null;
  return <Card className="divide-y divide-line" aria-label="规格访谈记录">
    <div className="flex items-center gap-2 px-4 py-3 text-sm font-semibold text-ink">
      <MessagesSquare className="size-4 text-accent" />规格访谈
    </div>
    {entries.slice(0, limit).map((entry) => <div key={entry.id} className="flex items-center gap-1 pr-2">
      <Link to={'/new?spec=' + entry.id}
      className="flex min-w-0 flex-1 flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5 text-xs hover:bg-subtle/50">
      <span className="min-w-0 flex-1 break-words font-medium text-ink">{entry.title}</span>
      <Badge tone={entry.linked ? 'green' : entry.status === 'thinking' ? 'blue' : entry.status === 'error' ? 'red' : 'neutral'} dot>{entry.linked ? '已交给 PM' : labels[entry.status]}</Badge>
      <time className="hidden text-muted sm:inline" dateTime={entry.updatedAt}>{formatDateTime(entry.updatedAt)}</time>
      <ArrowUpRight className="size-3.5 shrink-0 text-muted" aria-hidden="true" />
      </Link>
      <DeleteInterviewButton id={entry.id} title={entry.title} iconOnly onError={setError} onDeleted={(message) => {
        setRemoved((previous) => [...previous, entry.id]);
        setNotice(message || '访谈已删除。');
        reload();
      }} />
    </div>)}
    {notice && <p role="status" className="px-4 py-2 text-xs text-muted">{notice}</p>}
    {error && <p role="alert" className="px-4 py-2 text-xs text-danger">{error}</p>}
  </Card>;
}

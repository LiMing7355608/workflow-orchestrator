import { ChevronRight } from 'lucide-react';
import { Link } from 'react-router-dom';
import { formatRelativeTime } from '../../lib/format';
import type { WorkflowRunSummary } from '../../types/workflow';
import { Progress } from '../ui/Progress';
import { RunStatusBadge } from '../run/RunStatusBadge';

function progressTone(
  status: WorkflowRunSummary['status'],
): 'blue' | 'green' | 'amber' {
  if (status === 'completed') {
    return 'green';
  }
  if (status === 'waiting_for_boss') {
    return 'amber';
  }
  return 'blue';
}

export function RecentRunItem({ run }: { run: WorkflowRunSummary }) {
  return (
    <Link
      to={`/runs/${run.id}`}
      className="group flex items-center gap-3 px-4 py-3 transition-colors duration-150 hover:bg-subtle/50"
    >
      <div className="min-w-0 flex-1">
        <p className="truncate text-[12px] font-medium text-ink">
          {run.title}
        </p>
        <p className="mt-0.5 truncate text-[10px] text-muted">{run.summary}</p>
      </div>

      <RunStatusBadge status={run.status} className="max-[800px]:hidden" />

      <div className="flex w-24 items-center gap-2 max-[800px]:hidden">
        <Progress
          value={run.progress}
          tone={progressTone(run.status)}
          label={`${run.title} 进度`}
          className="flex-1"
        />
        <span className="w-7 text-right text-[10px] tabular-nums text-passive">
          {run.progress}%
        </span>
      </div>

      <span className="w-16 text-right text-[10px] text-passive max-[700px]:hidden">
        {formatRelativeTime(run.updatedAt)}
      </span>

      <ChevronRight
        className="h-4 w-4 text-passive transition-colors group-hover:text-ink"
        strokeWidth={1.8}
      />
    </Link>
  );
}

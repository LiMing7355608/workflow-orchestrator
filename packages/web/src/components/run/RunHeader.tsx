import {
  ArrowLeft,
  Boxes,
  CalendarClock,
  GitBranch,
} from 'lucide-react';
import { Link } from 'react-router-dom';
import { cn } from '../../lib/cn';
import { formatRelativeTime } from '../../lib/format';
import type { WorkflowRunDetail } from '../../types/workflow';
import { Progress } from '../ui/Progress';
import { RunStatusBadge } from './RunStatusBadge';
import { StageProgress } from './StageProgress';

function progressTone(
  status: WorkflowRunDetail['status'],
): 'blue' | 'green' | 'amber' {
  if (status === 'completed') {
    return 'green';
  }
  if (status === 'waiting_for_boss') {
    return 'amber';
  }
  return 'blue';
}

export function RunHeader({
  run,
  className,
}: {
  run: WorkflowRunDetail;
  className?: string;
}) {
  return (
    <div
      className={cn(
        'flex min-h-14 flex-wrap items-center gap-x-3 gap-y-2 bg-surface px-6 py-2.5 max-[900px]:px-4',
        className,
      )}
    >
      <Link
        to="/runs"
        aria-label="返回运行记录"
        title="返回运行记录"
        className="grid h-7 w-7 shrink-0 place-items-center rounded-md text-muted transition-colors hover:bg-subtle hover:text-ink"
      >
        <ArrowLeft className="h-4 w-4" strokeWidth={1.8} />
      </Link>

      <div className="flex min-w-0 flex-1 items-center gap-2">
        <h1 className="truncate text-[16px] font-semibold tracking-[-0.015em] text-ink">
          {run.title}
        </h1>
        <RunStatusBadge status={run.status} />
      </div>

      <div className="hidden items-center gap-3 text-[10px] text-passive min-[1200px]:flex">
        <span className="inline-flex items-center gap-1">
          <GitBranch className="h-3 w-3" strokeWidth={1.8} />
          规格 {run.specVersion}
        </span>
        <span className="inline-flex items-center gap-1">
          <Boxes className="h-3 w-3" strokeWidth={1.8} />
          {run.nodeCount} 节点
        </span>
        <span className="inline-flex items-center gap-1">
          <CalendarClock className="h-3 w-3" strokeWidth={1.8} />
          {formatRelativeTime(run.updatedAt)}
        </span>
      </div>

      <div className="ml-auto flex items-center gap-4 max-[1000px]:gap-2">
        <StageProgress
          compact
          stage={run.stage}
          status={run.status}
          className="max-[1000px]:hidden"
        />

        <div className="flex items-center gap-2">
          <span className="text-[10px] tabular-nums text-passive">
            {run.progress}%
          </span>
          <Progress
            value={run.progress}
            tone={progressTone(run.status)}
            label={`${run.title} 整体进度`}
            className="w-[90px] max-[700px]:w-[60px]"
          />
        </div>
      </div>
    </div>
  );
}

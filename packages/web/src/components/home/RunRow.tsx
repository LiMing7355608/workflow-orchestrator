import { Boxes, ChevronRight, Clock } from 'lucide-react';
import { Link } from 'react-router-dom';
import { formatRelativeTime } from '../../lib/format';
import type { RunStage, WorkflowRunSummary } from '../../types/workflow';
import { Progress } from '../ui/Progress';
import { RunStatusBadge } from '../run/RunStatusBadge';

const stageLabels: Record<RunStage, string> = {
  spec: '设计规格',
  decompose: '任务分解',
  orchestrate: '编排生成',
  execute: '执行监控',
};

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

export function RunRow({ run }: { run: WorkflowRunSummary }) {
  return (
    <Link
      to={`/runs/${run.id}`}
      className="group grid grid-cols-[minmax(0,1fr)_104px_160px_72px_92px_20px] items-center gap-4 px-5 py-3.5 transition-colors duration-150 hover:bg-subtle/50 max-[1100px]:grid-cols-[minmax(0,1fr)_104px_92px_20px]"
    >
      <div className="min-w-0">
        <p className="truncate text-[13px] font-medium text-ink">
          {run.title}
        </p>
        <p className="mt-0.5 truncate text-[11px] text-muted">{run.summary}</p>
      </div>

      <RunStatusBadge status={run.status} />

      <div className="max-[1100px]:hidden">
        <div className="flex items-center justify-between text-[10px] text-passive">
          <span>{stageLabels[run.stage]}</span>
          <span className="tabular-nums">{run.progress}%</span>
        </div>
        <Progress
          value={run.progress}
          tone={progressTone(run.status)}
          label={`${run.title} 运行进度`}
          className="mt-1.5"
        />
      </div>

      <div className="flex items-center gap-1.5 text-[11px] text-muted max-[1100px]:hidden">
        <Boxes className="h-3.5 w-3.5 text-passive" strokeWidth={1.8} />
        <span className="tabular-nums">{run.nodeCount}</span>
      </div>

      <div className="flex items-center gap-1.5 text-[11px] text-passive">
        <Clock className="h-3.5 w-3.5" strokeWidth={1.8} />
        <span className="truncate">{formatRelativeTime(run.updatedAt)}</span>
      </div>

      <ChevronRight
        className="h-4 w-4 text-passive transition-colors group-hover:text-ink"
        strokeWidth={1.8}
      />
    </Link>
  );
}

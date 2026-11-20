import { Boxes, ChevronRight, Clock, Trash2 } from 'lucide-react';
import { Link } from 'react-router-dom';
import { formatRelativeTime } from '../../lib/format';
import type { RunStage, WorkflowRunSummary } from '../../types/workflow';
import { Progress } from '../ui/Progress';
import { RunStatusBadge } from '../run/RunStatusBadge';
import { Button } from '../ui/Button';

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

export function RunRecordRow({ run, onDelete, deleting }: {
  run: WorkflowRunSummary;
  onDelete?: () => void;
  deleting?: boolean;
}) {
  return (
    <div className="relative">
    <Link
      to={`/runs/${run.id}`}
      className="group grid grid-cols-[minmax(0,1fr)_96px_96px_150px_64px_88px_20px] items-center gap-4 py-3.5 pl-5 pr-14 transition-colors duration-150 hover:bg-subtle/50 max-[1100px]:grid-cols-[minmax(0,1fr)_96px_150px_64px_88px_20px] max-[900px]:grid-cols-[minmax(0,1fr)_96px_88px_20px] max-[580px]:grid-cols-[minmax(0,1fr)_80px_14px] max-[580px]:gap-2"
    >
      <div className="min-w-0">
        <p className="truncate text-[13px] font-medium text-ink">
          {run.title}
        </p>
        <p className="mt-0.5 truncate text-[11px] text-muted">{run.summary}</p>
      </div>

      <RunStatusBadge status={run.status} />

      <div className="max-[1100px]:hidden">
        <span className="inline-flex items-center rounded-md border border-line bg-subtle/60 px-2 py-0.5 text-[10px] text-muted">
          {stageLabels[run.stage]}
        </span>
      </div>

      <div className="max-[900px]:hidden">
        <div className="flex items-center gap-2">
          <Progress
            value={run.progress}
            tone={progressTone(run.status)}
            label={`${run.title} 运行进度`}
            className="flex-1"
          />
          <span className="w-7 text-right text-[10px] tabular-nums text-passive">
            {run.progress}%
          </span>
        </div>
      </div>

      <div className="flex items-center gap-1.5 text-[11px] text-muted max-[900px]:hidden">
        <Boxes className="h-3.5 w-3.5 text-passive" strokeWidth={1.8} />
        <span className="tabular-nums">{run.nodeCount}</span>
      </div>

      <div className="flex items-center gap-1.5 text-[11px] text-passive max-[580px]:hidden">
        <Clock className="h-3.5 w-3.5" strokeWidth={1.8} />
        <span className="truncate">{formatRelativeTime(run.updatedAt)}</span>
      </div>

      <ChevronRight
        className="h-4 w-4 text-passive transition-colors group-hover:text-ink"
        strokeWidth={1.8}
      />
    </Link>
    {onDelete && (
      <Button
        variant="ghost"
        size="sm"
        className="absolute right-3 top-1/2 h-8 w-8 -translate-y-1/2 px-0 text-muted hover:text-danger"
        aria-label={'删除运行 ' + run.title}
        title={run.status === 'running' ? '先停止运行再删除' : '删除记录和产物'}
        disabled={deleting || run.status === 'running'}
        onClick={onDelete}
      >
        <Trash2 className="h-4 w-4" strokeWidth={1.8} />
      </Button>
    )}
    </div>
  );
}

import {
  ArrowLeft,
  Boxes,
  CalendarClock,
  GitBranch,
  Play,
  Square,
} from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { cn } from '../../lib/cn';
import { formatRelativeTime } from '../../lib/format';
import { resumeRun, stopRun } from '../../lib/api';
import type { WorkflowRunDetail } from '../../types/workflow';
import { Badge, type BadgeTone } from '../ui/Badge';
import { Button } from '../ui/Button';
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

/** 正在进行的那个请求。同时只允许一个，避免「停止」与「继续」互相踩。 */
type PendingAction = 'stop' | 'resume';

interface Notice {
  tone: BadgeTone;
  text: string;
}

export function RunHeader({
  run,
  onRunChanged,
  className,
}: {
  run: WorkflowRunDetail;
  /**
   * 操作成功后的刷新钩子。
   *
   * 状态是后端派生出来的，前端不能自己猜下一帧是什么样：点了停止就先把
   * 徽标改成「已暂停」，会在请求失败时留下一个谎。所以一律回读。
   */
  onRunChanged?: () => void;
  className?: string;
}) {
  const [pending, setPending] = useState<PendingAction | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);

  // 待人工处理的运行同样允许停止：审批节点在等人，但别的节点可能还在跑。
  // 已完成的运行不给操作按钮——那已经没有「正在跑的东西」可停了。
  const canStop = run.status === 'running' || run.status === 'waiting_for_boss';
  const canResume = run.status === 'paused';

  async function handleStop(): Promise<void> {
    if (pending) {
      return;
    }
    setPending('stop');
    setNotice(null);
    const result = await stopRun(run.id);
    setPending(null);

    if (!result) {
      // 请求本身失败：不能说「已停止」。这时后端可能连中止都没收到。
      setNotice({ tone: 'red', text: '停止请求没有成功，运行可能仍在继续' });
      return;
    }

    setNotice(
      result.cancelledAgents > 0
        ? {
            tone: 'amber',
            text: `已停止，终止了 ${result.cancelledAgents} 个正在执行的 Agent`,
          }
        : { tone: 'amber', text: '已停止，没有正在执行的 Agent 需要终止' },
    );
    onRunChanged?.();
  }

  async function handleResume(): Promise<void> {
    if (pending) {
      return;
    }
    setPending('resume');
    setNotice(null);
    const result = await resumeRun(run.id);
    setPending(null);

    if (!result) {
      setNotice({ tone: 'red', text: '继续请求没有成功，运行仍是暂停状态' });
      return;
    }

    setNotice({ tone: 'blue', text: '已继续，编排器正在往下推进' });
    onRunChanged?.();
  }

  return (
    <div className={cn('bg-surface', className)}>
      {notice ? (
        // 轻量提示：一行 Badge，不用 alert 打断操作，也不占版面
        <div className="flex items-center gap-2 px-6 pt-2 max-[900px]:px-4">
          <Badge tone={notice.tone} dot>
            {notice.text}
          </Badge>
        </div>
      ) : null}

      <div className="flex min-h-14 flex-wrap items-center gap-x-3 gap-y-2 px-6 py-2.5 max-[900px]:px-4">
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

          {canStop ? (
            <Button
              variant="danger"
              size="sm"
              onClick={() => void handleStop()}
              disabled={pending !== null}
              title="终止正在执行的 Agent 并停止本轮推进"
            >
              <Square className="h-3 w-3" strokeWidth={2.4} />
              {pending === 'stop' ? '停止中…' : '停止'}
            </Button>
          ) : canResume ? (
            <Button
              size="sm"
              onClick={() => void handleResume()}
              disabled={pending !== null}
              title="从中断处继续推进"
            >
              <Play className="h-3 w-3" strokeWidth={2.4} />
              {pending === 'resume' ? '继续中…' : '继续'}
            </Button>
          ) : null}
        </div>
      </div>
    </div>
  );
}

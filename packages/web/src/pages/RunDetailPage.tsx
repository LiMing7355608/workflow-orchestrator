import { ArrowLeft, Boxes, CalendarClock, GitBranch } from 'lucide-react';
import { Link, useParams } from 'react-router-dom';
import { RunStatusBadge } from '../components/run/RunStatusBadge';
import { Card } from '../components/ui/Card';
import { EmptyState } from '../components/ui/EmptyState';
import { Progress } from '../components/ui/Progress';
import { buttonStyles } from '../components/ui/Button';
import { seedRuns } from '../data/seed';
import { formatRelativeTime } from '../lib/format';
import { usePageTitle } from '../lib/use-page-title';

export function RunDetailPage() {
  const { runId } = useParams();
  const run = seedRuns.find((item) => item.id === runId);

  usePageTitle(run?.title ?? '运行详情');

  if (!run) {
    return (
      <div className="mx-auto max-w-[1180px] px-6 py-7 max-[900px]:px-4">
        <Card>
          <EmptyState
            icon={GitBranch}
            title="找不到这个运行"
            description="它可能已经被删除，或者链接不完整。"
            action={
              <Link
                to="/"
                className={buttonStyles({ variant: 'secondary', size: 'sm' })}
              >
                返回工作台
              </Link>
            }
          />
        </Card>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-[1180px] px-6 py-7 max-[900px]:px-4">
      <Link
        to="/"
        className="inline-flex items-center gap-1.5 text-[11px] text-muted transition-colors hover:text-ink"
      >
        <ArrowLeft className="h-3.5 w-3.5" strokeWidth={1.8} />
        返回工作台
      </Link>

      <div className="mt-4 flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-[24px] font-semibold tracking-[-0.02em] text-ink">
              {run.title}
            </h1>
            <RunStatusBadge status={run.status} />
          </div>
          <p className="mt-1.5 text-[12px] text-muted">{run.summary}</p>
          <div className="mt-3 flex flex-wrap items-center gap-4 text-[11px] text-passive">
            <span className="inline-flex items-center gap-1.5">
              <GitBranch className="h-3.5 w-3.5" strokeWidth={1.8} />
              规格 {run.specVersion}
            </span>
            <span className="inline-flex items-center gap-1.5">
              <Boxes className="h-3.5 w-3.5" strokeWidth={1.8} />
              {run.nodeCount} 个节点
            </span>
            <span className="inline-flex items-center gap-1.5">
              <CalendarClock className="h-3.5 w-3.5" strokeWidth={1.8} />
              更新于 {formatRelativeTime(run.updatedAt)}
            </span>
          </div>
        </div>

        <div className="w-[220px] max-[700px]:w-full">
          <div className="flex items-center justify-between text-[10px] text-passive">
            <span>整体进度</span>
            <span className="tabular-nums">{run.progress}%</span>
          </div>
          <Progress
            value={run.progress}
            tone={run.status === 'completed' ? 'green' : 'blue'}
            label={`${run.title} 整体进度`}
            className="mt-2"
          />
        </div>
      </div>

      <Card className="mt-6">
        <EmptyState
          icon={GitBranch}
          title="编排画布将在下一步接入"
          description="这里会展示 DAG 拓扑、四泳道看板、节点检查器、事件流和人工审批操作。"
          action={
            <Link
              to="/new"
              className={buttonStyles({ variant: 'secondary', size: 'sm' })}
            >
              新建运行
            </Link>
          }
        />
      </Card>
    </div>
  );
}

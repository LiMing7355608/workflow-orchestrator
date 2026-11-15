import { cn } from '../../lib/cn';
import type { WorkflowRunSummary } from '../../types/workflow';
import { Card } from '../ui/Card';

const statusItems = [
  { key: 'running', label: '运行中', bar: 'bg-accent' },
  { key: 'waiting_for_boss', label: '待你处理', bar: 'bg-coral' },
  { key: 'completed', label: '已完成', bar: 'bg-success' },
  { key: 'paused', label: '已暂停', bar: 'bg-passive' },
] as const;

export function RunOverview({
  runs,
  className,
}: {
  runs: WorkflowRunSummary[];
  className?: string;
}) {
  const total = Math.max(1, runs.length);

  return (
    <Card className={cn('p-4', className)}>
      <div className="flex items-center justify-between">
        <span className="text-[11px] text-muted">状态分布</span>
        <span className="text-[10px] text-passive">共 {runs.length} 个</span>
      </div>

      <div className="mt-3 space-y-3">
        {statusItems.map((item) => {
          const count = runs.filter((run) => run.status === item.key).length;

          return (
            <div key={item.key}>
              <div className="flex items-center justify-between text-[11px]">
                <span className="text-muted">{item.label}</span>
                <span className="tabular-nums text-ink">{count}</span>
              </div>
              <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-subtle">
                <div
                  className={cn(
                    'h-full rounded-full transition-[width] duration-300 ease-out',
                    item.bar,
                  )}
                  style={{ width: `${(count / total) * 100}%` }}
                />
              </div>
            </div>
          );
        })}
      </div>

      <p className="mt-4 border-t border-line pt-3 text-[10px] leading-4 text-passive">
        按最近一次运行状态统计。
      </p>
    </Card>
  );
}

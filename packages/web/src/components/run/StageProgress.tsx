import {
  Activity,
  Check,
  FileText,
  GitBranch,
  Network,
  type LucideIcon,
} from 'lucide-react';
import { Fragment } from 'react';
import { cn } from '../../lib/cn';
import type { RunStage, RunStatus } from '../../types/workflow';

interface StageStep {
  key: RunStage;
  label: string;
  icon: LucideIcon;
}

const steps: StageStep[] = [
  { key: 'spec', label: '设计规格', icon: FileText },
  { key: 'decompose', label: '任务分解', icon: Network },
  { key: 'orchestrate', label: '编排生成', icon: GitBranch },
  { key: 'execute', label: '执行监控', icon: Activity },
];

const stageIndex: Record<RunStage, number> = {
  spec: 0,
  decompose: 1,
  orchestrate: 2,
  execute: 3,
};

export function StageProgress({
  stage,
  status,
  compact = false,
  className,
}: {
  stage: RunStage;
  status: RunStatus;
  compact?: boolean;
  className?: string;
}) {
  const activeIndex =
    status === 'completed' ? steps.length : stageIndex[stage];

  if (compact) {
    return (
      <div
        className={cn('flex items-center gap-2.5', className)}
        aria-label="运行阶段"
      >
        {steps.map((step, index) => {
          const done = index < activeIndex;
          const active =
            index === activeIndex && status !== 'completed';
          const Icon = step.icon;

          return (
            <span
              key={step.key}
              className={cn(
                'inline-flex items-center gap-1 whitespace-nowrap text-[10px]',
                done
                  ? 'text-muted'
                  : active
                    ? 'font-medium text-ink'
                    : 'text-passive',
              )}
            >
              <span
                className={cn(
                  'grid h-3.5 w-3.5 place-items-center rounded-full border',
                  done
                    ? 'border-success/20 bg-success-soft text-success'
                    : active
                      ? 'border-accent/30 bg-accent-soft text-accent'
                      : 'border-line bg-surface text-passive',
                )}
              >
                {done ? (
                  <Check className="h-2 w-2" strokeWidth={2.2} />
                ) : (
                  <Icon className="h-2 w-2" strokeWidth={1.8} />
                )}
              </span>
              {step.label}
            </span>
          );
        })}
      </div>
    );
  }

  return (
    <div
      className={cn(
        'flex items-center gap-2 overflow-x-auto pb-0.5',
        className,
      )}
    >
      {steps.map((step, index) => {
        const done = index < activeIndex;
        const active = index === activeIndex && status !== 'completed';
        const Icon = step.icon;

        return (
          <Fragment key={step.key}>
            <div className="flex shrink-0 items-center gap-2">
              <span
                className={cn(
                  'grid h-6 w-6 place-items-center rounded-full border',
                  done
                    ? 'border-success/20 bg-success-soft text-success'
                    : active
                      ? 'border-accent/30 bg-accent-soft text-accent'
                      : 'border-line bg-surface text-passive',
                )}
              >
                {done ? (
                  <Check className="h-3 w-3" strokeWidth={2} />
                ) : (
                  <Icon className="h-3 w-3" strokeWidth={1.8} />
                )}
              </span>
              <span
                className={cn(
                  'text-[11px]',
                  done
                    ? 'text-muted'
                    : active
                      ? 'font-medium text-ink'
                      : 'text-passive',
                )}
              >
                {step.label}
              </span>
            </div>
            {index < steps.length - 1 ? (
              <span
                className={cn(
                  'h-px min-w-6 flex-1',
                  index < activeIndex ? 'bg-success/30' : 'bg-line',
                )}
              />
            ) : null}
          </Fragment>
        );
      })}
    </div>
  );
}

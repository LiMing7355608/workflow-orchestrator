import {
  Activity,
  FileText,
  GitBranch,
  Network,
  type LucideIcon,
} from 'lucide-react';
import { cn } from '../../lib/cn';
import { Card } from '../ui/Card';

interface Step {
  title: string;
  description: string;
  icon: LucideIcon;
}

const steps: Step[] = [
  {
    title: '设计规格',
    description: '输入产品目标、范围与约束',
    icon: FileText,
  },
  {
    title: 'PM 分解',
    description: '识别模块并拆成可执行任务',
    icon: Network,
  },
  {
    title: '编排生成',
    description: '建立依赖并校验 DAG',
    icon: GitBranch,
  },
  {
    title: '运行监控',
    description: '查看状态、日志与人工审批',
    icon: Activity,
  },
];

export function PipelineStrip({ className }: { className?: string }) {
  return (
    <Card
      className={cn(
        'grid grid-cols-4 gap-1 p-1 max-[900px]:grid-cols-2',
        className,
      )}
    >
      {steps.map((step, index) => {
        const Icon = step.icon;

        return (
          <div
            key={step.title}
            className="rounded-lg px-3 py-3 transition-colors hover:bg-subtle/60"
          >
            <div className="flex items-center gap-2">
              <span className="grid h-7 w-7 place-items-center rounded-md border border-line bg-surface text-muted">
                <Icon className="h-3.5 w-3.5" strokeWidth={1.8} />
              </span>
              <span className="font-mono text-[10px] text-passive">
                {String(index + 1).padStart(2, '0')}
              </span>
            </div>
            <p className="mt-2.5 text-[12px] font-medium text-ink">
              {step.title}
            </p>
            <p className="mt-1 text-[11px] leading-4 text-muted">
              {step.description}
            </p>
          </div>
        );
      })}
    </Card>
  );
}

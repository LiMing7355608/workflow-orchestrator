import type { LucideIcon } from 'lucide-react';
import { cn } from '../../lib/cn';
import { Card } from '../ui/Card';

type StatTone = 'blue' | 'amber' | 'green';

const toneStyles: Record<StatTone, string> = {
  blue: 'bg-accent-soft text-accent',
  amber: 'bg-warning-soft text-warning',
  green: 'bg-success-soft text-success',
};

interface StatCardProps {
  label: string;
  value: number;
  hint: string;
  icon: LucideIcon;
  tone?: StatTone;
}

export function StatCard({
  label,
  value,
  hint,
  icon: Icon,
  tone = 'blue',
}: StatCardProps) {
  return (
    <Card className="p-4">
      <div className="flex items-center justify-between gap-3">
        <span className="text-[11px] text-muted">{label}</span>
        <span
          className={cn(
            'grid h-7 w-7 place-items-center rounded-md',
            toneStyles[tone],
          )}
        >
          <Icon className="h-3.5 w-3.5" strokeWidth={1.9} />
        </span>
      </div>
      <div className="mt-2 flex items-end gap-2">
        <span className="text-[26px] font-semibold leading-none tabular-nums tracking-[-0.03em]">
          {value}
        </span>
        <span className="pb-0.5 text-[11px] text-passive">{hint}</span>
      </div>
    </Card>
  );
}

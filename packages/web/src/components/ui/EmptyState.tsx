import type { LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from '../../lib/cn';

interface EmptyStateProps {
  icon: LucideIcon;
  title: string;
  description: string;
  action?: ReactNode;
  className?: string;
}

export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
  className,
}: EmptyStateProps) {
  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center px-6 py-14 text-center',
        className,
      )}
    >
      <div className="grid h-11 w-11 place-items-center rounded-xl border border-line bg-subtle text-muted">
        <Icon className="h-5 w-5" strokeWidth={1.6} />
      </div>
      <h3 className="mt-3 text-[14px] font-medium text-ink">{title}</h3>
      <p className="mt-1 max-w-[380px] text-[12px] leading-5 text-muted">
        {description}
      </p>
      {action ? <div className="mt-4">{action}</div> : null}
    </div>
  );
}

import type { ReactNode } from 'react';
import { cn } from '../../lib/cn';

export type BadgeTone =
  | 'neutral'
  | 'blue'
  | 'green'
  | 'amber'
  | 'red'
  | 'violet'
  | 'coral';

const toneStyles: Record<BadgeTone, string> = {
  neutral: 'border-line bg-subtle text-muted',
  blue: 'border-accent/15 bg-accent-soft text-accent',
  green: 'border-success/15 bg-success-soft text-success',
  amber: 'border-warning/15 bg-warning-soft text-warning',
  red: 'border-danger/15 bg-danger-soft text-danger',
  violet: 'border-review/15 bg-review-soft text-review',
  coral: 'border-coral/15 bg-coral-soft text-coral',
};

const dotStyles: Record<BadgeTone, string> = {
  neutral: 'bg-passive',
  blue: 'bg-accent',
  green: 'bg-success',
  amber: 'bg-warning',
  red: 'bg-danger',
  violet: 'bg-review',
  coral: 'bg-coral',
};

interface BadgeProps {
  children: ReactNode;
  tone?: BadgeTone;
  dot?: boolean;
  className?: string;
  title?: string;
}

export function Badge({
  children,
  tone = 'neutral',
  dot = false,
  className,
  title,
}: BadgeProps) {
  return (
    <span
      title={title}
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-medium leading-4',
        toneStyles[tone],
        className,
      )}
    >
      {dot ? (
        <span
          aria-hidden="true"
          className={cn('h-1.5 w-1.5 rounded-full', dotStyles[tone])}
        />
      ) : null}
      {children}
    </span>
  );
}

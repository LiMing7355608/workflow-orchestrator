import type { ReactNode } from 'react';
import { cn } from '../../lib/cn';

interface FieldProps {
  label: string;
  hint?: string;
  children: ReactNode;
  className?: string;
}

export function Field({ label, hint, children, className }: FieldProps) {
  return (
    <div className={cn('space-y-1.5', className)}>
      <div className="flex items-center justify-between gap-2">
        <span className="text-[11px] font-medium text-muted">{label}</span>
        {hint ? <span className="text-[10px] text-passive">{hint}</span> : null}
      </div>
      {children}
    </div>
  );
}

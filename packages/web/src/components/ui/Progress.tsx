import { cn } from '../../lib/cn';

type ProgressTone = 'blue' | 'green' | 'amber';

const fillStyles: Record<ProgressTone, string> = {
  blue: 'bg-accent',
  green: 'bg-success',
  amber: 'bg-warning',
};

interface ProgressProps {
  value: number;
  tone?: ProgressTone;
  className?: string;
  label?: string;
}

export function Progress({
  value,
  tone = 'blue',
  className,
  label = '运行进度',
}: ProgressProps) {
  const clamped = Math.min(100, Math.max(0, value));

  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={clamped}
      className={cn(
        'h-1.5 w-full overflow-hidden rounded-full bg-subtle',
        className,
      )}
    >
      <div
        className={cn(
          'h-full rounded-full transition-[width] duration-300 ease-out',
          fillStyles[tone],
        )}
        style={{ width: `${clamped}%` }}
      />
    </div>
  );
}

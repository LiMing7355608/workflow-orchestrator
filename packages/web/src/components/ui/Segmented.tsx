import { cn } from '../../lib/cn';

interface SegmentedOption<T extends string> {
  value: T;
  label: string;
  disabled?: boolean;
}

interface SegmentedProps<T extends string> {
  options: ReadonlyArray<SegmentedOption<T>>;
  value: T;
  onChange: (value: T) => void;
  ariaLabel: string;
  fill?: boolean;
  className?: string;
}

export function Segmented<T extends string>({
  options,
  value,
  onChange,
  ariaLabel,
  fill = false,
  className,
}: SegmentedProps<T>) {
  return (
    <div
      role="group"
      aria-label={ariaLabel}
      className={cn(
        'inline-flex items-center gap-0.5 rounded-lg border border-line bg-surface p-0.5',
        fill && 'flex w-full',
        className,
      )}
    >
      {options.map((option) => {
        const active = option.value === value;

        return (
          <button
            key={option.value}
            type="button"
            aria-pressed={active}
            disabled={option.disabled}
            onClick={() => onChange(option.value)}
            className={cn(
              'h-7 whitespace-nowrap rounded-md px-2.5 text-[11px] font-medium transition-colors duration-150',
              fill && 'flex-1',
              option.disabled && 'cursor-not-allowed opacity-45',
              active
                ? 'bg-subtle text-ink'
                : 'text-muted hover:bg-subtle/60 hover:text-ink',
            )}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

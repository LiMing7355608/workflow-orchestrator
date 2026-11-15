import { cn } from '../../lib/cn';

type AvatarSize = 'sm' | 'md' | 'lg';

const sizeStyles: Record<AvatarSize, string> = {
  sm: 'h-7 w-7 text-[10px]',
  md: 'h-8 w-8 text-[11px]',
  lg: 'h-10 w-10 text-[13px]',
};

interface AvatarProps {
  label: string;
  size?: AvatarSize;
  className?: string;
}

export function Avatar({ label, size = 'md', className }: AvatarProps) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        'inline-flex shrink-0 items-center justify-center rounded-full bg-subtle font-medium text-muted ring-1 ring-line',
        sizeStyles[size],
        className,
      )}
    >
      {label}
    </span>
  );
}

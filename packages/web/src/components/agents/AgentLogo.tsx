import { useState } from 'react';
import { cn } from '../../lib/cn';

interface AgentLogoProps {
  src?: string;
  label: string;
  className?: string;
}

/**
 * 厂商图标。图标本身是装饰性的——所有调用点旁边都有名称，
 * 所以固定 alt="" + aria-hidden；加载失败时退回首字母方块。
 */
export function AgentLogo({ src, label, className }: AgentLogoProps) {
  const [broken, setBroken] = useState(false);

  if (!src || broken) {
    return (
      <span
        aria-hidden="true"
        className={cn(
          'grid place-items-center rounded-md bg-subtle font-mono text-[10px] font-semibold uppercase text-muted',
          className,
        )}
      >
        {label.charAt(0)}
      </span>
    );
  }

  return (
    <img
      src={src}
      alt=""
      aria-hidden="true"
      loading="lazy"
      onError={() => setBroken(true)}
      className={cn('shrink-0 object-contain', className)}
    />
  );
}

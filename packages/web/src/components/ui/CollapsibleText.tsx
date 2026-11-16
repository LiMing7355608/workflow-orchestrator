import { useState } from 'react';
import { cn } from '../../lib/cn';

/**
 * 可展开的文本块。
 *
 * 运行目标、节点描述这类内容常常是一整段任务书——产出物、验收标准都在里面，
 * 折叠成两行等于把关键要求藏起来。默认给一段预览，超出阈值才出现展开入口，
 * 避免短文本下面挂一个没有意义的按钮。
 */
export function CollapsibleText({
  text,
  lines = 2,
  threshold = 60,
  className,
  toggleClassName,
}: {
  text: string;
  /** 收起时保留几行。窄栏用 2，大面板用 3。 */
  lines?: 2 | 3 | 4;
  /** 超过多少字符才给展开入口。短文本不需要按钮。 */
  threshold?: number;
  className?: string;
  toggleClassName?: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const expandable = text.length > threshold;
  const clampClass =
    lines === 2 ? 'line-clamp-2' : lines === 3 ? 'line-clamp-3' : 'line-clamp-4';

  return (
    <div className="min-w-0">
      <p className={cn(!expanded && clampClass, className)}>{text}</p>
      {expandable ? (
        <button
          type="button"
          onClick={() => setExpanded((value) => !value)}
          className={cn(
            'mt-0.5 text-[11px] text-accent hover:underline focus-visible:underline',
            toggleClassName,
          )}
        >
          {expanded ? '收起' : '展开全文'}
        </button>
      ) : null}
    </div>
  );
}

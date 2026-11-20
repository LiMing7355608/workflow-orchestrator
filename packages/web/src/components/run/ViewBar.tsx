import { cn } from '../../lib/cn';
import { nodeTypeMeta } from '../../lib/workflow-meta';
import { Segmented } from '../ui/Segmented';

export type RunView = 'graph' | 'board' | 'events' | 'plan' | 'monitor';

const viewOptions: Array<{ value: RunView; label: string }> = [
  { value: 'graph', label: '编排图' },
  { value: 'plan', label: '任务拆解' },
  { value: 'board', label: '四泳道' },
  { value: 'events', label: '事件流' },
  { value: 'monitor', label: 'Agent 监控' },
];

interface ViewBarProps {
  value: RunView;
  onChange: (value: RunView) => void;
  nodeCount: number;
  eventCount: number;
  planning?: boolean;
  draft?: boolean;
}

export function ViewBar({
  value,
  onChange,
  nodeCount,
  eventCount,
  planning = false,
  draft = false,
}: ViewBarProps) {
  return (
    <div className="flex min-h-10 shrink-0 flex-wrap items-center justify-between gap-x-3 gap-y-1 border-b border-line bg-canvas px-3 py-1.5 sm:px-4">
      <div className="flex min-w-0 items-center gap-3 overflow-x-auto">
        <Segmented
          options={planning
            ? viewOptions.map((option) => ({ ...option, disabled: option.value !== 'events' && option.value !== 'monitor' && !(draft && option.value === 'plan') }))
            : viewOptions}
          value={value}
          onChange={onChange}
          ariaLabel="运行视图"
        />
        <span className="truncate text-[10px] text-passive max-[700px]:hidden">
          {nodeCount} 个节点 · {eventCount} 条事件
        </span>
      </div>

      <div className="flex items-center gap-3 max-[950px]:hidden">
        {Object.entries(nodeTypeMeta).map(([key, meta]) => (
          <span
            key={key}
            className="inline-flex items-center gap-1.5 text-[10px] text-muted"
          >
            <span className={cn('h-1.5 w-1.5 rounded-full', meta.dot)} />
            {meta.label}
          </span>
        ))}
      </div>
    </div>
  );
}

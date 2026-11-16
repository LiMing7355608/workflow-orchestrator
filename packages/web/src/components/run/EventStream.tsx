import {
  Bot,
  ChevronRight,
  GitBranch,
  Info,
  ScrollText,
  ShieldCheck,
  UserCheck,
  type LucideIcon,
} from 'lucide-react';
import { useMemo, useState } from 'react';
import { cn } from '../../lib/cn';
import { formatDateTime } from '../../lib/format';
import type { AgentEventKind, WorkflowEvent } from '../../types/workflow';
import { Badge, type BadgeTone } from '../ui/Badge';
import { EmptyState } from '../ui/EmptyState';
import { Segmented } from '../ui/Segmented';

type EventFilter = 'all' | WorkflowEvent['type'];
type EventMeta = {
  label: string;
  icon: LucideIcon;
  dot: string;
  tile: string;
  tone: BadgeTone;
};

const eventMeta: Record<WorkflowEvent['type'], EventMeta> = {
  stage: {
    label: '阶段',
    icon: GitBranch,
    dot: 'bg-accent',
    tile: 'bg-accent-soft text-accent',
    tone: 'blue',
  },
  agent: {
    label: 'Agent',
    icon: Bot,
    dot: 'bg-passive',
    tile: 'bg-subtle text-muted',
    tone: 'neutral',
  },
  review: {
    label: '审查',
    icon: ShieldCheck,
    dot: 'bg-review',
    tile: 'bg-review-soft text-review',
    tone: 'violet',
  },
  approval: {
    label: '审批',
    icon: UserCheck,
    dot: 'bg-warning',
    tile: 'bg-warning-soft text-warning',
    tone: 'amber',
  },
  system: {
    label: '系统',
    icon: Info,
    dot: 'bg-passive',
    tile: 'bg-subtle text-muted',
    tone: 'neutral',
  },
};

const filterOptions: Array<{ value: EventFilter; label: string }> = [
  { value: 'all', label: '全部' },
  { value: 'stage', label: '阶段' },
  { value: 'agent', label: 'Agent' },
  { value: 'review', label: '审查' },
  { value: 'approval', label: '审批' },
  { value: 'system', label: '系统' },
];

/**
 * agent.output 的细分标记。
 *
 * text 故意不给标记：绝大多数行都是正文，逐行挂个「回复」只会制造噪声。
 * 这里只标注真正需要一眼分辨的几类。
 */
const kindMeta: Partial<Record<AgentEventKind, { label: string; className: string }>> = {
  tool: { label: '工具', className: 'text-accent' },
  result: { label: '结果', className: 'text-success' },
  usage: { label: '用量', className: 'text-passive' },
  error: { label: '错误', className: 'text-danger' },
  session: { label: '会话', className: 'text-review' },
};

interface EventStreamProps {
  events: WorkflowEvent[];
  onSelectNode: (nodeId: string | null) => void;
}

export function EventStream({ events, onSelectNode }: EventStreamProps) {
  const [filter, setFilter] = useState<EventFilter>('all');

  const filtered = useMemo(() => {
    const matched =
      filter === 'all'
        ? events
        : events.filter((event) => event.type === filter);

    return [...matched].sort(
      (a, b) => new Date(b.at).getTime() - new Date(a.at).getTime(),
    );
  }, [events, filter]);

  return (
    <div className="flex h-full flex-col">
      <div className="shrink-0 border-b border-line px-4 py-2.5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="max-w-full overflow-x-auto">
            <Segmented
              options={filterOptions}
              value={filter}
              onChange={setFilter}
              ariaLabel="按事件类型筛选"
            />
          </div>
          <span className="text-[10px] tabular-nums text-passive">
            共 {filtered.length} 条
          </span>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-4">
        {filtered.length > 0 ? (
          <div className="relative space-y-3 border-l border-line pl-5">
            {filtered.map((event) => {
              const meta = eventMeta[event.type];
              const Icon = meta.icon;
              const kind = event.kind ? kindMeta[event.kind] : undefined;
              // 工具标记直接显示工具名，比一个笼统的「工具」信息量大得多
              const kindLabel =
                event.kind === 'tool' ? event.toolName ?? kind?.label : kind?.label;
              const content = (
                <>
                  <span
                    aria-hidden="true"
                    className={cn(
                      'absolute -left-[24px] top-4 h-2 w-2 rounded-full ring-4 ring-canvas',
                      meta.dot,
                    )}
                  />
                  <div className="rounded-lg border border-line bg-surface p-3 transition-colors hover:border-line-strong">
                    <div className="flex flex-wrap items-center gap-2">
                      <span
                        className={cn(
                          'grid h-6 w-6 place-items-center rounded-md',
                          meta.tile,
                        )}
                      >
                        <Icon className="h-3 w-3" strokeWidth={1.8} />
                      </span>
                      <Badge tone={meta.tone} dot>
                        {meta.label}
                      </Badge>
                      <span className="text-[10px] tabular-nums text-passive">
                        {formatDateTime(event.at)}
                      </span>
                      {event.agent ? (
                        <span className="text-[10px] text-muted">
                          {event.agent}
                        </span>
                      ) : null}
                      {event.nodeId ? (
                        <span className="ml-auto inline-flex items-center gap-1 text-[10px] text-muted">
                          查看节点
                          <ChevronRight
                            className="h-3 w-3"
                            strokeWidth={1.8}
                          />
                        </span>
                      ) : null}
                    </div>

                    <p className="mt-2 flex items-start gap-2 text-[12px] leading-5 text-ink">
                      {kind && kindLabel ? (
                        <span
                          className={cn(
                            'mt-1 shrink-0 rounded border border-current/25 px-1 text-[10px] font-medium leading-4',
                            kind.className,
                          )}
                        >
                          {kindLabel}
                        </span>
                      ) : null}
                      <span className="min-w-0 break-words">{event.message}</span>
                    </p>
                  </div>
                </>
              );

              return event.nodeId ? (
                <div key={event.id} className="relative">
                  <button
                    type="button"
                    onClick={() => onSelectNode(event.nodeId ?? null)}
                    className="block w-full text-left"
                  >
                    {content}
                  </button>
                </div>
              ) : (
                <div key={event.id} className="relative">
                  {content}
                </div>
              );
            })}
          </div>
        ) : (
          <EmptyState
            icon={ScrollText}
            title="没有匹配的事件"
            description="调整事件类型筛选后再试。"
          />
        )}
      </div>
    </div>
  );
}

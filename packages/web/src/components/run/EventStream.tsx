import { ChevronRight, MessageSquare, ScrollText } from 'lucide-react';
import { useMemo, useState } from 'react';
import { formatDateTime } from '../../lib/format';
import { displayNodeStatus, nodeStatusMeta } from '../../lib/workflow-meta';
import type { WorkflowEvent, WorkflowNode } from '../../types/workflow';
import { Badge } from '../ui/Badge';
import { Button } from '../ui/Button';
import { EmptyState } from '../ui/EmptyState';
import { Segmented } from '../ui/Segmented';

type EventFilter = 'all' | WorkflowEvent['type'];
const typeLabels: Record<WorkflowEvent['type'], string> = {
  stage: '阶段', agent: 'Agent', review: '审查', approval: '审批', system: '系统',
};
const options: Array<{ value: EventFilter; label: string }> = [
  { value: 'all', label: '全部' },
  ...Object.entries(typeLabels).map(([value, label]) => ({ value: value as WorkflowEvent['type'], label })),
];

function toolLabel(event: WorkflowEvent) {
  return event.toolName && /^[\p{L}\p{N}_./:-]{1,40}$/u.test(event.toolName) ? event.toolName : '工具';
}

function eventLabel(event: WorkflowEvent): string {
  switch (event.kind) {
    case 'tool': return '调用 ' + toolLabel(event);
    case 'thinking': return '过程输出';
    case 'result': return '返回结果';
    case 'status': return '客户端状态';
    case 'usage': return '调用用量';
    case 'session': return '会话信息';
    case 'error': return '执行错误';
    case 'text': return 'Agent 消息';
    default: return typeLabels[event.type];
  }
}

function compact(event: WorkflowEvent) {
  if (!event.kind) return event.message.replace(/\s+/g, ' ').slice(0, 104);
  return eventLabel(event);
}

interface EventGroup {
  id: string;
  node?: WorkflowNode;
  entries: WorkflowEvent[];
}

export function EventStream({ events, nodes = [], onSelectNode, onOpenPlanner }: {
  events: WorkflowEvent[];
  nodes?: WorkflowNode[];
  onSelectNode: (nodeId: string) => void;
  onOpenPlanner?: () => void;
}) {
  const [filter, setFilter] = useState<EventFilter>('all');
  const [limits, setLimits] = useState<Record<string, number>>({});
  const { groups, count } = useMemo(() => {
    const matched = events.filter((event) => filter === 'all' || event.type === filter);
    const byId = new Map(nodes.map((node) => [node.id, node]));
    const grouped = new Map<string, EventGroup>();
    for (const event of matched.reverse().sort((left, right) => right.at.localeCompare(left.at))) {
      const key = event.nodeId ? 'node:' + event.nodeId : event.agent || event.kind ? 'planner' : 'run';
      const group = grouped.get(key) ?? { id: key, node: event.nodeId ? byId.get(event.nodeId) : undefined, entries: [] };
      group.entries.push(event);
      grouped.set(key, group);
    }
    return { groups: [...grouped.values()], count: matched.length };
  }, [events, nodes, filter]);

  return <div className="flex h-full min-h-0 flex-col bg-canvas">
    <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-line bg-surface px-4 py-2.5">
      <div className="max-w-full overflow-x-auto"><Segmented options={options} value={filter} onChange={setFilter} ariaLabel="按事件类型筛选" /></div>
      <span className="text-[11px] text-muted">{groups.length} 组 · {count} 条事件</span>
    </div>
    <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3 sm:px-4">
      {!groups.length && <EmptyState icon={ScrollText} title="没有匹配的事件" description="调整事件类型筛选后再试。" />}
      <div className="space-y-2">
        {groups.map(({ id, node, entries }) => {
          const latest = entries[0]!;
          const agent = node?.agent ?? entries.find((event) => event.agent)?.agent;
          const status = node && nodeStatusMeta[displayNodeStatus(node)];
          const useful = entries.find((entry) => !['usage', 'session', 'thinking'].includes(entry.kind ?? '')) ?? latest;
          const limit = limits[id] ?? 25;
          return <details key={id} className="event-group rounded-xl border border-line bg-surface">
            <summary className="flex cursor-pointer list-none items-start gap-2 px-3 py-3 hover:bg-subtle/40">
              <ChevronRight aria-hidden="true" className="event-chevron mt-0.5 size-4 shrink-0 text-muted" />
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <strong className="break-words text-xs text-ink">{node?.title ?? (id === 'run' ? '运行阶段' : id === 'planner' ? 'PM 与编排器' : latest.nodeId)}</strong>
                  {status && <Badge dot tone={status.tone}>{status.label}</Badge>}
                </div>
                <p className="mt-1 truncate text-[11px] text-muted">{agent && agent + ' · '}{compact(useful)}</p>
              </div>
              <div className="min-w-0 shrink-0 text-right text-[10px] tabular-nums text-muted">
                <time dateTime={latest.at} title={formatDateTime(latest.at)}>{new Date(latest.at).toLocaleTimeString('zh-CN', { hour12: false })}</time>
                <p className="mt-1">{entries.length} 条</p>
              </div>
            </summary>
            <div className="space-y-1.5 border-t border-line px-3 py-2.5">
              {(node || id === 'planner' && onOpenPlanner) && <Button size="sm" variant="secondary"
                onClick={() => node ? onSelectNode(node.id) : onOpenPlanner?.()}>
                <MessageSquare className="size-3.5" />{node ? '打开 Agent 对话' : '和编排器对话'}
              </Button>}
              {entries.slice(0, limit).map((event) => {
                const meta = <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-ink">
                  {eventLabel(event)}<time className="text-[10px] text-muted" dateTime={event.at}>{formatDateTime(event.at)}</time>
                </span>;
                const message = <p className="whitespace-pre-wrap break-words text-xs leading-relaxed text-ink [overflow-wrap:anywhere]">
                  {event.kind === 'tool' && event.toolName && event.toolName !== toolLabel(event) ? event.toolName + '\n' : ''}{event.message}
                </p>;
                return event.kind || event.message.length > 150
                  ? <details className="rounded-lg border border-line bg-subtle/25" key={event.id}>
                    <summary className="cursor-pointer px-2.5 py-1.5">{meta}</summary>
                    <div className="border-t border-line px-2.5 py-2">{message}</div>
                  </details>
                  : <div className="space-y-1 px-2.5 py-1.5" key={event.id}>{meta}{message}</div>;
              })}
              {entries.length > limit && <Button size="sm" variant="ghost" onClick={() => setLimits((previous) => ({ ...previous, [id]: limit + 50 }))}>
                展开更多事件
              </Button>}
            </div>
          </details>;
        })}
      </div>
    </div>
  </div>;
}

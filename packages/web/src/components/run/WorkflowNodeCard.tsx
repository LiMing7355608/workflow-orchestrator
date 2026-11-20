import { Handle, Position, type Node, type NodeProps } from '@xyflow/react';
import { ArrowUpRight, ChevronDown, Files } from 'lucide-react';
import { cn } from '../../lib/cn';
import { formatDuration } from '../../lib/format';
import { displayNodeStatus, nodeStatusMeta, nodeTypeMeta } from '../../lib/workflow-meta';
import type { WorkflowNode } from '../../types/workflow';
import { AgentChip } from '../agents/AgentChip';
import { NodeTimes } from './TaskBreakdown';

export const NODE_WIDTH = 284;
export const NODE_HEIGHT = 106;
export const EXPANDED_HEIGHT = 218;
export const COMPACT_WIDTH = 234;
export const COMPACT_HEIGHT = 76;

export interface WorkflowNodeData extends Record<string, unknown> {
  node: WorkflowNode;
  compact: boolean;
  expanded: boolean;
  onToggle: () => void;
  onInspect: () => void;
}

export type WorkflowFlowNode = Node<WorkflowNodeData, 'workflow'>;

export function WorkflowNodeCard({ data, selected }: NodeProps<WorkflowFlowNode>) {
  const { node, compact, expanded, onToggle, onInspect } = data;
  const typeMeta = nodeTypeMeta[node.type];
  const state = displayNodeStatus(node);
  const statusMeta = nodeStatusMeta[state];
  const Icon = typeMeta.icon;
  const paths = node.delivery?.files.map((file) => file.path) ?? node.deliverables?.map((file) => file.path) ?? [];
  const height = expanded ? EXPANDED_HEIGHT : compact ? COMPACT_HEIGHT : NODE_HEIGHT;
  const width = compact ? COMPACT_WIDTH : NODE_WIDTH;

  return (
    <div data-state={state} className={cn('workflow-node relative overflow-hidden rounded-xl border bg-surface shadow-sm transition-colors',
      selected ? 'border-accent ring-2 ring-accent/20' : 'border-line hover:border-line-strong',
      state === 'running' && !selected && 'border-accent/55',
    )} style={{ width, height }}>
      <Handle type="target" position={Position.Top} className="!size-1.5 !border-0 !bg-line-strong" />
      <span aria-hidden="true" className={cn('absolute inset-y-0 left-0 w-[3px]', typeMeta.dot)} />
      <div className="flex h-full min-w-0 flex-col gap-1 px-3 py-2">
        <div className="flex items-center gap-1.5">
          <Icon className="size-3.5 shrink-0" style={{ color: typeMeta.color }} aria-hidden="true" />
          <span className="text-[10px] font-semibold text-muted">{typeMeta.label}</span>
          <span className={cn('ml-auto inline-flex shrink-0 items-center gap-1 text-[10px]', statusMeta.text)}>
            <span className={cn('size-1.5 rounded-full motion-reduce:animate-none', statusMeta.dot)} />{statusMeta.label}
          </span>
          <button type="button" onClick={(event) => { event.stopPropagation(); onToggle(); }}
            aria-expanded={expanded} aria-label={expanded ? '收起 ' + node.title : '展开 ' + node.title}
            title={expanded ? '收起任务卡' : '展开任务卡'}
            className="nodrag nopan -mr-1 grid size-5 shrink-0 place-items-center rounded text-muted hover:bg-subtle hover:text-accent focus-visible:ring-1 focus-visible:ring-accent">
            <ChevronDown className={cn('size-3.5 transition-transform motion-reduce:transition-none', !expanded && '-rotate-90')} />
          </button>
        </div>
        <p className={cn('break-words text-[13px] font-semibold leading-4 text-ink', compact && !expanded ? 'truncate' : 'line-clamp-2')}
          title={node.title}>{node.title}</p>
        {(!compact || expanded) && <div className="graph-secondary flex items-center justify-between gap-2 text-[10px] text-muted">
          <AgentChip agentId={node.agentId} label={node.type === 'route' ? '编排器' : node.agent} className="min-w-0" iconClassName="size-3" />
          {node.durationMs !== undefined && <span className="shrink-0 tabular-nums">{formatDuration(node.durationMs)}</span>}
        </div>}
        <NodeTimes node={node} compact={!expanded} />
        {expanded && <div className="mt-auto flex min-h-0 flex-col gap-1.5 border-t border-line pt-2">
          <p className="line-clamp-2 break-words text-[10px] leading-[13px] text-muted" title={node.failureReason ?? node.description}>{node.failureReason || node.description}</p>
          {paths.length > 0 && <p className="flex min-w-0 items-center gap-1.5 text-[10px] text-muted" title={paths.join(' · ')}>
            <Files className="size-3 shrink-0 text-accent" />
            <span className="truncate">{node.delivery ? '已落盘' : '计划交付'} · {paths[0]}</span>
            {paths.length > 1 && <span className="shrink-0">{paths.length} 项</span>}
          </p>}
          <button type="button" onClick={(event) => { event.stopPropagation(); onInspect(); }}
            className="nodrag nopan flex w-fit items-center gap-1 rounded px-1 text-[11px] font-medium text-accent hover:bg-accent-soft focus-visible:ring-1 focus-visible:ring-accent">
            <ArrowUpRight className="size-3" />查看详情和记录
          </button>
        </div>}
      </div>
      <Handle type="source" position={Position.Bottom} className="!size-1.5 !border-0 !bg-line-strong" />
    </div>
  );
}

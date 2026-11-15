import { Handle, Position, type Node, type NodeProps } from '@xyflow/react';
import { cn } from '../../lib/cn';
import { formatDuration } from '../../lib/format';
import { nodeStatusMeta, nodeTypeMeta } from '../../lib/workflow-meta';
import type { WorkflowNode } from '../../types/workflow';

export interface WorkflowNodeData extends Record<string, unknown> {
  node: WorkflowNode;
}

export type WorkflowFlowNode = Node<WorkflowNodeData, 'workflow'>;

export function WorkflowNodeCard({
  data,
  selected,
}: NodeProps<WorkflowFlowNode>) {
  const node = data.node;
  const typeMeta = nodeTypeMeta[node.type];
  const statusMeta = nodeStatusMeta[node.status];
  const Icon = typeMeta.icon;

  return (
    <div
      className={cn(
        'relative h-[88px] w-[220px] overflow-hidden rounded-lg border bg-surface px-3 py-2.5 transition-all duration-150',
        selected
          ? 'border-accent ring-2 ring-accent/20'
          : 'border-line hover:border-line-strong',
      )}
    >
      <span
        aria-hidden="true"
        className={cn('absolute inset-y-0 left-0 w-[3px]', typeMeta.dot)}
      />

      <Handle
        type="target"
        position={Position.Top}
        className="!h-1.5 !w-1.5 !border-0 !bg-line-strong"
      />

      <div className="flex items-start gap-2.5 pl-1">
        <span
          className={cn(
            'grid h-8 w-8 shrink-0 place-items-center rounded-md',
            typeMeta.tile,
          )}
        >
          <Icon className="h-4 w-4" strokeWidth={1.8} />
        </span>

        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-2">
            <span className="text-[10px] text-muted">{typeMeta.label}</span>
            <span
              className={cn(
                'inline-flex shrink-0 items-center gap-1 text-[10px]',
                statusMeta.text,
              )}
            >
              <span
                className={cn('h-1.5 w-1.5 rounded-full', statusMeta.dot)}
              />
              {statusMeta.label}
            </span>
          </div>

          <p className="mt-1 truncate text-[12px] font-medium leading-4 text-ink">
            {node.title}
          </p>

          <div className="mt-1 flex items-center justify-between gap-2 text-[10px] text-passive">
            <span className="truncate">{node.agent}</span>
            <span className="shrink-0 tabular-nums">
              {formatDuration(node.durationMs)}
            </span>
          </div>
        </div>
      </div>

      {node.attempts > 1 ? (
        <span className="absolute bottom-1.5 right-2 rounded bg-coral-soft px-1 py-0.5 text-[9px] text-coral">
          重试 {node.attempts}
        </span>
      ) : null}

      <Handle
        type="source"
        position={Position.Bottom}
        className="!h-1.5 !w-1.5 !border-0 !bg-line-strong"
      />
    </div>
  );
}

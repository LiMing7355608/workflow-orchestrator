import {
  GitBranch,
  ShieldCheck,
  UserCheck,
} from 'lucide-react';
import { cn } from '../../lib/cn';
import type { BoardCard as BoardCardModel } from '../../lib/board';
import { formatDuration } from '../../lib/format';
import { displayNodeStatus, nodeStatusMeta } from '../../lib/workflow-meta';
import { AgentChip } from '../agents/AgentChip';
import { Badge } from '../ui/Badge';

interface BoardCardProps {
  card: BoardCardModel;
  selected: boolean;
  onSelect: (nodeId: string) => void;
}

export function BoardCard({ card, selected, onSelect }: BoardCardProps) {
  // 卡片上的「已停止」来自 displayNodeStatus，泳道归属仍按调度状态算
  const statusMeta = nodeStatusMeta[displayNodeStatus(card.focusNode)];

  return (
    <button
      type="button"
      onClick={() => onSelect(card.focusNode.id)}
      className={cn(
        'w-full rounded-lg border bg-surface p-3 text-left transition-colors duration-150',
        selected
          ? 'border-accent ring-2 ring-accent/15'
          : 'border-line hover:border-line-strong hover:bg-subtle/20',
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <p className="min-w-0 text-[12px] font-medium leading-4 text-ink">
          {card.implement.title}
        </p>
        <Badge tone={statusMeta.tone} dot>
          {statusMeta.label}
        </Badge>
      </div>

      <AgentChip
        agentId={card.implement.agentId}
        label={card.implement.agent}
        className="mt-1 text-[10px] text-muted"
        iconClassName="h-3 w-3"
      />

      <div className="mt-2 flex items-center gap-1.5 text-[10px] text-passive">
        <GitBranch className="h-3 w-3 shrink-0" strokeWidth={1.8} />
        <span className="truncate font-mono">
          node/{card.implement.id}
        </span>
      </div>

      <div className="mt-1 flex items-center justify-between gap-2 text-[10px] text-passive">
        <span className="truncate font-mono">
          {card.implement.files[0] ?? '无独占文件'}
        </span>
        <span className="shrink-0 tabular-nums">
          {formatDuration(card.implement.durationMs)}
        </span>
      </div>

      {card.approval ? (
        <div className="mt-2 flex items-center gap-1.5 rounded-md border border-warning/15 bg-warning-soft/50 px-2 py-1 text-[10px] text-warning">
          <UserCheck className="h-3 w-3 shrink-0" strokeWidth={1.8} />
          <span className="truncate">{card.approval.title}</span>
        </div>
      ) : card.review ? (
        <div className="mt-2 flex items-center gap-1.5 rounded-md border border-line bg-subtle/50 px-2 py-1 text-[10px] text-muted">
          <ShieldCheck className="h-3 w-3 shrink-0" strokeWidth={1.8} />
          <span className="truncate">
            {card.review.title} · {nodeStatusMeta[displayNodeStatus(card.review)].label}
          </span>
        </div>
      ) : null}
    </button>
  );
}

import type { RunStatus } from '../../types/workflow';
import { Badge, type BadgeTone } from '../ui/Badge';

const statusMap: Record<RunStatus, { label: string; tone: BadgeTone }> = {
  running: { label: '运行中', tone: 'blue' },
  waiting_for_boss: { label: '待你处理', tone: 'coral' },
  completed: { label: '已完成', tone: 'green' },
  paused: { label: '已暂停', tone: 'neutral' },
  draft: { label: '草稿', tone: 'neutral' },
};

interface RunStatusBadgeProps {
  status: RunStatus;
  className?: string;
}

export function RunStatusBadge({ status, className }: RunStatusBadgeProps) {
  const item = statusMap[status];

  return (
    <Badge tone={item.tone} dot className={className}>
      {item.label}
    </Badge>
  );
}

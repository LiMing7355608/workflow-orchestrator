import type { RunStatus } from '../../types/workflow';
import { Badge, type BadgeTone } from '../ui/Badge';

const statusMap: Record<RunStatus, { label: string; tone: BadgeTone }> = {
  running: { label: '运行中', tone: 'blue' },
  waiting_for_boss: { label: '待你处理', tone: 'coral' },
  completed: { label: '已完成', tone: 'green' },
  paused: { label: '已暂停', tone: 'neutral' },
  draft: { label: '草稿', tone: 'neutral' },
  // `failed` 的文案要看阶段，见下
  failed: { label: '执行受阻', tone: 'red' },
};

interface RunStatusBadgeProps {
  status: RunStatus;
  /**
   * 已经拆出图了没有。
   *
   * `failed` 在事实层有两种来源，混成一句话会把用户引到错的方向：
   * - 图从来没冻出来 → 真的是拆解失败，下一步是「重新拆解」
   * - 图拆出来了、执行阶段卡死 → 一个节点都没在跑、也没有就绪节点，
   *   下一步是「哪个节点挂了、要不要重试」
   *
   * 用一个字的差别区分它们，比让用户自己猜有效。
   */
  hasGraph?: boolean;
  className?: string;
}

export function RunStatusBadge({
  status,
  hasGraph,
  className,
}: RunStatusBadgeProps) {
  const item = statusMap[status];
  const label =
    status === 'failed' ? (hasGraph ? '执行受阻' : '拆解失败') : item.label;

  return (
    <Badge tone={item.tone} dot className={className}>
      {label}
    </Badge>
  );
}

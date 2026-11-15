import type {
  WorkflowNode,
  WorkflowRunDetail,
} from '../types/workflow';

export type BoardLane = 'working' | 'needs_you' | 'in_review' | 'ready';

export interface BoardCard {
  id: string;
  lane: BoardLane;
  implement: WorkflowNode;
  focusNode: WorkflowNode;
  review?: WorkflowNode;
  approval?: WorkflowNode;
}

export interface BoardColumn {
  key: BoardLane;
  title: string;
  description: string;
  dot: string;
  cards: BoardCard[];
}

export const boardLaneMeta: Record<
  BoardLane,
  { title: string; description: string; dot: string }
> = {
  working: {
    title: '进行中',
    description: '正在执行或等待调度',
    dot: 'bg-accent',
  },
  needs_you: {
    title: '待你处理',
    description: '等待人工审批',
    dot: 'bg-coral',
  },
  in_review: {
    title: '审查中',
    description: '独立审查进行中',
    dot: 'bg-review',
  },
  ready: {
    title: '待合并',
    description: '审查已通过，等待交付',
    dot: 'bg-success',
  },
};

/**
 * 以实现节点为任务卡，把下游审查/审批状态折叠成四条泳道。
 */
export function deriveBoard(run: WorkflowRunDetail): BoardColumn[] {
  const byId = new Map(
    run.nodes.map((node) => [node.id, node] as const),
  );
  const outgoing = new Map<string, string[]>();

  run.nodes.forEach((node) => outgoing.set(node.id, []));
  run.edges.forEach((edge) => {
    if (byId.has(edge.source) && byId.has(edge.target)) {
      outgoing.get(edge.source)?.push(edge.target);
    }
  });

  const downstream = (nodeId: string) =>
    (outgoing.get(nodeId) ?? [])
      .map((id) => byId.get(id))
      .filter((node): node is WorkflowNode => Boolean(node));

  const cards: BoardCard[] = run.nodes
    .filter((node) => node.type === 'implement')
    .map((implement) => {
      const direct = downstream(implement.id);
      const review = direct.find((node) => node.type === 'review');
      const approval =
        direct.find((node) => node.type === 'approval') ??
        (review
          ? downstream(review.id).find((node) => node.type === 'approval')
          : undefined);

      let lane: BoardLane = 'working';

      if (approval?.status === 'waiting_approval') {
        lane = 'needs_you';
      } else if (
        review?.status === 'running' ||
        (implement.status === 'completed' &&
          review &&
          review.status !== 'completed')
      ) {
        lane = 'in_review';
      } else if (
        implement.status === 'completed' &&
        (!review || review.status === 'completed') &&
        (!approval || approval.status === 'completed')
      ) {
        lane = 'ready';
      }

      const focusNode =
        lane === 'needs_you' && approval
          ? approval
          : lane === 'in_review' && review
            ? review
            : implement;

      return {
        id: implement.id,
        lane,
        implement,
        focusNode,
        review,
        approval,
      };
    });

  return (Object.keys(boardLaneMeta) as BoardLane[]).map((key) => ({
    key,
    ...boardLaneMeta[key],
    cards: cards.filter((card) => card.lane === key),
  }));
}

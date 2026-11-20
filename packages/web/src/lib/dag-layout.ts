import type { WorkflowEdge, WorkflowNode } from '../types/workflow';

export interface DagPosition {
  x: number;
  y: number;
}

export interface DagLayoutOptions {
  nodeWidth?: number;
  nodeHeight?: number;
  heightByNode?: ReadonlyMap<string, number>;
  horizontalGap?: number;
  verticalGap?: number;
}

/**
 * 按依赖层级做自上而下的布局。没有依赖的节点在第一层，
 * 其他节点的层级等于所有上游层级最大值 + 1。
 */
export function layoutDag(
  nodes: WorkflowNode[],
  edges: WorkflowEdge[],
  options: DagLayoutOptions = {},
): Map<string, DagPosition> {
  const nodeWidth = options.nodeWidth ?? 220;
  const nodeHeight = options.nodeHeight ?? 88;
  const horizontalGap = options.horizontalGap ?? 32;
  const verticalGap = options.verticalGap ?? 56;

  const nodeIds = new Set(nodes.map((node) => node.id));
  const originalOrder = new Map(
    nodes.map((node, index) => [node.id, index] as const),
  );
  const indegree = new Map<string, number>();
  const outgoing = new Map<string, string[]>();

  nodes.forEach((node) => {
    indegree.set(node.id, 0);
    outgoing.set(node.id, []);
  });

  edges.forEach((edge) => {
    if (!nodeIds.has(edge.source) || !nodeIds.has(edge.target)) {
      return;
    }
    indegree.set(edge.target, (indegree.get(edge.target) ?? 0) + 1);
    outgoing.get(edge.source)?.push(edge.target);
  });

  const level = new Map<string, number>();
  nodes.forEach((node) => level.set(node.id, 0));

  const queue = nodes
    .filter((node) => (indegree.get(node.id) ?? 0) === 0)
    .map((node) => node.id);
  const order: string[] = [];

  while (queue.length > 0) {
    const id = queue.shift();
    if (!id) {
      break;
    }

    order.push(id);

    for (const target of outgoing.get(id) ?? []) {
      level.set(
        target,
        Math.max(level.get(target) ?? 0, (level.get(id) ?? 0) + 1),
      );
      const remaining = (indegree.get(target) ?? 1) - 1;
      indegree.set(target, remaining);
      if (remaining === 0) {
        queue.push(target);
      }
    }
  }

  const processed = new Set(order);
  nodes.forEach((node) => {
    if (!processed.has(node.id)) {
      order.push(node.id);
    }
  });

  const byLevel = new Map<number, string[]>();
  for (const id of order) {
    const currentLevel = level.get(id) ?? 0;
    const group = byLevel.get(currentLevel) ?? [];
    group.push(id);
    byLevel.set(currentLevel, group);
  }

  byLevel.forEach((group) => {
    group.sort(
      (a, b) =>
        (originalOrder.get(a) ?? 0) - (originalOrder.get(b) ?? 0),
    );
  });

  const maxWidth = Math.max(
    0,
    ...Array.from(
      byLevel.values(),
      (group) =>
        group.length * nodeWidth + Math.max(0, group.length - 1) * horizontalGap,
    ),
  );
  const maxLevel = Math.max(0, ...Array.from(byLevel.keys()));

  const positions = new Map<string, DagPosition>();

  let nextY = 0;
  for (const [, group] of [...byLevel].sort(([left], [right]) => left - right)) {
    const groupWidth =
      group.length * nodeWidth +
      Math.max(0, group.length - 1) * horizontalGap;
    const startX = (maxWidth - groupWidth) / 2;

    group.forEach((id, index) => {
      positions.set(id, {
        x: startX + index * (nodeWidth + horizontalGap),
        y: nextY,
      });
    });
    let rowHeight = nodeHeight;
    for (const id of group) rowHeight = Math.max(rowHeight, options.heightByNode?.get(id) ?? nodeHeight);
    nextY += rowHeight + verticalGap;
  }

  // 环或异常数据不会导致节点丢失，兜底放在最底部。
  nodes.forEach((node, index) => {
    if (!positions.has(node.id)) {
      positions.set(node.id, {
        x: index * (nodeWidth + horizontalGap),
        y: (maxLevel + 1) * (nodeHeight + verticalGap),
      });
    }
  });

  return positions;
}

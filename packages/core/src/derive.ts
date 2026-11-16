import type {
  BoardLane,
  EdgeView,
  EventView,
  NodeFacts,
  NodeStatus,
  NodeView,
  OrchestratorEvent,
  RunDetailView,
  RunFacts,
  RunStatus,
  RunView,
} from './types.js';

/** 把 agentId 解析成平台名的回调。编排器不直接依赖 Agent 目录的具体实现。 */
export type AgentLabelResolver = (agentId: string | undefined) => string | undefined;

/** 纯逻辑节点（审批、路由）没有 Agent，用事实里记录的展示名兜底。 */
function nodeAgentLabel(node: NodeFacts, resolve: AgentLabelResolver): string {
  return resolve(node.agentId) ?? node.executor ?? node.id;
}

/**
 * 节点状态推导。
 *
 * 优先级刻意这样排：执行中的事实压过依赖关系，
 * 被驳回过的节点在重新开始前显示为「退回重做」，
 * 其余按上游完成情况判定就绪与否。
 */
export function deriveNodeStatus(run: RunFacts, node: NodeFacts): NodeStatus {
  if (node.failureReason && !node.startedAt) {
    return 'failed';
  }
  if (node.startedAt && !node.finishedAt) {
    return node.type === 'approval' ? 'waiting_approval' : 'running';
  }
  if (node.finishedAt) {
    return 'completed';
  }
  if (node.attempts > 1) {
    return 'retry';
  }
  const dependencies = node.dependsOn.map((id) => run.nodes[id]);
  const depsSettled = dependencies.every(
    (dependency) =>
      dependency !== undefined &&
      deriveNodeStatus(run, dependency) === 'completed',
  );
  return depsSettled ? 'ready' : 'pending';
}

/**
 * 运行状态推导。注意没有读任何 status 字段——
 * `frozenAt` / `pausedAt` / `completedAt` 与节点事实是唯一依据。
 */
export function deriveRunStatus(run: RunFacts): RunStatus {
  const nodes = Object.values(run.nodes);
  const awaitingHuman = nodes.some(
    (node) => node.type === 'approval' && node.startedAt && !node.finishedAt,
  );
  if (awaitingHuman) {
    return 'waiting_for_boss';
  }
  if (run.completedAt) {
    return 'completed';
  }
  if (run.pausedAt) {
    return 'paused';
  }
  if (!run.frozenAt) {
    return 'draft';
  }
  return 'running';
}

export function deriveProgress(run: RunFacts): number {
  const nodes = Object.values(run.nodes);
  if (nodes.length === 0) {
    return 0;
  }
  const done = nodes.filter(
    (node) => deriveNodeStatus(run, node) === 'completed',
  ).length;
  return Math.round((done / nodes.length) * 100);
}

/** 最近一次事实变更时刻，用作列表排序依据。 */
export function deriveUpdatedAt(run: RunFacts): string {
  const stamps = [run.createdAt, run.frozenAt, run.pausedAt, run.completedAt];
  for (const node of Object.values(run.nodes)) {
    stamps.push(node.startedAt, node.finishedAt);
  }
  return stamps
    .filter((stamp): stamp is string => Boolean(stamp))
    .sort()
    .at(-1) ?? run.createdAt;
}

export function deriveNodeView(
  run: RunFacts,
  node: NodeFacts,
  resolve: AgentLabelResolver,
): NodeView {
  const duration =
    node.startedAt && node.finishedAt
      ? new Date(node.finishedAt).getTime() - new Date(node.startedAt).getTime()
      : undefined;

  return {
    id: node.id,
    title: node.title,
    description: node.description,
    type: node.type,
    status: deriveNodeStatus(run, node),
    agent: nodeAgentLabel(node, resolve),
    agentId: node.agentId,
    dependsOn: node.dependsOn,
    files: node.files,
    attempts: node.attempts,
    durationMs: duration !== undefined && Number.isFinite(duration) ? duration : undefined,
    escalated: node.escalated,
  };
}

export function deriveNodes(run: RunFacts, resolve: AgentLabelResolver): NodeView[] {
  return run.nodeOrder
    .map((id) => run.nodes[id])
    .filter((node): node is NodeFacts => Boolean(node))
    .map((node) => deriveNodeView(run, node, resolve));
}

/** 依赖边由节点事实直接生成，图结构冻结后不再变化。 */
export function deriveEdges(run: RunFacts): EdgeView[] {
  const edges: EdgeView[] = [];
  for (const id of run.nodeOrder) {
    const node = run.nodes[id];
    if (!node) {
      continue;
    }
    for (const dependency of node.dependsOn) {
      edges.push({
        id: `e-${dependency}-${node.id}`,
        source: dependency,
        target: node.id,
      });
    }
  }
  return edges;
}

export function deriveRunView(run: RunFacts): RunView {
  return {
    id: run.id,
    title: run.title,
    summary: run.summary,
    status: deriveRunStatus(run),
    stage: run.stage,
    progress: deriveProgress(run),
    nodeCount: run.nodeOrder.length,
    specVersion: run.specVersion,
    updatedAt: deriveUpdatedAt(run),
  };
}

/* ------------------------------------------------------------------ *
 * 事件视图：把事实事件翻译成看板可读的一行
 * ------------------------------------------------------------------ */

type EventKind = EventView['type'];

function eventKind(event: OrchestratorEvent): EventKind {
  switch (event.type) {
    case 'run.created':
    case 'run.frozen':
    case 'run.paused':
    case 'run.resumed':
    case 'run.completed':
      return 'stage';
    case 'review.verdict':
    case 'review.escalated':
      return 'review';
    case 'approval.requested':
    case 'approval.decided':
      return 'approval';
    case 'node.started':
    case 'node.completed':
    case 'node.failed':
    case 'node.reset':
    case 'agent.output':
      return 'agent';
    default:
      return 'system';
  }
}

function nodeTitleOf(run: RunFacts, nodeId: string): string {
  return run.nodes[nodeId]?.title ?? nodeId;
}

function eventMessage(run: RunFacts, event: OrchestratorEvent): string {
  switch (event.type) {
    case 'run.created':
      return `创建运行：${event.run.title}`;
    case 'run.frozen':
      return 'DAG 已冻结，进入执行阶段';
    case 'run.paused':
      return '运行已暂停';
    case 'run.resumed':
      return '运行已恢复';
    case 'run.completed':
      return '全部节点完成，运行结束';
    case 'node.started':
      return `${nodeTitleOf(run, event.nodeId)} 开始执行`;
    case 'node.completed':
      return `${nodeTitleOf(run, event.nodeId)} 完成`;
    case 'node.failed':
      return `${nodeTitleOf(run, event.nodeId)} 失败：${event.reason}`;
    case 'node.reset':
      return `${nodeTitleOf(run, event.nodeId)} 被退回重做：${event.reason}`;
    case 'review.verdict':
      return event.verdict === 'approved'
        ? `审查通过：${nodeTitleOf(run, event.nodeId)}`
        : `审查驳回：${nodeTitleOf(run, event.nodeId)}`;
    case 'review.escalated':
      return `审查超限，升级人工：${nodeTitleOf(run, event.nodeId)}`;
    case 'approval.requested':
      return `等待人工审批：${nodeTitleOf(run, event.record.nodeId)}`;
    case 'approval.decided': {
      const label =
        event.decision === 'approve'
          ? '批准'
          : event.decision === 'reject'
            ? '驳回'
            : '转交';
      return `审批${label}：${event.actor}${event.reason ? `（${event.reason}）` : ''}`;
    }
    case 'agent.output':
      return event.chunk.trim();
    default:
      return '';
  }
}

export function deriveEvents(run: RunFacts, events: OrchestratorEvent[]): EventView[] {
  const scoped = events.filter((event) => event.runId === run.id);
  const resolve: AgentLabelResolver = () => undefined;

  return scoped.map((event, index) => {
    const nodeId =
      'nodeId' in event
        ? event.nodeId
        : event.type === 'approval.requested'
          ? event.record.nodeId
          : undefined;
    const node = nodeId ? run.nodes[nodeId] : undefined;

    return {
      id: `ev-${index}`,
      at: event.at,
      type: eventKind(event),
      message: eventMessage(run, event),
      nodeId,
      agent: node ? nodeAgentLabel(node, resolve) : undefined,
    };
  });
}

export function deriveRunDetail(
  run: RunFacts,
  events: OrchestratorEvent[],
  resolve: AgentLabelResolver,
): RunDetailView {
  return {
    ...deriveRunView(run),
    nodes: deriveNodes(run, resolve),
    edges: deriveEdges(run),
    events: deriveEvents(run, events),
  };
}

/* ------------------------------------------------------------------ *
 * 四泳道：以实现节点为任务卡，把下游审查/审批状态折叠成泳道
 * ------------------------------------------------------------------ */

export interface BoardCardView {
  id: string;
  lane: BoardLane;
  implement: NodeView;
  focus: NodeView;
  review?: NodeView;
  approval?: NodeView;
}

export function deriveBoard(
  nodes: NodeView[],
  edges: EdgeView[],
): Record<BoardLane, BoardCardView[]> {
  const byId = new Map(nodes.map((node) => [node.id, node] as const));
  const outgoing = new Map<string, string[]>();
  for (const node of nodes) {
    outgoing.set(node.id, []);
  }
  for (const edge of edges) {
    if (byId.has(edge.source) && byId.has(edge.target)) {
      outgoing.get(edge.source)?.push(edge.target);
    }
  }

  const downstream = (id: string): NodeView[] =>
    (outgoing.get(id) ?? [])
      .map((next) => byId.get(next))
      .filter((node): node is NodeView => Boolean(node));

  const lanes: Record<BoardLane, BoardCardView[]> = {
    working: [],
    needs_you: [],
    in_review: [],
    ready: [],
  };

  for (const implement of nodes) {
    if (implement.type !== 'implement') {
      continue;
    }
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
      (implement.status === 'completed' && review && review.status !== 'completed')
    ) {
      lane = 'in_review';
    } else if (
      implement.status === 'completed' &&
      (!review || review.status === 'completed') &&
      (!approval || approval.status === 'completed')
    ) {
      lane = 'ready';
    }

    const focus =
      lane === 'needs_you' && approval
        ? approval
        : lane === 'in_review' && review
          ? review
          : implement;

    lanes[lane].push({
      id: implement.id,
      lane,
      implement,
      focus,
      review,
      approval,
    });
  }

  return lanes;
}

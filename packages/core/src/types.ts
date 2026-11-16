/**
 * 领域类型：事实与视图分离。
 *
 * 铁律：展示状态从不入库。`RunFacts` / `NodeFacts` 只记录发生了什么
 * （开始时刻、结束时刻、裁决、尝试次数），`RunView` 里的 status、进度、
 * 泳道全部由 `derive.ts` 在读取时算出来。
 *
 * 这样前端不需要等后端把某个 status 字段写对，编排器也不需要维护
 * 「状态字段和真实执行情况一致」这条永远会漂移的约束。
 */

export type RunStage = 'spec' | 'decompose' | 'orchestrate' | 'execute';

export type RunStatus = 'draft' | 'running' | 'waiting_for_boss' | 'completed' | 'paused';

export type NodeType = 'implement' | 'review' | 'approval' | 'route';

export type NodeStatus =
  | 'pending'
  | 'ready'
  | 'running'
  | 'completed'
  | 'failed'
  | 'waiting_approval'
  | 'retry';

export type ReviewVerdict = 'approved' | 'changes_requested';

export type ApprovalDecision = 'approve' | 'reject' | 'handoff';

export type ApprovalStatus = 'pending' | 'approved' | 'rejected' | 'handed_off';

/** 一次编排的持久事实。 */
export interface RunFacts {
  id: string;
  title: string;
  summary: string;
  /** 原始目标描述，Planner 的输入 */
  goal: string;
  specVersion: string;
  stage: RunStage;
  /** 注意：这里没有 status 字段——运行状态由 frozenAt / pausedAt / completedAt 与节点事实推导 */
  createdAt: string;
  /** DAG 冻结时刻。冻结后图结构不再变化 */
  frozenAt?: string;
  pausedAt?: string;
  completedAt?: string;
  /** 节点顺序，保证渲染稳定 */
  nodeOrder: string[];
  nodes: Record<string, NodeFacts>;
}

/** 单个节点的持久事实。 */
export interface NodeFacts {
  id: string;
  type: NodeType;
  title: string;
  description: string;
  dependsOn: string[];
  /** 独占文件范围，串并行安全的静态保障 */
  files: string[];
  /** 执行该节点的 Agent；审批与路由节点为空 */
  agentId?: string;
  /** 人类审批人与编排器节点使用的展示名 */
  executor?: string;
  attempts: number;
  maxAttempts: number;
  startedAt?: string;
  finishedAt?: string;
  verdict?: ReviewVerdict;
  failureReason?: string;
  /** 审查超限后升级到人工 */
  escalated?: boolean;
}

/** 审批记录：不可变追加，每次请求与决策各一条。 */
export interface ApprovalRecord {
  id: string;
  runId: string;
  nodeId: string;
  status: ApprovalStatus;
  actor?: string;
  reason?: string;
  requestedAt: string;
  decidedAt?: string;
  handedOffTo?: string;
}

/** 投影状态：所有事实的内存视图，可由事件日志完整重放。 */
export interface ProjectState {
  runs: Record<string, RunFacts>;
  approvals: ApprovalRecord[];
}

/* ------------------------------------------------------------------ *
 * 事件：唯一的事实写入通道
 * ------------------------------------------------------------------ */

export interface BaseEvent {
  at: string;
  runId: string;
}

export type OrchestratorEvent =
  | (BaseEvent & { type: 'run.created'; run: RunFacts })
  | (BaseEvent & { type: 'run.frozen' })
  | (BaseEvent & { type: 'run.paused' })
  | (BaseEvent & { type: 'run.resumed' })
  | (BaseEvent & { type: 'run.completed' })
  | (BaseEvent & { type: 'node.started'; nodeId: string })
  | (BaseEvent & { type: 'node.completed'; nodeId: string })
  | (BaseEvent & { type: 'node.failed'; nodeId: string; reason: string })
  | (BaseEvent & { type: 'node.reset'; nodeId: string; reason: string })
  | (BaseEvent & { type: 'review.verdict'; nodeId: string; verdict: ReviewVerdict })
  | (BaseEvent & { type: 'review.escalated'; nodeId: string })
  | (BaseEvent & { type: 'approval.requested'; record: ApprovalRecord })
  | (BaseEvent & {
      type: 'approval.decided';
      approvalId: string;
      decision: ApprovalDecision;
      actor: string;
      reason?: string;
    })
  | (BaseEvent & {
      type: 'agent.output';
      nodeId: string;
      agentId: string;
      chunk: string;
    });

export type EventType = OrchestratorEvent['type'];

/* ------------------------------------------------------------------ *
 * 视图：API 返回形状，前端直接消费
 * ------------------------------------------------------------------ */

export interface RunView {
  id: string;
  title: string;
  summary: string;
  status: RunStatus;
  stage: RunStage;
  /** 已完成节点占比，读时算 */
  progress: number;
  nodeCount: number;
  specVersion: string;
  updatedAt: string;
}

export interface NodeView {
  id: string;
  title: string;
  description: string;
  type: NodeType;
  status: NodeStatus;
  /** 平台名，由 agentId 查目录得到 */
  agent: string;
  agentId?: string;
  dependsOn: string[];
  files: string[];
  attempts: number;
  durationMs?: number;
  escalated?: boolean;
}

export interface EdgeView {
  id: string;
  source: string;
  target: string;
  label?: string;
}

export interface EventView {
  id: string;
  at: string;
  type: 'stage' | 'agent' | 'review' | 'approval' | 'system';
  message: string;
  nodeId?: string;
  agent?: string;
}

export interface RunDetailView extends RunView {
  nodes: NodeView[];
  edges: EdgeView[];
  events: EventView[];
}

export interface ApprovalView extends ApprovalRecord {
  runTitle: string;
  nodeTitle: string;
}

/* ------------------------------------------------------------------ *
 * 泳道：与看板四列一一对应，全部由节点视图推导
 * ------------------------------------------------------------------ */

export type BoardLane = 'working' | 'needs_you' | 'in_review' | 'ready';

export const boardLaneOrder: BoardLane[] = [
  'working',
  'needs_you',
  'in_review',
  'ready',
];

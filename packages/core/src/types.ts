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

import type { AgentEventKind } from './parsers.js';

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
  /**
   * 最近一次采集到的产物统计，仅供展示与提示词预算判断。
   *
   * diff 原文一律不进事实——它可能有几百 KB，写进事件日志等于
   * 每重放一次就要在内存里搬一遍，而且这些字节对状态机毫无用处。
   */
  artifactBytes?: number;
  /** 产物命中的路径，用于看板显示「改了哪些文件」 */
  artifactFiles?: string[];
  /**
   * Agent 自己报出来的原生会话 id（Claude 的 session_id、Codex 的 thread_id 等）。
   *
   * 存进事实是因为会话续跑（`session.derive: 'hooked'` 那类平台）只能靠它：
   * 进程退出后唯一还能接上上一轮上下文的东西就是这个 id，而它只出现在
   * 流式输出里，晚一步不落账就永久丢了。
   */
  nativeSessionId?: string;
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
      /**
       * 解析器给出的细分类型。老日志没有这个字段，读时按 text 处理，
       * 因此它只能是可选的——加必填字段等于让历史事件全部变成非法数据。
       */
      kind?: AgentEventKind;
      /** kind 为 tool 时的工具名，事件流要显示成「调用工具 X」 */
      toolName?: string;
    })
  | (BaseEvent & {
      /** 采集到 Agent 的原生会话 id。续跑要用，因此必须进事实而不是只走事件流。 */
      type: 'agent.session';
      nodeId: string;
      agentId: string;
      sessionId: string;
    })
  | (BaseEvent & {
      /** 产物采集完成。只带统计量与落盘位置，diff 原文在文件里。 */
      type: 'node.artifact';
      nodeId: string;
      bytes: number;
      files: string[];
      /** diff 文件路径；工作区不可采集或存盘失败时缺省 */
      diffPath?: string;
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
  /** 上游产物的统计量；没有产物采集时缺省 */
  artifactBytes?: number;
  artifactFiles?: string[];
  /** 原生会话 id，透出给前端展示与「从这一轮续跑」的入口 */
  nativeSessionId?: string;
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
  /**
   * agent 类事件的细分（text / tool / result / usage / session / error）。
   *
   * 与 `type` 正交：`type` 决定这一行归到哪个筛选页签，`kind` 只用于给同一
   * 页签里的条目加个更细的小标记，前端不该拿它做控制流。
   */
  kind?: AgentEventKind;
  toolName?: string;
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

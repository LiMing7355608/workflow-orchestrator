export type RunStage = 'spec' | 'decompose' | 'orchestrate' | 'execute';

export type RunStatus =
  | 'running'
  | 'waiting_for_boss'
  | 'completed'
  | 'paused'
  | 'draft';

export type NodeType = 'implement' | 'review' | 'approval' | 'route';

export type NodeStatus =
  | 'pending'
  | 'ready'
  | 'running'
  | 'completed'
  | 'failed'
  | 'waiting_approval'
  | 'retry';

export interface WorkflowRunSummary {
  id: string;
  title: string;
  summary: string;
  status: RunStatus;
  stage: RunStage;
  progress: number;
  nodeCount: number;
  specVersion: string;
  updatedAt: string;
}

export interface WorkflowNode {
  id: string;
  title: string;
  description: string;
  type: NodeType;
  status: NodeStatus;
  /** 执行者名称。有 agentId 时以 Agent 目录里的平台名为准 */
  agent: string;
  /** 绑定的可调度 Agent id；人类审批与编排器节点为空 */
  agentId?: string;
  dependsOn: string[];
  files: string[];
  attempts: number;
  durationMs?: number;
}

export interface WorkflowEdge {
  id: string;
  source: string;
  target: string;
  label?: string;
}

/**
 * Agent 输出的细分类型，与后端 `AgentEventKind` 一一对应。
 *
 * 前端刻意不引 `@orchestrator/core` 的类型：两边各留一份声明，后端加字段时
 * 这里只是少一个标记，不会让整页编译不过。
 */
export type AgentEventKind = 'text' | 'tool' | 'result' | 'usage' | 'session' | 'error';

export interface WorkflowEvent {
  id: string;
  at: string;
  type: 'stage' | 'agent' | 'review' | 'approval' | 'system';
  message: string;
  nodeId?: string;
  agent?: string;
  /** agent 类事件的细分标记；老事件没有这个字段 */
  kind?: AgentEventKind;
  /** kind 为 tool 时的工具名 */
  toolName?: string;
}

export interface WorkflowRunDetail extends WorkflowRunSummary {
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  events: WorkflowEvent[];
}

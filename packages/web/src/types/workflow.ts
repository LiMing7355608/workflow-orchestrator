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
  agent: string;
  dependsOn: string[];
  files: string[];
  attempts: number;
}

export interface WorkflowEdge {
  id: string;
  source: string;
  target: string;
}

export interface WorkflowEvent {
  id: string;
  at: string;
  type: 'stage' | 'agent' | 'review' | 'approval' | 'system';
  message: string;
  nodeId?: string;
  agent?: string;
}

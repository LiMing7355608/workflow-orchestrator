interface InterviewQuestion {
  title: string;
  question: string;
  recommendation: string;
}

export interface InterviewView {
  id: string;
  workspaceRoot: string;
  idea: string;
  agentId: string;
  revision: number;
  status: 'thinking' | 'question' | 'ready' | 'error';
  rounds: Array<{ questions: InterviewQuestion[]; answer?: string }>;
  spec?: string;
  error?: string;
}

export interface BlackboardView {
  directory: string | null;
  hasOutput: boolean;
  entries: Array<{
    id: string;
    at: string;
    author: string;
    source: 'human' | 'agent' | 'system';
    text: string;
    nodeId?: string;
  }>;
}

export interface AgentInterval {
  id: string;
  runId: string;
  runTitle: string;
  nodeId?: string;
  agentId: string;
  agentLabel: string;
  role: 'spec' | 'plan' | 'amend' | 'implement' | 'review';
  title: string;
  description: string;
  startedAt: string;
  finishedAt?: string;
  status: 'running' | 'completed' | 'failed' | 'interrupted';
}

export interface ActivityView {
  mode: string;
  active: number;
  intervals: AgentInterval[];
}

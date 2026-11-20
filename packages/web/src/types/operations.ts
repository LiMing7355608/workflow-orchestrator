import type { TaskDeliverable } from './workflow';

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
  model?: string;
  revision: number;
  status: 'thinking' | 'question' | 'ready' | 'error';
  rounds: Array<{ questions: InterviewQuestion[]; answer?: string }>;
  spec?: string;
  meetings?: Array<{ id: string; title: string; report: string; at: string }>;
  error?: string;
}

export interface InterviewSummary {
  id: string;
  title: string;
  agentId: string;
  model?: string;
  status: InterviewView['status'];
  updatedAt: string;
  roundCount: number;
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
  role: 'spec' | 'plan' | 'check' | 'amend' | 'implement' | 'review' | 'meeting';
  lane?: string;
  model?: string;
  progress?: string;
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

export interface PlanDraftView {
  revision: string;
  attempts: number;
  dag: {
    title: string;
    summary: string;
    nodes: Array<{
      id: string;
      type: 'implement' | 'review' | 'approval' | 'route';
      title: string;
      description: string;
      dependsOn: string[];
      files: string[];
      deliverables?: TaskDeliverable[];
      acceptance?: string[];
      agentId?: string;
      action?: 'merge';
    }>;
  };
  verification: {
    agentId: string;
    status: 'checked' | 'unavailable';
    summary: string;
    findings: Array<{ severity: 'required' | 'suggestion'; text: string; nodeIds: string[] }>;
  };
}

export interface MeetingActor { agentId: string; model?: string }
export interface MeetingRole extends MeetingActor { name: string; responsibility: string; prompt: string }
export interface MeetingSettings {
  title: string;
  agenda: string;
  mode: 'manual' | 'auto';
  host: MeetingActor;
  roles: MeetingRole[];
  rounds: number;
  roundControl?: 'manual' | 'host';
}
export interface MeetingSummary {
  id: string;
  title: string;
  status: 'draft' | 'organizing' | 'running' | 'paused' | 'failed' | 'complete';
  updatedAt: string;
  round: number;
}
export interface MeetingView extends MeetingSettings, MeetingSummary {
  workspaceRoot: string;
  sourceSpecId?: string;
  linkedRunId?: string;
  revision: number;
  turns: Omit<AgentInterval, 'agentLabel'>[];
  messages: Array<{
    id: string;
    at: string;
    kind: 'human' | 'agent' | 'host';
    author: string;
    text: string;
    round?: number;
    model?: string;
  }>;
  report?: string;
  reportStale?: boolean;
  error?: string;
}

import type { AgentProfile } from '../types/agent';
import type {
  WorkflowEvent,
  WorkflowRunDetail,
  WorkflowRunSummary,
} from '../types/workflow';

/**
 * 后端接口封装。
 *
 * 全部函数在失败时返回 null 而不抛异常——调用方据此决定回落静态数据，
 * 这样没起后端时页面照样能看，不会整页白屏。
 */

const API_BASE = '';

async function requestJson<T>(
  path: string,
  init?: RequestInit,
): Promise<T | null> {
  try {
    const response = await fetch(`${API_BASE}${path}`, {
      headers: { Accept: 'application/json', ...(init?.body ? { 'Content-Type': 'application/json' } : {}) },
      ...init,
    });
    if (!response.ok) {
      return null;
    }
    return (await response.json()) as T;
  } catch {
    return null;
  }
}

export function fetchRuns(): Promise<WorkflowRunSummary[] | null> {
  return requestJson<WorkflowRunSummary[]>('/api/runs');
}

export function fetchRunDetail(
  runId: string,
): Promise<WorkflowRunDetail | null> {
  return requestJson<WorkflowRunDetail>(`/api/runs/${encodeURIComponent(runId)}`);
}

export function fetchAgents(): Promise<AgentProfile[] | null> {
  return requestJson<AgentProfile[]>('/api/agents');
}

export function probeAgents(): Promise<AgentProfile[] | null> {
  return requestJson<AgentProfile[]>('/api/agents/probe', { method: 'POST' });
}

export function pauseRun(runId: string): Promise<unknown> {
  return requestJson(`/api/runs/${encodeURIComponent(runId)}/pause`, {
    method: 'POST',
  });
}

export function resumeRun(runId: string): Promise<unknown> {
  return requestJson(`/api/runs/${encodeURIComponent(runId)}/resume`, {
    method: 'POST',
  });
}

export interface ApprovalDecisionInput {
  decision: 'approve' | 'reject' | 'handoff';
  actor: string;
  reason?: string;
  handoffTo?: string;
}

export function decideApproval(
  runId: string,
  nodeId: string,
  input: ApprovalDecisionInput,
): Promise<WorkflowRunDetail | null> {
  return requestJson<WorkflowRunDetail>(
    `/api/runs/${encodeURIComponent(runId)}/nodes/${encodeURIComponent(nodeId)}/approval`,
    { method: 'POST', body: JSON.stringify(input) },
  );
}

/** SSE 负载：服务端把事实事件与已翻译好的视图一起发过来。 */
export interface RunEventPayload {
  runId: string;
  event?: WorkflowEvent;
}

/**
 * 订阅事件流。`onEvent` 可能被高频调用，调用方自己决定要不要防抖。
 * 返回取消订阅函数。
 */
export function subscribeRunEvents(
  onEvent: (payload: RunEventPayload) => void,
): () => void {
  if (typeof EventSource === 'undefined') {
    return () => {};
  }

  const source = new EventSource(`${API_BASE}/events`);
  source.onmessage = (message) => {
    try {
      onEvent(JSON.parse(message.data) as RunEventPayload);
    } catch {
      // 心跳或格式异常直接忽略
    }
  };

  return () => {
    source.close();
  };
}

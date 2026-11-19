import { randomUUID } from 'node:crypto';
import type { AgentRunner, OrchestratorEvent, RunFacts } from '@orchestrator/core';

export interface AgentInterval {
  id: string;
  runId: string;
  runTitle: string;
  nodeId?: string;
  agentId: string;
  role: 'spec' | 'plan' | 'amend' | 'implement' | 'review';
  title: string;
  description: string;
  startedAt: string;
  finishedAt?: string;
  status: 'running' | 'completed' | 'failed' | 'interrupted';
}

function describe(run: RunFacts, nodeId?: string): Pick<AgentInterval, 'role' | 'title' | 'description' | 'nodeId'> {
  const node = nodeId ? run.nodes[nodeId] : undefined;
  if (node?.type === 'implement' || node?.type === 'review') {
    return { role: node.type, title: node.title, description: node.description, nodeId };
  }
  if (run.frozenAt && nodeId) {
    return { role: 'amend', title: '调整任务图', description: '根据补充要求更新尚未开始的任务' };
  }
  return { role: 'plan', title: 'PM 任务分解', description: '读取规格并生成任务、执行角色和依赖' };
}

export class AgentActivity {
  private readonly intervals = new Map<string, AgentInterval>();

  constructor(
    private readonly getRun: (id: string) => RunFacts | undefined,
    private readonly notify: (id: string) => void,
  ) {}

  get entries(): AgentInterval[] {
    return [...this.intervals.values()];
  }

  forget(runId: string): void {
    for (const [key, entry] of this.intervals) {
      if (entry.runId === runId) this.intervals.delete(key);
    }
  }

  observe(runner: AgentRunner): AgentRunner {
    return {
      cancel: runner.cancel?.bind(runner),
      run: async (request, onChunk) => {
        const run = this.getRun(request.runId);
        if (!run) return runner.run(request, onChunk);
        const interval: AgentInterval = {
          id: randomUUID(), runId: run.id, runTitle: run.title, agentId: request.agentId,
          ...describe(run, request.nodeId), startedAt: new Date().toISOString(), status: 'running',
        };
        this.intervals.set(interval.id, interval);
        this.notify(run.id);
        try {
          const result = await runner.run(request, onChunk);
          interval.status = result.cancelled ? 'interrupted' : result.ok ? 'completed' : 'failed';
          return result;
        } catch (error) {
          interval.status = 'failed';
          throw error;
        } finally {
          interval.finishedAt = new Date().toISOString();
          this.prune();
          this.notify(run.id);
        }
      },
    };
  }

  /** Restore completed planning and node intervals from old and new journals. */
  restore(run: RunFacts, events: readonly OrchestratorEvent[]): void {
    if (run.id === 'run-collab-core' && !run.workspaceRoot) return;
    const open = new Map<string, AgentInterval>();
    const reconstructed: AgentInterval[] = [];
    function finish(key: string, at: string, status: AgentInterval['status']) {
      const current = open.get(key);
      if (!current) return;
      open.delete(key);
      reconstructed.push({ ...current, finishedAt: at, status });
    }
    function start(key: string, at: string, agentId: string, nodeId?: string) {
      finish(key, at, 'interrupted');
      open.set(key, {
        id: randomUUID(), runId: run.id, runTitle: run.title, agentId,
        ...describe(run, nodeId), startedAt: at, status: 'running',
      });
    }
    for (const event of events) {
      switch (event.type) {
        case 'plan.started': start('', event.at, event.agentId); break;
        case 'run.frozen': finish('', event.at, 'completed'); break;
        case 'plan.failed': finish('', event.at, 'failed'); break;
        case 'run.paused': finish('', event.at, 'interrupted'); break;
        case 'node.started': {
          const node = run.nodes[event.nodeId];
          if (node?.agentId && (node.type === 'implement' || node.type === 'review')) {
            start(event.nodeId, event.at, node.agentId, event.nodeId);
          }
          break;
        }
        case 'node.completed': finish(event.nodeId, event.at, 'completed'); break;
        case 'node.failed': finish(event.nodeId, event.at, 'failed'); break;
        case 'node.interrupted':
        case 'node.reset': finish(event.nodeId, event.at, 'interrupted'); break;
        case 'review.verdict':
          finish(event.nodeId, event.at, 'completed');
          break;
      }
    }
    for (const entry of reconstructed.slice(-300)) this.intervals.set(entry.id, entry);
    this.prune();
  }

  private prune() {
    const ended = this.entries.filter((entry) => entry.finishedAt).sort(
      (a, b) => a.finishedAt!.localeCompare(b.finishedAt!),
    );
    for (const entry of ended.slice(0, Math.max(0, ended.length - 300))) {
      this.intervals.delete(entry.id);
    }
  }
}

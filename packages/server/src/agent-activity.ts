import { randomUUID } from 'node:crypto';
import { createParser, type AgentProfile, type AgentRunner, type OrchestratorEvent, type RunFacts } from '@orchestrator/core';

export interface AgentInterval {
  id: string;
  runId: string;
  runTitle: string;
  nodeId?: string;
  agentId: string;
  role: 'spec' | 'plan' | 'check' | 'amend' | 'implement' | 'review';
  model?: string;
  progress?: string;
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
  if (nodeId?.startsWith('check-')) {
    return { role: 'check', title: '任务草案交叉核对', description: '核对需求覆盖、依赖关系和验收条件' };
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

  observe(runner: AgentRunner, getAgent: (id: string) => AgentProfile | undefined): AgentRunner {
    return {
      cancel: runner.cancel?.bind(runner),
      run: async (request, onChunk) => {
        const run = this.getRun(request.runId);
        if (!run) return runner.run(request, onChunk);
        const interval: AgentInterval = {
          id: randomUUID(), runId: run.id, runTitle: run.title, agentId: request.agentId, model: request.model,
          ...describe(run, request.nodeId), startedAt: new Date().toISOString(), status: 'running',
        };
        this.intervals.set(interval.id, interval);
        this.notify(run.id);
        const agent = getAgent(request.agentId);
        const parser = agent ? createParser(agent.launch.parser) : undefined;
        let lastNotice = 0;
        try {
          const result = await runner.run(request, (chunk) => {
            onChunk(chunk);
            for (const event of parser?.push(chunk) ?? []) {
              if (event.kind === 'session') interval.progress = '已建立会话，等待输出';
              if (event.kind === 'tool') {
                const name = event.toolName ?? '';
                interval.progress = /^[\p{L}\p{N}_./:-]{1,40}$/u.test(name) ? '正在调用 ' + name : '正在执行工具操作';
              }
              if (event.kind === 'error' && event.text?.trim()) interval.progress = event.text.trim().slice(0, 150);
              if (event.kind === 'text' && event.text?.trim()) {
                const output = event.text.trim().replace(/\s+/g, ' ');
                if (interval.role === 'plan' || interval.role === 'check' || interval.role === 'amend') {
                  interval.progress = '正在返回任务与核对结果';
                } else if (/\p{L}/u.test(output)) {
                  interval.progress = output.slice(-180);
                }
              }
              if (event.kind === 'result') interval.progress = '已收到回复，正在校验输出';
            }
            if (interval.progress && Date.now() - lastNotice >= 600) {
              lastNotice = Date.now();
              this.notify(run.id);
            }
          });
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
        case 'plan.checking':
          finish('', event.at, 'completed');
          start('', event.at, event.agentId, 'check-restored');
          break;
        case 'plan.drafted':
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

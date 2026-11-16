import { describe, expect, it } from 'vitest';
import { deriveEvents } from '../src/derive.js';
import type { OrchestratorEvent, RunFacts } from '../src/types.js';

const RUN = 'run-reset';

function run(): RunFacts {
  return {
    id: RUN,
    title: '重置切片',
    summary: '',
    goal: '',
    workspaceRoot: '/tmp/target-repo',
    specVersion: 'v1.0',
    stage: 'execute',
    createdAt: '2026-01-01T00:00:00.000Z',
    nodeOrder: ['n1'],
    nodes: {
      n1: {
        id: 'n1',
        type: 'implement',
        title: '甲',
        description: '',
        dependsOn: [],
        files: [],
        agentId: 'dsh',
        attempts: 1,
        maxAttempts: 3,
      },
    },
  };
}

function output(at: string, chunk: string): OrchestratorEvent {
  return {
    type: 'agent.output',
    at,
    runId: RUN,
    nodeId: 'n1',
    agentId: 'dsh',
    chunk,
    kind: 'text',
  };
}

describe('重置之后清空该节点的时间线', () => {
  it('早于最后一次重置的事件不再进入视图', () => {
    const events: OrchestratorEvent[] = [
      output('2026-01-01T00:01:00.000Z', '上一轮的输出'),
      { type: 'node.reset', at: '2026-01-01T00:10:00.000Z', runId: RUN, nodeId: 'n1', reason: '用户手动重置' },
      output('2026-01-01T00:11:00.000Z', '这一轮的输出'),
    ];

    const views = deriveEvents(run(), events);
    const messages = views.map((view) => view.message);

    expect(messages).not.toContain('上一轮的输出');
    expect(messages).toContain('这一轮的输出');
  });

  it('重置事件本身保留，它是「从这里重新开始」的标记', () => {
    const events: OrchestratorEvent[] = [
      output('2026-01-01T00:01:00.000Z', '旧'),
      { type: 'node.reset', at: '2026-01-01T00:10:00.000Z', runId: RUN, nodeId: 'n1', reason: '用户手动重置' },
    ];
    const views = deriveEvents(run(), events);
    expect(views).toHaveLength(1);
    // 重置记录留在该节点的事件里：看到「这一轮被作废」比彻底没有痕迹更有用
    expect(views[0]?.message).toContain('重置');
  });

  it('多次重置只看最后一次', () => {
    const events: OrchestratorEvent[] = [
      output('2026-01-01T00:01:00.000Z', '第一轮'),
      { type: 'node.reset', at: '2026-01-01T00:05:00.000Z', runId: RUN, nodeId: 'n1', reason: '第一次' },
      output('2026-01-01T00:06:00.000Z', '第二轮'),
      { type: 'node.reset', at: '2026-01-01T00:10:00.000Z', runId: RUN, nodeId: 'n1', reason: '第二次' },
      output('2026-01-01T00:11:00.000Z', '第三轮'),
    ];
    const messages = deriveEvents(run(), events).map((view) => view.message);
    expect(messages).not.toContain('第一轮');
    expect(messages).not.toContain('第二轮');
    expect(messages).toContain('第三轮');
  });

  it('别的节点不受这个边界影响', () => {
    const facts = run();
    facts.nodeOrder = ['n1', 'n2'];
    facts.nodes['n2'] = { ...facts.nodes['n1']!, id: 'n2', title: '乙' };

    const events: OrchestratorEvent[] = [
      {
        type: 'agent.output',
        at: '2026-01-01T00:01:00.000Z',
        runId: RUN,
        nodeId: 'n2',
        agentId: 'dsh',
        chunk: '乙的输出',
        kind: 'text',
      },
      { type: 'node.reset', at: '2026-01-01T00:10:00.000Z', runId: RUN, nodeId: 'n1', reason: '重置甲' },
    ];

    const messages = deriveEvents(facts, events).map((view) => view.message);
    expect(messages).toContain('乙的输出');
  });
});

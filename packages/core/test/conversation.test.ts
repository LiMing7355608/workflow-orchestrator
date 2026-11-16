import { describe, expect, it } from 'vitest';
import {
  deriveConversation,
  deriveEvents,
  emptyState,
  reduce,
  type NodeFacts,
  type OrchestratorEvent,
  type RunFacts,
} from '../src/index';

/**
 * 编排器会话的组装。
 *
 * 这里要钉住的不是「消息能不能显示」，而是三件容易悄悄坏掉的事：
 *   1. 首条必须来自 `run.goal`，不是事件——它一旦被存成事件，就会出现两份
 *      可能互相矛盾的目标；
 *   2. 系统行（拆解开始/失败、图生成、改图结果）必须按时刻插进对话的正确位置，
 *      因为「我要求改 → 它卡住了」这条因果只在这个顺序里成立；
 *   3. 打断标记只透传 true，不写 `false`。
 */

const AT = '2026-11-16T00:00:00.000Z';
const T1 = '2026-11-16T00:00:10.000Z';
const T2 = '2026-11-16T00:00:20.000Z';
const T3 = '2026-11-16T00:00:30.000Z';
const T4 = '2026-11-16T00:00:40.000Z';

function node(partial: Partial<NodeFacts> & Pick<NodeFacts, 'id' | 'type'>): NodeFacts {
  return {
    title: partial.id,
    description: '',
    dependsOn: [],
    files: [],
    attempts: 0,
    maxAttempts: 3,
    ...partial,
  };
}

function buildRun(overrides: Partial<RunFacts> = {}): RunFacts {
  const nodes = overrides.nodes ?? {};
  return {
    id: 'run-1',
    title: '月报工具',
    summary: '做一个月报工具',
    goal: '做一个月报工具，先出核心报表',
    workspaceRoot: '/tmp/target-repo',
    specVersion: 'v1.0',
    stage: 'orchestrate',
    createdAt: AT,
    nodeOrder: Object.keys(nodes),
    nodes,
    ...overrides,
  };
}

function event(
  partial: Partial<OrchestratorEvent> & Pick<OrchestratorEvent, 'type'>,
): OrchestratorEvent {
  return { at: AT, runId: 'run-1', ...partial } as OrchestratorEvent;
}

describe('deriveConversation：首条是目标，不占事件', () => {
  it('没有事件时只有目标这一条，时刻取 createdAt', () => {
    const run = buildRun();
    const entries = deriveConversation(run, []);

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      id: 'conv-goal',
      at: AT,
      role: 'user',
      text: '做一个月报工具，先出核心报表',
    });
  });

  it('目标为空时不留一条空消息', () => {
    expect(deriveConversation(buildRun({ goal: '   ' }), [])).toEqual([]);
  });

  it('目标不会被同名事件重复一次', () => {
    const run = buildRun();
    // 即使调用方真的发了一条与目标一样的用户消息，它们也是两条独立的事实：
    // 一条是「创建时的目标」，一条是「后来又说了一遍」
    const entries = deriveConversation(run, [
      event({ type: 'orchestrator.message', at: T1, role: 'user', text: run.goal }),
    ]);

    expect(entries).toHaveLength(2);
    expect(entries[1]?.at).toBe(T1);
  });
});

describe('deriveConversation：系统行插在正确位置', () => {
  it('拆解开始与失败之间夹着用户的插话，顺序按时刻', () => {
    const run = buildRun();
    const entries = deriveConversation(run, [
      event({ type: 'plan.started', at: T1, agentId: 'claude' }),
      event({
        type: 'orchestrator.message',
        at: T2,
        role: 'user',
        text: '先做导出',
        interrupt: true,
      }),
      event({ type: 'plan.failed', at: T3, message: '图里有环' }),
    ]);

    expect(entries.map((entry) => entry.role)).toEqual([
      'user',
      'system',
      'user',
      'system',
    ]);
    expect(entries[1]?.text).toBe('开始拆解任务图（claude）');
    expect(entries[1]?.tone).toBe('info');
    expect(entries[3]?.text).toBe('拆解失败：图里有环');
    expect(entries[3]?.tone).toBe('warning');
  });

  it('冻结行的节点数取这次冻结带进来的，而不是当前 nodeOrder', () => {
    // 图上后来多了一个节点：用当前 nodeOrder 会把「这次生成了几个」说成
    // 「现在有几个」
    const frozen = [
      node({ id: 'impl-a', type: 'implement' }),
      node({ id: 'review-a', type: 'review', dependsOn: ['impl-a'] }),
    ];
    const added = node({ id: 'impl-b', type: 'implement' });
    const run = buildRun({
      frozenAt: T1,
      stage: 'execute',
      nodes: { 'impl-a': frozen[0]!, 'review-a': frozen[1]!, 'impl-b': added },
      nodeOrder: ['impl-a', 'review-a', 'impl-b'],
    });

    const entries = deriveConversation(run, [
      event({ type: 'run.frozen', at: T1, nodes: frozen }),
    ]);
    const frozenEntry = entries.find((entry) => entry.tone === 'success');

    expect(frozenEntry?.text).toBe('任务图已生成：2 个节点');
  });

  it('改图行带出实际改动，空改动不说成「改了什么」', () => {
    const run = buildRun();
    const entries = deriveConversation(run, [
      event({
        type: 'dag.amended',
        at: T1,
        actor: 'YG',
        reason: '审查换成 codex',
        changes: [
          {
            kind: 'update-node',
            nodeId: 'review-a',
            fields: [{ field: 'agentId', from: 'claude', to: 'codex' }],
          },
          { kind: 'remove-node', nodeId: 'impl-b' },
        ],
      }),
      event({ type: 'dag.amended', at: T2, actor: 'YG', reason: '随便说一句', changes: [] }),
    ]);

    expect(entries[1]?.text).toBe(
      '改图：更新 review-a（agentId：claude → codex）；移除 impl-b',
    );
    expect(entries[2]?.text).toBe('改图：没有需要修改的地方');
  });
});

describe('deriveConversation：人机交替与打断标记', () => {
  it('同一毫秒内的消息保持落盘顺序', () => {
    // 一次改图与它的回复常常落在同一毫秒里。若顺序被重排，读起来就成了
    // 「它先回答、我才说话」
    const run = buildRun();
    const entries = deriveConversation(run, [
      event({ type: 'orchestrator.message', at: T1, role: 'user', text: '换成 codex' }),
      event({ type: 'orchestrator.message', at: T1, role: 'orchestrator', text: '已修改' }),
      event({ type: 'orchestrator.message', at: T2, role: 'user', text: '再收一点' }),
    ]);

    expect(entries.map((entry) => entry.text)).toEqual([
      run.goal,
      '换成 codex',
      '已修改',
      '再收一点',
    ]);
  });

  it('打断标记只透传 true，不为 false 造一个假事实', () => {
    const run = buildRun();
    const entries = deriveConversation(run, [
      event({
        type: 'orchestrator.message',
        at: T1,
        role: 'user',
        text: '先别拆了，改成先做登录',
        interrupt: true,
      }),
      event({ type: 'orchestrator.message', at: T2, role: 'user', text: '继续' }),
    ]);

    expect(entries[1]?.interrupt).toBe(true);
    expect(entries[2]?.interrupt).toBeUndefined();
    expect('interrupt' in (entries[2] ?? {})).toBe(false);
  });

  it('别的运行的事件不会串进来', () => {
    const run = buildRun();
    const entries = deriveConversation(run, [
      { type: 'orchestrator.message', at: T1, runId: 'run-2', role: 'user', text: '别人的话' },
    ]);

    expect(entries).toHaveLength(1);
  });
});

describe('orchestrator.message 与事实层的关系', () => {
  it('不进事件流：它有自己的视图', () => {
    const run = buildRun();
    const events = [
      event({ type: 'orchestrator.message', at: T1, role: 'user', text: '换成 codex' }),
    ];

    // 塞进事件流会让同一句话在界面上出现两次，而流水里没有「谁在跟谁说话」
    expect(deriveEvents(run, events)).toEqual([]);
  });

  it('归约不动任何事实：重放它得到的运行与丢掉它一样', () => {
    const run = buildRun();
    const state = {
      ...emptyState(),
      runs: { 'run-1': run },
    };

    expect(
      reduce(
        state,
        event({ type: 'orchestrator.message', at: T4, role: 'user', text: '再说一句' }),
      ),
    ).toBe(state);
  });
});

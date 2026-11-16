import { describe, expect, it } from 'vitest';
import {
  DEFAULT_AGENT_PROFILES,
  deriveNodeConversation,
  deriveRunDetail,
  reduce,
  runNode,
  type AdvanceDeps,
  type NodeFacts,
  type OrchestratorEvent,
  type ProjectState,
  type RunFacts,
} from '../src/index';

/**
 * 节点会话的组装，以及「这条要求真的进了提示词」。
 *
 * 这里要钉住的不是「消息能不能显示」，而是三件容易悄悄坏掉的事：
 *   1. 节点会话是「执行轮次 + 每轮输出 + 中途插话」交织的一条流：输出必须
 *      挂在它所属的那一轮下面，而不是散成几十条孤立的流水行；
 *   2. 打断标记只透传 true，且它不改变「当前是第几轮」这个归属；
 *   3. 人说过的话必须真的出现在提示词末尾——消息落了库却没进 prompt，
 *      等于什么都没发生，而这件事从界面上完全看不出来。
 */

const AT = '2026-11-16T00:00:00.000Z';
const T1 = '2026-11-16T00:00:10.000Z';
const T2 = '2026-11-16T00:00:20.000Z';
const T3 = '2026-11-16T00:00:30.000Z';
const T4 = '2026-11-16T00:00:40.000Z';
const T5 = '2026-11-16T00:00:50.000Z';
const T6 = '2026-11-16T00:01:00.000Z';
const T7 = '2026-11-16T00:01:10.000Z';
const T8 = '2026-11-16T00:01:20.000Z';

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

function buildRun(nodes: NodeFacts[], runId = 'run-node-conv'): RunFacts {
  return {
    id: runId,
    title: '节点会话测试',
    summary: '',
    goal: '验证节点会话与提示词注入',
    workspaceRoot: '/tmp/target-repo',
    specVersion: 'v1.0',
    stage: 'execute',
    createdAt: AT,
    frozenAt: AT,
    nodeOrder: nodes.map((item) => item.id),
    nodes: Object.fromEntries(nodes.map((item) => [item.id, item])),
  };
}

function event(
  partial: Partial<OrchestratorEvent> & Pick<OrchestratorEvent, 'type'>,
): OrchestratorEvent {
  return { at: AT, runId: 'run-node-conv', ...partial } as OrchestratorEvent;
}

describe('deriveNodeConversation：轮次、输出与插话交织成一条流', () => {
  it('按时刻组装，agent 输出挂到它所属的那一轮下面', () => {
    const run = buildRun([node({ id: 'impl-a', type: 'implement', agentId: 'claude' })]);
    const entries = deriveNodeConversation(run, [
      event({ type: 'node.started', at: T1, nodeId: 'impl-a' }),
      event({ type: 'agent.output', at: T2, nodeId: 'impl-a', agentId: 'claude', chunk: '先看接口' }),
      event({ type: 'node.completed', at: T3, nodeId: 'impl-a' }),
    ], 'impl-a');

    expect(entries.map((entry) => entry.role)).toEqual(['system', 'system']);
    expect(entries[0]?.text).toBe('开始执行（claude）');
    expect(entries[0]?.tone).toBe('info');
    // 输出不单独成条：它挂在这一轮下面，否则一次执行几十条输出会把
    // 「我中途改过要求」这件事彻底埋掉
    expect(entries[0]?.outputs).toHaveLength(1);
    expect(entries[0]?.outputs?.[0]?.text).toBe('先看接口');
    expect(entries[1]?.text).toBe('完成');
    expect(entries[1]?.tone).toBe('success');
  });

  it('插话夹在两轮之间，且不改变当前轮次的归属', () => {
    const run = buildRun([node({ id: 'impl-a', type: 'implement', agentId: 'claude' })]);
    const entries = deriveNodeConversation(run, [
      event({ type: 'node.started', at: T1, nodeId: 'impl-a' }),
      event({
        type: 'node.message',
        at: T2,
        nodeId: 'impl-a',
        role: 'user',
        text: '别用 vue，改成 react',
        interrupt: true,
      }),
      event({ type: 'node.interrupted', at: T3, nodeId: 'impl-a', reason: '用户打断并给出了新要求' }),
      event({ type: 'node.message', at: T4, nodeId: 'impl-a', role: 'agent', text: '已按新要求重启' }),
      event({ type: 'node.started', at: T5, nodeId: 'impl-a' }),
      event({ type: 'agent.output', at: T6, nodeId: 'impl-a', agentId: 'claude', chunk: '改用 react 重写' }),
      event({ type: 'node.completed', at: T7, nodeId: 'impl-a' }),
    ], 'impl-a');

    expect(entries.map((entry) => entry.role)).toEqual([
      'system',
      'user',
      'system',
      'agent',
      'system',
      'system',
    ]);
    // 打断消息带标记，且标记只透传 true
    expect(entries[1]?.interrupt).toBe(true);
    expect(entries[1]?.text).toBe('别用 vue，改成 react');
    expect(entries[2]?.text).toBe('被停止：用户打断并给出了新要求');
    expect(entries[2]?.tone).toBe('warning');
    // 第二轮的开始行才是那条输出的归属
    expect(entries[4]?.outputs).toHaveLength(1);
    expect(entries[4]?.outputs?.[0]?.text).toBe('改用 react 重写');
    expect(entries[5]?.text).toBe('完成');
  });

  it('打断之后才姗姗来迟的收尾输出不会被算进下一轮', () => {
    const run = buildRun([node({ id: 'impl-a', type: 'implement', agentId: 'claude' })]);
    const entries = deriveNodeConversation(run, [
      event({ type: 'node.started', at: T1, nodeId: 'impl-a' }),
      event({ type: 'node.interrupted', at: T2, nodeId: 'impl-a', reason: '用户停止了该节点' }),
      // 进程退出前 relay 才把缓冲刷出来：它属于被打断的那一轮
      event({ type: 'agent.output', at: T3, nodeId: 'impl-a', agentId: 'claude', chunk: '（回放已取消）' }),
      event({ type: 'node.started', at: T4, nodeId: 'impl-a' }),
    ], 'impl-a');

    expect(entries[0]?.outputs).toEqual([]);
    expect(entries.at(-1)?.outputs).toEqual([]);
  });

  it('失败与重置各自成行，原因原样带出', () => {
    const run = buildRun([node({ id: 'impl-a', type: 'implement', agentId: 'claude' })]);
    const entries = deriveNodeConversation(run, [
      event({ type: 'node.failed', at: T1, nodeId: 'impl-a', reason: '退出码 1' }),
      event({ type: 'node.reset', at: T2, nodeId: 'impl-a', reason: '用户手动重置' }),
    ], 'impl-a');

    expect(entries[0]?.text).toBe('失败：退出码 1');
    expect(entries[0]?.tone).toBe('warning');
    expect(entries[1]?.text).toBe('已重置：用户手动重置');
    expect(entries[1]?.tone).toBe('info');
  });

  it('空输出不占一行', () => {
    const run = buildRun([node({ id: 'impl-a', type: 'implement', agentId: 'claude' })]);
    const entries = deriveNodeConversation(run, [
      event({ type: 'node.started', at: T1, nodeId: 'impl-a' }),
      event({ type: 'agent.output', at: T2, nodeId: 'impl-a', agentId: 'claude', chunk: '   ' }),
    ], 'impl-a');

    expect(entries[0]?.outputs).toEqual([]);
  });

  it('别的节点、别的运行的事件都不会串进来', () => {
    const run = buildRun([
      node({ id: 'impl-a', type: 'implement', agentId: 'claude' }),
      node({ id: 'impl-b', type: 'implement', agentId: 'claude' }),
    ]);
    const entries = deriveNodeConversation(run, [
      event({ type: 'node.message', at: T1, nodeId: 'impl-b', role: 'user', text: '这是给 B 的' }),
      { type: 'node.message', at: T2, runId: 'run-other', nodeId: 'impl-a', role: 'user', text: '别的运行' },
      event({ type: 'node.started', at: T3, nodeId: 'impl-a' }),
    ], 'impl-a');

    expect(entries.map((entry) => entry.text)).toEqual(['开始执行（claude）']);
  });

  it('运行级事件不属于任何一个节点', () => {
    const run = buildRun([node({ id: 'impl-a', type: 'implement', agentId: 'claude' })]);
    const entries = deriveNodeConversation(run, [
      event({ type: 'run.paused', at: T1 }),
      event({ type: 'run.resumed', at: T2 }),
    ], 'impl-a');

    expect(entries).toEqual([]);
  });
});

describe('deriveRunDetail：节点会话只放有内容的节点', () => {
  it('没会话的节点不占一个键', () => {
    const run = buildRun([
      node({ id: 'impl-a', type: 'implement', agentId: 'claude' }),
      node({ id: 'impl-b', type: 'implement', agentId: 'claude' }),
    ]);
    const detail = deriveRunDetail(run, [
      event({ type: 'node.message', at: T1, nodeId: 'impl-a', role: 'user', text: '别动 src/db/**' }),
      event({
        type: 'node.message',
        at: T2,
        nodeId: 'impl-a',
        role: 'agent',
        text: '已记录。这条要求会在下次运行该节点时带上它。',
      }),
    ], () => undefined);

    expect(Object.keys(detail.nodeConversations)).toEqual(['impl-a']);
    expect(detail.nodeConversations['impl-a']).toHaveLength(2);
    expect(detail.nodeConversations['impl-b']).toBeUndefined();
  });

  it('node.message 不进事件流：同一句话不该出现两次', () => {
    const run = buildRun([node({ id: 'impl-a', type: 'implement', agentId: 'claude' })]);
    const detail = deriveRunDetail(run, [
      event({ type: 'node.message', at: T1, nodeId: 'impl-a', role: 'user', text: '别用 vue' }),
    ], () => undefined);

    expect(detail.events).toEqual([]);
    expect(detail.nodeConversations['impl-a']).toHaveLength(1);
  });
});

describe('node.message 与事实层的关系', () => {
  it('归约不动任何事实：重放它与丢掉它得到的节点一样', () => {
    const run = buildRun([node({ id: 'impl-a', type: 'implement', agentId: 'claude' })]);
    const state: ProjectState = { ...{ runs: { [run.id]: run }, approvals: [] } };

    expect(
      reduce(
        state,
        event({
          type: 'node.message',
          at: T1,
          nodeId: 'impl-a',
          role: 'user',
          text: '别动 src/db/**',
          interrupt: true,
        }),
      ),
    ).toBe(state);
  });
});

/* ------------------------------------------------------------------ *
 * 提示词注入
 * ------------------------------------------------------------------ */

interface Harness {
  deps: AdvanceDeps;
  events: OrchestratorEvent[];
  /** 每次执行真正拿到的提示词（stdin 与 argv 拼起来，不同 CLI 放法不同） */
  prompts: string[];
  state: () => ProjectState;
}

function harness(run: RunFacts, history: OrchestratorEvent[] = []): Harness {
  let state: ProjectState = { runs: { [run.id]: run }, approvals: [] };
  const events: OrchestratorEvent[] = [];
  const prompts: string[] = [];

  const deps: AdvanceDeps = {
    getRun: (id) => state.runs[id],
    emit: async (item) => {
      events.push(item);
      state = reduce(state, item);
    },
    runner: {
      run: async (request, onChunk) => {
        prompts.push(`${request.stdin ?? ''}\n${request.argv.join(' ')}`);
        onChunk('done');
        return { ok: true, exitCode: 0, output: 'done' };
      },
    },
    workspaceFor: () => ({
      prepare: async (runId, nodeId) => `/tmp/${runId}/${nodeId}`,
      release: async () => {},
    }),
    resolveAgent: (id) => DEFAULT_AGENT_PROFILES.find((agent) => agent.id === id),
    now: () => AT,
    nodeInFlight: new Set<string>(),
    eventsForRun: () => history,
  };

  return { deps, events, prompts, state: () => state };
}

function implementationNode(): NodeFacts {
  return node({
    id: 'impl-a',
    type: 'implement',
    agentId: 'claude',
    title: '实现登录',
    files: ['src/auth/**'],
  });
}

describe('buildPrompt：人类补充要求进提示词', () => {
  it('有插话时在末尾带上那一段，按时间顺序逐条列出', async () => {
    const run = buildRun([implementationNode()]);
    const history = [
      event({ type: 'node.message', at: T1, nodeId: 'impl-a', role: 'user', text: '别用 vue，改成 react' }),
      event({ type: 'node.message', at: T2, nodeId: 'impl-a', role: 'agent', text: '已记录，下次运行生效' }),
      event({ type: 'node.message', at: T3, nodeId: 'impl-a', role: 'user', text: '这个文件别动：src/db/**' }),
    ];
    const h = harness(run, history);

    await runNode(run.id, 'impl-a', h.deps);

    const prompt = h.prompts[0] ?? '';
    expect(prompt).toContain('## 人类在开发过程中的补充要求');
    expect(prompt).toContain('1. 别用 vue，改成 react');
    expect(prompt).toContain('2. 这个文件别动：src/db/**');
    // 回执是我们自己写的通知，喂回给 Agent 等于让它把自己的话当新要求
    expect(prompt).not.toContain('已记录，下次运行生效');
    // 必须落在末尾：提示词末尾才是「覆盖前面所有内容」的那个位置。
    // 判据是「这一段之后不再有任何别的段落标题」——不能直接看字符串结尾，
    // 因为不同 CLI 会把提示词放进 argv 的不同位置，后面还可能跟着别的参数。
    const notesIndex = prompt.indexOf('## 人类在开发过程中的补充要求');
    expect(notesIndex).toBeGreaterThan(prompt.indexOf('## 交付要求'));
    expect(prompt.slice(notesIndex).indexOf('## ', 3)).toBe(-1);
  });

  it('没有插话时整段不出现，连标题都没有', async () => {
    const run = buildRun([implementationNode()]);
    const h = harness(run, [
      // 只有别的节点的消息：不能拿来当这个节点的要求
      event({ type: 'node.message', at: T1, nodeId: 'impl-b', role: 'user', text: '别用 vue' }),
    ]);

    await runNode(run.id, 'impl-a', h.deps);

    expect(h.prompts[0] ?? '').not.toContain('人类在开发过程中的补充要求');
  });

  it('最多带最近 5 条：更早的要求不占提示词', async () => {
    const run = buildRun([implementationNode()]);
    const history = [
      event({ type: 'node.message', at: T1, nodeId: 'impl-a', role: 'user', text: '要求 1' }),
      event({ type: 'node.message', at: T2, nodeId: 'impl-a', role: 'user', text: '要求 2' }),
      event({ type: 'node.message', at: T3, nodeId: 'impl-a', role: 'user', text: '要求 3' }),
      event({ type: 'node.message', at: T4, nodeId: 'impl-a', role: 'user', text: '要求 4' }),
      event({ type: 'node.message', at: T5, nodeId: 'impl-a', role: 'user', text: '要求 5' }),
      event({ type: 'node.message', at: T6, nodeId: 'impl-a', role: 'user', text: '要求 6' }),
    ];
    const h = harness(run, history);

    await runNode(run.id, 'impl-a', h.deps);

    const prompt = h.prompts[0] ?? '';
    // 取最近的 5 条（2..6），并且保持原来的先后顺序
    expect(prompt).not.toContain('1. 要求 1');
    expect(prompt).toContain('1. 要求 2');
    expect(prompt).toContain('5. 要求 6');
    expect(prompt.indexOf('1. 要求 2')).toBeLessThan(prompt.indexOf('5. 要求 6'));
  });

  it('宿主不提供事件历史时提示词照旧可用', async () => {
    const run = buildRun([implementationNode()]);
    const h = harness(run);
    // 模拟「没有注入 eventsForRun」的宿主
    delete h.deps.eventsForRun;

    await runNode(run.id, 'impl-a', h.deps);

    expect(h.prompts[0] ?? '').toContain('## 交付要求');
    expect(h.prompts[0] ?? '').not.toContain('人类在开发过程中的补充要求');
  });
});

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_AGENT_PROFILES,
  nodeInFlightKey,
  reduce,
  runNode,
  type AdvanceDeps,
  type NodeFacts,
  type OrchestratorEvent,
  type ProjectState,
  type RunFacts,
} from '../src/index';

/**
 * 单节点运行。
 *
 * 这里要钉住三件事：拒绝的判据是「正在跑」而不是「跑过」；单跑不检查依赖；
 * 以及互斥标记真的能挡住第二个并发派发。用假 runner + 假工作区驱动，
 * 绝不启动真实进程。
 */

const AT = '2026-11-16T00:00:00.000Z';

function node(
  partial: Partial<NodeFacts> & Pick<NodeFacts, 'id' | 'type'>,
): NodeFacts {
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

function buildRun(nodes: NodeFacts[], runId = 'run-single'): RunFacts {
  return {
    id: runId,
    title: '单节点运行测试',
    summary: '',
    goal: '验证单跑语义',
    workspaceRoot: '/tmp/target-repo',
    specVersion: 'v1.0',
    stage: 'execute',
    createdAt: AT,
    frozenAt: AT,
    nodeOrder: nodes.map((item) => item.id),
    nodes: Object.fromEntries(nodes.map((item) => [item.id, item])),
  };
}

interface Harness {
  deps: AdvanceDeps;
  events: OrchestratorEvent[];
  state: () => ProjectState;
}

function harness(
  run: RunFacts,
  options: {
    /** 让 runner 停在半路，用来构造「正在跑」的窗口 */
    gate?: Promise<void>;
    output?: string;
  } = {},
): Harness {
  let state: ProjectState = { runs: { [run.id]: run }, approvals: [] };
  const events: OrchestratorEvent[] = [];

  const deps: AdvanceDeps = {
    getRun: (id) => state.runs[id],
    emit: async (event) => {
      events.push(event);
      state = reduce(state, event);
    },
    runner: {
      run: async (_request, onChunk) => {
        if (options.gate) {
          await options.gate;
        }
        const text = options.output ?? 'done';
        onChunk(text);
        return { ok: true, exitCode: 0, output: text };
      },
    },
    workspaceFor: () => ({
      prepare: async (runId, nodeId) => `/tmp/${runId}/${nodeId}`,
      release: async () => {},
    }),
    resolveAgent: (id) => DEFAULT_AGENT_PROFILES.find((agent) => agent.id === id),
    now: () => AT,
    // 互斥表由宿主持有；这里就是那一份
    nodeInFlight: new Set<string>(),
  };

  return { deps, events, state: () => state };
}

describe('runNode 单节点运行', () => {
  it('已开始的节点会被拒绝，且不落任何事件', async () => {
    // startedAt 有值、finishedAt 没有 = 这一轮还没结算完
    const run = buildRun([
      node({ id: 'impl-a', type: 'implement', agentId: 'claude', startedAt: AT }),
    ]);
    const h = harness(run);

    const result = await runNode('run-single', 'impl-a', h.deps);

    expect(result.ok).toBe(false);
    expect(result.reason).toContain('正在执行');
    // 拒绝就必须是「什么都没发生」：不能悄悄开始一个进程再报失败
    expect(h.events).toHaveLength(0);
  });

  it('未开始的节点能跑完，并落下 started / completed', async () => {
    const run = buildRun([
      node({ id: 'impl-a', type: 'implement', agentId: 'claude' }),
    ]);
    const h = harness(run);

    const result = await runNode('run-single', 'impl-a', h.deps);

    expect(result.ok).toBe(true);
    // 只看节点生命周期：agent.output 也会顺带入流，那是执行层的话，不是结局
    expect(
      h.events
        .filter((event) => event.type !== 'agent.output')
        .map((event) => event.type),
    ).toEqual(['node.started', 'node.completed']);
    expect(h.state().runs['run-single']?.nodes['impl-a']?.finishedAt).toBe(AT);
  });

  it('不检查依赖：上游还没完成也照样跑', async () => {
    // impl-b 依赖 impl-a，而 impl-a 一次都没跑过（pending）
    const run = buildRun([
      node({ id: 'impl-a', type: 'implement', agentId: 'claude' }),
      node({ id: 'impl-b', type: 'implement', agentId: 'claude', dependsOn: ['impl-a'] }),
    ]);
    const h = harness(run);

    const result = await runNode('run-single', 'impl-b', h.deps);

    expect(result.ok).toBe(true);
    // 只有 impl-b 被派发；依赖检查是调度器的事，单跑是用户的覆盖指令
    const started = h.events.filter(
      (event) => event.type === 'node.started' && event.nodeId === 'impl-b',
    );
    expect(started).toHaveLength(1);
    expect(h.state().runs['run-single']?.nodes['impl-b']?.finishedAt).toBe(AT);
    expect(h.state().runs['run-single']?.nodes['impl-a']?.startedAt).toBeUndefined();
  });

  it('失败过的节点允许重跑（判据是没在跑，不是没跑过）', async () => {
    // node.failed 会同时写 startedAt 与 finishedAt，这类节点必须还能被单跑
    const run = buildRun([
      node({
        id: 'impl-a',
        type: 'implement',
        agentId: 'claude',
        startedAt: AT,
        finishedAt: AT,
        failureReason: '退出码 1',
      }),
    ]);
    const h = harness(run);

    const result = await runNode('run-single', 'impl-a', h.deps);

    expect(result.ok).toBe(true);
    // node.started 会清掉失败原因：这一轮已经重新开始，旧结论不再成立
    expect(h.state().runs['run-single']?.nodes['impl-a']?.failureReason).toBeUndefined();
    expect(h.state().runs['run-single']?.nodes['impl-a']?.finishedAt).toBe(AT);
  });

  it('互斥标记已被占用时拒绝，不派发也不发事件', async () => {
    const run = buildRun([
      node({ id: 'impl-a', type: 'implement', agentId: 'claude' }),
    ]);
    const h = harness(run);
    h.deps.nodeInFlight?.add(nodeInFlightKey('run-single', 'impl-a'));

    const result = await runNode('run-single', 'impl-a', h.deps);

    expect(result.ok).toBe(false);
    expect(h.events).toHaveLength(0);
  });

  it('同一个节点并发两次，只有一次真的跑起来，结束后标记被撤销', async () => {
    const run = buildRun([
      node({ id: 'impl-a', type: 'implement', agentId: 'claude' }),
    ]);

    let release: () => void = () => {};
    const h = harness(run, {
      gate: new Promise<void>((resolve) => {
        release = resolve;
      }),
    });

    const first = runNode('run-single', 'impl-a', h.deps);
    // 第一拍就已经登记，第二拍紧接着发：不必等它跑完
    const second = await runNode('run-single', 'impl-a', h.deps);

    expect(second.ok).toBe(false);
    expect(second.reason).toContain('正在执行');

    release();
    await expect(first).resolves.toEqual({ ok: true });

    // 跑完之后标记必须被撤销，否则这个节点从此既跑不了也重置不了
    expect(h.deps.nodeInFlight?.has(nodeInFlightKey('run-single', 'impl-a'))).toBe(
      false,
    );

    // 撤销之后再跑一次是允许的
    const third = await runNode('run-single', 'impl-a', h.deps);
    expect(third.ok).toBe(true);
  });

  it('运行或节点不存在时给出理由，而不是抛异常', async () => {
    const run = buildRun([node({ id: 'impl-a', type: 'implement', agentId: 'claude' })]);
    const h = harness(run);

    const missingNode = await runNode('run-single', 'impl-ghost', h.deps);
    expect(missingNode.ok).toBe(false);
    expect(missingNode.reason).toContain('节点不存在');

    const missingRun = await runNode('run-ghost', 'impl-a', h.deps);
    expect(missingRun.ok).toBe(false);
    expect(missingRun.reason).toContain('运行不存在');
  });
});

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_AGENT_PROFILES,
  advanceRun,
  reduce,
  type AdvanceDeps,
  type NodeFacts,
  type OrchestratorEvent,
  type ProjectState,
  type RunFacts,
} from '../src/index';

/**
 * 中止语义。
 *
 * 停止在编排层只有一条规则：**不再派发新批次**。已经在跑的节点不被强行
 * 打断，也不被这里判成失败——它们的结局由 runner 的 `cancelled` 决定。
 * 所以这里全部用假 runner：进程级终止由 packages/server 的实现负责，
 * 本文件只验证「编排器肯不肯放手」。
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

function buildRun(nodes: NodeFacts[], runId = 'run-stop'): RunFacts {
  return {
    id: runId,
    title: '中止测试',
    summary: '',
    goal: '验证停止语义',
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
  calls: string[];
  state: () => ProjectState;
}

function harness(
  run: RunFacts,
  options: {
    /** 每次真正执行节点时调用，可在这里触发 abort */
    onRun?: (nodeId: string) => void;
    /** 返回的结局；默认成功 */
    output?: string;
    concurrency?: number;
  } = {},
): Harness {
  let state: ProjectState = { runs: { [run.id]: run }, approvals: [] };
  const events: OrchestratorEvent[] = [];
  const calls: string[] = [];

  const deps: AdvanceDeps = {
    getRun: (id) => state.runs[id],
    emit: async (event) => {
      events.push(event);
      state = reduce(state, event);
    },
    runner: {
      run: async (request, onChunk) => {
        calls.push(request.nodeId);
        options.onRun?.(request.nodeId);
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
    concurrency: options.concurrency ?? 4,
  };

  return { deps, events, calls, state: () => state };
}

describe('advanceRun 的中止语义', () => {
  it('信号已中止时不派发任何节点，直接以 cancelled 停止', async () => {
    const run = buildRun([
      node({ id: 'impl-a', type: 'implement', agentId: 'claude' }),
      node({ id: 'impl-b', type: 'implement', agentId: 'claude' }),
    ]);
    const h = harness(run);

    const controller = new AbortController();
    controller.abort();
    h.deps.signal = controller.signal;

    const result = await advanceRun('run-stop', h.deps);

    expect(result.stopped).toBe('cancelled');
    expect(result.executed).toEqual([]);
    // 一个节点都没起来，也就不能有任何事件：伪造 node.failed 等于凭空造事实
    expect(h.calls).toEqual([]);
    expect(h.events).toEqual([]);
  });

  it('执行中途中止后不再派发下一批，已在跑的节点照常收尾', async () => {
    const run = buildRun([
      node({ id: 'impl-a', type: 'implement', agentId: 'claude', files: ['src/a/**'] }),
      node({ id: 'impl-b', type: 'implement', agentId: 'claude', files: ['src/b/**'] }),
    ]);

    const controller = new AbortController();
    // 并发 1：第一轮只派发 impl-a，于是「第二批」就有明确的观察对象
    const h = harness(run, {
      concurrency: 1,
      onRun: () => controller.abort(),
    });
    h.deps.signal = controller.signal;

    const result = await advanceRun('run-stop', h.deps);

    expect(result.stopped).toBe('cancelled');
    expect(result.executed).toEqual(['impl-a']);
    // impl-b 从未被派发
    expect(h.calls).toEqual(['impl-a']);
    expect(
      h.events.some(
        (event) => event.type === 'node.started' && event.nodeId === 'impl-b',
      ),
    ).toBe(false);
    // 已经在跑的那个节点仍走到了它自己的结局：中止不越过执行层改判结果
    expect(h.state().runs['run-stop']?.nodes['impl-a']?.finishedAt).toBe(AT);
  });

  it('中止之后不再补审批记录等新的副作用', async () => {
    const run = buildRun([
      node({ id: 'impl-a', type: 'implement', agentId: 'claude' }),
      node({ id: 'ap-a', type: 'approval', dependsOn: ['impl-a'], executor: '老板' }),
    ]);

    const controller = new AbortController();
    const h = harness(run, {
      concurrency: 1,
      onRun: () => controller.abort(),
    });
    h.deps.signal = controller.signal;

    await advanceRun('run-stop', h.deps);

    // 实现节点完成后本应轮到审批节点，但此时已经中止
    expect(h.events.some((event) => event.type === 'approval.requested')).toBe(false);
  });

  it('执行层返回 cancelled 时落「被停止」而不是失败，节点因此还能被重新调度', async () => {
    const run = buildRun([
      node({ id: 'impl-a', type: 'implement', agentId: 'claude' }),
    ]);

    const h = harness(run);
    // 换成「进程被终止」的执行层：ok=false + cancelled=true
    h.deps.runner = {
      run: async () => ({
        ok: false,
        exitCode: null,
        output: '',
        cancelled: true,
        error: 'cancelled',
      }),
    };

    const result = await advanceRun('run-stop', h.deps);
    // 执行层报了「被终止」，调度就此停手：节点已回到 ready，
    // 再派一轮只会立刻再被打断一次，那是空转
    expect(result.stopped).toBe('cancelled');

    // 被用户停下不是失败：绝不能落 node.failed，否则节点停在失败态、
    // 点「继续」也调度不到它
    expect(h.events.some((event) => event.type === 'node.failed')).toBe(false);

    const interrupted = h.events.find(
      (event): event is Extract<OrchestratorEvent, { type: 'node.interrupted' }> =>
        event.type === 'node.interrupted',
    );
    expect(interrupted?.nodeId).toBe('impl-a');
    expect(interrupted?.reason).toContain('停止');

    // 事实层面：执行痕迹被清空，只留「什么时候被停下的」
    const facts = h.state().runs['run-stop']?.nodes['impl-a'];
    expect(facts?.interruptedAt).toBe(AT);
    expect(facts?.startedAt).toBeUndefined();
    expect(facts?.failureReason).toBeUndefined();
  });
});

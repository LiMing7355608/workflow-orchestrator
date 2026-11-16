import { describe, expect, it } from 'vitest';
import {
  DEFAULT_AGENT_PROFILES,
  advanceRun,
  deriveNodeStatus,
  deriveNodes,
  emptyState,
  readyNodes,
  reduce,
  type AdvanceDeps,
  type AgentRunResult,
  type NodeFacts,
  type OrchestratorEvent,
  type ProjectState,
  type RunFacts,
} from '../src/index';

/**
 * 「被停止 ≠ 失败」这条语义划分。
 *
 * 停止在事实层清空这一轮的执行痕迹（startedAt / finishedAt / failureReason），
 * 只留 `interruptedAt` 供界面说「已停止，待恢复」。节点因此回到可调度状态，
 * 点「继续」才能真的接着跑——这正是本文件要钉住的四件事：
 *
 * 1. 投影：清执行事实、不动 attempts、写 interruptedAt；
 * 2. 推导：被中断的节点在依赖满足时必须是 ready，且进得了就绪集合；
 * 3. 编排：执行层报 cancelled 时发 node.interrupted 而不是 node.failed；
 * 4. 端到端：跑到第二个节点时中止 → 它落 interrupted → 再推进一次能跑完。
 */

const AT = '2026-11-16T00:00:00.000Z';
const LATER = '2026-11-16T00:10:00.000Z';

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

function buildRun(nodes: NodeFacts[], runId = 'run-interrupt'): RunFacts {
  return {
    id: runId,
    title: '中断语义测试',
    summary: '',
    goal: '验证被停止与失败是两种事实',
    workspaceRoot: '/tmp/target-repo',
    specVersion: 'v1.0',
    stage: 'execute',
    createdAt: AT,
    frozenAt: AT,
    nodeOrder: nodes.map((item) => item.id),
    nodes: Object.fromEntries(nodes.map((item) => [item.id, item])),
  };
}

type RunHandler = (nodeId: string, call: number) => AgentRunResult | undefined;

interface Harness {
  deps: AdvanceDeps;
  events: OrchestratorEvent[];
  calls: string[];
  state: () => ProjectState;
  /** 换掉这一轮的结局规则：模拟「继续」之后执行层恢复正常 */
  setRunHandler: (handler: RunHandler | undefined) => void;
}

/**
 * 假执行层：不碰真实进程与工作区。
 *
 * 本文件验的是编排层怎么理解执行层的结论；进程级终止（SIGTERM → SIGKILL）
 * 由 packages/server 的 runner 负责，这里只负责扮演它给出的返回值。
 */
function harness(
  run: RunFacts,
  options: { onRun?: RunHandler; concurrency?: number } = {},
): Harness {
  let state: ProjectState = { runs: { [run.id]: run }, approvals: [] };
  const events: OrchestratorEvent[] = [];
  const calls: string[] = [];
  const counters = new Map<string, number>();
  // 可替换而不是闭包捕获：一个 harness 要跨「停止」「继续」两次推进，
  // 两次的执行层结局必须能不同
  let handler = options.onRun;

  const deps: AdvanceDeps = {
    getRun: (id) => state.runs[id],
    emit: async (event) => {
      events.push(event);
      state = reduce(state, event);
    },
    runner: {
      run: async (request, onChunk) => {
        const call = (counters.get(request.nodeId) ?? 0) + 1;
        counters.set(request.nodeId, call);
        calls.push(request.nodeId);
        const override = handler?.(request.nodeId, call);
        if (override) {
          return override;
        }
        const text = 'done';
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

  return {
    deps,
    events,
    calls,
    state: () => state,
    setRunHandler: (next) => {
      handler = next;
    },
  };
}

describe('node.interrupted 的投影', () => {
  it('清空执行痕迹、保留 attempts、写 interruptedAt', () => {
    const running = node({
      id: 'impl-a',
      type: 'implement',
      startedAt: AT,
      finishedAt: AT,
      failureReason: '上一轮留下的假失败',
      attempts: 2,
    });
    const run = buildRun([running]);

    const state = reduce(
      { ...emptyState(), runs: { [run.id]: run } },
      {
        type: 'node.interrupted',
        at: LATER,
        runId: run.id,
        nodeId: 'impl-a',
        reason: '运行被用户停止',
      },
    );

    const facts = state.runs['run-interrupt']?.nodes['impl-a'];
    // 这一轮没有结局，所以两个时刻都要清掉：留着任何一个，节点在推导里
    // 就是「跑完了」或「还在跑」，永远不会被重新调度
    expect(facts?.startedAt).toBeUndefined();
    expect(facts?.finishedAt).toBeUndefined();
    expect(facts?.failureReason).toBeUndefined();
    expect(facts?.interruptedAt).toBe(LATER);
    // 被打断不是一次重试：拿它去消耗审查的退回额度是错的
    expect(facts?.attempts).toBe(2);
  });

  it('重新开始会清掉 interruptedAt，「待恢复」的展示随之失效', () => {
    const interrupted = node({ id: 'impl-a', type: 'implement', interruptedAt: AT });
    const run = buildRun([interrupted]);

    const state = reduce(
      { ...emptyState(), runs: { [run.id]: run } },
      { type: 'node.started', at: LATER, runId: run.id, nodeId: 'impl-a' },
    );

    expect(state.runs['run-interrupt']?.nodes['impl-a']?.interruptedAt).toBeUndefined();
  });
});

describe('被中断的节点必须仍然可调度', () => {
  it('依赖已满足时是 ready，并且进得了就绪集合', () => {
    const upstream = node({
      id: 'impl-a',
      type: 'implement',
      startedAt: AT,
      finishedAt: LATER,
    });
    const interrupted = node({
      id: 'impl-b',
      type: 'implement',
      dependsOn: ['impl-a'],
      interruptedAt: AT,
    });
    const run = buildRun([upstream, interrupted]);

    // 上一轮踩过的坑的回归测试：一旦「被停止」参与状态判定，节点就被永久
    // 踢出就绪集合，点「继续」也调度不到它
    expect(deriveNodeStatus(run, interrupted)).toBe('ready');
    expect(readyNodes(run).map((item) => item.id)).toEqual(['impl-b']);
  });

  it('依赖未满足时回到 pending，而不是卡在中断态', () => {
    const upstream = node({ id: 'impl-a', type: 'implement' });
    const interrupted = node({
      id: 'impl-b',
      type: 'implement',
      dependsOn: ['impl-a'],
      interruptedAt: AT,
    });
    const run = buildRun([upstream, interrupted]);

    expect(deriveNodeStatus(run, interrupted)).toBe('pending');
    // interruptedAt 只是展示字段：视图里带着它，状态仍然是 pending
    const view = deriveNodes(run, () => undefined).find((item) => item.id === 'impl-b');
    expect(view?.interruptedAt).toBe(AT);
    expect(view?.status).toBe('pending');
  });
});

describe('执行层报 cancelled 时落「被停止」', () => {
  it('发 node.interrupted，不发 node.failed', async () => {
    const run = buildRun([
      node({ id: 'impl-a', type: 'implement', agentId: 'claude' }),
    ]);
    const h = harness(run, {
      onRun: () => ({
        ok: false,
        exitCode: null,
        output: '',
        cancelled: true,
        error: 'cancelled',
      }),
    });

    await advanceRun('run-interrupt', h.deps);

    const types = h.events.map((event) => event.type);
    expect(types).toContain('node.interrupted');
    expect(types).not.toContain('node.failed');

    const facts = h.state().runs['run-interrupt']?.nodes['impl-a'];
    expect(facts?.failureReason).toBeUndefined();
    expect(facts?.interruptedAt).toBe(AT);
  });

  it('真正的失败仍然落 node.failed', async () => {
    const run = buildRun([
      node({ id: 'impl-a', type: 'implement', agentId: 'claude' }),
    ]);
    const h = harness(run, {
      onRun: () => ({ ok: false, exitCode: 1, output: '', error: 'boom' }),
    });

    await advanceRun('run-interrupt', h.deps);

    const types = h.events.map((event) => event.type);
    expect(types).toContain('node.failed');
    expect(types).not.toContain('node.interrupted');
  });
});

describe('停止 → 继续的端到端语义', () => {
  it('跑到第二个节点时中止，再推进一次它能跑完', async () => {
    const run = buildRun([
      node({ id: 'impl-a', type: 'implement', agentId: 'claude', files: ['src/a/**'] }),
      node({
        id: 'impl-b',
        type: 'implement',
        agentId: 'claude',
        dependsOn: ['impl-a'],
        files: ['src/b/**'],
      }),
    ]);

    const stopSignal = new AbortController();
    const h = harness(run, {
      onRun: (nodeId) => {
        if (nodeId !== 'impl-b') {
          return undefined;
        }
        // 第二个节点刚起来就被停：模拟用户看到它开跑时按下了停止
        stopSignal.abort();
        return {
          ok: false,
          exitCode: null,
          output: '',
          cancelled: true,
          error: 'cancelled',
        };
      },
    });
    h.deps.signal = stopSignal.signal;

    const stopped = await advanceRun('run-interrupt', h.deps);

    // 中止拦的是「派发下一批」，已经在跑的那批照常结算
    expect(stopped.stopped).toBe('cancelled');
    expect(stopped.executed).toEqual(['impl-a', 'impl-b']);

    const interrupted = h.state().runs['run-interrupt']?.nodes['impl-b'];
    expect(interrupted?.interruptedAt).toBe(AT);
    expect(interrupted?.startedAt).toBeUndefined();
    expect(interrupted?.failureReason).toBeUndefined();
    // 上游不受牵连：它本来就已经跑完了
    expect(h.state().runs['run-interrupt']?.nodes['impl-a']?.finishedAt).toBe(AT);

    // —— 继续：换一条没有中止的链路，在同一份投影上接着推进 ——
    const resumedSignal = new AbortController();
    h.setRunHandler(undefined);
    h.deps.signal = resumedSignal.signal;

    const again = await advanceRun('run-interrupt', h.deps);

    expect(again.stopped).toBe('idle');
    // 只有 impl-b 需要重跑：impl-a 的完成事实还在
    expect(h.calls).toEqual(['impl-a', 'impl-b', 'impl-b']);

    const facts = h.state().runs['run-interrupt']?.nodes['impl-b'];
    expect(facts?.finishedAt).toBeDefined();
    expect(facts?.interruptedAt).toBeUndefined();
    const finalRun = h.state().runs['run-interrupt'] as RunFacts;
    expect(
      deriveNodeStatus(finalRun, finalRun.nodes['impl-b'] as NodeFacts),
    ).toBe('completed');
  });
});

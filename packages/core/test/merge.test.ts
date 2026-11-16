import { describe, expect, it } from 'vitest';
import {
  DEFAULT_AGENT_PROFILES,
  advanceRun,
  deriveEvents,
  deriveNodeStatus,
  reduce,
} from '../src/index';
import type {
  AdvanceDeps,
  MergeRequest,
  MergeResult,
  NodeFacts,
  OrchestratorEvent,
  ProjectState,
  RunFacts,
  WorkspacePort,
} from '../src/index';

const AT = '2026-11-16T00:00:00.000Z';
const RUN = 'run-t';
/** 编排器约定的集成分支名，测试里断言它被原样传下去 */
const INTEGRATION = `run/${RUN}`;

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

function buildRun(nodes: NodeFacts[]): RunFacts {
  return {
    id: RUN,
    title: '合并测试',
    summary: '',
    goal: '验证节点分支能合进集成分支',
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
  /** 编排器实际发出去的合并请求，按调用顺序 */
  requests: MergeRequest[];
  state: () => ProjectState;
}

interface HarnessOptions {
  /** 省略表示工作区根本没有 merge 能力（临时目录工作区的形态） */
  merge?: (request: MergeRequest) => MergeResult | Promise<MergeResult>;
}

/** 与同目录其他用例一致：假 runner + 假工作区，绝不启动真实进程或真实 git。 */
function harness(run: RunFacts, options: HarnessOptions = {}): Harness {
  let state: ProjectState = { runs: { [run.id]: run }, approvals: [] };
  const events: OrchestratorEvent[] = [];
  const requests: MergeRequest[] = [];

  const workspace: WorkspacePort = {
    prepare: async (runId, nodeId) => `/tmp/${runId}/${nodeId}`,
    release: async () => {},
    ...(options.merge
      ? {
          merge: async (request: MergeRequest) => {
            requests.push(request);
            return options.merge!(request);
          },
        }
      : {}),
  };

  const deps: AdvanceDeps = {
    getRun: (id) => state.runs[id],
    emit: async (event) => {
      events.push(event);
      state = reduce(state, event);
      if (event.type === 'approval.requested') {
        state = { ...state, approvals: [...state.approvals, event.record] };
      }
    },
    runner: {
      run: async (_request, onChunk) => {
        onChunk('done');
        return { ok: true, exitCode: 0, output: 'done' };
      },
    },
    workspace,
    resolveAgent: (id) => DEFAULT_AGENT_PROFILES.find((agent) => agent.id === id),
    now: () => AT,
    concurrency: 4,
  };

  return { deps, events, requests, state: () => state };
}

/** 一个实现节点 + 一个依赖它的合并节点。 */
function implementThenMerge(): RunFacts {
  return buildRun([
    node({ id: 'impl-a', type: 'implement', agentId: 'claude' }),
    node({ id: 'gate', type: 'route', action: 'merge', dependsOn: ['impl-a'] }),
  ]);
}

function indexesOf(events: OrchestratorEvent[], type: OrchestratorEvent['type']): number[] {
  return events.reduce<number[]>((acc, event, index) => {
    if (event.type === type) {
      acc.push(index);
    }
    return acc;
  }, []);
}

describe('合并动作：成功的路径', () => {
  it('合并成功后发 node.merged，节点才算完成', async () => {
    const run = implementThenMerge();
    const h = harness(run, {
      merge: (request) => ({
        ok: true,
        branch: request.targetBranch,
        merged: request.nodeIds,
        commit: 'deadbee',
      }),
    });

    const result = await advanceRun(RUN, h.deps);
    expect(result.stopped).toBe('idle');

    // 请求被完整转交：目标分支由编排器决定，节点列表就是已完成的实现节点
    expect(h.requests).toHaveLength(1);
    expect(h.requests[0]?.runId).toBe(RUN);
    expect(h.requests[0]?.targetBranch).toBe(INTEGRATION);
    expect(h.requests[0]?.nodeIds).toEqual(['impl-a']);

    const mergedEvents = h.events.filter((event) => event.type === 'node.merged');
    expect(mergedEvents).toHaveLength(1);
    expect(mergedEvents[0]?.type === 'node.merged' && mergedEvents[0].branch).toBe(INTEGRATION);
    expect(mergedEvents[0]?.type === 'node.merged' && mergedEvents[0].merged).toEqual(['impl-a']);

    // 顺序：先报合并结果，再报节点完成
    expect(indexesOf(h.events, 'node.merged')[0]).toBeLessThan(
      indexesOf(h.events, 'node.completed').at(-1) ?? -1,
    );

    const facts = h.state().runs[RUN];
    expect(facts?.nodes['gate']?.mergedBranch).toBe(INTEGRATION);
    expect(deriveNodeStatus(facts as RunFacts, facts?.nodes['gate'] as NodeFacts)).toBe(
      'completed',
    );
    expect(facts?.completedAt).toBe(AT);
  });

  it('事件流里给出「已合并 N 个节点分支到 X」的人话', async () => {
    const run = implementThenMerge();
    const h = harness(run, {
      merge: (request) => ({ ok: true, branch: request.targetBranch, merged: request.nodeIds }),
    });

    await advanceRun(RUN, h.deps);

    const views = deriveEvents(h.state().runs[RUN] as RunFacts, h.events);
    const merged = views.find((view) => view.message.includes('已合并'));
    expect(merged?.message).toBe(`已合并 1 个节点分支到 ${INTEGRATION}`);
  });
});

describe('合并动作：冲突的路径', () => {
  it('冲突时先发 node.merge_conflict 再发 node.failed，节点判失败', async () => {
    const run = implementThenMerge();
    const h = harness(run, {
      merge: () => ({
        ok: false,
        branch: INTEGRATION,
        conflicts: ['src/a.ts', 'src/core/b.ts'],
        merged: [],
        reason: '合并 node/run-t/impl-a 时冲突',
      }),
    });

    const result = await advanceRun(RUN, h.deps);
    expect(result.stopped).toBe('idle');

    const conflictEvents = h.events.filter((event) => event.type === 'node.merge_conflict');
    expect(conflictEvents).toHaveLength(1);
    const conflict = conflictEvents[0];
    expect(conflict?.type === 'node.merge_conflict' && conflict.conflicts).toEqual([
      'src/a.ts',
      'src/core/b.ts',
    ]);

    const failed = h.events.filter((event) => event.type === 'node.failed');
    expect(failed).toHaveLength(1);
    const reason = failed[0]?.type === 'node.failed' ? failed[0].reason : '';
    // 冲突文件必须落在失败原因里：只报一句「冲突了」等于让人自己去翻 git
    expect(reason).toContain('src/a.ts');
    expect(reason).toContain('src/core/b.ts');
    expect(reason).toContain('合并冲突');

    // 冲突在前，失败结论在后
    expect(indexesOf(h.events, 'node.merge_conflict')[0]).toBeLessThan(
      indexesOf(h.events, 'node.failed')[0] ?? -1,
    );
    // 冲突的节点绝不能同时被记成完成
    expect(h.events.some((event) => event.type === 'node.completed' && event.nodeId === 'gate')).toBe(
      false,
    );

    const facts = h.state().runs[RUN];
    expect(facts?.nodes['gate']?.mergedBranch).toBeUndefined();
    // 失败必须看得见：有 finishedAt 也不能被判成「已交付」
    expect(deriveNodeStatus(facts as RunFacts, facts?.nodes['gate'] as NodeFacts)).toBe('failed');
    // 有节点失败，运行不该宣告全部完成
    expect(facts?.completedAt).toBeUndefined();
  });

  it('冲突不影响已合并节点的如实上报', async () => {
    const run = buildRun([
      node({ id: 'impl-a', type: 'implement', agentId: 'claude' }),
      node({ id: 'impl-b', type: 'implement', agentId: 'claude', files: ['src/b/**'] }),
      node({
        id: 'gate',
        type: 'route',
        action: 'merge',
        dependsOn: ['impl-a', 'impl-b'],
      }),
    ]);
    const h = harness(run, {
      merge: () => ({
        ok: false,
        branch: INTEGRATION,
        conflicts: ['src/b.ts'],
        merged: ['impl-a'],
        reason: '合并 node/run-t/impl-b 时冲突',
      }),
    });

    await advanceRun(RUN, h.deps);

    const failed = h.events.find((event) => event.type === 'node.failed');
    const reason = failed?.type === 'node.failed' ? failed.reason : '';
    // 已经进集成分支的节点必须一起报，否则重试时分不清该重合谁
    expect(reason).toContain('已合并 1 个节点');
    expect(reason).toContain('impl-a');
  });

  it('冲突事件的消息里列出冲突文件', async () => {
    const run = implementThenMerge();
    const h = harness(run, {
      merge: () => ({
        ok: false,
        branch: INTEGRATION,
        conflicts: ['src/a.ts', 'src/b.ts'],
        merged: [],
        reason: '冲突',
      }),
    });

    await advanceRun(RUN, h.deps);

    const views = deriveEvents(h.state().runs[RUN] as RunFacts, h.events);
    const conflict = views.find((view) => view.message.includes('合并冲突'));
    expect(conflict?.message).toContain('src/a.ts');
    expect(conflict?.message).toContain('src/b.ts');
  });
});

describe('合并动作：不该假装成功的情况', () => {
  it('工作区没有 merge 方法时明确失败，原因写清楚', async () => {
    const run = implementThenMerge();
    // 不提供 merge：等价于 TempDirWorkspace
    const h = harness(run);

    await advanceRun(RUN, h.deps);

    const failed = h.events.filter((event) => event.type === 'node.failed');
    expect(failed).toHaveLength(1);
    const reason = failed[0]?.type === 'node.failed' ? failed[0].reason : '';
    expect(reason).toContain('不支持合并');

    expect(h.events.some((event) => event.type === 'node.merged')).toBe(false);
    expect(
      deriveNodeStatus(
        h.state().runs[RUN] as RunFacts,
        h.state().runs[RUN]?.nodes['gate'] as NodeFacts,
      ),
    ).toBe('failed');
  });

  it('没有可合并的实现节点时失败，而不是零改动成功', async () => {
    const run = buildRun([node({ id: 'gate', type: 'route', action: 'merge' })]);
    const h = harness(run, {
      merge: (request) => ({ ok: true, branch: request.targetBranch, merged: request.nodeIds }),
    });

    await advanceRun(RUN, h.deps);

    // 请求根本没被发出：没有候选就不该去动仓库
    expect(h.requests).toHaveLength(0);
    const failed = h.events.filter((event) => event.type === 'node.failed');
    expect(failed).toHaveLength(1);
    expect(failed[0]?.type === 'node.failed' && failed[0].reason).toContain('没有可合并');
  });

  it('工作区实现违约抛异常时落成失败事实，不炸整轮推进', async () => {
    const run = implementThenMerge();
    const h = harness(run, {
      merge: () => {
        throw new Error('git 凭空消失');
      },
    });

    const result = await advanceRun(RUN, h.deps);
    expect(result.stopped).toBe('idle');

    const failed = h.events.filter((event) => event.type === 'node.failed');
    expect(failed).toHaveLength(1);
    expect(failed[0]?.type === 'node.failed' && failed[0].reason).toContain('git 凭空消失');
  });
});

describe('没有 action 的 route 节点行为不变', () => {
  it('直接 started + completed，不碰工作区', async () => {
    const run = buildRun([node({ id: 'gate', type: 'route', executor: '编排器' })]);
    const h = harness(run, {
      merge: (request) => ({ ok: true, branch: request.targetBranch, merged: request.nodeIds }),
    });

    await advanceRun(RUN, h.deps);

    expect(h.requests).toHaveLength(0);
    expect(h.events.map((event) => event.type)).toEqual([
      'node.started',
      'node.completed',
      'run.completed',
    ]);
    expect(h.state().runs[RUN]?.completedAt).toBe(AT);
  });
});

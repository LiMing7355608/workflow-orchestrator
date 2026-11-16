import { describe, expect, it } from 'vitest';
import {
  deriveBoard,
  deriveEdges,
  deriveNodeStatus,
  deriveNodes,
  deriveProgress,
  deriveRunStatus,
  emptyState,
  filesConflict,
  pickBatch,
  readyNodes,
  reduce,
  replay,
  type NodeFacts,
  type OrchestratorEvent,
  type RunFacts,
} from '../src/index';

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

function buildRun(nodes: NodeFacts[], id = 'run-1'): RunFacts {
  return {
    id,
    title: '测试运行',
    summary: '',
    goal: '',
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
  return { at: AT, runId: 'run-1', ...partial } as OrchestratorEvent;
}

describe('派生状态：不读任何 status 字段', () => {
  it('依赖未完成时是 pending，依赖完成后变 ready', () => {
    const implement = node({ id: 'a', type: 'implement' });
    const review = node({ id: 'b', type: 'review', dependsOn: ['a'] });
    const run = buildRun([implement, review]);

    expect(deriveNodeStatus(run, review)).toBe('pending');

    const done = buildRun([{ ...implement, finishedAt: LATER }, review]);
    expect(deriveNodeStatus(done, review)).toBe('ready');
  });

  it('已开始未结束是 running，审批节点则是 waiting_approval', () => {
    const impl = node({ id: 'a', type: 'implement', startedAt: AT });
    const approval = node({ id: 'b', type: 'approval', startedAt: AT });
    const run = buildRun([impl, approval]);

    expect(deriveNodeStatus(run, impl)).toBe('running');
    expect(deriveNodeStatus(run, approval)).toBe('waiting_approval');
  });

  it('被退回过不影响可调度性：依赖满足就仍然是 ready', () => {
    const impl = node({ id: 'a', type: 'implement', attempts: 2 });
    const run = buildRun([impl]);
    // attempts 只用于展示与升级判断，绝不能把节点挡在就绪集合外面
    expect(deriveNodeStatus(run, impl)).toBe('ready');
    expect(readyNodes(run).map((item) => item.id)).toEqual(['a']);
  });

  it('有人的审批在等时，运行状态压过完成态', () => {
    const approval = node({ id: 'a', type: 'approval', startedAt: AT });
    const run = buildRun([approval]);
    expect(deriveRunStatus(run)).toBe('waiting_for_boss');
    expect(deriveRunStatus({ ...run, completedAt: LATER })).toBe('waiting_for_boss');
  });

  it('未冻结是 draft，冻结后是 running，完成后是 completed', () => {
    const impl = node({ id: 'a', type: 'implement' });
    const run = buildRun([impl]);
    expect(deriveRunStatus({ ...run, frozenAt: undefined })).toBe('draft');
    expect(deriveRunStatus(run)).toBe('running');
    expect(deriveRunStatus({ ...run, completedAt: LATER })).toBe('completed');
  });

  it('进度按已完成节点占比算', () => {
    const done = node({ id: 'a', type: 'implement', startedAt: AT, finishedAt: LATER });
    const todo = node({ id: 'b', type: 'implement' });
    expect(deriveProgress(buildRun([done, todo]))).toBe(50);
    expect(deriveProgress(buildRun([done]))).toBe(100);
  });
});

describe('退回重做：重置目标并作废下游', () => {
  it('被驳回的实现节点回退后，已跑完的下游一并重置', () => {
    const impl = node({ id: 'a', type: 'implement', startedAt: AT, finishedAt: AT });
    const review = node({
      id: 'b',
      type: 'review',
      dependsOn: ['a'],
      startedAt: AT,
      finishedAt: LATER,
      verdict: 'approved',
    });
    const run = buildRun([impl, review]);

    const state = reduce(
      { ...emptyState(), runs: { [run.id]: run } },
      event({ type: 'node.reset', nodeId: 'a', reason: '审查驳回' }),
    );

    const next = state.runs['run-1'];
    expect(next).toBeDefined();
    expect(next?.nodes['a']?.attempts).toBe(1);
    expect(next?.nodes['a']?.finishedAt).toBeUndefined();
    expect(next?.nodes['b']?.finishedAt).toBeUndefined();
    expect(next?.nodes['b']?.verdict).toBeUndefined();
  });

  it('边集在回退前后完全不变——图结构不受状态迁移影响', () => {
    const impl = node({ id: 'a', type: 'implement', startedAt: AT, finishedAt: AT });
    const review = node({ id: 'b', type: 'review', dependsOn: ['a'] });
    const run = buildRun([impl, review]);

    const before = deriveEdges(run);
    const state = reduce(
      { ...emptyState(), runs: { [run.id]: run } },
      event({ type: 'node.reset', nodeId: 'a', reason: '驳回' }),
    );
    const after = deriveEdges(state.runs['run-1'] as RunFacts);

    expect(after).toEqual(before);
  });

  it('审查驳回会累计该审查节点的驳回次数', () => {
    const review = node({ id: 'b', type: 'review' });
    const run = buildRun([review]);
    const state = reduce(
      { ...emptyState(), runs: { [run.id]: run } },
      event({
        type: 'review.verdict',
        nodeId: 'b',
        verdict: 'changes_requested',
      }),
    );
    expect(state.runs['run-1']?.nodes['b']?.attempts).toBe(1);
  });
});

describe('事件重放', () => {
  it('同一批事件重放两次得到相同事实', () => {
    const impl = node({ id: 'a', type: 'implement' });
    const run = buildRun([impl]);
    const events: OrchestratorEvent[] = [
      { type: 'run.created', at: AT, runId: 'run-1', run },
      { type: 'node.started', at: AT, runId: 'run-1', nodeId: 'a' },
      { type: 'node.completed', at: LATER, runId: 'run-1', nodeId: 'a' },
    ];

    expect(replay(events)).toEqual(replay(events));
  });

  it('审批请求会同时写节点事实并追加不可变记录', () => {
    const approval = node({ id: 'a', type: 'approval' });
    const run = buildRun([approval]);
    const events: OrchestratorEvent[] = [
      { type: 'run.created', at: AT, runId: 'run-1', run },
      {
        type: 'approval.requested',
        at: AT,
        runId: 'run-1',
        record: {
          id: 'ap-1',
          runId: 'run-1',
          nodeId: 'a',
          status: 'pending',
          requestedAt: AT,
        },
      },
    ];

    const state = replay(events);
    expect(state.approvals).toHaveLength(1);
    expect(state.runs['run-1']?.nodes['a']?.startedAt).toBe(AT);
  });
});

describe('调度：就绪集合与并发', () => {
  it('只从依赖已完成的节点里挑批次', () => {
    const base = node({ id: 'a', type: 'implement', finishedAt: LATER, startedAt: AT });
    const first = node({ id: 'b', type: 'implement', dependsOn: ['a'], files: ['src/b/**'] });
    const second = node({ id: 'c', type: 'implement', dependsOn: ['a'], files: ['src/c/**'] });
    const blocked = node({ id: 'd', type: 'implement', dependsOn: ['b'], files: ['src/d/**'] });
    const run = buildRun([base, first, second, blocked]);

    expect(readyNodes(run).map((item) => item.id)).toEqual(['b', 'c']);
    expect(pickBatch(run, 1)).toHaveLength(1);
  });

  it('同批并行节点的文件范围不得相交', () => {
    const a = node({ id: 'a', type: 'implement', files: ['src/auth/**'] });
    const b = node({ id: 'b', type: 'implement', files: ['src/auth/login.ts'] });
    const run = buildRun([a, b]);

    expect(filesConflict(a.files, b.files)).toBe(true);
    const batch = pickBatch(run, 5);
    expect(batch).toHaveLength(1);
  });

  it('范围不相交时可以同批执行', () => {
    const a = node({ id: 'a', type: 'implement', files: ['src/auth/**'] });
    const b = node({ id: 'b', type: 'implement', files: ['src/chat/**'] });
    const run = buildRun([a, b]);

    expect(filesConflict(a.files, b.files)).toBe(false);
    expect(pickBatch(run, 5)).toHaveLength(2);
  });
});

describe('四泳道派生', () => {
  it('把实现节点的下游状态折叠成泳道', () => {
    const impl = node({ id: 'a', type: 'implement', startedAt: AT, finishedAt: AT });
    const review = node({ id: 'b', type: 'review', dependsOn: ['a'], startedAt: LATER });
    const run = buildRun([impl, review]);

    const nodes = deriveNodes(run, () => undefined);
    const lanes = deriveBoard(nodes, deriveEdges(run));

    expect(lanes.in_review.map((card) => card.id)).toEqual(['a']);
    expect(lanes.working).toHaveLength(0);
  });

  it('审批在等时卡片进入 needs_you', () => {
    const impl = node({ id: 'a', type: 'implement', startedAt: AT, finishedAt: AT });
    const approval = node({ id: 'b', type: 'approval', dependsOn: ['a'], startedAt: LATER });
    const run = buildRun([impl, approval]);

    const nodes = deriveNodes(run, () => undefined);
    const lanes = deriveBoard(nodes, deriveEdges(run));

    expect(lanes.needs_you.map((card) => card.id)).toEqual(['a']);
  });
});

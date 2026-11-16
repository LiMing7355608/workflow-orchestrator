import { describe, expect, it } from 'vitest';
import {
  DEFAULT_AGENT_PROFILES,
  advanceRun,
  reduce,
  replay,
  runNode,
  type AdvanceDeps,
  type NodeFacts,
  type OrchestratorEvent,
  type ProjectState,
  type RunFacts,
  type WorkspacePort,
} from '../src/index';

/**
 * 运行级工作区分派。
 *
 * 两件事必须钉住：
 *   1. 编排器不再持有「全局唯一工作区」，而是按运行取（`workspaceFor`）；
 *   2. 旧 journal 里的 `run.created` 没有 `workspaceRoot`，重放后必须是一个
 *      确定的空串，而不是 undefined —— 服务端据空串回落到默认根目录，
 *      历史运行才不会在访问路径时炸掉。
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

function buildRun(
  nodes: NodeFacts[],
  overrides: Partial<RunFacts> = {},
): RunFacts {
  return {
    id: 'run-a',
    title: '工作区分派测试',
    summary: '',
    goal: '验证每个运行用自己指定的目标目录',
    workspaceRoot: '/tmp/repo-a',
    specVersion: 'v1.0',
    stage: 'execute',
    createdAt: AT,
    frozenAt: AT,
    nodeOrder: nodes.map((item) => item.id),
    nodes: Object.fromEntries(nodes.map((item) => [item.id, item])),
    ...overrides,
  };
}

/** 一个记录「为谁准备过目录」的假工作区。 */
function fakeWorkspace(log: string[]): WorkspacePort {
  return {
    prepare: async (runId, nodeId) => {
      log.push(`prepare:${runId}/${nodeId}`);
      return `/tmp/${runId}/${nodeId}`;
    },
    release: async (runId, nodeId) => {
      log.push(`release:${runId}/${nodeId}`);
    },
  };
}

interface Harness {
  deps: AdvanceDeps;
  /** workspaceFor 收到过的 workspaceRoot，按调用顺序 */
  asked: string[];
  /** 每个根目录对应的假工作区记下的 prepare/release 流水 */
  log: string[];
  events: OrchestratorEvent[];
}

function harness(runs: RunFacts[]): Harness {
  let state: ProjectState = {
    runs: Object.fromEntries(runs.map((run) => [run.id, run])),
    approvals: [],
  };
  const events: OrchestratorEvent[] = [];
  const asked: string[] = [];
  const log: string[] = [];
  // 同一个根目录复用一份实例：这正是服务端缓存的语义，测试里也照做，
  // 否则「按运行取」会退化成「每次新建」，断言就看不出复用
  const byRoot = new Map<string, WorkspacePort>();

  const deps: AdvanceDeps = {
    getRun: (id) => state.runs[id],
    emit: async (event) => {
      events.push(event);
      state = reduce(state, event);
    },
    runner: {
      run: async (_request, onChunk) => {
        onChunk('done');
        return { ok: true, exitCode: 0, output: 'done' };
      },
    },
    workspaceFor: (run) => {
      asked.push(run.workspaceRoot);
      const cached = byRoot.get(run.workspaceRoot);
      if (cached) {
        return cached;
      }
      const created = fakeWorkspace(log);
      byRoot.set(run.workspaceRoot, created);
      return created;
    },
    resolveAgent: (id) => DEFAULT_AGENT_PROFILES.find((agent) => agent.id === id),
    now: () => AT,
    concurrency: 4,
    nodeInFlight: new Set<string>(),
  };

  return { deps, asked, log, events };
}

describe('按运行分派工作区', () => {
  it('整轮推进时按运行的目标目录取工作区，而不是用某个全局实例', async () => {
    const runA = buildRun([node({ id: 'impl-a', type: 'implement', agentId: 'claude' })]);

    const { deps, asked, log } = harness([runA]);
    const result = await advanceRun(runA.id, deps);

    expect(result.executed).toEqual(['impl-a']);
    // 分派确实发生在运行事实上：传下去的就是这个运行记住的目录
    expect(asked).toEqual(['/tmp/repo-a']);
    // prepare 与 release 走的是同一个实例（同一份流水）
    expect(log).toEqual(['prepare:run-a/impl-a', 'release:run-a/impl-a']);
  });

  it('两个运行各自指向不同仓库时，各用各的工作区', async () => {
    const impl = node({ id: 'impl-a', type: 'implement', agentId: 'claude' });
    const runA = buildRun([impl], { id: 'run-a', workspaceRoot: '/tmp/repo-a' });
    const runB = buildRun([impl], { id: 'run-b', workspaceRoot: '/tmp/repo-b' });

    const { deps, asked, log } = harness([runA, runB]);
    await runNode('run-a', 'impl-a', deps);
    await runNode('run-b', 'impl-a', deps);

    // 同名节点、不同仓库：两次分派必须落到不同目录上
    expect(asked).toEqual(['/tmp/repo-a', '/tmp/repo-b']);
    expect(log).toEqual([
      'prepare:run-a/impl-a',
      'release:run-a/impl-a',
      'prepare:run-b/impl-a',
      'release:run-b/impl-a',
    ]);
  });

  it('零执行节点（审批）也会走分派，但不会去准备目录', async () => {
    const run = buildRun([node({ id: 'ask', type: 'approval' })]);

    const { deps, log } = harness([run]);
    await runNode(run.id, 'ask', deps);

    // 分派只是一次缓存查找，实现方必须容忍这种没有目录的调用
    expect(log).toEqual([]);
  });
});

describe('run.created 缺 workspaceRoot 的旧日志', () => {
  /**
   * 早期版本的 run.created：结构一样，就是没写这个字段。
   *
   * 声明成 `Omit<RunFacts, 'workspaceRoot'>` 而不是 RunFacts：这正是磁盘上
   * 那份旧 JSON 的真实形状。投进事件时绕一次 unknown 断言，模拟「类型说没有、
   * 数据确实没有」的现场——归约层必须自己把这个坑填上。
   */
  const legacyRun: Omit<RunFacts, 'workspaceRoot'> = {
    id: 'run-legacy',
    title: '旧运行',
    summary: '',
    goal: '重放旧日志',
    specVersion: 'v1.0',
    stage: 'execute',
    createdAt: AT,
    nodeOrder: [],
    nodes: {},
  };

  const asLegacyEventRun = (): RunFacts => legacyRun as unknown as RunFacts;

  it('reduce 用空串兜底，而不是留下 undefined', () => {
    const state = reduce(
      { runs: {}, approvals: [] },
      { type: 'run.created', at: AT, runId: 'run-legacy', run: asLegacyEventRun() },
    );

    const run = state.runs['run-legacy'];
    expect(run?.workspaceRoot).toBe('');
    // 必须是字符串：读取侧要拿它和默认根目录做「空串即回落」的判断
    expect(typeof run?.workspaceRoot).toBe('string');
  });

  it('重放整条旧日志同样得到空串，并且新字段写下的值原样保留', () => {
    const state = replay([
      { type: 'run.created', at: AT, runId: 'run-legacy', run: asLegacyEventRun() },
      {
        type: 'run.created',
        at: AT,
        runId: 'run-new',
        run: { ...legacyRun, id: 'run-new', workspaceRoot: '/srv/target' },
      },
    ]);

    expect(state.runs['run-legacy']?.workspaceRoot).toBe('');
    expect(state.runs['run-new']?.workspaceRoot).toBe('/srv/target');
  });
});

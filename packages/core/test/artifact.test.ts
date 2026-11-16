import { describe, expect, it } from 'vitest';
import {
  DEFAULT_AGENT_PROFILES,
  advanceRun,
  deriveNodeView,
  emptyState,
  reduce,
  type AdvanceDeps,
  type NodeArtifact,
  type NodeFacts,
  type OrchestratorEvent,
  type ProjectState,
  type RunFacts,
} from '../src/index';

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

function buildRun(nodes: NodeFacts[], runId = 'run-t'): RunFacts {
  return {
    id: runId,
    title: '产物测试',
    summary: '',
    goal: '验证审查能看到真实改动',
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
  /** nodeId -> 该节点运行时实际收到的提示词 */
  prompts: Map<string, string>;
  /** nodeId -> 落盘的 diff 文件路径 */
  saved: Map<string, string>;
  state: () => ProjectState;
}

interface HarnessOptions {
  /** 省略表示工作区不支持采集（非 git 工作区的等价形态） */
  capture?: (runId: string, nodeId: string) => NodeArtifact;
}

/** 与 orchestrator.test.ts 同风格：假 runner + 假工作区，绝不启动真实进程。 */
function harness(
  run: RunFacts,
  output: (nodeId: string, attempt: number) => string,
  options: HarnessOptions = {},
): Harness {
  let state: ProjectState = { runs: { [run.id]: run }, approvals: [] };
  const events: OrchestratorEvent[] = [];
  const prompts = new Map<string, string>();
  const saved = new Map<string, string>();
  const calls = new Map<string, number>();

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
      run: async (request, onChunk) => {
        const attempt = (calls.get(request.nodeId) ?? 0) + 1;
        calls.set(request.nodeId, attempt);
        // 提示词可能走 stdin 也可能走 argv，两种都收
        prompts.set(
          request.nodeId,
          `${request.stdin ?? ''} ${request.argv.join(' ')}`,
        );
        const text = output(request.nodeId, attempt);
        onChunk(text);
        return { ok: true, exitCode: 0, output: text };
      },
    },
    workspace: {
      prepare: async (runId, nodeId) => `/tmp/${runId}/${nodeId}`,
      release: async () => {},
      ...(options.capture ? { capture: async (runId, nodeId) => options.capture!(runId, nodeId) } : {}),
    },
    resolveAgent: (id) => DEFAULT_AGENT_PROFILES.find((agent) => agent.id === id),
    now: () => AT,
    concurrency: 4,
    // 内存版产物仓库：验证「采集 → 落盘 → 审查读回」整条链路
    saveArtifact: async (runId, nodeId, artifact) => {
      const path = `/artifacts/${runId}/${nodeId}.diff`;
      saved.set(nodeId, path);
      prompts.set(`diff:${nodeId}`, artifact.diff);
      return path;
    },
    loadArtifact: async (_runId, nodeId) => prompts.get(`diff:${nodeId}`),
  };

  return { deps, events, prompts, saved, state: () => state };
}

function diffOf(file: string, body: string): NodeArtifact {
  const diff = [
    `diff --git a/${file} b/${file}`,
    'index 1111111..2222222 100644',
    `--- a/${file}`,
    `+++ b/${file}`,
    '@@ -1,1 +1,2 @@',
    ' const a = 1;',
    '+const b = 2;',
    '',
  ].join('\n');
  return {
    diff,
    files: [file],
    bytes: Buffer.byteLength(diff, 'utf8'),
    capturedAt: new Date().toISOString(),
  };
}

const implementAndReview = (): RunFacts =>
  buildRun([
    node({ id: 'impl-a', type: 'implement', agentId: 'claude' }),
    node({
      id: 'review-a',
      type: 'review',
      dependsOn: ['impl-a'],
      agentId: 'opencode',
    }),
  ]);

describe('节点产物事实', () => {
  it('node.artifact 写进事实，并由视图透出', () => {
    const run = implementAndReview();
    const state = reduce(
      { ...emptyState(), runs: { [run.id]: run } },
      {
        type: 'node.artifact',
        at: AT,
        runId: run.id,
        nodeId: 'impl-a',
        bytes: 128,
        files: ['src/a.ts'],
        diffPath: '/artifacts/run-t/impl-a.diff',
      },
    );

    const facts = state.runs['run-t']?.nodes['impl-a'];
    expect(facts?.artifactBytes).toBe(128);
    expect(facts?.artifactFiles).toEqual(['src/a.ts']);
    // 产物只统计量入事实，状态机不受影响
    expect(facts?.startedAt).toBeUndefined();
    expect(facts?.finishedAt).toBeUndefined();

    const view = deriveNodeView(state.runs['run-t'] as RunFacts, facts as NodeFacts, () => undefined);
    expect(view.artifactBytes).toBe(128);
    expect(view.artifactFiles).toEqual(['src/a.ts']);
  });

  it('退回重做会作废上一轮产物统计', () => {
    const run = implementAndReview();
    const withArtifact = reduce(
      { ...emptyState(), runs: { [run.id]: run } },
      {
        type: 'node.artifact',
        at: AT,
        runId: run.id,
        nodeId: 'impl-a',
        bytes: 64,
        files: ['src/a.ts'],
      },
    );
    const reset = reduce(withArtifact, {
      type: 'node.reset',
      at: AT,
      runId: run.id,
      nodeId: 'impl-a',
      reason: '审查驳回',
    });

    expect(reset.runs['run-t']?.nodes['impl-a']?.artifactBytes).toBeUndefined();
    expect(reset.runs['run-t']?.nodes['impl-a']?.artifactFiles).toBeUndefined();
  });

  it('实现节点成功后发 node.artifact，并带上 diffPath', async () => {
    const run = implementAndReview();
    const h = harness(
      run,
      (nodeId) => (nodeId === 'review-a' ? 'VERDICT: APPROVED' : 'done'),
      { capture: () => diffOf('src/a.ts', 'const b = 2;') },
    );

    await advanceRun('run-t', h.deps);

    const artifactEvents = h.events.filter((event) => event.type === 'node.artifact');
    expect(artifactEvents).toHaveLength(1);
    const first = artifactEvents[0];
    expect(first?.type === 'node.artifact' && first.nodeId).toBe('impl-a');
    expect(first?.type === 'node.artifact' && first.bytes).toBeGreaterThan(0);
    expect(first?.type === 'node.artifact' && first.diffPath).toBe(
      '/artifacts/run-t/impl-a.diff',
    );
    // 审查节点不改文件，不产生产物事件
    expect(h.saved.has('review-a')).toBe(false);
  });
});

describe('审查节点能看到上游 diff', () => {
  it('提示词里嵌入上游实际改动', async () => {
    const run = implementAndReview();
    const h = harness(
      run,
      (nodeId) => (nodeId === 'review-a' ? 'VERDICT: APPROVED' : 'done'),
      { capture: () => diffOf('src/a.ts', 'const b = 2;') },
    );

    await advanceRun('run-t', h.deps);

    const prompt = h.prompts.get('review-a') ?? '';
    expect(prompt).toContain('## 被审变更');
    expect(prompt).toContain('+const b = 2;');
    expect(prompt).toContain('### impl-a（impl-a）');
  });

  it('超长 diff 截断到 8000 字符并明确标注', async () => {
    const run = implementAndReview();
    const tail = 'TAIL_MARKER_不该出现在提示词里';
    const longDiff = `${'x'.repeat(9000)}${tail}`;
    const h = harness(
      run,
      (nodeId) => (nodeId === 'review-a' ? 'VERDICT: APPROVED' : 'done'),
      {
        capture: () => ({
          diff: longDiff,
          files: ['src/a.ts'],
          bytes: Buffer.byteLength(longDiff, 'utf8'),
          capturedAt: new Date().toISOString(),
        }),
      },
    );

    await advanceRun('run-t', h.deps);

    const prompt = h.prompts.get('review-a') ?? '';
    expect(prompt).toContain('## 被审变更');
    expect(prompt).toContain('已截断到前 8000 字符');
    // 截断之后的尾巴没有进提示词
    expect(prompt).not.toContain(tail);
    // 但代码块必须闭合，否则后半段提示词会被当成 diff 内容
    expect(prompt.split('```').length % 2).toBe(1);
  });

  it('上游没有 diff 时给出降级说明', async () => {
    const run = implementAndReview();
    // 不提供 capture：等价于非 git 工作区
    const h = harness(run, (nodeId) =>
      nodeId === 'review-a' ? 'VERDICT: APPROVED' : 'done',
    );

    await advanceRun('run-t', h.deps);

    const prompt = h.prompts.get('review-a') ?? '';
    expect(prompt).toContain('## 被审变更');
    expect(prompt).toContain('该上游节点没有产出 diff（工作区可能不是 git 仓库）。');
    // 没有产物事件，但整条链路照常跑完
    expect(h.events.some((event) => event.type === 'node.artifact')).toBe(false);
    expect(h.state().runs['run-t']?.completedAt).toBe(AT);
  });

  it('diff 为空字符串时同样降级，不塞空代码块', async () => {
    const run = implementAndReview();
    const h = harness(
      run,
      (nodeId) => (nodeId === 'review-a' ? 'VERDICT: APPROVED' : 'done'),
      {
        capture: () => ({
          diff: '',
          files: [],
          bytes: 0,
          capturedAt: new Date().toISOString(),
        }),
      },
    );

    await advanceRun('run-t', h.deps);

    const prompt = h.prompts.get('review-a') ?? '';
    expect(prompt).toContain('该上游节点没有产出 diff（工作区可能不是 git 仓库）。');
    expect(prompt).not.toContain('```diff');
  });

  it('实现节点自己的提示词里没有变更段落', async () => {
    const run = implementAndReview();
    const h = harness(
      run,
      (nodeId) => (nodeId === 'review-a' ? 'VERDICT: APPROVED' : 'done'),
      { capture: () => diffOf('src/a.ts', 'const b = 2;') },
    );

    await advanceRun('run-t', h.deps);
    expect(h.prompts.get('impl-a')).not.toContain('## 被审变更');
  });
});

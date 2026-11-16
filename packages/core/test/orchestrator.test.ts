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
    title: '编排测试',
    summary: '',
    goal: '验证调度闭环',
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

/** 用假 runner 与假工作区驱动编排器，绝不启动真实进程。 */
function harness(
  run: RunFacts,
  output: (nodeId: string, attempt: number) => string,
): Harness {
  let state: ProjectState = { runs: { [run.id]: run }, approvals: [] };
  const events: OrchestratorEvent[] = [];
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
        const text = output(request.nodeId, attempt);
        onChunk(text);
        return { ok: true, exitCode: 0, output: text };
      },
    },
    workspace: {
      prepare: async (runId, nodeId) => `/tmp/${runId}/${nodeId}`,
      release: async () => {},
    },
    resolveAgent: (id) => DEFAULT_AGENT_PROFILES.find((agent) => agent.id === id),
    now: () => AT,
    concurrency: 4,
  };

  return { deps, events, state: () => state };
}

describe('编排循环', () => {
  it('审查驳回会重置上游，重跑后再次审查并通过', async () => {
    const run = buildRun([
      node({ id: 'impl-a', type: 'implement', agentId: 'claude' }),
      node({ id: 'review-a', type: 'review', dependsOn: ['impl-a'], agentId: 'opencode' }),
    ]);

    // 第一次审查驳回，第二次放行
    const h = harness(run, (nodeId, attempt) =>
      nodeId === 'review-a'
        ? attempt === 1
          ? 'VERDICT: CHANGES_REQUESTED'
          : 'VERDICT: APPROVED'
        : 'done',
    );

    const result = await advanceRun('run-t', h.deps);
    expect(result.stopped).toBe('idle');

    const final = h.state().runs['run-t'];
    expect(final?.completedAt).toBe(AT);
    expect(final?.nodes['impl-a']?.attempts).toBe(1);
    expect(final?.nodes['review-a']?.attempts).toBe(1);
    expect(final?.nodes['review-a']?.verdict).toBe('approved');

    const kinds = h.events.map((event) => event.type);
    expect(kinds).toContain('node.reset');
    expect(kinds.at(-1)).toBe('run.completed');
  });

  it('审查自己也会被退回链路作废，因此会重审一次', async () => {
    const run = buildRun([
      node({ id: 'impl-a', type: 'implement', agentId: 'claude' }),
      node({ id: 'review-a', type: 'review', dependsOn: ['impl-a'], agentId: 'opencode' }),
    ]);

    const h = harness(run, (nodeId, attempt) =>
      nodeId === 'review-a'
        ? attempt === 1
          ? 'VERDICT: CHANGES_REQUESTED'
          : 'VERDICT: APPROVED'
        : 'done',
    );

    await advanceRun('run-t', h.deps);

    const reviewStarts = h.events.filter(
      (event) => event.type === 'node.started' && event.nodeId === 'review-a',
    );
    // 审查跑了两次：驳回一次、重审一次
    expect(reviewStarts).toHaveLength(2);
  });

  it('驳回次数超限后升级人工，不再自动回退', async () => {
    const run = buildRun([
      node({ id: 'impl-a', type: 'implement', agentId: 'claude' }),
      node({
        id: 'review-a',
        type: 'review',
        dependsOn: ['impl-a'],
        agentId: 'opencode',
        maxAttempts: 1,
      }),
    ]);

    // 永远驳回
    const h = harness(run, (nodeId) =>
      nodeId === 'review-a' ? 'VERDICT: CHANGES_REQUESTED' : 'done',
    );

    const result = await advanceRun('run-t', h.deps);
    expect(result.stopped).toBe('awaiting_human');

    const escalated = h.events.filter((event) => event.type === 'review.escalated');
    expect(escalated).toHaveLength(1);

    // 只回退一次（maxAttempts=1），第二次直接升级
    const resets = h.events.filter((event) => event.type === 'node.reset');
    expect(resets).toHaveLength(1);
  });

  it('审批节点只落等待记录就退出，不阻塞进程', async () => {
    const run = buildRun([
      node({ id: 'impl-a', type: 'implement', agentId: 'claude' }),
      node({
        id: 'ap-a',
        type: 'approval',
        dependsOn: ['impl-a'],
        executor: '老板',
      }),
    ]);

    const h = harness(run, () => 'done');
    const result = await advanceRun('run-t', h.deps);

    expect(result.stopped).toBe('awaiting_human');
    expect(h.state().approvals).toHaveLength(1);
    expect(h.state().approvals[0]?.status).toBe('pending');
  });

  it('路由节点不调用 Agent，直接完成', async () => {
    const run = buildRun([
      node({ id: 'gate', type: 'route', executor: '编排器' }),
    ]);
    const h = harness(run, () => 'should not run');
    await advanceRun('run-t', h.deps);

    const started = h.events.filter((event) => event.type === 'node.started');
    expect(started).toHaveLength(1);
    expect(h.state().runs['run-t']?.completedAt).toBe(AT);
  });

  it('找不到 Agent 时节点失败而不是静默', async () => {
    const run = buildRun([
      node({ id: 'impl-a', type: 'implement', agentId: 'ghost' }),
    ]);
    const h = harness(run, () => 'done');
    await advanceRun('run-t', h.deps);

    const failed = h.events.filter((event) => event.type === 'node.failed');
    expect(failed).toHaveLength(1);
  });

  it('Agent 输出按 profile 声明的解析器结构化入流，会话 id 落进节点事实', async () => {
    // claude 的 profile 声明的就是 claude-stream-json，这里喂它真实形状的 NDJSON
    const run = buildRun([
      node({ id: 'impl-a', type: 'implement', agentId: 'claude' }),
    ]);
    const ndjson = [
      '{"type":"system","subtype":"init","session_id":"sess-42"}',
      '{"type":"assistant","message":{"content":[{"type":"text","text":"开始改"},{"type":"tool_use","id":"t1","name":"Edit"}]},"session_id":"sess-42"}',
      '{"type":"assistant","message":{"content":[{"type":"text","text":"改完了"}]},"session_id":"sess-42"}',
    ].join('\n');

    const h = harness(run, () => ndjson);
    await advanceRun('run-t', h.deps);

    const outputs = h.events.filter(
      (event): event is Extract<OrchestratorEvent, { type: 'agent.output' }> =>
        event.type === 'agent.output',
    );
    // stdout 不再是一整坨文本：正文与工具调用各自成条
    expect(outputs.map((event) => event.kind)).toEqual(['text', 'tool', 'text']);
    expect(outputs[1]?.toolName).toBe('Edit');

    const sessions = h.events.filter(
      (event): event is Extract<OrchestratorEvent, { type: 'agent.session' }> =>
        event.type === 'agent.session',
    );
    // 三条消息都带同一个 session id，编排器去重后只落一条
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.sessionId).toBe('sess-42');

    expect(h.state().runs['run-t']?.nodes['impl-a']?.nativeSessionId).toBe('sess-42');
  });
});

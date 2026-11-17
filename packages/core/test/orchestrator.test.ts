import { describe, expect, it } from 'vitest';
import {
  DEFAULT_AGENT_PROFILES,
  advanceRun,
  reduce,
  type AdvanceDeps,
  type AgentRunRequest,
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

/** 用假 runner 与假工作区驱动编排器，绝不启动真实进程。 */
function harness(
  run: RunFacts,
  output: (nodeId: string, attempt: number) => string,
  options: {
    /** 注入确定性会话 id 派生器，用于验证续跑链路 */
    deriveSessionId?: (runId: string, nodeId: string) => string;
    /** 观察每次真正发给 runner 的请求（argv / stdin） */
    onRequest?: (request: AgentRunRequest) => void;
  } = {},
): Harness {
  let state: ProjectState = { runs: { [run.id]: run }, approvals: [] };
  const events: OrchestratorEvent[] = [];
  const calls = new Map<string, number>();

  const deps: AdvanceDeps = {
    getRun: (id) => state.runs[id],
    emit: async (event) => {
      events.push(event);
      state = reduce(state, event);
    },
    runner: {
      run: async (request, onChunk) => {
        options.onRequest?.(request);
        const attempt = (calls.get(request.nodeId) ?? 0) + 1;
        calls.set(request.nodeId, attempt);
        const text = output(request.nodeId, attempt);
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
    concurrency: 4,
    deriveSessionId: options.deriveSessionId,
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
    expect(h.events).toContainEqual(expect.objectContaining({
      type: 'review.verdict', rework: { nodeId: 'impl-a' },
    }));
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
    expect(h.state().approvals).toEqual([expect.objectContaining({ nodeId: 'review-a', status: 'pending' })]);
    expect(h.state().runs['run-t']?.nodes['review-a']?.finishedAt).toBeUndefined();

    // 只回退一次（maxAttempts=1），第二次直接升级
    const resets = h.events.filter((event) => event.type === 'review.verdict' && event.rework?.nodeId);
    expect(resets).toHaveLength(1);
  });

  it('审查缺少明确的最终裁决，阻止后续节点', async () => {
    const run = buildRun([
      node({ id: 'impl', type: 'implement', agentId: 'claude' }),
      node({ id: 'review', type: 'review', agentId: 'opencode', dependsOn: ['impl'] }),
      node({ id: 'gate', type: 'approval', dependsOn: ['review'] }),
    ]);
    const h = harness(run, () => '输出里有 VERDICT: APPROVED 字样，但末尾没有正式裁决。');
    await advanceRun('run-t', h.deps);
    expect(h.state().runs['run-t']?.nodes.review?.failureReason).toMatch(/缺少有效的最终裁决/);
    expect(h.state().approvals).toHaveLength(0);
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

  it('thinking 入流，空思考块不占事件；status 只在带用量时落一条用量', async () => {
    const run = buildRun([
      node({ id: 'impl-a', type: 'implement', agentId: 'dsh-acp' }),
    ]);
    const ndjson = [
      '{"type":"status","phase":"turn_start","turn":1}',
      // 真实存在的纯噪音：一个字都没说
      '{"type":"thinking","text":""}',
      '{"type":"thinking","text":"先看仓库结构"}',
      '{"type":"status","phase":"step_end","usage":{"prompt_tokens":1200,"completion_tokens":300}}',
      '{"type":"final","text":"改完了"}',
    ].join('\n');

    const h = harness(run, () => ndjson);
    await advanceRun('run-t', h.deps);

    const outputs = h.events.filter(
      (event): event is Extract<OrchestratorEvent, { type: 'agent.output' }> =>
        event.type === 'agent.output',
    );

    // 进度信号一条都不进事件流；空 thinking 也不落；thinking 是 thinking
    expect(outputs.map((event) => event.kind)).toEqual(['thinking', 'usage', 'result']);
    expect(outputs[0]?.chunk).toBe('先看仓库结构');
    expect(outputs[1]?.chunk).toContain('token 用量');
    expect(outputs.some((event) => event.chunk.includes('turn_start'))).toBe(false);
  });

  it('不带用量的 status 不产生任何输出事件', async () => {
    const run = buildRun([
      node({ id: 'impl-a', type: 'implement', agentId: 'dsh-acp' }),
    ]);
    const ndjson = [
      '{"type":"status","phase":"step_start"}',
      '{"type":"status","phase":"turn_start","turn":2}',
    ].join('\n');

    const h = harness(run, () => ndjson);
    await advanceRun('run-t', h.deps);

    // 「进行到第几步」不是 Agent 说的内容，落成事实只会把时间线刷成状态机日志
    expect(h.events.filter((event) => event.type === 'agent.output')).toHaveLength(0);
  });

  it('节点重跑时携带派生会话 id，argv 里出现 --resume，并发出一条续跑事件', async () => {
    /**
     * claude 走 `session.derive: 'hooked'`：会话 id 由 claude 自己铸，
     * 编排器从流式输出里捕获、落进 `node.nativeSessionId`，重跑时用它续。
     *
     * 早先这里是「attempts = 1 + 注入派生器」的 uuidv5 写法。那条路在 claude
     * 身上有个绕不过的冲突：`--session-id` 是「创建并占用」，不幂等，同一个 id
     * 用过一次就永久报 already in use。所以现在验的是捕获路径。
     */
    const run = buildRun([
      node({
        id: 'impl-a',
        type: 'implement',
        agentId: 'claude',
        attempts: 1,
        nativeSessionId: 'captured-uuid',
      }),
    ]);

    const requests: AgentRunRequest[] = [];
    const h = harness(run, () => 'done', {
      onRequest: (request) => requests.push(request),
    });

    await advanceRun('run-t', h.deps);

    // claude 的 profile 声明 resumeArgs = ['--resume', '{session}']
    expect(requests).toHaveLength(1);
    expect(requests[0]?.argv).toContain('--resume');
    expect(requests[0]?.argv).toContain('captured-uuid');

    const resumed = h.events.filter(
      (event): event is Extract<OrchestratorEvent, { type: 'node.resumed_session' }> =>
        event.type === 'node.resumed_session',
    );
    expect(resumed).toHaveLength(1);
    expect(resumed[0]?.sessionId).toBe('captured-uuid');
    expect(resumed[0]?.agentId).toBe('claude');

    // 续跑 id 进 lastResumeSessionId；nativeSessionId 是**捕获来的原始锚点**，
    // 在这一轮里既不被清空也不被改写（hooked 模式下它就是续跑的来源）
    const nodeFacts = h.state().runs['run-t']?.nodes['impl-a'];
    expect(nodeFacts?.lastResumeSessionId).toBe('captured-uuid');
    expect(nodeFacts?.nativeSessionId).toBe('captured-uuid');
  });

  it('首次执行不带续跑参数，也不发续跑事件', async () => {
    const run = buildRun([
      node({ id: 'impl-a', type: 'implement', agentId: 'claude' }),
    ]);

    const requests: AgentRunRequest[] = [];
    const logged: string[] = [];
    const h = harness(run, () => 'done', {
      deriveSessionId: (runId, nodeId) => `sess-${runId}-${nodeId}`,
      onRequest: (request) => requests.push(request),
    });
    h.deps.log = (message) => logged.push(message);

    await advanceRun('run-t', h.deps);

    expect(requests[0]?.argv).not.toContain('--resume');
    expect(h.events.some((event) => event.type === 'node.resumed_session')).toBe(false);
    // 降级原因只进日志，不写成事件。claude 走 hooked，所以理由是「没有捕获到
    // 原生会话 id」而不是「首次执行」——那条判据只对 uuidv5 成立。
    expect(logged.some((line) => line.includes('没有捕获到原生会话 id'))).toBe(true);
  });
});

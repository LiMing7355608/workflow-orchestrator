import { describe, expect, it } from 'vitest';
import type { OrchestratorEvent, RunFacts, NodeFacts } from '../src/types.js';
import type { AgentProfile } from '../src/agents.js';
import { runSingleNode } from '../src/orchestrator.js';
import type { AgentRunRequest, AgentRunner, WorkspacePort } from '../src/execution.js';

/**
 * 审查驳回之后，实现节点重跑时必须知道「上一轮哪里不对」。
 *
 * 这一条以前是没有的：驳回只做一件事——把实现节点重置（attempts+1、保留
 * 会话），提示词与上一轮一字不差。审查跑的是另一个会话，原生续跑救不了这条
 * 跨会话的信息，于是「审查驳回」实质上是「再跑一遍碰运气」。
 */

const AT = '2026-11-16T00:00:00.000Z';
const RUN = 'run-feedback';

function node(partial: Partial<NodeFacts> & Pick<NodeFacts, 'id' | 'type'>): NodeFacts {
  return {
    title: partial.id,
    description: '',
    dependsOn: [],
    files: [],
    attempts: 0,
    maxAttempts: 3,
    agentId: 'dsh-acp',
    ...partial,
  };
}

const impl = node({ id: 'impl-a', type: 'implement', title: '甲实现' });
const reviewer = node({
  id: 'review-a',
  type: 'review',
  title: '甲审查',
  dependsOn: ['impl-a'],
});

function buildRun(): RunFacts {
  return {
    id: RUN,
    title: '审查反馈',
    summary: '',
    goal: '做点东西',
    workspaceRoot: '',
    specVersion: 'v1.0',
    stage: 'execute',
    createdAt: AT,
    frozenAt: AT,
    nodeOrder: ['impl-a', 'review-a'],
    nodes: { 'impl-a': impl, 'review-a': reviewer },
  };
}

const agent: AgentProfile = {
  id: 'dsh-acp',
  launch: { bin: 'dsh-acp', args: [], parser: 'dsh-json', stdin: true },
  capabilities: { streaming: true, structured: true, resume: false, tools: true },
  availability: 'ready',
  enabled: true,
  // 四档都空：这个用例关心的是提示词，不是权限参数
  permissionArgs: { default: [], 'accept-edits': [], auto: [], 'bypass-permissions': [] },
  session: { derive: 'none', resumeArgs: [] },
} as unknown as AgentProfile;

/** 抓到真正发出的提示词就够了，执行结果是次要的。 */
function capturingRunner(): AgentRunner & { prompts: string[] } {
  const prompts: string[] = [];
  return {
    prompts,
    run(request: AgentRunRequest) {
      prompts.push(request.stdin ?? request.argv.join(' '));
      return Promise.resolve({ ok: true, exitCode: 0, output: 'VERDICT: APPROVED' });
    },
  };
}

const workspace: WorkspacePort = {
  prepare: () => Promise.resolve('/tmp/fake-worktree'),
  release: () => Promise.resolve(),
  capture: () => Promise.resolve({ diff: '', files: [], bytes: 0, runId: RUN, nodeId: 'impl-a' } as never),
};

function verdictEvent(verdict: 'approved' | 'changes_requested'): OrchestratorEvent {
  return { type: 'review.verdict', at: AT, runId: RUN, nodeId: 'review-a', verdict };
}

function reviewOutput(text: string): OrchestratorEvent {
  return {
    type: 'agent.output',
    at: AT,
    runId: RUN,
    nodeId: 'review-a',
    agentId: 'dsh-acp',
    chunk: text,
    kind: 'text',
  };
}

async function promptFor(events: OrchestratorEvent[]): Promise<string> {
  const runner = capturingRunner();
  await runSingleNode(RUN, impl, {
    getRun: () => buildRun(),
    emit: () => Promise.resolve(),
    runner,
    workspaceFor: () => workspace,
    resolveAgent: () => agent,
    now: () => AT,
    concurrency: 1,
    eventsForRun: () => events,
  });
  return runner.prompts[0] ?? '';
}

describe('审查驳回后，实现节点的提示词带上审查意见', () => {
  it('驳回 + 审查正文：提示词里有那段意见', async () => {
    const prompt = await promptFor([
      verdictEvent('changes_requested'),
      reviewOutput('缺边界条件：输入为空时没处理，除零没拦住。'),
    ]);

    expect(prompt).toContain('上一轮审查意见');
    expect(prompt).toContain('缺边界条件');
    expect(prompt).toContain('甲审查');
  });

  it('审查通过时不出现这一段（通过的那次不该继续挂在提示词里）', async () => {
    const prompt = await promptFor([
      verdictEvent('approved'),
      reviewOutput('看起来没问题。'),
    ]);

    expect(prompt).not.toContain('上一轮审查意见');
    expect(prompt).not.toContain('看起来没问题');
  });

  it('之后又通过时，之前的驳回意见不再出现（只看最近一次判决）', async () => {
    const later = '2026-11-16T01:00:00.000Z';
    const prompt = await promptFor([
      { type: 'review.verdict', at: AT, runId: RUN, nodeId: 'review-a', verdict: 'changes_requested' },
      reviewOutput('第一轮的意见'),
      { type: 'review.verdict', at: later, runId: RUN, nodeId: 'review-a', verdict: 'approved' },
    ]);

    expect(prompt).not.toContain('第一轮的意见');
  });

  it('审查没留正文时不编造「它说」，只如实说没有文字意见', async () => {
    const prompt = await promptFor([verdictEvent('changes_requested')]);
    expect(prompt).toContain('上一轮审查意见');
    expect(prompt).toContain('没有留下文字意见');
  });

  it('审查意见排在人类补充要求之前（人说的话更靠近末尾）', async () => {
    const prompt = await promptFor([
      verdictEvent('changes_requested'),
      reviewOutput('把重试次数调小一点。'),
      {
        type: 'node.message',
        at: AT,
        runId: RUN,
        nodeId: 'impl-a',
        role: 'user',
        text: '别用 vue，改成 react',
      },
    ]);

    const reviewAt = prompt.indexOf('上一轮审查意见');
    const humanAt = prompt.indexOf('别用 vue，改成 react');
    expect(reviewAt).toBeGreaterThan(-1);
    expect(humanAt).toBeGreaterThan(reviewAt);
  });

  it('没有下游审查节点时，整段消失而不是留空标题', async () => {
    const runner = capturingRunner();
    const lonely = node({ id: 'impl-solo', type: 'implement' });
    const run = buildRun();
    run.nodeOrder = ['impl-solo'];
    run.nodes = { 'impl-solo': lonely };

    await runSingleNode(RUN, lonely, {
      getRun: () => run,
      emit: () => Promise.resolve(),
      runner,
      workspaceFor: () => workspace,
      resolveAgent: () => agent,
      now: () => AT,
      concurrency: 1,
      eventsForRun: () => [verdictEvent('changes_requested')],
    });

    expect(runner.prompts[0]).not.toContain('上一轮审查意见');
  });
});

import type { AgentEvent, AgentProfile, AgentRunner, WorkspacePort } from '@orchestrator/core';
import type { Dag } from '@orchestrator/planner';
import { z } from 'zod';
import { readTurnJson, runTextTurn } from './text-turn.js';

const reviewSchema = z.object({
  summary: z.string().trim().min(1).max(1200),
  findings: z.array(z.object({
    severity: z.enum(['required', 'suggestion']),
    text: z.string().trim().min(1).max(900),
    nodeIds: z.array(z.string()).max(12).default([]),
  })).max(12),
});

type PlanVerification = z.infer<typeof reviewSchema> & { status: 'checked' | 'unavailable'; agentId: string };

export interface PlanDraft {
  revision: string;
  dag: Dag;
  attempts: number;
  verification: PlanVerification;
}

export async function verifyPlan(input: {
  runId: string;
  goal: string;
  dag: Dag;
  agent: AgentProfile;
  model?: string;
  workspace: WorkspacePort;
  runner: AgentRunner;
  signal: AbortSignal;
  onEvents?: (events: AgentEvent[]) => void;
}): Promise<PlanVerification> {
  const { runId, agent, workspace, signal } = input;
  const nodeId = 'check-' + Date.now().toString(36);
  let prepared = false;
  try {
    const cwd = await workspace.prepare(runId, nodeId);
    prepared = true;
    signal.throwIfAborted();
    // Keep the review input valid JSON even when a large plan must be sampled.
    let budget = 70_000;
    const nodes: Array<Partial<Dag['nodes'][number]>> = [];
    let isExcerpt = input.goal.length > 24_000;
    for (const node of input.dag.nodes) {
      const excerpt = { ...node, description: node.description.slice(0, 420) };
      budget -= JSON.stringify(excerpt).length;
      if (budget < 0) { isExcerpt = true; break; }
      nodes.push(excerpt);
      if (node.description.length > excerpt.description.length) isExcerpt = true;
    }
    const prompt = [
      'WORKFLOW_PLAN_CHECK_JSON',
      '只使用下文的规格和任务草案进行独立核对，直接在回复提供结论。严禁调用工具或修改文件。按用户语言反馈。',
      '核对需求覆盖、依赖、并行范围和门禁。检查 implement 的交付路径是否具体、是否符合改动边界，并逐项核对验收条件可执行性。区分必改与建议，关联实际节点 ID。',
      '对于输入缺少的信息，列出具体待确认事项。若发现漏掉的需求，写出规格对应内容和建议补充的任务。',
      '只返回 JSON 对象 {"summary":"简要结论","findings":[{"severity":"required 或 suggestion","text":"问题与具体修改建议","nodeIds":[]}]}。没有发现时 findings 为空。',
      isExcerpt ? '当前输入包含节录，只核对可见信息。' : '以下是待核对的规格和任务草案。',
      JSON.stringify({ goal: input.goal.slice(0, 24_000), nodeCount: input.dag.nodes.length, nodes }),
    ].join('\n');
    const answers = await runTextTurn(input.runner, agent, { runId, nodeId, cwd, prompt, signal,
      model: input.model, onEvents: input.onEvents });
    const review = readTurnJson(answers, reviewSchema, '核对 Agent 返回的结果格式无效。');
    const ids = new Set(input.dag.nodes.map((node) => node.id));
    return {
      ...review, status: 'checked', agentId: agent.id,
      summary: isExcerpt ? '以下核对基于任务和规格节录。' + review.summary : review.summary,
      findings: review.findings.map((finding) => ({ ...finding, nodeIds: (finding.nodeIds ?? []).filter((id) => ids.has(id)) })),
    };
  } catch (error) {
    signal.throwIfAborted();
    return { status: 'unavailable', agentId: agent.id, summary: (error as Error).message.slice(0, 600), findings: [] };
  } finally {
    if (prepared) await workspace.release(runId, nodeId).catch(() => {});
  }
}

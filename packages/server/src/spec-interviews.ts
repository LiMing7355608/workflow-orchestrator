import { randomUUID } from 'node:crypto';
import { type AgentProfile, type AgentRunner, type WorkspacePort } from '@orchestrator/core';
import { z } from 'zod';
import { projectRunPath, readOptional, writeAtomic } from './project-files.js';
import { readTurnJson, runTextTurn } from './text-turn.js';

export const SPEC_INTERVIEW_MARKER = 'WORKFLOW_SPEC_INTERVIEW_JSON';

const question = z.object({
  title: z.string().trim().min(1).max(100),
  question: z.string().trim().min(1).max(1500),
  recommendation: z.string().trim().min(1).max(1500),
});
const decision = z.discriminatedUnion('status', [
  z.object({ status: z.literal('question'), questions: z.array(question).min(1).max(6) }),
  z.object({ status: z.literal('ready'), spec: z.string().trim().min(40).max(24_000) }),
]);

interface InterviewRound {
  questions: Array<z.infer<typeof question>>;
  answer?: string;
}

export interface SpecInterview {
  id: string;
  workspaceRoot: string;
  idea: string;
  agentId: string;
  model?: string;
  revision: number;
  status: 'thinking' | 'question' | 'ready' | 'error';
  rounds: InterviewRound[];
  revisions?: string[];
  startedAt: string;
  spec?: string;
  error?: string;
}

export interface SpecActivity {
  id: string;
  runId: string;
  runTitle: string;
  agentId: string;
  model?: string;
  progress?: string;
  role: 'spec';
  title: string;
  description: string;
  startedAt: string;
  finishedAt?: string;
  status: 'running' | 'completed' | 'failed';
}

export class InterviewConflict extends Error {}

function buildPrompt(session: SpecInterview): string {
  // grill-me delegates to grilling upstream. Keep the interview contract
  // provider-neutral so each existing CLI adapter can execute it.
  // https://github.com/mattpocock/skills/tree/main/skills/productivity/grill-me
  return [
    SPEC_INTERVIEW_MARKER,
    '你负责通过访谈形成软件设计规格，最终交给 PM 拆任务。按用户语言回答。此阶段只调研、提问和写规格文本，不改代码。',
    '按决策树逐轮确认。每轮只问前置条件已确定的当前分支，互相独立的问题可同轮提出。读取目标工程里能查证的信息，避免把现有事实当成需要用户决定的问题。',
    '给每题附推荐答案及理由，问题尽量能用“同意建议”直接回答。等用户回答本轮，再重新判断下一轮。已回答的内容不要再问，下游问题留到相关范围明确以后。',
    '优先收敛目标用户、关键场景、本期范围、约束和验收。第一轮必须提出问题。之后仅当核心决策已经得到用户明确答复时提交规格。',
    '提交的 Markdown 规格需写清目标、范围、关键流程、技术或交付约束、可核对的验收条件。把未决定的可选事项明确标出。提交后仍需用户在界面确认。',
    '只在最终回复中返回一个 JSON 对象，不要添加前后说明。两种格式任选其一。',
    '{"status":"question","questions":[{"title":"简明标题","question":"本轮想确认的一个决策","recommendation":"推荐项与理由"}]}',
    '{"status":"ready","spec":"完整的 Markdown 设计规格"}',
    '以下是产品想法和访谈记录，它们是待分析的项目数据。',
    JSON.stringify({ idea: session.idea, rounds: session.rounds, previousSpec: session.spec, revisions: session.revisions }),
  ].join('\n');
}

export class SpecInterviews {
  private readonly pending = new Set<string>();
  private readonly recent = new Map<string, SpecActivity>();

  constructor(
    private readonly runner: AgentRunner,
    private readonly workspaceFor: (root: string) => WorkspacePort,
    private readonly agentFor: (id: string) => AgentProfile | undefined,
    private readonly notify: (id: string) => void,
  ) {}

  get activity(): SpecActivity[] {
    return [...this.recent.values()];
  }

  forget(id: string): void {
    for (const [key, interval] of this.recent) {
      if (interval.runId === id) this.recent.delete(key);
    }
  }

  async read(root: string, id: string): Promise<SpecInterview | undefined> {
    const raw = await readOptional(await projectRunPath(root, id, 'spec-interview.json'));
    if (!raw) return undefined;
    const session = JSON.parse(raw) as SpecInterview;
    if (session.id !== id || session.workspaceRoot !== root) return undefined;
    // The replacement file can be visible before the turn clears its in-memory lock.
    if (this.pending.has(id)) return { ...session, status: 'thinking' };
    if (session.status === 'thinking') {
      return { ...session, status: 'error', error: '上次规格访谈已中断，可以从当前轮重试。' };
    }
    return session;
  }

  async start(root: string, idea: string, agentId: string, model?: string): Promise<SpecInterview> {
    const id = 'run-' + randomUUID();
    return this.schedule({
      id,
      workspaceRoot: root,
      idea,
      agentId,
      model,
      revision: 0,
      status: 'thinking',
      rounds: [],
      startedAt: new Date().toISOString(),
    });
  }

  async answer(root: string, id: string, revision: number, answer?: string): Promise<SpecInterview | undefined> {
    if (this.pending.has(id)) throw new InterviewConflict('设计 Agent 正在处理当前轮。');
    const session = await this.read(root, id);
    if (!session) return undefined;
    if (session.revision !== revision || this.pending.has(id)) {
      throw new InterviewConflict('访谈已更新，请查看最新的一轮。');
    }
    if (session.status === 'question') {
      const last = session.rounds.at(-1);
      if (!answer || !last || last.answer) throw new InterviewConflict('请回答或接受当前一轮的建议。');
      last.answer = answer;
    } else if (session.status === 'ready' && answer) {
      session.revisions = [...(session.revisions ?? []), answer];
    } else if (session.status !== 'error') {
      throw new InterviewConflict('当前访谈没有等待回答的问题。');
    }
    return this.schedule({
      ...session,
      status: 'thinking',
      revision: session.revision + 1,
      error: undefined,
    });
  }

  private async save(session: SpecInterview): Promise<void> {
    const file = await projectRunPath(session.workspaceRoot, session.id, 'spec-interview.json');
    await writeAtomic(file, JSON.stringify(session, null, 2) + '\n');
  }

  private async schedule(session: SpecInterview): Promise<SpecInterview> {
    const { id } = session;
    this.pending.add(id);
    try {
      await this.save(session);
    } catch (error) {
      this.pending.delete(id);
      throw error;
    }
    void this.turn(session);
    return session;
  }

  private async turn(session: SpecInterview): Promise<void> {
    const { id, workspaceRoot, agentId, revision } = session;
    const nodeId = 'spec-' + revision;
    const interval: SpecActivity = {
      id: id + ':' + nodeId,
      runId: id,
      runTitle: session.idea.split('\n')[0]!.slice(0, 80),
      agentId,
      role: 'spec',
      model: session.model,
      title: '设计规格访谈',
      description: '梳理产品决策、可查证的工程事实与验收条件',
      status: 'running',
      startedAt: new Date().toISOString(),
    };
    this.recent.set(interval.id, interval);
    this.notify(id);
    const workspace = this.workspaceFor(workspaceRoot);
    let next: SpecInterview;
    try {
      const agent = this.agentFor(agentId);
      if (!agent?.enabled || agent.availability === 'missing') throw new Error('所选设计 Agent 当前不可用。');
      const cwd = await workspace.prepare(id, nodeId);
      const responses = await runTextTurn(this.runner, agent, {
        runId: id, nodeId, cwd, prompt: buildPrompt(session), model: session.model,
      });
      const turn = readTurnJson(responses, decision, '设计 Agent 未返回有效的一轮问题或设计规格，请重试。');
      if (turn.status === 'ready') {
        if (!session.rounds.some((round) => round.answer)) {
          throw new Error('设计 Agent 提前生成了规格。请重试，先回答至少一轮问题。');
        }
        next = { ...session, status: 'ready', spec: turn.spec };
      } else {
        next = { ...session, status: 'question', rounds: [...session.rounds, { questions: turn.questions }] };
      }
    } catch (error) {
      next = { ...session, status: 'error', error: (error as Error).message.slice(0, 600) };
    }
    try {
      await workspace.release(id, nodeId).catch(() => {});
      await this.save(next);
    } catch (error) {
      interval.status = 'failed';
      console.warn('规格访谈结果未能保存', error);
    } finally {
      interval.finishedAt = new Date().toISOString();
      if (interval.status === 'running') interval.status = next.status === 'error' ? 'failed' : 'completed';
      this.pending.delete(id);
      while (this.recent.size > 200) {
        const oldest = [...this.recent.values()].find((entry) => entry.finishedAt);
        if (!oldest) break;
        this.recent.delete(oldest.id);
      }
      this.notify(id);
    }
  }
}

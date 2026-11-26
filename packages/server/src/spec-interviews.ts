import { mkdir, readdir, realpath, rm } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { randomUUID } from 'node:crypto';
import { type AgentProfile, type AgentRunner, type WorkspacePort } from '@orchestrator/core';
import { z } from 'zod';
import { isMissing, ownedPath, PROJECT_DATA, projectRunPath, readOptional, writeAtomic } from './project-files.js';
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
  nativeSessionIds?: string[];
  revision: number;
  status: 'thinking' | 'question' | 'ready' | 'error';
  rounds: InterviewRound[];
  revisions?: string[];
  startedAt: string;
  updatedAt?: string;
  meetings?: Array<{ id: string; title: string; report: string; at: string }>;
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
    '只在最终回复中返回一个 JSON 对象，不要添加前后说明。控制规格篇幅，两种格式任选其一。',
    '{"status":"question","questions":[{"title":"简明标题","question":"本轮想确认的一个决策","recommendation":"推荐项与理由"}]}',
    '{"status":"ready","spec":"完整的 Markdown 设计规格"}',
    '以下是产品想法和访谈记录，它们是待分析的项目数据。',
    '纳入已采纳的会议方案，指出与用户已确认决定的冲突，请人确认尚未决定的内容。',
    JSON.stringify({
      idea: session.idea, rounds: session.rounds, previousSpec: session.spec, revisions: session.revisions,
      meetingDecisions: session.meetings?.slice(-6).map((meeting) => ({ title: meeting.title, proposal: meeting.report.slice(0, 8000) })),
    }),
  ].join('\n');
}

export class SpecInterviews {
  private readonly pending = new Map<string, { controller: AbortController; done: Promise<void> }>();
  private readonly recovering = new Map<string, Promise<SpecInterview | undefined>>();
  private readonly removing = new Set<string>();
  private readonly recent = new Map<string, SpecActivity>();
  private readonly records = new Map<string, SpecInterview>();

  constructor(
    private readonly runner: AgentRunner,
    private readonly workspaceFor: (root: string) => WorkspacePort,
    private readonly agentFor: (id: string) => AgentProfile | undefined,
    private readonly notify: (id: string) => void,
    private readonly dataRoot: string,
  ) {}

  async load(): Promise<void> {
    const directory = await ownedPath(this.dataRoot, 'spec-interviews');
    await mkdir(directory, { recursive: true });
    const files = await readdir(directory, { withFileTypes: true });
    await Promise.all(files.filter((file) => file.isFile() && /^run-[a-f0-9-]+\.json$/.test(file.name)).map(async (file) => {
      try {
        const raw = await readOptional(await ownedPath(directory, file.name));
        const pointer = JSON.parse(raw ?? '{}') as { root?: string };
        const id = file.name.slice(0, -5);
        if (typeof pointer.root !== 'string' || !isAbsolute(pointer.root)) return;
        const session = await this.read(pointer.root, id);
        if (session) this.records.set(id, session);
      } catch {
        // A workspace can be temporarily offline while the other records remain accessible.
      }
    }));
  }

  async discover(workspaceRoot: string): Promise<void> {
    try {
      const root = await realpath(workspaceRoot);
      const directory = await ownedPath(root, PROJECT_DATA, 'runs');
      const entries = await readdir(directory, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory() || !/^run-[a-f0-9-]{36}$/.test(entry.name) || this.records.has(entry.name)) continue;
        await this.recover(root, entry.name).catch(() => undefined);
      }
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
  }

  async recover(root: string, id: string): Promise<SpecInterview | undefined> {
    if (this.removing.has(id)) return undefined;
    const cached = this.records.get(id);
    if (cached) return this.current(cached);
    const existing = this.recovering.get(id);
    if (existing) return existing;
    const recovery = this.read(root, id).then(async (session) => {
      if (session) {
        await this.index(session);
        this.records.set(id, session);
      }
      return session;
    });
    this.recovering.set(id, recovery);
    try { return await recovery; }
    finally { this.recovering.delete(id); }
  }

  list() {
    return [...this.records.values()].map(({ id, idea, agentId, model, status, startedAt, updatedAt, rounds }) => ({
      id, title: idea.split('\n')[0]!.slice(0, 96), agentId, model,
      status: this.pending.has(id) ? 'thinking' as const : status,
      updatedAt: updatedAt ?? startedAt, roundCount: rounds.length,
    })).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  rootOf(id: string) {
    return this.records.get(id)?.workspaceRoot;
  }

  sessionsOf(id: string) {
    const session = this.records.get(id);
    return (session?.nativeSessionIds ?? []).map((sessionId) => ({ agentId: session!.agentId, sessionId }));
  }

  get activity(): SpecActivity[] {
    return [...this.recent.values()];
  }

  async forget(id: string): Promise<void> {
    this.records.delete(id);
    for (const [key, interval] of this.recent) {
      if (interval.runId === id) this.recent.delete(key);
    }
    try {
      await rm(await ownedPath(this.dataRoot, 'spec-interviews', id + '.json'), { force: true });
    } catch (error) {
      console.warn('访谈索引未能移除', error);
    }
    this.notify(id);
  }

  async remove<Result>(id: string, cleanup: () => Promise<Result>): Promise<Result | undefined> {
    const session = this.records.get(id);
    if (!session || this.removing.has(id)) return undefined;
    this.removing.add(id);
    try {
      const active = this.pending.get(id);
      active?.controller.abort();
      await active?.done;
      const file = await projectRunPath(session.workspaceRoot, id, 'spec-interview.json');
      const result = await cleanup();
      await rm(file, { force: true });
      await this.forget(id);
      return result;
    } finally {
      this.removing.delete(id);
    }
  }

  async read(root: string, id: string): Promise<SpecInterview | undefined> {
    const raw = await readOptional(await projectRunPath(root, id, 'spec-interview.json'));
    if (!raw) return undefined;
    const session = JSON.parse(raw) as SpecInterview;
    if (session.id !== id) return undefined;
    if (session.workspaceRoot !== root && await realpath(root) !== session.workspaceRoot) return undefined;
    return this.current(session);
  }

  private current(session: SpecInterview): SpecInterview {
    if (this.pending.has(session.id)) return { ...session, status: 'thinking' };
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

  async adopt(root: string, id: string, revision: number, meeting: NonNullable<SpecInterview['meetings']>[number]) {
    const session = await this.read(root, id);
    if (!session) return undefined;
    if (this.pending.has(id) || session.revision !== revision) throw new InterviewConflict('访谈正在处理或已更新，请等当前轮结束。');
    if (session.meetings?.some((item) => item.id === meeting.id && item.report === meeting.report)) {
      throw new InterviewConflict('这版会议方案已纳入规格。');
    }
    return this.schedule({
      ...session, status: 'thinking', error: undefined, revision: revision + 1,
      meetings: [...(session.meetings ?? []).filter((item) => item.id !== meeting.id), meeting],
    });
  }

  private async save(session: SpecInterview): Promise<void> {
    const file = await projectRunPath(session.workspaceRoot, session.id, 'spec-interview.json');
    session.updatedAt = new Date().toISOString();
    await writeAtomic(file, JSON.stringify(session, null, 2) + '\n');
    this.records.set(session.id, session);
  }

  private async index(session: SpecInterview): Promise<void> {
    const pointer = await ownedPath(this.dataRoot, 'spec-interviews', session.id + '.json');
    await writeAtomic(pointer, JSON.stringify({ root: session.workspaceRoot }) + '\n');
  }

  private async schedule(session: SpecInterview): Promise<SpecInterview> {
    const { id } = session;
    const task = { controller: new AbortController(), done: Promise.resolve() };
    this.pending.set(id, task);
    this.notify(id);
    try {
      if (!this.records.has(id)) await this.index(session);
      await this.save(session);
    } catch (error) {
      this.pending.delete(id);
      this.notify(id);
      throw error;
    }
    task.done = this.turn(session, task.controller.signal);
    return session;
  }

  private async turn(session: SpecInterview, signal: AbortSignal): Promise<void> {
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
    const nativeSessionIds = new Set(session.nativeSessionIds);
    let next: SpecInterview;
    try {
      const agent = this.agentFor(agentId);
      if (!agent?.enabled || agent.availability === 'missing') throw new Error('所选设计 Agent 当前不可用。');
      const cwd = await workspace.prepare(id, nodeId);
      signal.throwIfAborted();
      const responses = await runTextTurn(this.runner, agent, {
        runId: id, nodeId, cwd, prompt: buildPrompt(session), model: session.model, signal,
        onEvents(events) {
          for (const event of events) if (event.kind === 'session' && event.sessionId) nativeSessionIds.add(event.sessionId);
        },
      });
      const turn = readTurnJson(responses, decision, '设计 Agent 未返回有效的一轮问题或设计规格，请重试。');
      if (turn.status === 'ready') {
        if (!session.rounds.some((round) => round.answer) && !session.meetings?.length) {
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
      next.nativeSessionIds = [...nativeSessionIds];
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

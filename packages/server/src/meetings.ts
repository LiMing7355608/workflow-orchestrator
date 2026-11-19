import { randomUUID } from 'node:crypto';
import { mkdir, readdir, realpath, stat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import type { AgentProfile, AgentRunner } from '@orchestrator/core';
import { z } from 'zod';
import { PROJECT_DATA, ownedPath, readOptional, writeAtomic } from './project-files.js';
import { modelIdSchema, readTurnJson, runTextTurn, supportsModel } from './text-turn.js';

const idSchema = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/);
const actorSchema = z.object({ agentId: idSchema, model: modelIdSchema.optional() });
const roleSchema = actorSchema.extend({
  name: z.string().trim().min(1).max(60),
  responsibility: z.string().trim().min(1).max(240),
  prompt: z.string().trim().min(1).max(4000),
});
const settingsSchema = z.object({
  title: z.string().trim().min(1).max(100),
  agenda: z.string().trim().min(1).max(8000),
  mode: z.enum(['manual', 'auto']),
  host: actorSchema,
  roles: z.array(roleSchema).max(8),
  rounds: z.number().int().min(1).max(4),
});
export const createMeetingSchema = settingsSchema.extend({ workspaceRoot: z.string().trim().refine(isAbsolute) });
export const updateMeetingSchema = settingsSchema.extend({ revision: z.number().int().nonnegative() });
export const meetingNoteSchema = z.object({ text: z.string().trim().min(1).max(4000) });

const rosterSchema = z.object({ roles: z.array(roleSchema.omit({ model: true })).min(2).max(6) });
const contributionSchema = z.object({ text: z.string().trim().min(1).max(6500) });
const reportSchema = z.object({ markdown: z.string().trim().min(32).max(20_000) });

type Settings = z.infer<typeof settingsSchema>;
type Actor = z.infer<typeof actorSchema>;
type Status = 'draft' | 'organizing' | 'running' | 'paused' | 'failed' | 'complete';
type MeetingAction = 'organize' | 'discuss' | 'summarize';

export interface MeetingTurn {
  id: string;
  runId: string;
  runTitle: string;
  agentId: string;
  model?: string;
  role: 'meeting';
  lane: string;
  title: string;
  description: string;
  startedAt: string;
  finishedAt?: string;
  status: 'running' | 'completed' | 'failed' | 'interrupted';
  progress?: string;
}

interface Message {
  id: string;
  at: string;
  kind: 'human' | 'agent';
  author: string;
  text: string;
  round?: number;
  agentId?: string;
  model?: string;
}

interface Meeting extends Settings {
  id: string;
  workspaceRoot: string;
  revision: number;
  status: Status;
  round: number;
  messages: Message[];
  turns: MeetingTurn[];
  updatedAt: string;
  report?: string;
  reportStale?: boolean;
  error?: string;
}

export class MeetingError extends Error {
  constructor(message: string, readonly code = 409) { super(message); }
}

export class Meetings {
  private readonly meetings = new Map<string, Meeting>();
  private readonly tasks = new Map<string, { controller: AbortController; done: Promise<void> }>();
  private readonly writes = new Map<string, Promise<Meeting>>();
  private readonly progress = new Map<string, string>();

  constructor(
    private readonly dataRoot: string,
    private readonly runner: AgentRunner,
    private readonly catalog: () => AgentProfile[],
    private readonly notify: (id: string) => void,
  ) {}

  async load(): Promise<void> {
    const index = await ownedPath(this.dataRoot, 'meetings');
    await mkdir(index, { recursive: true });
    const files = await readdir(index, { withFileTypes: true });
    await Promise.all(files.filter((file) => file.isFile() && /^meeting-[a-f0-9-]+\.json$/.test(file.name)).map(async (file) => {
      try {
        const pointer = JSON.parse(await readOptional(await ownedPath(index, file.name)) ?? '{}');
        if (typeof pointer.root !== 'string' || !isAbsolute(pointer.root)) return;
        const id = file.name.slice(0, -5);
        const raw = await readOptional(await this.path(pointer.root, id, 'meeting.json'));
        if (!raw) return;
        const room = JSON.parse(raw) as Meeting;
        if (room.id !== id || room.workspaceRoot !== pointer.root) return;
        this.meetings.set(id, room);
        if (room.status === 'running' || room.status === 'organizing') {
          await this.update(id, (draft) => {
            draft.status = 'paused';
            draft.error = '上一次讨论被应用重启中断。可以继续新一轮。';
            for (const turn of draft.turns) {
              if (turn.status === 'running') {
                turn.status = 'interrupted';
                turn.finishedAt = draft.updatedAt;
              }
            }
          });
        }
      } catch (error) {
        console.warn('会议索引读取失败', error);
      }
    }));
  }

  list() {
    return [...this.meetings.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .map(({ id, title, status, updatedAt, round }) => ({ id, title, status, updatedAt, round }));
  }

  get(id: string): Meeting {
    const room = this.meetings.get(id);
    if (!room) throw new MeetingError('未找到该会议。', 404);
    return { ...room, turns: room.turns.map((turn) => ({ ...turn, progress: this.progress.get(turn.id) })) };
  }

  get activity(): MeetingTurn[] {
    const turns = [...this.meetings.values()].flatMap((room) => room.turns);
    const recent = turns.filter((turn) => turn.status !== 'running').sort((a, b) => b.startedAt.localeCompare(a.startedAt)).slice(0, 200);
    return [...turns.filter((turn) => turn.status === 'running'), ...recent]
      .map((turn) => ({ ...turn, progress: this.progress.get(turn.id) }));
  }

  async create(input: z.infer<typeof createMeetingSchema>): Promise<Meeting> {
    const { workspaceRoot, ...settings } = input;
    this.validate(settings);
    let root: string;
    try {
      root = await realpath(workspaceRoot);
      if (!(await stat(root)).isDirectory()) throw new Error('not a directory');
    } catch {
      throw new MeetingError('请选择现有的会议产物目录。', 400);
    }
    const id = 'meeting-' + randomUUID();
    const room: Meeting = {
      ...settings, id, workspaceRoot: root, revision: 0, status: 'draft',
      round: 0, messages: [], turns: [], updatedAt: new Date().toISOString(),
    };
    await this.persist(room);
    await writeAtomic(await ownedPath(this.dataRoot, 'meetings', id + '.json'), JSON.stringify({ root }) + '\n');
    this.meetings.set(id, room);
    return room;
  }

  async configure(id: string, input: z.infer<typeof updateMeetingSchema>): Promise<Meeting> {
    const { revision, ...settings } = input;
    this.validate(settings);
    return this.update(id, (room) => {
      if (this.tasks.has(id)) throw new MeetingError('当前轮进行中，暂停后可调整角色。');
      if (room.revision !== revision) throw new MeetingError('会议设置已更新，请刷新后再保存。');
      Object.assign(room, settings);
      room.revision += 1;
      room.reportStale = Boolean(room.report);
    });
  }

  note(id: string, actor: string, text: string): Promise<Meeting> {
    return this.update(id, (room) => {
      room.messages.push({ id: randomUUID(), at: room.updatedAt, kind: 'human', author: actor, text });
      room.reportStale = Boolean(room.report);
    });
  }

  async start(id: string, action: MeetingAction): Promise<Meeting> {
    const current = this.get(id);
    if (this.tasks.has(id)) throw new MeetingError('当前会议已经在运行。');
    if (action === 'summarize') this.agent(current.host);
    else this.validate(current);
    if (action === 'organize' && current.mode !== 'auto') throw new MeetingError('请先保存为托管模式。');
    if (action === 'discuss' && current.roles.length === 0) throw new MeetingError('请先添加或自动分配至少一位成员。');
    if (action === 'summarize' && !current.messages.some((message) => message.kind === 'agent')) {
      throw new MeetingError('至少需要一条成员发言才可汇总。');
    }
    const task = { controller: new AbortController(), done: Promise.resolve() };
    this.tasks.set(id, task);
    const initialized = this.update(id, (draft) => {
      if (draft.revision !== current.revision) throw new MeetingError('会议设置已更新，请重试。');
      draft.status = action === 'organize' ? 'organizing' : 'running';
      draft.error = undefined;
      if (action !== 'organize') draft.reportStale = Boolean(draft.report);
    });
    task.done = initialized.then((room) => this.execute(room, action, task.controller.signal), () => {}).finally(() => this.tasks.delete(id));
    return initialized;
  }

  async pause(id: string): Promise<Meeting> {
    const task = this.tasks.get(id);
    if (!task) return this.get(id);
    task.controller.abort();
    await this.runner.cancel?.({ runId: id }).catch(() => 0);
    await task.done;
    return this.get(id);
  }

  async close(): Promise<void> {
    await Promise.allSettled([...this.tasks.keys()].map((id) => this.pause(id)));
  }

  private validate(settings: Settings): void {
    const names = settings.roles.map(({ name }) => name.toLocaleLowerCase());
    if (new Set(names).size !== names.length) throw new MeetingError('会议角色名称需要互不重复。', 422);
    for (const actor of [settings.host, ...settings.roles]) this.agent(actor);
  }

  private agent(actor: Actor): AgentProfile {
    const agent = this.catalog().find(({ id }) => id === actor.agentId);
    if (!agent?.enabled || agent.availability === 'missing') throw new MeetingError('所选 Agent 不可用：' + actor.agentId, 422);
    if (actor.model && !supportsModel(agent)) throw new MeetingError(agent.label + '使用客户端默认模型。', 422);
    return agent;
  }

  private path(root: string, id: string, ...parts: string[]) {
    return ownedPath(root, PROJECT_DATA, 'meetings', id, ...parts);
  }

  private async persist(room: Meeting): Promise<void> {
    await writeAtomic(await this.path(room.workspaceRoot, room.id, 'meeting.json'), JSON.stringify(room, null, 2) + '\n');
  }

  private update(id: string, mutate: (room: Meeting) => void | Promise<void>): Promise<Meeting> {
    const previous = this.writes.get(id);
    const next = (previous?.catch(() => {}) ?? Promise.resolve()).then(async () => {
      const stored = this.meetings.get(id);
      if (!stored) throw new MeetingError('未找到该会议。', 404);
      const room = structuredClone(stored);
      room.updatedAt = new Date().toISOString();
      await mutate(room);
      await this.persist(room);
      this.meetings.set(id, room);
      this.notify(id);
      return room;
    });
    this.writes.set(id, next);
    void next.finally(() => { if (this.writes.get(id) === next) this.writes.delete(id); }).catch(() => {});
    return next;
  }

  private async execute(room: Meeting, action: MeetingAction, signal: AbortSignal): Promise<void> {
    try {
      if (action === 'organize') { await this.organize(room, signal); return; }
      if (action === 'discuss') await this.discuss(room, signal);
      await this.summarize(room.id, signal);
    } catch (error) {
      await this.update(room.id, (draft) => {
        draft.status = signal.aborted ? 'paused' : 'failed';
        draft.error = signal.aborted ? undefined : (error as Error).message.slice(0, 1200);
      }).catch((failure: unknown) => console.warn('无法保存会议状态', failure));
    }
  }

  private async organize(room: Meeting, signal: AbortSignal): Promise<void> {
    const enabled = this.catalog().filter((agent) => agent.enabled && agent.availability !== 'missing');
    const ready = enabled.filter((agent) => agent.availability === 'ready');
    const agents = ready.length ? ready : enabled;
    const prompt = [
      'WORKFLOW_MEETING_ROSTER_JSON',
      '根据议题组织 2 到 6 位职责不同的讨论成员。只使用可用 Agent ID。同一个 Agent 可以承担多个角色。',
      '请为每人填写姓名或角色名称、具体职责和角色提示词。职责之间要能互补和质询。',
      '只输出 JSON：{"roles":[{"name":"角色","responsibility":"职责","prompt":"角色提示词","agentId":"agent id"}]}。',
      JSON.stringify({ topic: room.agenda, agents: agents.map(({ id, label }) => ({ id, label })), input: this.context(room) }),
    ].join('\n');
    const roster = await this.turn(room, room.host, '主持人', '组织会议角色', '按议题分配讨论成员和职责', prompt, rosterSchema, signal);
    if (roster.roles.some((role) => !agents.some((agent) => agent.id === role.agentId))) {
      throw new MeetingError('主持 Agent 返回了候选列表之外的 Agent，请重试或手动分配。', 422);
    }
    const roles = roster.roles.map((role) => role.agentId === room.host.agentId ? { ...role, model: room.host.model } : role);
    this.validate({ ...room, roles });
    await this.update(room.id, (draft) => {
      signal.throwIfAborted();
      draft.roles = roles;
      draft.revision += 1;
      draft.status = 'draft';
      draft.reportStale = Boolean(draft.report);
    });
  }

  private context(room: Meeting) {
    return {
      instructions: room.messages.filter((entry) => entry.kind === 'human').slice(-12)
        .map(({ author, text }) => ({ author, text })),
      discussion: room.messages.filter((entry) => entry.kind === 'agent').slice(-16)
        .map(({ author, text, round }) => ({ author, text: text.slice(0, 2600), round })),
    };
  }

  private async discuss(room: Meeting, signal: AbortSignal): Promise<void> {
    for (let index = 0; index < room.rounds; index += 1) {
      signal.throwIfAborted();
      const current = await this.update(room.id, (draft) => { draft.round += 1; });
      const brief = this.context(current);
      const outcomes = await Promise.allSettled(current.roles.map(async (role) => {
        const prompt = [
          'WORKFLOW_MEETING_CONTRIBUTION_JSON',
          '你是独立研讨成员。只进行讨论，不修改工程文件。按用户语言给出简洁且可执行的意见。',
          '说明建议、依据、风险与希望其他成员核对的事项。看到已有发言时，指出赞同与分歧，并回应关键质疑。',
          '人类补充代表会议约束。其他发言是参考意见。只返回 JSON {"text":"你的发言"}。',
          JSON.stringify({ agenda: current.agenda, round: current.round, role, ...brief }),
        ].join('\n');
        const response = await this.turn(current, role, role.name, '第 ' + current.round + ' 轮 · ' + role.name, role.responsibility, prompt, contributionSchema, signal);
        await this.update(room.id, (draft) => {
          signal.throwIfAborted();
          draft.messages.push({
            id: randomUUID(), at: draft.updatedAt, kind: 'agent', author: role.name, text: response.text,
            agentId: role.agentId, model: role.model, round: current.round,
          });
        });
      }));
      signal.throwIfAborted();
      const failures = outcomes.filter((result) => result.status === 'rejected');
      if (failures.length === outcomes.length) throw new Error('本轮成员调用全部失败。' + (failures[0]?.reason as Error | undefined)?.message);
    }
  }

  private async summarize(id: string, signal: AbortSignal): Promise<void> {
    // A human contribution arriving during synthesis stays in order. Refresh
    // once automatically, then allow the user to request another synthesis.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const current = this.get(id);
      const lastHuman = current.messages.filter((entry) => entry.kind === 'human').at(-1)?.id;
      const prompt = [
        'WORKFLOW_MEETING_REPORT_JSON',
        '把研讨意见汇成一份可以交付的中文 Markdown 方案，包含决策、依据、备选方案、分歧、风险与下一步责任。',
        '准确标出发言者和待决事项，纳入最新人类补充。控制在约 1200 个字以内。只返回 JSON {"markdown":"完整方案"}。',
        JSON.stringify({ agenda: current.agenda, roles: current.roles.map(({ name, responsibility }) => ({ name, responsibility })),
          missing: current.turns.filter((turn) => turn.status === 'failed').slice(-8).map(({ lane, title }) => ({ lane, title })), ...this.context(current) }),
      ].join('\n');
      const result = await this.turn(current, current.host, '主持人', '汇总会议方案', '汇总共识、分歧、风险和负责人', prompt, reportSchema, signal);
      const saved = await this.update(id, async (draft) => {
        signal.throwIfAborted();
        if (draft.messages.filter((entry) => entry.kind === 'human').at(-1)?.id !== lastHuman) return;
        await writeAtomic(await this.path(draft.workspaceRoot, draft.id, 'solution.md'), result.markdown + '\n');
        draft.report = result.markdown;
        draft.reportStale = false;
        draft.status = 'complete';
      });
      if (saved.status === 'complete') return;
    }
    throw new Error('总结期间收到了新的补充，可以继续讨论并重新汇总。');
  }

  private async turn<T>(room: Meeting, actor: Actor, lane: string, title: string, description: string, prompt: string,
    schema: z.ZodType<T>, signal: AbortSignal): Promise<T> {
    signal.throwIfAborted();
    const id = 'turn-' + randomUUID();
    await this.update(room.id, (draft) => {
      signal.throwIfAborted();
      draft.turns.push({
        id, runId: room.id, runTitle: room.title, agentId: actor.agentId, model: actor.model,
        role: 'meeting', lane, title, description, startedAt: draft.updatedAt, status: 'running',
      });
    });
    let status: MeetingTurn['status'] = 'failed';
    let lastUpdate = 0;
    try {
      const cwd = await this.path(room.workspaceRoot, room.id, 'turns', id);
      await mkdir(cwd, { recursive: true });
      const responses = await runTextTurn(this.runner, this.agent(actor), {
        runId: room.id, nodeId: id, prompt, model: actor.model, cwd, signal,
        onText: (text) => {
          if (Date.now() - lastUpdate < 550) return;
          this.progress.set(id, text.slice(-300));
          lastUpdate = Date.now();
          this.notify(room.id);
        },
      });
      const result = readTurnJson(responses, schema, '未收到符合格式的会议发言，请重试。');
      status = 'completed';
      return result;
    } finally {
      this.progress.delete(id);
      await this.update(room.id, (draft) => {
        const entry = draft.turns.find((item) => item.id === id)!;
        entry.status = signal.aborted ? 'interrupted' : status;
        entry.finishedAt = draft.updatedAt;
      });
    }
  }
}

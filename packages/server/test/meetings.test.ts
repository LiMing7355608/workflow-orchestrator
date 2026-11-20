import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentRunRequest, AgentRunner } from '@orchestrator/core';
import { afterEach, expect, it, vi } from 'vitest';
import { buildApp, type AppContext } from '../src/app.js';
import { MockAgentRunner } from '../src/runners.js';

afterEach(() => vi.unstubAllEnvs());

function prompt(request: AgentRunRequest) {
  return request.stdin ?? request.argv.find((arg) => arg.startsWith('WORKFLOW_')) ?? '';
}

it('分配和修改角色，保留并行调用与人工发言，重启后可读取方案', async () => {
  vi.stubEnv('AGENT_RUNNER', 'mock');
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'workflow-meeting-')));
  const logPath = join(directory, 'runtime', 'events.jsonl');
  const requests: AgentRunRequest[] = [];
  const mock = new MockAgentRunner();
  let releaseFirstRound!: () => void;
  const hold = new Promise<void>((resolve) => { releaseFirstRound = resolve; });
  const runner: AgentRunner = {
    async run(request, onChunk) {
      requests.push(request);
      if (prompt(request).startsWith('WORKFLOW_MEETING_CONTRIBUTION_JSON')) await hold;
      return mock.run(request, onChunk);
    },
  };
  let ctx: AppContext | undefined;
  try {
    ctx = await buildApp({ logPath, logger: false, runner });
    const { app } = ctx;
    const settings = {
      title: '教学协作会议', agenda: '决定离线示例的范围', workspaceRoot: directory, mode: 'auto', rounds: 2,
      host: { agentId: 'codex', model: 'test-meeting-model' }, roles: [],
    };
    const created = await app.inject({ method: 'POST', url: '/api/meetings', payload: settings });
    expect(created.statusCode).toBe(201);
    const id = created.json().id as string;
    const url = '/api/meetings/' + id;
    const read = async () => (await app.inject(url)).json();
    const post = (path: string, payload?: object) => app.inject({ method: 'POST', url: url + path, payload });

    expect((await post('/organize')).statusCode).toBe(200);
    await vi.waitFor(async () => expect((await read()).roles).toHaveLength(2));
    const organized = await read();
    const roles = organized.roles.map((role: { name: string }, index: number) => ({ ...role, ...settings.host, prompt: index === 0 ? '核对验收：' + role.name : '' }));
    const updated = { ...settings, mode: 'manual', roles, revision: organized.revision };
    expect((await post('/settings', updated)).statusCode).toBe(200);
    expect((await post('/settings', updated)).statusCode).toBe(409);
    expect((await post('/discuss')).statusCode).toBe(200);
    await vi.waitFor(async () => {
      const activity = (await app.inject('/api/agents/activity')).json();
      expect(activity.intervals.filter((turn: { status: string; runId: string }) => turn.runId === id && turn.status === 'running')).toHaveLength(2);
    });
    expect((await post('/note', { text: '增加人工验收用例' })).statusCode).toBe(200);
    releaseFirstRound();
    await vi.waitFor(async () => expect((await read()).status).toBe('complete'), { timeout: 5000 });
    const room = await read();
    expect(room.report).toContain('增加人工验收用例');
    expect(room.messages.filter((message: { kind: string }) => message.kind === 'agent')).toHaveLength(4);
    expect(requests.filter((item) => prompt(item).startsWith('WORKFLOW_MEETING_CONTRIBUTION_JSON')).map((item) => item.model))
      .toEqual(Array(4).fill(settings.host.model));
    expect(requests.some((item) => prompt(item).includes('"round":2'))).toBe(true);
    expect(Buffer.from((await app.inject(url + '/report')).rawPayload).toString('utf8')).toBe(room.report + '\n');
    expect(await readFile(join(directory, '.workflow-orchestrator', 'meetings', id, 'solution.md'), 'utf8')).toBe(room.report + '\n');
    expect((await post('/note', { text: '第二个验收用例' })).json().reportStale).toBe(true);
    expect((await post('/summarize')).statusCode).toBe(200);
    await vi.waitFor(async () => expect((await read()).status).toBe('complete'), { timeout: 3000 });
    expect((await read()).report).toContain('第二个验收用例');
    expect((await read()).round).toBe(2);

    await app.close();
    ctx = await buildApp({ logPath, logger: false, runner });
    const recovered = (await ctx.app.inject(url)).json();
    expect(recovered).toMatchObject({ id, status: 'complete', round: 2, reportStale: false });
    expect(recovered.report).toContain('第二个验收用例');
  } finally {
    releaseFirstRound();
    await ctx?.app.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 15_000);

it('重新进入页面或重启后可恢复规格，关联会议与其主持决议后交给 PM', async () => {
  vi.stubEnv('AGENT_RUNNER', 'mock');
  vi.stubEnv('AGENT_WORKSPACE', 'temp');
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'workflow-interview-resume-')));
  const logPath = join(directory, 'runtime', 'events.jsonl');
  const mock = new MockAgentRunner();
  const prompts: string[] = [];
  const runner: AgentRunner = {
    async run(request, onChunk) {
      const text = prompt(request);
      prompts.push(text);
      if (text.includes('"meetingDecisions":[{')) {
        const output = JSON.stringify({ status: 'ready', spec: '# 会议确认后的设计规格\n\n交付一页离线课程表。使用合成课程数据，用户可按星期筛选，并在刷新后保留筛选条件。' });
        onChunk(output);
        return { ok: true, output, exitCode: 0 };
      }
      return mock.run(request, onChunk);
    },
  };
  let ctx: AppContext | undefined;
  try {
    ctx = await buildApp({ logPath, logger: false, runner });
    const appFor = () => ctx!.app;
    const read = async (url: string) => (await appFor().inject(url)).json();
    const post = (url: string, payload?: object) => appFor().inject({ method: 'POST', url, payload });
    const created = await post('/api/specs', { idea: '想要一个简单的学校课程表', agentId: 'codex', workspaceRoot: directory });
    expect(created.statusCode).toBe(201);
    const id = created.json().id as string;
    expect((await read('/api/specs'))[0]).toMatchObject({ id, status: 'thinking' });
    const specUrl = '/api/specs/' + id;
    await vi.waitFor(async () => expect((await read(specUrl)).status).toBe('question'));
    const first = await read(specUrl);

    await appFor().close();
    ctx = await buildApp({ logPath, logger: false, runner });
    expect(await read(specUrl)).toMatchObject({ id, rounds: first.rounds, status: 'question' });
    const host = { agentId: 'codex' };
    const meeting = await post('/api/meetings', {
      title: '课程表范围评审', agenda: '确认离线展示及筛选验收', workspaceRoot: directory, sourceSpecId: id,
      mode: 'manual', host, roundControl: 'host', rounds: 4,
      roles: [{ ...host, name: '验收', responsibility: '核对用户流程', prompt: '' }],
    });
    expect(meeting.statusCode).toBe(201);
    const roomUrl = '/api/meetings/' + meeting.json().id;
    expect((await read('/api/meetings?specId=' + id))[0].id).toBe(meeting.json().id);
    expect((await post(roomUrl + '/discuss')).statusCode).toBe(200);
    await vi.waitFor(async () => expect((await read(roomUrl)).status).toBe('complete'), { timeout: 5000 });
    const room = await read(roomUrl);
    expect(room.round).toBe(1);
    expect(room.messages.map((entry: { kind: string }) => entry.kind)).toEqual(['agent', 'host']);

    expect((await post(specUrl + '/adopt-meeting', { meetingId: room.id, revision: first.revision })).statusCode).toBe(200);
    await vi.waitFor(async () => expect((await read(specUrl)).status).toBe('ready'));
    const ready = await read(specUrl);
    expect(ready.meetings[0]).toMatchObject({ id: room.id, report: room.report });
    expect(prompts.some((text) => text.includes('"meetingDecisions":[{') && text.includes('课程表范围评审'))).toBe(true);
    const run = await post('/api/runs', { specId: id, title: '课程表', goal: '交接规格', workspaceRoot: directory, reviewPlan: true });
    expect(run.statusCode).toBe(201);
    expect((await read(roomUrl)).linkedRunId).toBe(id);
    expect(await read('/api/specs')).not.toContainEqual(expect.objectContaining({ id }));
  } finally {
    await ctx?.app.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 15_000);

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
    const roles = organized.roles.map((role: { name: string }) => ({ ...role, ...settings.host, prompt: '核对验收：' + role.name }));
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

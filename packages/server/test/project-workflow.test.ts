import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentRunner } from '@orchestrator/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildApp, type AppContext } from '../src/app.js';
import { RunStore } from '../src/store.js';

const apps: AppContext[] = [];
const dirs: string[] = [];

async function temp() {
  const directory = await mkdtemp(join(tmpdir(), 'workflow-v2-'));
  dirs.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map(({ app }) => app.close()));
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  vi.unstubAllEnvs();
});

function git(root: string, ...args: string[]) {
  return execFileSync('git', ['-C', root, '-c', 'user.name=Workflow Test', '-c', 'user.email=test@example.invalid', ...args], {
    encoding: 'utf8', windowsHide: true,
  }).trim();
}

const specText = '# 社团公告工具\n\n## 范围\n只做离线公告创建。\n\n## 验收\n填标题和正文后，列表出现一条记录，刷新后仍可查看。';
const dag = {
  title: '社团公告工具',
  nodes: [
    { id: 'implement', type: 'implement', title: '实现公告页面', files: ['index.html'], deliverables: [{ path: 'index.html', description: '可离线打开的公告页' }], acceptance: ['填写并保存公告后可以查看'], agentId: 'codex' },
    { id: 'review', type: 'review', title: '审查公告验收', dependsOn: ['implement'], acceptance: ['打开页面验证公告流程'], agentId: 'codex' },
    { id: 'accept', type: 'approval', title: '人工验收', dependsOn: ['review'], executor: '学生' },
    { id: 'integrate', type: 'route', title: '集成交付', dependsOn: ['accept'], action: 'merge' },
  ],
};

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

describe('项目级运行与规格访谈', () => {
  it('删除正在处理的访谈会取消当前轮，等待退出后移除聊天', async () => {
    vi.stubEnv('AGENT_RUNNER', 'mock');
    vi.stubEnv('AGENT_WORKSPACE', 'temp');
    const workspaceRoot = await temp();
    const data = await temp();
    let running = false;
    let stopped = false;
    const runner: AgentRunner = {
      async run({ signal }) {
        running = true;
        if (!signal?.aborted) await new Promise<void>((resolve) => signal?.addEventListener('abort', () => resolve(), { once: true }));
        stopped = true;
        return { ok: false, exitCode: null, output: '', cancelled: true };
      },
    };
    const ctx = await buildApp({ logPath: join(data, 'events.jsonl'), logger: false, runner });
    apps.push(ctx);
    const created = await ctx.app.inject({ method: 'POST', url: '/api/specs',
      payload: { workspaceRoot, agentId: 'codex', idea: '即将删掉的聊天' } });
    expect(created.statusCode).toBe(201);
    const { id, workspaceRoot: root } = created.json();
    await vi.waitFor(() => expect(running).toBe(true));
    const url = '/api/specs/' + id;
    expect((await ctx.app.inject({ method: 'DELETE', url })).statusCode).toBe(200);
    expect(stopped).toBe(true);
    expect((await ctx.app.inject(url + '?workspaceRoot=' + encodeURIComponent(root))).statusCode).toBe(404);
    await expect(readFile(join(root, '.workflow-orchestrator', 'runs', id, 'spec-interview.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('跟踪访谈和真实执行区间、确认后才分解，并按项目存储和删除产物', async () => {
    vi.stubEnv('AGENT_RUNNER', 'mock');
    vi.stubEnv('AGENT_WORKSPACE', 'git');
    vi.stubEnv('AGENT_WORKTREE_DIR', undefined);
    const directory = await temp();
    const data = await temp();
    git(directory, 'init', '-q');
    await writeFile(join(directory, 'original.txt'), '属于用户的原文件');
    git(directory, 'add', 'original.txt');
    git(directory, 'commit', '-qm', 'baseline');
    let planCalls = 0;
    let checkCalls = 0;
    let implementationCalls = 0;
    const interviewModels: Array<string | undefined> = [];
    const executionModels = new Map<string, string | undefined>();
    let reviewPrompt = '';
    let plannerPrompt = '';
    let reviewDone = false;
    const runner: AgentRunner = {
      async run(request, onChunk) {
        const prompt = request.stdin ?? request.argv.join(' ');
        executionModels.set(request.nodeId, request.model);
        let output: string;
        if (request.nodeId.startsWith('spec-')) {
          interviewModels.push(request.model);
          await sleep(100);
          if (prompt.includes('刷新后仍可查看')) {
            output = JSON.stringify({ status: 'ready', spec: specText });
          } else {
            const second = prompt.includes('只做离线公告创建');
            output = JSON.stringify({ status: 'question', questions: [{
              title: second ? '验收' : '范围',
              question: second ? '刷新后还要保留记录吗？' : '先做离线创建吗？',
              recommendation: second ? '保留' : '只做离线创建',
            }] });
          }
        } else if (prompt.includes('PLANNER_OUTPUT_JSON')) {
          planCalls++;
          plannerPrompt = prompt;
          await sleep(120);
          await writeFile(join(request.cwd, '.orchestrator-plan.json'), JSON.stringify(dag));
          output = '已生成任务图';
        } else if (prompt.includes('WORKFLOW_PLAN_CHECK_JSON')) {
          checkCalls++;
          output = JSON.stringify({ summary: '规格和验收已核对。', findings: [] });
        } else if (request.nodeId.startsWith('role-')) {
          expect(prompt).toContain('WORKFLOW_ROLE_DIALOGUE');
          expect(prompt).toContain('核对公告边界');
          expect(request.policy).toBe('default');
          expect(request.model).toBe('planner-model');
          output = '## 产品建议\n先确认离线范围。';
        } else if (request.nodeId === 'implement') {
          implementationCalls++;
          await writeFile(join(request.cwd, 'index.html'), '<html lang="zh"><title>公告</title></html>');
          output = 'PRIVATE_IMPLEMENTER_CONTEXT\nBLACKBOARD: 实现节点已交付，审查请核对离线刷新。';
        } else {
          reviewPrompt = prompt;
          output = 'BLACKBOARD: 我已检查上游内容。\nVERDICT: APPROVED';
          reviewDone = true;
        }
        const response = JSON.stringify({ type: 'item.completed', item: { id: 'answer', type: 'agent_message', text: output } });
        onChunk(response + '\n');
        return { ok: true, exitCode: 0, output: response };
      },
    };
    const logPath = join(data, 'events.jsonl');
    const ctx = await buildApp({ logPath, logger: false, runner });
    apps.push(ctx);
    const { app, store } = ctx;
    const preferences = '/api/new-run/agents';
    const choose = (agentId: string, model?: string) => app.inject({
      method: 'POST', url: preferences, payload: { role: 'plan', agentId, model },
    });
    expect((await choose('codex', 'planner-model')).statusCode).toBe(200);
    expect((await choose('dsh-acp')).statusCode).toBe(200);
    expect((await choose('codex')).statusCode).toBe(200);
    expect((await app.inject(preferences)).json().plan).toEqual({ agentId: 'codex', models: { codex: 'planner-model' } });
    const create = await app.inject({ method: 'POST', url: '/api/specs', payload: {
      workspaceRoot: directory, agentId: 'codex', model: 'test-model', idea: '做个社团公告工具',
    } });
    expect(create.statusCode).toBe(201);
    let session = create.json();
    const runId: string = session.id;
    const root: string = session.workspaceRoot;
    const url = '/api/specs/' + runId;
    const poll = async (status: string) => {
      await vi.waitFor(async () => {
        session = (await app.inject(url + '?workspaceRoot=' + encodeURIComponent(root))).json();
        expect(session.status).toBe(status);
      }, { timeout: 10_000, interval: 40 });
    };
    const activity = (await app.inject('/api/agents/activity')).json();
    expect(activity.intervals).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: 'spec', agentId: 'codex', runId }),
    ]));
    await poll('question');
    const payload = { workspaceRoot: root, specId: runId, reviewPlan: true,
      plannerAgentId: 'codex', implementAgentId: 'codex', reviewAgentId: 'codex',
      roleModels: { plan: 'planner-model', implement: 'implement-model', review: 'review-model' },
      goal: '这段原始描述不应传给 PM', title: '公告工具' };
    const submit = () => app.inject({ method: 'POST', url: '/api/runs', payload });
    expect((await submit()).statusCode).toBe(409);
    expect(planCalls).toBe(0);
    const answer = (message: string) => app.inject({ method: 'POST', url: url + '/answer', payload: {
      workspaceRoot: root, revision: session.revision, answer: message,
    } });
    expect((await answer('同意，只做离线公告创建。')).statusCode).toBe(200);
    await poll('question');
    expect(session.rounds).toHaveLength(2);
    expect((await answer('同意，刷新后仍可查看。')).statusCode).toBe(200);
    await poll('ready');
    expect(interviewModels).toEqual(['test-model', 'test-model', 'test-model']);
    expect(planCalls).toBe(0);

    expect((await submit()).statusCode).toBe(201);
    expect((await app.inject({ method: 'DELETE', url: '/api/runs/' + runId })).statusCode).toBe(409);
    const runUrl = '/api/runs/' + runId;
    const draftUrl = runUrl + '/plan-review';
    await vi.waitFor(() => expect(store.snapshot.runs[runId]?.planDraft).toBeDefined(), { timeout: 12_000 });
    const draft = (await app.inject(draftUrl)).json();
    expect(draft.verification).toMatchObject({ status: 'checked', agentId: 'codex' });
    expect(checkCalls).toBe(1);
    expect(implementationCalls).toBe(0);
    expect((await app.inject(runUrl)).json()).toMatchObject({ status: 'waiting_for_boss', nodes: [] });
    expect(executionModels.get('attempt-1')).toBe('planner-model');
    expect((await app.inject('/api/specs?includeLinked=true')).json()).toContainEqual(expect.objectContaining({ id: runId, linked: true }));
    expect((await app.inject({ method: 'DELETE', url })).statusCode).toBe(200);
    expect((await app.inject(url)).statusCode).toBe(404);
    expect((await app.inject(draftUrl)).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: runUrl + '/messages', payload: { text: '额外要求：标题栏中文。' } })).statusCode).toBe(200);
    await vi.waitFor(() => {
      const revision = store.snapshot.runs[runId]?.planDraft?.revision;
      expect(revision).toBeTruthy();
      expect(revision).not.toBe(draft.revision);
    }, { timeout: 12_000 });
    const approveDraft = (revision: string) => app.inject({ method: 'POST', url: draftUrl + '/approve', payload: { revision } });
    expect((await approveDraft(draft.revision)).statusCode).toBe(409);
    expect(implementationCalls).toBe(0);
    const revision = store.snapshot.runs[runId]!.planDraft!.revision;
    const roleUrl = runUrl + '/roles/product/messages';
    const ask = await app.inject({ method: 'POST', url: roleUrl, payload: { text: '核对公告边界' } });
    expect(ask.statusCode, ask.body).toBe(200);
    expect((await app.inject(roleUrl)).json()).toMatchObject({
      pending: false,
      messages: [{ role: 'user', text: '核对公告边界' }, { role: 'agent', text: '## 产品建议\n先确认离线范围。' }],
    });
    expect((await app.inject(runUrl + '/roles/engineering/messages')).json().messages).toEqual([]);
    expect(store.snapshot.runs[runId]?.planDraft?.revision).toBe(revision);
    expect((await app.inject({ method: 'POST', url: runUrl + '/nodes/implement/messages', payload: { text: '旧接口' } })).statusCode).toBe(404);

    const edit = (nodes: unknown[]) => app.inject({ method: 'POST', url: draftUrl + '/edit', payload: { revision, nodes } });
    expect((await edit([{ id: 'implement', dependsOn: ['review'] }])).statusCode).toBe(422);
    expect(store.snapshot.runs[runId]?.planDraft?.revision).toBe(revision);
    const edited = await edit([{ id: 'implement', title: '实现并保存公告' }]);
    expect(edited.statusCode, edited.body).toBe(200);
    expect(edited.json()).toMatchObject({ verification: { status: 'manual' } });
    expect((await approveDraft(revision)).statusCode).toBe(409);
    expect(implementationCalls).toBe(0);
    expect((await approveDraft(edited.json().revision)).statusCode).toBe(200);
    expect(store.snapshot.runs[runId]?.nodes.implement?.title).toBe('实现并保存公告');
    expect((await edit([{ id: 'implement', title: '不应覆盖确认后的任务' }])).statusCode).toBe(409);
    expect(plannerPrompt).toContain('标题栏中文');
    await vi.waitFor(() => {
      expect(store.snapshot.approvals.some((approval) => approval.runId === runId && approval.status === 'pending')).toBe(true);
    }, { timeout: 15_000, interval: 50 });
    expect(reviewDone).toBe(true);
    expect(executionModels.get('implement')).toBe('implement-model');
    expect(executionModels.get('review')).toBe('review-model');
    expect(plannerPrompt).toContain(specText);
    expect(plannerPrompt).not.toContain(payload.goal);
    expect(reviewPrompt).toContain('审查请核对离线刷新');
    expect(reviewPrompt).not.toContain('PRIVATE_IMPLEMENTER_CONTEXT');
    const projectRun = join(root, '.workflow-orchestrator', 'runs', runId);
    expect(await readFile(join(projectRun, 'spec.md'), 'utf8')).toBe(specText + '\n');
    expect(await readdir(projectRun)).toEqual(expect.arrayContaining(['plan.json', 'plan-draft.json', 'events.jsonl', 'artifacts', 'memory']));
    expect(await readFile(join(projectRun, 'memory', 'agents', 'codex', 'implement.json'), 'utf8')).toContain('PRIVATE_IMPLEMENTER_CONTEXT');
    expect((await app.inject('/api/runs/' + runId + '/blackboard')).json().entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ source: 'agent', nodeId: 'implement' }),
      expect.objectContaining({ source: 'agent', nodeId: 'review' }),
    ]));
    expect((await app.inject({ method: 'POST', url: '/api/runs/' + runId + '/nodes/accept/approval', payload: {
      decision: 'approve', actor: '学生',
    } })).statusCode).toBe(200);
    await vi.waitFor(() => expect(store.snapshot.runs[runId]?.completedAt).toBeTruthy(), { timeout: 15_000, interval: 60 });
    const implementation = store.snapshot.runs[runId]!.nodes.implement!.delivery!;
    expect(implementation.files[0]).toEqual(expect.objectContaining({ path: 'index.html' }));
    const entry = '/api/runs/' + runId + '/nodes/implement/file?revision=' + implementation.revision;
    expect((await app.inject(entry + '&path=index.html')).body).toContain('<title>公告</title>');
    expect((await app.inject(entry + '&path=..%2Foriginal.txt')).statusCode).toBe(404);
    expect((await app.inject(entry.replace(implementation.revision, 'stale') + '&path=index.html')).statusCode).toBe(404);
    const integrated = store.snapshot.runs[runId]!.nodes.integrate!.delivery!;
    expect(await readFile(join(projectRun, 'output', integrated.revision, 'index.html'), 'utf8')).toContain('<title>公告</title>');
    expect((await app.inject('/api/runs/' + runId + '/plan-files/plan.json')).json().nodes[0].deliverables[0].path).toBe('index.html');
    const delivery = await app.inject('/api/runs/' + runId + '/output');
    expect(delivery.statusCode).toBe(200);
    expect(delivery.rawPayload.subarray(0, 2).toString()).toBe('PK');
    expect(git(root, 'status', '--porcelain')).toBe('');

    const reloaded = await RunStore.open(logPath);
    expect(reloaded.snapshot.runs[runId]?.workspaceRoot).toBe(root);
    await vi.waitFor(async () => {
      expect((await app.inject({ method: 'DELETE', url: '/api/runs/' + runId })).statusCode).toBe(200);
    }, { timeout: 5000, interval: 35 });
    expect(await readFile(join(root, 'original.txt'), 'utf8')).toBe('属于用户的原文件');
    expect(await readdir(projectRun).catch(() => null)).toBeNull();
    expect(git(root, 'branch', '--list', 'run/' + runId)).toBe('');
    expect((await RunStore.open(logPath)).snapshot.runs[runId]).toBeUndefined();
    expect((await app.inject('/api/runs/' + runId)).statusCode).toBe(404);
  }, 45_000);
});

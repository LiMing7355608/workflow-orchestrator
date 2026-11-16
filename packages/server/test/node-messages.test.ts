import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { AgentProfile, OrchestratorEvent, RunFacts } from '@orchestrator/core';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app';
import type { RunStore } from '../src/store';

/**
 * 节点会话接口：`POST /api/runs/:id/nodes/:nodeId/messages`。
 *
 * 走真的 `buildApp` + `app.inject`，并且真的把执行跑起来：这个接口的价值全在
 * 「消息、打断、重跑这三件事有没有按那个顺序落成事实」上，只断言状态码的话，
 * 一条语义都测不到。
 *
 * 两条分支的判据是「节点现在有没有在跑」，所以这里必须真的造出「正在执行」
 * 那个窗口——用回放器（`AGENT_RUNNER=mock`）时它会在产出点之间各等 120ms，
 * 足够我们插进去说一句话。
 */

const RUN_ID = 'run-node-messages';
const AT = '2026-11-16T00:00:00.000Z';

/** 回放器不启动进程，`bin` 只需要能被探测到。 */
const MOCK_AGENT: AgentProfile = {
  id: 'mock-agent',
  label: '回放执行器',
  vendor: 'local',
  logo: '',
  launch: { bin: 'node', args: ['-p', '{prompt}'], stdin: true, parser: 'plain' },
  capabilities: { streaming: true, structured: false, resume: false, tools: false },
  availability: 'ready',
  enabled: true,
  permissionArgs: {
    default: [],
    'accept-edits': [],
    auto: [],
    'bypass-permissions': [],
  },
  session: { derive: 'none', resumeArgs: [] },
  timeoutMs: 30_000,
};

/**
 * 三个节点的图：两个串起来的实现节点，外加一个已经发起、正等着人的审批节点。
 *
 * 审批节点给 `startedAt` 就够了——真实的 `approval.requested` 也是这么写的，
 * 而「它有没有 startedAt」正是 `deriveNodeStatus` 判 waiting_approval 的依据。
 */
function buildRun(runId: string): RunFacts {
  return {
    id: runId,
    title: '节点会话测试',
    summary: '',
    goal: '验证节点的插话、打断与重跑',
    workspaceRoot: '/tmp/target-repo',
    specVersion: 'v1.0',
    stage: 'execute',
    createdAt: AT,
    nodeOrder: ['impl-a', 'impl-b', 'approval-a'],
    nodes: {
      'impl-a': {
        id: 'impl-a',
        type: 'implement',
        title: '实现 A',
        description: '',
        dependsOn: [],
        files: [],
        agentId: MOCK_AGENT.id,
        attempts: 0,
        maxAttempts: 3,
      },
      'impl-b': {
        id: 'impl-b',
        type: 'implement',
        title: '实现 B',
        description: '',
        dependsOn: ['impl-a'],
        files: [],
        agentId: MOCK_AGENT.id,
        attempts: 0,
        maxAttempts: 3,
      },
      'approval-a': {
        id: 'approval-a',
        type: 'approval',
        title: '范围确认',
        description: '',
        dependsOn: ['impl-a'],
        files: [],
        executor: '审批人',
        attempts: 0,
        maxAttempts: 3,
        // 审批已发起，正等人
        startedAt: AT,
      },
    },
  };
}

const tempDirs: string[] = [];
const originalEnv = {
  runner: process.env.AGENT_RUNNER,
  workspace: process.env.AGENT_WORKSPACE,
  artifactDir: process.env.AGENT_ARTIFACT_DIR,
  worktreeDir: process.env.AGENT_WORKTREE_DIR,
};

interface Fixture {
  app: FastifyInstance;
  store: RunStore;
  runId: string;
}

async function createFixture(options: { seed?: boolean } = {}): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), 'orchestrator-node-messages-'));
  tempDirs.push(root);
  process.env.AGENT_ARTIFACT_DIR = join(root, 'artifacts');
  // 必须在 buildApp 之前设置：执行器与工作区都是在那里面按 env 选型的
  process.env.AGENT_RUNNER = 'mock';
  process.env.AGENT_WORKSPACE = 'temp';
  process.env.AGENT_WORKTREE_DIR = join(root, 'worktrees');

  const { app, store } = await buildApp({
    logPath: join(root, 'events.jsonl'),
    catalog: [MOCK_AGENT],
    logger: false,
  });
  await app.ready();

  if (options.seed !== false) {
    await store.emit({ type: 'run.created', at: AT, runId: RUN_ID, run: buildRun(RUN_ID) });
    await store.emit({ type: 'run.frozen', at: AT, runId: RUN_ID });
  }

  return { app, store, runId: RUN_ID };
}

/** 轮询到条件成立；超时返回 undefined，让断言自己带出实际值。 */
async function waitFor<T>(
  probe: () => T | undefined,
  timeoutMs = 4_000,
): Promise<T | undefined> {
  const deadline = Date.now() + timeoutMs;
  let last: T | undefined;
  while (Date.now() < deadline) {
    last = probe();
    if (last !== undefined) {
      return last;
    }
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
  return last;
}

/** 让出若干毫秒：只在「等执行层的进程表里真的出现这个节点」时用。 */
function tick(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface NodeMessageBody {
  ok: boolean;
  interrupted: boolean;
  reply: string;
  run: {
    status: string;
    nodes: Array<{ id: string; status: string }>;
    nodeConversations: Record<string, Array<{ role: string; text: string; interrupt?: boolean }>>;
  };
  conversation: Array<{ role: string; text: string; interrupt?: boolean; tone?: string }>;
}

/** 取这个节点在事件流里的消息事件。 */
function nodeMessages(
  store: RunStore,
  runId: string,
  nodeId: string,
): Array<Extract<OrchestratorEvent, { type: 'node.message' }>> {
  return store
    .eventsForRun(runId)
    .filter(
      (event): event is Extract<OrchestratorEvent, { type: 'node.message' }> =>
        event.type === 'node.message' && event.nodeId === nodeId,
    );
}

/** 某个节点落了几次 `node.started`：这是「它真的被重跑了一遍」最硬的证据。 */
function startCount(store: RunStore, runId: string, nodeId: string): number {
  return store
    .eventsForRun(runId)
    .filter((event) => event.type === 'node.started' && event.nodeId === nodeId).length;
}

afterEach(async () => {
  const restore = (name: string, value: string | undefined): void => {
    if (value === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = value;
    }
  };
  restore('AGENT_RUNNER', originalEnv.runner);
  restore('AGENT_WORKSPACE', originalEnv.workspace);
  restore('AGENT_ARTIFACT_DIR', originalEnv.artifactDir);
  restore('AGENT_WORKTREE_DIR', originalEnv.worktreeDir);

  await Promise.all(
    tempDirs.splice(0).map((dir) =>
      rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(
        () => {},
      ),
    ),
  );
});

describe('POST /api/runs/:id/nodes/:nodeId/messages：节点在跑', () => {
  it('先杀进程、再落消息与打断，然后按新要求重跑这个节点', async () => {
    const { app, runId, store } = await createFixture();

    // 用整轮推进把节点跑起来：这条路径同样要能被一句话打断
    const advancing = app.inject({ method: 'POST', url: `/api/runs/${runId}/advance` });
    await waitFor(() => store.snapshot.runs[runId]?.nodes['impl-a']?.startedAt);
    // 让执行层真的把进程（这里是回放单元）登记进表：cancel 只对已经登记的生効
    await tick(30);

    const response = await app.inject({
      method: 'POST',
      url: `/api/runs/${runId}/nodes/impl-a/messages`,
      payload: { text: '别用 vue，改成 react' },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json() as NodeMessageBody;
    expect(body.ok).toBe(true);
    expect(body.interrupted).toBe(true);
    expect(body.reply).toContain('已打断');

    await advancing;

    // 一、进程真的被取消了：回放器在下个产出点收尾，并写下这一行
    const cancelledOutputs = store
      .eventsForRun(runId)
      .filter(
        (event) =>
          event.type === 'agent.output' &&
          event.nodeId === 'impl-a' &&
          event.chunk.includes('回放已取消'),
      );
    expect(cancelledOutputs).toHaveLength(1);

    // 二、打断事实落盘，并且原因里带出那句原话（排障要能回答「哪句话打断了它」）
    const interrupted = store
      .eventsForRun(runId)
      .filter(
        (event): event is Extract<OrchestratorEvent, { type: 'node.interrupted' }> =>
          event.type === 'node.interrupted' && event.nodeId === 'impl-a',
      );
    expect(interrupted).toHaveLength(1);
    expect(interrupted[0]?.reason).toContain('用户打断并给出了新要求');
    expect(interrupted[0]?.reason).toContain('别用 vue');

    // 三、两条消息：人说的带 interrupt，回执不带
    const messages = nodeMessages(store, runId, 'impl-a');
    expect(messages.map((item) => item.role)).toEqual(['user', 'agent']);
    expect(messages[0]?.text).toBe('别用 vue，改成 react');
    expect(messages[0]?.interrupt).toBe(true);
    expect(messages[1]?.interrupt).toBeUndefined();

    // 四、节点被重跑：started 落了两次，且最终跑完
    expect(startCount(store, runId, 'impl-a')).toBe(2);
    expect(store.snapshot.runs[runId]?.nodes['impl-a']?.finishedAt).toBeDefined();
    expect(store.snapshot.runs[runId]?.nodes['impl-a']?.failureReason).toBeUndefined();

    // 五、响应里带回节点会话，前端不必再拉一次
    expect(body.conversation.map((entry) => entry.role)).toContain('user');
    expect(
      body.conversation.some(
        (entry) => entry.role === 'user' && entry.interrupt === true,
      ),
    ).toBe(true);
    expect(body.run.nodeConversations['impl-a']?.length).toBeGreaterThan(0);

    await app.close();
  });

  it('消息先落、打断紧随其后、回执最后：这个顺序不能被反过来', async () => {
    const { app, runId, store } = await createFixture();

    const advancing = app.inject({ method: 'POST', url: `/api/runs/${runId}/advance` });
    await waitFor(() => store.snapshot.runs[runId]?.nodes['impl-a']?.startedAt);
    await tick(30);

    await app.inject({
      method: 'POST',
      url: `/api/runs/${runId}/nodes/impl-a/messages`,
      payload: { text: '这个文件别动：src/db/**' },
    });
    await advancing;

    const sequence = store
      .eventsForRun(runId)
      .filter(
        (event) =>
          (event.type === 'node.message' || event.type === 'node.interrupted') &&
          'nodeId' in event &&
          event.nodeId === 'impl-a',
      )
      .map((event) => event.type);

    // 消息在前、打断在后：反过来的话，中间那个窗口里「消息说打断了、
    // 进程其实还在跑」，而这一轮写下的每个字都还是按旧要求来的
    expect(sequence).toEqual(['node.message', 'node.interrupted', 'node.message']);

    await app.close();
  });
});

describe('POST /api/runs/:id/nodes/:nodeId/messages：节点没在跑', () => {
  it('只落消息，绝不触发执行', async () => {
    const { app, runId, store } = await createFixture();

    const response = await app.inject({
      method: 'POST',
      url: `/api/runs/${runId}/nodes/impl-a/messages`,
      payload: { text: '这个文件别动：src/db/**' },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json() as NodeMessageBody;
    expect(body.ok).toBe(true);
    // 不自动重跑：人可能只是在留个话，或者想先看看上一轮的产物
    expect(body.interrupted).toBe(false);
    expect(body.reply).toContain('下次运行该节点时');
    expect(body.reply).toContain('运行此节点');

    const messages = nodeMessages(store, runId, 'impl-a');
    expect(messages.map((item) => item.role)).toEqual(['user', 'agent']);
    expect(messages[0]?.interrupt).toBeUndefined();
    // 一次执行都没被派发
    expect(startCount(store, runId, 'impl-a')).toBe(0);
    expect(store.snapshot.runs[runId]?.nodes['impl-a']?.startedAt).toBeUndefined();

    await app.close();
  });

  it('等人工审批的节点不会被当成「在跑」而掐掉审批', async () => {
    const { app, runId, store } = await createFixture();

    const response = await app.inject({
      method: 'POST',
      url: `/api/runs/${runId}/nodes/approval-a/messages`,
      payload: { text: '范围先按最小可用来' },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json() as NodeMessageBody;
    // 它有 startedAt、没有 finishedAt，但没有任何 Agent 进程：真去打断会把
    // 节点从「待你审批」变回「就绪」，审批还在，界面却不再问人了
    expect(body.interrupted).toBe(false);
    expect(body.reply).toContain('审批');
    expect(store.snapshot.runs[runId]?.nodes['approval-a']?.startedAt).toBe(AT);
    expect(
      body.run.nodes.find((node) => node.id === 'approval-a')?.status,
    ).toBe('waiting_approval');

    await app.close();
  });
});

describe('POST /api/runs/:id/nodes/:nodeId/messages：入参与目标校验', () => {
  it('运行不存在时 404 run_not_found', async () => {
    const { app } = await createFixture({ seed: false });

    const response = await app.inject({
      method: 'POST',
      url: '/api/runs/run-ghost/nodes/impl-a/messages',
      payload: { text: '随便说一句' },
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: 'run_not_found' });

    await app.close();
  });

  it('节点不存在时 404 node_not_found', async () => {
    const { app, runId } = await createFixture();

    const response = await app.inject({
      method: 'POST',
      url: `/api/runs/${runId}/nodes/impl-ghost/messages`,
      payload: { text: '随便说一句' },
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: 'node_not_found' });

    await app.close();
  });

  it('空消息 400，不落任何事实', async () => {
    const { app, runId, store } = await createFixture();
    const before = store.eventsForRun(runId).length;

    const response = await app.inject({
      method: 'POST',
      url: `/api/runs/${runId}/nodes/impl-a/messages`,
      payload: { text: '   ' },
    });

    expect(response.statusCode).toBe(400);
    expect(store.eventsForRun(runId)).toHaveLength(before);

    await app.close();
  });
});

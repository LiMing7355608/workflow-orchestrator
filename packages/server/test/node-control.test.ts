import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { AgentProfile, RunFacts } from '@orchestrator/core';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app';
import type { RunStore } from '../src/store';

/**
 * 节点级控制接口：单跑 / 停止 / 重置。
 *
 * 走真的 `buildApp` + `app.inject`，并且真的把执行跑起来：这三个接口的价值
 * 全在「节点事实最后变成了什么」上，只断言状态码的话，一条语义都测不到。
 *
 * 执行器用 `AGENT_RUNNER=mock`（回放器不启动进程），工作区用
 * `AGENT_WORKSPACE=temp`（不碰仓库里的 worktree）。
 */

const RUN_ID = 'run-node-control';
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
 * 两个实现节点串成一条链：单跑要能绕过这条链，重置要能作废下游，
 * 都需要「上游 / 下游」这层结构。
 */
function buildRun(runId: string): RunFacts {
  return {
    id: runId,
    title: '节点级控制接口测试',
    summary: '',
    goal: '验证单个节点的运行、停止与重置',
    workspaceRoot: '/tmp/target-repo',
    specVersion: 'v1.0',
    stage: 'execute',
    createdAt: AT,
    nodeOrder: ['impl-a', 'impl-b'],
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
  const root = await mkdtemp(join(tmpdir(), 'orchestrator-node-control-'));
  tempDirs.push(root);
  process.env.AGENT_ARTIFACT_DIR = join(root, 'artifacts');
  // 必须在 buildApp 之前设置：执行器与工作区都是在那里面按 env 选型的
  process.env.AGENT_RUNNER = 'mock';
  process.env.AGENT_WORKSPACE = 'temp';
  // 节点目录落在本次用例的临时根下：不写进仓库的 data/worktrees
  process.env.AGENT_WORKTREE_DIR = join(root, 'worktrees');

  const { app, store } = await buildApp({
    logPath: join(root, 'events.jsonl'),
    // 只放回放器这一个 Agent：探测结果与开发者本机装了什么无关
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

interface NodeControlBody {
  ok: boolean;
  cancelled?: boolean;
  resetNodes?: number;
  invalidatedNodes?: number;
  run: {
    status: string;
    nodes: Array<{ id: string; status: string; attempts: number }>;
  };
}

afterEach(async () => {
  if (originalEnv.runner === undefined) {
    delete process.env.AGENT_RUNNER;
  } else {
    process.env.AGENT_RUNNER = originalEnv.runner;
  }
  if (originalEnv.workspace === undefined) {
    delete process.env.AGENT_WORKSPACE;
  } else {
    process.env.AGENT_WORKSPACE = originalEnv.workspace;
  }
  if (originalEnv.artifactDir === undefined) {
    delete process.env.AGENT_ARTIFACT_DIR;
  } else {
    process.env.AGENT_ARTIFACT_DIR = originalEnv.artifactDir;
  }
  if (originalEnv.worktreeDir === undefined) {
    delete process.env.AGENT_WORKTREE_DIR;
  } else {
    process.env.AGENT_WORKTREE_DIR = originalEnv.worktreeDir;
  }

  await Promise.all(
    tempDirs.splice(0).map((dir) =>
      rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(
        () => {},
      ),
    ),
  );
});

describe('POST /api/runs/:id/nodes/:nodeId/run', () => {
  it('运行或节点不存在时分别 404', async () => {
    const { app } = await createFixture({ seed: false });

    const missingRun = await app.inject({
      method: 'POST',
      url: '/api/runs/run-ghost/nodes/impl-a/run',
    });
    expect(missingRun.statusCode).toBe(404);
    expect(missingRun.json()).toEqual({ error: 'run_not_found' });

    await app.close();
  });

  it('节点不存在时 404 node_not_found', async () => {
    const { app, runId } = await createFixture();

    const response = await app.inject({
      method: 'POST',
      url: `/api/runs/${runId}/nodes/impl-ghost/run`,
    });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: 'node_not_found' });

    await app.close();
  });

  it('单跑一个节点并同步返回它已完成', async () => {
    const { app, runId } = await createFixture();

    const response = await app.inject({
      method: 'POST',
      url: `/api/runs/${runId}/nodes/impl-a/run`,
    });

    expect(response.statusCode).toBe(200);
    const body = response.json() as NodeControlBody;
    expect(body.ok).toBe(true);
    expect(body.run.nodes.find((node) => node.id === 'impl-a')?.status).toBe(
      'completed',
    );

    await app.close();
  });

  it('不检查依赖：上游没跑也能单跑下游', async () => {
    const { app, runId } = await createFixture();

    const response = await app.inject({
      method: 'POST',
      url: `/api/runs/${runId}/nodes/impl-b/run`,
    });

    expect(response.statusCode).toBe(200);
    const body = response.json() as NodeControlBody;
    expect(body.run.nodes.find((node) => node.id === 'impl-b')?.status).toBe(
      'completed',
    );
    // 上游一次都没被派发：单跑是覆盖调度顺序的显式指令。
    // 它的状态是 ready 而不是 pending——依赖为空，只是没人跑过它。
    expect(body.run.nodes.find((node) => node.id === 'impl-a')?.status).toBe(
      'ready',
    );

    await app.close();
  });

  it('同一节点正在跑时再发一次，409 node_running', async () => {
    const { app, runId, store } = await createFixture();

    // 不 await：请求还在跑，第二发才会撞上互斥标记
    const first = app.inject({
      method: 'POST',
      url: `/api/runs/${runId}/nodes/impl-a/run`,
    });

    await waitFor(() => store.snapshot.runs[runId]?.nodes['impl-a']?.startedAt);

    const second = await app.inject({
      method: 'POST',
      url: `/api/runs/${runId}/nodes/impl-a/run`,
    });
    expect(second.statusCode).toBe(409);
    const failure = second.json() as { error: string; message: string };
    expect(failure.error).toBe('node_running');
    // 消息必须解释「为什么现在不行」，不能只是一个错误码
    expect(failure.message).toContain('正在执行');

    expect((await first).statusCode).toBe(200);
    // 跑完之后标记被撤销，于是可以再跑一次
    const third = await app.inject({
      method: 'POST',
      url: `/api/runs/${runId}/nodes/impl-a/run`,
    });
    expect(third.statusCode).toBe(200);

    await app.close();
  });
});

describe('POST /api/runs/:id/nodes/:nodeId/stop', () => {
  it('运行或节点不存在时分别 404', async () => {
    const { app, runId } = await createFixture({ seed: false });

    const missingRun = await app.inject({
      method: 'POST',
      url: '/api/runs/run-ghost/nodes/impl-a/stop',
    });
    expect(missingRun.statusCode).toBe(404);

    const seeded = await createFixture();
    const missingNode = await seeded.app.inject({
      method: 'POST',
      url: `/api/runs/${seeded.runId}/nodes/impl-ghost/stop`,
    });
    expect(missingNode.statusCode).toBe(404);
    expect(missingNode.json()).toEqual({ error: 'node_not_found' });

    await app.close();
    await seeded.app.close();
  });

  it('没有进程在跑时 cancelled 为 false，不编造终止数量', async () => {
    const { app, runId } = await createFixture();

    const response = await app.inject({
      method: 'POST',
      url: `/api/runs/${runId}/nodes/impl-a/stop`,
    });

    expect(response.statusCode).toBe(200);
    const body = response.json() as NodeControlBody;
    expect(body.ok).toBe(true);
    expect(body.cancelled).toBe(false);
    /**
     * 没有节点在跑 = 整体停止。
     *
     * 这条原来断言 `running`，理由是「节点级停止不改整轮状态」。但它们并不
     * 矛盾：这里改的不是 `pausedAt` 那条事实，而是**派生**——没有任何节点
     * 在跑的时候再自称运行中，就是在骗人（界面说在跑，实际一个 Agent 都
     * 没起来）。用户定的规则是「所有节点停止，那就整体停止」。
     */
    expect(body.run.status).toBe('paused');

    await app.close();
  });

  it('停掉正在跑的节点：确认终止，节点落成可恢复的中断', async () => {
    const { app, runId, store } = await createFixture();

    // 用整轮推进把节点跑起来（节点级停止同样要能停它）
    const advancing = app.inject({ method: 'POST', url: `/api/runs/${runId}/advance` });
    await waitFor(() => store.snapshot.runs[runId]?.nodes['impl-a']?.startedAt);

    const stopped = await app.inject({
      method: 'POST',
      url: `/api/runs/${runId}/nodes/impl-a/stop`,
    });

    expect(stopped.statusCode).toBe(200);
    const body = stopped.json() as NodeControlBody;
    // 回放器的 cancel 是确认过的：它真的会在下一个产出点收尾
    expect(body.cancelled).toBe(true);

    await advancing;

    const facts = store.snapshot.runs[runId]?.nodes['impl-a'];
    // 被打断不是失败：failureReason 必须缺省，interruptedAt 才该有值
    expect(facts?.failureReason).toBeUndefined();
    expect(facts?.interruptedAt).toBeDefined();

    await app.close();
  });
});

describe('POST /api/runs/:id/nodes/:nodeId/reset', () => {
  it('运行或节点不存在时分别 404', async () => {
    const { app } = await createFixture({ seed: false });

    const missingRun = await app.inject({
      method: 'POST',
      url: '/api/runs/run-ghost/nodes/impl-a/reset',
    });
    expect(missingRun.statusCode).toBe(404);

    const seeded = await createFixture();
    const missingNode = await seeded.app.inject({
      method: 'POST',
      url: `/api/runs/${seeded.runId}/nodes/impl-ghost/reset`,
    });
    expect(missingNode.statusCode).toBe(404);
    expect(missingNode.json()).toEqual({ error: 'node_not_found' });

    await app.close();
    await seeded.app.close();
  });

  it('重置已完成的节点后它回到可运行状态，且能再跑一次', async () => {
    const { app, runId } = await createFixture();

    await app.inject({ method: 'POST', url: `/api/runs/${runId}/nodes/impl-a/run` });

    // body 可以完全为空：重置没有参数
    const reset = await app.inject({
      method: 'POST',
      url: `/api/runs/${runId}/nodes/impl-a/reset`,
    });

    expect(reset.statusCode).toBe(200);
    const body = reset.json() as NodeControlBody;
    expect(body.ok).toBe(true);
    expect(body.resetNodes).toBeGreaterThanOrEqual(1);

    const node = body.run.nodes.find((item) => item.id === 'impl-a');
    // 执行事实被清空 → 回到就绪（依赖为空），attempts 记一次退回
    expect(node?.status).toBe('ready');
    expect(node?.attempts).toBe(1);

    // 「可重跑」不是靠状态值猜的，而是真的再跑一遍
    const rerun = await app.inject({
      method: 'POST',
      url: `/api/runs/${runId}/nodes/impl-a/run`,
    });
    expect(rerun.statusCode).toBe(200);
    const rerunBody = rerun.json() as NodeControlBody;
    expect(rerunBody.run.nodes.find((item) => item.id === 'impl-a')?.status).toBe(
      'completed',
    );

    await app.close();
  });

  it('重置上游会把已跑完的下游一并作废，并在响应里报出数量', async () => {
    const { app, runId } = await createFixture();

    // 整轮跑到头：impl-a → impl-b 都完成
    const advanced = await app.inject({
      method: 'POST',
      url: `/api/runs/${runId}/advance`,
    });
    expect(advanced.statusCode).toBe(200);
    // `/advance` 直接回运行详情，不是 { ok, run } 那个包装
    const before = advanced.json() as NodeControlBody['run'];
    expect(before.nodes.every((node) => node.status === 'completed')).toBe(true);

    const reset = await app.inject({
      method: 'POST',
      url: `/api/runs/${runId}/nodes/impl-a/reset`,
    });
    expect(reset.statusCode).toBe(200);
    const body = reset.json() as NodeControlBody;
    // 目标 + 一个已完成的下游
    expect(body.resetNodes).toBe(2);
    expect(body.invalidatedNodes).toBe(1);

    expect(body.run.nodes.find((node) => node.id === 'impl-a')?.status).toBe('ready');
    // 下游回到 pending：它的上游已经不再是已完成状态
    expect(body.run.nodes.find((node) => node.id === 'impl-b')?.status).toBe(
      'pending',
    );

    await app.close();
  });

  it('节点正在跑时 409，不会把重新开始的事实抹掉', async () => {
    const { app, runId, store } = await createFixture();

    const advancing = app.inject({ method: 'POST', url: `/api/runs/${runId}/advance` });
    await waitFor(() => store.snapshot.runs[runId]?.nodes['impl-a']?.startedAt);

    const reset = await app.inject({
      method: 'POST',
      url: `/api/runs/${runId}/nodes/impl-a/reset`,
    });
    expect(reset.statusCode).toBe(409);
    const failure = reset.json() as { error: string; message: string };
    expect(failure.error).toBe('node_running');
    expect(failure.message).toContain('正在执行');

    // 收尾：停止整轮推进，让那条 fire-and-forget 的链路结束
    await app.inject({ method: 'POST', url: `/api/runs/${runId}/stop` });
    await advancing;

    await app.close();
  });
});

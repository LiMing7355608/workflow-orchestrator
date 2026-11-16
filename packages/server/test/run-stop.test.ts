import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { RunFacts } from '@orchestrator/core';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app';
import type { RunStore } from '../src/store';

/**
 * 停止 / 继续接口。
 *
 * 走真的 `buildApp` + `app.inject`：这里要验的是状态码与派生出来的
 * 运行状态，只有经过真实路由与 projection 才测得到。
 *
 * 执行层刻意留成空档：节点声明的 agentId 在空目录里查不到，于是 resume
 * 之后的推进会在工作区准备之前就判定「找不到可用的 Agent」——测试因此
 * 不会拉起真实进程，也不会去动仓库里的 worktree。
 */

const RUN_ID = 'run-stop-api';
const AT = '2026-11-16T00:00:00.000Z';

const tempDirs: string[] = [];
const originalArtifactDir = process.env.AGENT_ARTIFACT_DIR;
const originalWorktreeDir = process.env.AGENT_WORKTREE_DIR;

/** 一条已经冻结、可以推进的运行。 */
function buildRun(runId: string): RunFacts {
  return {
    id: runId,
    title: '停止接口测试',
    summary: '',
    goal: '验证强制停止与继续',
    workspaceRoot: '/tmp/target-repo',
    specVersion: 'v1.0',
    stage: 'execute',
    createdAt: AT,
    nodeOrder: ['impl-a', 'approval-a'],
    nodes: {
      'impl-a': {
        id: 'impl-a',
        type: 'implement',
        title: '实现',
        description: '',
        dependsOn: [],
        files: [],
        agentId: 'ghost-agent',
        attempts: 0,
        maxAttempts: 3,
      },
      'approval-a': {
        id: 'approval-a',
        type: 'approval',
        title: '人工审批',
        description: '',
        dependsOn: ['impl-a'],
        files: [],
        executor: '审批人',
        attempts: 0,
        maxAttempts: 3,
      },
    },
  };
}

interface Fixture {
  app: FastifyInstance;
  store: RunStore;
  runId: string;
}

async function createFixture(options: { seed?: boolean } = {}): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), 'orchestrator-stop-'));
  tempDirs.push(root);
  process.env.AGENT_ARTIFACT_DIR = join(root, 'artifacts');
  // 节点目录落在临时根下：prepare 会先 mkdir 再调 git，失败也会留下空目录
  process.env.AGENT_WORKTREE_DIR = join(root, 'worktrees');

  const { app, store } = await buildApp({
    logPath: join(root, 'events.jsonl'),
    // 空目录：不探测本机装了什么，测试结果与开发者机器无关
    catalog: [],
    logger: false,
  });
  await app.ready();

  if (options.seed !== false) {
    await store.emit({ type: 'run.created', at: AT, runId: RUN_ID, run: buildRun(RUN_ID) });
    await store.emit({ type: 'run.frozen', at: AT, runId: RUN_ID });
  }

  return { app, store, runId: RUN_ID };
}

/** 让 resume 之后那条 fire-and-forget 的推进链路收尾，再关应用。 */
async function settle(ms = 60): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

afterEach(async () => {
  if (originalArtifactDir === undefined) {
    delete process.env.AGENT_ARTIFACT_DIR;
  } else {
    process.env.AGENT_ARTIFACT_DIR = originalArtifactDir;
  }
  if (originalWorktreeDir === undefined) {
    delete process.env.AGENT_WORKTREE_DIR;
  } else {
    process.env.AGENT_WORKTREE_DIR = originalWorktreeDir;
  }

  await Promise.all(
    tempDirs.splice(0).map((dir) =>
      rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(
        () => {},
      ),
    ),
  );
});

describe('POST /api/runs/:id/stop', () => {
  it('运行不存在时 404', async () => {
    const { app } = await createFixture({ seed: false });

    const response = await app.inject({
      method: 'POST',
      url: '/api/runs/run-ghost/stop',
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: 'run_not_found' });

    await app.close();
  });

  it('停止后返回实际终止数量与派生状态，运行随即变成 paused', async () => {
    const { app, runId } = await createFixture();

    // 动手之前先确认它确实是 running：否则「变成 paused」毫无信息量
    const before = await app.inject({ method: 'GET', url: `/api/runs/${runId}` });
    expect((before.json() as { status: string }).status).toBe('running');

    const response = await app.inject({
      method: 'POST',
      url: `/api/runs/${runId}/stop`,
    });

    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      ok: boolean;
      cancelledAgents: number;
      status: string;
    };
    expect(body.ok).toBe(true);
    // 没有进程在跑时数量必须是 0——不能为了好看编一个数出来
    expect(body.cancelledAgents).toBe(0);
    expect(body.status).toBe('paused');

    const after = await app.inject({ method: 'GET', url: `/api/runs/${runId}` });
    expect((after.json() as { status: string }).status).toBe('paused');

    await app.close();
  });

  it('重复停止是幂等的，不会报错也不会改变结论', async () => {
    const { app, runId } = await createFixture();

    const first = await app.inject({ method: 'POST', url: `/api/runs/${runId}/stop` });
    const second = await app.inject({ method: 'POST', url: `/api/runs/${runId}/stop` });

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect((second.json() as { status: string }).status).toBe('paused');

    await app.close();
  });

  it('待人工审批的运行停止后是 paused，而不是继续显示「待你处理」', async () => {
    const { app, store, runId } = await createFixture();

    // 造一条「审批在等人」的运行：这是停止按钮必须同样可用的状态
    await store.emit({
      type: 'approval.requested',
      at: AT,
      runId,
      record: {
        id: 'ap-test-1',
        runId,
        nodeId: 'approval-a',
        status: 'pending',
        requestedAt: AT,
      },
    });

    const waiting = await app.inject({ method: 'GET', url: `/api/runs/${runId}` });
    expect((waiting.json() as { status: string }).status).toBe('waiting_for_boss');

    const stopped = await app.inject({
      method: 'POST',
      url: `/api/runs/${runId}/stop`,
    });
    expect(stopped.statusCode).toBe(200);
    // 停止是编排器不再推进的事实，它必须压过「在等你审批」的显示
    expect((stopped.json() as { status: string }).status).toBe('paused');

    // 再继续：暂停事实被清掉，审批仍在等，于是回到 waiting_for_boss
    await app.inject({ method: 'POST', url: `/api/runs/${runId}/resume` });
    const resumed = await app.inject({ method: 'GET', url: `/api/runs/${runId}` });
    expect((resumed.json() as { status: string }).status).toBe('waiting_for_boss');

    await settle();
    await app.close();
  });
});

describe('POST /api/runs/:id/resume', () => {
  it('停止之后再继续，状态回到 running', async () => {
    const { app, runId } = await createFixture();

    await app.inject({ method: 'POST', url: `/api/runs/${runId}/stop` });

    const paused = await app.inject({ method: 'GET', url: `/api/runs/${runId}` });
    expect((paused.json() as { status: string }).status).toBe('paused');

    const resumed = await app.inject({
      method: 'POST',
      url: `/api/runs/${runId}/resume`,
    });
    expect(resumed.statusCode).toBe(200);
    expect(resumed.json()).toEqual({ ok: true });

    const after = await app.inject({ method: 'GET', url: `/api/runs/${runId}` });
    expect((after.json() as { status: string }).status).toBe('running');

    await settle();
    await app.close();
  });

  it('运行不存在时 404', async () => {
    const { app } = await createFixture({ seed: false });

    const response = await app.inject({
      method: 'POST',
      url: '/api/runs/run-ghost/resume',
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: 'run_not_found' });

    await app.close();
  });
});

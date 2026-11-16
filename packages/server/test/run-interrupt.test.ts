import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { AgentProfile, RunFacts } from '@orchestrator/core';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app';
import type { RunStore } from '../src/store';

/**
 * 「停止 → 继续」在 HTTP 层的完整链路。
 *
 * 这里走真的 `buildApp` + `app.inject`，并且真的把一次推进跑起来：要验的是
 * 停止之后节点的**持久事实**（不是 failed、而是可恢复的中断），以及继续之后
 * 它会不会被重新派发。只断言接口返回码的话，这条回归一条都测不到。
 *
 * 执行器用 `AGENT_RUNNER=mock`（回放器不启动任何进程），工作区用
 * `AGENT_WORKSPACE=temp`（不碰仓库里的 worktree）。两者都在本文件内设置并恢复。
 */

const RUN_ID = 'run-interrupt-api';
const AT = '2026-11-16T00:00:00.000Z';

/** 回放器不启动进程，所以 `bin` 只需要能被探测到，取值不影响结论。 */
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

const tempDirs: string[] = [];
const originalEnv = {
  runner: process.env.AGENT_RUNNER,
  workspace: process.env.AGENT_WORKSPACE,
  artifactDir: process.env.AGENT_ARTIFACT_DIR,
  worktreeDir: process.env.AGENT_WORKTREE_DIR,
};

function buildRun(runId: string): RunFacts {
  return {
    id: runId,
    title: '中断语义接口测试',
    summary: '',
    goal: '验证停止之后继续能让被中断的节点接着跑',
    workspaceRoot: '/tmp/target-repo',
    specVersion: 'v1.0',
    stage: 'execute',
    createdAt: AT,
    nodeOrder: ['impl-a'],
    nodes: {
      'impl-a': {
        id: 'impl-a',
        type: 'implement',
        title: '实现',
        description: '',
        dependsOn: [],
        files: [],
        agentId: MOCK_AGENT.id,
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

async function createFixture(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), 'orchestrator-interrupt-'));
  tempDirs.push(root);
  process.env.AGENT_ARTIFACT_DIR = join(root, 'artifacts');
  // 必须在 buildApp 之前设置：执行器与工作区都是在那里面按 env 选型的
  process.env.AGENT_RUNNER = 'mock';
  process.env.AGENT_WORKSPACE = 'temp';
  // 节点目录落在本次用例的临时根下：既不写进开发者自己的 data/worktrees，
  // 也能跟着 tempDirs 一起清干净
  process.env.AGENT_WORKTREE_DIR = join(root, 'worktrees');

  const { app, store } = await buildApp({
    logPath: join(root, 'events.jsonl'),
    // 只放回放器这一个 Agent：探测结果与开发者本机装了什么无关
    catalog: [MOCK_AGENT],
    logger: false,
  });
  await app.ready();

  await store.emit({ type: 'run.created', at: AT, runId: RUN_ID, run: buildRun(RUN_ID) });
  await store.emit({ type: 'run.frozen', at: AT, runId: RUN_ID });

  return { app, store, runId: RUN_ID };
}

/** 轮询到条件成立；超时返回 undefined，让断言自己去失败并带出实际值。 */
async function waitFor<T>(
  probe: () => Promise<T | undefined> | T | undefined,
  timeoutMs = 4_000,
): Promise<T | undefined> {
  const deadline = Date.now() + timeoutMs;
  let last: T | undefined;
  while (Date.now() < deadline) {
    last = await probe();
    if (last !== undefined) {
      return last;
    }
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
  return last;
}

/** 读当前节点事实，供 waitFor 轮询。 */
const nodeFacts = (
  fixture: Fixture,
): (() => RunFacts['nodes'][string] | undefined) => {
  return () => fixture.store.snapshot.runs[RUN_ID]?.nodes['impl-a'];
};

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

describe('强制停止之后，被打断的节点是可恢复的中断', () => {
  it('节点落 interruptedAt 而不是 failureReason', async () => {
    const fixture = await createFixture();
    const { app } = fixture;

    // 把推进跑起来但不 await：要在节点执行中按下停止
    const advancing = app.inject({ method: 'POST', url: `/api/runs/${RUN_ID}/advance` });

    // 等它真的开始（否则 stop 会落在空档上，cancel 数量为 0，什么都没打断）
    const started = await waitFor(() => nodeFacts(fixture)()?.startedAt);
    expect(started).toBeDefined();

    const stopped = await app.inject({ method: 'POST', url: `/api/runs/${RUN_ID}/stop` });
    expect(stopped.statusCode).toBe(200);
    expect((stopped.json() as { cancelledAgents: number }).cancelledAgents).toBe(1);

    await advancing;

    // stop 会等 in-flight 的结算落盘，所以此刻读到的事实就是最终事实
    const facts = nodeFacts(fixture)();
    expect(facts?.failureReason).toBeUndefined();
    expect(facts?.interruptedAt).toBeDefined();
    // 这一轮的执行痕迹被清空：节点因此回到可调度状态
    expect(facts?.startedAt).toBeUndefined();
    expect(facts?.finishedAt).toBeUndefined();

    const detail = await app.inject({ method: 'GET', url: `/api/runs/${RUN_ID}` });
    const body = detail.json() as {
      nodes: Array<{ id: string; status: string; interruptedAt?: string }>;
    };
    const view = body.nodes.find((item) => item.id === 'impl-a');
    // 关键断言：不是 failed。以前这里是 failed，于是「继续」永远续不上。
    expect(view?.status).not.toBe('failed');
    expect(view?.status).toBe('ready');
    expect(view?.interruptedAt).toBeDefined();

    await app.close();
  });

  it('继续之后该节点被重新派发并跑到完成', async () => {
    const fixture = await createFixture();
    const { app } = fixture;

    const advancing = app.inject({ method: 'POST', url: `/api/runs/${RUN_ID}/advance` });
    await waitFor(() => nodeFacts(fixture)()?.startedAt);
    await app.inject({ method: 'POST', url: `/api/runs/${RUN_ID}/stop` });
    await advancing;

    expect(nodeFacts(fixture)()?.interruptedAt).toBeDefined();

    const resumed = await app.inject({ method: 'POST', url: `/api/runs/${RUN_ID}/resume` });
    expect(resumed.statusCode).toBe(200);

    // 等的是「整轮运行结束」，不是「节点写完 finishedAt」：节点完成后调度器还要
    // 再走一轮才会判定 isRunSettled 并落 run.completed。本机上这段间隔只有几毫秒，
    // CI 上会被放大，只等节点就会时不时读到 running。
    const settled = await waitFor(
      () => fixture.store.snapshot.runs[RUN_ID]?.completedAt,
      10_000,
    );
    expect(settled).toBeDefined();

    const facts = nodeFacts(fixture)();
    expect(facts?.failureReason).toBeUndefined();
    // 重新开始会把「待恢复」清掉：它已经不是「已停止」了
    expect(facts?.interruptedAt).toBeUndefined();

    const detail = await app.inject({ method: 'GET', url: `/api/runs/${RUN_ID}` });
    const body = detail.json() as {
      status: string;
      nodes: Array<{ id: string; status: string }>;
    };
    expect(body.nodes.find((item) => item.id === 'impl-a')?.status).toBe('completed');
    expect(body.status).toBe('completed');

    await app.close();
  });
});

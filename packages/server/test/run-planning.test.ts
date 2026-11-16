import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { AgentProfile, OrchestratorEvent } from '@orchestrator/core';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app';
import type { RunStore } from '../src/store';

/**
 * `POST /api/runs` 的异步拆解。
 *
 * 这条链路要验的不是「能不能建运行」，而是**建完之后多久返回**：拆解要真调
 * 一个 CLI Agent（实测 20–40 秒），请求挂在那里等，用户点完按钮看到的只有
 * 转圈。断言方式因此落在事件顺序上——响应拿回来那一刻，`run.frozen` 必须
 * 还不存在。同步实现下这条必然失败（返回时图早已冻结），所以它比计时更稳。
 *
 * 执行层用回放器 + 临时目录工作区：不启动任何真实进程，但整条「拆解 → 冻结
 * → 派发」的链路是真的走一遍。
 */

const tempDirs: string[] = [];
const originalEnv = {
  runner: process.env.AGENT_RUNNER,
  workspace: process.env.AGENT_WORKSPACE,
  artifact: process.env.AGENT_ARTIFACT_DIR,
  worktreeDir: process.env.AGENT_WORKTREE_DIR,
  plannerAgent: process.env.PLANNER_AGENT_ID,
};

/**
 * 两个「本机装好了」的 Agent。
 *
 * `bin` 指向 node：探测只看这个可执行文件能不能解析到，因此结果与开发机上
 * 装没装 claude / codex 无关。
 */
function agent(id: string): AgentProfile {
  return {
    id,
    label: id,
    vendor: 'test',
    logo: `/logos/${id}.svg`,
    launch: { bin: 'node', args: ['{prompt}'], stdin: false, parser: 'plain' },
    capabilities: { streaming: true, structured: true, resume: false, tools: true },
    availability: 'ready',
    enabled: true,
    permissionArgs: {
      default: [],
      'accept-edits': [],
      auto: [],
      'bypass-permissions': [],
    },
    session: { derive: 'none', resumeArgs: [] },
    timeoutMs: 60_000,
  };
}

/** 一份客户端自带的合法图：用来确认同步那条老路没有被这次改动带坏。 */
const HANDWRITTEN_DAG = {
  title: '手写图',
  summary: '客户端自带的任务图',
  specVersion: 'v1.0',
  nodes: [
    {
      id: 'impl-a',
      type: 'implement',
      title: '实现 A',
      description: '按目标实现',
      dependsOn: [],
      files: ['src/a/**'],
      agentId: 'claude',
      maxAttempts: 3,
    },
  ],
};

interface Fixture {
  app: FastifyInstance;
  store: RunStore;
}

async function createFixture(catalog?: AgentProfile[]): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), 'orchestrator-planning-'));
  tempDirs.push(root);

  process.env.AGENT_RUNNER = 'mock';
  process.env.AGENT_WORKSPACE = 'temp';
  process.env.AGENT_ARTIFACT_DIR = join(root, 'artifacts');
  // 拆解会真的 prepare 一个工作区（回放链路的 release 用的是另一套 runId，
  // 清不掉），所以必须指到临时根，否则仓库的 data/worktrees 会越积越多
  process.env.AGENT_WORKTREE_DIR = join(root, 'worktrees');
  delete process.env.PLANNER_AGENT_ID;

  const { app, store } = await buildApp({
    logPath: join(root, 'events.jsonl'),
    catalog: catalog ?? [agent('claude'), agent('codex')],
    logger: false,
  });
  await app.ready();

  return { app, store };
}

/** 轮询等一个条件成立。拆解是异步的，测试只能等它落到事实上。 */
async function waitFor<T>(
  probe: () => T | undefined,
  timeoutMs = 5_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = probe();
    if (value !== undefined) {
      return value;
    }
    if (Date.now() > deadline) {
      throw new Error('等待超时：条件始终没有成立');
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** 让 fire-and-forget 的推进链路收尾，再关应用。 */
async function settle(ms = 200): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

afterEach(async () => {
  const restore = (key: string, value: string | undefined): void => {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  };
  restore('AGENT_RUNNER', originalEnv.runner);
  restore('AGENT_WORKSPACE', originalEnv.workspace);
  restore('AGENT_ARTIFACT_DIR', originalEnv.artifact);
  restore('AGENT_WORKTREE_DIR', originalEnv.worktreeDir);
  restore('PLANNER_AGENT_ID', originalEnv.plannerAgent);

  await Promise.all(
    tempDirs.splice(0).map((dir) =>
      rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(
        () => {},
      ),
    ),
  );
});

function createRun(app: FastifyInstance, payload: Record<string, unknown>) {
  return app.inject({ method: 'POST', url: '/api/runs', payload });
}

describe('POST /api/runs：立即返回，图随后由事件推出来', () => {
  it('响应回来时图还没冻结，之后 plan.started 与冻结事件依次落盘', async () => {
    const { app, store } = await createFixture();

    const response = await createRun(app, {
      title: '搭建登录',
      goal: '做一个登录页，支持邮箱与验证码',
    });

    expect(response.statusCode).toBe(201);
    const body = response.json() as {
      id: string;
      title: string;
      status: string;
      stage: string;
      nodeCount: number;
      nodes: unknown[];
    };

    // 响应体够前端跳转：id / title / status 都在
    expect(body.id).toMatch(/^run-/);
    expect(body.title).toBe('搭建登录');
    // 还没图：状态是 draft，阶段停在编排
    expect(body.status).toBe('draft');
    expect(body.stage).toBe('orchestrate');
    expect(body.nodes).toEqual([]);

    /**
     * 关键断言：这一刻 `run.frozen` 还不存在。
     *
     * 这就是「返回不等规划」的直接证据——旧实现里 `await generateDag` 一结束
     * 就落冻结事件，响应回来时它必然已经在日志里。用事件顺序而不是耗时断言，
     * 是为了让结论与机器快慢无关。
     */
    const atResponse = store.eventsForRun(body.id);
    expect(atResponse[0]?.type).toBe('run.created');
    expect(atResponse.some((event) => event.type === 'run.frozen')).toBe(false);

    // 后台那条链随后把图交出来
    const frozen = await waitFor(() =>
      store
        .eventsForRun(body.id)
        .find((event) => event.type === 'run.frozen') as
        | Extract<OrchestratorEvent, { type: 'run.frozen' }>
        | undefined,
    );

    const types = store.eventsForRun(body.id).map((event) => event.type);
    expect(types).toContain('plan.started');
    expect(types.indexOf('plan.started')).toBeLessThan(types.indexOf('run.frozen'));
    // 节点图随冻结事件落地，而不是像从前那样塞在 run.created 里
    expect(frozen.nodes?.length).toBeGreaterThan(0);

    const detail = await app.inject({ method: 'GET', url: `/api/runs/${body.id}` });
    const view = detail.json() as {
      status: string;
      stage: string;
      nodeCount: number;
      nodes: Array<{ id: string; agentId?: string }>;
    };
    expect(view.stage).toBe('execute');
    expect(view.status).toBe('running');
    expect(view.nodeCount).toBe(frozen.nodes?.length);
    expect(view.nodes[0]?.id).toBe(frozen.nodes?.[0]?.id);

    await settle(400);
    await app.close();
  });

  it('拆解失败：plan.failed 落盘，运行派生为 failed 且不留未处理的 rejection', async () => {
    // 目录为空：Planner 找不到能干活的 Agent，拆解必然失败
    const { app, store } = await createFixture([]);

    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);

    try {
      const response = await createRun(app, {
        title: '注定失败',
        goal: '随便做点什么',
      });

      // 失败发生在返回之后：请求本身仍然是成功的「已创建」
      expect(response.statusCode).toBe(201);
      const body = response.json() as { id: string; status: string };

      const failed = await waitFor(() =>
        store
          .eventsForRun(body.id)
          .find((event) => event.type === 'plan.failed') as
          | Extract<OrchestratorEvent, { type: 'plan.failed' }>
          | undefined,
      );
      expect(failed.message).toContain('没有可用的 Agent');
      // issues 即便为空也要是数组：前端据此决定要不要展开问题清单
      expect(Array.isArray(failed.issues)).toBe(true);

      const detail = await app.inject({ method: 'GET', url: `/api/runs/${body.id}` });
      const view = detail.json() as {
        status: string;
        stage: string;
        nodes: unknown[];
        planFailure?: { message: string };
        events: Array<{ message: string }>;
      };
      // 没有图、也没人在推进它：状态必须是 failed，不能永远挂着 running
      expect(view.status).toBe('failed');
      expect(view.stage).toBe('orchestrate');
      expect(view.nodes).toEqual([]);
      expect(view.planFailure?.message).toContain('没有可用的 Agent');
      // 失败原因也要出现在事件流里，用户才能在详情页直接读到
      expect(
        view.events.some((event) => event.message.includes('任务图拆解失败')),
      ).toBe(true);

      // fire-and-forget 的失败路径必须被接住：漏出去就是未处理的 rejection
      await settle(300);
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
      await app.close();
    }
  });

  it('客户端自带 DAG 时仍然同步冻结，不经过拆解', async () => {
    const { app, store } = await createFixture();

    const response = await createRun(app, {
      title: '自带图',
      goal: '按这张图执行',
      dag: HANDWRITTEN_DAG,
    });

    expect(response.statusCode).toBe(201);
    const body = response.json() as {
      id: string;
      status: string;
      nodes: Array<{ id: string }>;
    };

    // 图在响应里就已经在了：这条路径没有要等的 Agent
    expect(body.nodes.map((node) => node.id)).toEqual(['impl-a']);
    expect(body.status).toBe('running');

    const types = store.eventsForRun(body.id).map((event) => event.type);
    expect(types.slice(0, 2)).toEqual(['run.created', 'run.frozen']);
    // 没有拆解就没有拆解事件
    expect(types).not.toContain('plan.started');

    await settle(400);
    await app.close();
  });
});

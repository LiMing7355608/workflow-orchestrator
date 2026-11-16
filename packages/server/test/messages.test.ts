import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { AgentProfile, NodeFacts, RunFacts } from '@orchestrator/core';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app';
import type { RunStore } from '../src/store';

/**
 * 编排器对话接口。
 *
 * 走真的 `buildApp` + `app.inject`：要验的是「一句自然语言指令 → 一条
 * `dag.amended` 事实 → 派生出来的节点变化」这条完整链路，只有经过真实路由、
 * 校验闸门与投影才测得到。
 *
 * 执行层用回放器（`AGENT_RUNNER=mock`）+ 临时目录工作区：改图链路要求 Agent
 * 真的往工作区里写交付文件，回放器实现了这一点，而它同时不启动任何进程，
 * 于是测试既不依赖本机装了什么 CLI，也不会碰仓库里的 git worktree。
 */

const RUN_ID = 'run-messages-api';
const AT = '2026-11-16T00:00:00.000Z';

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
 * `bin` 指向 node 而不是某个真实 CLI：探测只看 `where <bin>` 能不能解析到，
 * 用 node 保证测试结果与开发者机器上装没装 claude / codex 无关。
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

function node(partial: Partial<NodeFacts> & Pick<NodeFacts, 'id' | 'type'>): NodeFacts {
  return {
    title: partial.id,
    description: '',
    dependsOn: [],
    files: [],
    attempts: 0,
    maxAttempts: 3,
    ...partial,
  };
}

/**
 * 一条已经冻结的运行：实现节点跑完了，审查节点还没开始。
 *
 * `reviewStarted` 用来造出「审查节点已经在跑」的那一版，两版之间的唯一差别
 * 就是它有没有 startedAt——拒绝规则要判的正是这个。
 */
function buildRun(options: { reviewStarted?: boolean } = {}): RunFacts {
  const review = node({
    id: 'review-chat',
    type: 'review',
    title: '审查消息模块',
    agentId: 'claude',
    dependsOn: ['impl-chat'],
    files: ['src/chat/**'],
    ...(options.reviewStarted ? { startedAt: AT } : {}),
  });

  return {
    id: RUN_ID,
    title: '消息模块',
    summary: '',
    goal: '实现消息模块',
    workspaceRoot: '/tmp/target-repo',
    specVersion: 'v1.0',
    stage: 'execute',
    createdAt: AT,
    frozenAt: AT,
    nodeOrder: ['impl-chat', 'review-chat'],
    nodes: {
      'impl-chat': node({
        id: 'impl-chat',
        type: 'implement',
        title: '实现消息模块',
        agentId: 'claude',
        files: ['src/chat/**'],
        startedAt: AT,
        finishedAt: AT,
      }),
      'review-chat': review,
    },
  };
}

interface Fixture {
  app: FastifyInstance;
  store: RunStore;
}

async function createFixture(
  options: {
    seed?: { reviewStarted?: boolean };
    /** 目录为空时改图根本找不到可用的 Agent */
    catalog?: AgentProfile[];
    /** 让运行处于暂停：测试要验改图本身，不该顺带把新节点真的跑起来 */
    paused?: boolean;
  } = {},
): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), 'orchestrator-messages-'));
  tempDirs.push(root);

  process.env.AGENT_RUNNER = 'mock';
  process.env.AGENT_WORKSPACE = 'temp';
  process.env.AGENT_ARTIFACT_DIR = join(root, 'artifacts');
  // 改图会让 Planner 真的去 prepare 一个工作区；不指到临时根，它就会在
  // 仓库的 data/worktrees 下留一堆 amend-* 目录（回放链路的 release 用的是
  // 另一套 runId，清不掉）
  process.env.AGENT_WORKTREE_DIR = join(root, 'worktrees');
  delete process.env.PLANNER_AGENT_ID;

  const { app, store } = await buildApp({
    logPath: join(root, 'events.jsonl'),
    catalog: options.catalog ?? [agent('claude'), agent('codex')],
    logger: false,
  });
  await app.ready();

  if (options.seed) {
    await store.emit({
      type: 'run.created',
      at: AT,
      runId: RUN_ID,
      run: buildRun(options.seed),
    });
    await store.emit({ type: 'run.frozen', at: AT, runId: RUN_ID });
    if (options.paused) {
      await store.emit({ type: 'run.paused', at: AT, runId: RUN_ID });
    }
  }

  return { app, store };
}

/** 让 fire-and-forget 的推进链路收尾，再关应用。 */
async function settle(ms = 120): Promise<void> {
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

async function sendMessage(
  app: FastifyInstance,
  runId: string,
  text: string,
  actor?: string,
) {
  return app.inject({
    method: 'POST',
    url: `/api/runs/${runId}/messages`,
    headers: actor ? { 'x-actor': encodeURIComponent(actor) } : undefined,
    payload: { text },
  });
}

describe('POST /api/runs/:id/messages', () => {
  it('运行不存在时 404', async () => {
    const { app } = await createFixture();

    const response = await sendMessage(app, 'run-ghost', '换个 agent');

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: 'run_not_found' });

    await app.close();
  });

  it('没有可用 Agent 时 422，并说清是指令没落成图', async () => {
    // 目录为空：Planner 找不到可以干活的 Agent，指令根本没机会变成图
    const { app } = await createFixture({ seed: {}, catalog: [] });

    const response = await sendMessage(app, RUN_ID, '审查那个节点换成 codex');

    expect(response.statusCode).toBe(422);
    const body = response.json() as { error: string; message: string; issues: unknown[] };
    expect(body.error).toBe('instruction_rejected');
    expect(body.message).toContain('没有可用的 Agent');
    expect(Array.isArray(body.issues)).toBe(true);

    await app.close();
  });

  it('指令落成改动：发出 dag.amended，节点事实随之变化', async () => {
    const { app, store } = await createFixture({
      // 暂停着改图：这里要验的是改图，不该顺带把审查节点真的跑起来
      seed: {},
      paused: true,
    });

    const response = await sendMessage(app, RUN_ID, '审查那个节点换成 codex', 'YG');

    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      reply: string;
      applied: Array<{
        kind: string;
        nodeId: string;
        fields?: Array<{ field: string; from?: string; to?: string }>;
      }>;
      rejected: Array<{ nodeId: string; reason: string }>;
      run: { nodes: Array<{ id: string; agentId?: string }> };
    };

    expect(body.rejected).toEqual([]);
    expect(body.applied).toHaveLength(1);
    expect(body.applied[0]?.kind).toBe('update-node');
    expect(body.applied[0]?.nodeId).toBe('review-chat');
    expect(body.applied[0]?.fields).toEqual([
      { field: 'agentId', from: 'claude', to: 'codex' },
    ]);
    // 回复必须说清改了什么，而不是一句「已完成」
    expect(body.reply).toContain('agentId：claude → codex');

    // 事实层：事件真的落了，并且是那条「人下的指令」
    const amendEvents = store.eventsForRun(RUN_ID).filter((event) => event.type === 'dag.amended');
    expect(amendEvents).toHaveLength(1);
    const amend = amendEvents[0];
    expect(amend && 'actor' in amend ? amend.actor : undefined).toBe('YG');
    expect(amend && 'reason' in amend ? amend.reason : undefined).toBe(
      '审查那个节点换成 codex',
    );
    expect(store.snapshot.runs[RUN_ID]?.amendments).toHaveLength(1);

    // 回读运行详情：图上那个节点的 Agent 已经变了
    const detail = await app.inject({ method: 'GET', url: `/api/runs/${RUN_ID}` });
    const nodes = (detail.json() as { nodes: Array<{ id: string; agentId?: string }> }).nodes;
    expect(nodes.find((item) => item.id === 'review-chat')?.agentId).toBe('codex');
    // 实现节点没被牵连
    expect(nodes.find((item) => item.id === 'impl-chat')?.agentId).toBe('claude');

    await settle();
    await app.close();
  });

  it('改动落在已开始的节点上时被拒，并给出可读理由', async () => {
    const { app, store } = await createFixture({ seed: { reviewStarted: true } });

    const response = await sendMessage(app, RUN_ID, '审查那个节点换成 codex');

    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      reply: string;
      applied: unknown[];
      rejected: Array<{ nodeId: string; reason: string }>;
    };

    // 关键：不是静默丢弃——applied 为空，rejected 里有话说
    expect(body.applied).toEqual([]);
    expect(body.rejected).toHaveLength(1);
    expect(body.rejected[0]?.nodeId).toBe('review-chat');
    expect(body.rejected[0]?.reason).toContain('已经开始执行');
    expect(body.reply).toContain('没有生效');

    // 没有生效的改动就不该写事实：对话不是编排事实，改动才是
    expect(store.eventsForRun(RUN_ID).some((event) => event.type === 'dag.amended')).toBe(
      false,
    );
    expect(store.snapshot.runs[RUN_ID]?.nodes['review-chat']?.agentId).toBe('claude');

    await settle();
    await app.close();
  });

  it('body 不合法时 400，不会把空指令当成改图请求', async () => {
    const { app } = await createFixture({ seed: {} });

    const response = await app.inject({
      method: 'POST',
      url: `/api/runs/${RUN_ID}/messages`,
      payload: { text: '' },
    });

    expect(response.statusCode).toBe(400);
    expect((response.json() as { error: string }).error).toBe('invalid_body');

    await app.close();
  });
});

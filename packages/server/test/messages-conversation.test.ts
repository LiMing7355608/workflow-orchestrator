import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { AgentProfile, NodeFacts, OrchestratorEvent, RunFacts } from '@orchestrator/core';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app';
import { buildAmendInstruction } from '../src/amend';
import type { RunStore } from '../src/store';

/**
 * 编排器对话落库、打断拆解、以及上下文如何拼进 amendDag。
 *
 * 这里验的是三件互相独立的事，任何一件坏掉都表现为「对话看起来没问题、
 * 实际上什么都没记住」：
 *
 *   1. 用户说的话先落成事实，改图成功、失败、被拒都一样；
 *   2. 拆解进行中的插话是**打断并重来**，不是去改一张还不存在的图；
 *   3. 前几轮对话会拼进下一条指令的上下文，让「刚才那个改动再收一点」有指代。
 *
 * 走真的 `buildApp` + `app.inject`：只有经过真实路由、校验闸门与投影，
 * 「一句话 → 一条事件 → 派生出来的会话」这条链路才测得到。
 */

const RUN_ID = 'run-conversation-api';
const AT = '2026-11-16T00:00:00.000Z';

const tempDirs: string[] = [];
const originalEnv = {
  runner: process.env.AGENT_RUNNER,
  workspace: process.env.AGENT_WORKSPACE,
  artifact: process.env.AGENT_ARTIFACT_DIR,
  worktreeDir: process.env.AGENT_WORKTREE_DIR,
  targetDir: process.env.AGENT_TARGET_DIR,
  plannerAgent: process.env.PLANNER_AGENT_ID,
};

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

/** 一条已经冻结的运行：实现节点跑完，审查节点还没开始。 */
function buildRun(): RunFacts {
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
      'review-chat': node({
        id: 'review-chat',
        type: 'review',
        title: '审查消息模块',
        agentId: 'claude',
        dependsOn: ['impl-chat'],
        files: ['src/chat/**'],
      }),
    },
  };
}

interface Fixture {
  app: FastifyInstance;
  store: RunStore;
}

async function createFixture(
  options: {
    /** 不给就只建应用，不预置运行（打断拆解那条用例自己建） */
    seed?: boolean;
    /** 目录为空时改图根本找不到可用的 Agent */
    catalog?: AgentProfile[];
  } = {},
): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), 'orchestrator-conversation-'));
  tempDirs.push(root);

  process.env.AGENT_RUNNER = 'mock';
  process.env.AGENT_WORKSPACE = 'temp';
  process.env.AGENT_ARTIFACT_DIR = join(root, 'artifacts');
  process.env.AGENT_WORKTREE_DIR = join(root, 'worktrees');
  // 建运行要一个可用的目标目录；这里等价于运维用 AGENT_TARGET_DIR 指定过
  process.env.AGENT_TARGET_DIR = join(root, 'target');
  delete process.env.PLANNER_AGENT_ID;

  const { app, store } = await buildApp({
    logPath: join(root, 'events.jsonl'),
    catalog: options.catalog ?? [agent('claude'), agent('codex')],
    logger: false,
  });
  await app.ready();

  if (options.seed) {
    await store.emit({ type: 'run.created', at: AT, runId: RUN_ID, run: buildRun() });
    await store.emit({ type: 'run.frozen', at: AT, runId: RUN_ID });
    // 暂停着改图：要验的是对话与改图，不该顺带把审查节点真跑起来
    await store.emit({ type: 'run.paused', at: AT, runId: RUN_ID });
  }

  return { app, store };
}

type MessageEvent = Extract<OrchestratorEvent, { type: 'orchestrator.message' }>;

function messagesOf(store: RunStore, runId: string): MessageEvent[] {
  return store.eventsForRun(runId).filter(
    (event): event is MessageEvent => event.type === 'orchestrator.message',
  );
}

/** 轮询等一个条件成立。拆解是异步的，测试只能等它落到事实上。 */
async function waitFor<T>(probe: () => T | undefined, timeoutMs = 5_000): Promise<T> {
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
  restore('AGENT_TARGET_DIR', originalEnv.targetDir);
  restore('PLANNER_AGENT_ID', originalEnv.plannerAgent);

  await Promise.all(
    tempDirs.splice(0).map((dir) =>
      rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(
        () => {},
      ),
    ),
  );
});

interface ConversationBody {
  reply?: string;
  error?: string;
  message?: string;
  interrupted?: boolean;
  conversation?: Array<{
    at: string;
    role: 'user' | 'orchestrator' | 'system';
    text: string;
    tone?: string;
    interrupt?: boolean;
  }>;
}

async function sendMessage(
  app: FastifyInstance,
  runId: string,
  text: string,
  actor?: string,
): Promise<ConversationBody & { statusCode: number }> {
  const response = await app.inject({
    method: 'POST',
    url: `/api/runs/${runId}/messages`,
    headers: actor ? { 'x-actor': encodeURIComponent(actor) } : undefined,
    payload: { text },
  });
  return { statusCode: response.statusCode, ...(response.json() as ConversationBody) };
}

describe('对话落库：说过的每句话都留在事实里', () => {
  it('改图成功：用户消息与编排器回复都落盘，并出现在 conversation 里', async () => {
    const { app, store } = await createFixture({ seed: true });
    try {
      const body = await sendMessage(app, RUN_ID, '审查那个节点换成 codex', 'YG');

      expect(body.statusCode).toBe(200);
      // 首条永远是目标本身，它不来自事件（见 core 的 deriveConversation）
      expect(body.conversation?.[0]).toMatchObject({
        role: 'user',
        text: '实现消息模块',
      });

      const texts = (body.conversation ?? []).map((entry) => entry.text);
      expect(texts).toContain('审查那个节点换成 codex');
      // 系统行把「改了什么」写进同一条流里，而不是只留在事件流里
      expect(texts.some((text) => text.startsWith('改图：更新 review-chat'))).toBe(true);
      expect(texts.some((text) => text.includes('agentId：claude → codex'))).toBe(true);

      // 事实层：一问一答，顺序不能反
      const messages = messagesOf(store, RUN_ID);
      expect(messages.map((event) => event.role)).toEqual(['user', 'orchestrator']);
      expect(messages[0]?.text).toBe('审查那个节点换成 codex');
      expect(messages[1]?.text).toContain('agentId：claude → codex');

      // GET 的响应与响应体里的会话是同一条流：两边各算一遍也不会分叉
      const detail = await app.inject({ method: 'GET', url: `/api/runs/${RUN_ID}` });
      expect((detail.json() as ConversationBody).conversation).toEqual(
        body.conversation,
      );

      await settle();
    } finally {
      await app.close();
    }
  });

  it('同一运行并发两句：两条都落库，且都基于最新图算 diff', async () => {
    const { app, store } = await createFixture({ seed: true });
    try {
      // 并发发两句不同的话。没有互斥时两边各自端着一份旧快照算 diff，
      // 后落地的 dag.amended 按字段覆盖，先落地那条的改动会被静默吃掉——
      // 用户看到自己说的两句都在，却只有一句生效。
      const [first, second] = await Promise.all([
        sendMessage(app, RUN_ID, '审查那个节点换成 codex', 'YG'),
        sendMessage(app, RUN_ID, '再把实现节点的重试次数改成 2', 'YG'),
      ]);

      expect(first.statusCode).toBe(200);
      expect(second.statusCode).toBe(200);

      // 两条用户消息一条都不能丢
      const userMessages = messagesOf(store, RUN_ID).filter(
        (event) => event.role === 'user',
      );
      expect(userMessages.map((event) => event.text).sort()).toEqual(
        ['再把实现节点的重试次数改成 2', '审查那个节点换成 codex'].sort(),
      );

      // 编排器对每一句都有回复：会话里不能出现「人说了、它没应」
      const replies = messagesOf(store, RUN_ID).filter(
        (event) => event.role === 'orchestrator',
      );
      expect(replies.length).toBe(2);

      await settle();
    } finally {
      await app.close();
    }
  });

  it('改图失败：用户消息仍然落库，失败原因成为编排器的回复', async () => {
    // 目录为空：Planner 找不到能干活的 Agent，指令根本没机会变成图
    const { app, store } = await createFixture({ seed: true, catalog: [] });
    try {
      const body = await sendMessage(app, RUN_ID, '审查那个节点换成 codex');

      expect(body.statusCode).toBe(422);
      expect(body.error).toBe('instruction_rejected');
      expect(body.reply).toContain('没能改这张图');

      /**
       * 关键：失败不撤销「人说过这句话」。
       *
       * 之前这条路径直接 422 返回，什么事实都不留——用户刷新之后只看到一张
       * 没变的图，再也想不起来自己要求过什么。
       */
      const messages = messagesOf(store, RUN_ID);
      expect(messages).toHaveLength(2);
      expect(messages[0]).toMatchObject({
        role: 'user',
        text: '审查那个节点换成 codex',
      });
      expect(messages[1]?.role).toBe('orchestrator');
      expect(messages[1]?.text).toContain('没有可用的 Agent');

      const detail = await app.inject({ method: 'GET', url: `/api/runs/${RUN_ID}` });
      const texts = ((detail.json() as ConversationBody).conversation ?? []).map(
        (entry) => entry.text,
      );
      expect(texts).toContain('审查那个节点换成 codex');
      expect(texts.some((text) => text.startsWith('没能改这张图'))).toBe(true);

      await settle();
    } finally {
      await app.close();
    }
  });
});

describe('拆解进行中插话：打断并重来', () => {
  it('还没有图（上次拆解失败）：这句话是重拆，而不是去改一张空图', async () => {
    // 目录为空：第一次拆解必然失败，运行停在「没有图」这个状态上
    const { app, store } = await createFixture({ catalog: [] });
    try {
      const created = await app.inject({
        method: 'POST',
        url: '/api/runs',
        payload: { title: '登录页', goal: '做一个登录页' },
      });
      const id = (created.json() as { id: string }).id;
      await waitFor(() =>
        store.eventsForRun(id).find((event) => event.type === 'plan.failed'),
      );

      const body = await sendMessage(app, id, '改成先做扫码登录');

      expect(body.statusCode).toBe(200);
      // 没有任何东西在被它打断：这条消息不是「打断」，是「换个方向重来」
      expect(body.interrupted).toBe(false);
      expect(body.reply).toContain('重新拆解');

      const userMessages = messagesOf(store, id).filter((event) => event.role === 'user');
      expect(userMessages).toHaveLength(1);
      expect(userMessages[0]?.interrupt).toBeUndefined();

      // 又发起了一次拆解（并且同样因为目录为空而失败）
      await waitFor(() =>
        store.eventsForRun(id).filter((event) => event.type === 'plan.started').length === 2
          ? true
          : undefined,
      );
      // 关键：没有对着空图做一次形同虚设的改图
      const types = store.eventsForRun(id).map((event) => event.type);
      expect(types).not.toContain('dag.amended');

      await settle();
    } finally {
      await app.close();
    }
  });

  it('abort 当前拆解、按新要求重拆，且不会同时跑两个规划', async () => {
    const { app, store } = await createFixture();
    try {
      const created = await app.inject({
        method: 'POST',
        url: '/api/runs',
        payload: { title: '登录页', goal: '做一个登录页' },
      });
      const id = (created.json() as { id: string }).id;

      await waitFor(() =>
        store.eventsForRun(id).find((event) => event.type === 'plan.started'),
      );
      // 拆解还在跑（回放器要 80ms 才交出图），此刻插话就是打断
      const body = await sendMessage(app, id, '先做注册再做登录');

      expect(body.statusCode).toBe(200);
      expect(body.interrupted).toBe(true);
      expect(body.reply).toContain('已打断正在进行的拆解');

      // 图最终由新的一次拆解交出来
      await waitFor(() => store.snapshot.runs[id]?.frozenAt);

      // 事件列表要在拆解真正收尾之后再读一遍：它是一个活数组的快照，
      // 早读一步就只能看到拆解开始之前的那几条
      const types = store.eventsForRun(id).map((event) => event.type);
      const userMessages = messagesOf(store, id).filter((event) => event.role === 'user');
      expect(userMessages).toHaveLength(1);
      // 打断标记记在这条消息自己身上：它是这条消息的属性，不是后来的更正
      expect(userMessages[0]?.interrupt).toBe(true);
      expect(messagesOf(store, id).map((event) => event.role)).toEqual([
        'user',
        'orchestrator',
      ]);

      const starts = types.filter((type) => type === 'plan.started');
      const freezes = types.filter((type) => type === 'run.frozen');
      const failures = types.filter((type) => type === 'plan.failed');
      expect(starts).toHaveLength(2);
      /**
       * 只有一次冻结，也没有拆解失败。
       *
       * 这就是「没有同时跑两个规划」的可观测证据：被打断的那条链在冻结之前
       * 有一道 `throwIfAborted`（见 planner 的 generateDag），它永远交不出图；
       * 而它若被当成失败结算，会留下一条 plan.failed 把用户的打断说成故障。
       * 事件顺序也钉住了同一件事——打断消息必须夹在两次 plan.started 之间。
       */
      expect(freezes).toHaveLength(1);
      expect(failures).toHaveLength(0);

      const messageIndex = store
        .eventsForRun(id)
        .findIndex((event) => event.type === 'orchestrator.message');
      const startIndices = store
        .eventsForRun(id)
        .map((event, index) => (event.type === 'plan.started' ? index : -1))
        .filter((index) => index >= 0);
      expect(messageIndex).toBeGreaterThan(-1);
      expect(messageIndex).toBeLessThan(startIndices.at(-1) ?? -1);

      await settle();
    } finally {
      await app.close();
    }
  });
});

describe('对话上下文拼进 amendDag', () => {
  it('没有历史时指令原样交给 Planner', () => {
    expect(buildAmendInstruction('换成 codex', [])).toBe('换成 codex');
  });

  it('有历史时前文在前、本次指令在后，且标明哪一段才是新要求', () => {
    const instruction = buildAmendInstruction('再收一点', [
      { role: 'user', text: '审查那个节点换成 codex' },
      { role: 'orchestrator', text: '已按指令修改任务图：\n- review-chat 的 agentId → codex' },
    ]);

    expect(instruction).toContain('之前聊过什么');
    expect(instruction).toContain('- 用户：审查那个节点换成 codex');
    // 编排器自己的回复也进上下文：否则「刚才」只剩下半边
    expect(instruction).toContain('- 编排器：已按指令修改任务图');
    // 换行被压成空格：一条消息占一行，上下文才读得出「哪句是谁说的」
    expect(instruction).not.toContain('任务图：\n- review-chat');
    expect(instruction.indexOf('之前聊过什么')).toBeLessThan(
      instruction.indexOf('本次指令'),
    );
    expect(instruction.trimEnd().endsWith('再收一点')).toBe(true);
  });

  it('只带最近十轮，且单条消息被压短', () => {
    const history = Array.from({ length: 14 }, (_, index) => ({
      role: 'user' as const,
      text: `第 ${index} 句 ${'长'.repeat(400)}`,
    }));
    const instruction = buildAmendInstruction('继续', history);

    // 最早那几句不该还在：上下文是参考，不是把整段历史重投一遍
    expect(instruction).not.toContain('第 0 句');
    expect(instruction).not.toContain('第 3 句');
    expect(instruction).toContain('第 4 句');
    expect(instruction).toContain('第 13 句');
    // 每条压到 200 字符以内，否则十轮就能把一条短指令顶过 prompt 里的
    // 「指令偏长」阈值，让 Agent 收到一句与实情不符的警告
    expect(instruction).toContain('…');
    expect(instruction.length).toBeLessThan(2_500);
  });
});

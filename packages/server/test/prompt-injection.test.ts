import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type {
  AgentProfile,
  AgentRunRequest,
  AgentRunResult,
  AgentRunner,
} from '@orchestrator/core';
import { DEFAULT_AGENT_PROFILES } from '@orchestrator/core';
import { buildApp } from '../src/app.js';

/**
 * 记录每一次真实发出的 prompt 的执行器。
 *
 * 为什么需要它：`buildPrompt` 的注入逻辑在 core 里已经用假 runner 测过，但
 * **「server 有没有把事件读取端接进 deps」**这一层测不到——MockAgentRunner
 * 不回显 prompt，删掉 `buildAdvanceDeps` 里那一行接线不会有任何测试变红。
 * 这个执行器让端到端的那一问可以被断言。
 */
class CapturingRunner implements AgentRunner {
  readonly prompts: string[] = [];

  async run(
    request: AgentRunRequest,
    onChunk: (chunk: string) => void,
  ): Promise<AgentRunResult> {
    this.prompts.push(request.stdin ?? request.argv.join(' '));
    onChunk('ok');
    return { ok: true, exitCode: 0, output: 'ok' };
  }
}

const AT = '2026-11-16T00:00:00.000Z';
const RUN_ID = 'run-node-prompt';

// 用真实 profile：手写的简化版会漏字段（比如 session.derive），
// 那种错误只会把用例变成「测我的 fixture」而不是「测产品行为」
const CATALOG: AgentProfile[] = DEFAULT_AGENT_PROFILES.filter(
  (agent) => agent.id === 'dsh-acp',
).map((agent) => ({ ...agent, availability: 'ready' as const }));

let tempDir: string | undefined;
const savedEnv = {
  workspace: process.env.AGENT_WORKSPACE,
  worktreeDir: process.env.AGENT_WORKTREE_DIR,
  artifactDir: process.env.AGENT_ARTIFACT_DIR,
};

afterEach(async () => {
  if (savedEnv.workspace === undefined) {
    delete process.env.AGENT_WORKSPACE;
  } else {
    process.env.AGENT_WORKSPACE = savedEnv.workspace;
  }
  if (savedEnv.worktreeDir === undefined) {
    delete process.env.AGENT_WORKTREE_DIR;
  } else {
    process.env.AGENT_WORKTREE_DIR = savedEnv.worktreeDir;
  }
  if (savedEnv.artifactDir === undefined) {
    delete process.env.AGENT_ARTIFACT_DIR;
  } else {
    process.env.AGENT_ARTIFACT_DIR = savedEnv.artifactDir;
  }
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true }).catch(() => {});
    tempDir = undefined;
  }
});

async function createFixture(): Promise<{
  app: Awaited<ReturnType<typeof buildApp>>['app'];
  store: Awaited<ReturnType<typeof buildApp>>['store'];
  runner: CapturingRunner;
}> {
  tempDir = await mkdtemp(join(tmpdir(), 'orchestrator-prompt-'));
  // 临时目录不是 git 仓库：用 temp 工作区，这个用例关心的是提示词，
  // 不是 worktree 隔离
  process.env.AGENT_WORKSPACE = 'temp';
  process.env.AGENT_WORKTREE_DIR = join(tempDir, 'worktrees');
  // 产物目录也必须指走：默认落在 <启动目录>/data/artifacts，跑一次测试
  // 就会在仓库里留下一个 packages/server/data
  process.env.AGENT_ARTIFACT_DIR = join(tempDir, 'artifacts');

  const runner = new CapturingRunner();
  const { app, store } = await buildApp({
    logPath: join(tempDir, 'events.jsonl'),
    catalog: CATALOG,
    runner,
    logger: false,
  });

  await store.emit({
    type: 'run.created',
    at: AT,
    runId: RUN_ID,
    run: {
      id: RUN_ID,
      title: '提示词注入',
      summary: '验证人类补充要求是否进入提示词',
      goal: '实现消息模块',
      workspaceRoot: tempDir,
      specVersion: 'v1.0',
      stage: 'decompose',
      createdAt: AT,
      nodeOrder: ['impl-a'],
      nodes: {
        'impl-a': {
          id: 'impl-a',
          type: 'implement',
          title: '甲实现',
          description: '实现消息模块',
          dependsOn: [],
          files: [],
          agentId: 'dsh-acp',
          attempts: 0,
          maxAttempts: 3,
        },
      },
    },
  });
  await store.emit({ type: 'run.frozen', at: AT, runId: RUN_ID });

  return { app, store, runner };
}

describe('人类补充要求进入提示词', () => {
  it('节点留言会出现在这个节点真正发出的 probe 里', async () => {
    const { app, store, runner } = await createFixture();

    // 节点没在跑：只记录，不触发执行
    const recorded = await app.inject({
      method: 'POST',
      url: `/api/runs/${RUN_ID}/nodes/impl-a/messages`,
      payload: { text: '别用 vue，改成 react' },
    });
    expect(recorded.statusCode, recorded.body).toBe(200);
    expect(runner.prompts).toHaveLength(0);

    // 现在手动跑这个节点：提示词里必须带上刚才那句话
    const run = await app.inject({
      method: 'POST',
      url: `/api/runs/${RUN_ID}/nodes/impl-a/run`,
      payload: {},
    });
    expect(run.statusCode, run.body).toBe(200);

    expect(runner.prompts).toHaveLength(1);
    const prompt = runner.prompts[0] ?? '';
    expect(prompt).toContain('人类在开发过程中的补充要求');
    expect(prompt).toContain('别用 vue，改成 react');

    await app.close();
  });

  it('没有留言时这一段完全不出现，不留空标题', async () => {
    const { app, runner } = await createFixture();

    const run = await app.inject({
      method: 'POST',
      url: `/api/runs/${RUN_ID}/nodes/impl-a/run`,
      payload: {},
    });
    expect(run.statusCode).toBe(200);

    const prompt = runner.prompts[0] ?? '';
    expect(prompt).not.toContain('人类在开发过程中的补充要求');

    await app.close();
  });
});

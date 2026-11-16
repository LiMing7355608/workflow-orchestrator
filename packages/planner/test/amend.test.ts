import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentProfile, AgentRunner, WorkspacePort } from '@orchestrator/core';
import {
  DagGenerationError,
  PLAN_FILENAME,
  PLANNER_AMEND_MARKER,
  amendDag,
  buildAmendmentPrompt,
  extractCurrentDagFromPrompt,
  parseDag,
  type Dag,
} from '../src/index';

/**
 * 改图链路。
 *
 * 交付只认工作区里的 `PLAN_FILENAME` 文件，所以这里的「假 runner」必须真的
 * 往磁盘上写东西——这正是被测语义之一：没写文件就是没交付，stdout 里说了
 * 什么都不算。工作区因此也用真的临时目录，而不是一个假路径。
 */

function agent(
  partial: Partial<AgentProfile> & Pick<AgentProfile, 'id'>,
): AgentProfile {
  return {
    label: partial.id,
    vendor: 'test',
    logo: `/logos/${partial.id}.svg`,
    launch: { bin: partial.id, args: ['run', '{prompt}'], stdin: false, parser: 'plain' },
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
    ...partial,
  };
}

const catalog: AgentProfile[] = [
  agent({ id: 'claude' }),
  agent({ id: 'codex', availability: 'installed' }),
];

const currentDag: Dag = parseDag({
  title: '消息模块',
  summary: '实现消息模块并审查',
  specVersion: 'v1.0',
  nodes: [
    {
      id: 'impl-chat',
      type: 'implement',
      title: '实现消息模块',
      description: '收发消息',
      dependsOn: [],
      files: ['src/chat/**'],
      agentId: 'claude',
      maxAttempts: 3,
    },
    {
      id: 'review-chat',
      type: 'review',
      title: '审查消息模块',
      description: '核对边界',
      dependsOn: ['impl-chat'],
      files: ['src/chat/**'],
      agentId: 'claude',
      maxAttempts: 3,
    },
  ],
});

/** 把当前图改一个字段，代表「Agent 交回来的新图」。 */
function amended(overrides: Partial<Dag> = {}): string {
  return JSON.stringify({
    title: currentDag.title,
    summary: currentDag.summary,
    specVersion: currentDag.specVersion,
    nodes: currentDag.nodes.map((node) =>
      node.id === 'review-chat' ? { ...node, agentId: 'codex' } : node,
    ),
    ...overrides,
  });
}

const tempDirs: string[] = [];

/** 真实临时目录工作区：交付文件的读写都发生在磁盘上。 */
const workspace: WorkspacePort = {
  prepare: async (runId, nodeId) => {
    const dir = await mkdtemp(join(tmpdir(), `amend-${runId}-${nodeId}-`));
    tempDirs.push(dir);
    return dir;
  },
  release: async () => {},
};

/**
 * 假执行器：第 n 次调用写第 n 条预设内容（`undefined` 表示这次什么都不写）。
 * 同时记录每次收到的 prompt，用于验证「问题被回灌」。
 */
function fakeRunner(outputs: Array<string | undefined>): {
  runner: AgentRunner;
  prompts: string[];
  calls: () => number;
} {
  let index = 0;
  const prompts: string[] = [];
  return {
    prompts,
    runner: {
      run: async (request, onChunk) => {
        const text = outputs[Math.min(index, outputs.length - 1)];
        prompts.push(request.stdin ?? request.argv.join(' '));
        index += 1;
        if (text !== undefined) {
          await writeFile(join(request.cwd, PLAN_FILENAME), text, 'utf8');
        }
        onChunk(text ?? '');
        return { ok: true, exitCode: 0, output: text ?? '' };
      },
    },
    calls: () => index,
  };
}

/** 语义非法：引用了目录里不存在的 Agent，能过 schema 但过不了校验。 */
const invalidPlan = JSON.stringify({
  title: '坏图',
  summary: '',
  specVersion: 'v1.0',
  nodes: [
    {
      id: 'impl-chat',
      type: 'implement',
      title: '实现消息模块',
      description: '',
      dependsOn: [],
      files: [],
      agentId: 'ghost',
      maxAttempts: 3,
    },
  ],
});

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) =>
      rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }).catch(
        () => {},
      ),
    ),
  );
});

describe('buildAmendmentPrompt', () => {
  it('给出指令原文、当前图摘要、白名单与锁定节点', () => {
    const prompt = buildAmendmentPrompt(
      '做一个消息模块',
      currentDag,
      '审查那个节点换成 codex',
      catalog,
      { lockedNodeIds: ['impl-chat'] },
    );

    expect(prompt).toContain(PLANNER_AMEND_MARKER);
    expect(prompt).toContain('审查那个节点换成 codex');
    // 紧凑摘要要能看清每个节点是谁、依赖谁、占哪些文件
    expect(prompt).toContain('impl-chat | implement');
    expect(prompt).toContain('agent=claude');
    expect(prompt).toContain('deps=impl-chat');
    expect(prompt).toContain('files=src/chat/**');
    // 已锁定节点必须显式标出来，否则 Agent 无从知道哪些不能碰
    expect(prompt).toContain('已锁定');
    // 白名单只列可用 Agent
    expect(prompt).toContain('可用 agentId 白名单：claude, codex');
    // 交付方式仍然是写文件
    expect(prompt).toContain(PLAN_FILENAME);
    // 上一轮的问题按需回灌
    expect(prompt).not.toContain('上一版被拒绝的原因');
  });

  it('能把 prompt 里的当前图读回来，供回放执行器使用', () => {
    const prompt = buildAmendmentPrompt(
      '目标',
      currentDag,
      '换个 agent',
      catalog,
    );
    const round = extractCurrentDagFromPrompt(prompt);
    expect(round?.nodes.map((node) => node.id)).toEqual(['impl-chat', 'review-chat']);
    expect(round?.nodes[0]?.files).toEqual(['src/chat/**']);
  });
});

describe('amendDag', () => {
  it('读到交付文件就返回修改后的图', async () => {
    const fake = fakeRunner([amended()]);
    const plan = await amendDag(
      '做一个消息模块',
      currentDag,
      '审查那个节点换成 codex',
      catalog,
      { runner: fake.runner, workspace },
    );

    expect(plan.attempts).toBe(1);
    expect(plan.agentId).toBe('claude');
    expect(plan.issues).toHaveLength(0);
    expect(plan.dag.nodes.find((node) => node.id === 'review-chat')?.agentId).toBe(
      'codex',
    );
    expect(fake.calls()).toBe(1);
  });

  it('校验不通过时把问题回灌，第二轮通过', async () => {
    const fake = fakeRunner([invalidPlan, amended()]);
    const plan = await amendDag(
      '做一个消息模块',
      currentDag,
      '实现也换成 codex',
      catalog,
      { runner: fake.runner, workspace },
    );

    expect(plan.attempts).toBe(2);
    expect(plan.issues[0]?.kind).toBe('unknown-agent');
    // 第二轮 prompt 里必须带上上一轮的错误，否则 Agent 会重犯同一个错
    expect(fake.prompts[1]).toContain('上一版被拒绝的原因');
    expect(fake.prompts[1]).toContain('ghost');
  });

  it('连续不合格时抛错，并带上累计问题', async () => {
    const fake = fakeRunner([invalidPlan]);
    await expect(
      amendDag('做一个消息模块', currentDag, '随便改改', catalog, {
        runner: fake.runner,
        workspace,
      }),
    ).rejects.toThrow(DagGenerationError);

    try {
      await amendDag('做一个消息模块', currentDag, '随便改改', catalog, {
        runner: fake.runner,
        workspace,
      });
    } catch (error) {
      const failure = error as DagGenerationError;
      expect(failure.attempts).toBe(3);
      expect(failure.issues.length).toBeGreaterThan(0);
    }
  });

  it('只在回复里贴 JSON 而不写文件，不算交付', async () => {
    // 第三个参数是 undefined：这次调用什么都不写盘
    const fake = fakeRunner([undefined]);
    await expect(
      amendDag('做一个消息模块', currentDag, '换个 agent', catalog, {
        runner: fake.runner,
        workspace,
        // stdout 里明明有合法 JSON，也绝不能被当成答案
        // （runner 的 output 与交付文件是两条通道）
      }),
    ).rejects.toThrow(new RegExp(PLAN_FILENAME));
    expect(fake.calls()).toBe(3);
  });

  it('目录里没有可用 Agent 时直接报错', async () => {
    await expect(
      amendDag('做一个消息模块', currentDag, '换个 agent', [], {
        runner: fakeRunner([amended()]).runner,
        workspace,
      }),
    ).rejects.toThrow(/没有可用的 Agent/);
  });
});

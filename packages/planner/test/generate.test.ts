import { describe, expect, it } from 'vitest';
import type { AgentProfile, AgentRunner, WorkspacePort } from '@orchestrator/core';
import {
  DagGenerationError,
  PLANNER_PROMPT_MARKER,
  generateDag,
  pickPlannerAgent,
  usablePlannerAgents,
} from '../src/generate';

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
  agent({ id: 'opencode', availability: 'installed' }),
  agent({ id: 'trae', enabled: false }),
  agent({ id: 'gone', availability: 'missing' }),
];

const workspace: WorkspacePort = {
  prepare: async (runId, nodeId) => `/tmp/${runId}/${nodeId}`,
  release: async () => {},
};

/** 假执行器：按顺序吐出预设输出，并记录被调用了几次。 */
function fakeRunner(outputs: string[]): {
  runner: AgentRunner;
  calls: () => number;
} {
  let index = 0;
  let count = 0;
  return {
    runner: {
      run: async (_request, onChunk) => {
        count += 1;
        const text = outputs[Math.min(index, outputs.length - 1)] ?? '';
        index += 1;
        onChunk(text);
        return { ok: true, exitCode: 0, output: text };
      },
    },
    calls: () => count,
  };
}

const validPlan = JSON.stringify({
  title: '核心功能',
  summary: '测试用图',
  specVersion: 'v1.0',
  nodes: [
    {
      id: 'impl-core',
      type: 'implement',
      title: '实现核心',
      description: '做点什么',
      dependsOn: [],
      files: ['src/core/**'],
      agentId: 'claude',
      maxAttempts: 3,
    },
    {
      id: 'review-core',
      type: 'review',
      title: '审查核心',
      description: '看看做得对不对',
      dependsOn: ['impl-core'],
      files: ['src/core/**'],
      agentId: 'opencode',
      maxAttempts: 3,
    },
  ],
});

/** 语义非法：引用了目录里不存在的 Agent，能过 schema 但过不了校验。 */
const invalidPlan = JSON.stringify({
  title: '坏图',
  summary: '',
  specVersion: 'v1.0',
  nodes: [
    {
      id: 'impl-core',
      type: 'implement',
      title: '实现',
      description: '',
      dependsOn: [],
      files: [],
      agentId: 'ghost',
      maxAttempts: 3,
    },
  ],
});

describe('规划 Agent 选择', () => {
  it('排除未启用与未安装的，ready 且结构化输出优先', () => {
    const usable = usablePlannerAgents(catalog);
    expect(usable.map((item) => item.id)).toEqual(['claude', 'opencode']);
    expect(pickPlannerAgent(catalog)?.id).toBe('claude');
  });

  it('显式指定时不做二次筛选，让调用方拿到明确结果', () => {
    expect(pickPlannerAgent(catalog, 'gone')?.id).toBe('gone');
    expect(pickPlannerAgent(catalog, 'nope')).toBeUndefined();
  });
});

describe('用 Agent 生成 DAG', () => {
  it('一次就通过时返回图与来源', async () => {
    const fake = fakeRunner([validPlan]);
    const plan = await generateDag('做一个核心功能', catalog, {
      runner: fake.runner,
      workspace,
    });

    expect(plan.dag.nodes).toHaveLength(2);
    expect(plan.attempts).toBe(1);
    expect(plan.agentId).toBe('claude');
    expect(plan.issues).toHaveLength(0);
    expect(fake.calls()).toBe(1);
  });

  it('首次不合法会把问题回灌后重试，第二次通过', async () => {
    const fake = fakeRunner([invalidPlan, validPlan]);
    const plan = await generateDag('做一个核心功能', catalog, {
      runner: fake.runner,
      workspace,
    });

    expect(plan.attempts).toBe(2);
    expect(fake.calls()).toBe(2);
    // 成功也要留下踩过的坑，作为排障线索
    expect(plan.issues.length).toBeGreaterThan(0);
    expect(plan.issues[0]?.kind).toBe('unknown-agent');
  });

  it('连续不合格时抛错并带上 issues', async () => {
    const fake = fakeRunner([invalidPlan]);
    await expect(
      generateDag('做一个核心功能', catalog, { runner: fake.runner, workspace }, { maxAttempts: 2 }),
    ).rejects.toThrow(DagGenerationError);

    try {
      await generateDag('做一个核心功能', catalog, { runner: fake.runner, workspace }, { maxAttempts: 2 });
    } catch (error) {
      const failure = error as DagGenerationError;
      expect(failure.issues.length).toBeGreaterThan(0);
      expect(failure.attempts).toBe(2);
    }
  });

  it('输出不是 JSON 时同样重试', async () => {
    const fake = fakeRunner(['我不太确定该怎么拆，先聊聊需求吧。', validPlan]);
    const plan = await generateDag('做一个核心功能', catalog, {
      runner: fake.runner,
      workspace,
    });
    expect(plan.attempts).toBe(2);
  });

  it('能容忍 JSON 被代码块包裹与前后废话', async () => {
    const noisy = `好的，这是计划：\n\`\`\`json\n${validPlan}\n\`\`\`\n以上。`;
    const fake = fakeRunner([noisy]);
    const plan = await generateDag('做一个核心功能', catalog, {
      runner: fake.runner,
      workspace,
    });
    expect(plan.dag.title).toBe('核心功能');
  });

  it('Agent 执行失败时抛错而不是当成空图', async () => {
    const runner: AgentRunner = {
      run: async () => ({ ok: false, exitCode: 2, output: '', error: 'boom' }),
    };
    await expect(
      generateDag('做一个核心功能', catalog, { runner, workspace }, { maxAttempts: 1 }),
    ).rejects.toThrow(/boom/);
  });

  it('目录里没有可调度的 Agent 时明确报错', async () => {
    await expect(
      generateDag('随便什么', [agent({ id: 'x', availability: 'missing' })], {
        runner: fakeRunner([validPlan]).runner,
        workspace,
      }),
    ).rejects.toThrow(/没有可用的 Agent/);
  });

  it('每次规划用独立的临时工作区，不会读到上一轮的交付文件', async () => {
    const prepared: Array<{ runId: string; nodeId: string }> = [];
    const tracking: WorkspacePort = {
      prepare: async (runId, nodeId) => {
        prepared.push({ runId, nodeId });
        return `/tmp/${runId}/${nodeId}`;
      },
      release: async () => {},
    };

    const fake = fakeRunner([validPlan, validPlan]);
    await generateDag('写一个计算器', catalog, {
      runner: fake.runner,
      workspace: tracking,
    });
    await generateDag('写一份 README', catalog, {
      runner: fake.runner,
      workspace: tracking,
    });

    expect(prepared).toHaveLength(2);
    // 目录复用会让上一轮的 .orchestrator-plan.json 被当成这一轮的结果
    expect(prepared[0]?.runId).not.toBe(prepared[1]?.runId);
  });

  it('prompt 里带自查标记与可用白名单', async () => {
    let captured = '';
    const runner: AgentRunner = {
      run: async (request, onChunk) => {
        captured = request.stdin ?? request.argv.join(' ');
        onChunk(validPlan);
        return { ok: true, exitCode: 0, output: validPlan };
      },
    };

    await generateDag('做一个核心功能', catalog, { runner, workspace });
    expect(captured).toContain(PLANNER_PROMPT_MARKER);
    expect(captured).toContain('claude');
    // 未启用的不该出现在白名单里
    expect(captured).not.toContain('trae');
  });
});

it('ACP 规划可从正文提交任务图，校验拒绝时记录重试原因', async () => {
  const prompts: string[] = [];
  const retries: Array<[number, string]> = [];
  const planner = agent({ id: 'dsh-acp', transport: 'acp',
    launch: { bin: 'dsh', args: ['--profile', 'acp'], stdin: true, parser: 'plain' } });
  const runner: AgentRunner = {
    async run(request, onChunk) {
      prompts.push(request.stdin ?? '');
      expect(request.policy).toBe('default');
      const output = prompts.length === 1 ? invalidPlan : validPlan;
      onChunk(output);
      return { ok: true, exitCode: 0, output };
    },
  };

  const result = await generateDag('做一个核心功能', [...catalog, planner], {
    runner, workspace,
    workspaceFiles: async () => ['src/core/index.ts'],
    onRetry: (attempt, reason) => { retries.push([attempt, reason]); },
  }, { agentId: planner.id });
  expect(result.dag.nodes.map((node) => node.id)).toEqual(['impl-core', 'review-core']);
  expect(result.attempts).toBe(2);
  expect(prompts[0]).toContain('只在最终回复提交完整任务图 JSON');
  expect(prompts[0]).toContain('src/core/index.ts');
  expect(prompts[1]).toContain('ghost');
  expect(retries).toHaveLength(1);
  expect(retries[0]).toEqual([1, expect.stringContaining('ghost')]);
});

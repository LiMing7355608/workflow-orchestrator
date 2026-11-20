import { describe, expect, it } from 'vitest';
import type { AgentProfile } from '@orchestrator/core';
import { parseDag } from '../src/schema';
import { validateDag } from '../src/validate';

function agent(partial: Partial<AgentProfile> & Pick<AgentProfile, 'id'>): AgentProfile {
  return {
    label: partial.id,
    vendor: 'test',
    logo: `/logos/${partial.id}.svg`,
    launch: { bin: partial.id, args: [], stdin: false, parser: 'plain' },
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
  agent({ id: 'opencode' }),
  agent({ id: 'trae', enabled: false }),
  agent({ id: 'gone', availability: 'missing' }),
];

function dag(nodes: unknown[]) {
  return parseDag({ title: '测试', nodes });
}

describe('DAG 冻结校验', () => {
  it('合法图通过', () => {
    const result = validateDag(
      dag([
        { id: 'impl-a', type: 'implement', title: '实现', agentId: 'claude', files: ['src/a/**'] },
        { id: 'review-a', type: 'review', title: '审查', dependsOn: ['impl-a'], agentId: 'opencode' },
      ]),
      catalog,
    );
    expect(result.ok).toBe(true);
    expect(result.issues).toHaveLength(0);
  });

  it('依赖指向不存在的节点会被拒绝', () => {
    const result = validateDag(
      dag([{ id: 'impl-a', type: 'implement', title: '实现', agentId: 'claude', dependsOn: ['nope'] }]),
      catalog,
    );
    expect(result.ok).toBe(false);
    expect(result.issues.map((issue) => issue.kind)).toContain('missing-dependency');
  });

  it('有环会被拒绝', () => {
    const result = validateDag(
      dag([
        { id: 'impl-a', type: 'implement', title: 'A', agentId: 'claude', dependsOn: ['impl-b'] },
        { id: 'impl-b', type: 'implement', title: 'B', agentId: 'claude', dependsOn: ['impl-a'] },
      ]),
      catalog,
    );
    expect(result.ok).toBe(false);
    expect(result.issues.map((issue) => issue.kind)).toContain('cycle');
  });

  it('并行节点的文件范围相交会被拒绝', () => {
    const result = validateDag(
      dag([
        { id: 'impl-a', type: 'implement', title: 'A', agentId: 'claude', files: ['src/auth/**'] },
        { id: 'impl-b', type: 'implement', title: 'B', agentId: 'claude', files: ['src/auth/login.ts'] },
      ]),
      catalog,
    );
    expect(result.ok).toBe(false);
    expect(result.issues.map((issue) => issue.kind)).toContain('file-conflict');
  });

  it('有先后关系的节点允许范围重叠', () => {
    const result = validateDag(
      dag([
        { id: 'impl-a', type: 'implement', title: 'A', agentId: 'claude', files: ['src/auth/**'] },
        {
          id: 'impl-b',
          type: 'implement',
          title: 'B',
          agentId: 'claude',
          dependsOn: ['impl-a'],
          files: ['src/auth/**'],
        },
      ]),
      catalog,
    );
    expect(result.ok).toBe(true);
  });

  it('未知 Agent、未启用 Agent、实现节点缺 Agent 都会被拒绝', () => {
    const unknown = validateDag(
      dag([{ id: 'impl-a', type: 'implement', title: 'A', agentId: 'ghost' }]),
      catalog,
    );
    expect(unknown.issues.map((issue) => issue.kind)).toContain('unknown-agent');

    const disabled = validateDag(
      dag([{ id: 'impl-a', type: 'implement', title: 'A', agentId: 'trae' }]),
      catalog,
    );
    expect(disabled.issues.map((issue) => issue.kind)).toContain('disabled-agent');

    const missing = validateDag(
      dag([{ id: 'impl-a', type: 'implement', title: 'A' }]),
      catalog,
    );
    expect(missing.issues.map((issue) => issue.kind)).toContain('missing-agent');
  });

  it('开启 requireInstalled 后未安装的 Agent 会被拦下', () => {
    const result = validateDag(
      dag([{ id: 'impl-a', type: 'implement', title: 'A', agentId: 'gone' }]),
      catalog,
      { requireInstalled: true },
    );
    expect(result.ok).toBe(false);
    expect(result.issues.map((issue) => issue.kind)).toContain('agent-not-installed');
  });

  it('审批与路由节点不需要 Agent', () => {
    const result = validateDag(
      dag([
        { id: 'impl-a', type: 'implement', title: 'A', agentId: 'claude' },
        { id: 'gate', type: 'route', title: '门禁', dependsOn: ['impl-a'], executor: '编排器' },
        { id: 'ok', type: 'approval', title: '审批', dependsOn: ['impl-a'], executor: '老板' },
      ]),
      catalog,
    );
    expect(result.ok).toBe(true);
  });

  it('重复 id 会被拒绝', () => {
    const result = validateDag(
      dag([
        { id: 'impl-a', type: 'implement', title: 'A', agentId: 'claude' },
        { id: 'impl-a', type: 'implement', title: 'A2', agentId: 'claude' },
      ]),
      catalog,
    );
    expect(result.issues.map((issue) => issue.kind)).toContain('duplicate-id');
  });

  it('route 节点可以声明 merge 动作', () => {
    const result = validateDag(
      dag([
        { id: 'impl-a', type: 'implement', title: 'A', agentId: 'claude' },
        {
          id: 'gate',
          type: 'route',
          title: '合并',
          dependsOn: ['impl-a'],
          executor: '编排器',
          action: 'merge',
        },
      ]),
      catalog,
    );
    expect(result.ok).toBe(true);
    expect(result.issues).toHaveLength(0);
  });

  it('非 route 节点声明 action 会被拒绝', () => {
    const result = validateDag(
      dag([
        { id: 'impl-a', type: 'implement', title: 'A', agentId: 'claude', action: 'merge' },
      ]),
      catalog,
    );
    expect(result.ok).toBe(false);
    const issue = result.issues.find((item) => item.kind === 'action-not-allowed');
    expect(issue?.nodeIds).toEqual(['impl-a']);
    expect(issue?.message).toContain('只有 route 节点');
  });

  it('未知 action 在结构校验阶段就被挡下', () => {
    // schema 层拒绝，validate 根本不会被调用
    expect(() =>
      dag([{ id: 'gate', type: 'route', title: '门禁', action: 'rebase' }]),
    ).toThrow();
  });
});

it('交付契约拒绝缺少实际文件或未经审批的计划', () => {
  const manifest = {
    id: 'impl', type: 'implement', title: '计数器', agentId: 'claude',
    files: ['src/**'], deliverables: [{ path: 'src/index.html' }],
    acceptance: ['点击加一会把结果由 0 更新到 1'],
  };
  const approval = { id: 'accept', type: 'approval', title: '人工确认', dependsOn: ['impl'] };
  const merge = { id: 'merge', type: 'route', title: '交付', action: 'merge', dependsOn: ['accept'] };
  const options = { requireDeliverables: true };
  expect(validateDag(dag([manifest, approval, merge]), catalog, options).ok).toBe(true);
  const missing = validateDag(dag([{ ...manifest, deliverables: [] }, { ...merge, dependsOn: ['impl'] }]), catalog, options);
  expect(missing.issues.map((issue) => issue.kind)).toEqual(expect.arrayContaining(['missing-deliverable', 'incomplete-delivery']));
  expect(() => dag([{ ...manifest, deliverables: [{ path: '../index.html' }] }])).toThrow();
});

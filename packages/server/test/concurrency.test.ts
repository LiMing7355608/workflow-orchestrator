import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { NodeFacts, RunFacts } from '@orchestrator/core';
import { pickBatch } from '@orchestrator/core';

/**
 * 并发度是这次运行的属性，不是这台机器的属性。
 *
 * 背景：用户在新建立表单里选的「并行度」原样拼进目标文本交给 Planner，
 * 执行时根本不读它——135 个节点按服务缺省的 2 路派发，排到天荒地老。
 */

function node(id: string, files: string[] = []): NodeFacts {
  return {
    id,
    type: 'implement',
    title: id,
    description: '',
    dependsOn: [],
    files,
    agentId: 'dsh',
    attempts: 0,
    maxAttempts: 3,
  };
}

function run(ids: string[], concurrency?: number): RunFacts {
  return {
    id: 'run-concurrency',
    title: '并发',
    summary: '',
    goal: '',
    workspaceRoot: '',
    ...(concurrency !== undefined ? { concurrency } : {}),
    specVersion: 'v1.0',
    stage: 'execute',
    createdAt: '2026-01-01T00:00:00.000Z',
    frozenAt: '2026-01-01T00:00:00.000Z',
    nodeOrder: ids,
    nodes: Object.fromEntries(ids.map((id) => [id, node(id)])),
  };
}

const IDS = Array.from({ length: 40 }, (_, index) => `n${index + 1}`);

afterEach(async () => {
  // 这个文件不落盘，保留 afterEach 只是为了与其它用例的写法一致
  await Promise.resolve();
});

describe('按运行自己的并发度派发', () => {
  it('运行里写了 16，就一次挑 16 个', () => {
    expect(pickBatch(run(IDS, 16), 16)).toHaveLength(16);
  });

  it('调用方不复用服务级缺省值：同一张图、不同并发，结果不同', () => {
    const facts = run(IDS, 20);
    // 服务缺省是 2，但运行自己说了 20
    const batch = pickBatch(facts, facts.concurrency ?? 2);
    expect(batch).toHaveLength(20);
  });

  it('没有 concurrency 的运行回落到调用方给的值（旧 journal 兼容）', () => {
    expect(pickBatch(run(IDS), 4)).toHaveLength(4);
  });

  it('可挑的节点少于并发度时，按实际数量派发', () => {
    const few = IDS.slice(0, 3);
    expect(pickBatch(run(few, 16), 16)).toHaveLength(3);
  });
});

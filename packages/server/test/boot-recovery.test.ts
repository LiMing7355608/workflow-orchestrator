import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { deriveRunStatus } from '@orchestrator/core';
import { buildApp } from '../src/app.js';

const AT = '2026-11-16T00:00:00.000Z';
const RUN_ID = 'run-boot';

let cleanup: string | undefined;

afterEach(async () => {
  if (cleanup) {
    await rm(cleanup, { recursive: true, force: true }).catch(() => {});
    cleanup = undefined;
  }
});

async function tempLogPath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'orch-boot-'));
  cleanup = dir;
  return join(dir, 'events.jsonl');
}

/**
 * 造一个「事实说在跑、实际没进程」的场景：直接发 node.started 而不发完成，
 * 然后关掉应用——相当于上一轮服务带着在跑的节点被硬杀。
 */
async function seedStaleRun(logPath: string): Promise<void> {
  const { app, store } = await buildApp({ logPath });
  await store.emit({
    type: 'run.created',
    at: AT,
    runId: RUN_ID,
    run: {
      id: RUN_ID,
      title: '重启自愈用例',
      summary: '',
      goal: '验证启动自愈',
      workspaceRoot: '/tmp/target-repo',
      specVersion: 'v1.0',
      stage: 'execute',
      createdAt: AT,
      frozenAt: AT,
      nodeOrder: ['impl-a'],
      nodes: {
        'impl-a': {
          id: 'impl-a',
          type: 'implement',
          title: '甲实现',
          description: '',
          dependsOn: [],
          files: [],
          agentId: 'claude',
          attempts: 0,
          maxAttempts: 3,
        },
      },
    },
  });
  await store.emit({
    type: 'node.started',
    at: AT,
    runId: RUN_ID,
    nodeId: 'impl-a',
  });
  await app.close();
}

describe('启动自愈', () => {
  it('把没有进程在跑的运行中节点收敛成可恢复的中断', async () => {
    const logPath = await tempLogPath();
    await seedStaleRun(logPath);

    // 重新构建应用 = 模拟一次服务重启（没有 registry，说明没有任何活进程）
    const { app, store } = await buildApp({ logPath });

    const node = store.snapshot.runs[RUN_ID]?.nodes['impl-a'];
    expect(node?.startedAt).toBeUndefined();
    expect(node?.finishedAt).toBeUndefined();
    expect(node?.interruptedAt).toBeDefined();
    // 不是失败：它只是没在跑，人可以再点运行
    expect(node?.failureReason).toBeUndefined();

    const health = await app.inject({ method: 'GET', url: '/api/health' });
    expect((health.json() as { recoveredNodes: number }).recoveredNodes).toBe(1);

    await app.close();
  });

  it('重启两次不会把同一次中断记两遍', async () => {
    const logPath = await tempLogPath();
    await seedStaleRun(logPath);

    const first = await buildApp({ logPath });
    expect(first.store.history.length).toBeGreaterThan(0);
    await first.app.close();

    const second = await buildApp({ logPath });
    const health = await second.app.inject({ method: 'GET', url: '/api/health' });
    // 第一次已经收敛过，第二次没有僵死节点可收敛
    expect((health.json() as { recoveredNodes: number }).recoveredNodes).toBe(0);
    await second.app.close();
  });

  /**
   * 拆解是异步的：创建与冻结之间存在一个「有运行、没有图」的窗口。那个窗口
   * 里服务被重启，就再也没人会把它拆完——自愈必须把这件事说成失败，而不是
   * 标成「已暂停」，后者会给出一个续不出任何东西的「继续」按钮。
   */
  it('拆解中途被重启：收敛成失败，不给一个续不上的「继续」', async () => {
    const logPath = await tempLogPath();
    const runId = 'run-planning-boot';

    const booted = await buildApp({ logPath });
    await booted.store.emit({
      type: 'run.created',
      at: AT,
      runId,
      run: {
        id: runId,
        title: '拆到一半被重启',
        summary: '',
        goal: '验证拆解中断',
        workspaceRoot: '/tmp/target-repo',
        specVersion: 'v1.0',
        stage: 'orchestrate',
        createdAt: AT,
        nodeOrder: [],
        nodes: {},
      },
    });
    await booted.app.close();

    const restarted = await buildApp({ logPath });
    const run = restarted.store.snapshot.runs[runId];
    expect(run?.pausedAt).toBeUndefined();
    expect(run?.planFailure?.message).toContain('拆解被中断');
    expect(run ? deriveRunStatus(run) : undefined).toBe('failed');

    const health = await restarted.app.inject({ method: 'GET', url: '/api/health' });
    expect((health.json() as { interruptedPlans: number }).interruptedPlans).toBe(1);
    await restarted.app.close();

    // 再来一次：同一次中断不该被记第二遍
    const again = await buildApp({ logPath });
    const healthAgain = await again.app.inject({ method: 'GET', url: '/api/health' });
    expect(
      (healthAgain.json() as { interruptedPlans: number }).interruptedPlans,
    ).toBe(0);
    await again.app.close();
  });
});

import { existsSync } from 'node:fs';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProcessRegistry, type ProcessRecord } from '../src/registry';
import { DEAD_PID } from './dead-pid';

/**
 * 子进程登记簿的行为测试。
 *
 * 存活性只依赖两个确定性 pid：DEAD_PID（一定不存在）与 process.pid
 * （测试进程自己，一定活着）。任何用例都不会真的 fork 或杀掉进程，
 * 所以 Windows 与 Linux 上跑出来的是同一个结论。
 */

const tempDirs: string[] = [];

async function createRegistry(): Promise<{ registry: ProcessRegistry; dir: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'orchestrator-proc-'));
  tempDirs.push(dir);
  return { registry: new ProcessRegistry(dir), dir };
}

function recordOf(pid: number, overrides: Partial<ProcessRecord> = {}): ProcessRecord {
  return {
    pid,
    runId: 'run-test',
    nodeId: 'impl-core',
    agentId: 'claude',
    bin: 'claude',
    startedAt: new Date().toISOString(),
    ...overrides,
  };
}

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) =>
      rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => {}),
    ),
  );
});

describe('ProcessRegistry', () => {
  it('登记后落盘为 <pid>.json，list 读得回来，注销后消失', async () => {
    const { registry, dir } = await createRegistry();
    const record = recordOf(DEAD_PID);

    await registry.register(record);

    const file = join(dir, `${DEAD_PID}.json`);
    expect(existsSync(file)).toBe(true);
    await expect(registry.list()).resolves.toEqual([record]);

    await registry.unregister(DEAD_PID);

    expect(existsSync(file)).toBe(false);
    await expect(registry.list()).resolves.toEqual([]);
  });

  it('目录还不存在时 list 返回空数组而不是抛错', async () => {
    const { registry, dir } = await createRegistry();
    // 用一个还没创建的子目录：第一次启动就是这个状态
    const fresh = new ProcessRegistry(join(dir, 'processes'));

    await expect(fresh.list()).resolves.toEqual([]);
    await expect(registry.list()).resolves.toEqual([]);
  });

  it('损坏的记录文件被跳过，不影响其余记录', async () => {
    const { registry, dir } = await createRegistry();
    const good = recordOf(DEAD_PID);
    await registry.register(good);

    // 崩溃时正好写了一半，以及一个字段缺失的文件
    await writeFile(join(dir, 'broken.json'), '{"pid": 4242, "runId": "run-', 'utf8');
    await writeFile(join(dir, 'partial.json'), JSON.stringify({ pid: 4243 }), 'utf8');
    // 非 JSON 文件（比如手工放进去的说明）也不该被当成记录
    await writeFile(join(dir, 'notes.txt'), 'hello', 'utf8');

    const listed = await registry.list();

    expect(listed).toEqual([good]);
    // 坏文件不会被顺手删掉：它可能是排查现场的唯一线索
    expect((await readdir(dir)).sort()).toEqual(
      [`${DEAD_PID}.json`, 'broken.json', 'notes.txt', 'partial.json'].sort(),
    );
  });

  it('reap 清掉已退出的记录，保留还活着的（按注入的判定）', async () => {
    const { registry, dir } = await createRegistry();
    const dead = recordOf(DEAD_PID, { nodeId: 'ghost-node' });
    const alive = recordOf(process.pid, { nodeId: 'still-running' });
    await registry.register(dead);
    await registry.register(alive);

    const result = await registry.reap({
      // 当前测试进程当然活着：它代表「另一个 run 仍在推进，别动」的情形
      shouldReap: (record) => record.pid !== process.pid,
    });

    expect(result.removed).toEqual([dead]);
    expect(result.terminated).toEqual([]);
    expect(result.alive).toEqual([alive]);

    // 磁盘状态要跟结果一致
    expect(existsSync(join(dir, `${DEAD_PID}.json`))).toBe(false);
    expect(existsSync(join(dir, `${process.pid}.json`))).toBe(true);
    await expect(registry.list()).resolves.toEqual([alive]);
  });

  it('reap 的 shouldReap 与 terminate 都可注入，默认策略会收掉活着的记录', async () => {
    const { registry, dir } = await createRegistry();
    await registry.register(recordOf(process.pid));

    const terminate = vi.fn<(pid: number) => void>();
    const result = await registry.reap({
      // 默认就是 () => true，这里显式写出来强调「孤儿一律清」是策略而非硬编码
      shouldReap: () => true,
      terminate,
    });

    // terminate 换成桩函数，测试进程不会被真的发信号
    expect(terminate).toHaveBeenCalledWith(process.pid);
    expect(result.terminated.map((record) => record.pid)).toEqual([process.pid]);
    expect(result.alive).toEqual([]);
    expect(existsSync(join(dir, `${process.pid}.json`))).toBe(false);
  });

  it('reap 遇到 terminate 抛错仍把记录清掉（进程刚好在这一瞬间退出）', async () => {
    const { registry } = await createRegistry();
    await registry.register(recordOf(process.pid));

    const result = await registry.reap({
      terminate: () => {
        throw new Error('ESRCH');
      },
    });

    expect(result.terminated.map((record) => record.pid)).toEqual([process.pid]);
    await expect(registry.list()).resolves.toEqual([]);
  });

  it('unregisterTracked 只清本实例登记过的记录', async () => {
    const { registry, dir } = await createRegistry();
    const own = recordOf(DEAD_PID);
    await registry.register(own);

    // 另一个实例（模拟同目录下另一个 server）登记的一条
    const other = recordOf(DEAD_PID + 4, { runId: 'run-other' });
    await new ProcessRegistry(dir).register(other);

    const cleaned = await registry.unregisterTracked();

    expect(cleaned).toEqual([DEAD_PID]);
    // 别人的记录必须留着：删掉它等于抹掉另一个实例正在跑的 Agent 的线索
    await expect(registry.list()).resolves.toEqual([other]);
    // 重复调用是幂等的
    await expect(registry.unregisterTracked()).resolves.toEqual([]);
  });
});

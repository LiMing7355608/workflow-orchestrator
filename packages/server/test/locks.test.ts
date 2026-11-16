import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DataDirLock, type LockInfo } from '../src/locks';
import { DEAD_PID } from './dead-pid';

/**
 * 数据目录锁的行为测试。
 *
 * 只靠两种确定性 pid——当前测试进程（一定活着）与 DEAD_PID（一定不存在）——
 * 来覆盖「有人持锁」和「陈旧锁接管」两条分支，不 fork、不杀进程，
 * Windows 与 Linux 行为一致。
 */

const tempDirs: string[] = [];

async function createLock(): Promise<{ lock: DataDirLock; lockPath: string; dir: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'orchestrator-lock-'));
  tempDirs.push(dir);
  const lockPath = join(dir, 'orchestrator.lock');
  return { lock: new DataDirLock(lockPath), lockPath, dir };
}

async function readLock(lockPath: string): Promise<LockInfo> {
  return JSON.parse(await readFile(lockPath, 'utf8')) as LockInfo;
}

afterEach(async () => {
  // Windows 上句柄释放慢，删不掉就重试几次；临时目录残留不该让测试判红
  await Promise.all(
    tempDirs.splice(0).map((dir) =>
      rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => {}),
    ),
  );
});

describe('DataDirLock', () => {
  it('acquire 成功后锁文件存在，内容带着当前进程 pid', async () => {
    const { lock, lockPath } = await createLock();

    const handle = await lock.acquire({ pid: process.pid, logPath: './data/events.jsonl' });

    expect(existsSync(lockPath)).toBe(true);
    const written = await readLock(lockPath);
    expect(written.pid).toBe(process.pid);
    expect(written.logPath).toBe('./data/events.jsonl');
    // startedAt 是这次 acquire 的时间戳，同时也是这份锁的唯一标识
    expect(Number.isNaN(Date.parse(written.startedAt))).toBe(false);

    // peek 读到的就是落盘的那一份
    await expect(lock.peek()).resolves.toEqual(written);

    await handle.release();
  });

  it('同一进程再开一个实例抢同一把锁会抛错，并在消息里带上持有者信息', async () => {
    const { lock, lockPath } = await createLock();
    const first = await lock.acquire({ pid: process.pid, logPath: './data/events.jsonl' });

    // pid 相同但 startedAt 不同：仍然必须拦住，否则「同一个进程两个实例」
    // 会绕过锁，而它们在内存里是两份互不相干的 store
    const second = new DataDirLock(lockPath);
    await expect(
      second.acquire({ pid: process.pid, logPath: './data/events.jsonl' }),
    ).rejects.toThrow(String(process.pid));

    await first.release();
  });

  it('持有者已经死了的陈旧锁会被接管覆盖', async () => {
    const { lock, lockPath } = await createLock();
    const stale: LockInfo = {
      pid: DEAD_PID,
      startedAt: '2024-01-01T00:00:00.000Z',
      logPath: './data/events.jsonl',
    };
    await writeFile(lockPath, JSON.stringify(stale), 'utf8');

    const handle = await lock.acquire({ pid: process.pid, logPath: './data/events.jsonl' });

    const taken = await readLock(lockPath);
    expect(taken.pid).toBe(process.pid);
    expect(taken.startedAt).not.toBe(stale.startedAt);

    await handle.release();
  });

  it('锁文件是半截 JSON 时当作陈旧锁接管，peek 返回 undefined', async () => {
    const { lock, lockPath } = await createLock();
    // 上一轮崩溃时正好写到一半的情形
    await writeFile(lockPath, '{"pid": 12345, "startedAt": "2024-01-0', 'utf8');

    await expect(lock.peek()).resolves.toBeUndefined();

    const handle = await lock.acquire({ pid: process.pid, logPath: './data/events.jsonl' });
    expect((await readLock(lockPath)).pid).toBe(process.pid);

    await handle.release();
  });

  it('release 之后锁文件消失，重复 release 不报错', async () => {
    const { lock, lockPath } = await createLock();

    const handle = await lock.acquire({ pid: process.pid, logPath: './data/events.jsonl' });
    await handle.release();

    expect(existsSync(lockPath)).toBe(false);
    // 信号连来两次时会重复调 release
    await expect(handle.release()).resolves.toBeUndefined();
  });

  it('release 不会删掉后来者写的锁', async () => {
    const { lock, lockPath } = await createLock();
    const handle = await lock.acquire({ pid: process.pid, logPath: './data/events.jsonl' });

    // 模拟「自己的锁被接管」：内容换成另一份锁（不同 pid + 不同 startedAt）。
    // 场景本身需要两个真实进程才自然发生，这里直接构造结果状态。
    const successor: LockInfo = {
      pid: DEAD_PID,
      startedAt: '2025-06-01T12:00:00.000Z',
      logPath: './data/events.jsonl',
    };
    await writeFile(lockPath, JSON.stringify(successor), 'utf8');

    await handle.release();

    // 比对不上就该放手：删掉对方的锁会让它带着「已经没锁」的错觉继续写日志
    expect(existsSync(lockPath)).toBe(true);
    expect(await readLock(lockPath)).toEqual(successor);
  });
});

import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { OrchestratorEvent } from '@orchestrator/core';
import { EventJournal, resolveJournalRoot } from '../src/journal-file';
import { RunStore } from '../src/store';

/**
 * 分片日志的行为测试。
 *
 * 用真实临时目录而不是内存假文件系统：轮转靠 rename、删除靠 unlink、
 * 字节数靠 stat，这些在假文件系统上全都测不出 Windows 与 POSIX 的差异。
 */

const tempDirs: string[] = [];
const START = Date.parse('2024-05-01T00:00:00.000Z');

async function createRoot(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'orchestrator-journal-'));
  tempDirs.push(dir);
  return dir;
}

/** 造一条事件，`index` 同时决定时间与 nodeId，读回来能直接校验顺序。 */
function event(runId: string, index: number): OrchestratorEvent {
  return {
    type: 'node.started',
    at: new Date(START + index * 1000).toISOString(),
    runId,
    nodeId: `n${index}`,
  };
}

/** 从事件反推序号，顺序断言用得上。 */
function indexOf(item: OrchestratorEvent): number {
  const nodeId = 'nodeId' in item ? item.nodeId : '';
  return Number(nodeId.replace('n', ''));
}

afterEach(async () => {
  // Windows 上句柄释放慢，删不掉就重试；临时目录残留不该让测试判红
  await Promise.all(
    tempDirs.splice(0).map((dir) =>
      rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => {}),
    ),
  );
});

describe('EventJournal', () => {
  it('追加多条后按时间顺序读回', async () => {
    const root = await createRoot();
    const journal = new EventJournal({ rootDir: root });

    for (let index = 0; index < 5; index += 1) {
      await journal.append(event('run-a', index));
    }

    const events = await journal.readRun('run-a');
    expect(events).toHaveLength(5);
    expect(events.map(indexOf)).toEqual([0, 1, 2, 3, 4]);

    // 目录结构：<root>/<runId>/events.jsonl
    expect(await readdir(join(root, 'run-a'))).toEqual(['events.jsonl']);
    expect(await journal.shards('run-a')).toEqual([join(root, 'run-a', 'events.jsonl')]);
  });

  it('超过 maxBytesPerShard 时轮转，读回仍然完整且有序', async () => {
    const root = await createRoot();
    // 单条事件约 85 字节，200 字节的阈值保证每两三条就得换分片
    const journal = new EventJournal({ rootDir: root, maxBytesPerShard: 200, maxShards: 5 });

    for (let index = 0; index < 9; index += 1) {
      await journal.append(event('run-b', index));
    }

    const shards = await journal.shards('run-b');
    expect(shards.length).toBeGreaterThan(1);
    // 最后一个永远是当前写入的那个分片
    expect(shards.at(-1)).toBe(join(root, 'run-b', 'events.jsonl'));

    const events = await journal.readRun('run-b');
    expect(events).toHaveLength(9);
    expect(events.map(indexOf)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it('超过 maxShards 时最旧的分片被删掉', async () => {
    const root = await createRoot();
    const journal = new EventJournal({ rootDir: root, maxBytesPerShard: 200, maxShards: 2 });

    for (let index = 0; index < 15; index += 1) {
      await journal.append(event('run-c', index));
    }

    const files = (await readdir(join(root, 'run-c'))).sort();
    // 当前分片 + 最多 2 个归档，永远不会有 events.3.jsonl
    expect(files).toContain('events.jsonl');
    expect(files).toContain('events.1.jsonl');
    expect(files).toContain('events.2.jsonl');
    expect(files).not.toContain('events.3.jsonl');

    const events = await journal.readRun('run-c');
    // 尾部一定完整，头部被裁掉——这正是「有界的只增日志」的代价
    expect(events.map(indexOf).at(-1)).toBe(14);
    const first = events.map(indexOf)[0] ?? -1;
    expect(first).toBeGreaterThan(0);
    expect(events.map(indexOf)).toEqual(
      Array.from({ length: 15 - first }, (_, offset) => first + offset),
    );
  });

  it('损坏行被跳过而不是抛异常', async () => {
    const root = await createRoot();
    const journal = new EventJournal({ rootDir: root });

    await journal.append(event('run-d', 0));
    await journal.append(event('run-d', 1));

    // 模拟写到一半被 kill：追加半截 JSON 与一行纯垃圾
    const shardPath = join(root, 'run-d', 'events.jsonl');
    const intact = await readFile(shardPath, 'utf8');
    await writeFile(
      shardPath,
      `${intact}{"type":"node.started","at":"2024-05-01T00:00:00.000Z","runId":"run-d"\nnonsense\n`,
      'utf8',
    );
    await journal.append(event('run-d', 2));

    const events = await journal.readRun('run-d');
    expect(events.map(indexOf)).toEqual([0, 1, 2]);
  });

  it('旧的单文件 events.jsonl 能被 readAll 按 runId 分组', async () => {
    const root = await createRoot();
    // 升级前的布局：全部 run 混在一个文件里
    await writeFile(
      join(root, 'events.jsonl'),
      [
        event('legacy-a', 0),
        event('legacy-b', 0),
        event('legacy-a', 1),
      ]
        .map((item) => `${JSON.stringify(item)}\n`)
        .join(''),
      'utf8',
    );

    const journal = new EventJournal({ rootDir: root });
    // 升级后新写入的 run 走分片
    await journal.append(event('fresh-c', 0));

    const grouped = await journal.readAll();
    expect([...grouped.keys()].sort()).toEqual(['fresh-c', 'legacy-a', 'legacy-b']);
    expect(grouped.get('legacy-a')?.map(indexOf)).toEqual([0, 1]);
    expect(grouped.get('legacy-b')?.map(indexOf)).toEqual([0]);
    expect(grouped.get('fresh-c')?.map(indexOf)).toEqual([0]);

    // 单个 run 的读回也要带上旧文件里的同 run 事件
    expect((await journal.readRun('legacy-a')).map(indexOf)).toEqual([0, 1]);

    // 旧文件只读不搬：内容原样留在原地
    const legacy = await readFile(join(root, 'events.jsonl'), 'utf8');
    expect(legacy.split('\n').filter(Boolean)).toHaveLength(3);
  });

  it('同一 run 的并发 append 不撕裂，读回条数与顺序都对', async () => {
    const root = await createRoot();
    const journal = new EventJournal({ rootDir: root });

    // 并发发出，落盘顺序由每个 run 的串行队列决定
    await Promise.all(
      Array.from({ length: 30 }, (_, index) => journal.append(event('run-e', index))),
    );

    const events = await journal.readRun('run-e');
    expect(events).toHaveLength(30);
    expect(new Set(events.map(indexOf)).size).toBe(30);
  });

  it('resolveJournalRoot 把旧的 .jsonl 路径折算成目录', async () => {
    expect(resolveJournalRoot(join('data', 'events.jsonl'))).toBe('data');
    expect(resolveJournalRoot('data')).toBe('data');
  });

  it('run 目录不存在时读回空数组，不抛出', async () => {
    const root = await createRoot();
    await mkdir(join(root, 'other'), { recursive: true });
    const journal = new EventJournal({ rootDir: root });

    expect(await journal.readRun('missing')).toEqual([]);
    expect(await journal.shards('missing')).toEqual([]);
    expect([...(await journal.readAll()).keys()]).toEqual([]);
  });
});

/**
 * 升级路径的回归：旧单文件 + 新分片共存时，重启两次不能把事件读重复。
 * 这是 `readAll` 「旧文件只读不搬」策略唯一的风险点，必须钉住。
 */
describe('RunStore 跨重启的旧数据兼容', () => {
  it('旧单文件里的 run 重启后条数不变，新事件只落在分片里', async () => {
    const root = await createRoot();
    await writeFile(
      join(root, 'events.jsonl'),
      [event('run-old', 0), event('run-old', 1)]
        .map((item) => `${JSON.stringify(item)}\n`)
        .join(''),
      'utf8',
    );

    const first = await RunStore.open(join(root, 'events.jsonl'), () => []);
    expect(first.history).toHaveLength(2);
    await first.emit(event('run-old', 2));
    expect(first.eventsForRun('run-old')).toHaveLength(3);
    // 未知 run 不该拿到别人的事件
    expect(first.eventsForRun('run-other')).toEqual([]);

    // 重启一次：旧文件 2 条 + 分片 1 条，不能变成 5 条
    const second = await RunStore.open(join(root, 'events.jsonl'), () => []);
    expect(second.history).toHaveLength(3);
    expect(second.eventsForRun('run-old').map(indexOf)).toEqual([0, 1, 2]);

    // 再重启一次也一样
    const third = await RunStore.open(join(root, 'events.jsonl'), () => []);
    expect(third.eventsForRun('run-old')).toHaveLength(3);
  });
});

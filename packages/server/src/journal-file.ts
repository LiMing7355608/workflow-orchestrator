/**
 * 分片事件日志。
 *
 * JSONL 只增不减是对的——它是唯一事实源，改一行就等于篡改历史。但「只增」
 * 不等于「一个文件装到底」：单个 run 跑几天，`events.jsonl` 会长到几百 MB，
 * 每次追加都要打开一个大文件，读回来还得整份进内存。
 *
 * 因此这里按 run 分目录、按体积分片：
 *
 *   <root>/<runId>/events.jsonl       当前写入的分片
 *   <root>/<runId>/events.1.jsonl     上一片（数字越大越旧）
 *   <root>/<runId>/events.2.jsonl
 *
 * 超出活跃归档数量的分片转入 archive/。所有分片都参与状态回放。
 */
import type { Dirent } from 'node:fs';
import {
  appendFile,
  mkdir,
  readdir,
  readFile,
  rename,
  stat,
} from 'node:fs/promises';
import { basename, dirname, extname, join } from 'node:path';
import type { OrchestratorEvent } from '@orchestrator/core';
import { silentLog, type LogSink } from './log.js';

export interface JournalOptions {
  /** 根目录，每个 run 一个子目录 */
  rootDir: string;
  /** 单个分片的最大字节数，超过就轮转 */
  maxBytesPerShard?: number;
  /** 每个 run 保留在活跃日志目录的归档分片数 */
  maxShards?: number;
  /** 诊断与降级告警的出口，不传则静默 */
  log?: LogSink;
}

const DEFAULT_MAX_BYTES_PER_SHARD = 8 * 1024 * 1024;
const DEFAULT_MAX_SHARDS = 5;

/** 当前写入的分片名。数字分片才是归档，0 不参与命名。 */
const ACTIVE_SHARD = 'events.jsonl';

/** 归档分片名：数字越大越旧。 */
function archiveShard(index: number): string {
  return `events.${index}.jsonl`;
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT';
}

/**
 * 解析一行 JSONL。
 *
 * 校验 `runId` / `at` / `type` 三个必备字段：写到一半被 kill 的行是残缺
 * JSON，而历史上也出现过半截对象。缺 `runId` 的事件无法归组，干脆按损坏行处理。
 */
function parseLine(line: string): OrchestratorEvent | undefined {
  const trimmed = line.trim();
  if (!trimmed) {
    return undefined;
  }
  try {
    const value: unknown = JSON.parse(trimmed);
    if (typeof value !== 'object' || value === null) {
      return undefined;
    }
    const candidate = value as Record<string, unknown>;
    if (
      typeof candidate['runId'] !== 'string' ||
      typeof candidate['at'] !== 'string' ||
      typeof candidate['type'] !== 'string'
    ) {
      return undefined;
    }
    return value as OrchestratorEvent;
  } catch {
    // 损坏行跳过，不让一行坏数据把整次运行的读回全部葬送
    return undefined;
  }
}

async function readShardEvents(filePath: string): Promise<OrchestratorEvent[]> {
  let raw: string;
  try {
    raw = await readFile(filePath, 'utf8');
  } catch (error) {
    if (isMissing(error)) {
      return [];
    }
    throw error;
  }

  const events: OrchestratorEvent[] = [];
  for (const line of raw.split('\n')) {
    const event = parseLine(line);
    if (event) {
      events.push(event);
    }
  }
  return events;
}

export class EventJournal {
  private readonly rootDir: string;
  private readonly maxBytesPerShard: number;
  private readonly maxShards: number;
  private readonly log: LogSink;

  /**
   * 每个 run 一条串行队列。
   *
   * 同一次运行的事件必须按调用顺序落盘：并发 append 会让两个 `appendFile`
   * 交错在同一个文件偏移上，写出「A 的前半段 + B + A 的后半段」这种撕裂行，
   * 事后无法重放。单进程内排队就够了——跨进程由数据目录锁保证（`DataDirLock`），
   * 两个 server 同时写这件事在 main.ts 里就已经被拦住了。
   */
  private readonly queues = new Map<string, Promise<void>>();

  /** 当前分片已写字节数的内存估计，省掉每次追加前的一次 stat */
  private readonly shardBytes = new Map<string, number>();
  private readonly archiveSequence = new Map<string, number>();

  constructor(options: JournalOptions) {
    this.rootDir = options.rootDir;
    // 0 会让轮转失去意义（每写一条都是新分片），下限钉在 1
    this.maxBytesPerShard = Math.max(
      1,
      options.maxBytesPerShard ?? DEFAULT_MAX_BYTES_PER_SHARD,
    );
    this.maxShards = Math.max(1, options.maxShards ?? DEFAULT_MAX_SHARDS);
    this.log = options.log ?? silentLog;
  }

  /** 追加一条事件，写到 `<root>/<runId>/events.jsonl`，超限则轮转。 */
  async append(event: OrchestratorEvent): Promise<void> {
    await this.enqueue(event.runId, async () => {
      const runDir = this.runDir(event.runId);
      await mkdir(runDir, { recursive: true });

      const line = `${JSON.stringify(event)}\n`;
      const bytes = Buffer.byteLength(line, 'utf8');
      const used = await this.usedBytes(event.runId, runDir);

      // 空文件不轮转：一条事件本身超过上限时也得先写进去，否则会陷入
      // 「永远轮转、永远写不下去」的死循环
      const rotateFirst = used > 0 && used + bytes > this.maxBytesPerShard;
      if (rotateFirst) {
        await this.rotate(event.runId, runDir);
      }

      await appendFile(join(runDir, ACTIVE_SHARD), line, 'utf8');
      this.shardBytes.set(event.runId, (rotateFirst ? 0 : used) + bytes);
    });
  }

  /** 读回一次运行的全部事件（含旧单文件里的同 run 事件），按时间顺序拼接。 */
  async readRun(runId: string): Promise<OrchestratorEvent[]> {
    const legacy = (await this.readLegacy()).filter(
      (event) => event.runId === runId,
    );
    return [...legacy, ...(await this.readShards(runId))];
  }

  /** 载入全部运行的事件，返回按 runId 分组的 Map。 */
  async readAll(): Promise<Map<string, OrchestratorEvent[]>> {
    const grouped = new Map<string, OrchestratorEvent[]>();
    const add = (runId: string, event: OrchestratorEvent): void => {
      const bucket = grouped.get(runId);
      if (bucket) {
        bucket.push(event);
      } else {
        grouped.set(runId, [event]);
      }
    };

    // 旧数据优先：单文件里的时间戳一定早于分片里的（升级前 vs 升级后）
    for (const event of await this.readLegacy()) {
      add(event.runId, event);
    }

    for (const runId of await this.listRunDirs()) {
      for (const event of await this.readShards(runId)) {
        add(runId, event);
      }
    }
    return grouped;
  }

  /** 某个 run 已用的分片列表（从旧到新），用于诊断。归档与当前分片都在内。 */
  async shards(runId: string): Promise<string[]> {
    const runDir = this.runDir(runId);
    const indices = await this.archiveIndices(runDir);
    const coldDir = join(runDir, 'archive');
    const archived = await this.archiveIndices(coldDir);
    const paths = [
      ...archived.sort((left, right) => left - right).map((index) => join(coldDir, archiveShard(index))),
      ...indices.sort((left, right) => right - left).map((index) => join(runDir, archiveShard(index))),
    ];

    const active = join(runDir, ACTIVE_SHARD);
    try {
      await stat(active);
      paths.push(active);
    } catch (error) {
      if (!isMissing(error)) {
        throw error;
      }
    }
    return paths;
  }

  /* ---------------------------------------------------------------- *
   * 内部实现
   * ---------------------------------------------------------------- */

  private runDir(runId: string): string {
    return join(this.rootDir, runId);
  }

  /** 把任务接到该 run 的队尾；前一个失败不阻断后续追加。 */
  private enqueue(runId: string, task: () => Promise<void>): Promise<void> {
    const previous = this.queues.get(runId) ?? Promise.resolve();
    const next = previous.then(task, task);
    const settled = next.then(
      () => undefined,
      () => undefined,
    );
    this.queues.set(runId, settled);
    // 队列尾部落定后收掉自己的表项，长期运行不会随 run 数量累积空 Promise
    void settled.then(() => {
      if (this.queues.get(runId) === settled) {
        this.queues.delete(runId);
      }
    });
    return next;
  }

  private async usedBytes(runId: string, runDir: string): Promise<number> {
    const cached = this.shardBytes.get(runId);
    if (cached !== undefined) {
      return cached;
    }
    let bytes = 0;
    try {
      bytes = (await stat(join(runDir, ACTIVE_SHARD))).size;
    } catch (error) {
      if (!isMissing(error)) {
        throw error;
      }
    }
    this.shardBytes.set(runId, bytes);
    return bytes;
  }

  /**
   * 归档分片编号，从大到小（大 = 旧）。
   *
   * 目录里只认 `events.<n>.jsonl`，其他文件（比如用户自己丢进来的备注）不碰。
   */
  private async archiveIndices(runDir: string): Promise<number[]> {
    let names: string[];
    try {
      names = await readdir(runDir);
    } catch (error) {
      if (isMissing(error)) {
        return [];
      }
      throw error;
    }

    const indices: number[] = [];
    for (const name of names) {
      const matched = /^events\.(\d+)\.jsonl$/.exec(name);
      if (matched?.[1]) {
        indices.push(Number(matched[1]));
      }
    }
    return indices;
  }

  /** 保留最早的事实，活动分片从新到旧继续使用原来的编号。 */
  private async rotate(runId: string, runDir: string): Promise<void> {
    const coldDir = join(runDir, 'archive');
    let sequence = this.archiveSequence.get(runId);
    if (sequence === undefined) {
      sequence = Math.max(0, ...(await this.archiveIndices(coldDir)));
    }
    await mkdir(coldDir, { recursive: true });

    const indices = await this.archiveIndices(runDir);
    for (const index of indices.sort((left, right) => right - left)) {
      const source = join(runDir, archiveShard(index));
      if (index >= this.maxShards) {
        const target = join(coldDir, archiveShard(sequence + 1));
        await rename(source, target);
        sequence += 1;
        this.archiveSequence.set(runId, sequence);
      } else {
        await rename(source, join(runDir, archiveShard(index + 1)));
      }
    }
    await rename(join(runDir, ACTIVE_SHARD), join(runDir, archiveShard(1)));
  }

  /**
   * 读旧版单文件日志（`<root>/events.jsonl`）。
   *
   * 升级不能读不到历史：用户机器上那份单文件里躺着全部旧 run，丢它等于丢事实。
   * 这里只读不搬——搬迁会重写事实源，一旦中途失败就两头不完整。
   */
  private async readLegacy(): Promise<OrchestratorEvent[]> {
    return readShardEvents(join(this.rootDir, ACTIVE_SHARD));
  }

  private async readShards(runId: string): Promise<OrchestratorEvent[]> {
    const events: OrchestratorEvent[] = [];
    for (const path of await this.shards(runId)) {
      events.push(...(await readShardEvents(path)));
    }
    return events;
  }

  /** rootDir 下真正装着 run 的子目录。 */
  private async listRunDirs(): Promise<string[]> {
    let entries: Dirent[];
    try {
      entries = await readdir(this.rootDir, { withFileTypes: true });
    } catch (error) {
      if (isMissing(error)) {
        return [];
      }
      throw error;
    }
    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  }
}

/**
 * 把旧配置里的日志路径折算成分片根目录。
 *
 * `EVENT_LOG_PATH` 之类的历史配置指向一个具体文件（`./data/events.jsonl`），
 * 直接当目录用会变成 `./data/events.jsonl/<runId>/...` 这种荒唐路径。
 * 因此凡是 `.jsonl` 结尾的路径一律取其所在目录当根，旧文件正好同名，
 * `readAll` 会自动把它当旧数据读进来。
 */
export function resolveJournalRoot(logPath: string): string {
  const name = basename(logPath);
  if (extname(name) === '.jsonl') {
    return dirname(logPath);
  }
  return logPath;
}

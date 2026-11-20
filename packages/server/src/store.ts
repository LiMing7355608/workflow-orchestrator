import { readdir } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import {
  EventBus,
  emptyState,
  reduce,
  replay,
  type OrchestratorEvent,
  type ProjectState,
} from '@orchestrator/core';
import {
  EventJournal,
  resolveJournalRoot,
  type JournalOptions,
} from './journal-file.js';
import { silentLog, type LogSink } from './log.js';
import {
  assertRunId,
  isMissing,
  ownedPath,
  projectRunPath,
  projectRunsRoot,
  readOptional,
  writeAtomic,
} from './project-files.js';

const INDEX_DIR = '.project-runs';
type RunLocation = { workspaceRoot?: string; deleted?: true };

export interface RunStoreOptions {
  /** 分片参数，只覆盖需要的项 */
  journal?: Partial<Pick<JournalOptions, 'maxBytesPerShard' | 'maxShards'>>;
  /** 日志出口，由 app.ts 注入；不传则静默 */
  log?: LogSink;
}

/** 没有该 run 的事件时返回的常量，避免每次分配空数组 */
const NO_EVENTS: readonly OrchestratorEvent[] = Object.freeze([]);

/**
 * 事实存储：分片 JSONL 事件日志是唯一事实源，内存投影只是读缓存。
 *
 * 写入路径只有一个 `emit`：先落盘再归约再广播。违反这个顺序会出现
 * 「界面看到了、重启后没了」的情况，所以顺序不商量。
 *
 * 内存里按 run 分组存事件。此前读接口每次都把「全量历史」传给 derive，
 * run 一多就退化成 O(总事件数 × 请求数)；分组之后单次请求只碰自己那个 run。
 */
export class RunStore {
  private constructor(
    private readonly journal: EventJournal,
    private readonly indexRoot: string,
    private readonly locations: Map<string, RunLocation>,
    private readonly projectJournal: (root: string) => EventJournal,
    private state: ProjectState,
    /** 全量事件，追加顺序，`history` 与 /api/health 用 */
    private readonly all: OrchestratorEvent[],
    /** runId → 该 run 的事件，顺序与落盘顺序一致 */
    private readonly byRun: Map<string, OrchestratorEvent[]>,
    readonly bus: EventBus,
  ) {}

  /**
   * 打开存储。
   *
   * `logPath` 保留原名是为了兼容既有调用方与 `EVENT_LOG_PATH`：传文件路径
   * （`./data/events.jsonl`）或目录都行，文件路径取其所在目录当分片根，
   * 那份旧文件本身会被当成历史数据读进来。
   */
  static async open(
    logPath: string,
    seed: (now: Date) => OrchestratorEvent[] = () => [],
    options: RunStoreOptions = {},
  ): Promise<RunStore> {
    const log = options.log ?? silentLog;
    const indexRoot = resolveJournalRoot(logPath);
    const createJournal = (rootDir: string) => new EventJournal({ rootDir, ...options.journal, log });
    const journal = createJournal(indexRoot);
    const journals = new Map<string, EventJournal>();
    const projectJournal = (root: string) => {
      let local = journals.get(root);
      if (!local) {
        local = createJournal(projectRunsRoot(root));
        journals.set(root, local);
      }
      return local;
    };

    const grouped = await journal.readAll();
    const locations = new Map<string, RunLocation>();
    const indexDir = await ownedPath(indexRoot, INDEX_DIR);
    const files = await readdir(indexDir, { withFileTypes: true }).catch((error: unknown) => {
      if (isMissing(error)) return [];
      throw error;
    });
    for (const entry of files) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
      const runId = entry.name.slice(0, -5);
      try {
        assertRunId(runId);
        const path = await ownedPath(indexRoot, INDEX_DIR, entry.name);
        const location = JSON.parse((await readOptional(path)) ?? 'null') as RunLocation | null;
        if (!location || (location.workspaceRoot && !isAbsolute(location.workspaceRoot))) continue;
        locations.set(runId, location);
        if (location.deleted) {
          grouped.delete(runId);
          if (location.workspaceRoot) {
            await projectRunPath(location.workspaceRoot, runId);
            await projectJournal(location.workspaceRoot).removeRun(runId);
          }
          await journal.removeRun(runId);
        } else if (location.workspaceRoot) {
          await projectRunPath(location.workspaceRoot, runId);
          const events = await projectJournal(location.workspaceRoot).readRun(runId);
          if (events.length > 0) grouped.set(runId, events);
        }
      } catch (error) {
        log.warn('项目运行目录暂时无法读取', { runId, error });
      }
    }

    // 回放以每条运行的落盘顺序为准。
    const events = [...grouped.values()].flat();

    const loaded = events.length > 0 || locations.size > 0 ? events : seed(new Date());
    if (events.length === 0 && loaded.length > 0) {
      // 首次启动才播种：已有事实时再写一遍示例运行等于伪造历史
      log.debug('事件日志为空，写入播种事件', { count: loaded.length });
      for (const event of loaded) {
        await journal.append(event);
      }
    }

    const all: OrchestratorEvent[] = [];
    const byRun = new Map<string, OrchestratorEvent[]>();
    for (const event of loaded) {
      all.push(event);
      const bucket = byRun.get(event.runId);
      if (bucket) {
        bucket.push(event);
      } else {
        byRun.set(event.runId, [event]);
      }
    }

    return new RunStore(journal, indexRoot, locations, projectJournal, replay(loaded), all, byRun, new EventBus());
  }

  get snapshot(): ProjectState {
    return this.state;
  }

  /** 全量事件，兼容既有读法；逐 run 读取请用 `eventsForRun`。 */
  get history(): readonly OrchestratorEvent[] {
    return this.all;
  }

  /** 某个 run 的事件（只读，顺序即落盘顺序）。未知 run 返回空数组。 */
  eventsForRun(runId: string): readonly OrchestratorEvent[] {
    return this.byRun.get(runId) ?? NO_EVENTS;
  }

  projectWorkspace(runId: string): string | undefined {
    return this.locations.get(runId)?.workspaceRoot;
  }

  async registerProjectRun(runId: string, workspaceRoot: string): Promise<void> {
    const existing = this.locations.get(runId);
    if (existing?.deleted || (existing && existing.workspaceRoot !== workspaceRoot)) {
      throw new Error('运行编号已占用');
    }
    await projectRunPath(workspaceRoot, runId, 'events.jsonl');
    const location = { workspaceRoot };
    await this.writeLocation(runId, location);
    this.locations.set(runId, location);
  }

  async removeRun(runId: string, at: string): Promise<void> {
    const previous = this.locations.get(runId);
    const location: RunLocation = { ...previous, deleted: true };
    if (location.workspaceRoot) await projectRunPath(location.workspaceRoot, runId);
    await this.writeLocation(runId, location);
    this.locations.set(runId, location);
    try {
      await this.journal.removeRun(runId);
      if (location.workspaceRoot) await this.projectJournal(location.workspaceRoot).removeRun(runId);
    } catch (error) {
      await this.writeLocation(runId, previous ?? {});
      this.locations.set(runId, previous ?? {});
      throw error;
    }

    const deleted: OrchestratorEvent = { type: 'run.deleted', runId, at };
    this.state = reduce(this.state, deleted);
    this.byRun.delete(runId);
    for (let i = this.all.length - 1; i >= 0; i--) {
      if (this.all[i]?.runId === runId) this.all.splice(i, 1);
    }
    this.bus.publish(deleted);
  }

  private async writeLocation(runId: string, location: RunLocation): Promise<void> {
    assertRunId(runId);
    const path = await ownedPath(this.indexRoot, INDEX_DIR, `${runId}.json`);
    await writeAtomic(path, JSON.stringify(location));
  }

  /** 唯一写入口。落盘 → 归约 → 广播，顺序不可调换。 */
  async emit(event: OrchestratorEvent): Promise<void> {
    const location = this.locations.get(event.runId);
    if (location?.deleted) return;
    const journal = location?.workspaceRoot ? this.projectJournal(location.workspaceRoot) : this.journal;
    await journal.append(event);
    this.state = reduce(this.state, event);
    this.all.push(event);

    const bucket = this.byRun.get(event.runId);
    if (bucket) {
      bucket.push(event);
    } else {
      this.byRun.set(event.runId, [event]);
    }

    this.bus.publish(event);
  }

  /** 把一批事件按顺序写入。中途失败时前面的已落盘，重放仍然自洽。 */
  async emitAll(events: OrchestratorEvent[]): Promise<void> {
    for (const event of events) {
      await this.emit(event);
    }
  }
}

export { emptyState };

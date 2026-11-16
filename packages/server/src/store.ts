import {
  EventBus,
  emptyState,
  reduce,
  replay,
  type OrchestratorEvent,
  type ProjectState,
} from '@orchestrator/core';
import { appendEvent, loadEvents } from '@orchestrator/core/node';

/**
 * 事实存储：JSONL 事件日志是唯一事实源，内存投影只是读缓存。
 *
 * 写入路径只有一个 `emit`：先落盘再归约再广播。违反这个顺序会出现
 * 「界面看到了、重启后没了」的情况，所以顺序不商量。
 */
export class RunStore {
  private constructor(
    private readonly logPath: string,
    private state: ProjectState,
    private events: OrchestratorEvent[],
    readonly bus: EventBus,
  ) {}

  static async open(
    logPath: string,
    seed: (now: Date) => OrchestratorEvent[] = () => [],
  ): Promise<RunStore> {
    let events = await loadEvents(logPath);

    if (events.length === 0) {
      events = seed(new Date());
      for (const event of events) {
        await appendEvent(logPath, event);
      }
    }

    return new RunStore(logPath, replay(events), events, new EventBus());
  }

  get snapshot(): ProjectState {
    return this.state;
  }

  get history(): readonly OrchestratorEvent[] {
    return this.events;
  }

  /** 唯一写入口。落盘 → 归约 → 广播，顺序不可调换。 */
  async emit(event: OrchestratorEvent): Promise<void> {
    await appendEvent(this.logPath, event);
    this.state = reduce(this.state, event);
    // approval.requested 的记录追加由 replay 的 apply 负责，这里补齐同一行为
    if (event.type === 'approval.requested') {
      this.state = {
        ...this.state,
        approvals: [...this.state.approvals, event.record],
      };
    }
    this.events.push(event);
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

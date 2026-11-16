import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { killProcessTree } from './process-tree.js';
import { silentLog } from './log.js';

/**
 * 子进程登记簿。
 *
 * server 崩掉重启时，上一轮用 spawn 拉起的 Agent 进程仍然活着，但父进程
 * 的手柄已经没了——它们变成没人收的孤儿，继续占着 worktree、继续烧 token。
 * 登记簿把「pid → 属于哪个 run 的哪个节点」落到磁盘上，重启后能把这些
 * 孤儿认出来并处理掉。
 *
 * 刻意用「一个 pid 一个 JSON 文件」而不是一张总表：并发登记不加锁也不会
 * 互相覆盖，单个文件写坏只丢一条记录。
 */

export interface ProcessRecord {
  pid: number;
  runId: string;
  nodeId: string;
  agentId: string;
  bin: string;
  startedAt: string;
}

export interface ReapOptions {
  /**
   * 活着但仍在登记簿里的进程，要不要收掉。
   *
   * 默认一律收（启动时看到的都是上一轮遗留的孤儿）；做成可注入是为了
   * 将来能按 run 状态精细判断——比如「这个 run 还在推进，别动它的进程」。
   */
  shouldReap?: (record: ProcessRecord) => boolean;
  /** 终止手段。默认发 SIGTERM，测试里可注入成不真杀的实现 */
  terminate?: (pid: number) => void | Promise<void>;
}

export interface ReapResult {
  /** 进程已不在，记录被清掉 */
  removed: ProcessRecord[];
  /** 进程还活着，按 shouldReap 判定收掉记录 */
  terminated: ProcessRecord[];
  /** 进程还活着且按策略保留 */
  alive: ProcessRecord[];
}

/**
 * 存活性判断统一收口在这里。
 *
 * 只有 ESRCH 才判死；EPERM（进程属于别人）与其它 errno 一律判活——
 * 误判活着的代价是启动时多打印一条孤儿，误判死亡的代价是去动别人的进程。
 */
function isAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

function isProcessRecord(value: unknown): value is ProcessRecord {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate['pid'] === 'number' &&
    typeof candidate['runId'] === 'string' &&
    typeof candidate['nodeId'] === 'string' &&
    typeof candidate['agentId'] === 'string' &&
    typeof candidate['bin'] === 'string' &&
    typeof candidate['startedAt'] === 'string'
  );
}

export class ProcessRegistry {
  /** 本实例登记过、尚未注销的 pid。退出时只收拾这些，别去动别人的记录 */
  private readonly tracked = new Set<number>();

  constructor(private readonly dir: string) {}

  private fileOf(pid: number): string {
    return join(this.dir, `${pid}.json`);
  }

  /** 登记一个子进程，落盘为 <dir>/<pid>.json */
  async register(record: ProcessRecord): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    await writeFile(this.fileOf(record.pid), `${JSON.stringify(record, null, 2)}\n`, 'utf8');
    this.tracked.add(record.pid);
  }

  /** 注销。文件本来就不存在时静默成功——反复注销不该成为故障 */
  async unregister(pid: number): Promise<void> {
    this.tracked.delete(pid);
    await rm(this.fileOf(pid), { force: true }).catch(() => {});
  }

  /** 列出全部记录。目录不存在视为「一条都没有」；单个文件损坏整体不崩 */
  async list(): Promise<ProcessRecord[]> {
    let names: string[];
    try {
      names = await readdir(this.dir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return [];
      }
      throw error;
    }

    const records: ProcessRecord[] = [];
    for (const name of names) {
      if (!name.endsWith('.json')) {
        continue;
      }
      try {
        // 剥 BOM：记录文件可能被人用编辑器改过，带 BOM 会让 JSON.parse 失败，
        // 从而把一条完全有效的记录当成损坏文件跳过
        const raw = (await readFile(join(this.dir, name), 'utf8')).replace(/^\uFEFF/, '');
        const parsed: unknown = JSON.parse(raw);
        if (isProcessRecord(parsed)) {
          records.push(parsed);
        }
      } catch {
        // 半截 JSON、读不了的权限问题：跳过这一条。
        // 一条读不出来的记录不该让整个回收流程停摆。
      }
    }
    return records;
  }

  /**
   * 回收孤儿。
   *
   * 判定顺序：进程不在了 → 直接删记录；还在且 shouldReap 同意 → 尝试终止
   * 再删记录；还在但拒绝回收 → 原样留着，交给调用方决定。
   * 终止失败（进程刚好在这瞬间退出）也当成功：记录本来就没有保留价值了。
   */
  async reap(options: ReapOptions = {}): Promise<ReapResult> {
    const shouldReap = options.shouldReap ?? ((): boolean => true);
    // 默认走整树终止：Windows 上 Agent 是通过 cmd.exe /c 拉起的，
    // 只对 cmd.exe 发信号会留下还在跑的 node 子进程，而记录已被删掉，
    // 从此再也管不到它——那正是「停了但还在烧」的来源。
    const terminate =
      options.terminate ??
      ((pid: number): Promise<void> =>
        killProcessTree(pid, { force: true, log: silentLog }));

    const result: ReapResult = { removed: [], terminated: [], alive: [] };

    for (const record of await this.list()) {
      if (!isAlive(record.pid)) {
        await rm(this.fileOf(record.pid), { force: true }).catch(() => {});
        this.tracked.delete(record.pid);
        result.removed.push(record);
        continue;
      }

      if (!shouldReap(record)) {
        result.alive.push(record);
        continue;
      }

      try {
        await terminate(record.pid);
      } catch {
        // 进程在判定与终止之间正好退出，属于正常竞态
      }
      await rm(this.fileOf(record.pid), { force: true }).catch(() => {});
      this.tracked.delete(record.pid);
      result.terminated.push(record);
    }

    return result;
  }

  /**
   * 收掉本实例登记过的全部记录，返回被清掉的 pid。
   *
   * 进程退出时用它：只收拾自己拉起的子进程，别人的记录留给它们的主人
   * 或者下一次启动的 reap。比「退出时清空整个目录」重要得多——后者会在
   * 多实例部署下把另一个 server 正在跑的 Agent 登记一起抹掉。
   */
  async unregisterTracked(): Promise<number[]> {
    const pids = [...this.tracked];
    for (const pid of pids) {
      await this.unregister(pid);
    }
    return pids;
  }
}

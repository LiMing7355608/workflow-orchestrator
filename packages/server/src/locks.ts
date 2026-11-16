import { readFile, unlink, writeFile } from 'node:fs/promises';

/**
 * 数据目录锁。
 *
 * 存在的理由很具体：两个 server 进程同时往同一个 JSONL 事件日志追加，
 * 行会交错、重放会出现半条记录，事后无法从日志里恢复真实顺序。
 * 锁是「一个数据目录只能有一个写者」的唯一强制手段。
 */

export interface LockHandle {
  release(): Promise<void>;
}

export interface LockInfo {
  /** 持有者进程 pid */
  pid: number;
  /** 获取时间，ISO 字符串。同时充当这份锁的唯一标识 */
  startedAt: string;
  /** 持有者写的事件日志绝对路径，出问题时一眼看出冲突的是哪个日志 */
  logPath: string;
}

/**
 * 持锁者的存活三态判定。
 *
 * 失败方向刻意不对称：把活着的进程判成死的，后果是两个写者同时写日志；
 * 把死掉的进程判成活的，后果只是这次启动失败、需要人工删锁。
 * 前者会静默毁数据，后者会立刻被发现，所以除 ESRCH 外一律按活着算。
 */
function isHolderAlive(pid: number): boolean {
  // pid 0 / 负数在 POSIX 上代表进程组，process.kill(0, 0) 在 Windows 上还会
  // 返回成功，拿它当「活着」会造出一把永远抢不到的死锁。
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // ESRCH：查无此进程，锁的主人不在了
    if (code === 'ESRCH') {
      return false;
    }
    // EPERM 说明进程在，只是属于别的 uid —— 按活着处理，
    // 否则换个用户启动的 server 会把对方的锁当陈旧锁接管。
    // 其余 errno 同理保守处理。
    return true;
  }
}

/** 解析锁文件内容。半截 JSON、缺字段一律返回 undefined，由调用方当作陈旧锁。 */
function parseLockInfo(raw: string): LockInfo | undefined {
  let parsed: unknown;
  try {
    // 手工排查时常用编辑器改锁文件，带 BOM 的 UTF-8 会让 JSON.parse 直接失败。
    // 剥掉 BOM，避免「一个看不见的前缀」把锁误判成陈旧锁。
    parsed = JSON.parse(raw.replace(/^\uFEFF/, ''));
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return undefined;
  }
  const candidate = parsed as Record<string, unknown>;
  if (
    typeof candidate['pid'] !== 'number' ||
    typeof candidate['startedAt'] !== 'string' ||
    typeof candidate['logPath'] !== 'string'
  ) {
    return undefined;
  }
  return {
    pid: candidate['pid'],
    startedAt: candidate['startedAt'],
    logPath: candidate['logPath'],
  };
}

export class DataDirLock {
  constructor(private readonly lockPath: string) {}

  /** 只读查看当前锁内容。读不出来（不存在或损坏）返回 undefined。 */
  async peek(): Promise<LockInfo | undefined> {
    try {
      return parseLockInfo(await readFile(this.lockPath, 'utf8'));
    } catch {
      return undefined;
    }
  }

  /**
   * 尝试获取锁。持有者还活着就抛错；持有者已死或锁文件损坏则接管。
   *
   * 原子性靠 `flag: 'wx'`（O_CREAT|O_EXCL）：创建与写入是一个原子操作，
   * 文件「存在」本身就是「有人持锁」的可靠信号，所以两个进程不可能同时
   * 创建成功。
   *
   * 剩下一个缝隙在接管陈旧锁时：删除与重新创建之间不是原子的。
   * 若进程 A 判定陈旧、进程 B 同时判定陈旧，B 先删先建，A 的 `unlink`
   * 就可能落在 B 刚写好的文件上，随后 A 也能创建成功 —— 双方都自认持锁。
   * 窗口宽度是「读锁文件 → unlink」之间的微秒级，只在崩溃后多个 server
   * 同秒启动时才会撞上。这里做了两层收敛：写入后立刻回读校验（发现被抢
   * 就把这次 acquire 判失败，而不是带着一份已经被删掉的锁继续跑），
   * 以及有限次重试（被抢就重来一轮，正常只会看到活着的新持有者然后退出）。
   * 要彻底消灭这个窗口需要 OS 级 flock，Node 标准库没有可移植实现，
   * 所以按「极小概率 + 失败即启动失败」的代价接受它。
   */
  async acquire(info: Omit<LockInfo, 'startedAt'>): Promise<LockHandle> {
    const mine: LockInfo = { ...info, startedAt: new Date().toISOString() };
    const payload = JSON.stringify(mine, null, 2);

    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        await writeFile(this.lockPath, payload, { encoding: 'utf8', flag: 'wx' });
        // 回读校验：确认写下去的这份还在、还是自己的。被并发者删掉重建时
        // 这一步会失败，把「双持锁」降级成「这次启动失败」。
        const written = await this.peek();
        if (
          !written ||
          written.pid !== mine.pid ||
          written.startedAt !== mine.startedAt
        ) {
          throw new Error(`锁文件在写入后被其它进程接管：${this.lockPath}`);
        }
        return this.handleFor(mine);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        // EEXIST 是预期路径（有人持锁）；其它错误（例如目录不存在、权限不足）
        // 直接抛出，让启动失败暴露真实原因。
        if (code !== 'EEXIST') {
          throw error;
        }
      }

      const current = await this.peek();
      if (current && isHolderAlive(current.pid)) {
        throw new Error(
          `数据目录已被 pid ${current.pid} 占用（获取时间 ${current.startedAt}，日志 ${current.logPath}）：${this.lockPath}`,
        );
      }

      // 陈旧锁：删掉后回到循环顶部重新抢。
      // ENOENT 是正常的——并发者可能已经先删了。
      await unlink(this.lockPath).catch(() => {});
    }

    throw new Error(`连续 5 次重试都没能取得数据目录锁：${this.lockPath}`);
  }

  /**
   * 生成释放句柄。
   *
   * 只删「自己写的那份」：pid 与 startedAt 都必须对上。少了这个比对，
   * 一旦自己的锁已被后来者接管，release 会把对方的锁删掉，对方则以为
   * 锁还在手上继续写同一个日志 —— 正是这个锁要防的事故。
   */
  private handleFor(mine: LockInfo): LockHandle {
    let released = false;
    return {
      release: async (): Promise<void> => {
        // 信号连来两次时 release 会被调两次，重复释放不该报错
        if (released) {
          return;
        }
        released = true;
        const current = await this.peek();
        if (
          !current ||
          current.pid !== mine.pid ||
          current.startedAt !== mine.startedAt
        ) {
          return;
        }
        await unlink(this.lockPath).catch(() => {});
      },
    };
  }
}

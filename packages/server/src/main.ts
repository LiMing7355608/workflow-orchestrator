import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { buildApp } from './app.js';
import { resolveJournalRoot } from './journal-file.js';
import { DataDirLock, type LockHandle } from './locks.js';
import { repoRoot, resolveDataDir, resolveRunningFile } from './paths.js';
import { ProcessRegistry } from './registry.js';

const port = Number(process.env.PORT ?? 3000);
const host = process.env.HOST ?? '127.0.0.1';

/**
 * 编排器的数据根目录：**仓库自己的 `data/`**（源码运行时）。
 *
 * 打包成可执行文件之后规则会变——那时候没有「仓库」可溯源，见
 * `paths.ts` 里的三种形态。这里只负责取，不重复那套判断。
 */
const dataDir = resolveDataDir();

const logPath = process.env.EVENT_LOG_PATH ?? resolve(dataDir, 'events.jsonl');
/** 分片事件日志的根目录：`/api/runs/:id/events` 读的就是 `<root>/<runId>/` */
const journalRoot = resolve(resolveJournalRoot(logPath));

// 锁与登记簿都在数据根下，可用环境变量挪走，
// 便于「同一台机器跑两个互不干扰的实例」这种调试场景。
const lockPath = resolve(process.env.LOCK_PATH ?? resolve(dataDir, 'orchestrator.lock'));
const processDir = resolve(process.env.PROCESS_DIR ?? resolve(dataDir, 'processes'));
/** 真实监听地址写在这里，供启动方（桌面壳）读取。 */
const runningFile = resolveRunningFile(dataDir);

/**
 * 抢数据目录锁，抢不到就退出。
 *
 * 这里必须是启动的第一件事：两个 server 同时追加同一个 JSONL 会写出行内
 * 交错的事件，事后无法重放；而且这种损坏是静默的，等到发现时日志已经废了。
 * 抢不到时把持有者的 pid 与获取时间打出来，运维才知道该去杀谁、锁是不是
 * 上一轮崩溃留下的。
 */
async function acquireLockOrExit(): Promise<LockHandle> {
  const lock = new DataDirLock(lockPath);
  try {
    return await lock.acquire({ pid: process.pid, logPath: resolve(logPath) });
  } catch (error) {
    const holder = await lock.peek();
    console.error('[fatal] 无法取得数据目录锁，启动中止');
    console.error(`  锁文件：${lockPath}`);
    if (holder) {
      console.error(
        `  当前持有者：pid ${holder.pid}，获取于 ${holder.startedAt}，日志 ${holder.logPath}`,
      );
      console.error('  确认对方已退出可删除锁文件；进程仍在则说明有另一个实例在跑。');
    }
    console.error(`  原因：${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}

const lockHandle = await acquireLockOrExit();

// 登记簿在锁之后初始化：没有锁就没有资格动数据目录里的任何东西
const registry = new ProcessRegistry(processDir);

// 启动即回收：上一轮崩溃留下的 Agent 子进程此刻还在跑，
// 既占着 worktree 又继续消耗 token，必须在接新活之前收掉。
const reaped = await registry.reap();
console.log(
  `[registry] 启动回收：清掉已退出记录 ${reaped.removed.length} 个，终止存活孤儿 ${reaped.terminated.length} 个，按策略保留 ${reaped.alive.length} 个`,
);
for (const record of reaped.terminated) {
  console.log(
    `[registry] 已向 pid ${record.pid} 发终止信号（run ${record.runId} / 节点 ${record.nodeId} / Agent ${record.agentId}）`,
  );
}

/**
 * 前端构建产物目录。
 *
 * 开发态在仓库里（`packages/web/dist`）；打包后由外壳铺到 `resources/web`，
 * 通过 `AGENT_WEB_DIR` 告诉这里。都没有就只提供 API——那是测试与纯后端场景。
 */
function resolveWebRoot(): string | undefined {
  const explicit = process.env.AGENT_WEB_DIR?.trim();
  if (explicit) {
    return resolve(explicit);
  }
  const local = resolve(repoRoot(), 'packages/web/dist');
  return existsSync(local) ? local : undefined;
}

const { app } = await buildApp({
  logPath,
  webRoot: resolveWebRoot(),
  logger: { level: process.env.LOG_LEVEL ?? 'info' },
  registry,
  lock: lockHandle,
});

try {
  await app.listen({ port, host });
  /**
   * 真实监听地址以 Fastify 报出来的为准，不是配置值。
   *
   * `PORT=0` 时由操作系统分配，服务自己事先不知道会拿到哪个端口；桌面版就靠
   * 这种方式避免和 Web 版或任何别的服务撞号（参考实现同样是“OS 分配的端口，
   * 因此不可能撞上 3080 或保留端口”）。
   */
  const address = app.server.address();
  const actualPort =
    typeof address === 'object' && address !== null ? address.port : port;
  const url = `http://${host}:${actualPort}`;

  /**
   * 把地址写成文件，供**启动方**读取。
   *
   * 桌面版是「Electron 守护一个独立 server 进程」，它必须知道窗口该加载哪个
   * URL。从 stdout 里抠 pid 或端口是脆的（日志格式一改就断），而一个 JSON 文件
   * 是人也能看懂、进程也能读的契约。心跳时间戳让启动方判断这份文件是不是
   * 上一轮崩溃留下的陈旧记录。
   */
  await writeFile(
    runningFile,
    `${JSON.stringify(
      { url, port: actualPort, host, pid: process.pid, startedAt: new Date().toISOString() },
      null,
      2,
    )}\n`,
    'utf8',
  ).catch((error: unknown) => {
    // 写不出地址文件不该阻止服务运行：它只是给启动方的便利，不是前提
    console.error(`[warn] 写运行地址文件失败（不影响服务）：${String(error)}`);
  });

  // 启动横幅留在 console：此刻用户还没把日志管道接好，而这是他要看的第一屏。
  // 之后的一切（请求、推进、失败）都走 pino，不再往 stdout 里撒字符串。
  console.log(`orchestrator server listening on ${url}`);
  console.log(`运行位置索引：${resolve(journalRoot, '.project-runs')}`);
  console.log(`旧运行日志：${resolve(logPath)}`);
  console.log(`lock file: ${lockPath}`);
  console.log(`process registry: ${processDir}`);
  console.log(`running file: ${runningFile}`);
  console.log(`log level: ${process.env.LOG_LEVEL ?? 'info'}（LOG_LEVEL 可调）`);
} catch (error) {
  // 启动失败要能一眼看出「卡在哪一步」：端口、主机、日志目录、锁，逐个摊开
  console.error('[fatal] 编排器启动失败，HTTP 服务没能监听');
  console.error(`  监听地址：${host}:${port}（PORT / HOST 可改）`);
  console.error(`  事件日志目录：${journalRoot}`);
  console.error(`  锁文件：${lockPath}`);
  console.error(`  原因：${error instanceof Error ? error.message : String(error)}`);
  if (error instanceof Error && error.stack) {
    console.error(`  堆栈：\n${error.stack}`);
  }
  await lockHandle.release();
  process.exit(1);
}

/**
 * 关停顺序固定：先断 HTTP（不再接受新 run），再清自己登记的记录，
 * 最后放锁。
 *
 * 放锁必须最后做：锁一放，另一个实例就能进来写同一个日志，而我们可能还在
 * 清理。反过来，记录清理失败也照样要放锁——留一条孤儿记录只是脏数据，
 * 卡着锁不放会让下一次启动直接失败。
 */
let shuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  console.log(`[shutdown] 收到 ${signal}，开始关停`);

  try {
    await app.close();
  } catch (error) {
    console.error(
      `[shutdown] 关闭 HTTP 服务出错（地址 ${host}:${port}）：${error instanceof Error ? error.message : String(error)}`,
    );
  }

  try {
    const cleaned = await registry.unregisterTracked();
    if (cleaned.length > 0) {
      console.log(`[shutdown] 已清理本进程登记的 ${cleaned.length} 条子进程记录：${cleaned.join(', ')}`);
    }
  } catch (error) {
    console.error(
      `[shutdown] 清理子进程记录出错（目录 ${processDir}）：${error instanceof Error ? error.message : String(error)}`,
    );
  }

  try {
    await lockHandle.release();
    console.log(`[shutdown] 已释放数据目录锁 ${lockPath}`);
  } catch (error) {
    console.error(
      `[shutdown] 释放锁失败（${lockPath}），下次启动可能被自己的陈旧锁挡住：${error instanceof Error ? error.message : String(error)}`,
    );
  }
  process.exit(0);
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void shutdown(signal);
  });
}

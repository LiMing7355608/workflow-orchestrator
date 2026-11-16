import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { LogSink } from './log.js';

const execFileAsync = promisify(execFile);

/**
 * 终止一个进程**及其全部子孙**。
 *
 * 为什么不能只 `child.kill()`：Windows 上 npm 装出来的 `.cmd` 不能直接 spawn，
 * 我们通过 `cmd.exe /c dsh.cmd ...` 启动，于是 `child.pid` 是 cmd.exe，真正的
 * Agent 是它的 node 子进程。杀掉 cmd.exe 后 node 变成孤儿继续跑——它还在写
 * 事件、还在烧 token，而父进程这边「确认退出」成功，界面显示已停止。
 * 这就是「假停止」的由来。
 *
 * 所以 Windows 走 `taskkill /T`（整棵树），POSIX 走进程组。
 * `force` 为 false 时先请一次，给 Agent 机会收尾。
 */
export async function killProcessTree(
  pid: number | undefined,
  options: { force: boolean; log: LogSink },
): Promise<void> {
  if (pid === undefined || !Number.isInteger(pid) || pid <= 0) {
    return;
  }

  if (process.platform === 'win32') {
    const args = ['/PID', String(pid), '/T'];
    if (options.force) {
      args.push('/F');
    }
    try {
      await execFileAsync('taskkill', args, { windowsHide: true });
    } catch (error) {
      // taskkill 在进程已经不在时返回非零，属于正常竞态
      options.log.debug('taskkill 未能终止进程树', { pid, force: options.force, error });
    }
    return;
  }

  // POSIX：子进程由 spawn 创建，没有独立进程组时退化为只杀自己
  try {
    process.kill(-pid, options.force ? 'SIGKILL' : 'SIGTERM');
  } catch {
    try {
      process.kill(pid, options.force ? 'SIGKILL' : 'SIGTERM');
    } catch (error) {
      options.log.debug('向进程发信号失败', { pid, force: options.force, error });
    }
  }
}

/** 这个 pid 是否还活着。不判断它是不是自己人——调用方已经知道 pid 的来源。 */
export function isPidAlive(pid: number | undefined): boolean {
  if (pid === undefined || !Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

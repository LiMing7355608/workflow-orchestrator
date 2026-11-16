import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { promisify } from 'node:util';
import type { NodeArtifact, WorkspacePort } from '@orchestrator/core';

const execFileAsync = promisify(execFile);

/** 采集 diff 的输出上限。超大改动宁可在这里截断，也不要把进程缓冲区撑爆。 */
const CAPTURE_MAX_BUFFER = 8 * 1024 * 1024;

/**
 * 解析 `git status --porcelain -z` 的输出。
 *
 * 用 `-z` 而不是普通文本输出：含空格或中文的路径在文本模式下会被
 * 加引号并转义，拿到的路径直接不可用；`-z` 用 NUL 分隔，原样给出。
 * 重命名/复制在 `-z` 下会紧跟一项「原路径」，必须跳过，
 * 否则同一处改动会被算成两个不同文件。
 */
function parsePorcelain(stdout: string): string[] {
  const entries = stdout.split('\0').filter((entry) => entry.length > 3);
  const paths: string[] = [];
  for (let i = 0; i < entries.length; i += 1) {
    const entry = entries[i];
    if (!entry) {
      continue;
    }
    const status = entry.slice(0, 2);
    paths.push(entry.slice(3));
    if (status.includes('R') || status.includes('C')) {
      i += 1;
    }
  }
  return paths;
}

/**
 * 每个实现节点独占一个 git worktree 与一条分支。
 *
 * 文件系统级隔离是并行安全的最终保障——调度器的文件范围检查只是静态近似，
 * 真正让两个 Agent 不会互相踩的是各写各的目录。
 */
export class GitWorktreeWorkspace implements WorkspacePort {
  constructor(
    private readonly repoRoot: string,
    private readonly baseDir = '.worktrees',
  ) {}

  private branchOf(runId: string, nodeId: string): string {
    return `node/${runId}/${nodeId}`;
  }

  private dirOf(runId: string, nodeId: string): string {
    return resolve(this.repoRoot, this.baseDir, runId, nodeId);
  }

  private async git(args: string[]): Promise<void> {
    await execFileAsync('git', args, {
      cwd: this.repoRoot,
      windowsHide: true,
      timeout: 120_000,
    });
  }

  async prepare(runId: string, nodeId: string): Promise<string> {
    const dir = this.dirOf(runId, nodeId);
    if (existsSync(dir)) {
      // 重试同一个节点时复用已有工作区，保留上一轮的上下文
      return dir;
    }
    await mkdir(dirname(dir), { recursive: true });
    await this.git(['worktree', 'add', '-b', this.branchOf(runId, nodeId), dir, 'HEAD']);
    return dir;
  }

  /**
   * 采集节点工作目录里的改动，统一成一份 diff。
   *
   * 全程只在真实目录上跑 git CLI，不臆造内容；任何一步失败都退化成
   * 空产物而不是抛异常——采集失败只该让下游看不到 diff，
   * 不该把一次已经成功的执行判成失败。
   */
  async capture(runId: string, nodeId: string): Promise<NodeArtifact> {
    const capturedAt = new Date().toISOString();
    const empty: NodeArtifact = { diff: '', files: [], bytes: 0, capturedAt };

    const dir = this.dirOf(runId, nodeId);
    if (!existsSync(dir)) {
      return empty;
    }

    const options = {
      cwd: dir,
      windowsHide: true,
      timeout: 60_000,
      maxBuffer: CAPTURE_MAX_BUFFER,
    };

    // 未跟踪文件默认根本不出现在 `git diff` 里，而 Agent 新建文件是最常见的
    // 交付方式，漏掉它们等于什么都没采到。这里走 `git add -N`（intent-to-add）：
    // 只把路径登记进 index，不写入任何 blob 内容，工作区文件一字不动，
    // 随后 `git diff` 就会把整份新文件当作新增贴出来。
    // 没选 `git diff --no-index`，因为它要按文件逐个调用、对已跟踪文件还得
    // 另走一条分支，而且「有差异」时退出码是 1，会被 execFile 当成失败。
    await execFileAsync('git', ['add', '-N', '--all'], options).catch(() => {});

    let diff = '';
    try {
      // 对比 HEAD 而不是「工作区 vs index」：Agent 自己执行过 git add 时，
      // 后者会把这些改动当成已提交内容而全部漏掉。
      const { stdout } = await execFileAsync(
        'git',
        ['diff', '--no-color', '--no-ext-diff', 'HEAD'],
        options,
      );
      diff = stdout;
    } catch {
      // 空仓库还没有 HEAD，退化成「工作区 vs index」
      try {
        const { stdout } = await execFileAsync(
          'git',
          ['diff', '--no-color', '--no-ext-diff'],
          options,
        );
        diff = stdout;
      } catch {
        diff = '';
      }
    }

    let files: string[] = [];
    try {
      const { stdout } = await execFileAsync(
        'git',
        ['status', '--porcelain', '-z'],
        options,
      );
      files = parsePorcelain(stdout);
    } catch {
      files = [];
    }

    return { diff, files, bytes: Buffer.byteLength(diff, 'utf8'), capturedAt };
  }

  /**
   * 释放工作区。
   *
   * 顺序与直觉相反：必须先移除 worktree，再删分支——git 拒绝删除
   * 已被某个工作树检出的分支。有未提交改动时整体跳过：
   * 用户数据安全优先于清理干净。
   */
  async release(runId: string, nodeId: string): Promise<void> {
    const dir = this.dirOf(runId, nodeId);
    if (!existsSync(dir)) {
      return;
    }

    try {
      const { stdout } = await execFileAsync('git', ['status', '--porcelain'], {
        cwd: dir,
        windowsHide: true,
        timeout: 30_000,
      });
      if (stdout.trim()) {
        // 有未提交改动，留给人工处理，不强行删除
        return;
      }
    } catch {
      return;
    }

    await this.git(['worktree', 'remove', dir]).catch(() => {});
    await this.git(['branch', '-D', this.branchOf(runId, nodeId)]).catch(() => {});
  }
}

/** 不落 git 的临时目录实现，用于测试与无仓库场景。 */
export class TempDirWorkspace implements WorkspacePort {
  constructor(private readonly root: string) {}

  async prepare(runId: string, nodeId: string): Promise<string> {
    const dir = resolve(this.root, runId, nodeId);
    await mkdir(dir, { recursive: true });
    return dir;
  }

  async release(): Promise<void> {
    // 临时目录不主动清理，便于事后排查
  }

  /**
   * 临时目录没有 git 基线，谈不上「改了什么」。
   * 明面上返回空产物，让编排器与审查节点都能看到「这里没有 diff」，
   * 而不是让 capture 缺失去触发一堆 undefined 判断。
   */
  async capture(): Promise<NodeArtifact> {
    return { diff: '', files: [], bytes: 0, capturedAt: new Date().toISOString() };
  }
}

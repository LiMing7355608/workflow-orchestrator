import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { promisify } from 'node:util';
import type { WorkspacePort } from '@orchestrator/core';

const execFileAsync = promisify(execFile);

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
}

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { promisify } from 'node:util';
import type {
  MergeRequest,
  MergeResult,
  NodeArtifact,
  WorkspacePort,
} from '@orchestrator/core';

const execFileAsync = promisify(execFile);

/** 采集 diff 的输出上限。超大改动宁可在这里截断，也不要把进程缓冲区撑爆。 */
const CAPTURE_MAX_BUFFER = 8 * 1024 * 1024;

/**
 * 集成工作区在 `<worktreeRoot>/<runId>/` 下占用的目录名，与节点目录同级。
 *
 * 取一个不可能与节点 id 撞车的名字：它在同一个父目录里与所有节点 worktree
 * 并列，用 `integration` 之类的名字迟早会和一个真实的节点 id 重叠。
 */
const INTEGRATION_DIR = '_integration';

/**
 * 一次 git 调用的结构化结果。
 *
 * merge 路径上不能靠抛异常：一次合并里有多条 git 命令，某一条失败到底是
 * 「冲突」「分支不存在」还是「没有提交身份」，只有把这些信息留住才能
 * 给出可执行的结论。所以统一收敛成这个形状，失败也是返回值。
 */
interface GitResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

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
 * 目标目录是不是一个可用的 git 工作树。
 *
 * 为什么要单独问一句：`git worktree add` 在非 git 目录里会失败，但那是一句
 * 混合着用法提示的 git 报错，用户看到的是「这个 Agent 跑挂了」，而真实原因
 * 是「你选的目录不是仓库」。校验必须发生在建运行之前，并且能翻译成人话。
 *
 * 判据是 `--is-inside-work-tree` 而不是「有没有 .git 目录」：前者由 git 自己
 * 回答（子目录、worktree、软链接都算对），后者会在 submodule、worktree 里的
 * `.git` 文件、以及任意子目录上给出错误结论。裸仓库同样返回 false——它没有
 * 可交付的工作区。
 */
export async function isGitWorkTree(dir: string): Promise<boolean> {
  const result = await new Promise<GitResult>((resolvePromise) => {
    execFile(
      'git',
      ['rev-parse', '--is-inside-work-tree'],
      { cwd: dir, windowsHide: true, timeout: 15_000 },
      (error, stdout, stderr) => {
        resolvePromise({
          ok: error === null,
          stdout: typeof stdout === 'string' ? stdout : '',
          stderr: typeof stderr === 'string' ? stderr : '',
        });
      },
    );
  });
  return result.ok && result.stdout.trim() === 'true';
}

/**
 * 每个实现节点独占一个 git worktree 与一条分支。
 *
 * 文件系统级隔离是并行安全的最终保障——调度器的文件范围检查只是静态近似，
 * 真正让两个 Agent 不会互相踩的是各写各的目录。
 *
 * 「仓库在哪」与「worktree 落在哪」是两个独立的位置，构造函数逼调用方把它们
 * 分开传：仓库根是用户选的目标目录（他要求成果出现的地方），而 worktree 必须
 * 落在编排器自己的 data 目录下——写进用户仓库的 `.worktrees/` 等于往他的
 * 工程里塞一堆还要他自己清理的垃圾，`git status` 也会被污染。
 */
export class GitWorktreeWorkspace implements WorkspacePort {
  constructor(
    private readonly repoRoot: string,
    private readonly worktreeRoot: string,
  ) {}

  private branchOf(runId: string, nodeId: string): string {
    return `node/${runId}/${nodeId}`;
  }

  private dirOf(runId: string, nodeId: string): string {
    return resolve(this.worktreeRoot, runId, nodeId);
  }

  private async git(args: string[]): Promise<void> {
    await execFileAsync('git', args, {
      cwd: this.repoRoot,
      windowsHide: true,
      timeout: 120_000,
    });
  }

  /** 带结果返回的 git 调用。所有失败都留在返回值里，不抛。 */
  private async gitRun(
    args: string[],
    cwd: string,
    timeout = 120_000,
  ): Promise<GitResult> {
    try {
      const { stdout, stderr } = await execFileAsync('git', args, {
        cwd,
        windowsHide: true,
        timeout,
        maxBuffer: CAPTURE_MAX_BUFFER,
      });
      return { ok: true, stdout, stderr };
    } catch (error) {
      const failure = error as { stdout?: string; stderr?: string; message?: string };
      return {
        ok: false,
        stdout: failure.stdout ?? '',
        stderr: failure.stderr ?? failure.message ?? '',
      };
    }
  }

  private integrationDirOf(runId: string): string {
    return resolve(this.worktreeRoot, runId, INTEGRATION_DIR);
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

  /**
   * 把节点工作区里未提交的改动落成一个提交。
   *
   * 为什么必须做：节点分支是在 `prepare` 时从 HEAD 拉出来的，Agent 改完
   * 文件往往并不自己 commit（`capture` 采集的正是这些未提交改动）。
   * 不补这一步，分支 tip 还停在创建时的 HEAD，`git merge` 会把这条分支
   * 判定成「没有任何新提交」，等于白合——worktree 里干了活，集成分支上
   * 一个字都没有。
   *
   * 工作区已被释放或读不出状态时静默放行：那只是「没有待提交的改动」，
   * 不该把一次本来能成的合并拦下来。
   */
  private async commitWorktree(
    dir: string,
    nodeId: string,
  ): Promise<{ ok: true } | { ok: false; reason: string }> {
    if (!existsSync(dir)) {
      return { ok: true };
    }

    const status = await this.gitRun(['status', '--porcelain'], dir, 60_000);
    if (!status.ok || !status.stdout.trim()) {
      return { ok: true };
    }

    const added = await this.gitRun(['add', '--all'], dir, 60_000);
    if (!added.ok) {
      return { ok: false, reason: `节点 ${nodeId} 的改动暂存失败：${added.stderr.trim()}` };
    }

    // 不传 --no-verify：仓库自己的钩子不该被编排器绕过。钩子拦下时
    // 合并会明确失败并带上钩子的输出，人能看到真正的原因。
    const committed = await this.gitRun(
      ['commit', '-m', `node ${nodeId}: 节点工作区改动`],
      dir,
      120_000,
    );
    if (!committed.ok) {
      return { ok: false, reason: `节点 ${nodeId} 的改动提交失败：${committed.stderr.trim()}` };
    }
    return { ok: true };
  }

  /** 当前合并冲突留下的未合并路径。 */
  private async conflictFiles(dir: string): Promise<string[]> {
    const result = await this.gitRun(['diff', '--name-only', '--diff-filter=U'], dir);
    return result.stdout
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
  }

  /**
   * 准备集成分支与它的独立工作区。
   *
   * 复用而不是每次重建，理由有三：一是合并节点重跑（审查驳回后重跑一遍）
   * 不能把上次已经合进去的历史丢掉；二是冲突现场留在磁盘上才有人能接管；
   * 三是 `git worktree add -b` 对已存在的分支会直接报错。
   */
  private async ensureIntegration(
    runId: string,
    branch: string,
    dir: string,
  ): Promise<{ ok: true } | { ok: false; reason: string }> {
    if (existsSync(dir)) {
      return { ok: true };
    }

    await mkdir(dirname(dir), { recursive: true });

    const existing = await this.gitRun(
      ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`],
      this.repoRoot,
    );
    const added =
      existing.ok && existing.stdout.trim()
        ? await this.gitRun(['worktree', 'add', dir, branch], this.repoRoot)
        : await this.gitRun(['worktree', 'add', '-b', branch, dir, 'HEAD'], this.repoRoot);

    if (!added.ok) {
      return {
        ok: false,
        reason: `集成分支 ${branch} 的工作区准备失败：${added.stderr.trim() || 'git worktree add 失败'}`,
      };
    }
    return { ok: true };
  }

  /**
   * 合并节点分支到集成分支。
   *
   * 全程走 `execFile` 调真实 git，不解析、不臆造：
   *  - 逐个 `git merge --no-ff`，用合并提交把「谁合进来的」留成可读历史；
   *  - 任何一步失败都返回结构化结果，不抛异常；
   *  - 冲突时先 `merge --abort` 收干净现场再报告，否则集成分支会卡在
   *    MERGING 状态，下一次合并直接报错，重试永远失败；
   *  - 已成功的那些节点照实写进 `merged`，冲突不该抹掉既成事实。
   *
   * 成功后刻意不删节点 worktree 与分支：那是 `release` 的职责，而且
   * 冲突排查要看得见现场。
   */
  async merge(request: MergeRequest): Promise<MergeResult> {
    const { runId, nodeIds, targetBranch } = request;
    const merged: string[] = [];
    const dir = this.integrationDirOf(runId);

    const prepared = await this.ensureIntegration(runId, targetBranch, dir);
    if (!prepared.ok) {
      return { ok: false, branch: targetBranch, conflicts: [], merged, reason: prepared.reason };
    }

    for (const nodeId of nodeIds) {
      const nodeBranch = this.branchOf(runId, nodeId);

      const committed = await this.commitWorktree(this.dirOf(runId, nodeId), nodeId);
      if (!committed.ok) {
        return { ok: false, branch: targetBranch, conflicts: [], merged, reason: committed.reason };
      }

      // 分支不存在时自己说清楚：git 的原始报错里混着用法提示，
      // 直接透出去等于让人去读 git 帮助文档
      const exists = await this.gitRun(
        ['rev-parse', '--verify', '--quiet', `refs/heads/${nodeBranch}`],
        this.repoRoot,
      );
      if (!exists.ok || !exists.stdout.trim()) {
        return {
          ok: false,
          branch: targetBranch,
          conflicts: [],
          merged,
          reason: `节点分支不存在：${nodeBranch}`,
        };
      }

      const result = await this.gitRun(
        ['merge', '--no-ff', nodeBranch, '-m', `merge ${nodeBranch}`],
        dir,
      );
      if (result.ok) {
        merged.push(nodeId);
        continue;
      }

      const conflicts = await this.conflictFiles(dir);
      await this.gitRun(['merge', '--abort'], dir);
      return {
        ok: false,
        branch: targetBranch,
        conflicts,
        merged,
        reason:
          conflicts.length > 0
            ? `合并 ${nodeBranch} 时冲突`
            : `合并 ${nodeBranch} 失败：${result.stderr.trim() || result.stdout.trim() || 'git merge 未给出原因'}`,
      };
    }

    const head = await this.gitRun(['rev-parse', 'HEAD'], dir);
    return {
      ok: true,
      branch: targetBranch,
      merged,
      commit: head.ok ? head.stdout.trim() : undefined,
    };
  }
}

/**
 * 不落 git 的临时目录实现，用于测试与无仓库场景。
 *
 * `root` 由调用方给（服务端统一给 `data/worktrees`，与目标仓库无关）：
 * 目标目录只决定「在哪个仓库里干活」，节点目录永远由编排器自己管。
 */
export class TempDirWorkspace implements WorkspacePort {
  constructor(private readonly root: string) {}

  async prepare(runId: string, nodeId: string): Promise<string> {
    const dir = resolve(this.root, runId, nodeId);
    await mkdir(dir, { recursive: true });
    return dir;
  }

  /**
   * 释放临时目录：真的删掉。
   *
   * 早先这里刻意不清理「便于事后排查」，代价是目录无限累积，而规划与改图
   * 一度复用固定目录，上一轮的交付文件会被下一轮读回来。产物 diff 在 release
   * 之前就已采集落盘，删目录不会丢东西。
   */
  async release(runId: string, nodeId: string): Promise<void> {
    await rm(resolve(this.root, runId, nodeId), {
      recursive: true,
      force: true,
    }).catch(() => {});
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

import { execFile } from 'node:child_process';
import { existsSync, readdirSync, rmdirSync } from 'node:fs';
import { mkdir, readdir, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { promisify } from 'node:util';
import type {
  MergeRequest,
  MergeResult,
  NodeArtifact,
  WorkspacePort,
} from '@orchestrator/core';
import { assertRunId, isMissing, ownedPath } from './project-files.js';

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

  async removeRun(runId: string): Promise<void> {
    assertRunId(runId);
    const directory = await ownedPath(this.worktreeRoot, runId);
    const listed = await this.gitValue(['worktree', 'list', '--porcelain']);
    const worktrees = listed.trim().split(/\r?\n\r?\n/).map((record) => ({
      path: record.split(/\r?\n/)[0]?.slice('worktree '.length),
      branch: record.match(/^branch (.+)$/m)?.[1]?.trim(),
    }));
    const names = await readdir(directory).catch((error: unknown) => {
      if (isMissing(error)) return [];
      throw error;
    });
    const owned = new Set(await Promise.all(names.map(async (name) => resolve(await ownedPath(this.worktreeRoot, runId, name)))));
    const checkedOutElsewhere = new Set<string>();
    for (const entry of worktrees) {
      if (entry.path && owned.has(resolve(entry.path))) {
        await this.gitValue(['worktree', 'remove', '--force', entry.path]);
      } else if (entry.branch) {
        checkedOutElsewhere.add(entry.branch);
      }
    }
    const integration = `refs/heads/run/${runId}`;
    const nodePrefix = `refs/heads/node/${runId}/`;
    const parents = ['node-base', 'published', 'run-base', 'integration'].map(
      (kind) => `refs/orchestrator/${kind}/${runId}`,
    );
    const references = (await this.gitValue([
      'for-each-ref', '--format=%(refname)', integration, nodePrefix, ...parents,
    ])).split(/\r?\n/).filter(Boolean);
    for (const ref of references) {
      if (checkedOutElsewhere.has(ref)) continue;
      if (ref === integration || ref.startsWith(nodePrefix)) {
        const baseline = ref === integration
          ? `refs/orchestrator/integration/${runId}/commit`
          : this.publishedRef(runId, ref.slice(nodePrefix.length));
        const recorded = await this.commitAt(baseline);
        const current = await this.commitAt(ref);
        if (current && (!recorded || current === recorded)) {
          // Compare the old SHA so an intervening change never gets removed.
          await this.gitValue(['update-ref', '-d', ref, current]);
        }
      }
    }
    for (const ref of references) {
      if (parents.some((parent) => ref === parent || ref.startsWith(parent + '/'))) {
        await this.gitValue(['update-ref', '-d', ref]);
      }
    }
    await rm(directory, { recursive: true, force: true });
  }

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
    env?: NodeJS.ProcessEnv,
  ): Promise<GitResult> {
    try {
      const { stdout, stderr } = await execFileAsync('git', [
        '-c', 'user.name=Workflow Orchestrator', '-c', 'user.email=orchestrator@localhost',
        ...args,
      ], {
        cwd,
        windowsHide: true,
        timeout,
        maxBuffer: CAPTURE_MAX_BUFFER,
        ...(env ? { env: { ...process.env, ...env } } : {}),
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

  /**
   * 把 base 与 upstream 的改动汇成一棵树，返回树对象 id。
   *
   * `git merge-tree --write-tree` 是最省事的做法，但它要求 **Git 2.38+**，
   * 而机器上的 git 可能更老（实测 2.28 会把 `--write-tree` 当成 revision 解析，
   * 报 `unknown rev --write-tree`，整个节点直接「工作区准备失败」）。
   *
   * 老版本降级到三路 `read-tree`：这是 `git merge` 内部干的事，plumbing 层
   * 早就有，不需要任何新特性。代价是要自己管一个临时索引文件。
   */
  private async mergedTree(base: string, upstream: string): Promise<string> {
    const modern = await this.gitRun(
      ['merge-tree', '--write-tree', base, upstream],
      this.repoRoot,
    );
    if (modern.ok) {
      return modern.stdout.trim();
    }

    // 两边的共同祖先：`read-tree -m` 的第一个参数是合并基，不是任意基线
    const ancestor = await this.gitValue(['merge-base', base, upstream], this.repoRoot);
    const indexFile = resolve(
      this.worktreeRoot,
      `.merge-index-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    );
    await mkdir(this.worktreeRoot, { recursive: true });
    const env = { GIT_INDEX_FILE: indexFile };

    try {
      const read = await this.gitRun(
        ['read-tree', '-m', '--aggressive', ancestor, base, upstream],
        this.repoRoot,
        120_000,
        env,
      );
      if (!read.ok) {
        // 真冲突：交给上层去记合并冲突，别在这里吞掉
        throw new Error(
          `汇集上游产物时发生冲突：${read.stderr.trim() || read.stdout.trim() || 'read-tree 失败'}`,
        );
      }
      const written = await this.gitRun(['write-tree'], this.repoRoot, 120_000, env);
      if (!written.ok) {
        throw new Error(
          `写出合并后的树失败：${written.stderr.trim() || 'write-tree 失败'}`,
        );
      }
      return written.stdout.trim();
    } finally {
      await rm(indexFile, { force: true }).catch(() => {});
    }
  }

  private integrationDirOf(runId: string): string {
    return resolve(this.worktreeRoot, runId, INTEGRATION_DIR);
  }

  private baseRef(runId: string, nodeId?: string): string {
    return nodeId
      ? `refs/orchestrator/node-base/${runId}/${nodeId}`
      : `refs/orchestrator/run-base/${runId}`;
  }

  private publishedRef(runId: string, nodeId: string): string {
    return `refs/orchestrator/published/${runId}/${nodeId}/commit`;
  }

  private async commitAt(ref: string): Promise<string | undefined> {
    const result = await this.gitRun(['rev-parse', '--verify', '--quiet', ref], this.repoRoot);
    return result.ok ? result.stdout.trim() : undefined;
  }

  private async gitValue(args: string[], cwd = this.repoRoot): Promise<string> {
    const result = await this.gitRun(args, cwd);
    if (!result.ok) {
      throw new Error(result.stderr.trim() || result.stdout.trim() || `git ${args[0]} 失败`);
    }
    return result.stdout.trim();
  }

  private async runBase(runId: string): Promise<string> {
    const ref = this.baseRef(runId);
    const existing = await this.commitAt(ref);
    if (existing) {
      return existing;
    }
    const head = await this.gitValue(['rev-parse', 'HEAD']);
    // 空旧值表示只能创建。并行节点会使用最先成功登记的基线。
    const created = await this.gitRun(['update-ref', ref, head, ''], this.repoRoot);
    if (created.ok) {
      return head;
    }
    const registered = await this.commitAt(ref);
    if (!registered) {
      throw new Error(created.stderr.trim() || '无法登记运行的 Git 基线');
    }
    return registered;
  }

  private async dependencyBase(runId: string, upstreamIds: string[]): Promise<string> {
    let base = await this.runBase(runId);
    for (const id of upstreamIds) {
      const upstream = await this.nodeCommit(runId, id);
      if ((await this.gitRun(['merge-base', '--is-ancestor', upstream, base], this.repoRoot)).ok) {
        continue;
      }
      if ((await this.gitRun(['merge-base', '--is-ancestor', base, upstream], this.repoRoot)).ok) {
        base = upstream;
        continue;
      }
      const tree = await this.mergedTree(base, upstream);
      base = await this.gitValue([
        'commit-tree', tree, '-p', base, '-p', upstream, '-m', `汇集节点 ${id} 的上游产物`,
      ]);
    }
    return base;
  }

  async prepare(runId: string, nodeId: string, upstreamIds?: string[]): Promise<string> {
    const dir = await ownedPath(this.worktreeRoot, runId, nodeId);
    const branch = this.branchOf(runId, nodeId);
    const base = upstreamIds ? await this.dependencyBase(runId, upstreamIds) : 'HEAD';
    const ref = this.baseRef(runId, nodeId);
    const previous = upstreamIds ? await this.commitAt(ref) : undefined;

    if (!existsSync(dir)) {
      await mkdir(dirname(dir), { recursive: true });
      const branchExists = await this.commitAt(`refs/heads/${branch}`);
      await this.git(branchExists
        ? ['worktree', 'add', dir, branch]
        : ['worktree', 'add', '-b', branch, dir, base]);
    }

    if (upstreamIds && previous !== base) {
      const oldTree = previous && await this.commitAt(`${previous}^{tree}`);
      const newTree = await this.commitAt(`${base}^{tree}`);
      if (previous && oldTree !== newTree) {
        if (await this.gitValue(['status', '--porcelain'], dir)) {
          throw new Error('上游产物已更新，请先保存当前节点工作区中的未提交改动');
        }
        const rebased = await this.gitRun(['rebase', '--onto', base, previous], dir);
        if (!rebased.ok) {
          await this.gitRun(['rebase', '--abort'], dir);
          throw new Error(`无法接入更新后的上游产物：${rebased.stderr.trim() || rebased.stdout.trim()}`);
        }
      }
      if (!previous || oldTree !== newTree) {
        await this.gitValue(['update-ref', ref, base]);
      }
    }
    return dir;
  }

  async publish(runId: string, nodeId: string): Promise<void> {
    const dir = this.dirOf(runId, nodeId);
    const branch = await this.gitValue(['symbolic-ref', '--short', 'HEAD'], dir);
    if (branch !== this.branchOf(runId, nodeId)) {
      throw new Error('节点执行期间切换了工作区分支');
    }
    const committed = await this.commitWorktree(dir, nodeId);
    if (!committed.ok) {
      throw new Error(committed.reason);
    }
    const head = await this.gitValue(['rev-parse', 'HEAD'], dir);
    await this.gitValue(['update-ref', this.publishedRef(runId, nodeId), head]);
  }

  private async nodeCommit(runId: string, nodeId: string): Promise<string> {
    const published = await this.commitAt(this.publishedRef(runId, nodeId));
    if (published) {
      return published;
    }
    // 兼容旧运行以及直接使用工作区的调用方。
    const saved = await this.commitWorktree(this.dirOf(runId, nodeId), nodeId);
    if (!saved.ok) {
      throw new Error(saved.reason);
    }
    const branch = this.branchOf(runId, nodeId);
    const commit = await this.commitAt(`refs/heads/${branch}`);
    if (!commit) {
      throw new Error(`节点分支不存在：${branch}`);
    }
    return commit;
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

    const base = await this.commitAt(this.baseRef(runId, nodeId)) ?? 'HEAD';
    let diff = '';
    try {
      // 对比 HEAD 而不是「工作区 vs index」：Agent 自己执行过 git add 时，
      // 后者会把这些改动当成已提交内容而全部漏掉。
      const { stdout } = await execFileAsync(
        'git',
        ['diff', '--no-color', '--no-ext-diff', base],
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
        ['diff', '--name-only', '-z', base],
        options,
      );
      files = stdout.split('\0').filter(Boolean);
    } catch {
      files = [];
    }

    return { diff, files, bytes: Buffer.byteLength(diff, 'utf8'), capturedAt };
  }

  /**
   * 释放工作区。
   *
   * 只清理**目录**，不删分支。
   *
   * 目录必须清：它是我们建在目标仓库 `.worktrees/` 下的，攒下来会挡住下一次
   * `prepare`（同名目录已存在就会被当成「接着上次干」），也会让用户的
   * `.worktrees` 永远清不空。产物在 `publish` 时已经 `update-ref` 进了
   * `publishedRef`，`capture` 采集的 diff 也早落了 artifacts，删目录不会丢东西。
   *
   * 分支留着：用户明确说过本地分支无所谓。反过来，删分支在「工作区里有未提交
   * 改动」时风险很大——那份改动并不总是已经落到 ref 上（节点失败、被中断、
   * 或 Agent 中途改了但没走到 publish），删了就真没了。宁可在目标仓库里多留
   * 一条 `node/<runId>/<nodeId>`，也不赌一把。
   *
   * 前提是 `repoRoot` 指向**目标仓库**而不是编排器自己：分支理应长在用户
   * 工程的 git 里，编排器自己的仓库只该有 main。
   */
  async release(runId: string, nodeId: string): Promise<void> {
    const dir = await ownedPath(this.worktreeRoot, runId, nodeId);
    if (!existsSync(dir)) {
      return;
    }

    // --force：跳过「有未提交改动」的拒绝，但那份改动对应的分支仍然留着
    const removed = await this.gitRun(
      ['worktree', 'remove', '--force', dir],
      this.repoRoot,
    );
    if (!removed.ok) {
      // git 有时因目录非空（构建产物、node_modules）而拒绝。目录本身是
      // 我们建的，直接删掉再让 git 忘掉这条登记即可。
      await rm(dir, { recursive: true, force: true }).catch(() => {});
      await this.gitRun(['worktree', 'prune'], this.repoRoot);
    }

    // 基线 ref 只是 prepare 的内部记账，留着没用；分支不动
    await this.gitRun(['update-ref', '-d', this.baseRef(runId, nodeId)], this.repoRoot);

    /**
     * 顺手收掉空的运行目录。
     *
     * 每个节点有自己的子目录，节点删完之后 `<worktreeRoot>/<runId>/` 就成了
     * 空壳。不清的话 `.worktrees` 里会留下一排只含空目录的运行 id，用户看不出
     * 哪些还在用、也不敢整体删。
     *
     * 只在确实为空时才删：还有兄弟节点在跑时这里必须留着。
     */
    const runDir = resolve(this.worktreeRoot, runId);
    try {
      if (existsSync(runDir) && readdirSync(runDir).length === 0) {
        rmdirSync(runDir);
      }
    } catch {
      // 目录被别人同时删掉、或还有兄弟节点：都不是问题
    }
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
    if (!status.ok) {
      return { ok: false, reason: `读取节点 ${nodeId} 工作区失败：${status.stderr.trim()}` };
    }
    if (!status.stdout.trim()) {
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
    base: string,
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
        : await this.gitRun(['worktree', 'add', '-b', branch, dir, base], this.repoRoot);

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

    const runBase = await this.commitAt(this.baseRef(runId));
    const prepared = await this.ensureIntegration(runId, targetBranch, dir, runBase ?? 'HEAD');
    if (!prepared.ok) {
      return { ok: false, branch: targetBranch, conflicts: [], merged, reason: prepared.reason };
    }

    const status = await this.gitRun(['status', '--porcelain'], dir);
    if (!status.ok || status.stdout.trim()) {
      return { ok: false, branch: targetBranch, conflicts: [], merged, reason: '集成工作区有未提交改动或无法读取' };
    }
    const integrationRef = `refs/orchestrator/integration/${runId}/commit`;
    const current = await this.commitAt(`refs/heads/${targetBranch}`);
    const previous = await this.commitAt(integrationRef);
    if (previous && current !== previous) {
      return { ok: false, branch: targetBranch, conflicts: [], merged, reason: '集成分支有手动提交，请确认后再合并' };
    }
    if (runBase && (previous || current === runBase)) {
      const reset = await this.gitRun(['reset', '--keep', runBase], dir);
      if (!reset.ok) {
        return { ok: false, branch: targetBranch, conflicts: [], merged, reason: reset.stderr.trim() };
      }
      const recorded = await this.gitRun(['update-ref', integrationRef, runBase], dir);
      if (!recorded.ok) {
        return { ok: false, branch: targetBranch, conflicts: [], merged, reason: recorded.stderr.trim() };
      }
    }

    for (const nodeId of nodeIds) {
      const nodeBranch = this.branchOf(runId, nodeId);
      let commit: string;
      try {
        commit = await this.nodeCommit(runId, nodeId);
      } catch (error) {
        return { ok: false, branch: targetBranch, conflicts: [], merged, reason: (error as Error).message };
      }
      const result = await this.gitRun(['merge', '--no-ff', commit, '-m', `merge ${nodeBranch}`], dir);
      if (result.ok) {
        merged.push(nodeId);
        const recorded = await this.gitRun(['update-ref', integrationRef, 'HEAD'], dir);
        if (!recorded.ok) {
          return { ok: false, branch: targetBranch, conflicts: [], merged, reason: recorded.stderr.trim() };
        }
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

  async removeRun(runId: string): Promise<void> {
    assertRunId(runId);
    await rm(await ownedPath(this.root, runId), { recursive: true, force: true });
  }

  async prepare(runId: string, nodeId: string): Promise<string> {
    const dir = await ownedPath(this.root, runId, nodeId);
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
    await rm(await ownedPath(this.root, runId, nodeId), {
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

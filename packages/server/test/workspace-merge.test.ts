import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { GitWorktreeWorkspace } from '../src/workspace';

/**
 * 真实 git 的合并集成测试。
 *
 * 假工作区测不出真正会出事的地方：worktree 的创建参数、未提交改动有没有
 * 落成提交、冲突时集成分支能不能收干净。这里在临时仓库里跑真的 git 与
 * 真的 worktree，Windows 与 Linux 都要跑得通，所以路径一律走 node:path，
 * git 一律走 execFile（不经过 shell，避免引号与转义差异）。
 */

const execFileAsync = promisify(execFile);

/** 每个用例建的临时仓库，afterEach 统一清掉 */
const tempRepos: string[] = [];

const g = { windowsHide: true, timeout: 120_000 } as const;

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd, ...g });
  return stdout;
}

interface Fixture {
  root: string;
  workspace: GitWorktreeWorkspace;
}

async function createRepo(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), 'orchestrator-merge-'));
  tempRepos.push(root);

  await execFileAsync('git', ['init'], { cwd: root, ...g });
  // 本机可能没有全局身份，临时仓库自带一份，否则 merge 提交会直接失败
  await git(root, ['config', 'user.name', 'Orchestrator Test']);
  await git(root, ['config', 'user.email', 'test@example.invalid']);
  // Windows 默认 autocrlf 会改写换行，冲突与否会跟着漂移；显式关掉保证两端一致
  await git(root, ['config', 'core.autocrlf', 'false']);
  // 全局 gpgsign 开着时，没有密钥的环境提交会失败
  await git(root, ['config', 'commit.gpgsign', 'false']);

  await writeFile(join(root, 'README.md'), '# fixture\n', 'utf8');
  await git(root, ['add', '--all']);
  await git(root, ['commit', '-m', 'init']);

  return { root, workspace: new GitWorktreeWorkspace(root) };
}

/** 集成工作区目录，与 GitWorktreeWorkspace 内部的布局一致 */
function integrationDirOf(root: string, runId: string): string {
  return join(root, '.worktrees', runId, '_integration');
}

afterEach(async () => {
  // Windows 上 worktree 里的文件句柄释放得慢，删不掉就重试几次；
  // 临时目录残留不该让测试判红
  await Promise.all(
    tempRepos.splice(0).map((root) =>
      rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(
        () => {},
      ),
    ),
  );
});

describe('GitWorktreeWorkspace.merge（真实 git）', () => {
  it('两个节点改同一个文件时返回冲突，并保守地回滚现场', async () => {
    const { root, workspace } = await createRepo();
    const runId = 'run-conflict';
    const targetBranch = `run/${runId}`;

    // 两个节点各自在自己的 worktree 里改同一处，且都不提交——
    // 这正是真实 Agent 的形态：改动留在工作区里
    const dirA = await workspace.prepare(runId, 'impl-a');
    const dirB = await workspace.prepare(runId, 'impl-b');
    await writeFile(join(dirA, 'shared.txt'), 'from a\n', 'utf8');
    await writeFile(join(dirB, 'shared.txt'), 'from b\n', 'utf8');

    const result = await workspace.merge({
      runId,
      nodeIds: ['impl-a', 'impl-b'],
      targetBranch,
    });

    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error('同一文件的同一处改动应当冲突');
    }
    expect(result.branch).toBe(targetBranch);
    expect(result.conflicts).toContain('shared.txt');
    // 第一个节点确实合进去了，冲突不能把既成事实抹掉
    expect(result.merged).toEqual(['impl-a']);
    expect(result.reason).toContain('impl-b');

    // 现场必须收干净：留着 MERGING 状态，下一次合并会直接报错
    const integration = integrationDirOf(root, runId);
    const status = await git(integration, ['status', '--porcelain']);
    expect(status).not.toContain('UU');
    expect(existsSync(join(integration, '.git')) || existsSync(integration)).toBe(true);
  });

  it('两个节点改不同文件时合并成功，merged 如实列出两个节点', async () => {
    const { root, workspace } = await createRepo();
    const runId = 'run-clean';
    const targetBranch = `run/${runId}`;

    const dirC = await workspace.prepare(runId, 'impl-c');
    const dirD = await workspace.prepare(runId, 'impl-d');
    await writeFile(join(dirC, 'c.txt'), 'c\n', 'utf8');
    await writeFile(join(dirD, 'd.txt'), 'd\n', 'utf8');

    const result = await workspace.merge({
      runId,
      nodeIds: ['impl-c', 'impl-d'],
      targetBranch,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error(`合并应当成功，实际失败：${result.reason}`);
    }
    expect(result.branch).toBe(targetBranch);
    expect(result.merged).toEqual(['impl-c', 'impl-d']);
    expect(result.commit).toMatch(/^[0-9a-f]{40}$/);

    // 未提交的改动要真的进集成分支：两个文件都在集成工作区里
    const integration = integrationDirOf(root, runId);
    expect(await readFile(join(integration, 'c.txt'), 'utf8')).toBe('c\n');
    expect(await readFile(join(integration, 'd.txt'), 'utf8')).toBe('d\n');

    // 重复合并同一批节点应当成功且幂等：集成分支与目录都要被复用，
    // 而不是因为「分支已存在」直接报错
    const again = await workspace.merge({
      runId,
      nodeIds: ['impl-c', 'impl-d'],
      targetBranch,
    });
    expect(again.ok).toBe(true);
    if (again.ok) {
      expect(again.merged).toEqual(['impl-c', 'impl-d']);
    }

    // 合并结束后不删节点 worktree 与分支：冲突排查需要现场
    expect(await git(root, ['branch', '--list', `node/${runId}/impl-c`])).toContain('impl-c');
    expect(existsSync(join(root, '.worktrees', runId, 'impl-c'))).toBe(true);
  });

  it('节点分支不存在时返回结构化失败，而不是抛异常', async () => {
    const { workspace } = await createRepo();
    const runId = 'run-ghost';

    // 没有 prepare 过任何节点，直接要求合并
    const result = await workspace.merge({
      runId,
      nodeIds: ['never-ran'],
      targetBranch: `run/${runId}`,
    });

    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error('不存在的分支不该被当成合并成功');
    }
    expect(result.merged).toEqual([]);
    expect(result.conflicts).toEqual([]);
    expect(result.reason).toContain('never-ran');
  });
});

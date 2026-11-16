import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { promisify } from 'node:util';
import type { FastifyInstance } from 'fastify';
import type { AgentProfile } from '@orchestrator/core';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app';
import type { RunStore } from '../src/store';

/**
 * 「这个运行在哪儿干活」的接口契约。
 *
 * 这一组用例守的是一个设计缺陷的修复：以前所有运行的成果都堆在启动 server
 * 的那个目录里，目标目录从来没被问过。所以这里断言的不是「能不能建运行」，
 * 而是三件事：
 *   - 目录不可用时**不许**建运行（静默回退到默认目录是最坏的失败方式）；
 *   - 目录可用时它必须原样进事实，并能被读回来；
 *   - 什么都没给时才用默认值，而默认值本身要能从 /api/runtime 看到。
 */

const execFileAsync = promisify(execFile);
const g = { windowsHide: true, timeout: 120_000 } as const;

const tempDirs: string[] = [];
const originalEnv = {
  runner: process.env.AGENT_RUNNER,
  workspace: process.env.AGENT_WORKSPACE,
  artifactDir: process.env.AGENT_ARTIFACT_DIR,
  worktreeDir: process.env.AGENT_WORKTREE_DIR,
  targetDir: process.env.AGENT_TARGET_DIR,
};

/**
 * 一个「本机装好了」的 Agent：探测只看可执行文件能否解析到，
 * 因此结果与开发机上装没装 claude / codex 无关。
 */
function agent(id: string): AgentProfile {
  return {
    id,
    label: id,
    vendor: 'test',
    logo: `/logos/${id}.svg`,
    launch: { bin: 'node', args: ['{prompt}'], stdin: false, parser: 'plain' },
    capabilities: { streaming: true, structured: true, resume: false, tools: true },
    availability: 'ready',
    enabled: true,
    permissionArgs: {
      default: [],
      'accept-edits': [],
      auto: [],
      'bypass-permissions': [],
    },
    session: { derive: 'none', resumeArgs: [] },
    timeoutMs: 30_000,
  };
}

/** 客户端自带的图：跳过拆解，创建路径是同步的，断言只落在目录这件事上。 */
const HANDWRITTEN_DAG = {
  title: '手写图',
  summary: '客户端自带的任务图',
  specVersion: 'v1.0',
  nodes: [
    {
      id: 'impl-a',
      type: 'implement',
      title: '实现 A',
      description: '按目标实现',
      dependsOn: [],
      files: ['src/a/**'],
      agentId: 'claude',
      maxAttempts: 3,
    },
  ],
};

interface Fixture {
  app: FastifyInstance;
  store: RunStore;
  /** 本次用例的临时根目录（日志、产物、worktree 都在这下面） */
  root: string;
}

/**
 * 建一个应用实例。
 *
 * `mode` 决定工作区实现：`git` 走真实 worktree（校验会检查目标目录是不是
 * git 仓库），`temp` 是降级路径（不检查 git）。两者的校验差异正是要验的东西，
 * 所以由用例显式选。`targetDir` 用来给 `AGENT_TARGET_DIR` 赋值——必须在
 * buildApp 之前设好，默认目录是那一刻算出来的。
 */
async function createFixture(
  mode: 'git' | 'temp' = 'git',
  targetDir?: string,
): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), 'orchestrator-workspace-'));
  tempDirs.push(root);

  process.env.AGENT_RUNNER = 'mock';
  process.env.AGENT_WORKSPACE = mode;
  process.env.AGENT_ARTIFACT_DIR = join(root, 'artifacts');
  // 节点 worktree 落在临时根下：既证明它不在目标仓库里，也不会写脏工作区
  process.env.AGENT_WORKTREE_DIR = join(root, 'worktrees');
  if (targetDir === undefined) {
    delete process.env.AGENT_TARGET_DIR;
  } else {
    process.env.AGENT_TARGET_DIR = targetDir;
  }

  const { app, store } = await buildApp({
    logPath: join(root, 'events.jsonl'),
    catalog: [agent('claude')],
    logger: false,
  });
  await app.ready();

  return { app, store, root };
}

/** 造一个真的 git 仓库：只有它才配当 git 模式下的目标目录。 */
async function createRepo(root: string, name = 'repo'): Promise<string> {
  const dir = join(root, name);
  await mkdir(dir, { recursive: true });
  await execFileAsync('git', ['init'], { cwd: dir, ...g });
  // 本机可能没有全局身份；worktree/提交都不该依赖开发者的 git 配置
  await execFileAsync('git', ['config', 'user.name', 'Orchestrator Test'], { cwd: dir, ...g });
  await execFileAsync('git', ['config', 'user.email', 'test@example.invalid'], {
    cwd: dir,
    ...g,
  });
  await execFileAsync('git', ['config', 'commit.gpgsign', 'false'], { cwd: dir, ...g });
  await execFileAsync('git', ['config', 'core.autocrlf', 'false'], { cwd: dir, ...g });
  await execFileAsync('git', ['commit', '--allow-empty', '-m', 'init'], { cwd: dir, ...g });
  return dir;
}

function createRun(app: FastifyInstance, payload: Record<string, unknown>) {
  return app.inject({ method: 'POST', url: '/api/runs', payload });
}

/** 让 fire-and-forget 的推进链路收尾，再关应用。 */
async function settle(ms = 250): Promise<void> {
  await new Promise((resolveTimer) => setTimeout(resolveTimer, ms));
}

/**
 * 轮询到节点进入终态。
 *
 * 别用固定睡眠断言「已经跑完」：那条断言写的是时间，不是行为。执行链路一变长
 * （哪怕只是多了一次 git 调用），固定睡眠就先到点、断言先失败，而功能其实是
 * 好的。轮询到终态才是在断言真正在意的东西。
 */
async function waitForStatus(
  app: FastifyInstance,
  runId: string,
  nodeId: string,
  done: (status: string | undefined) => boolean,
  timeoutMs = 10_000,
): Promise<string | undefined> {
  const deadline = Date.now() + timeoutMs;
  let status: string | undefined;
  while (Date.now() < deadline) {
    const response = await app.inject({ method: 'GET', url: `/api/runs/${runId}` });
    const body = response.json() as { nodes: Array<{ id: string; status: string }> };
    status = body.nodes.find((item) => item.id === nodeId)?.status;
    if (done(status)) {
      return status;
    }
    await new Promise((resolveTimer) => setTimeout(resolveTimer, 50));
  }
  return status;
}

/** 现有运行的条数：用来证明被拒的请求一条事实都没留下。 */
function runCount(store: RunStore): number {
  return Object.keys(store.snapshot.runs).length;
}

afterEach(async () => {
  const restore = (key: string, value: string | undefined): void => {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  };
  restore('AGENT_RUNNER', originalEnv.runner);
  restore('AGENT_WORKSPACE', originalEnv.workspace);
  restore('AGENT_ARTIFACT_DIR', originalEnv.artifactDir);
  restore('AGENT_WORKTREE_DIR', originalEnv.worktreeDir);
  restore('AGENT_TARGET_DIR', originalEnv.targetDir);

  await Promise.all(
    tempDirs.splice(0).map((dir) =>
      rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(
        () => {},
      ),
    ),
  );
});

describe('POST /api/runs：目标目录的解析与校验', () => {
  it('目录不存在：自动创建并 git init，而不是让用户先去手动建', async () => {
    const { app, store, root } = await createFixture();
    const missing = join(root, 'brand-new-project');
    expect(existsSync(missing)).toBe(false);

    const response = await createRun(app, {
      title: '新项目',
      goal: '在这个还不存在的目录里开一个新项目',
      dag: HANDWRITTEN_DAG,
      workspaceRoot: missing,
    });

    // 用户填一个还不存在的路径，意思就是「在这里开个新项目」。
    // 让他先去 mkdir + git init 只是仪式，而且多半会漏掉后者。
    expect(response.statusCode).toBe(201);
    expect(existsSync(missing)).toBe(true);
    expect(existsSync(join(missing, '.git'))).toBe(true);

    // 空仓库没有 HEAD，`git worktree add ... HEAD` 会直接失败
    // （Not a valid object name），整个拆解阶段就卡在这。必须补一个基线提交。
    const head = await execFileAsync('git', ['rev-parse', '--verify', 'HEAD'], {
      cwd: missing,
      windowsHide: true,
    }).then(
      () => true,
      () => false,
    );
    expect(head).toBe(true);

    const runId = (response.json() as { id: string }).id;
    expect(store.snapshot.runs[runId]?.workspaceRoot).toBe(missing);

    await app.close();
  });

  it('已存在但不是 git 的目录：就地初始化，不卡住用户', async () => {
    const { app, store, root } = await createFixture('git');
    const plain = join(root, 'user-existing-dir');
    await mkdir(plain, { recursive: true });
    expect(existsSync(join(plain, '.git'))).toBe(false);

    const response = await createRun(app, {
      title: '已有目录',
      goal: '应当被就地初始化',
      dag: HANDWRITTEN_DAG,
      workspaceRoot: plain,
    });

    // 让用户退出编排器、去开一个终端敲 git init、再回来，纯属摩擦。
    // git init 可逆（删掉 .git 就回到原样），卡住流程不可逆。
    expect(response.statusCode).toBe(201);
    expect(existsSync(join(plain, '.git'))).toBe(true);

    const runId = (response.json() as { id: string }).id;
    expect(store.snapshot.runs[runId]?.workspaceRoot).toBe(plain);

    await app.close();
  });

  it('已存在的普通目录：就地 git init，run 记下这个目录', async () => {
    const { app, store, root } = await createFixture('git');
    const plain = join(root, 'plain-dir');
    await mkdir(plain, { recursive: true });

    const response = await createRun(app, {
      title: '不是仓库',
      goal: '应当被就地初始化',
      dag: HANDWRITTEN_DAG,
      workspaceRoot: plain,
    });

    expect(response.statusCode).toBe(201);
    expect(existsSync(join(plain, '.git'))).toBe(true);
    const runId = (response.json() as { id: string }).id;
    expect(store.snapshot.runs[runId]?.workspaceRoot).toBe(plain);

    await app.close();
  });

  it('合法 git 目录：201，/api/runs/:id 读得回 workspaceRoot，且节点真的在那个仓库里跑', async () => {
    const { app, root } = await createFixture('git');
    const target = await createRepo(root);

    const response = await createRun(app, {
      title: '在目标仓库里干活',
      goal: '实现一个计算器',
      dag: HANDWRITTEN_DAG,
      workspaceRoot: target,
    });

    expect(response.statusCode).toBe(201);
    const created = response.json() as { id: string; workspaceRoot: string };
    expect(created.workspaceRoot).toBe(target);

    const detail = await app.inject({ method: 'GET', url: `/api/runs/${created.id}` });
    expect(detail.statusCode).toBe(200);
    expect((detail.json() as { workspaceRoot: string }).workspaceRoot).toBe(target);

    /**
     * 端到端证据：节点必须真的跑完。
     *
     * `git worktree add` 是从**目标仓库**里建出来的，一旦它失败，节点会落成
     * `工作区准备失败`。所以「completed」这一条同时证明了三件事：目标目录被
     * 用上了、仓库确实是 git 仓库、worktree 建在了编排器自己的 data 下。
     *
     * 轮询到终态而不是睡固定时长：这条断言在意的是结果，不是耗时。
     */
    const status = await waitForStatus(
      app,
      created.id,
      'impl-a',
      (value) => value === 'completed' || value === 'failed',
    );
    expect(status).toBe('completed');

    // 用户仓库里不该留下任何编排器的东西
    expect(existsSync(join(target, '.worktrees'))).toBe(false);

    await app.close();
  });

  it('不传目录且服务未配置默认值：400 workspace_required，绝不猜一个目录', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orchestrator-required-'));
    tempDirs.push(root);
    delete process.env.AGENT_TARGET_DIR;
    process.env.AGENT_RUNNER = 'mock';
    process.env.AGENT_WORKSPACE = 'temp';
    process.env.AGENT_ARTIFACT_DIR = join(root, 'artifacts');
    process.env.AGENT_WORKTREE_DIR = join(root, 'worktrees');

    const { app, store } = await buildApp({ logPath: join(root, 'events.jsonl') });
    const before = runCount(store);

    const response = await createRun(app, {
      title: '没选目录',
      goal: '应当被拒绝',
      dag: HANDWRITTEN_DAG,
    });

    // 目标目录是必填项：猜一个（比如进程工作目录）会让成果落在用户没打算
    // 动的地方，而他直到发现文件跑错位置才知道。
    expect(response.statusCode).toBe(400);
    const body = response.json() as { error: string; message: string };
    expect(body.error).toBe('workspace_required');
    expect(body.message).toContain('目标目录');
    expect(runCount(store)).toBe(before);

    await app.close();
  });

  it('不传目录：回落到 AGENT_TARGET_DIR，/api/runtime 把同一个默认值给前端', async () => {
    // 默认目录在 buildApp 那一刻定下，所以必须先把目标仓库准备好
    const staging = await mkdtemp(join(tmpdir(), 'orchestrator-target-'));
    tempDirs.push(staging);
    const target = await createRepo(staging);

    const { app } = await createFixture('git', target);

    const runtime = (await app.inject({ method: 'GET', url: '/api/runtime' })).json() as {
      defaultWorkspaceRoot: string;
    };
    expect(runtime.defaultWorkspaceRoot).toBe(resolve(target));

    const response = await createRun(app, {
      title: '不指定目录',
      goal: '用默认值',
      dag: HANDWRITTEN_DAG,
    });

    expect(response.statusCode).toBe(201);
    expect((response.json() as { workspaceRoot: string }).workspaceRoot).toBe(
      resolve(target),
    );

    await settle();
    await app.close();
  });

  it('相对路径被归一化成绝对路径再落进事实', async () => {
    const { app, root } = await createFixture('git');
    const target = await createRepo(root);

    const response = await createRun(app, {
      title: '相对路径',
      goal: '应当被归一化',
      dag: HANDWRITTEN_DAG,
      workspaceRoot: relative(process.cwd(), target),
    });

    expect(response.statusCode).toBe(201);
    const body = response.json() as { workspaceRoot: string };
    expect(body.workspaceRoot).toBe(resolve(target));

    await settle();
    await app.close();
  });
});

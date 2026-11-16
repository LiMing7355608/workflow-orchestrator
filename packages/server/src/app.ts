import { randomUUID } from 'node:crypto';
import { existsSync, statSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import type { ServerResponse } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve } from 'node:path';
import Fastify, { type FastifyBaseLogger, type FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  DEFAULT_AGENT_PROFILES,
  advanceRun,
  createAgentEventRelay,
  deriveBoard,
  deriveEdges,
  deriveEvents,
  deriveNodeStatus,
  deriveRunDetail,
  deriveRunStatus,
  deriveRunView,
  findAgent,
  isRunSettled,
  nodeInFlightKey,
  runNode,
  reworkTarget,
  type AdvanceDeps,
  type AgentProfile,
  type AgentRunner,
  type NodeFacts,
  type OrchestratorEvent,
  type RunFacts,
  type WorkspacePort,
} from '@orchestrator/core';
import {
  DagGenerationError,
  amendDag,
  generateDag,
  parseDag,
  pickPlannerAgent,
  safeParseDag,
  validateDag,
  type AmendedPlan,
  type Dag,
} from '@orchestrator/planner';
import { ArtifactStore } from './artifacts.js';
import { buildAmendmentReply, dagFromFacts, diffDag } from './amend.js';
import type { LockHandle } from './locks.js';
import type { LogFn, LogSink } from './log.js';
import { probeCatalog } from './probe.js';
import type { ProcessRegistry } from './registry.js';
import { MockAgentRunner, SpawnAgentRunner } from './runners.js';
import { buildSeedEvents } from './seed.js';
import { SESSION_NAMESPACE, createSessionIdDeriver } from './session-id.js';
import { RunStore } from './store.js';
import { GitWorktreeWorkspace, TempDirWorkspace, isGitWorkTree } from './workspace.js';

const execFileAsync = promisify(execFile);

export interface AppOptions {
  /** 事件日志路径，JSONL 追加写 */
  logPath: string;
  /** 覆盖默认 Agent 目录，测试用 */
  catalog?: AgentProfile[];
  /**
   * 结构化日志开关。缺省按 `LOG_LEVEL`（默认 info）打开 pino；
   * 传 `false` 彻底关掉（单测里不希望有日志噪声时用）。
   */
  logger?: boolean | { level?: string };
  /** 分片参数，覆盖 EventJournal 的默认值（8MB / 5 个活跃归档） */
  journal?: { maxBytesPerShard?: number; maxShards?: number };
  /**
   * 子进程登记簿。传入则真拉起 Agent 时会登记 / 注销；
   * 不传就是「不登记」，与接入登记簿之前的行为一致。
   */
  registry?: ProcessRegistry;
  /**
   * 数据目录锁句柄。buildApp 不自己获取也不释放它——锁的生死属于进程
   * 生命周期，不属于应用实例；这里只是接收并带出去，避免调用方为了
   * 把它挂在上下文里再包一层。
   */
  lock?: LockHandle;
}

export interface AppContext {
  app: FastifyInstance;
  store: RunStore;
  getCatalog: () => AgentProfile[];
  /** 原样带出调用方传进来的锁句柄，未传则为 undefined */
  lock?: LockHandle;
}

const approvalBodySchema = z.object({
  decision: z.enum(['approve', 'reject', 'handoff']),
  /**
   * 审批人。这里没有默认值：身份的真实来源是 `X-Actor` 请求头，
   * body 只是兼容手工调用（curl、e2e）时的兜底，两边都没有才算 anonymous。
   * 以前默认写死成某个小组名，等于把「谁批的」这件事伪造成常量。
   */
  actor: z.string().min(1).optional(),
  reason: z.string().optional(),
  handoffTo: z.string().min(1).optional(),
});

const createRunBodySchema = z.object({
  title: z.string().min(1),
  goal: z.string().min(1),
  /** 省略时由 Planner 依据 goal 现生成；显式给出则走客户端手写的老路 */
  dag: z.unknown().optional(),
  /** 用哪个 Agent 拆图。省略时按「装好了 + 能结构化输出」自动挑 */
  plannerAgentId: z.string().min(1).optional(),
  /** 覆盖 DAG 里的实现节点 Agent */
  implementAgentId: z.string().min(1).optional(),
  /** 覆盖 DAG 里的审查节点 Agent；与实现用不同的 Agent 才能有异构视角 */
  reviewAgentId: z.string().min(1).optional(),
  /**
   * 这次运行在哪儿干活：目标仓库的绝对路径。
   *
   * 省略时按 `AGENT_TARGET_DIR` → 服务启动目录依次回落，但**一旦给了就必须
   * 可用**：路径不存在、或不是 git 仓库时直接 400，绝不静默换成默认目录——
   * 用户填错路径却在他自己的目录里跑，是最糟的一种失败方式。
   */
  workspaceRoot: z.string().min(1).optional(),
});

/** 编排器对话：一句话指令 + 可选的自报身份。 */
const runMessageBodySchema = z.object({
  text: z.string().min(1),
  /** 与审批一致：身份优先取请求头，body 只是手工调用的兜底 */
  actor: z.string().min(1).optional(),
});

/**
 * 节点重置的请求体。
 *
 * 允许空 body：重置本身没有参数。reason 只是为了在审计行里留下
 * 「为什么退回重做」，缺省时接口写「用户手动重置」。
 */
const resetNodeBodySchema = z.object({
  reason: z.string().min(1).optional(),
});

/**
 * 一次异步拆解的输入。
 *
 * 创建运行的请求在返回之后就不存在了，所以它需要的东西必须整包带走：
 * 目标、调用方点名的 Agent、角色覆盖。少带一样，后台那条链就只能去读
 * 已经不在作用域里的请求状态。
 */
interface PlanRequest {
  goal: string;
  /** 调用方显式指定的拆图 Agent；留空由 Planner 按目录自己挑 */
  requestedAgentId?: string;
  /**
   * 这次运行已经校验过的目标目录（绝对路径）。
   *
   * 必须整包带走：拆解发生在响应返回之后，那一刻请求对象早就不在了，
   * 而 Planner 要为它准备一个落在这个仓库里的工作区。
   */
  workspaceRoot: string;
  /** 角色覆盖：图结构照旧，只换同角色节点的 Agent */
  roles: { implementAgentId?: string; reviewAgentId?: string };
}

/**
 * 把 fastify 自带的 pino 适配成最小日志面。
 *
 * 适配放在这一层，是为了让 store / probe / runners 完全不认识 fastify：
 * 它们只需要「打一条日志」，具体落到 pino、console 还是测试里的数组，
 * 由调用方决定。
 */
function toLogSink(logger: FastifyBaseLogger): LogSink {
  const write =
    (level: 'debug' | 'warn' | 'error'): LogFn =>
    (message, detail) => {
      // Error 必须放 err 字段：pino 对普通对象只会序列化自有可枚举属性，
      // Error 的 message / stack 都在原型与不可枚举位上，直接传就丢了
      if (detail === undefined) {
        logger[level](message);
        return;
      }
      logger[level](detail instanceof Error ? { err: detail } : { detail }, message);
    };

  return { debug: write('debug'), warn: write('warn'), error: write('error') };
}

/** `LOG_LEVEL` 是环境变量的既定名字，缺省 info；`false` 表示彻底关掉。 */
function resolveLogger(option: AppOptions['logger']): false | { level: string } {
  if (option === false) {
    return false;
  }
  const level =
    (typeof option === 'object' ? option.level : undefined) ??
    process.env.LOG_LEVEL ??
    'info';
  return { level };
}

/** 分片参数：显式传入优先，其次环境变量，最后交给 EventJournal 的默认值。 */
function resolveJournal(
  option: AppOptions['journal'],
): { maxBytesPerShard?: number; maxShards?: number } {
  const fromEnv = (name: string): number | undefined => {
    const raw = process.env[name];
    if (!raw) {
      return undefined;
    }
    const value = Number(raw);
    // 非数字或 0 直接当没配：让 EventJournal 用自己的下限兜住，而不是把日志写坏
    return Number.isFinite(value) && value > 0 ? value : undefined;
  };
  return {
    maxBytesPerShard: option?.maxBytesPerShard ?? fromEnv('JOURNAL_MAX_BYTES_PER_SHARD'),
    maxShards: option?.maxShards ?? fromEnv('JOURNAL_MAX_SHARDS'),
  };
}

/**
 * 解出请求头里的审批人名字。
 *
 * HTTP 头的值只能是 latin-1 字节，中文名字没法直接放进去——浏览器端
 * `Headers.set` 会直接抛 TypeError。所以约定前端一律 `encodeURIComponent`
 * 后再放进头里，这里解码。裸值（curl 手敲的中文会先变成乱码，但 ASCII
 * 名字一直是合法的）原样返回，解码失败也原样返回：宁可名字有点脏，
 * 也不能因为一个请求头让整个取数链路返回 500。
 */
function decodeActorHeader(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) {
    return undefined;
  }
  try {
    return decodeURIComponent(trimmed);
  } catch {
    return trimmed;
  }
}

/**
 * 把目标压成一行摘要。
 *
 * 前端会把「分解粒度 / 并行度 / 审查轮次」这些设置拼在目标末尾当提示，
 * 摘要只取第一个段落，免得列表页每条都拖着同一串设置。
 */
function summarizeGoal(goal: string, fallbackTitle: string): string {
  const firstBlock =
    goal
      .split(/\n\s*\n/)[0]
      ?.trim()
      .replace(/\s+/g, ' ')
      .trim() ?? '';
  if (!firstBlock) {
    return fallbackTitle.trim() || '未命名运行';
  }
  return firstBlock.length > 90 ? `${firstBlock.slice(0, 90)}…` : firstBlock;
}

/**
 * 按角色覆盖 DAG 里的执行 Agent。
 *
 * 这是「新建运行时就把谁干活定下来」的落点：Planner 拆出的图结构照旧，
 * 只把同一角色节点的 agentId 换掉。审批与路由节点不参与——那不是 Agent。
 */
function applyRoleAgents(
  dag: Dag,
  roles: { implementAgentId?: string; reviewAgentId?: string },
): Dag {
  if (!roles.implementAgentId && !roles.reviewAgentId) {
    return dag;
  }
  return {
    ...dag,
    nodes: dag.nodes.map((node) => {
      if (node.type === 'implement' && roles.implementAgentId) {
        return { ...node, agentId: roles.implementAgentId };
      }
      if (node.type === 'review' && roles.reviewAgentId) {
        return { ...node, agentId: roles.reviewAgentId };
      }
      return node;
    }),
  };
}

/**
 * 把 Planner 产出的图翻成节点事实。
 *
 * 单独抽出来，是因为有两条路径都要冻结同一张图：调用方自带 DAG（同步）与
 * 后台拆解（异步）。各写一份的话迟早会分叉——最典型的是漏掉 `action`，
 * 于是声明了 merge 的 route 节点会退化成一个空转的普通路由节点。
 */
function toNodeFacts(dag: Dag): NodeFacts[] {
  return dag.nodes.map((node) => ({
    id: node.id,
    type: node.type,
    title: node.title,
    description: node.description,
    dependsOn: node.dependsOn,
    files: node.files,
    agentId: node.agentId,
    executor: node.executor,
    // 动作必须随事实一起冻结：编排器执行 route 节点时读的是 NodeFacts
    action: node.action,
    attempts: 0,
    maxAttempts: node.maxAttempts,
  }));
}

/**
 * 从统一 diff 里抠出改动路径。
 *
 * 为什么不用节点事实里的 `artifactFiles`：那个字段是采集那一刻的快照，
 * 与磁盘上这份 diff 可能不是同一轮；接口返回的既然是这份 diff，统计量
 * 也必须由它自己推出来，摘要才不会和正文打架。
 *
 * 优先 `diff --git` 头（删除文件也有路径，`+/-` 行里的 `/dev/null` 不会
 * 干扰）；退化到 `+++ b/` 是为了兼容没有 git 前缀的纯 unified diff。
 */
function filesInDiff(diff: string): string[] {
  const fromGitHeader = new Set<string>();
  const fromHunkHeader = new Set<string>();

  for (const line of diff.split('\n')) {
    const gitHeader = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
    if (gitHeader?.[2]) {
      fromGitHeader.add(gitHeader[2].trim());
      continue;
    }
    const target = /^\+\+\+ b\/(.+)$/.exec(line);
    if (target?.[1]) {
      fromHunkHeader.add(target[1].trim());
    }
  }

  return [...(fromGitHeader.size > 0 ? fromGitHeader : fromHunkHeader)];
}

/**
 * Fastify 应用工厂。
 *
 * 拆成工厂而不是直接监听，是为了让 e2e 测试能注入自己的日志路径与目录，
 * 不必起真实端口。`main.ts` 只负责 listen。
 */
export async function buildApp(options: AppOptions): Promise<AppContext> {
  const app = Fastify({ logger: resolveLogger(options.logger) });
  const log = toLogSink(app.log);
  const store = await RunStore.open(options.logPath, buildSeedEvents, {
    journal: resolveJournal(options.journal),
    log,
  });
  const baseline = options.catalog ?? DEFAULT_AGENT_PROFILES;

  const runnerMode = process.env.AGENT_RUNNER ?? 'real';
  const workspaceMode = process.env.AGENT_WORKSPACE ?? 'git';
  const loadCatalog = async (): Promise<AgentProfile[]> =>
    runnerMode === 'mock' && !options.catalog
      ? baseline.map((agent) => ({ ...agent, availability: 'ready' }))
      : probeCatalog(baseline, log);
  let catalog = await loadCatalog();

  const resolveAgent = (agentId: string | undefined): string | undefined =>
    findAgent(agentId, catalog)?.label;

  const now = (): string => new Date().toISOString();

  /**
   * 当前操作者身份。
   *
   * 顺序：`X-Actor` 请求头 → body 的 `actor` → `'anonymous'`。
   * 头优先，是因为身份属于「谁在用这个会话」，不该被某个请求体里的字段
   * 悄悄覆盖；body 兜底只是为了让 curl 与 e2e 不必伪造请求头。
   * 全部落空时给 `anonymous` 而不是编一个名字——审批记录里最不能接受的
   * 就是看不出「这条是机器写的」。
   */
  const resolveActor = (
    headers: Record<string, string | string[] | undefined>,
    bodyActor?: string,
  ): string => {
    const raw = headers['x-actor'];
    const header = Array.isArray(raw) ? raw[0] : raw;
    const fromHeader = decodeActorHeader(header);
    if (fromHeader) {
      return fromHeader;
    }
    const fromBody = bodyActor?.trim();
    return fromBody ? fromBody : 'anonymous';
  };

  /** 会话 id 派生器只在这里实例化一次：命名空间解析失败要尽早炸，而不是等第一个节点重跑。 */
  const deriveSessionId = createSessionIdDeriver(SESSION_NAMESPACE);

  /**
   * derive 系列要的是可变数组，这里只拷该 run 的事件。
   *
   * 之前传的是 `[...store.history]`——每次请求拷全量事件，run 一多就是
   * 明显的一次性分配；现在只碰自己那个 run。
   */
  const runEvents = (runId: string): OrchestratorEvent[] => [
    ...store.eventsForRun(runId),
  ];

  /* ---------------------------------------------------------------- *
   * 执行层：Agent 执行器与工作区
   * ---------------------------------------------------------------- */

  // 默认真跑：用户要的是看到 Agent 实际执行，回放只是没有可执行 Agent 时的兜底
  const runner: AgentRunner =
    runnerMode === 'real'
      ? new SpawnAgentRunner(options.registry, log)
      : new MockAgentRunner(workspaceMode === 'git');

  // 默认 git：只有真 git worktree 才产得出 diff，审查节点也才有东西可审。
  // temp 保留作为降级选项——在没有 git 的环境里仍能跑通整条编排链路，
  // 代价是审查提示词里只会有一句「该上游节点没有产出 diff」。
  /**
   * 编排器自己的数据根目录（启动目录），与「这次在哪干活」完全无关。
   *
   * 两者之前是同一个值（`process.cwd()` 既当仓库根又当数据根），于是所有运行
   * 都被钉死在启动 server 的那个仓库里。现在这里只用来定位 data/*。
   */
  const dataRoot = process.cwd();

  /**
   * 各节点 worktree 的存放根，集中在编排器自己的 data 目录下。
   *
   * 为什么不能写进目标仓库：那是用户自己的工程，往里面塞 `.worktrees/`
   * 等于让他替我们清理垃圾，`git status` 也会被一堆临时目录污染。
   */
  const worktreeRoot = process.env.AGENT_WORKTREE_DIR
    ? resolve(process.env.AGENT_WORKTREE_DIR)
    : resolve(dataRoot, 'data/worktrees');

  /**
   * 默认目标目录：请求没给、也没有 `AGENT_TARGET_DIR` 时用它。
   *
   * 保留启动目录作为兜底是为了不改变老用法的行为（在哪个仓库里启动就在哪个
   * 仓库里干活）；但用户一旦填了目录，就必须按他填的那个来。
   */
  const defaultWorkspaceRoot = resolve(process.env.AGENT_TARGET_DIR ?? process.cwd());

  /**
   * 按目标目录缓存工作区实例。
   *
   * 复用是安全的：实例本身无状态，真正的隔离是每个节点各自的
   * `<worktreeRoot>/<runId>/<nodeId>`。缓存省下的是重复的目录判断与 git 调用。
   */
  const workspaces = new Map<string, WorkspacePort>();

  /** 取出某个目标目录对应的工作区实现。 */
  function workspaceAt(root: string): WorkspacePort {
    const cached = workspaces.get(root);
    if (cached) {
      return cached;
    }
    const created: WorkspacePort =
      workspaceMode === 'git'
        ? new GitWorktreeWorkspace(root, worktreeRoot)
        : new TempDirWorkspace(worktreeRoot);
    workspaces.set(root, created);
    return created;
  }

  /**
   * 这个运行该用哪个工作区。
   *
   * 空 `workspaceRoot` 是旧 journal 的兜底值（见 core 里 `run.created` 的归约）：
   * 那些运行创建时还没有「目标目录」这个概念，只能按默认根目录继续跑——
   * 否则重启之后一条历史运行连工作区都要不出来。
   */
  function workspaceFor(run: RunFacts): WorkspacePort {
    return workspaceAt(run.workspaceRoot ? resolve(run.workspaceRoot) : defaultWorkspaceRoot);
  }

  /**
   * 保证仓库有一个 HEAD 提交。
   *
   * 新建/就地初始化的仓库是空的，没有 HEAD，而 `git worktree add ... HEAD`
   * 必须有一个有效的起始对象——否则报 `Not a valid object name: 'HEAD'`，
   * 整个拆解阶段直接失败。刚 init 出来的仓库本来就该有个起点，补一个空提交
   * 是最小代价的做法。
   *
   * 身份用 `-c` 临时指定：用户的全局 git 配置可能根本没有 user.name，
   * 那样 commit 会以「Please tell me who you are」失败，把一个内部步骤
   * 变成用户看不懂的错误。
   */
  async function ensureHeadCommit(root: string): Promise<void> {
    try {
      await execFileAsync('git', ['rev-parse', '--verify', 'HEAD'], {
        cwd: root,
        windowsHide: true,
      });
      return;
    } catch {
      // 没有 HEAD：继续往下补一个
    }

    await execFileAsync(
      'git',
      [
        '-c',
        'user.name=orchestrator',
        '-c',
        'user.email=orchestrator@localhost',
        'commit',
        '--allow-empty',
        '-m',
        'chore: 初始化仓库基线',
      ],
      { cwd: root, windowsHide: true },
    );
  }

  /** 目标目录校验的两种结局：可用，或者一句能直接展示给用户的原因。 */
  type WorkspaceCheck =
    | { ok: true; root: string }
    | { ok: false; code: 'workspace_not_found' | 'workspace_not_git'; message: string };

  /**
   * 弹一个原生目录选择框，返回用户选的绝对路径。
   *
   * 为什么要后端弹：浏览器拿不到绝对路径。File System Access API 的
   * `showDirectoryPicker()` 只给 handle，路径对前端是保密的，而编排器要的
   * 恰恰是一个能传给 git 的绝对路径。所以在 Windows 上直接调系统的
   * FolderBrowserDialog，把这个值交给前端填进输入框。
   */
  async function pickDirectory(): Promise<
    { ok: true; path: string } | { ok: false; reason: 'cancelled' | 'unsupported' | 'failed'; message?: string }
  > {
    if (process.platform !== 'win32') {
      return { ok: false, reason: 'unsupported', message: '原生目录选择只在 Windows 上提供' };
    }

    // -STA 是 WinForms 的硬要求：MTA 线程里弹窗会直接抛异常。
    const script = [
      'Add-Type -AssemblyName System.Windows.Forms | Out-Null',
      '$dialog = New-Object System.Windows.Forms.FolderBrowserDialog',
      "$dialog.Description = '选择 Agent 干活的目标目录'",
      "$dialog.ShowNewFolderButton = $true",
      "if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {",
      '  Write-Output $dialog.SelectedPath',
      '} else {',
      "  Write-Output '__CANCELLED__'",
      '}',
    ].join('\n');

    try {
      const { stdout } = await execFileAsync(
        'powershell.exe',
        ['-NoProfile', '-STA', '-Command', script],
        { windowsHide: true, timeout: 300_000 },
      );
      const picked = stdout.trim();
      if (!picked || picked === '__CANCELLED__') {
        return { ok: false, reason: 'cancelled' };
      }
      return { ok: true, path: resolve(picked) };
    } catch (error) {
      app.log.warn({ err: error }, '弹目录选择框失败');
      return { ok: false, reason: 'failed', message: (error as Error).message };
    }
  }

  app.get('/api/fs/pick-directory', async () => pickDirectory());

  /**
   * 校验一次创建请求的目标目录。
   *
   * 三道关，顺序是刻意的：
   *   1. 归一化成绝对路径——`./x`、`..`、正反斜杠混写都收敛成一个值，
   *      后面所有比较（缓存键、与旧日志对照）才可能一致；
   *   2. 必须存在且是目录。不存在就 400，**不回退**：用户填错路径、我们却
   *      在他自己的目录里跑，等于让他事后才发现成果落错了地方；
   *   3. git 模式下还必须是 git 工作树。没有 git 就建不出 worktree，而「偷偷
   *      降级成直接在用户目录里跑」会污染他的工作区（Agent 的改动没有隔离、
   *      没有 diff、审查节点也审不了），所以宁可拒绝。
   */
  async function checkWorkspaceRoot(
    requested: string | undefined,
  ): Promise<WorkspaceCheck> {
    const raw = requested?.trim() ? requested.trim() : defaultWorkspaceRoot;
    const root = resolve(raw);

    let isDirectory = false;
    try {
      isDirectory = existsSync(root) && statSync(root).isDirectory();
    } catch {
      // 权限不足、路径中间有普通文件等情况 statSync 会抛：一律按「不可用」处理
      isDirectory = false;
    }
    if (!isDirectory) {
      // 新目录：编排器自己建好并初始化仓库。
      //
      // 用户填一个还不存在的路径，意思就是「在这里开个新项目」。让他先去
      // 手动 mkdir 再 git init 只是仪式——而且他多半会漏掉 git init，然后
      // 被拒绝打回来。
      try {
        await mkdir(root, { recursive: true });
        await execFileAsync('git', ['init', '-q'], {
          cwd: root,
          windowsHide: true,
        });
        // 空的 git 仓库没有 HEAD，worktree add 会直接失败
        await ensureHeadCommit(root);
      } catch (error) {
        return {
          ok: false,
          code: 'workspace_not_found',
          message: `目标目录不存在，自动创建也失败了：${root}（${(error as Error).message}）`,
        };
      }
      return { ok: true, root };
    }

    // 已经存在但不是 git 仓库：同样就地初始化。
    //
    // 早先这里是拒绝，理由是「那是用户的资产，不该擅自塞 .git」。但实际使用
    // 下来这道拦阻只制造摩擦——用户填一个目录就是要在那儿干活，被一句
    // 「请先 git init」挡回来，等于让他退出编排器、去开个终端、再回来。
    // git init 是可逆的（删掉 .git 就回到原样），而卡住流程是不可逆的体验损失。
    //
    // 真要拒绝的只有一种：初始化失败（权限不足、目录只读）。那时候必须把
    // 原因说清，而不是笼统地说「不可用」。
    if (workspaceMode === 'git' && !(await isGitWorkTree(root))) {
      try {
        await execFileAsync('git', ['init', '-q'], {
          cwd: root,
          windowsHide: true,
        });
        await ensureHeadCommit(root);
      } catch (error) {
        return {
          ok: false,
          code: 'workspace_not_git',
          message: `目标目录不是 git 仓库，自动初始化也失败了：${root}（${(error as Error).message}）`,
        };
      }
    }

    return { ok: true, root };
  }

  // diff 原文落盘，事件日志里只留统计量与路径。data/* 已在 gitignore 内。
  const artifacts = new ArtifactStore(
    process.env.AGENT_ARTIFACT_DIR ?? resolve(dataRoot, 'data/artifacts'),
  );

  /**
   * 一条推进链路：能够被中止，且能被人等待完成。
   *
   * 之前这里只是一个 `Set<string>` 占位标记。要做「强制停止」就必须有
   * 中止的对象，而「停止后立刻继续」还必须能等到上一条链路真的让位——
   * 所以两样东西一起存。
   */
  interface AdvanceTask {
    controller: AbortController;
    done: Promise<void>;
  }

  // 同一个运行不允许两条推进链路并行，否则会重复派发同一批节点
  const advancing = new Map<string, AdvanceTask>();

  /**
   * 节点级「进行中」标记，键 `runId/nodeId`。
   *
   * 全进程只有这一份，整轮推进与单节点运行共用：一个节点同时只该有一个
   * Agent 进程，而两条路径看到的节点事实可能都还停在「没开始」。
   */
  const nodeInFlight = new Set<string>();

  /**
   * 编排依赖的唯一构造点。
   *
   * 整轮推进与单节点运行必须用同一组端口：同一个执行器、同一套会话派生、
   * 同一个工作区分派函数与产物存储。两边各写一份的话，单跑产出的 diff 会
   * 落到另一个地方，而「这条 diff 是哪一次执行写的」将成为无法回答的问题。
   *
   * 注意这里给的是 `workspaceFor`（按运行取）而不是某个实例：一条推进链路里
   * 可能混着不同运行的节点，任何「整轮共用一个工作区」的写法都会把 A 的产物
   * 写进 B 的仓库。
   */
  function buildAdvanceDeps(signal?: AbortSignal): AdvanceDeps {
    return {
      getRun: (id) => store.snapshot.runs[id],
      emit: (event) => store.emit(event),
      runner,
      // 按运行取：同一个运行里所有节点共用一个目标仓库，不同运行之间不共用
      workspaceFor,
      resolveAgent: (agentId) => findAgent(agentId, catalog),
      now,
      concurrency: Number(process.env.AGENT_CONCURRENCY ?? 2),
      // 停止靠这个信号生效：编排器只在批与批之间检查它，不打断已在跑的节点。
      // 单节点运行不传——它是用户的一次显式请求，没有「批次」可中止，
      // 要停就走节点级的 /stop。
      signal,
      // 续跑派生：同一对 (runId, nodeId) 永远算出同一个会话 id，
      // 于是重启、重放、重跑都能接上同一轮 Agent 上下文
      deriveSessionId,
      // 续跑降级（首次执行 / 回放无 hook）不写事件，但在日志里必须留痕
      log: (message, detail) => log.debug(message, detail),
      // 产物落盘与读取都走同一个 store，审查节点才能读到实现节点刚写的 diff
      saveArtifact: (runId, nodeId, artifact) =>
        artifacts.save(runId, nodeId, artifact),
      loadArtifact: (runId, nodeId) => artifacts.load(runId, nodeId),
      nodeInFlight,
    };
  }

  /** 推进主循环本体。与 startAdvance 分开，是为了让登记与清理只写一次。 */
  async function advanceLoop(runId: string, signal: AbortSignal): Promise<void> {
    try {
      await advanceRun(runId, buildAdvanceDeps(signal));
    } catch (error) {
      // 推进失败不能吞掉：写成一条事实，让看板能看见
      await store
        .emit({
          type: 'run.paused',
          at: now(),
          runId,
        })
        .catch(() => {});
      // 事实只能表达「这一轮停了」，原因与堆栈属于运维信息，进日志
      app.log.error({ err: error, runId }, '推进失败，已把运行置为暂停');
    }
  }

  /**
   * 启动（或复用）这个 run 的推进链路。
   *
   * 复用而不是排队：已有链路在跑时再起一条，会让同一批节点被派发两次。
   * 复用返回的是既有的那条，调用方仍可 await 它完成。
   */
  function startAdvance(runId: string): AdvanceTask {
    const existing = advancing.get(runId);
    if (existing) {
      return existing;
    }

    const controller = new AbortController();
    let task: AdvanceTask;
    const done = advanceLoop(runId, controller.signal).finally(() => {
      // 只清理自己那一条：停止之后紧接着 resume，表里可能已经换了新链路，
      // 拿旧链路去 delete 会把新的那条从表里抹掉，造成同一 run 并发推进
      if (advancing.get(runId) === task) {
        advancing.delete(runId);
      }
    });
    task = { controller, done };
    advancing.set(runId, task);
    return task;
  }

  /** 推进到本轮结束。`/advance` 需要这个同步语义，其余调用点 fire-and-forget。 */
  async function advance(runId: string): Promise<void> {
    // 已有链路在推进：直接返回，不排队等它——与改造前一致。
    // 复用它等于把「这一轮」交给已经在跑的那一轮，重复派发才是真问题。
    if (advancing.has(runId)) {
      return;
    }
    await startAdvance(runId).done;
  }

  /* ---------------------------------------------------------------- *
   * 异步拆解：创建即返回，图随后由事件推出来
   * ---------------------------------------------------------------- */

  /**
   * 正在拆解的运行。
   *
   * 同一个 run 只允许一条拆解链：两条并行会各自调一次 Agent、各自发一次
   * 冻结事件，后到的那张图会盖掉先到的——同一个运行凭空换了一次图。
   * 与 `advancing` 同一套互斥思路，区别是这里不需要可等待的句柄：
   * 拆解是「发起即忘」，调用方拿不到、也不需要它的结果。
   */
  const planning = new Map<string, AdvanceTask>();

  /**
   * 后台拆解任务图：先发 `plan.started`，等 Agent 给出图，再把图冻结进事实。
   *
   * 为什么是 fire-and-forget：`generateDag` 走的是真 CLI Agent，实测 20–40 秒。
   * 让 HTTP 请求挂在这里等，用户点完「开始拆解」看到的是一动不动，像没点上。
   * 请求只负责把「这次意图」变成事实，图由事件推进——这就是参考实现里
   * 「先返回 session 句柄，状态靠事件往前推」的语义：交接点是「这个运行已经
   * 存在」，而不是「这个运行已经准备好了」。
   *
   * 每个出口都必须落事件，否则运行会永远卡在没有图的中间态：
   * 成功落冻结事件（节点图随事件进入事实）并踢一轮推进，失败落 `plan.failed`。
   */
  async function runPlanning(runId: string, request: PlanRequest, signal: AbortSignal): Promise<void> {
    const requestedAgentId =
      request.requestedAgentId || process.env.PLANNER_AGENT_ID || undefined;

    /**
     * 这次拆解用的是谁。
     *
     * `generateDag` 内部按同一份目录、同一个 `pickPlannerAgent` 挑选，所以这里
     * 算出来的就是它将要用的那个。没有可用 Agent 时回落到调用方点名的 id，
     * 再回落到 `orchestrator`——「谁都没得用」同样是一条要被人看见的事实，
     * 留一个空字段就什么都说明不了。
     */
    const agentId =
      pickPlannerAgent(catalog, requestedAgentId)?.id ??
      requestedAgentId ??
      'orchestrator';

    await store.emit({ type: 'plan.started', at: now(), runId, agentId });
    const relay = createAgentEventRelay({ emit: (event) => store.emit(event), now }, { runId, agentId });

    try {
      const generated = await generateDag(
        request.goal,
        catalog,
        {
          runner,
          /**
           * 拆解也在同一个目标目录里进行。
           *
           * 看起来「只是生成一张图」不需要仓库，但 Planner 要读现有代码才能
           * 拆得准，它写下的中间产物也该落在这个运行自己的 worktree 里——
           * 用服务启动目录，等于让拆解去看另一个工程。
           */
          workspace: workspaceAt(request.workspaceRoot),
          onEvents: relay.forward,
        },
        { agentId: requestedAgentId, runId, signal },
      ).finally(relay.flush);

      // 角色覆盖要在校验之前：校验看的是最终 agentId，不是 Planner 猜的那个
      signal.throwIfAborted();
      const dag = applyRoleAgents(generated.dag, request.roles);

      // 冻结前的最后一道闸。覆盖可能把 agentId 换成目录里不存在的值，
      // 那样的图必须在这里被拦下——冻结之后再发现，只能靠画布上一个个
      // 节点报错，而不是一句「这张图不能用」。
      const validation = validateDag(dag, catalog);
      if (!validation.ok) {
        throw new DagGenerationError(
          '角色覆盖之后这张图不再合法',
          generated.attempts,
          validation.issues,
        );
      }

      await store.emit({
        type: 'run.frozen',
        at: now(),
        runId,
        nodes: toNodeFacts(dag),
      });

      app.log.debug(
        {
          runId,
          agentId: generated.agentId,
          nodes: dag.nodes.length,
          // 回放器几轮才给出合格图是排障线索，不是成功指标
          attempts: generated.attempts,
        },
        '任务图已冻结',
      );

      // 冻结即可开跑，不必等客户端再踢一脚
      void advance(runId);
    } catch (error) {
      if (signal.aborted) {
        return;
      }
      // 图不合格与 Agent 跑不起来要分开说：前者是内容问题（带 issues，
      // 用户改目标或换 Agent 就能救），后者是编排器自身的问题。
      const failure =
        error instanceof DagGenerationError
          ? {
              message: error.message,
              issues: error.issues.map((issue) => ({
                kind: issue.kind,
                message: issue.message,
              })),
            }
          : {
              message: error instanceof Error ? error.message : String(error),
            };

      app.log.warn(
        { err: error, runId, agentId },
        '拆解任务图失败，运行停在编排阶段',
      );

      // 结论进事实，堆栈进日志。写事实本身也可能失败（磁盘满），此时已经
      // 没有第二处可写，只能吞掉——异常再往上冒就是未处理的 rejection。
      await store
        .emit({ type: 'plan.failed', at: now(), runId, ...failure })
        .catch((emitError: unknown) => {
          app.log.error({ err: emitError, runId }, 'plan.failed 落盘失败');
        });
    }
  }

  /** 发起一次拆解。已经在拆的直接复用：不排队，也不重复调 Agent。 */
  function startPlanning(runId: string, request: PlanRequest): void {
    if (planning.has(runId)) {
      return;
    }
    const controller = new AbortController();
    const done = runPlanning(runId, request, controller.signal)
      .catch((error: unknown) => {
        app.log.error({ err: error, runId }, '拆解链路异常退出');
      })
      .finally(() => { planning.delete(runId); });
    planning.set(runId, { controller, done });
  }

  /**
   * `stop` 等已中止链路结算的上限。
   *
   * 有一个必须等的理由：abort 只拦「还要不要派发下一批」，已经在跑的
   * `executeNode` 还会走到结算，并在那里落 `node.interrupted`。这些事件决定了
   * 「点继续」时节点能不能被重新调度，所以 stop 的响应不该抢在它们前面——
   * 否则调用方紧接着 GET 会看到「已停止的运行里有个节点还在跑」。
   *
   * 上限存在的理由同样明确：一个不肯退出的 Agent 不能把「停止」本身卡住。
   * 到点就返回，剩余事件随后照常落盘，状态最终一致。
   */
  const STOP_SETTLE_TIMEOUT_MS = 2_000;

  /* ---------------------------------------------------------------- *
   * Agent 目录
   * ---------------------------------------------------------------- */

  app.get('/api/agents', async () => catalog);

  /** 当前执行配置。前端拿它告诉用户「这轮是真的调 Agent 还是回放」 */
  app.get('/api/runtime', async () => ({
    runner: runnerMode,
    workspace: workspaceMode,
    concurrency: Number(process.env.AGENT_CONCURRENCY ?? 2),
    plannerAgentId: process.env.PLANNER_AGENT_ID ?? null,
    /**
     * 新建运行表单里「目标目录」的默认值。
     *
     * 由后端给而不是前端猜：默认值取决于服务进程的启动目录与 AGENT_TARGET_DIR，
     * 那两样前端一概不知道。用户看到的就是「什么都不填会发生什么」。
     */
    defaultWorkspaceRoot,
    /**
     * 前端据此决定要不要显示「浏览…」按钮。
     *
     * 原生目录选择框只有 Windows 有，其它平台前端不该给一个必然失败的入口。
     */
    canPickDirectory: process.platform === 'win32',
  }));

  app.post('/api/agents/probe', async () => {
    // 始终基于基线重新探测：拿上一次探测结果当输入会把 ready 磨成 installed
    catalog = await loadCatalog();
    return catalog;
  });

  /* ---------------------------------------------------------------- *
   * 运行读取
   * ---------------------------------------------------------------- */

  app.get('/api/runs', async () => {
    return Object.values(store.snapshot.runs)
      .map(deriveRunView)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  });

  app.get<{ Params: { id: string } }>('/api/runs/:id', async (request, reply) => {
    const run = store.snapshot.runs[request.params.id];
    if (!run) {
      return reply.code(404).send({ error: 'run_not_found' });
    }
    return deriveRunDetail(run, runEvents(run.id), resolveAgent);
  });

  app.get<{ Params: { id: string } }>(
    '/api/runs/:id/board',
    async (request, reply) => {
      const run = store.snapshot.runs[request.params.id];
      if (!run) {
        return reply.code(404).send({ error: 'run_not_found' });
      }
      const detail = deriveRunDetail(run, runEvents(run.id), resolveAgent);
      return {
        runId: run.id,
        lanes: deriveBoard(detail.nodes, deriveEdges(run)),
      };
    },
  );

  app.get<{ Params: { id: string } }>(
    '/api/runs/:id/events',
    async (request, reply) => {
      const run = store.snapshot.runs[request.params.id];
      if (!run) {
        return reply.code(404).send({ error: 'run_not_found' });
      }
      return deriveEvents(run, runEvents(run.id), resolveAgent);
    },
  );

  /**
   * 节点产物 diff。
   *
   * diff 原文不进事件日志（见 ArtifactStore 的注释），所以要看「这个节点
   * 到底改了什么」只能回到磁盘上那份文件。接口原样返回全文：截断与折叠
   * 属于展示层的事，后端一截断，调用方就再也拿不到完整内容了。
   */
  app.get<{ Params: { id: string; nodeId: string } }>(
    '/api/runs/:id/nodes/:nodeId/artifact',
    async (request, reply) => {
      const run = store.snapshot.runs[request.params.id];
      const node = run?.nodes[request.params.nodeId];
      if (!run || !node) {
        // 运行或节点不存在，与「节点存在但没有产物」用同一个 404：
        // 对调用方来说结论一致——没有东西可给，且绝不能返回空 diff
        // 假装成功（空 diff 会被当成「这个节点什么都没改」）。
        return reply.code(404).send({ error: 'artifact_not_found' });
      }

      const diff = await artifacts.load(run.id, node.id);
      if (diff === undefined) {
        return reply.code(404).send({ error: 'artifact_not_found' });
      }

      return {
        diff,
        // 统计量按返回的这份 diff 现算，不读节点事实里的 artifactBytes /
        // artifactFiles：那两个字段是采集时刻的旧值，一旦重跑或落盘失败，
        // 就会出现「摘要说有 3 个文件、正文只有 1 个」的自相矛盾。
        files: filesInDiff(diff),
        bytes: Buffer.byteLength(diff, 'utf8'),
        runId: run.id,
        nodeId: node.id,
      };
    },
  );

  /**
   * 只属于某个节点的事件。
   *
   * 复用 deriveEvents 后按 nodeId 过滤，而不是另写一套翻译：文案只有一处，
   * 前端详情面板与事件流看到的同一件事必然说同一句话。
   */
  app.get<{ Params: { id: string; nodeId: string } }>(
    '/api/runs/:id/nodes/:nodeId/events',
    async (request, reply) => {
      const run = store.snapshot.runs[request.params.id];
      if (!run || !run.nodes[request.params.nodeId]) {
        return reply.code(404).send({ error: 'node_not_found' });
      }
      return deriveEvents(run, runEvents(run.id), resolveAgent).filter(
        (event) => event.nodeId === request.params.nodeId,
      );
    },
  );

  /* ---------------------------------------------------------------- *
   * 运行写入
   * ---------------------------------------------------------------- */

  app.post('/api/runs', async (request, reply) => {
    const body = createRunBodySchema.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({ error: 'invalid_body', issues: body.error.issues });
    }

    /**
     * 先定「在哪儿干活」，再谈其它。
     *
     * 这一步必须早于任何事实写入：目录不可用时这个运行根本不存在，
     * 而不是「建了一条运行、跑起来才发现没地方落地」。
     */
    const checked = await checkWorkspaceRoot(body.data.workspaceRoot);
    if (!checked.ok) {
      return reply.code(400).send({ error: checked.code, message: checked.message });
    }
    const workspaceRoot = checked.root;

    // 身份在这个接口里不影响「能不能建」——谁都能建运行。但拆解是异步的，
    // 失败时请求早就返回了，日志里必须留下「谁发起的」，才知道该找谁。
    const actor = resolveActor(request.headers);

    const at = now();
    const runId = `run-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;

    /**
     * 调用方自带图：没有拆解这一步，直接冻结。
     *
     * 这条路径保持同步——它不调 Agent，毫秒级就结束，没有需要绕开的等待。
     * 反过来把它也改成异步，只会让「客户端已经算好的图」白白多绕一圈事件。
     */
    if (body.data.dag !== undefined) {
      const parsed = safeParseDag(body.data.dag);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'invalid_dag', issues: parsed.error.issues });
      }

      // 角色覆盖要在校验之前：校验看的是最终 agentId，不是 Planner 猜的那个
      const dag = applyRoleAgents(parsed.data, {
        implementAgentId: body.data.implementAgentId,
        reviewAgentId: body.data.reviewAgentId,
      });

      // 冻结前的最后一道闸：不合法就不许进执行阶段
      const validation = validateDag(dag, catalog);
      if (!validation.ok) {
        return reply.code(422).send({ error: 'dag_rejected', issues: validation.issues });
      }

      const frozenNodes = toNodeFacts(dag);
      const run: RunFacts = {
        id: runId,
        // 标题优先用调用方给的那句话：它直接来自用户输入，比模型/回放器
        // 编出来的通用名字更有信息量。DAG 标题只在调用方没给时兜底。
        title: body.data.title.trim() || dag.title,
        // 摘要把用户目标压缩成一行，列表页靠它回答「这轮在做什么」。
        // 用户目标优先于模型给的 summary——后者是二手转述，还可能带着
        // 回放器的通用措辞。
        summary:
          summarizeGoal(body.data.goal, body.data.title) ||
          dag.summary.trim() ||
          '未命名运行',
        goal: body.data.goal,
        // 这次运行的目标仓库。归一化之后的绝对路径，读取侧直接拿它建工作区
        workspaceRoot,
        specVersion: dag.specVersion,
        stage: 'decompose',
        createdAt: at,
        nodeOrder: frozenNodes.map((node) => node.id),
        nodes: Object.fromEntries(frozenNodes.map((node) => [node.id, node])),
      };

      await store.emit({ type: 'run.created', at, runId, run });
      await store.emit({ type: 'run.frozen', at: now(), runId });

      // 冻结即可开跑，不必等客户端再踢一脚
      void advance(runId);

      return reply.code(201).send({
        ...deriveRunDetail(store.snapshot.runs[runId]!, runEvents(runId), resolveAgent),
        plan: null,
      });
    }

    /**
     * 走 Planner 现拆：不等拆解结果，立刻把运行交出去。
     *
     * 顺序是刻意的——先把「这次创建」落成事实，再发起拆解。反过来（先拆再建）
     * 就是改之前那套：请求挂几十秒，用户看到的只有转圈。图由 `run.frozen`
     * 带进事实，前端在详情页通过 SSE 收到它之后自己长出来。
     */
    const run: RunFacts = {
      id: runId,
      title: body.data.title.trim() || summarizeGoal(body.data.goal, '未命名运行'),
      summary: summarizeGoal(body.data.goal, body.data.title) || '未命名运行',
      goal: body.data.goal,
      // 拆解阶段也要记住目录：起 planner 的 worktree 用它，运维复盘时也要看
      workspaceRoot,
      /**
       * 规格版本先按默认值占位。
       *
       * Planner 给的 `specVersion` 要等图回来才知道，而它只是一颗展示用的
       * 标签（界面头部的「规格 v1.0」），不是结构事实。为它加一条回写事件，
       * 换来的是一处几乎没人会读到的精度。
       */
      specVersion: 'v1.0',
      plannerAgentId: body.data.plannerAgentId,
      implementAgentId: body.data.implementAgentId,
      reviewAgentId: body.data.reviewAgentId,
      // 图还没生出来：这一阶段的运行只由 plan.* 与 run.frozen 推进
      stage: 'orchestrate',
      createdAt: at,
      // 空图：界面据此显示「编排器正在拆解任务图…」，而不是空看板
      nodeOrder: [],
      nodes: {},
    };

    await store.emit({ type: 'run.created', at, runId, run });

    app.log.debug({ runId, actor }, '运行已创建，转为后台拆解');

    startPlanning(runId, {
      goal: body.data.goal,
      requestedAgentId: body.data.plannerAgentId,
      workspaceRoot,
      roles: {
        implementAgentId: body.data.implementAgentId,
        reviewAgentId: body.data.reviewAgentId,
      },
    });

    // 立即返回。响应体要够前端跳转：id / title / status / stage 都在 RunView 里，
    // 前端拿到 id 就直接导航，剩下的进展由事件推过去。
    return reply.code(201).send({
      ...deriveRunDetail(store.snapshot.runs[runId]!, runEvents(runId), resolveAgent),
      plan: null,
    });
  });

  app.post<{ Params: { id: string } }>(
    '/api/runs/:id/pause',
    async (request, reply) => {
      if (!store.snapshot.runs[request.params.id]) {
        return reply.code(404).send({ error: 'run_not_found' });
      }
      await store.emit({ type: 'run.paused', at: now(), runId: request.params.id });
      return { ok: true };
    },
  );

  /**
   * 强制停止：中止调度、终止 Agent 进程、落一条 run.paused。
   *
   * 四步的顺序不是随便排的：
   *   1. 先 abort，保证不再派发新一批节点——否则刚停下的运行会被自己推出
   *      一个新节点，用户看到的是「点了停止它还在动」；
   *   2. 再 cancel，把已经在跑的进程请走（SIGTERM → 宽限 → SIGKILL）；
   *   3. 等已中止的链路结算完（`STOP_SETTLE_TIMEOUT_MS`）——在跑的
   *      `executeNode` 会在这一步落 `node.interrupted`，正是「继续」时能让
   *      该节点重新被调度的前提；
   *   4. 最后写事件：状态是派生物，它必须反映前几步的真实结果，不能预先宣称。
   *
   * 复用 run.paused 而不是新增事件类型：停止与暂停在事实层是同一件事——
   * 这个运行现在不由编排器推进了；区别只在有没有把正在跑的进程杀掉，
   * 而「有没有杀掉」属于这次请求的返回值，不是持久事实。
   */
  app.post<{ Params: { id: string } }>(
    '/api/runs/:id/stop',
    async (request, reply) => {
      const runId = request.params.id;
      if (!store.snapshot.runs[runId]) {
        return reply.code(404).send({ error: 'run_not_found' });
      }

      // 没有在推进的链路也照样往下走：进程可能只是上一轮遗留的，
      // 「停止」对用户来说是幂等的，不是「必须先有活跃链路」。
      const task = advancing.get(runId) ?? planning.get(runId);
      task?.controller.abort();

      // 先落暂停事实，再去做清理。
      //
      // 这个顺序是被真实体验逼出来的：先 cancel 再等结算，一旦进程杀不掉、
      // 或者节点还在长时间执行，`run.paused` 就迟迟写不下去，用户点完停止
      // 看到界面一动不动，会以为整个停止是假的。状态是给人看的第一反馈，
      // 它必须立刻反映「编排器已经不再推进这个运行」这件事——而这在 abort
      // 返回的那一刻就已经成立了，与进程能不能杀掉无关。
      await store.emit({ type: 'run.paused', at: now(), runId });

      // cancel 是可选能力：实现方没有它时数量就是 0，绝不假装停掉了什么
      let cancelledAgents = 0;
      if (runner.cancel) {
        try {
          cancelledAgents = await runner.cancel({ runId });
        } catch (error) {
          // 终止出错不能让「停止」整体失败：调度已经中止，暂停事实也已落下。
          // 但数量保持 0——没被确认终止的进程一律不算数。
          app.log.warn({ err: error, runId }, '终止 Agent 进程时出错');
        }
      }

      if (cancelledAgents === 0 && options.registry) {
        // 兜底：runner 的进程表里没找到句柄（键对不上、或者进程已经被接管），
        // 就按登记表把这个 run 名下还活着的子进程一并终止。
        // 用户按下停止意味着「不要再烧了」，此时宁可多做一步清理。
        try {
          const reaped = await options.registry.reap({
            shouldReap: (record) => record.runId === runId,
          });
          cancelledAgents = reaped.terminated.length;
        } catch (error) {
          app.log.warn({ err: error, runId }, '按登记表终止 Agent 进程时出错');
        }
      }

      if (cancelledAgents === 0) {
        // 明确记一笔：用户以为停了，实际可能还有进程在烧。这条日志是排查入口。
        app.log.warn(
          { runId, hasTask: Boolean(task) },
          '停止请求没有确认终止任何 Agent 进程',
        );
      }

      // 给已中止的链路一点时间把在跑的节点结算成 interrupted（它自己发事实，
      // 这里不补），好让紧接着的 GET 看到一致的结果。等不到也无妨，状态已经是 paused。
      if (task) {
        await Promise.race([
          task.done.catch(() => {}),
          new Promise<void>((resolve) => {
            // unref：这个兜底计时器不该独自把进程钉住（测试退出时尤其明显）
            setTimeout(resolve, STOP_SETTLE_TIMEOUT_MS).unref();
          }),
        ]);
      }

      const next = store.snapshot.runs[runId];
      return {
        ok: true,
        cancelledAgents,
        status: next ? deriveRunStatus(next) : 'paused',
      };
    },
  );

  app.post<{ Params: { id: string } }>(
    '/api/runs/:id/resume',
    async (request, reply) => {
      const runId = request.params.id;
      if (!store.snapshot.runs[runId]) {
        return reply.code(404).send({ error: 'run_not_found' });
      }

      // 停止之后紧接着继续：上一条链路可能还在收尾，它的 signal 已经 abort。
      // 必须先等它让位，否则 startAdvance 会把那条已中止的链路复用回来，
      // 表现为「点了继续，什么都没发生」。正常在跑的链路不动它。
      //
      // 这里能续上的前提是 stop 那次已经让被打断的节点落下 `node.interrupted`
      // （投影层因此清空了它的 startedAt / finishedAt，节点回到 ready），
      // 所以下面的 advance 会把它当作一个没跑过的节点重新派发。
      const current = advancing.get(runId) ?? planning.get(runId);
      if (current?.controller.signal.aborted) {
        await current.done.catch(() => {});
      }

      await store.emit({ type: 'run.resumed', at: now(), runId });
      const run = store.snapshot.runs[runId]!;
      if (!run.frozenAt) {
        startPlanning(runId, {
          goal: run.goal,
          requestedAgentId: run.plannerAgentId,
          workspaceRoot: run.workspaceRoot || defaultWorkspaceRoot,
          roles: { implementAgentId: run.implementAgentId, reviewAgentId: run.reviewAgentId },
        });
      } else {
        void advance(runId);
      }
      return { ok: true };
    },
  );

  app.post<{ Params: { id: string } }>(
    '/api/runs/:id/advance',
    async (request, reply) => {
      const run = store.snapshot.runs[request.params.id];
      if (!run) {
        return reply.code(404).send({ error: 'run_not_found' });
      }
      await advance(request.params.id);
      return deriveRunDetail(
        store.snapshot.runs[request.params.id]!,
        runEvents(request.params.id),
        resolveAgent,
      );
    },
  );

  /* ---------------------------------------------------------------- *
   * 节点级控制：单跑 / 停止 / 重置
   *
   * 粒度细到单个节点，是因为「整轮跑完再看」和「先跑这一个看看」是两种
   * 完全不同的工作节奏。为了重跑一个节点去新建一次运行，代价是把前面
   * 所有的执行事实一起丢掉。
   *
   * 三个动作都不是「运行级」的：单跑不触发整轮推进，停止不写 run.paused，
   * 重置不动图结构。要动整轮，仍然走 /advance 与 /stop。
   * ---------------------------------------------------------------- */

  /**
   * 这个节点现在有人在跑它吗。
   *
   * 两条判据都要看：`nodeInFlight` 覆盖「请求已登记、`node.started` 还没落盘」
   * 那一小段空窗；节点事实覆盖整轮推进派发出去的执行（它不经过这张表）。
   * 只看其中一个，都会在某些时刻得出「它没在跑」。
   */
  const nodeIsRunning = (run: RunFacts, nodeId: string): boolean => {
    if (nodeInFlight.has(nodeInFlightKey(run.id, nodeId))) {
      return true;
    }
    const node = run.nodes[nodeId];
    return node?.startedAt !== undefined && node.finishedAt === undefined;
  };

  app.post<{ Params: { id: string; nodeId: string } }>(
    '/api/runs/:id/nodes/:nodeId/run',
    async (request, reply) => {
      const { id: runId, nodeId } = request.params;
      const run = store.snapshot.runs[runId];
      if (!run) {
        return reply.code(404).send({ error: 'run_not_found' });
      }
      if (!run.nodes[nodeId]) {
        return reply.code(404).send({ error: 'node_not_found' });
      }

      const node = run.nodes[nodeId]!;
      if (node.action === 'merge' && !node.dependsOn.every((id) =>
        run.nodes[id] && deriveNodeStatus(run, run.nodes[id]!) === 'completed')) {
        return reply.code(409).send({ error: 'merge_dependencies_pending', message: '请先完成合并节点依赖的任务和审批' });
      }

      // 同步跑完这一个节点再返回：一次执行就是这个请求的全部意义，
      // 提前 200 只会让调用方以为它已经跑完了。重复派发由 runNode 内部的
      // 标记互斥挡成 409——那是全进程唯一的一张表，与这里会不会并发无关。
      const result = await runNode(runId, nodeId, buildAdvanceDeps());
      if (!result.ok) {
        // 走到这里只剩「互斥命中」一种可能（运行与节点已经在上面 404 过）。
        // 与 404 分开报，前端才能说「等一等」而不是「这个节点不存在」。
        return reply.code(409).send({
          error: 'node_running',
          message: result.reason ?? '该节点正在执行',
        });
      }

      const next = store.snapshot.runs[runId]!;
      // 单跑也能收尾整轮：最后一个节点如果是靠单跑跑完的，运行必须落
      // run.completed，否则它会永远停在「运行中」——派生状态只看事实，
      // 没人替它下这个结论。
      if (!next.completedAt && isRunSettled(next)) {
        await store.emit({ type: 'run.completed', at: now(), runId });
      }

      return {
        ok: true,
        run: deriveRunDetail(store.snapshot.runs[runId]!, runEvents(runId), resolveAgent),
      };
    },
  );

  app.post<{ Params: { id: string; nodeId: string } }>(
    '/api/runs/:id/nodes/:nodeId/stop',
    async (request, reply) => {
      const { id: runId, nodeId } = request.params;
      const run = store.snapshot.runs[runId];
      if (!run) {
        return reply.code(404).send({ error: 'run_not_found' });
      }
      if (!run.nodes[nodeId]) {
        return reply.code(404).send({ error: 'node_not_found' });
      }

      // 刻意不动整轮运行的状态：这是节点级操作，不是「停止整个运行」。
      // 不发 run.paused——那会把用户按过的「继续」意图一起清掉，
      // 表现为「我只想停一个节点，整轮却停了」。
      // 先落事实，再去怼进程。
      //
      // 早先这里只调 cancel、一条事件都不发，指望执行层结算时自己发
      // node.interrupted。问题是：进程可能几秒才退、可能根本退不掉，
      // 界面靠 SSE 收事件才会刷新，于是用户点完「停止此节点」看到卡片
      // 还是「运行中」——功能上像坏的。用户按下停止，编排器在那一刻就
      // 不再认为这个节点在跑，这条事实必须立刻落下去。
      await store.emit({
        type: 'node.interrupted',
        at: now(),
        runId,
        nodeId,
        reason: '用户停止了该节点',
      });

      // 再尽力终止进程。返回值是**确认**终止的数量，不是发出去的请求数。
      let cancelled = false;
      if (runner.cancel) {
        try {
          cancelled = (await runner.cancel({ runId, nodeId })) > 0;
        } catch (error) {
          // 终止出错不能让这个接口整体失败，但也不能假装停掉了什么：
          // cancelled 保持 false，真实结局由执行层的 cancelled 说明。
          app.log.warn({ err: error, runId, nodeId }, '终止节点 Agent 时出错');
        }
      }

      // runner 的进程表只认识本次进程生命周期里拉起的 Agent。服务重启过、
      // 或者句柄因为别的原因丢了，它就会返回 0——而进程可能还在烧。
      // 这时用登记表按 pid 兜底，这是「停止」唯一能在重启后依然有效的手段。
      if (!cancelled && options.registry) {
        try {
          const reaped = await options.registry.reap({
            shouldReap: (record) =>
              record.runId === runId && record.nodeId === nodeId,
          });
          cancelled = reaped.terminated.length > 0;
        } catch (error) {
          app.log.warn(
            { err: error, runId, nodeId },
            '按登记表终止节点 Agent 时出错',
          );
        }
      }

      if (!cancelled) {
        app.log.warn(
          { runId, nodeId },
          '停止节点时没有确认终止任何 Agent 进程（可能已经没有进程在跑）',
        );
      }

      // 返回取消请求发出后的即时快照：`node.interrupted` 要等进程真的退出、
      // 执行层给出 cancelled 才会落盘，界面靠 SSE 收到它后再刷新一次。
      const next = store.snapshot.runs[runId]!;
      return {
        ok: true,
        cancelled,
        run: deriveRunDetail(next, runEvents(runId), resolveAgent),
      };
    },
  );

  app.post<{ Params: { id: string; nodeId: string } }>(
    '/api/runs/:id/nodes/:nodeId/reset',
    async (request, reply) => {
      const { id: runId, nodeId } = request.params;
      const run = store.snapshot.runs[runId];
      if (!run) {
        return reply.code(404).send({ error: 'run_not_found' });
      }
      if (!run.nodes[nodeId]) {
        return reply.code(404).send({ error: 'node_not_found' });
      }

      // 正在跑的节点不能重置：清空事实之后那一次执行回来还要写
      // node.completed，会把刚重置出来的「可重跑」直接抹掉，
      // 用户看到的将是「点了重置，它却变成了已完成」。
      if (nodeIsRunning(run, nodeId)) {
        return reply.code(409).send({
          error: 'node_running',
          message: '节点正在执行，等它结束后再重置',
        });
      }

      // body 允许为空：重置没有参数。reason 只为了审计行能回答
      // 「这次回退是人点的还是审查驳回的」。
      const body = resetNodeBodySchema.safeParse(request.body ?? {});
      const reason =
        body.success && body.data.reason ? body.data.reason : '用户手动重置';

      // 作废是 reduce 里做的，接口这边拿不到「改了几个」，只能比执行前后的事实差。
      //
      // 「原本谁跑完了」必须在 emit 之前抄成布尔值：投影层是浅拷贝，节点对象
      // 在重置时被就地改写，emit 之后再回读旧快照，看到的已经是新值。
      const wasFinished = new Set(
        run.nodeOrder.filter((id) => Boolean(run.nodes[id]?.finishedAt)),
      );

      // 复用 node.reset 的既有语义（清 startedAt / finishedAt / verdict /
      // failureReason / 产物统计，attempts += 1，并把已经跑完的下游一并作废），
      // 不另起一套「重置」事件：回退的判据只有一处，重放才不会分叉。
      await store.emit({ type: 'node.reset', at: now(), runId, nodeId, reason });

      const next = store.snapshot.runs[runId]!;
      const invalidated = next.nodeOrder.filter(
        (id) => id !== nodeId && wasFinished.has(id) && !next.nodes[id]?.finishedAt,
      ).length;

      return {
        ok: true,
        // 目标节点本身也算一次重置：即使它从没跑过，attempts 也加了 1
        resetNodes: invalidated + 1,
        invalidatedNodes: invalidated,
        run: deriveRunDetail(next, runEvents(runId), resolveAgent),
      };
    },
  );

  /* ---------------------------------------------------------------- *
   * 编排器对话：把一句自然语言指令落成对图的修改
   * ---------------------------------------------------------------- */

  /**
   * 与编排器对话。
   *
   * 三步走，顺序不能换：
   *   1. 由事实重建当前 DAG，交给 Planner 侧的 amendDag 产出一张候选新图；
   *   2. 用白名单比对新旧图，算出真正能落地的改动与被拒的改动；
   *   3. 有改动才 emit `dag.amended` 并继续推进——没有改动的对话不该在
   *      事实里留下一条「改过图」的痕迹。
   *
   * 会话本身不落库：用户的这句话只作为 `dag.amended.reason` 存在，
   * 因为对话不是编排事实，改动的结果才是。这样重放事件日志得到的是同一张图，
   * 而不是一段无法校验的聊天记录。
   */
  app.post<{ Params: { id: string } }>(
    '/api/runs/:id/messages',
    async (request, reply) => {
      const runId = request.params.id;
      const run = store.snapshot.runs[runId];
      if (!run) {
        return reply.code(404).send({ error: 'run_not_found' });
      }

      const body = runMessageBodySchema.safeParse(request.body);
      if (!body.success) {
        return reply.code(400).send({ error: 'invalid_body', issues: body.error.issues });
      }

      const actor = resolveActor(request.headers, body.data.actor);
      const currentDag = dagFromFacts(run);
      // 已经产生执行事实的节点：它们不许再被改，必须让 Planner 事先知道
      const lockedNodeIds = Object.values(run.nodes)
        .filter((node) => Boolean(node.startedAt || node.finishedAt))
        .map((node) => node.id);

      let amended: AmendedPlan;
      try {
        amended = await amendDag(
          run.goal || run.title,
          currentDag,
          body.data.text,
          catalog,
          {
            runner,
            // 改图同样在运行自己的目标目录里做：它要读的是这个工程的代码
            workspace: workspaceFor(run),
            onOutput: (chunk) => {
              // 与规划同理：截断后入日志，全文会淹掉启动日志
              app.log.debug(
                { chunk: chunk.trim().slice(0, 200) },
                'amend 输出',
              );
            },
          },
          {
            agentId: run.plannerAgentId || process.env.PLANNER_AGENT_ID || undefined,
            runId,
            lockedNodeIds,
          },
        );
      } catch (error) {
        if (error instanceof DagGenerationError) {
          // 指令落不成图属于「内容问题」：把 issues 交给调用方去展示
          return reply.code(422).send({
            error: 'instruction_rejected',
            message: error.message,
            issues: error.issues,
          });
        }
        const message = error instanceof Error ? error.message : String(error);
        return reply.code(502).send({ error: 'planner_failed', message, issues: [] });
      }

      const plan = diffDag(currentDag, amended.dag, run);

      if (plan.applied.length > 0) {
        await store.emit({
          type: 'dag.amended',
          at: now(),
          runId,
          actor,
          // 原文照存：排障要能回答「哪一句话导致了这次改图」
          reason: body.data.text,
          changes: plan.applied,
        });
        // 图变了就继续跑：新加/改过的节点应当在下一批被派发出去。
        // 但 `advance` 内部会复用已有链路，所以这里 fire-and-forget 是安全的。
        void advance(runId);
      }

      return {
        reply: buildAmendmentReply(plan),
        applied: plan.applied,
        rejected: plan.rejected,
        run: deriveRunDetail(
          store.snapshot.runs[runId]!,
          runEvents(runId),
          resolveAgent,
        ),
      };
    },
  );

  /* ---------------------------------------------------------------- *
   * 审批：不可变追加，不阻塞进程
   * ---------------------------------------------------------------- */

  app.get('/api/approvals', async () => {
    const pending = store.snapshot.approvals.filter(
      (record) => record.status === 'pending',
    );
    return pending.map((record) => ({
      ...record,
      runTitle: store.snapshot.runs[record.runId]?.title ?? record.runId,
      nodeTitle:
        store.snapshot.runs[record.runId]?.nodes[record.nodeId]?.title ??
        record.nodeId,
    }));
  });

  const deciding = new Set<string>();

  app.post<{ Params: { id: string; nodeId: string } }>(
    '/api/runs/:id/nodes/:nodeId/approval',
    async (request, reply) => {
      const { id: runId, nodeId } = request.params;
      const run = store.snapshot.runs[runId];
      if (!run) {
        return reply.code(404).send({ error: 'run_not_found' });
      }
      const node = run.nodes[nodeId];
      if (!node || (node.type !== 'approval' && !node.escalated)) {
        return reply.code(404).send({ error: 'approval_node_not_found' });
      }
      const body = approvalBodySchema.safeParse(request.body);
      if (!body.success) {
        return reply.code(400).send({ error: 'invalid_body', issues: body.error.issues });
      }

      const record = store.snapshot.approvals.find(
        (item) => item.runId === runId && item.nodeId === nodeId && item.status === 'pending',
      );
      if (!record || deciding.has(record.id) || deriveNodeStatus(run, node) !== 'waiting_approval') {
        return reply.code(409).send({ error: 'no_pending_approval', message: '当前节点没有可提交的审批' });
      }
      const { decision, reason } = body.data;
      const actor = resolveActor(request.headers, body.data.actor);
      const handoffTo = body.data.handoffTo?.trim();
      if (decision === 'handoff' && !handoffTo) {
        return reply.code(400).send({ error: 'handoff_target_required', message: '请填写接收审批的人' });
      }
      if (record.handedOffTo && record.handedOffTo !== actor) {
        return reply.code(403).send({ error: 'approval_assigned', message: `该审批已转交给 ${record.handedOffTo}` });
      }

      deciding.add(record.id);
      const at = now();
      try {
        await store.emit({
          type: 'approval.decided',
          at,
          runId,
          nodeId,
          approvalId: record.id,
          decision,
          actor,
          reason,
          resetNodeId: decision === 'reject' ? reworkTarget(run, node)?.id : undefined,
          nextRecord: decision === 'handoff' ? {
            id: `ap-${randomUUID()}`,
            runId,
            nodeId,
            status: 'pending',
            requestedAt: at,
            handedOffTo: handoffTo,
          } : undefined,
        });
      } finally {
        deciding.delete(record.id);
      }

      void advance(runId);
      return deriveRunDetail(store.snapshot.runs[runId]!, runEvents(runId), resolveAgent);
    },
  );

  /* ---------------------------------------------------------------- *
   * SSE：编排层只发布，看板只订阅
   * ---------------------------------------------------------------- */

  const eventStreams = new Set<ServerResponse>();
  app.addHook('preClose', async () => {
    for (const response of eventStreams) {
      response.end();
    }
  });

  app.get('/events', async (_request, reply) => {
    reply.hijack();
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    eventStreams.add(reply.raw);
    reply.raw.write(': connected\n\n');

    const unsubscribe = store.bus.subscribe((event: OrchestratorEvent) => {
      const run = store.snapshot.runs[event.runId];
      const view = run ? deriveEvents(run, [event], resolveAgent)[0] : undefined;
      reply.raw.write(
        `data: ${JSON.stringify({ runId: event.runId, event: view, raw: event })}\n\n`,
      );
    });

    const heartbeat = setInterval(() => {
      reply.raw.write(': ping\n\n');
    }, 15_000);

    reply.raw.once('close', () => {
      eventStreams.delete(reply.raw);
      clearInterval(heartbeat);
      unsubscribe();
    });
  });

  /* ---------------------------------------------------------------- *
   * 身份
   * ---------------------------------------------------------------- */

  /**
   * 当前操作者。前端只拿它做展示与校验，真正的身份判定仍在每个写接口里
   * 各自解析（只要请求头的来源不变，两边结果必然一致）。
   */
  app.get('/api/identity', async (request) => ({
    actor: resolveActor(request.headers),
  }));

  /**
   * 启动自愈：把「事实说在跑、实际没有进程」的节点收敛掉。
   *
   * 服务重启时，上一轮拉起的 Agent 已经随父进程消失，但事实里还留着
   * `startedAt`、没有 `finishedAt`——投影出来就是永远的「运行中」。这种
   * 僵死状态骗的不只是界面：调度器也不会再碰它（它不在就绪集合里），
   * 用户只能一个个手动点停止。
   *
   * 判据是「登记表里有没有这个 runId/nodeId 的活进程」，而不是「有没有
   * startedAt」——正在跑的节点当然也有 startedAt。
   *
   * 刻意不自动往下推进：重启不代表用户想继续烧钱，恢复执行必须由人发起。
   */
  async function reconcileStaleNodes(): Promise<{
    recovered: number;
    pausedRuns: number;
    /** 停在拆解中途、被收敛成失败的运行数 */
    interruptedPlans: number;
  }> {
    const active = new Set<string>();
    if (options.registry) {
      try {
        for (const record of await options.registry.list()) {
          active.add(`${record.runId}\u0000${record.nodeId}`);
        }
      } catch (error) {
        app.log.warn({ err: error }, '读取进程登记表失败，按「全部已退出」处理');
      }
    }

    let recovered = 0;
    for (const [runId, run] of Object.entries(store.snapshot.runs)) {
      for (const nodeId of run.nodeOrder) {
        const node = run.nodes[nodeId];
        if (!node || node.startedAt === undefined || node.finishedAt !== undefined) {
          continue;
        }
        if (deriveNodeStatus(run, node) === 'waiting_approval' ||
            active.has(`${runId}\u0000${nodeId}`)) {
          continue;
        }
        await store.emit({
          type: 'node.interrupted',
          at: now(),
          runId,
          nodeId,
          reason: '服务重启，执行进程已不存在',
        });
        recovered += 1;
      }
    }

    if (recovered > 0) {
      app.log.warn({ recovered }, '启动自愈：收敛了上次遗留的运行中节点');
    }

    // 运行级也要收敛：重启之后没有任何推进链路，一个仍然宣称自己在 running
    // 的运行是同一类谎言。标成 paused 既是事实（编排器没在推进它），也把
    // 「继续」这个入口交回给人——重启不代表用户想接着烧钱。
    // waiting_for_boss 不受影响：它的优先级高于 paused，审批仍等着人。
    let pausedRuns = 0;
    let interruptedPlans = 0;
    for (const [runId, run] of Object.entries(store.snapshot.runs)) {
      if (run.pausedAt !== undefined || run.completedAt !== undefined ||
          ['waiting_for_boss', 'failed'].includes(deriveRunStatus(run))) {
        continue;
      }
      if (run.frozenAt === undefined) {
        /**
         * 还没有图的运行停在拆解中途。
         *
         * 这里不能标 paused：一个没有 DAG 的运行续不出任何东西，那个「继续」
         * 按钮点下去只会什么都不发生——用户会以为编排器坏了。拆解是重启前
         * 那个进程的活，它已经不在了，所以结论只能是失败，并把「重新拆解」
         * 这件事交回给人。
         *
         * 已经收敛过就不再记一遍：同一次中断被两次重启写两条失败，事件流
         * 会显得这个运行反复出事。
         */
        if (run.planFailure) {
          continue;
        }
        await store.emit({
          type: 'plan.failed',
          at: now(),
          runId,
          message: '服务重启，任务图拆解被中断',
        });
        interruptedPlans += 1;
        continue;
      }
      await store.emit({ type: 'run.paused', at: now(), runId });
      pausedRuns += 1;
    }
    if (pausedRuns > 0) {
      app.log.warn({ pausedRuns }, '启动自愈：把未完成的运行标为暂停');
    }
    if (interruptedPlans > 0) {
      app.log.warn({ interruptedPlans }, '启动自愈：把拆解中断的运行标为失败');
    }

    return { recovered, pausedRuns, interruptedPlans };
  }

  const recovery = await reconcileStaleNodes();

  app.get('/api/health', async () => ({
    ok: true,
    runs: Object.keys(store.snapshot.runs).length,
    approvals: store.snapshot.approvals.filter((record) => record.status === 'pending').length,
    events: store.history.length,
    /** 本次启动自愈收敛了几个僵死节点、几个未完成的运行、几个中断的拆解 */
    recoveredNodes: recovery.recovered,
    pausedRuns: recovery.pausedRuns,
    interruptedPlans: recovery.interruptedPlans,
  }));

  return { app, store, getCatalog: () => catalog, lock: options.lock };
}

export { parseDag };

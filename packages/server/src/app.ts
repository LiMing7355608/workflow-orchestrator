import { randomUUID } from 'node:crypto';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import type { ServerResponse } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { dirname, extname, isAbsolute, join, resolve } from 'node:path';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyBaseLogger, type FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  DEFAULT_AGENT_PROFILES,
  advanceRun,
  createAgentEventRelay,
  deriveBoard,
  deriveEdges,
  deriveEvents,
  deriveNodeConversation,
  deriveNodeStatus,
  deriveRunDetail,
  deriveRunStatus,
  deriveRunView,
  findAgent,
  isRunSettled,
  nodeInFlightKey,
  runNode,
  reworkTarget,
  reduce,
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
import { attachment, deliveryFile, saveIntegratedDelivery, saveTaskDelivery } from './deliveries.js';
import { HttpModelRunner, ModelProviders } from './model-providers.js';
import { registerModelRoutes } from './model-routes.js';
import { registerMeetingRoutes } from './meeting-routes.js';
import { MeetingError, Meetings } from './meetings.js';
import { AgentActivity } from './agent-activity.js';
import { buildAmendInstruction, buildAmendmentReply, dagFromFacts, diffDag } from './amend.js';
import type { LockHandle } from './locks.js';
import type { LogFn, LogSink } from './log.js';
import { resolveDataDir } from './paths.js';
import { verifyPlan, type PlanDraft } from './plan-review.js';
import { PROJECT_DATA, ownedPath, projectRunPath, readOptional, writeAtomic } from './project-files.js';
import { probeCatalog } from './probe.js';
import type { ProcessRegistry } from './registry.js';
import { MockAgentRunner } from './runners.js';
import { RoutingAgentRunner, transportResolver } from './runners/routing.js';
import { RunMemory } from './run-memory.js';
import { buildSeedEvents } from './seed.js';
import { SESSION_NAMESPACE, createSessionIdDeriver } from './session-id.js';
import { InterviewConflict, SpecInterviews } from './spec-interviews.js';
import { RunStore } from './store.js';
import { modelIdSchema, supportsModel } from './text-turn.js';
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
   * 覆盖执行器。测试用：只有拿到真实发出的 prompt 才能断言「人类补充要求
   * 有没有进提示词」这类端到端行为。
   */
  runner?: AgentRunner;
  /**
   * 前端构建产物目录（含 index.html）。
   *
   * 给了就由 server 自己托管静态资源与 SPA 兜底路由——桌面版和「单进程生产
   * 形态」都靠它，因为没有 Vite dev server 可依赖。不给就只提供 API。
   */
  webRoot?: string;
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

const runIdSchema = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/);
const createRunBodySchema = z.object({
  title: z.string().min(1),
  goal: z.string().min(1),
  specId: runIdSchema.optional(),
  sourceMeetingId: runIdSchema.optional(),
  reviewPlan: z.boolean().optional(),
  requireDeliverables: z.boolean().optional(),
  specSettings: z.object({
    granularity: z.enum(['coarse', 'medium', 'fine']),
    reviewRounds: z.number().int().min(1).max(3),
  }).optional(),
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
  /**
   * 这次运行允许同时跑几个节点。
   *
   * 用户在建运行时就该能决定「开几路」——一个大目标拆出上百个节点时，
   * 按服务的缺省 2 路要跑到天亮。上限 32：再高对单机上的 CLI Agent 没有
   * 意义（进程、内存、模型配额都会先撑不住），且没有上限的并发是另一种
   * 形式的不可控。
   */
  concurrency: z.number().int().min(1).max(32).optional(),
});

/** 编排器对话：一句话指令 + 可选的自报身份。 */
const runMessageBodySchema = z.object({
  text: z.string().min(1),
  /** 与审批一致：身份优先取请求头，body 只是手工调用的兜底 */
  actor: z.string().min(1).optional(),
});

/**
 * 节点会话：对这个节点说一句话。
 *
 * 与编排器对话同一形状（text + 可选 actor），刻意不复用同一个 schema：两者的
 * 语义完全不同——一句是「改这张图」，一句是「这一次执行按我说的改」。共用一个
 * schema 之后，任何一边加字段都会悄悄变成对另一边的承诺。
 */
const nodeMessageBodySchema = z.object({
  text: z.string().min(1),
  actor: z.string().min(1).optional(),
});

/**
 * 会话里的用户/编排器消息事件。
 *
 * 抽成一个具名类型，是因为「最近几轮对话」这段上下文要在三处使用（落库、
 * 拼指令、回复），每处各写一遍 `Extract<...>` 只会让改动漏掉某处。
 */
type ConversationMessage = Extract<OrchestratorEvent, { type: 'orchestrator.message' }>;

/**
 * 打断一次正在进行的拆解之后，等它让位的上限。
 *
 * 为什么必须等：`startPlanning` 看到表里还有条目就直接复用那条已中止的链，
 * 「按新要求重来」于是变成「什么都没发生」。为什么不能无限等：一个不肯退出
 * 的 CLI 进程不能把用户已经下达的新要求永久挂起——超时之后强制作废表项，
 * 旧链即便还活着也不可能再交出图（冻结之前有一道 `throwIfAborted`）。
 */
const INTERRUPT_SETTLE_TIMEOUT_MS = 2_000;

/**
 * 重新拆解时用的目标：原目标 + 这次中途插进来的要求。
 *
 * 不是「用新要求覆盖原目标」：重拆是从零开始的一次新任务，只给它半句话会
 * 拆出一张只覆盖后半段的图，而人以为自己还在做原来那件事。
 */
function replanGoal(goal: string, instruction: string): string {
  const base = goal.trim();
  return base
    ? `${base}\n\n## 用户的补充要求（中途插入，与上文同等重要）\n${instruction.trim()}`
    : instruction.trim();
}

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
    deliverables: node.deliverables,
    acceptance: node.acceptance,
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
  const modelProviders = new ModelProviders(dirname(resolve(options.logPath)));
  await modelProviders.load();
  const loadCatalog = (): Promise<AgentProfile[]> =>
    runnerMode === 'mock' && !options.catalog
      ? Promise.resolve(baseline.map((agent) => ({ ...agent, availability: 'ready' })))
      : probeCatalog(baseline, log);
  let builtinCatalog = await loadCatalog();
  let catalog = [...builtinCatalog, ...modelProviders.profiles()];
  registerModelRoutes(app, modelProviders, dirname(resolve(options.logPath)), () => catalog, () => {
    catalog = [...builtinCatalog, ...modelProviders.profiles()];
  });

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

  // 默认真跑：用户要的是看到 Agent 实际执行，回放只是没有可执行 Agent 时的兜底。
  //
  // 允许注入：有些行为只有拿到**真实发出的 prompt** 才能断言（比如「人类的补充
  // 要求有没有被拼进去」）。MockAgentRunner 不回显 prompt，光靠类型和代码审查
  // 检查「buildAdvanceDeps 有没有接线」是不够的——删掉那一行不会有任何测试变红。
  const baseRunner: AgentRunner =
    options.runner ??
    (runnerMode === 'real'
      ? new RoutingAgentRunner(transportResolver(() => catalog), {
          registry: options.registry,
          log,
          http: new HttpModelRunner(modelProviders),
        })
      : new MockAgentRunner(workspaceMode === 'git'));
  const activity = new AgentActivity(
    (id) => store.snapshot.runs[id],
    (runId) => store.bus.publish({ type: 'agent.activity', runId, at: now() }),
  );
  const runner = activity.observe(baseRunner, (id) => findAgent(id, catalog));
  const meetings = new Meetings(dirname(resolve(options.logPath)), baseRunner, () => catalog,
    (runId) => store.bus.publish({ type: 'meeting.updated', runId, at: now() }));
  await meetings.load();
  app.addHook('onClose', () => meetings.close());

  // 默认 git：只有真 git worktree 才产得出 diff，审查节点也才有东西可审。
  // temp 保留作为降级选项——在没有 git 的环境里仍能跑通整条编排链路，
  // 代价是审查提示词里只会有一句「该上游节点没有产出 diff」。
  /**
   * 编排器自己的数据根目录，与「这次在哪干活」无关。
   *
   * 规则集中在 `paths.ts`：源码运行时是仓库根下的 `data/`；打包成 exe 之后
   * 没有仓库可溯源，会退到 exe 同级目录或用户目录。这里不重复那套判断——
   * 两处各写一份，迟早出现「锁在一处、journal 在另一处」。
   */
  const dataRoot = resolveDataDir();

  /** 旧运行使用的临时工作区根。 */
  const scratchRoot = process.env.AGENT_WORKTREE_DIR
    ? resolve(process.env.AGENT_WORKTREE_DIR)
    : resolve(dataRoot, 'worktrees');

  /**
   * 服务级默认目标目录：只有运维显式配了 `AGENT_TARGET_DIR` 才有。
   *
   * 早先这里兜底成 `process.cwd()`，结果是「在哪个仓库里启动服务，成果就落
   * 在哪个仓库」——用户新建运行时不填目录也能提交，等他发现时文件已经堆进
   * 了自己没打算动的地方。目标目录必须是一次显式选择，不能有隐式默认。
   */
  const envTargetDir = process.env.AGENT_TARGET_DIR?.trim();
  const defaultWorkspaceRoot: string | null = envTargetDir
    ? resolve(envTargetDir)
    : null;

  /**
   * 按目标目录缓存工作区实例。
   *
   * 复用是安全的：实例本身无状态，真正的隔离是每个节点各自的
   * `<worktreeRoot>/<runId>/<nodeId>`。缓存省下的是重复的目录判断与 git 调用。
   */
  const workspaces = new Map<string, GitWorktreeWorkspace | TempDirWorkspace>();

  /** 老记录保留原路径，新记录的默认工作区在所选项目内。 */
  const worktreeRootOverride = process.env.AGENT_WORKTREE_DIR
    ? resolve(process.env.AGENT_WORKTREE_DIR)
    : undefined;

  function worktreeRootFor(root: string, managed: boolean): string {
    return worktreeRootOverride ?? (managed
      ? resolve(root, PROJECT_DATA, 'worktrees')
      : workspaceMode === 'git' ? resolve(root, '.worktrees') : scratchRoot);
  }

  /** 取出某个目标目录对应的工作区实现。 */
  function workspaceAt(root: string, managed: boolean): GitWorktreeWorkspace | TempDirWorkspace {
    const worktreeRoot = worktreeRootFor(root, managed);
    const key = root + '\0' + worktreeRoot;
    const cached = workspaces.get(key);
    if (cached) {
      return cached;
    }
    const created =
      workspaceMode === 'git'
        ? new GitWorktreeWorkspace(root, worktreeRoot)
        : new TempDirWorkspace(worktreeRoot);
    workspaces.set(key, created);
    return created;
  }

  /**
   * 这个运行该用哪个工作区。
   *
   * 空 `workspaceRoot` 是旧 journal 的兜底值（见 core 里 `run.created` 的归约）：
   * 那些运行创建时还没有「目标目录」这个概念。它们只能靠服务级默认目录继续，
   * 没有那个配置就无解——此时抛出去，由调用方记成「工作区准备失败」，
   * 比随便挑一个目录继续跑诚实。
   */
  function workspaceFor(run: RunFacts): WorkspacePort {
    const root = run.workspaceRoot ? resolve(run.workspaceRoot) : defaultWorkspaceRoot;
    if (!root) {
      throw new Error(
        `运行 ${run.id} 没有记录目标目录（旧数据），且服务未配置 AGENT_TARGET_DIR`,
      );
    }
    return workspaceAt(root, Boolean(store.projectWorkspace(run.id)));
  }

  function planningWorkspace(runId: string, workspace: WorkspacePort): WorkspacePort {
    return {
      prepare: (attempt, node) => workspace.prepare(runId, `plan-${attempt}-${node}`),
      release: (attempt, node) => workspace.release(runId, `plan-${attempt}-${node}`),
    };
  }

  const interviews = new SpecInterviews(
    baseRunner,
    (root) => workspaceAt(root, true),
    (id) => findAgent(id, catalog),
    (runId) => store.bus.publish({ type: 'spec.updated', runId, at: now() }),
    dirname(resolve(options.logPath)),
  );
  await interviews.load();
  const knownProjects = new Set(Object.values(store.snapshot.runs).map((run) => run.workspaceRoot).filter(Boolean));
  if (defaultWorkspaceRoot) knownProjects.add(defaultWorkspaceRoot);
  await Promise.allSettled([...knownProjects].map((root) => interviews.discover(root)));
  registerMeetingRoutes(app, meetings, resolveActor, (id) => interviews.rootOf(id), (room) =>
    room.sourceSpecId && store.snapshot.runs[room.sourceSpecId] ? room.sourceSpecId
      : Object.values(store.snapshot.runs).filter((run) => run.sourceMeetingId === room.id)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0]?.id);
  const handingOff = new Set<string>();

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
    | {
        ok: false;
        code: 'workspace_required' | 'workspace_not_found' | 'workspace_not_git';
        message: string;
      };

  /**
   * 弹一个原生目录选择框，返回用户选的绝对路径。
   *
   * 为什么要后端弹：浏览器拿不到绝对路径。File System Access API 的
   * `showDirectoryPicker()` 只给 handle，路径对前端是保密的，而编排器要的
   * 恰恰是一个能传给 git 的绝对路径。
   *
   * 为什么不用 FolderBrowserDialog：那是 Windows 上最老的树形选择器，不能
   * 直接粘贴路径、没有地址栏、不能新建文件夹后立刻跳进去。这里借用
   * OpenFileDialog 加上「允许不存在的文件名」的开关——它的外壳就是标准的
   * 「打开文件」对话框，有地址栏、有快速访问、能粘贴路径，用户在上面选好
   * 目录后点「打开」，我们取所在目录即得目标路径。
   */
  async function pickDirectory(): Promise<
    | { picked: true; path: string }
    | { picked: false; reason: 'cancelled' | 'unsupported' | 'failed'; message?: string }
  > {
    if (process.platform !== 'win32') {
      return { picked: false, reason: 'unsupported', message: '原生目录选择只在 Windows 上提供' };
    }

    // -STA 是 WinForms 的硬要求：MTA 线程里弹窗会直接抛异常。
    const script = [
      'Add-Type -AssemblyName System.Windows.Forms | Out-Null',
      '$dialog = New-Object System.Windows.Forms.OpenFileDialog',
      "$dialog.Title = '选择目标目录：进入文件夹后点「打开」'",
      // 关掉文件名合法性校验，用户在同一目录里点「打开」就能确认选这个目录
      '$dialog.ValidateNames = $false',
      '$dialog.CheckFileExists = $false',
      '$dialog.CheckPathExists = $true',
      '$dialog.RestoreDirectory = $true',
      // 这一行是占位文件名：它让对话框把「打开」解释为「选当前目录」
      "$dialog.FileName = '选择当前文件夹'",
      "$dialog.Filter = '文件夹|*.folder'",
      'if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {',
      '  Write-Output (Split-Path -Parent $dialog.FileName)',
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
        return { picked: false, reason: 'cancelled' };
      }
      return { picked: true, path: resolve(picked) };
    } catch (error) {
      app.log.warn({ err: error }, '弹目录选择框失败');
      return { picked: false, reason: 'failed', message: (error as Error).message };
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
    if (!raw) {
      // 没有请求值、也没有服务级默认：目标目录必须是一次显式选择。
      // 猜一个目录（比如进程的工作目录）会让成果落在用户没打算动的地方，
      // 而他直到发现文件跑错地方才知道。
      return {
        ok: false,
        code: 'workspace_required',
        message: '请先选择目标目录：这是 Agent 干活的地方，成果会落在这里。',
      };
    }
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
      return { ok: true, root: await withWorktreeExcluded(await realpath(root)) };
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

    if (workspaceMode === 'git') {
      try {
        await ensureHeadCommit(root);
      } catch (error) {
        return { ok: false, code: 'workspace_not_git', message: `准备 Git 基线失败：${(error as Error).message}` };
      }
    }
    return { ok: true, root: await withWorktreeExcluded(await realpath(root)) };
  }

  /**
   * 让目标仓库**本地**忽略 `.worktrees/`，返回原值以便就地串进 return。
   *
   * 写 `.git/info/exclude` 而不是用户的 `.gitignore`：后者会进版本库、被
   * 别的机器和协作者看到，而「这台机器上编排器在这里干活」是纯粹的本地事实。
   * 用户不该因为用了编排器就往自己的仓库里提交一条 `.worktrees/`。
   *
   * 失败不阻断：忽略配不上顶多让 `git status` 多一行，不该让整个运行起不来。
   */
  async function withWorktreeExcluded(root: string): Promise<string> {
    const entries = ['.worktrees/', PROJECT_DATA + '/'];
    try {
      const gitDir = resolve(root, '.git');
      // worktree 形式的仓库 `.git` 是文件而不是目录，这里只需要常见那种
      if (!existsSync(gitDir) || !statSync(gitDir).isDirectory()) {
        return root;
      }
      const infoDir = resolve(gitDir, 'info');
      const excludeFile = resolve(infoDir, 'exclude');
      const current = existsSync(excludeFile) ? await readFile(excludeFile, 'utf8') : '';
      const existing = current.split(/\r?\n/).map((line) => line.trim());
      const missing = entries.filter((entry) => !existing.includes(entry));
      if (!missing.length) return root;
      await mkdir(infoDir, { recursive: true });
      const prefix = current && !current.endsWith('\n') ? `${current}\n` : current;
      await writeFile(
        excludeFile,
        `${prefix}${missing.join('\n')}\n`,
        'utf8',
      );
    } catch (error) {
      log.debug('写入 .git/info/exclude 失败（不影响运行）', { root, error });
    }
    return root;
  }

  // diff 原文落盘，事件日志里只留统计量与路径。data/* 已在 gitignore 内。
  const artifacts = new ArtifactStore(
    process.env.AGENT_ARTIFACT_DIR ?? resolve(dataRoot, 'artifacts'),
  );
  const memory = new RunMemory(
    (id) => store.projectWorkspace(id),
    (runId) => store.bus.publish({ type: 'blackboard.updated', runId, at: now() }),
  );

  async function artifactsFor(runId: string): Promise<ArtifactStore> {
    const root = store.projectWorkspace(runId);
    return root ? new ArtifactStore(await projectRunPath(root, runId, 'artifacts'), true) : artifacts;
  }

  async function writePlan(runId: string, dag: Dag): Promise<void> {
    const root = store.projectWorkspace(runId);
    if (root) await writeAtomic(await projectRunPath(root, runId, 'plan.json'), JSON.stringify(dag, null, 2) + '\n');
  }

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
      saveTaskFiles: async (run, node, cwd, commit) => {
        const root = store.projectWorkspace(run.id);
        if (!root || !node.deliverables?.length) return undefined;
        return saveTaskDelivery({ root, runId: run.id, nodeId: node.id, cwd, commit, deliverables: node.deliverables });
      },
      exportDelivery: async (run, _node, result) => {
        const root = store.projectWorkspace(run.id);
        if (!root) return undefined;
        const commit = result.commit ?? (await execFileAsync('git', ['rev-parse', '--verify', `refs/heads/${result.branch}`], {
          cwd: root, windowsHide: true, timeout: 30_000,
        })).stdout.trim();
        const planned = new Map<string, NonNullable<NodeFacts['deliverables']>[number]>();
        for (const id of result.merged) {
          for (const item of run.nodes[id]?.deliverables ?? []) planned.set(item.path, item);
        }
        return saveIntegratedDelivery(root, run.id, commit, planned.values());
      },
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
      saveArtifact: async (runId, nodeId, artifact) =>
        (await artifactsFor(runId)).save(runId, nodeId, artifact),
      loadArtifact: async (runId, nodeId) => (await artifactsFor(runId)).load(runId, nodeId),
      memory,
      nodeInFlight,
      // 节点提示词要带上「人在开发过程中插的话」。内核不持有事件日志，所以从
      // 这里接出去；整轮推进与单跑共用同一个取值函数，否则同一个节点在两条
      // 路径上会读到不同的补充要求——那正是最难解释的一类不一致。
      eventsForRun: (id) => store.eventsForRun(id),
      waitBeforeDispatch: (id) => amendChains.get(id),
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
   * 同一运行上的改图改成排队执行。
   *
   * 两个并发的 `POST /messages` 各自基于同一份旧图快照算 diff，后落地的
   * `dag.amended` 按字段覆盖，先落地那条的改动就被**静默吃掉**了——用户看到
   * 自己说过的两句话都在，却只有一句生效。对话从窄面板变成常驻大窗口之后，
   * 多标签页同时开口的概率明显上升，这个窗口必须堵上。
   *
   * 选排队而不是拒绝：用户只是又补了一句，让他等前一句算完就能基于最新图继续，
   * 比回一个「稍后再试」有用得多。
   */
  const amendChains = new Map<string, Promise<void>>();
  const planControls = new Set<string>();

  /**
   * 排到该运行的改图队尾，返回释放函数。
   *
   * 调用方拿到名额后必须**重新读快照**：前一个请求可能刚改过图，端着进端点时
   * 那份快照已经过期了。
   */
  async function acquireAmendSlot(runId: string): Promise<() => void> {
    const previous = amendChains.get(runId) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const mine = previous.then(() => gate);
    amendChains.set(runId, mine);
    await previous;

    return () => {
      release();
      // 队尾还是自己时才把键删掉；后面已经有人在排的话，交给最后那个人收尾
      if (amendChains.get(runId) === mine) {
        amendChains.delete(runId);
      }
    };
  }

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
          workspace: planningWorkspace(runId, workspaceAt(request.workspaceRoot, Boolean(store.projectWorkspace(runId)))),
          onEvents: relay.forward,
        },
        { agentId: requestedAgentId, runId, signal, requireDeliverables: store.snapshot.runs[runId]?.requireDeliverables },
      ).finally(relay.flush);

      // 角色覆盖要在校验之前：校验看的是最终 agentId，不是 Planner 猜的那个
      signal.throwIfAborted();
      const dag = applyRoleAgents(generated.dag, request.roles);

      // 冻结前的最后一道闸。覆盖可能把 agentId 换成目录里不存在的值，
      // 那样的图必须在这里被拦下——冻结之后再发现，只能靠画布上一个个
      // 节点报错，而不是一句「这张图不能用」。
      const validation = validateDag(dag, catalog, { requireDeliverables: store.snapshot.runs[runId]?.requireDeliverables });
      if (!validation.ok) {
        throw new DagGenerationError(
          '角色覆盖之后这张图不再合法',
          generated.attempts,
          validation.issues,
        );
      }

      const run = store.snapshot.runs[runId]!;
      if (run.reviewPlan) {
        const root = store.projectWorkspace(runId)!;
        const checker = [findAgent(run.reviewAgentId ?? '', catalog), ...catalog.filter((item) => item.id !== agentId), findAgent(agentId, catalog)]
          .find((item) => item?.enabled && item.availability !== 'missing');
        await store.emit({ type: 'plan.checking', at: now(), runId, agentId: checker?.id ?? 'orchestrator' });
        const verification = checker
          ? await verifyPlan({ runId, goal: request.goal, dag, agent: checker, runner, signal, workspace: workspaceFor(run) })
          : { status: 'unavailable' as const, agentId: 'orchestrator', summary: '没有可用的核对 Agent。', findings: [] };
        signal.throwIfAborted();
        const draft: PlanDraft = { revision: randomUUID(), dag, attempts: generated.attempts, verification };
        await writeAtomic(await projectRunPath(root, runId, 'plan-draft.json'), JSON.stringify(draft, null, 2) + '\n');
        signal.throwIfAborted();
        await store.emit({ type: 'plan.drafted', at: now(), runId, revision: draft.revision });
        return;
      }

      await freezePlan(runId, dag, generated.agentId, generated.attempts, signal);
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

  async function freezePlan(runId: string, dag: Dag, agentId: string, attempts: number, signal?: AbortSignal, actor?: string) {
    await writePlan(runId, dag);
    signal?.throwIfAborted();
    await store.emit({ type: 'run.frozen', at: now(), runId, nodes: toNodeFacts(dag), ...(actor ? { actor } : {}) });
    await memory.remember(runId, '_planner', agentId, { ok: true, exitCode: 0, output: '' },
      `生成了 ${dag.nodes.length} 个节点，规划尝试 ${attempts} 次。任务图已通过校验。`,
    ).catch((error: unknown) => log.warn('无法写入规划 Agent 记忆', error));
    await memory.post(runId, {
      source: 'system', author: resolveAgent(agentId) ?? agentId,
      text: `PM 已生成 ${dag.nodes.length} 个任务，执行节点可在共享黑板交接决定和结果。`,
    }).catch((error: unknown) => log.warn('无法写入规划交接记录', error));
    if (!signal?.aborted) void advance(runId);
  }

  function currentPlanningGoal(run: RunFacts) {
    const input = recentConversation(run.id).filter((message) => message.role === 'user').map((message) => message.text);
    return input.length ? replanGoal(run.goal, input.join('\n')) : run.goal;
  }

  async function readPlanDraft(run: RunFacts): Promise<PlanDraft | undefined> {
    const root = store.projectWorkspace(run.id);
    if (!root || !run.planDraft) return undefined;
    const raw = await readOptional(await projectRunPath(root, run.id, 'plan-draft.json'));
    if (!raw) return undefined;
    const draft = JSON.parse(raw) as PlanDraft;
    return draft.revision === run.planDraft.revision ? draft : undefined;
  }

  app.get<{ Params: { id: string } }>('/api/runs/:id/plan-review', async (request, reply) => {
    const run = store.snapshot.runs[request.params.id];
    const draft = run && await readPlanDraft(run);
    return draft ?? reply.code(404).send({ message: '草案尚未就绪。' });
  });

  app.get<{ Params: { id: string; name: string } }>('/api/runs/:id/plan-files/:name', async (request, reply) => {
    const { id, name } = request.params;
    const run = store.snapshot.runs[id];
    const root = run && store.projectWorkspace(id);
    if (!root || !(name === 'spec.md' || name === 'plan.json' ||
        name === 'plan-draft.json' && (run.planDraft || run.frozenAt))) {
      return reply.code(404).send({ message: '规划文件尚未写入。' });
    }
    const path = await projectRunPath(root, id, name);
    if (!existsSync(path)) return reply.code(404).send({ message: '规划文件尚未写入。' });
    return reply.type(name.endsWith('.json') ? 'application/json' : 'text/markdown; charset=utf-8')
      .header('X-Content-Type-Options', 'nosniff').header('Content-Disposition', attachment(name))
      .send(createReadStream(path));
  });

  app.post<{ Params: { id: string } }>('/api/runs/:id/plan-review/approve', async (request, reply) => {
    const runId = request.params.id;
    const revision = z.object({ revision: z.string().uuid() }).safeParse(request.body);
    const run = store.snapshot.runs[runId];
    if (!run) return reply.code(404).send({ message: '未找到该运行。' });
    if (!revision.success || !run.planDraft || run.planDraft.revision !== revision.data.revision || run.pausedAt ||
        deletingRuns.has(runId) || planControls.has(runId)) {
      return reply.code(409).send({ message: '草案正在更新或已暂停，请查看最新版本。' });
    }
    planControls.add(runId);
    try {
      const draft = await readPlanDraft(run);
      if (!draft) return reply.code(409).send({ message: '草案文件已更新，请刷新。' });
      const checked = safeParseDag(draft.dag);
      if (!checked.success || !validateDag(checked.data, catalog, { requireDeliverables: run.requireDeliverables }).ok) {
        return reply.code(422).send({ message: '草案或 Agent 配置已变化，请重新核对。' });
      }
      const actor = resolveActor(request.headers);
      const planner = pickPlannerAgent(catalog, run.plannerAgentId)?.id ?? 'orchestrator';
      await freezePlan(runId, checked.data, planner, draft.attempts, undefined, actor);
      return { ok: true };
    } finally {
      planControls.delete(runId);
    }
  });

  /** 发起一次拆解。已经在拆的直接复用：不排队，也不重复调 Agent。 */
  function startPlanning(runId: string, request: PlanRequest): void {
    if (planning.has(runId)) {
      return;
    }
    const controller = new AbortController();
    let task: AdvanceTask;
    const done = runPlanning(runId, request, controller.signal)
      .catch((error: unknown) => {
        app.log.error({ err: error, runId }, '拆解链路异常退出');
      })
      .finally(() => {
        /**
         * 只清理自己那一条。
         *
         * 中断重来会先 abort 再登记新链；旧链的收尾早不来就晚不来，无条件
         * `delete(runId)` 会把刚登记的新链从表里抹掉——于是这个 run 又能被
         * 第三条请求并发发起一次拆解，两张图互相覆盖。与 `startAdvance` 同一
         * 套写法，理由也一样。
         */
        if (planning.get(runId) === task) {
          planning.delete(runId);
        }
      });
    task = { controller, done };
    planning.set(runId, task);
  }

  /**
   * 等一段被中止的拆解让位。
   *
   * 返回之后，表里那个 runId 要么已经空出来（正常收尾），要么被强制作废
   * （旧链不肯退出）——两种情况下 `startPlanning` 都能登记新链。
   */
  async function settleAbortedPlanning(runId: string, task: AdvanceTask): Promise<void> {
    await Promise.race([
      task.done.catch(() => {}),
      new Promise<void>((resolve) => {
        // unref：这个兜底计时器不该独自把进程钉住（测试退出时尤其明显）
        setTimeout(resolve, INTERRUPT_SETTLE_TIMEOUT_MS).unref();
      }),
    ]);
    if (planning.get(runId) === task) {
      app.log.warn(
        { runId },
        '被打断的拆解没有在时限内退出，强制作废并开始新的拆解',
      );
      planning.delete(runId);
    }
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

  app.get<{ Querystring: { runId?: string; summary?: string } }>('/api/agents/activity', async (request) => {
    const intervals = [...activity.entries, ...interviews.activity, ...meetings.activity]
      .filter((entry) => entry.agentId !== 'orchestrator' && (!request.query.runId || entry.runId === request.query.runId))
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
    return {
      mode: runnerMode,
      active: intervals.filter((entry) => entry.status === 'running').length,
      intervals: request.query.summary === 'true' ? [] : intervals.map((entry) => ({ ...entry, agentLabel: resolveAgent(entry.agentId) ?? entry.agentId })),
    };
  });

  const specRoot = z.string().trim().min(1).refine(isAbsolute);
  const startSpec = z.object({
    workspaceRoot: specRoot,
    idea: z.string().trim().min(1).max(16_000),
    agentId: z.string().min(1).optional(),
    model: modelIdSchema.optional(),
  });
  const specAnswer = z.object({
    workspaceRoot: specRoot,
    revision: z.number().int().nonnegative(),
    answer: z.string().trim().min(1).max(12_000).optional(),
  });

  app.post('/api/specs', async (request, reply) => {
    const body = startSpec.safeParse(request.body);
    if (!body.success) return reply.code(400).send({ message: '请输入产品想法并选择目标目录。' });
    const agent = pickPlannerAgent(catalog, body.data.agentId || process.env.PLANNER_AGENT_ID || undefined);
    if (!agent?.enabled || agent.availability === 'missing') {
      return reply.code(422).send({ message: '请选择一个已安装且启用的设计 Agent。' });
    }
    const checked = await checkWorkspaceRoot(body.data.workspaceRoot);
    if (!checked.ok) return reply.code(400).send({ message: checked.message });
    await ownedPath(checked.root, PROJECT_DATA, 'worktrees');
    if (body.data.model && !supportsModel(agent)) {
      return reply.code(422).send({ message: '该设计 Agent 使用客户端默认模型。' });
    }
    return reply.code(201).send(await interviews.start(checked.root, body.data.idea, agent.id, body.data.model));
  });

  app.get('/api/specs', async () => interviews.list().filter(({ id }) => !store.snapshot.runs[id]));
  app.get<{ Params: { id: string }; Querystring: { workspaceRoot?: string } }>('/api/specs/:id', async (request, reply) => {
    const id = runIdSchema.safeParse(request.params.id);
    if (!id.success) return reply.code(400).send({ message: '访谈编号无效。' });
    const root = specRoot.safeParse(interviews.rootOf(id.data) ?? request.query.workspaceRoot);
    if (!root.success) return reply.code(404).send({ message: '找不到访谈目录。' });
    const session = await interviews.recover(resolve(root.data), id.data);
    return session ?? reply.code(404).send({ message: '未找到这次规格访谈。' });
  });

  app.post<{ Params: { id: string } }>('/api/specs/:id/answer', async (request, reply) => {
    const body = specAnswer.safeParse(request.body);
    const id = runIdSchema.safeParse(request.params.id);
    if (!body.success || !id.success) return reply.code(400).send({ message: '访谈回答或编号无效。' });
    if (handingOff.has(id.data) || Object.hasOwn(store.snapshot.runs, id.data)) {
      return reply.code(409).send({ message: '该访谈正在交接或已经交给 PM。' });
    }
    handingOff.add(id.data);
    try {
      const session = await interviews.answer(resolve(body.data.workspaceRoot), id.data, body.data.revision, body.data.answer);
      return session ?? reply.code(404).send({ message: '未找到这次规格访谈。' });
    } catch (error) {
      if (error instanceof InterviewConflict) return reply.code(409).send({ message: error.message });
      throw error;
    } finally {
      handingOff.delete(id.data);
    }
  });

  app.post<{ Params: { id: string } }>('/api/specs/:id/adopt-meeting', async (request, reply) => {
    const { id } = request.params;
    const input = z.object({ meetingId: runIdSchema, revision: z.number().int().nonnegative() }).safeParse(request.body);
    const root = interviews.rootOf(id);
    if (!root || !input.success) return reply.code(400).send({ message: '访谈或会议编号无效。' });
    if (handingOff.has(id) || store.snapshot.runs[id]) {
      return reply.code(409).send({ message: '该规格已交给 PM。' });
    }
    handingOff.add(id);
    try {
      const room = meetings.get(input.data.meetingId);
      if (room.workspaceRoot !== root || room.sourceSpecId !== id || room.status !== 'complete' || room.reportStale || !room.report) {
        return reply.code(422).send({ message: '请选择当前访谈关联的、已汇总的会议方案。' });
      }
      const session = await interviews.adopt(root, id, input.data.revision, { id: room.id, title: room.title, report: room.report, at: room.updatedAt });
      return session ?? reply.code(404).send({ message: '访谈已移走。' });
    } catch (error) {
      if (error instanceof InterviewConflict) return reply.code(409).send({ message: error.message });
      if (error instanceof MeetingError) return reply.code(error.code).send({ message: error.message });
      throw error;
    } finally {
      handingOff.delete(id);
    }
  });

  /** 当前执行配置。前端拿它告诉用户「这轮是真的调 Agent 还是回放」 */
  app.get('/api/runtime', async () => ({
    runner: runnerMode,
    workspace: workspaceMode,
    concurrency: Number(process.env.AGENT_CONCURRENCY ?? 2),
    plannerAgentId: process.env.PLANNER_AGENT_ID ?? null,
    /**
     * 服务级默认目标目录，没有配置就是 null。
     *
     * 刻意不再兜底成进程的工作目录：目标目录必须由用户显式选择。前端拿到
     * null 就不预填，让「选目录」这件事无法被跳过。
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
    builtinCatalog = await loadCatalog();
    catalog = [...builtinCatalog, ...modelProviders.profiles()];
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

  const deletingRuns = new Set<string>();
  const mutationCounts = new Map<string, number>();
  const mutatingRequests = new WeakMap<object, string>();

  app.addHook('preHandler', async (request, reply) => {
    if (request.method !== 'POST' || !request.routeOptions.url?.startsWith('/api/runs/:id/')) return;
    const { id } = request.params as { id: string };
    if (deletingRuns.has(id)) return reply.code(409).send({ message: '正在删除这个运行。' });
    mutatingRequests.set(request, id);
    mutationCounts.set(id, (mutationCounts.get(id) ?? 0) + 1);
  });
  app.addHook('onSend', async (request, _reply, payload) => {
    const id = mutatingRequests.get(request);
    if (id) {
      mutatingRequests.delete(request);
      const count = (mutationCounts.get(id) ?? 1) - 1;
      if (count === 0) mutationCounts.delete(id);
      else mutationCounts.set(id, count);
    }
    return payload;
  });

  app.delete<{ Params: { id: string } }>('/api/runs/:id', async (request, reply) => {
    const runId = request.params.id;
    const run = store.snapshot.runs[runId];
    if (!Object.hasOwn(store.snapshot.runs, runId) || !run || !runIdSchema.safeParse(runId).success) {
      return reply.code(404).send({ error: 'run_not_found', message: '未找到这条运行。' });
    }
    if (deletingRuns.has(runId) || mutationCounts.has(runId) || handingOff.has(runId) ||
        advancing.has(runId) || planning.has(runId) || amendChains.has(runId) || planControls.has(runId) ||
        run.nodeOrder.some((id) => nodeInFlight.has(nodeInFlightKey(runId, id))) ||
        activity.entries.some((entry) => entry.runId === runId && entry.status === 'running')) {
      return reply.code(409).send({ error: 'run_busy', message: '请先停止运行，等 Agent 退出后再删除。' });
    }
    deletingRuns.add(runId);
    try {
      const managed = store.projectWorkspace(runId);
      const root = managed ?? (run.workspaceRoot || undefined);
      if (root && existsSync(root)) {
        if (managed && await realpath(root) !== root) throw new Error('目标目录的真实位置已变化');
        if (!worktreeRootOverride) {
          if (managed) await ownedPath(root, PROJECT_DATA, 'worktrees');
          else await ownedPath(root, '.worktrees');
        }
        await workspaceAt(root, Boolean(managed)).removeRun(runId);
      }
      if (!managed) await artifacts.removeLegacyRun(runId);
      await store.removeRun(runId, now());
      activity.forget(runId);
      interviews.forget(runId);
      return { ok: true };
    } catch (error) {
      log.warn('删除运行未完成', { runId, error });
      return reply.code(409).send({
        error: 'cleanup_failed',
        message: '清理运行失败。请检查目标目录是否可写或工作区是否被占用，然后重试。',
      });
    } finally {
      deletingRuns.delete(runId);
    }
  });

  app.get<{ Params: { id: string } }>('/api/runs/:id/blackboard', async (request, reply) => {
    const { id } = request.params;
    if (!Object.hasOwn(store.snapshot.runs, id)) return reply.code(404).send({ error: 'run_not_found' });
    const workspaceRoot = store.projectWorkspace(id);
    const directory = workspaceRoot ? await projectRunPath(workspaceRoot, id) : null;
    return { directory, hasOutput: Boolean(await runArchive(id)), entries: await memory.board(id) };
  });

  app.post<{ Params: { id: string } }>('/api/runs/:id/blackboard', async (request, reply) => {
    const { id } = request.params;
    if (!Object.hasOwn(store.snapshot.runs, id)) return reply.code(404).send({ message: '未找到这条运行。' });
    const body = z.object({ text: z.string().trim().min(1).max(1500) }).safeParse(request.body);
    if (!body.success) return reply.code(400).send({ message: '请输入要共享的内容，最多 1500 字。' });
    const post = await memory.post(id, {
      source: 'human', author: resolveActor(request.headers), text: body.data.text,
    });
    return post ?? reply.code(409).send({ message: '这条旧运行没有项目目录内的协作黑板。' });
  });

  async function runArchive(id: string) {
    const run = store.snapshot.runs[id];
    const root = run && store.projectWorkspace(id);
    if (!root) return undefined;
    const merge = Object.values(run.nodes).filter((node) =>
      node.action === 'merge' && node.finishedAt && !node.failureReason && node.mergedBranch,
    ).sort((a, b) => b.finishedAt!.localeCompare(a.finishedAt!))[0];
    if (!merge) return undefined;
    const path = merge.delivery
      ? await projectRunPath(root, id, 'output', merge.delivery.revision + '.zip')
      : await projectRunPath(root, id, 'output.zip');
    return existsSync(path) ? path : undefined;
  }

  app.get<{ Params: { id: string } }>('/api/runs/:id/output', async (request, reply) => {
    const { id } = request.params;
    const path = await runArchive(id);
    if (!path) return reply.code(404).send({ error: 'output_not_found' });
    return reply
      .type('application/zip')
      .header('Content-Disposition', 'attachment; filename="' + id + '.zip"')
      .send(createReadStream(path));
  });

  app.get<{ Params: { id: string; nodeId: string }; Querystring: { path?: string; revision?: string } }>(
    '/api/runs/:id/nodes/:nodeId/file', async (request, reply) => {
      const { id, nodeId } = request.params;
      const run = store.snapshot.runs[id];
      const root = run && store.projectWorkspace(id);
      const node = run && Object.hasOwn(run.nodes, nodeId) ? run.nodes[nodeId] : undefined;
      const current = node?.delivery;
      const { path, revision } = request.query;
      if (!root || !node || !current || typeof path !== 'string' || revision !== current.revision) {
        return reply.code(404).send({ message: '没有找到本次落盘的文件。' });
      }
      const file = await deliveryFile(root, id, nodeId, path, current, node.action === 'merge');
      return file ? reply.type('application/octet-stream').header('X-Content-Type-Options', 'nosniff')
        .header('Content-Disposition', attachment(file)).send(createReadStream(file))
        : reply.code(404).send({ message: '文件已经移走或不存在。' });
    },
  );

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

      const diff = await (await artifactsFor(run.id)).load(run.id, node.id);
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

    // 显式任务图可先校验，避免拒绝的请求创建目录或初始化仓库。
    let submittedDag: Dag | undefined;
    if (body.data.dag !== undefined) {
      const parsed = safeParseDag(body.data.dag);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'invalid_dag', issues: parsed.error.issues });
      }

      // 角色覆盖要在校验之前：校验看的是最终 agentId，不是 Planner 猜的那个
      submittedDag = applyRoleAgents(parsed.data, {
        implementAgentId: body.data.implementAgentId,
        reviewAgentId: body.data.reviewAgentId,
      });

      // 冻结前的最后一道闸：不合法就不许进执行阶段
      const validation = validateDag(submittedDag, catalog, { requireDeliverables: body.data.requireDeliverables });
      if (!validation.ok) {
        return reply.code(422).send({ error: 'dag_rejected', issues: validation.issues });
      }
    }

    const checked = await checkWorkspaceRoot(body.data.workspaceRoot);
    if (!checked.ok) {
      return reply.code(400).send({ error: checked.code, message: checked.message });
    }
    const workspaceRoot = checked.root;
    const implementer = findAgent(body.data.implementAgentId, catalog);
    if (implementer?.transport === 'http-model') {
      return reply.code(422).send({ message: '实现角色需要具备工程工具的 Agent。' });
    }
    if (body.data.sourceMeetingId) {
      try {
        const room = meetings.get(body.data.sourceMeetingId);
        if (room.workspaceRoot !== workspaceRoot || room.status !== 'complete' || room.reportStale || !room.report) {
          return reply.code(422).send({ message: '请先确认同一项目目录下的会议方案。' });
        }
      } catch (error) {
        if (error instanceof MeetingError) return reply.code(error.code).send({ message: error.message });
        throw error;
      }
    }

    if (body.data.specId && submittedDag) {
      return reply.code(400).send({ message: '规格访谈需要交给 PM 拆解，不能同时指定任务图。' });
    }
    const runId = body.data.specId ?? 'run-' + Date.now().toString(36) + '-' + randomUUID().slice(0, 8);
    if (handingOff.has(runId) || deletingRuns.has(runId)) {
      return reply.code(409).send({ message: '正在处理同一条运行，请稍后重试。' });
    }
    handingOff.add(runId);
    try {
      const existing = store.snapshot.runs[runId];
      if (existing) {
        if (existing.workspaceRoot !== workspaceRoot) {
          return reply.code(409).send({ message: '规格访谈与目标目录不匹配。' });
        }
        return deriveRunDetail(existing, runEvents(runId), resolveAgent);
      }
      const spec = body.data.specId ? await interviews.read(workspaceRoot, body.data.specId) : undefined;
      if (body.data.specId && (spec?.status !== 'ready' || !spec.spec)) {
        return reply.code(409).send({ message: '请先完成访谈并确认规格。' });
      }
      const specification = spec?.spec ?? body.data.goal;
      const settings = body.data.specSettings;
      const granularity = settings ? { coarse: '粗', medium: '中', fine: '细' }[settings.granularity] : undefined;
      const goal = settings
        ? specification + '\n\n编排设置：分解粒度 ' + granularity + '，并行上限 ' +
          (body.data.concurrency ?? 2) + '，审查轮次 ' + settings.reviewRounds + '。'
        : specification;
      const title = body.data.title.trim() || submittedDag?.title || summarizeGoal(goal, '未命名运行');
      const at = now();
      const nodes = submittedDag ? toNodeFacts(submittedDag) : [];
      const run: RunFacts = {
        id: runId,
        title,
        summary: summarizeGoal(goal, title) || submittedDag?.summary || '未命名运行',
        goal,
        workspaceRoot,
        sourceMeetingId: body.data.sourceMeetingId,
        ...(body.data.concurrency === undefined ? {} : { concurrency: body.data.concurrency }),
        specVersion: submittedDag?.specVersion ?? 'v1.0',
        ...(body.data.reviewPlan && !submittedDag ? { reviewPlan: true } : {}),
        ...(body.data.requireDeliverables || body.data.reviewPlan && !submittedDag ? { requireDeliverables: true } : {}),
        plannerAgentId: body.data.plannerAgentId,
        implementAgentId: body.data.implementAgentId,
        reviewAgentId: body.data.reviewAgentId,
        stage: submittedDag ? 'decompose' : 'orchestrate',
        createdAt: at,
        nodeOrder: nodes.map((node) => node.id),
        nodes: Object.fromEntries(nodes.map((node) => [node.id, node])),
      };
      await ownedPath(workspaceRoot, PROJECT_DATA, 'worktrees');
      await store.registerProjectRun(runId, workspaceRoot);
      await writeAtomic(await projectRunPath(workspaceRoot, runId, 'spec.md'), specification.trim() + '\n');
      if (submittedDag) await writePlan(runId, submittedDag);
      await store.emit({ type: 'run.created', at, runId, run });
      if (submittedDag) {
        await store.emit({ type: 'run.frozen', at: now(), runId });
        void advance(runId);
      } else {
        const actor = resolveActor(request.headers);
        app.log.debug({ runId, actor }, '运行已创建，转为后台拆解');
        startPlanning(runId, {
          goal,
          requestedAgentId: body.data.plannerAgentId,
          workspaceRoot,
          roles: {
            implementAgentId: body.data.implementAgentId,
            reviewAgentId: body.data.reviewAgentId,
          },
        });
      }
      return reply.code(201).send({
        ...deriveRunDetail(store.snapshot.runs[runId]!, runEvents(runId), resolveAgent),
        plan: null,
      });
    } finally {
      handingOff.delete(runId);
    }
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
   * 重试失败的节点。
   *
   * 执行阶段卡死的运行（有节点失败、也没有任何就绪节点）在事实层是 `failed`，
   * 但它跟「拆解失败」不是一回事：图是好的，只是没人能往下跑。这种运行给一个
   * 「继续」按钮没有意义——没有就绪节点可调度，点了什么都不会发生。
   *
   * 所以恢复动作是「把挂掉的节点重置回可调度状态，再推进一次」。重置会连带
   * 作废它们已经跑完的下游，这一点如实报给调用方，别让人以为只是重跑一个节点。
   */
  app.post<{ Params: { id: string } }>(
    '/api/runs/:id/retry-failed',
    async (request, reply) => {
      const runId = request.params.id;
      const run = store.snapshot.runs[runId];
      if (!run) {
        return reply.code(404).send({ error: 'run_not_found' });
      }

      const failed = Object.values(run.nodes).filter(
        (node) => node.failureReason !== undefined,
      );
      if (failed.length === 0) {
        return reply.code(409).send({
          error: 'no_failed_nodes',
          message: '这个运行没有失败的节点可重试',
        });
      }

      const finishedCount = (): number =>
        Object.values(store.snapshot.runs[runId]!.nodes).filter(
          (node) => node.finishedAt !== undefined,
        ).length;

      // 重置会连带作废失败节点已经跑完的下游，这个数量要如实报出去：
      // 用户以为「只重跑这一两个」，实际会往回退好几个节点
      const before = finishedCount();

      for (const node of failed) {
        await store.emit({
          type: 'node.reset',
          at: now(),
          runId,
          nodeId: node.id,
          reason: '重试失败节点',
        });
      }

      const invalidatedNodes = Math.max(0, before - finishedCount());

      // 重置后立刻推进：用户点这个按钮的意思就是「接着跑」
      void advance(runId);

      return {
        ok: true,
        resetNodes: failed.length,
        invalidatedNodes,
        run: deriveRunDetail(store.snapshot.runs[runId]!, runEvents(runId), resolveAgent),
      };
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
      if (run.planDraft) return { ok: true };
      if (!run.frozenAt) {
        // 还没拆完的运行要继续拆，必须知道在哪儿建 planner 的 worktree。
        // 旧数据没记目录、服务也没配默认值时就只能拒绝——猜一个目录继续跑，
        // 等于替用户决定成果落在哪。
        const planningRoot = run.workspaceRoot || defaultWorkspaceRoot;
        if (!planningRoot) {
          return reply.code(409).send({
            error: 'workspace_missing',
            message: '这个运行没有记录目标目录（旧数据），无法继续拆解，请新建一个运行',
          });
        }
        startPlanning(runId, {
          goal: currentPlanningGoal(run),
          requestedAgentId: run.plannerAgentId,
          workspaceRoot: planningRoot,
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
   * 节点级控制：单跑 / 停止 / 重置 / 对话
   *
   * 粒度细到单个节点，是因为「整轮跑完再看」和「先跑这一个看看」是两种
   * 完全不同的工作节奏。为了重跑一个节点去新建一次运行，代价是把前面
   * 所有的执行事实一起丢掉。
   *
   * 四个动作都不是「运行级」的：单跑不触发整轮推进，停止不写 run.paused，
   * 重置不动图结构，对话只落消息（在跑时额外打断并重跑这一个节点）。要动
   * 整轮，仍然走 /advance 与 /stop。
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

  /**
   * 立刻执行一次节点打断之后，等它让位的上限。
   *
   * 为什么必须等：自动重跑走的是 `runNode`，而它看到 `nodeInFlight` 里还有这个
   * 节点就会直接回「已有一条派发在跑」。不等，这条要求就变成了一句「已打断，
   * 但没重跑」——用户还得自己再点一次运行。
   *
   * 为什么不能无限等：一个不肯退出的 CLI 进程不能把用户刚下达的要求永久挂起。
   * 超时之后放弃自动重跑，回复里明说「点运行此节点」——那一步同样会带上这条
   * 要求，因为它读的是同一份事件历史。
   */
  const NODE_INTERRUPT_SETTLE_TIMEOUT_MS = 5_000;

  /** 等这个节点的派发标记被撤掉。返回是否等到了。 */
  async function settleNodeInterrupt(runId: string, nodeId: string): Promise<boolean> {
    const key = nodeInFlightKey(runId, nodeId);
    const deadline = Date.now() + NODE_INTERRUPT_SETTLE_TIMEOUT_MS;
    while (nodeInFlight.has(key)) {
      if (Date.now() >= deadline) {
        return false;
      }
      // 20ms 一拍：这里只是等一个内存标记消失，不需要更细的精度，
      // 而更密的轮询会让「一句话打断」在整个等待期里占满一个核
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 20);
      });
    }
    return true;
  }

  /**
   * 发一次取消意图，不负责它成功。
   *
   * `runner.cancel` 的返回值是**确认终止**的数量，不是结论：进程可能还没起来
   * （返回 0），可能收到了信号但还要几秒才退。所以调用方判的是「派发标记消失」
   * 这个可观测事实，而不是这个返回值。
   */
  async function cancelNodeProcess(runId: string, nodeId: string): Promise<void> {
    if (!runner.cancel) {
      return;
    }
    try {
      const cancelled = await runner.cancel({ runId, nodeId });
      if (cancelled === 0) {
        // 没有确认终止不等于停下来了：登记表里有、进程表里没有，说明还在启动
        // 路上。这条日志是排查「为什么打断慢了一拍」的唯一线索。
        app.log.debug({ runId, nodeId }, '节点打断请求没有命中任何进程');
      }
    } catch (error) {
      // 终止出错不能让整个请求失败，但也不能假装停掉了什么
      app.log.warn({ err: error, runId, nodeId }, '终止节点 Agent 时出错');
    }
  }

  /**
   * 等一条被取消的执行彻底让位，必要时补发一次取消。
   *
   * 补发是因为 `cancel` 与 `runner.run` 之间有窗口：cancel 发出去时进程可能
   * 还没登记进进程表（返回 0），那一拍之后再发一次才命中真的进程。
   */
  async function settleAfterInterrupt(runId: string, nodeId: string): Promise<boolean> {
    if (await settleNodeInterrupt(runId, nodeId)) {
      return true;
    }
    await cancelNodeProcess(runId, nodeId);
    return settleNodeInterrupt(runId, nodeId);
  }

  /** 把一句人话压成能进事件 `reason` 的短句：那条事实要出现在时间线上，不能是一整段。 */
  function briefReason(text: string): string {
    const oneLine = text.replace(/\s+/g, ' ').trim();
    return oneLine.length > 40 ? `${oneLine.slice(0, 40)}…` : oneLine;
  }

  /**
   * 对某个节点说一句话。
   *
   * 这是「节点也能被打断、也能对话」的落点，两条分支的语义在事实层完全不同，
   * 靠「这个节点现在有没有在跑」区分：
   *
   * - **在跑**：这句话是「停下手里的活，按我说的改」。所以先终止进程、再落
   *   消息、再落打断事实，最后自动重跑这个节点——新要求进提示词（见
   *   core 的 buildPrompt），Agent 真的会看到它。
   * - **没在跑**（pending / completed / failed / 等审批）：这句话是留言。
   *   只落消息，**不自动重跑**。人可能只是想先记下来、想先看看上一轮的产物，
   *   或者根本还在权衡；替他起一次执行，花的是钱和一段没人要的改动。回复里
   *   明说这条要求会在下次运行该节点时生效，不让人以为「它已经照做了」。
   *
   * 顺序不能反的地方写在各步注释里，核心只有一条：**先杀进程，再落消息**。
   * 反过来会出现「消息说打断了、进程其实还在跑」的窗口，而这个窗口里 Agent
   * 写下的每一个字都还是按旧要求来的。
   */
  app.post<{ Params: { id: string; nodeId: string } }>(
    '/api/runs/:id/nodes/:nodeId/messages',
    async (request, reply) => {
      const { id: runId, nodeId } = request.params;
      const run = store.snapshot.runs[runId];
      if (!run) {
        return reply.code(404).send({ error: 'run_not_found' });
      }
      const node = run.nodes[nodeId];
      if (!node) {
        return reply.code(404).send({ error: 'node_not_found' });
      }

      const body = nodeMessageBodySchema.safeParse(request.body);
      if (!body.success) {
        return reply.code(400).send({ error: 'invalid_body', issues: body.error.issues });
      }
      const text = body.data.text.trim();
      if (!text) {
        return reply.code(400).send({ error: 'invalid_body' });
      }

      /**
       * 「正在跑」必须在任何 await 之前判定。
       *
       * 这是个快照问题：一旦 emit 出去，事件落盘与归约要让出若干个微任务，
       * 那一刻读到的运行事实可能已经是「刚结束」。而这条消息要不要带
       * `interrupt: true` 是它自身的属性——事件写下去就改不了，靠随后补一条
       * 更正事件只会让重放多出一份需要互相解释的记录。
       */
      const running = nodeIsRunning(run, nodeId);
      /**
       * 等人工审批的节点也算「在跑」（它有 startedAt、没有 finishedAt），
       * 但它头上悬着一条审批记录，没有任何 Agent 进程。对它执行打断会把
       * `startedAt` 清掉，节点当场从「待你审批」变成「就绪」——审批还在，
       * 界面却不再问人了。所以这一类只算留言。
       */
      const awaitingApproval = deriveNodeStatus(run, node) === 'waiting_approval';
      const at = now();

      const detailOf = () =>
        deriveRunDetail(store.snapshot.runs[runId]!, runEvents(runId), resolveAgent);
      /** 这个节点此刻的会话，随响应带给前端（省掉一次往返）。 */
      const nodeConversation = () =>
        detailOf().nodeConversations[nodeId] ?? [];

      if (!running || awaitingApproval) {
        // ---- 一、没在跑：只记录，不重跑 ----
        await store.emit({
          type: 'node.message',
          at,
          runId,
          nodeId,
          role: 'user',
          text,
        });

        const replyText = awaitingApproval
          ? '已记录。这个节点正在等人工审批，不会自动重跑；审批通过后再次运行它时会带上这条要求。'
          : '已记录。这条要求会在下次运行该节点时带上它——点「运行此节点」即可。';
        await store.emit({
          type: 'node.message',
          at: now(),
          runId,
          nodeId,
          role: 'agent',
          text: replyText,
        });

        return {
          ok: true,
          // 界面据此说「这次只记下了」，而不是「这次打断了它」
          interrupted: false,
          reply: replyText,
          run: detailOf(),
          conversation: nodeConversation(),
        };
      }

      // ---- 二、在跑：打断 + 自动重跑 ----

      // 第一步：杀进程。放在落消息之前，所以「消息说打断了」这个时刻，
      // 终止意图已经发出去了。
      await cancelNodeProcess(runId, nodeId);

      // 第二步：把这句话落成事实，并标上「它打断了正在进行的执行」
      await store.emit({
        type: 'node.message',
        at: now(),
        runId,
        nodeId,
        role: 'user',
        text,
        interrupt: true,
      });

      // 第三步：落打断事实。这一步同时把 startedAt / finishedAt / failureReason
      // 清干净（见 journal 里 node.interrupted 的归约），于是这个节点回到可派发
      // 状态——没有它，下面的 runNode 会以「该节点正在执行」直接拒绝。
      //
      // 必须紧挨着消息落，不能等进程退干净再落：正在收尾的那次执行自己也会在
      // `cancelled` 分支里落一条 node.interrupted（「运行被用户停止」）。它的
      // 幂等判据是「事实里已经记过打断」——我们把事实先写下去，它就只退不再记，
      // 会话里才不会出现两条「被停止」。等它退完再写，这两条就都会落下。
      //
      // reason 带出原话：排障时要能回答「哪句话打断了这一次执行」。
      await store.emit({
        type: 'node.interrupted',
        at: now(),
        runId,
        nodeId,
        reason: `用户打断并给出了新要求：${briefReason(text)}`,
      });

      // 第四步：等那条执行彻底让位。不 await 它，重跑会撞上「已有一条派发在跑」。
      const settled = await settleAfterInterrupt(runId, nodeId);

      // 第五步：按新要求重跑。提示词会带上这条要求，所以这是「真的照做了」，
      // 不是「记下了」。没让位成功时按留言处理并说清原因。
      const rerun = settled
        ? await runNode(runId, nodeId, buildAdvanceDeps())
        : { ok: false, reason: '上一次执行还没能停下来' };

      // 重跑跑完了，下游就该接着走。
      //
      // 这一脚是必须的：`/nodes/:nodeId/run`（手动单跑）刻意不推进整轮，
      // 那是「我只想看看这个节点」；但打断对话的语义是「这一轮按新要求重来，
      // 然后继续往下」，不推进的话下游会永远卡在等它完成——用户看到的就是
      // 「说完了，图也改了，可后面不动」。
      if (rerun.ok) {
        void advance(runId);
      }

      const replyText = rerun.ok
        ? '已打断当前这轮，并按你这条要求重新开始执行。下游会接着往下走。'
        : `已打断当前这轮，但没能自动重启：${rerun.reason}。点「运行此节点」会带上这条要求。`;

      // 第六步：回执落库。与编排器对话同一约定——回复和用户消息走同一条通道，
      // 界面只有一个来源。
      await store.emit({
        type: 'node.message',
        at: now(),
        runId,
        nodeId,
        role: 'agent',
        text: replyText,
      });

      return {
        ok: true,
        interrupted: true,
        reply: replyText,
        run: detailOf(),
        conversation: nodeConversation(),
      };
    },
  );


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
   * 编排器对话：把一句话落成事实，再决定它是「改图」还是「重拆」
   * ---------------------------------------------------------------- */

  /**
   * 最近几轮编排器对话，按落盘顺序。
   *
   * 只取 `orchestrator.message`：系统行（拆解开始/失败、改图结果）是派生视图，
   * 不是人说过的话，拼进 prompt 只会让 Agent 以为有人在跟它对话。
   */
  function recentConversation(runId: string): ConversationMessage[] {
    const messages: ConversationMessage[] = [];
    for (const event of store.eventsForRun(runId)) {
      if (event.type === 'orchestrator.message') {
        messages.push(event);
      }
    }
    return messages;
  }

  /** 把编排器的一句话落成事实。回复与用户消息走同一条通道，界面只有一个来源。 */
  async function replyToConversation(runId: string, text: string): Promise<void> {
    await store.emit({
      type: 'orchestrator.message',
      at: now(),
      runId,
      role: 'orchestrator',
      text,
    });
  }

  /**
   * 与编排器对话。
   *
   * 这个接口承担两件在事实层完全不同的事，靠「这个运行有没有图」区分：
   *
   * - **还没有图**（拆解进行中，或上一次拆解失败了）：这句话的语义是「停下，
   *   按我说的重来」。那一刻没有任何图可改，拿 amendDag 去改一张空图，只会
   *   得到一句「没有需要修改的地方」——而用户真正要求的是换个方向重拆，这句
   *   回复会被读成「它没听懂」。
   * - **图已经冻结**：这句话是对那张图的修改指令，走白名单比对。
   *
   * 两条路径之前都先做同一件事：把用户这句话落成事实。不管后面成不成功，
   * 「人说过这句话」都不是结论而是已经发生的事——改图失败时用户回头还要能
   * 看见自己要求过什么。编排器的回复同样落库，否则刷新之后只剩单方面的问话。
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
      const text = body.data.text.trim();
      const at = now();

      /**
       * 这句话之前的对话，不含它自己——它马上就是这条指令的正文，再拼一遍
       * 等于让 Agent 以为自己被要求了两次。
       */
      const history = recentConversation(runId);

      /**
       * 有没有打断一次正在进行的拆解。
       *
       * 必须在落事件之前判定：`interrupt` 是这条消息自身的属性，事件一旦写下去
       * 就改不了；靠随后补一条「其实刚才打断了」的更正事件，只会让重放多出一份
       * 需要互相解释的记录。
       */
      const interrupted = planning.get(runId);
      /**
       * 这个运行还没有图。
       *
       * 两种情形都算：拆解正在进行中，或者上一次拆解就失败了。判据用
       * `frozenAt` 而不是「planning 里有没有它」——对一张还不存在的图做 amend
       * 永远只会得到「没有需要修改的地方」，而用户其实在要求换个方向重来。
       * 这条线只在「图已经冻结」时才落到改图逻辑上，与界面那句提示一致。
       */
      const noGraphYet = run.frozenAt === undefined;
      if (planControls.has(runId)) {
        return reply.code(409).send({ message: '草案正在提交，请稍后再补充。' });
      }
      if (noGraphYet) planControls.add(runId);
      try {
        /**
         * 先 abort，再落事件。
         *
         * 顺序反过来就会多出一个窗口：中间那一次磁盘写虽然只有几毫秒，却也够
         * 拆解把图冻出来——那就成了一次没有打断可言的「打断」，紧接着的重拆还会
         * 把刚生成的图整个换掉。
         */
        interrupted?.controller.abort();

        await store.emit({
          type: 'orchestrator.message',
          at,
          runId,
          role: 'user',
          text,
          ...(interrupted ? { interrupt: true } : {}),
        });

        // ---- 一、还没有图：这句话是「停下重来」 ----
        if (noGraphYet) {
          if (interrupted) {
            // abort 之后必须等它让位：见 settleAbortedPlanning 的注释
            await settleAbortedPlanning(runId, interrupted);
          }

          const planningRoot = run.workspaceRoot || defaultWorkspaceRoot;
          if (!planningRoot) {
            // 旧日志没记目标目录：猜一个目录继续跑，等于替用户决定成果落在哪
            const replyText =
              '这个运行没有记录目标目录，我没法重新拆解。请新建一个运行并选定目录。';
            await replyToConversation(runId, replyText);
            return reply.code(409).send({
              error: 'workspace_missing',
              message: replyText,
              reply: replyText,
              applied: [],
              rejected: [],
              run: deriveRunDetail(store.snapshot.runs[runId]!, runEvents(runId), resolveAgent),
            });
          }

          startPlanning(runId, {
            goal: currentPlanningGoal(run),
            requestedAgentId: run.plannerAgentId,
            workspaceRoot: planningRoot,
            roles: {
              implementAgentId: run.implementAgentId,
              reviewAgentId: run.reviewAgentId,
            },
          });

          // 两种结局都算「重来」，但对人要说清是打断了在跑的活，还是接着上一次失败
          const replyText = interrupted
            ? '已打断正在进行的拆解，并按你这条要求重新拆解。新的任务图会随事件出现在运行详情里。'
            : '已将你的补充要求并入原目标。重新拆解的结果会出现在运行详情里。';
          await replyToConversation(runId, replyText);
          return {
            ok: true,
            // 界面据此说「这次是打断了拆解」，而不是「改了一下图」
            interrupted: Boolean(interrupted),
            reply: replyText,
            applied: [],
            rejected: [],
            run: deriveRunDetail(store.snapshot.runs[runId]!, runEvents(runId), resolveAgent),
          };
        }
      } finally {
        if (noGraphYet) planControls.delete(runId);
      }

      // ---- 二、图已经冻结：这句话是对那张图的修改指令 ----
      //
      // 改图必须串行：两个并发的请求各自端着一份旧快照算 diff，后落地的
      // dag.amended 按字段覆盖，先落地那条的改动就被静默吃掉了。排队拿到
      // 名额之后**重新读快照**——前一个请求可能刚改过图。
      const releaseAmend = await acquireAmendSlot(runId);
      try {
        const current = store.snapshot.runs[runId] ?? run;
        const currentDag = dagFromFacts(current);
        // 已经产生执行事实的节点：它们不许再被改，必须让 Planner 事先知道
        const lockedNodeIds = Object.values(current.nodes)
          .filter((node) => Boolean(node.startedAt || node.finishedAt))
          .map((node) => node.id);

        let amended: AmendedPlan;
        try {
          amended = await amendDag(
            current.goal || current.title,
            currentDag,
          // 指令之前先给它前文：用户会说「刚才那个改动再收一点」，而
          // 「刚才」只在对话里存在，不在指令里
          buildAmendInstruction(
            text,
            history.map((message) => ({ role: message.role, text: message.text })),
          ),
          catalog,
          {
            runner,
            // 改图同样在运行自己的目标目录里做：它要读的是这个工程的代码
            workspace: planningWorkspace(runId, workspaceFor(current)),
            onOutput: (chunk) => {
              // 与规划同理：截断后入日志，全文会淹掉启动日志
              app.log.debug(
                { chunk: chunk.trim().slice(0, 200) },
                'amend 输出',
              );
            },
          },
          {
            agentId: current.plannerAgentId || process.env.PLANNER_AGENT_ID || undefined,
            runId,
            lockedNodeIds,
          },
        );
      } catch (error) {
        /**
         * 失败也是这个会话的一部分，必须落成一条回复。
         *
         * 否则界面上只剩用户单方面说过的话，而下一次打开面板的人会以为那句话
         * 被照办了。失败原因原样写进回复——它是人决定「换个说法还是换个 Agent」
         * 的唯一依据。
         */
        const issues = error instanceof DagGenerationError ? error.issues : [];
        const message = error instanceof Error ? error.message : String(error);
        const replyText = [
          `没能改这张图：${message}`,
          ...issues.slice(0, 3).map((issue) => `- ${issue.message}`),
        ].join('\n');
        await replyToConversation(runId, replyText);

        if (error instanceof DagGenerationError) {
          // 指令落不成图属于「内容问题」：把 issues 交给调用方去展示
          return reply.code(422).send({
            error: 'instruction_rejected',
            message,
            reply: replyText,
            issues,
            applied: [],
            rejected: [],
            run: deriveRunDetail(store.snapshot.runs[runId]!, runEvents(runId), resolveAgent),
          });
        }
        return reply.code(502).send({
          error: 'planner_failed',
          message,
          reply: replyText,
          issues: [],
          applied: [],
          rejected: [],
          run: deriveRunDetail(store.snapshot.runs[runId]!, runEvents(runId), resolveAgent),
        });
      }

      const latest = store.snapshot.runs[runId] ?? current;
      const plan = diffDag(dagFromFacts(latest), amended.dag, latest);
      if (plan.applied.length > 0) {
        const amendment: OrchestratorEvent = {
          type: 'dag.amended', at: now(), runId, actor, reason: text, changes: plan.applied,
        };
        if (latest.requireDeliverables) {
          const candidate = reduce(store.snapshot, amendment).runs[runId]!;
          const verification = validateDag(dagFromFacts(candidate), catalog, { requireDeliverables: true });
          if (!verification.ok) {
            const message = verification.issues.map((issue) => issue.message).slice(0, 4).join('。');
            await replyToConversation(runId, message);
            return reply.code(422).send({ message, reply: message, applied: [], rejected: plan.rejected });
          }
        }
        await store.emit(amendment);
        await writePlan(runId, dagFromFacts(store.snapshot.runs[runId]!)).catch(
          (error: unknown) => log.warn('无法更新任务图备份', error),
        );
        // 图变了就继续跑：新加/改过的节点应当在下一批被派发出去。
        // 但 `advance` 内部会复用已有链路，所以这里 fire-and-forget 是安全的。
        void advance(runId);
      }

      const replyText = buildAmendmentReply(plan);
      await replyToConversation(runId, replyText);

      const detail = deriveRunDetail(
        store.snapshot.runs[runId]!,
        runEvents(runId),
        resolveAgent,
      );

      return {
        ok: true,
        reply: replyText,
        applied: plan.applied,
        rejected: plan.rejected,
        run: detail,
        // 显式再给一份：只想要会话（不关心图）的调用方不必从 run 里挖
        conversation: detail.conversation,
      };
      } finally {
        // 无论成功、被拒还是抛错，名额都要还回去，否则这个运行的改图就永久卡住
        releaseAmend();
      }
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
  for (const run of Object.values(store.snapshot.runs)) activity.restore(run, store.eventsForRun(run.id));

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

  /**
   * 托管前端构建产物。
   *
   * 之前这条路根本不存在：开发时前端跑在 Vite dev server 上、由它代理 `/api`，
   * 所以「生产形态」一直是空缺的。桌面版没有 Vite 可依赖，必须由 server
   * 自己把 `index.html` 与 assets 发出去。
   *
   * 两个细节：
   * - `wildcard: false` + 兜底的 `index.html`，因为前端用的 history 路由，
   *   刷新 `/runs/xxx` 时文件系统里没有对应路径。API 请求和缺失的静态文件返回 404。
   * - 目录不存在就跳过（测试、纯 API 场景不需要它）。
   */
  const webRoot = options.webRoot ?? process.env.AGENT_WEB_DIR;
  if (webRoot && existsSync(join(webRoot, 'index.html'))) {
    await app.register(fastifyStatic, {
      root: webRoot,
      wildcard: false,
      // `/api` 与 `/events` 不是静态资源，别让通配把它们吞了
      prefix: '/',
    });
    app.setNotFoundHandler((request, reply) => {
      const pathname = (request.raw.url ?? '').split('?')[0] ?? '';
      const reserved = ['/api', '/events', '/assets'].some(
        (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
      );
      const acceptsHtml = request.headers.accept?.split(',').some(
        (type) => type.trim().split(';')[0] === 'text/html',
      );
      if ((request.method === 'GET' || request.method === 'HEAD') &&
          acceptsHtml && !reserved && !extname(pathname)) {
        return reply.sendFile('index.html');
      }
      return reply.code(404).send({ error: 'not_found', message: `找不到资源：${pathname}` });
    });
    log.debug(`静态前端：${webRoot}`);
  } else if (webRoot) {
    log.warn(`静态前端目录里没有 index.html，跳过托管：${webRoot}`);
  }

  return { app, store, getCatalog: () => catalog, lock: options.lock };
}

export { parseDag };

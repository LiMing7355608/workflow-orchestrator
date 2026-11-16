import { buildAgentArgv, type AgentProfile } from './agents.js';
import type {
  AgentRunner,
  MergeResult,
  NodeArtifact,
  WorkspacePort,
} from './execution.js';
import {
  createParser,
  type AgentEvent,
  type AgentOutputParser,
  type AgentUsage,
} from './parsers.js';
import { DEFAULT_CONCURRENCY, isRunSettled, pendingHumanWork, pickBatch } from './scheduler.js';
import { resolveSession } from './session.js';
import type {
  NodeFacts,
  OrchestratorEvent,
  ReviewVerdict,
  RunFacts,
} from './types.js';

export interface AdvanceDeps {
  getRun(runId: string): RunFacts | undefined;
  emit(event: OrchestratorEvent): Promise<void>;
  runner: AgentRunner;
  /**
   * 按运行取工作区：每个运行可能指向不同仓库，不能再是一个全局实例。
   *
   * 之前这里是 `workspace: WorkspacePort`，于是所有运行的成果都堆在启动
   * server 的那个仓库里——「先确定在哪儿干活，再开工」这个顺序被跳过了。
   *
   * 实现方应当按 `run.workspaceRoot` 缓存实例（同一个根目录复用一份），
   * 因为审批、普通路由节点这些零执行节点也会走到这条取值路径上。
   */
  workspaceFor: (run: RunFacts) => WorkspacePort;
  resolveAgent(agentId: string): AgentProfile | undefined;
  now(): string;
  concurrency?: number;
  /** 单次推进的最大轮次，防止调度循环失控 */
  maxRounds?: number;
  /**
   * 确定性会话 id 派生器，供 `session.derive: 'uuidv5'` 的平台续跑。
   *
   * 必须由宿主注入：派生要用 node:crypto，而内核要能被前端打包。
   * 不注入时 uuidv5 类平台一律降级为新跑——比让它们带着空 session 启动安全。
   */
  deriveSessionId?: (runId: string, nodeId: string) => string;
  /**
   * 排障日志。续跑判定里的「为什么没续上」不写成事件（正常降级不该刷屏），
   * 但也不该消失，因此只走这条可选通道。
   */
  log?: (msg: string, detail?: unknown) => void;
  /**
   * 把节点产物落盘，返回文件路径。
   *
   * 编排内核不碰文件系统，存哪儿由宿主决定；返回 undefined 表示
   * 存盘失败，此时事件里不带 diffPath，下游读到的是「没有 diff」。
   */
  saveArtifact?: (
    runId: string,
    nodeId: string,
    artifact: NodeArtifact,
  ) => Promise<string | undefined>;
  /**
   * 读回某节点上次落盘的 diff 文本，供审查提示词使用
   */
  loadArtifact?: (runId: string, nodeId: string) => Promise<string | undefined>;
  /**
   * 中止信号。
   *
   * 只控制「还要不要派发下一批」：`abort` 之后已经在跑的节点不会被强行
   * 打断，也不会被这里判成失败——它们的结局由 runner 的 `cancelled` 决定。
   * 编排器不越过执行层去替进程下结论，这是本层唯一的正确姿势。
   */
  signal?: AbortSignal;
  /**
   * 节点级「进行中」标记，键由 `nodeInFlightKey` 生成。
   *
   * 存在的唯一理由是：同一个节点不能有两个 Agent 进程。整轮推进与单节点运行
   * 是两条独立的调用路径，光靠节点事实挡不住——事实是在 `node.started` 落盘
   * 之后才变成 running 的，而两条路径可能在同一拍里各自读到了「还没开始」。
   *
   * 由宿主注入并持有，内核只负责在里面登记与撤销：表必须是全进程唯一的一份，
   * 内核自己 `new Set()` 出来的东西对下一次调用毫无约束力。
   */
  nodeInFlight?: Set<string>;
}

/**
 * 节点级进行中标记的键。
 *
 * 用 `runId/nodeId` 而不是只有 nodeId：不同运行里的同名节点是完全不相干的两件事，
 * 撞键会把另一个运行里正常执行的节点判成「正在跑」。
 */
export function nodeInFlightKey(runId: string, nodeId: string): string {
  return `${runId}/${nodeId}`;
}

export type AdvanceStopReason =
  | 'idle'
  | 'awaiting_human'
  | 'paused'
  | 'cancelled'
  | 'max_rounds'
  | 'missing_run';

export interface AdvanceResult {
  executed: string[];
  stopped: AdvanceStopReason;
}

/** 审查节点要靠输出末尾的裁决标记决定分支，格式在这里收敛成一处。 */
export function parseVerdict(output: string): ReviewVerdict {
  const tail = output.slice(-2000).toUpperCase();
  if (tail.includes('VERDICT: CHANGES_REQUESTED') || tail.includes('VERDICT:CHANGES_REQUESTED')) {
    return 'changes_requested';
  }
  return 'approved';
}

/**
 * 嵌进审查提示词的 diff 上限（字符数）。
 *
 * 8000 字符大约是一份中等规模改动的全量 diff。再往上贴，提示词会
 * 挤掉真正的审查要求，而 Agent 对超长输入的注意力分布本来就不均匀。
 */
const DIFF_PROMPT_LIMIT = 8000;

/** 上游节点没有可用 diff 时的降级说明，措辞要能让审查 Agent 明白原因。 */
const NO_DIFF_NOTE = '该上游节点没有产出 diff（工作区可能不是 git 仓库）。';

/**
 * 拼「被审变更」段落。
 *
 * 审查 Agent 之前只能看到标题和描述，等于在盲审；这里把上游实现节点
 * 落盘的 diff 读回来嵌进提示词，让它审的是真实改动。
 * 任何读取失败都降级成一句说明，绝不因此中断审查。
 */
async function reviewChangesSection(
  runId: string,
  upstream: NodeFacts[],
  deps: AdvanceDeps,
): Promise<string[]> {
  const implementNodes = upstream.filter((item) => item.type === 'implement');
  if (implementNodes.length === 0) {
    return [];
  }

  const lines = ['', '## 被审变更'];
  for (const item of implementNodes) {
    lines.push('', `### ${item.title}（${item.id}）`);

    let diff: string | undefined;
    try {
      diff = await deps.loadArtifact?.(runId, item.id);
    } catch {
      diff = undefined;
    }

    if (!diff || !diff.trim()) {
      lines.push(NO_DIFF_NOTE);
      continue;
    }

    if (diff.length > DIFF_PROMPT_LIMIT) {
      lines.push(
        '```diff',
        diff.slice(0, DIFF_PROMPT_LIMIT),
        '```',
        `> 注意：diff 共 ${diff.length} 字符，已截断到前 ${DIFF_PROMPT_LIMIT} 字符；`,
        '> 未展示的部分请以代码库实际状态为准，不要当作不存在。',
      );
      continue;
    }

    lines.push('```diff', diff, '```');
  }

  return lines;
}

async function buildPrompt(
  run: RunFacts,
  node: NodeFacts,
  upstream: NodeFacts[],
  deps: AdvanceDeps,
): Promise<string> {
  const lines = [
    `# 任务：${node.title}`,
    '',
    node.description,
    '',
    `## 上下文`,
    `- 运行目标：${run.goal || run.title}`,
    `- 节点类型：${node.type}`,
    `- 独占文件范围：${node.files.join(', ') || '无'}`,
  ];

  if (upstream.length > 0) {
    lines.push('', '## 上游产出');
    for (const item of upstream) {
      lines.push(`- ${item.title}（${item.id}）`);
    }
  }

  if (node.type === 'review') {
    // 变更段落紧贴在审查要求之前：读到这里时正好把手上的东西对照着判
    lines.push(...(await reviewChangesSection(run.id, upstream, deps)));
    lines.push(
      '',
      '## 审查要求',
      '只读审查，不要修改任何文件。检查正确性、边界条件与验收条件。',
      '最后一行必须给出裁决标记，二选一：',
      'VERDICT: APPROVED',
      'VERDICT: CHANGES_REQUESTED',
    );
  } else {
    lines.push(
      '',
      '## 交付要求',
      `只在下列范围内改动：${node.files.join(', ') || '整个仓库'}`,
      '完成后简要说明你做了什么。',
    );
  }

  return lines.join('\n');
}

function upstreamOf(run: RunFacts, node: NodeFacts): NodeFacts[] {
  return node.dependsOn
    .map((id) => run.nodes[id])
    .filter((item): item is NodeFacts => Boolean(item));
}

/**
 * 单条 agent.output 事件的字符上限。
 *
 * 解析后的文本事件可能是一整份文件内容或一整段总结；不截断的话，事件日志
 * 会被单条输出撑爆，重放和 SSE 都要为它付内存。2000 字符足够看清「说了什么」，
 * 完整输出仍在 AgentRunResult.output 里，裁决与失败原因读的是那一份。
 */
const OUTPUT_CHUNK_LIMIT = 2000;

/** usage 事件没有正文，拼一句人能读的摘要当作 chunk。 */
function formatUsage(usage: AgentUsage | undefined): string | undefined {
  if (!usage) {
    return undefined;
  }
  const parts: string[] = [];
  if (usage.promptTokens !== undefined) {
    parts.push(`输入 ${usage.promptTokens}`);
  }
  if (usage.completionTokens !== undefined) {
    parts.push(`输出 ${usage.completionTokens}`);
  }
  if (usage.totalTokens !== undefined) {
    parts.push(`合计 ${usage.totalTokens}`);
  }
  return parts.length > 0 ? `token 用量：${parts.join(' / ')}` : undefined;
}

/**
 * 把解析器产出的事件接到编排器的事件流上。
 *
 * 为什么不能简单 `await emit`：`onChunk` 是同步回调，它由子进程 stdout 的
 * 'data' 事件直接触发。一旦在这里 await，慢的事件日志就会反压回 Agent 进程本身，
 * 等于用日志速度限制 Agent 产出速度。所以这里只把 emit 排进一条串行队列：
 * onChunk 立刻返回，队列保证事件落盘顺序与产生顺序一致，错误则攒起来由
 * `flush` 在 Agent 结束后统一抛出——既不阻塞流，也不 fire-and-forget 到无人接管。
 */
function createEventRelay(
  deps: AdvanceDeps,
  target: {
    runId: string;
    nodeId: string;
    agentId: string;
    parserId: AgentProfile['launch']['parser'];
  },
): {
  parser: AgentOutputParser;
  forward: (events: AgentEvent[]) => void;
  flush: () => Promise<void>;
} {
  const { runId, nodeId, agentId } = target;
  const parser = createParser(target.parserId);

  // 串行队列：保证落盘顺序 == 产生顺序
  let queue: Promise<void> = Promise.resolve();
  const failures: unknown[] = [];
  // 会话 id 会在 init 与 result 里重复出现，重复入流只是噪声
  let lastSessionId: string | undefined;

  const dispatch = (event: OrchestratorEvent): void => {
    queue = queue
      .then(() => deps.emit(event))
      .catch((error: unknown) => {
        failures.push(error);
      });
  };

  const forward = (events: AgentEvent[]): void => {
    for (const item of events) {
      const at = deps.now();

      if (item.kind === 'session') {
        if (!item.sessionId || item.sessionId === lastSessionId) {
          continue;
        }
        lastSessionId = item.sessionId;
        dispatch({ type: 'agent.session', at, runId, nodeId, agentId, sessionId: item.sessionId });
        continue;
      }

      if (item.kind === 'status') {
        // 进度信号不落 agent.output：它是「进行到第几步」，不是 Agent 说的内容。
        // 只有结算那一拍带上用量时才值得记一条事实——用量是成本，不是进度。
        const usage = formatUsage(item.usage);
        if (!usage) {
          continue;
        }
        dispatch({
          type: 'agent.output',
          at,
          runId,
          nodeId,
          agentId,
          chunk: usage,
          kind: 'usage',
        });
        continue;
      }

      // 空正文不发：`{"type":"thinking","text":""}` 这类空思考块一个字都没说，
      // 落进事实就是凭空占掉时间线的一条
      const chunk = (item.text ?? item.toolName ?? formatUsage(item.usage) ?? '').trim();
      if (!chunk) {
        continue;
      }
      dispatch({
        type: 'agent.output',
        at,
        runId,
        nodeId,
        agentId,
        chunk: chunk.slice(0, OUTPUT_CHUNK_LIMIT),
        kind: item.kind,
        toolName: item.toolName,
      });
    }
  };

  const flush = async (): Promise<void> => {
    await queue;
    const first = failures.shift();
    failures.length = 0;
    if (first !== undefined) {
      // 事件落盘失败等于事实丢失。宁可让这一轮推进失败（宿主会把它记成
      // run.paused 并打日志），也不能当成什么都没发生。
      throw first;
    }
  };

  return { parser, forward, flush };
}

/**
 * 合并节点的目标分支。
 *
 * 按 run 隔离：两次不同的运行绝不能往同一个分支上堆，
 * 否则前一次运行的历史会混进后一次的集成结果里，无从区分。
 */
function integrationBranchOf(runId: string): string {
  return `run/${runId}`;
}

/**
 * 本次运行里可以参与合并的实现节点。
 *
 * 判据是「已完成且没有失败原因」而不是「跑过」：失败节点的分支上可能是
 * 半成品，合进去会把别人的正确改动连带污染。顺序取 nodeOrder，
 * 保证同一张图重放多次得到相同的合并顺序。
 */
function mergeCandidates(run: RunFacts): string[] {
  return run.nodeOrder.filter((id) => {
    const item = run.nodes[id];
    return (
      item !== undefined &&
      item.type === 'implement' &&
      Boolean(item.finishedAt) &&
      !item.failureReason
    );
  });
}

/**
 * 执行一次合并动作。
 *
 * 所有出口都是显式事件，没有「静默成功」这条路：
 * 没有 merge 能力、没有可合并节点、合并冲突、git 报错，四种情况
 * 各自落到 node.failed 上并写清原因。工作区缺 merge 方法时尤其不能
 * 假装成功——那会让运行看起来合完了，而集成分支其实根本不存在。
 */
async function executeMerge(
  runId: string,
  node: NodeFacts,
  run: RunFacts,
  deps: AdvanceDeps,
  workspace: WorkspacePort,
): Promise<void> {
  const targetBranch = integrationBranchOf(runId);

  const merge = workspace.merge?.bind(workspace);
  if (!merge) {
    await deps.emit({
      type: 'node.failed',
      at: deps.now(),
      runId,
      nodeId: node.id,
      reason: '当前工作区不支持合并：临时目录工作区没有版本历史，节点改动无法汇入集成分支',
    });
    return;
  }

  const nodeIds = mergeCandidates(run);
  if (nodeIds.length === 0) {
    // 没有上游改动可合并不等于「合成功了」。这种情况多半是图写错了
    // （合并节点没声明 dependsOn），必须报出来而不是悄悄放行。
    await deps.emit({
      type: 'node.failed',
      at: deps.now(),
      runId,
      nodeId: node.id,
      reason: '没有可合并的已完成实现节点：检查合并节点是否声明了 dependsOn',
    });
    return;
  }

  let result: MergeResult;
  try {
    result = await merge({ runId, nodeIds, targetBranch });
  } catch (error) {
    // 端口约定实现方不抛异常，但宿主实现可能违约。
    // 这里兜住，让它变成一条可读的失败事实，而不是打崩整轮推进。
    await deps.emit({
      type: 'node.failed',
      at: deps.now(),
      runId,
      nodeId: node.id,
      reason: `合并执行失败：${(error as Error).message}`,
    });
    return;
  }

  if (result.ok) {
    await deps.emit({
      type: 'node.merged',
      at: deps.now(),
      runId,
      nodeId: node.id,
      branch: result.branch,
      merged: result.merged,
    });
    await deps.emit({ type: 'node.completed', at: deps.now(), runId, nodeId: node.id });
    return;
  }

  await deps.emit({
    type: 'node.merge_conflict',
    at: deps.now(),
    runId,
    nodeId: node.id,
    branch: result.branch,
    conflicts: result.conflicts,
    reason: result.reason,
  });

  // 冲突不是「什么都没发生」：已经合进去的那些节点确实进了目标分支，
  // 必须和冲突一起报，否则重试时无法判断该重合哪些。
  const detail =
    result.conflicts.length > 0
      ? `冲突文件：${result.conflicts.join('、')}`
      : result.reason;
  const done =
    result.merged.length > 0 ? `；已合并 ${result.merged.length} 个节点：${result.merged.join('、')}` : '';
  await deps.emit({
    type: 'node.failed',
    at: deps.now(),
    runId,
    nodeId: node.id,
    reason: `${result.conflicts.length > 0 ? '合并冲突' : '合并失败'}（${result.branch}），${detail}${done}`,
  });
}

/**
 * 一个节点的执行结局，从调度角度唯一有意义的那一维。
 *
 * 只区分「这一轮是不是被外部终止了」：失败不需要回报给调度器（失败事实
 * 已经落在事件里，节点自然不会被再次挑中），而被终止的节点会回到就绪集合，
 * 调度器必须知道「不要再往下派了」。
 */
type NodeOutcome = 'interrupted' | undefined;

async function executeNode(
  runId: string,
  node: NodeFacts,
  deps: AdvanceDeps,
): Promise<NodeOutcome> {
  // 中止后不再开始任何新节点：连审批记录都不补。
  //
  // 为什么静默返回而不是发一条 node.failed：这个节点根本没执行过，把它
  // 记成失败是在伪造事实。真正的终止事实由宿主写成 run.paused，已经在跑的
  // 那几个节点各自按 runner 的结局收尾。
  if (deps.signal?.aborted) {
    return;
  }

  const run = deps.getRun(runId);
  if (!run) {
    return;
  }

  /**
   * 工作区在这一刻按运行取定。
   *
   * 目标仓库在 `run.created` 时就写进事实了，同一个运行里的所有节点共用它；
   * 不同运行之间绝不能共用——共用等于让 A 的产物落进 B 的仓库。
   * 取一次而不是每次调用都取：这一轮执行里 prepare / capture / release
   * 必须是同一个实例，否则产物会被采集到另一个目录上。
   */
  const workspace = deps.workspaceFor(run);

  // 审批节点：写一条待审批记录就退出，绝不阻塞进程
  if (node.type === 'approval') {
    const at = deps.now();
    await deps.emit({
      type: 'approval.requested',
      at,
      runId,
      record: {
        id: `ap-${node.id}-${Date.parse(at)}`,
        runId,
        nodeId: node.id,
        status: 'pending',
        requestedAt: at,
      },
    });
    return;
  }

  // 路由节点本身没有 Agent，只有声明了 action 的才真干活
  if (node.type === 'route') {
    await deps.emit({ type: 'node.started', at: deps.now(), runId, nodeId: node.id });
    if (node.action === 'merge') {
      await executeMerge(runId, node, run, deps, workspace);
      return;
    }
    // 普通路由节点：纯逻辑、零副作用，直接完成
    await deps.emit({
      type: 'node.completed',
      at: deps.now(),
      runId,
      nodeId: node.id,
    });
    return;
  }

  const agent = deps.resolveAgent(node.agentId ?? '');
  if (!agent) {
    await deps.emit({
      type: 'node.failed',
      at: deps.now(),
      runId,
      nodeId: node.id,
      reason: `找不到可用的 Agent：${node.agentId ?? '(未指定)'}`,
    });
    return;
  }

  // 审查节点必须用最保守的权限档位
  const policy = node.type === 'review' ? 'default' : 'accept-edits';
  const prompt = await buildPrompt(run, node, upstreamOf(run, node), deps);

  // 续跑判定只能在这里做：此刻 node 是「这一轮」的事实快照，
  // attempts 已经反映了被退回的次数，nativeSessionId 也已经是上一轮捕获到的值。
  const deriveId = deps.deriveSessionId;
  const session = resolveSession(agent, node, deriveId, runId);

  if (session.resumable && session.sessionId) {
    // 先落一条「复用会话」事实再启动：CLI 一旦起来，看板就该能解释
    // 这一轮的上下文是接来的还是新开的
    await deps.emit({
      type: 'node.resumed_session',
      at: deps.now(),
      runId,
      nodeId: node.id,
      agentId: agent.id,
      sessionId: session.sessionId,
      reason: agent.session.derive === 'uuidv5' ? '确定性派生' : '沿用捕获的原生会话',
    });
  } else if (session.reason) {
    // 不续跑是常态（首次执行、回放无 hook 拿不到 id），写成事件只会刷屏，
    // 但排障时又必须能回答「这次为什么没接上」，所以只进日志。
    deps.log?.(`节点 ${node.id} 不续跑：${session.reason}`, {
      runId,
      nodeId: node.id,
      agentId: agent.id,
      reason: session.reason,
    });
  }

  let cwd: string;
  try {
    cwd = await workspace.prepare(runId, node.id);
  } catch (error) {
    await deps.emit({
      type: 'node.failed',
      at: deps.now(),
      runId,
      nodeId: node.id,
      reason: `工作区准备失败：${(error as Error).message}`,
    });
    return;
  }

  await deps.emit({ type: 'node.started', at: deps.now(), runId, nodeId: node.id });

  const argv = buildAgentArgv(agent, {
    prompt,
    workdir: cwd,
    policy,
    session: session.resumable ? session.sessionId : session.plannedSessionId,
    resume: session.resumable,
  });

  // profile 里声明的 parser 就是「这台 CLI 的输出怎么读」的唯一事实源。
  // 解析器与事件转发在启动前后建好，Agent 一开口就能按结构入流。
  const relay = createEventRelay(deps, {
    runId,
    nodeId: node.id,
    agentId: agent.id,
    parserId: agent.launch.parser,
  });

  const result = await deps.runner.run(
    {
      runId,
      nodeId: node.id,
      agentId: agent.id,
      bin: agent.launch.bin,
      argv,
      stdin: agent.launch.stdin ? prompt : undefined,
      cwd,
      timeoutMs: agent.timeoutMs,
      policy,
    },
    (chunk) => {
      // 同步回调里只做解析与排队，绝不 await（理由见 createEventRelay）
      relay.forward(relay.parser.push(chunk));
    },
  );

  // 收尾：冲掉缓冲区里不完整的行，再把排队的事件全部落盘。
  // 必须放在失败判定之前——超时或非零退出时，Agent 最后说的话往往正是线索。
  relay.forward(relay.parser.finish());
  await relay.flush();

  if (!result.ok) {
    // 被用户停下 ≠ 执行失败，两者必须落成不同的事件。
    //
    // 执行层给出的 `cancelled` 说的是「这个进程是人让我停的」，不是「这件事做砸了」。
    // 把它记成 node.failed 的后果是实证过的：节点停在失败状态，就绪集合永远
    // 挑不到它，用户点「继续」也续不上，只能新建一个运行——一条本该可恢复的
    // 中断，被写成了一次需要人介入的失败。
    //
    // 所以这里只问一件事：是人让它停的，还是它自己没跑成。
    if (result.cancelled) {
      // 幂等：节点级停止接口会抢先把这条事实落下去（否则界面在进程退出前
      // 一直显示运行中）。这里据当前事实判断，已经记过就不再记第二遍。
      const current = deps.getRun(runId)?.nodes[node.id];
      const alreadyInterrupted =
        current !== undefined &&
        current.interruptedAt !== undefined &&
        current.startedAt === undefined;

      if (!alreadyInterrupted) {
        await deps.emit({
          type: 'node.interrupted',
          at: deps.now(),
          runId,
          nodeId: node.id,
          reason: '运行被用户停止',
        });
      }
      await workspace.release(runId, node.id).catch(() => {});
      return 'interrupted';
    }

    await deps.emit({
      type: 'node.failed',
      at: deps.now(),
      runId,
      nodeId: node.id,
      // 超时与普通非零退出必须分开措辞：前者是 Agent 自己没跑完，
      // 后者是它跑完了但报错，用户看到的下一步动作完全不同。
      reason: result.timedOut
        ? `Agent 超时（${Math.round(agent.timeoutMs / 1000)} 秒）`
        : result.error ?? `退出码 ${result.exitCode ?? '未知'}`,
    });
    await workspace.release(runId, node.id).catch(() => {});
    return;
  }

  if (node.type === 'review') {
    const verdict = parseVerdict(result.output);
    await deps.emit({ type: 'review.verdict', at: deps.now(), runId, nodeId: node.id, verdict });

    // 先给审查节点本身落完成事实，再决定要不要回退。
    // 顺序反过来的话，回退传播时它还没完成，不会被一并作废，
    // 结果就是上游重跑完了却再也不会重审。
    await deps.emit({ type: 'node.completed', at: deps.now(), runId, nodeId: node.id });
    await workspace.release(runId, node.id).catch(() => {});

    if (verdict === 'changes_requested') {
      const attempt = node.attempts + 1;
      if (attempt > node.maxAttempts) {
        // 回退次数用尽，交给人决定继续回修还是接受现状
        await deps.emit({
          type: 'review.escalated',
          at: deps.now(),
          runId,
          nodeId: node.id,
        });
        return;
      }
      const target = node.dependsOn[0];
      if (target) {
        await deps.emit({
          type: 'node.reset',
          at: deps.now(),
          runId,
          nodeId: target,
          reason: `审查驳回（第 ${attempt} 次）`,
        });
      }
    }
    return;
  }

  await deps.emit({ type: 'node.completed', at: deps.now(), runId, nodeId: node.id });

  // 实现节点的产物要在 release 之前采集——工作区一释放，
  // 那条分支和目录就没了，diff 再也拿不回来。
  // 采集/存盘失败只意味着下游看不到 diff，不影响本次执行的成功判定。
  if (node.type === 'implement') {
    await captureArtifact(runId, node.id, workspace, deps);
  }

  await workspace.release(runId, node.id).catch(() => {});
}

/**
 * 单节点执行，把调度器才需要的那一维结局丢掉。
 *
 * 对外暴露的是这个薄壳而不是 `executeNode` 本身：`NodeOutcome` 回答的是
 * 「这一批里有没有节点被打断、还要不要往下派」，单跑路径没有下一批可派，
 * 把那个维度透出去只会诱使调用方去猜调度语义。
 */
export async function runSingleNode(
  runId: string,
  node: NodeFacts,
  deps: AdvanceDeps,
): Promise<void> {
  await executeNode(runId, node, deps);
}

/** 单节点运行的结果。失败时 `reason` 是给人看的一句解释，不是错误码。 */
export interface RunNodeResult {
  ok: boolean;
  reason?: string;
}

/**
 * 跑一个节点，不等整轮编排。
 *
 * 三条语义，都是刻意的：
 *
 * 1. **不检查依赖**。用户显式点「运行此节点」就是要求覆盖调度顺序；依赖检查
 *    是调度器（`pickBatch`）的职责，不是执行器的。在这里补一道依赖闸门，
 *    等于让「上游还卡着但我就要先跑这一个」这件事永远做不到。
 * 2. **拒绝的判据是「这一轮还没结算完」，不是「跑过」**。已经开始且有
 *    `finishedAt` 的节点（失败或完成）允许再跑一次——重跑一个失败节点正是
 *    这个入口存在的理由。而 `node.failed` 也会写 `startedAt`，所以按
 *    「有 startedAt 就拒绝」写，会把最常见的重跑场景一起挡死。
 * 3. **互斥落在 `nodeInFlight` 上**。检查和登记之间没有任何 await，
 *    因此同一拍里的两个请求必然一胜一负；命中即返回失败，由调用方翻成 409。
 *    这张表由宿主注入，整轮推进共用同一份，见 `AdvanceDeps.nodeInFlight`。
 */
export async function runNode(
  runId: string,
  nodeId: string,
  deps: AdvanceDeps,
): Promise<RunNodeResult> {
  const run = deps.getRun(runId);
  if (!run) {
    return { ok: false, reason: `运行不存在：${runId}` };
  }

  const node = run.nodes[nodeId];
  if (!node) {
    return { ok: false, reason: `节点不存在：${nodeId}` };
  }

  if (node.startedAt !== undefined && node.finishedAt === undefined) {
    return { ok: false, reason: '该节点正在执行，等这一次结束再来' };
  }

  const key = nodeInFlightKey(runId, nodeId);
  if (deps.nodeInFlight?.has(key)) {
    return { ok: false, reason: '该节点正在执行（已有一条派发在跑）' };
  }

  deps.nodeInFlight?.add(key);
  try {
    // node 是调用时刻的事实快照，与整轮推进里派发出去的那份同源：
    // 会话续跑与提示词都读它，单跑不该看到另一套上下文。
    await executeNode(runId, node, deps);
  } finally {
    // 必须放 finally：执行层抛错时若不撤销标记，这个节点会永远被判成
    // 「正在执行」，从此既跑不了也重置不了。
    deps.nodeInFlight?.delete(key);
  }

  return { ok: true };
}

/**
 * 采集产物 → 落盘 → 发事实。
 *
 * 三步都可以失败，且失败互不牵连：工作区不是 git 就没有 capture，
 * 存盘失败就没有 diffPath，无论哪种，bytes / files 仍会如实入账，
 * 看板至少能看到这次执行到底动了多少东西。
 */
async function captureArtifact(
  runId: string,
  nodeId: string,
  workspace: WorkspacePort,
  deps: AdvanceDeps,
): Promise<void> {
  if (!workspace.capture) {
    return;
  }

  let artifact: NodeArtifact;
  try {
    artifact = await workspace.capture(runId, nodeId);
  } catch {
    return;
  }

  let diffPath: string | undefined;
  if (deps.saveArtifact) {
    try {
      diffPath = await deps.saveArtifact(runId, nodeId, artifact);
    } catch {
      diffPath = undefined;
    }
  }

  await deps.emit({
    type: 'node.artifact',
    at: deps.now(),
    runId,
    nodeId,
    bytes: artifact.bytes,
    files: artifact.files,
    diffPath,
  });
}

/**
 * 推进一次运行：反复取就绪批次执行，直到没有可跑的节点、
 * 或者停下来等人（审批 / 审查升级）。
 *
 * 工作区不在这里选：每个节点执行时按它所属的运行取（`deps.workspaceFor`）。
 * 同一批里可能混着不同运行的节点，任何「整轮共用一个工作区」的写法都会
 * 把别人的产物写进另一个仓库。
 */
export async function advanceRun(
  runId: string,
  deps: AdvanceDeps,
): Promise<AdvanceResult> {
  const executed: string[] = [];
  const maxRounds = deps.maxRounds ?? 50;
  let round = 0;

  while (round < maxRounds) {
    round += 1;

    // 中止优先于一切：连状态判断都不做，直接退出。
    // 放在循环顶部是必须的——批次执行完才 abort 的情况下，如果不在这里
    // 检查，下一轮会照样把新一批节点派发出去，等于「停止」慢一拍。
    //
    // 这里只拦「还要不要派发」：上一批已经发出去的 executeNode 仍会跑到结算，
    // 并按 runner 的结局各自落 node.interrupted（而不是 node.failed）。那些
    // 事件会把节点重新交回就绪集合，这正是「继续」能接着跑的前提。
    if (deps.signal?.aborted) {
      return { executed, stopped: 'cancelled' };
    }

    const run = deps.getRun(runId);
    if (!run) {
      return { executed, stopped: 'missing_run' };
    }
    if (!run.frozenAt) {
      return { executed, stopped: 'idle' };
    }
    if (run.pausedAt) {
      return { executed, stopped: 'paused' };
    }

    // 已经被单节点运行占住的节点不进这一批。
    //
    // 单跑登记的标记早于它那一条 `node.started` 落盘，而这一轮读到的 run
    // 是新事实之前的那份快照，因此「就绪」里可能还留着它。不在这里筛掉，
    // 同一节点就会各起一个进程，两边的结局互相覆盖。
    const batch = pickBatch(run, deps.concurrency ?? DEFAULT_CONCURRENCY).filter(
      (node) => !deps.nodeInFlight?.has(nodeInFlightKey(runId, node.id)),
    );
    if (batch.length === 0) {
      const waiting = pendingHumanWork(run);
      if (waiting.length > 0) {
        return { executed, stopped: 'awaiting_human' };
      }
      // 没有可跑的、也没有人等：整张图跑完了，落一条完成事实
      if (isRunSettled(run) && !run.completedAt) {
        await deps.emit({ type: 'run.completed', at: deps.now(), runId });
      }
      return { executed, stopped: 'idle' };
    }

    const outcomes = await Promise.all(
      batch.map((node) => executeNode(runId, node, deps)),
    );
    executed.push(...batch.map((node) => node.id));

    // 这一批里有节点是被外部终止的：停在这里。
    //
    // 不能直接进下一轮。被打断的节点落的是 node.interrupted，它在投影层已经
    // 回到 ready（否则「继续」调度不到它），因此下一轮立刻又会把它挑出来，
    // 而执行层的终止意图还在——那会变成一路重跑到 maxRounds 的空转。
    // 「停」的意图可能来自 abort 信号，也可能直接来自执行层（进程被外部杀掉），
    // 两种在调度上都是同一件事：这一轮不再往下派。
    if (outcomes.includes('interrupted')) {
      return { executed, stopped: 'cancelled' };
    }
  }

  return { executed, stopped: 'max_rounds' };
}

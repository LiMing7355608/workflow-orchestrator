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
  workspace: WorkspacePort;
  resolveAgent(agentId: string): AgentProfile | undefined;
  now(): string;
  concurrency?: number;
  /** 单次推进的最大轮次，防止调度循环失控 */
  maxRounds?: number;
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
  /** 读回某节点上次落盘的 diff 文本，供审查提示词使用 */
  loadArtifact?: (runId: string, nodeId: string) => Promise<string | undefined>;
}

export type AdvanceStopReason =
  | 'idle'
  | 'awaiting_human'
  | 'paused'
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
): Promise<void> {
  const targetBranch = integrationBranchOf(runId);

  const merge = deps.workspace.merge?.bind(deps.workspace);
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

async function executeNode(
  runId: string,
  node: NodeFacts,
  deps: AdvanceDeps,
): Promise<void> {
  const run = deps.getRun(runId);
  if (!run) {
    return;
  }

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
      await executeMerge(runId, node, run, deps);
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

  let cwd: string;
  try {
    cwd = await deps.workspace.prepare(runId, node.id);
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

  const argv = buildAgentArgv(agent, { prompt, workdir: cwd, policy });

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
    await deps.emit({
      type: 'node.failed',
      at: deps.now(),
      runId,
      nodeId: node.id,
      reason: result.timedOut
        ? `Agent 超时（${Math.round(agent.timeoutMs / 1000)} 秒）`
        : result.error ?? `退出码 ${result.exitCode ?? '未知'}`,
    });
    await deps.workspace.release(runId, node.id).catch(() => {});
    return;
  }

  if (node.type === 'review') {
    const verdict = parseVerdict(result.output);
    await deps.emit({ type: 'review.verdict', at: deps.now(), runId, nodeId: node.id, verdict });

    // 先给审查节点本身落完成事实，再决定要不要回退。
    // 顺序反过来的话，回退传播时它还没完成，不会被一并作废，
    // 结果就是上游重跑完了却再也不会重审。
    await deps.emit({ type: 'node.completed', at: deps.now(), runId, nodeId: node.id });
    await deps.workspace.release(runId, node.id).catch(() => {});

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
    await captureArtifact(runId, node.id, deps);
  }

  await deps.workspace.release(runId, node.id).catch(() => {});
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
  deps: AdvanceDeps,
): Promise<void> {
  if (!deps.workspace.capture) {
    return;
  }

  let artifact: NodeArtifact;
  try {
    artifact = await deps.workspace.capture(runId, nodeId);
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

    const batch = pickBatch(run, deps.concurrency ?? DEFAULT_CONCURRENCY);
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

    await Promise.all(batch.map((node) => executeNode(runId, node, deps)));
    executed.push(...batch.map((node) => node.id));
  }

  return { executed, stopped: 'max_rounds' };
}

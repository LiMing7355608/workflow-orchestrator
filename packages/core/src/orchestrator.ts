import { buildAgentArgv, type AgentProfile } from './agents.js';
import type { AgentRunner, WorkspacePort } from './execution.js';
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

function buildPrompt(run: RunFacts, node: NodeFacts, upstream: NodeFacts[]): string {
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

  // 路由节点：纯逻辑，无副作用
  if (node.type === 'route') {
    await deps.emit({ type: 'node.started', at: deps.now(), runId, nodeId: node.id });
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
  const prompt = buildPrompt(run, node, upstreamOf(run, node));

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
      const text = chunk.trim();
      if (text) {
        void deps.emit({
          type: 'agent.output',
          at: deps.now(),
          runId,
          nodeId: node.id,
          agentId: agent.id,
          chunk: text.slice(0, 2000),
        });
      }
    },
  );

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
  await deps.workspace.release(runId, node.id).catch(() => {});
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

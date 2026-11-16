import type { OrchestratorEvent, ProjectState, RunFacts } from './types.js';

export function emptyState(): ProjectState {
  return { runs: {}, approvals: [] };
}

/** 浅拷贝一层 run 再改，保证 reduce 是纯函数。 */
function withRun(
  state: ProjectState,
  runId: string,
  mutate: (run: RunFacts) => void,
): ProjectState {
  const run = state.runs[runId];
  if (!run) {
    return state;
  }
  const next: RunFacts = { ...run, nodes: { ...run.nodes } };
  mutate(next);
  return { ...state, runs: { ...state.runs, [runId]: next } };
}

function withNode(
  state: ProjectState,
  runId: string,
  nodeId: string,
  mutate: (node: RunFacts['nodes'][string]) => void,
): ProjectState {
  return withRun(state, runId, (run) => {
    const node = run.nodes[nodeId];
    if (!node) {
      return;
    }
    const next = { ...node };
    mutate(next);
    run.nodes[nodeId] = next;
  });
}

/** 找到某个节点的全部下游（传递闭包）。 */
function downstreamIds(run: RunFacts, nodeId: string): string[] {
  const seen = new Set<string>();
  const queue = [nodeId];
  while (queue.length > 0) {
    const current = queue.shift();
    if (current === undefined) {
      break;
    }
    for (const id of run.nodeOrder) {
      const node = run.nodes[id];
      if (!node || seen.has(id)) {
        continue;
      }
      if (node.dependsOn.includes(current)) {
        seen.add(id);
        queue.push(id);
      }
    }
  }
  return [...seen];
}

/**
 * 退回重做：重置目标节点，并把已跑完的下游一并作废。
 *
 * 这一步是「回退不改变图结构」的关键——边集永远不动，
 * 只有事实被清空重新累积，因此 DAG 始终保持无环。
 */
function resetNode(run: RunFacts, nodeId: string): void {
  const node = run.nodes[nodeId];
  if (!node) {
    return;
  }
  node.startedAt = undefined;
  node.finishedAt = undefined;
  node.verdict = undefined;
  node.failureReason = undefined;
  // 旧产物随重做一并作废：留着上一轮的 diff 统计，
  // 看板会显示一份已经不存在的变更。
  node.artifactBytes = undefined;
  node.artifactFiles = undefined;
  node.attempts += 1;

  for (const id of downstreamIds(run, nodeId)) {
    const downstream = run.nodes[id];
    if (!downstream || !downstream.finishedAt) {
      continue;
    }
    downstream.startedAt = undefined;
    downstream.finishedAt = undefined;
    downstream.verdict = undefined;
    downstream.failureReason = undefined;
    downstream.artifactBytes = undefined;
    downstream.artifactFiles = undefined;
  }
}

/**
 * 事件的唯一投影入口。所有状态变化都必须经过这里，
 * 时间戳一律来自事件自身的 `at`，投影过程不生成任何新时间。
 */
export function reduce(
  state: ProjectState,
  event: OrchestratorEvent,
): ProjectState {
  switch (event.type) {
    case 'run.created':
      return {
        ...state,
        runs: { ...state.runs, [event.run.id]: event.run },
      };

    case 'run.frozen':
      return withRun(state, event.runId, (run) => {
        run.frozenAt = event.at;
        run.stage = 'execute';
      });

    case 'run.paused':
      return withRun(state, event.runId, (run) => {
        run.pausedAt = event.at;
      });

    case 'run.resumed':
      return withRun(state, event.runId, (run) => {
        run.pausedAt = undefined;
      });

    case 'run.completed':
      return withRun(state, event.runId, (run) => {
        run.completedAt = event.at;
      });

    case 'node.started':
      return withNode(state, event.runId, event.nodeId, (node) => {
        node.startedAt = event.at;
        node.finishedAt = undefined;
        node.failureReason = undefined;
      });

    case 'node.completed':
      return withNode(state, event.runId, event.nodeId, (node) => {
        node.finishedAt = event.at;
        node.failureReason = undefined;
      });

    case 'node.failed':
      return withNode(state, event.runId, event.nodeId, (node) => {
        node.failureReason = event.reason;
        node.startedAt = node.startedAt ?? event.at;
        node.finishedAt = event.at;
      });

    case 'node.reset':
      return withRun(state, event.runId, (run) => {
        resetNode(run, event.nodeId);
      });

    case 'review.verdict':
      return withNode(state, event.runId, event.nodeId, (node) => {
        node.verdict = event.verdict;
        node.finishedAt = node.finishedAt ?? event.at;
        // 审查节点的 attempts 记的是「驳回过几次」，用于回退次数上限
        if (event.verdict === 'changes_requested') {
          node.attempts += 1;
        }
      });

    case 'review.escalated':
      return withNode(state, event.runId, event.nodeId, (node) => {
        node.escalated = true;
      });

    case 'approval.requested':
      return withNode(state, event.runId, event.record.nodeId, (node) => {
        node.startedAt = node.startedAt ?? event.at;
      });
    // 审批记录本身在下面的分支追加，这里只记节点事实。

    case 'approval.decided': {
      const approvals = state.approvals.map((record) =>
        record.id === event.approvalId
          ? {
              ...record,
              status:
                event.decision === 'approve'
                  ? ('approved' as const)
                  : event.decision === 'reject'
                    ? ('rejected' as const)
                    : ('handed_off' as const),
              actor: event.actor,
              reason: event.reason,
              decidedAt: event.at,
            }
          : record,
      );
      return { ...state, approvals };
    }

    case 'agent.output':
      // 输出走事件流，不改变任何事实。
      return state;

    case 'node.artifact':
      // 产物只统计量入事实，不改变节点状态机：采集成功与否
      // 都不该影响「这个节点是否完成」，否则一次 git 抖动就能
      // 把已完成的节点改判成失败。
      return withNode(state, event.runId, event.nodeId, (node) => {
        node.artifactBytes = event.bytes;
        node.artifactFiles = event.files;
      });

    default:
      return state;
  }
}

/** `approval.requested` 需要同时追加记录与写节点事实，单独处理。 */
function apply(state: ProjectState, event: OrchestratorEvent): ProjectState {
  const next = reduce(state, event);
  if (event.type === 'approval.requested') {
    return { ...next, approvals: [...next.approvals, event.record] };
  }
  return next;
}

export function replay(events: OrchestratorEvent[]): ProjectState {
  return events.reduce(apply, emptyState());
}

/* ------------------------------------------------------------------ *
 * 事件总线：CDC 的降级版。编排层只发布，看板只订阅。
 * ------------------------------------------------------------------ */

export type EventListener = (event: OrchestratorEvent) => void;

export class EventBus {
  private readonly listeners = new Set<EventListener>();

  subscribe(listener: EventListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  publish(event: OrchestratorEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // 单个订阅者出错不能拖垮编排器
      }
    }
  }
}

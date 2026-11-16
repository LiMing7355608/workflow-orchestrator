import type {
  DagAmendment,
  OrchestratorEvent,
  ProjectState,
  RunFacts,
} from './types.js';

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

/**
 * 读出运行的目标目录，旧日志缺字段时压成空串。
 *
 * `workspaceRoot` 是后加的事实字段：早期 journal 里的 `run.created` 没有它，
 * 从磁盘解析出来是 `undefined`，而类型声明说是 `string`——不在这里收敛，
 * 那个 undefined 会一路漂到 `resolve()` 与缓存键上，表现为「历史运行一继续
 * 就崩」。空串是刻意选的哨兵值：它不可能是合法路径，读取侧（服务端的工作区
 * 分派）据此回落到默认根目录。
 */
function workspaceRootOf(run: RunFacts): string {
  return typeof run.workspaceRoot === 'string' ? run.workspaceRoot : '';
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
  // 退回重做之后「已停止」不再成立：这一轮的打断记录属于上一次执行事实
  node.interruptedAt = undefined;
  // 旧产物随重做一并作废：留着上一轮的 diff 统计，
  // 看板会显示一份已经不存在的变更。
  node.artifactBytes = undefined;
  node.artifactFiles = undefined;
  // 合并结果随重做一并作废：留着上一次的分支名，看板会声称改动已在
  // 集成分支上，而重跑出来的那一版其实还没合。
  node.mergedBranch = undefined;
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
    downstream.mergedBranch = undefined;
  }
}

/**
 * 把一次 `dag.amended` 的改动落到节点事实上。
 *
 * 这里刻意只认白名单字段（agentId / title / description / files / maxAttempts）：
 * 事件里的 `node` 是服务端算出来的新事实，但投影层不为它背书——一个越权的
 * 生产者也改不动 dependsOn、type 与执行事实（startedAt / attempts / verdict）。
 * 「谁能改什么」因此只有一处判据，而且是可重放的判据。
 *
 * 返回结构上的新数组/对象：reduce 是纯函数，就地改会让上一次投影出来的快照
 * 跟着一起变，界面回退时就再也看不到改动前的图了。
 */
function applyAmendments(run: RunFacts, amendments: DagAmendment[]): void {
  for (const amendment of amendments) {
    if (amendment.kind === 'add-node') {
      const added = amendment.node;
      // 没有节点事实的 add-node 是无效记账：不猜它想加什么
      if (!added || run.nodes[amendment.nodeId]) {
        continue;
      }
      run.nodes[amendment.nodeId] = { ...added };
      // 追加到末尾而不是插到中间：nodeOrder 的既有前缀代表「已经发生过的顺序」，
      // 新加进来的节点在时间上本来就排在最后。
      run.nodeOrder = [...run.nodeOrder, amendment.nodeId];
      continue;
    }

    if (amendment.kind === 'remove-node') {
      if (!run.nodes[amendment.nodeId]) {
        continue;
      }
      delete run.nodes[amendment.nodeId];
      run.nodeOrder = run.nodeOrder.filter((id) => id !== amendment.nodeId);
      continue;
    }

    const current = run.nodes[amendment.nodeId];
    const updated = amendment.node;
    if (!current || !updated) {
      continue;
    }
    run.nodes[amendment.nodeId] = {
      ...current,
      title: updated.title,
      description: updated.description,
      files: updated.files,
      agentId: updated.agentId,
      maxAttempts: updated.maxAttempts,
    };
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
      /**
       * `workspaceRoot` 在这里归一化，而不是让每个读取方自己判空。
       *
       * 归约是唯一的事实入口：把兼容逻辑放在这一天，重放旧日志、从磁盘恢复、
       * 新写入三条路径都会得到同一个形状；放在读取侧则要保证每个调用点都记得判。
       */
      return {
        ...state,
        runs: {
          ...state.runs,
          [event.run.id]: {
            ...event.run,
            workspaceRoot: workspaceRootOf(event.run),
          },
        },
      };

    case 'run.frozen':
      return withRun(state, event.runId, (run) => {
        /**
         * 节点图随冻结事件一起落地——这是异步拆解唯一的交付物。
         *
         * 深拷贝一层是必须的：投影之后 `resetNode` 会就地改写节点事实，而
         * 事件对象还留在 journal 的内存数组里。共用引用等于让后来的重置去
         * 篡改一条历史事件，重放时同一份日志会得出不同的结果。
         */
        if (event.nodes && event.nodes.length > 0) {
          run.nodeOrder = event.nodes.map((node) => node.id);
          run.nodes = Object.fromEntries(
            event.nodes.map((node) => [
              node.id,
              { ...node, dependsOn: [...node.dependsOn], files: [...node.files] },
            ]),
          );
        }
        run.frozenAt = event.at;
        run.stage = 'execute';
      });

    case 'plan.started':
      /**
       * 重新拆解开始：上一轮的失败结论立刻作废。
       *
       * 不清掉的话，从「点了重新拆解」到「新图生出来」这几十秒里，
       * `deriveRunStatus` 会继续报 `failed`——用户看到的是同一个失败徽标，
       * 会以为按钮没生效。
       */
      return withRun(state, event.runId, (run) => {
        run.planFailure = undefined;
      });

    case 'plan.failed':
      // 失败是结论而不是噪音：它必须进事实，否则这个运行除了「创建过」
      // 之外没有任何可派生状态，界面上会永远停在「运行中」。
      return withRun(state, event.runId, (run) => {
        run.planFailure = {
          at: event.at,
          message: event.message,
          issues: event.issues,
        };
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
        // 重新开始意味着「待恢复」这个展示不再成立：不清掉它，看板会一直
        // 说这个节点已停止，而它正在跑
        node.interruptedAt = undefined;
      });

    case 'node.completed':
      return withNode(state, event.runId, event.nodeId, (node) => {
        node.finishedAt = event.at;
        node.failureReason = undefined;
        node.interruptedAt = undefined;
      });

    case 'node.failed':
      return withNode(state, event.runId, event.nodeId, (node) => {
        node.failureReason = event.reason;
        node.startedAt = node.startedAt ?? event.at;
        node.finishedAt = event.at;
      });

    case 'node.interrupted':
      /**
       * 被停止：把这一轮的执行事实整体抹掉，只留一个时刻用于展示。
       *
       * 清 `startedAt` / `finishedAt` 是这次修复的核心：留着它们，节点在
       * `deriveNodeStatus` 里要么是 running、要么是 completed，`readyNodes`
       * 永远不会再挑到它，用户点「继续」也续不上。清掉之后它自然回到
       * ready（依赖已满足）或 pending（依赖未满足），与「这一轮没跑过」等价。
       *
       * `attempts` 保持不变：这不是一次重试，是被打断。把它算进尝试次数会让
       * 审查的退回额度被用户的停止按钮消耗掉。
       */
      return withNode(state, event.runId, event.nodeId, (node) => {
        node.startedAt = undefined;
        node.finishedAt = undefined;
        node.failureReason = undefined;
        node.interruptedAt = event.at;
      });

    case 'node.reset':
      return withRun(state, event.runId, (run) => {
        resetNode(run, event.nodeId);
      });

    case 'dag.amended':
      // 图结构改动走独立事件，并在 facts 里留一条审计流水。
      // 不复用 node.reset：那条的语义是「审查驳回退回重做」，它清执行事实、
      // 不动结构；这一条恰好相反，只动结构、绝不清执行事实。
      return withRun(state, event.runId, (run) => {
        applyAmendments(run, event.changes);
        // 空改动不记账：一次「没有需要修改的地方」的对话不该在审计里留痕
        if (event.changes.length > 0) {
          run.amendments = [...(run.amendments ?? []), ...event.changes];
        }
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

    case 'agent.session':
      // 会话 id 是唯一需要落事实的 Agent 输出：它是后续续跑唯一的锚点，
      // 只活在事件流里的话，重启重放后就会永远拿不到。
      return withNode(state, event.runId, event.nodeId, (node) => {
        node.nativeSessionId = event.sessionId;
      });

    case 'node.resumed_session':
      // 只记「这一轮用了哪个会话」，绝不动 nativeSessionId：
      // 覆盖它等于伪造平台的捕获结果，下一轮 hooked 派生就会拿派生值当原生值用。
      return withNode(state, event.runId, event.nodeId, (node) => {
        node.lastResumeSessionId = event.sessionId;
      });

    case 'node.artifact':
      // 产物只统计量入事实，不改变节点状态机：采集成功与否
      // 都不该影响「这个节点是否完成」，否则一次 git 抖动就能
      // 把已完成的节点改判成失败。
      return withNode(state, event.runId, event.nodeId, (node) => {
        node.artifactBytes = event.bytes;
        node.artifactFiles = event.files;
      });

    case 'node.merged':
      // 只记分支名。完成态由紧随其后的 node.completed 负责——
      // 合并成功与节点完成是两件事，虽然正常情况下它们成对出现。
      return withNode(state, event.runId, event.nodeId, (node) => {
        node.mergedBranch = event.branch;
      });

    case 'node.merge_conflict':
      // 冲突不改完成态：这条事件只负责把冲突文件摆到台面上，
      // 真正的失败判定由编排器补发的 node.failed 决定。
      // 在这里顺手写 failureReason 会让同一次失败被记两遍，
      // 且与「失败一律经过 node.failed」的投影约定相冲突。
      return state;

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

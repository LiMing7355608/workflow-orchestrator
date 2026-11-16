import type {
  BoardLane,
  EdgeView,
  EventView,
  NodeFacts,
  NodeStatus,
  NodeView,
  OrchestratorEvent,
  RunDetailView,
  RunFacts,
  RunStatus,
  RunView,
} from './types.js';
import { reviveLegacyAgentText } from './legacy-text.js';

/** 把 agentId 解析成平台名的回调。编排器不直接依赖 Agent 目录的具体实现。 */
export type AgentLabelResolver = (agentId: string | undefined) => string | undefined;

/** 纯逻辑节点（审批、路由）没有 Agent，用事实里记录的展示名兜底。 */
function nodeAgentLabel(node: NodeFacts, resolve: AgentLabelResolver): string {
  return resolve(node.agentId) ?? node.executor ?? node.id;
}

/**
 * 节点状态推导。
 *
 * 优先级刻意这样排：执行中的事实压过依赖关系，
 * 被驳回过的节点在重新开始前显示为「退回重做」，
 * 其余按上游完成情况判定就绪与否。
 *
 * 关于 `interruptedAt`：它**不参与**这里的任何分支。节点被用户停下之后，
 * 投影层已经把 startedAt / finishedAt / failureReason 清空，因此它会自然落到
 * 下面的依赖判定上——依赖满足就是 ready，不满足就是 pending。这是刻意的：
 * 状态值决定 `readyNodes` 的成员，一旦「被停止」成为一个状态值，这个节点就
 * 永远进不了就绪集合，用户点「继续」也不会被重新调度（上一轮用
 * `attempts > 0 → retry` 时踩的正是这个坑）。界面要显示「已停止，待恢复」
 * 时读 `interruptedAt`，不要读状态值。
 */
export function deriveNodeStatus(run: RunFacts, node: NodeFacts): NodeStatus {
  if (node.failureReason) {
    // 失败事实压过一切时间戳。
    //
    // 不能只看「有没有 startedAt」：失败也发生在开始之后，而 node.failed
    // 同时会写 finishedAt，若让下面「有 finishedAt 即完成」的规则先命中，
    // 一个失败的节点就会在跑完之后被展示成已交付——合并冲突这类需要
    // 立刻看见的结论会被抹掉。只有 node.started / node.completed 会清空
    // failureReason，因此「有 failureReason」当且仅当最近一次结局是失败。
    return 'failed';
  }
  if (node.startedAt && !node.finishedAt) {
    return node.type === 'approval' || node.escalated ? 'waiting_approval' : 'running';
  }
  if (node.finishedAt) {
    return 'completed';
  }
  // 被退回过不等于不可调度：attempts 只用于展示「重试第几次」和判定升级，
  // 绝不能拿它挡住就绪集合，否则节点退回一次就永远跑不动了。
  const dependencies = node.dependsOn.map((id) => run.nodes[id]);
  const depsSettled = dependencies.every(
    (dependency) =>
      dependency !== undefined &&
      deriveNodeStatus(run, dependency) === 'completed',
  );
  return depsSettled ? 'ready' : 'pending';
}

/**
 * 运行状态推导。注意没有读任何 status 字段——
 * `frozenAt` / `pausedAt` / `completedAt` 与节点事实是唯一依据。
 */
export function deriveRunStatus(run: RunFacts): RunStatus {
  const nodes = Object.values(run.nodes);
  const awaitingHuman = nodes.some(
    (node) => deriveNodeStatus(run, node) === 'waiting_approval',
  );
  // 「在等人」与「已暂停」相遇时，暂停优先。
  //
  // 两者都表示编排器没在推进，但含义不同：前者是「我等着你批」，后者是
  // 「你让我停了」。用户按过停止之后还显示「待你处理」，会让人以为它仍在
  // 等审批，而实际上这轮已经停了；点继续则回到 waiting_for_boss（审批记录
  // 从没被删掉）。
  if (awaitingHuman && !run.pausedAt) {
    return 'waiting_for_boss';
  }
  // 完成态仍压过暂停：一次已经跑完的运行，不该因为后来被点了停止就倒退成
  // 「已暂停」。这个优先级是既有行为，改了会让历史运行凭空变样。
  if (run.completedAt) {
    return 'completed';
  }
  if (run.pausedAt) {
    return 'paused';
  }
  if (!run.frozenAt) {
    /**
     * 还没有图的时候只剩两种可能：正在拆解（`draft`），或者拆解已经失败。
     *
     * 判据必须是「有失败事实」且「图从未冻结」两个条件同时成立：
     * - 只看 `planFailure`：一次历史上的失败会把后来重新拆解成功、甚至已经
     *   跑完的运行永远标成失败——失败事实是 append-only 的，事件删不掉。
     * - 只看「没有 frozenAt」：每个刚创建、正在拆解几十秒的运行都会被误判
     *   成失败，用户看到的是「刚建就挂了」。
     *
     * 所以冻结是那条分界线：`frozenAt` 一旦存在，拆解那一段历史就再也不能
     * 决定运行状态。
     */
    return run.planFailure ? 'failed' : 'draft';
  }
  if (nodes.some((node) => node.failureReason) &&
      !nodes.some((node) => ['ready', 'running'].includes(deriveNodeStatus(run, node)))) {
    return 'failed';
  }
  return 'running';
}

export function deriveProgress(run: RunFacts): number {
  const nodes = Object.values(run.nodes);
  if (nodes.length === 0) {
    return 0;
  }
  const done = nodes.filter(
    (node) => deriveNodeStatus(run, node) === 'completed',
  ).length;
  return Math.round((done / nodes.length) * 100);
}

/** 最近一次事实变更时刻，用作列表排序依据。 */
export function deriveUpdatedAt(run: RunFacts): string {
  const stamps = [
    run.createdAt,
    run.frozenAt,
    run.pausedAt,
    run.completedAt,
    // 拆解失败也是一次事实变更：不记进来的话，一个刚失败不久的运行会带着
    // 几十秒前的创建时刻排在列表底部，看起来像「很久没动静了」
    run.planFailure?.at,
  ];
  for (const node of Object.values(run.nodes)) {
    stamps.push(node.startedAt, node.finishedAt, node.interruptedAt);
  }
  return stamps
    .filter((stamp): stamp is string => Boolean(stamp))
    .sort()
    .at(-1) ?? run.createdAt;
}

export function deriveNodeView(
  run: RunFacts,
  node: NodeFacts,
  resolve: AgentLabelResolver,
): NodeView {
  const duration =
    node.startedAt && node.finishedAt
      ? new Date(node.finishedAt).getTime() - new Date(node.startedAt).getTime()
      : undefined;

  return {
    id: node.id,
    title: node.title,
    description: node.description,
    type: node.type,
    status: deriveNodeStatus(run, node),
    agent: nodeAgentLabel(node, resolve),
    agentId: node.agentId,
    dependsOn: node.dependsOn,
    files: node.files,
    attempts: node.attempts,
    durationMs: duration !== undefined && Number.isFinite(duration) ? duration : undefined,
    escalated: node.escalated,
    // 展示用：状态是 ready/pending，但这一轮是被用户停下的，界面据此说
    // 「已停止，待恢复」而不是「就绪」
    interruptedAt: node.interruptedAt,
    artifactBytes: node.artifactBytes,
    artifactFiles: node.artifactFiles,
    nativeSessionId: node.nativeSessionId,
    mergedBranch: node.mergedBranch,
  };
}

export function deriveNodes(run: RunFacts, resolve: AgentLabelResolver): NodeView[] {
  return run.nodeOrder
    .map((id) => run.nodes[id])
    .filter((node): node is NodeFacts => Boolean(node))
    .map((node) => deriveNodeView(run, node, resolve));
}

/** 依赖边由节点事实直接生成，图结构冻结后不再变化。 */
export function deriveEdges(run: RunFacts): EdgeView[] {
  const edges: EdgeView[] = [];
  for (const id of run.nodeOrder) {
    const node = run.nodes[id];
    if (!node) {
      continue;
    }
    for (const dependency of node.dependsOn) {
      edges.push({
        id: `e-${dependency}-${node.id}`,
        source: dependency,
        target: node.id,
      });
    }
  }
  return edges;
}

export function deriveRunView(run: RunFacts): RunView {
  return {
    id: run.id,
    title: run.title,
    summary: run.summary,
    goal: run.goal,
    status: deriveRunStatus(run),
    stage: run.stage,
    // 旧日志里没有这个字段（见 run.created 的归约兜底），这里再挡一次：
    // 视图是给界面读的，空串明确表示「这条运行的目录未知」，不能是 undefined。
    workspaceRoot: run.workspaceRoot ?? '',
    planFailure: run.planFailure,
    progress: deriveProgress(run),
    nodeCount: run.nodeOrder.length,
    specVersion: run.specVersion,
    updatedAt: deriveUpdatedAt(run),
  };
}

/* ------------------------------------------------------------------ *
 * 事件视图：把事实事件翻译成看板可读的一行
 * ------------------------------------------------------------------ */

type EventKind = EventView['type'];

function eventKind(event: OrchestratorEvent): EventKind {
  switch (event.type) {
    case 'run.created':
    case 'run.frozen':
    // 拆解属于阶段性事件，归 stage 页签：它说的是「图还没生出来」，
    // 而不是某个 Agent 的执行过程——虽然产图这个动作是 Agent 干的。
    case 'plan.started':
    case 'plan.failed':
    case 'run.paused':
    case 'run.resumed':
    case 'run.completed':
      // 改图归到 stage 页签：它改的是阶段性的结构，不是某个节点的执行过程。
      // 归到 agent 页签会让人以为某个 Agent 干了这件事，而干这件事的是人。
      return 'stage';
    case 'dag.amended':
      return 'stage';
    case 'review.verdict':
    case 'review.escalated':
      return 'review';
    case 'node.interrupted':
      // 归 system 而不是 agent：它不是某个 Agent 说的话，也不是执行结果，
      // 而是编排层对「这个人把运行按停了」这件事的记账。
      return 'system';
    case 'approval.requested':
    case 'approval.decided':
      return 'approval';
    case 'node.started':
    case 'node.completed':
    case 'node.failed':
    case 'node.reset':
    case 'node.artifact':
    case 'node.merged':
    case 'node.merge_conflict':
    case 'agent.output':
    case 'agent.session':
    case 'node.resumed_session':
      return 'agent';
    default:
      return 'system';
  }
}

function nodeTitleOf(run: RunFacts, nodeId: string): string {
  return run.nodes[nodeId]?.title ?? nodeId;
}

function eventMessage(run: RunFacts, event: OrchestratorEvent): string {
  switch (event.type) {
    case 'run.created':
      return `创建运行：${event.run.title}`;
    case 'run.frozen':
      return 'DAG 已冻结，进入执行阶段';
    case 'plan.started':
      // 带上 Agent：用户点了「开始拆解」之后唯一的进展信号就是「谁在拆」，
      // 只写「正在拆解」等于把等待的原因藏起来
      return `编排器开始拆解任务图（${event.agentId}）`;
    case 'plan.failed':
      // 原因原样带出：这是用户决定「重试还是改目标」的唯一依据，
      // 概括成「拆解失败」等于让他再猜一次
      return `任务图拆解失败：${event.message}`;
    case 'run.paused':
      return '运行已暂停';
    case 'run.resumed':
      return '运行已恢复';
    case 'run.completed':
      return '全部节点完成，运行结束';
    case 'dag.amended': {
      // 一行说清「谁改了什么」，且逐条列出改动对象：这是审计行，
      // 聚合成一个数字就再也无法回答「哪几个节点被动了」。
      const parts = event.changes.map((change) => {
        const label =
          change.kind === 'add-node'
            ? '新增'
            : change.kind === 'remove-node'
              ? '移除'
              : '更新';
        const detail =
          change.fields && change.fields.length > 0
            ? `（${change.fields
                .map((field) => `${field.field}：${field.from ?? '—'} → ${field.to ?? '—'}`)
                .join('，')}）`
            : '';
        return `${label} ${change.nodeId}${detail}`;
      });
      return `按指令修改任务图（${event.actor}）：${parts.join('；')}`;
    }
    case 'node.started':
      return `${nodeTitleOf(run, event.nodeId)} 开始执行`;
    case 'node.completed':
      return `${nodeTitleOf(run, event.nodeId)} 完成`;
    case 'node.failed':
      return `${nodeTitleOf(run, event.nodeId)} 失败：${event.reason}`;
    case 'node.reset':
      return `${nodeTitleOf(run, event.nodeId)} 被退回重做：${event.reason}`;
    case 'node.interrupted':
      // 措辞刻意不用「失败」：它不是这个节点的结论，只是人按了停止。
      // 节点名列在这里而不是句首，是因为这句话说的是「什么被停下了」。
      return `被停止：${nodeTitleOf(run, event.nodeId)}（${event.reason}）`;
    case 'review.verdict':
      return event.verdict === 'approved'
        ? `审查通过：${nodeTitleOf(run, event.nodeId)}`
        : `审查驳回：${nodeTitleOf(run, event.nodeId)}`;
    case 'review.escalated':
      return `审查超限，升级人工：${nodeTitleOf(run, event.nodeId)}`;
    case 'approval.requested':
      return `等待人工审批：${nodeTitleOf(run, event.record.nodeId)}`;
    case 'approval.decided': {
      const label =
        event.decision === 'approve'
          ? '批准'
          : event.decision === 'reject'
            ? '驳回'
            : '转交';
      const recipient = event.nextRecord?.handedOffTo;
      const actor = recipient ? `${event.actor} → ${recipient}` : event.actor;
      return `审批${label}：${actor}${event.reason ? `（${event.reason}）` : ''}`;
    }
    case 'node.artifact':
      return `${nodeTitleOf(run, event.nodeId)} 产出 ${event.files.length} 个文件的变更（${event.bytes} 字节）`;
    case 'node.merged':
      // 报数量而不是逐个列：这里的一句话是给人扫一眼的，
      // 具体是谁已经在 merged 里，展开交给详情面板
      return `已合并 ${event.merged.length} 个节点分支到 ${event.branch}`;
    case 'node.merge_conflict':
      // 冲突文件必须写全：这是人唯一能据以判断「要不要手工合一下」的信息
      return `合并冲突（${event.conflicts.length} 个文件）：${event.conflicts.join('、') || '未取得文件列表'}`;
    case 'agent.output':
      // 工具调用单独说清楚：把「干了什么」和「说了什么」混成一行，
      // 事件流读起来就只剩一堵文本墙
      return event.kind === 'tool' && event.chunk === event.toolName
        ? `调用工具 ${event.toolName}`
        : event.chunk.trim();
    case 'agent.session':
      return `原生会话已建立：${event.sessionId}`;
    case 'node.resumed_session':
      // 与「原生会话已建立」区分开：那条是平台给的 id，这条是我们复用了它
      return `${nodeTitleOf(run, event.nodeId)} 复用会话续跑：${event.sessionId}`;
    default:
      return '';
  }
}

/**
 * 每个节点最后一次被重置的时刻。
 *
 * 重置的语义是「这个节点之前那轮不算数了」，但 journal 是 append-only，事件
 * 一条都删不掉。所以只能在读取时切片：早于这个边界的事件不再进入视图，
 * 时间线才会真的从空开始，而不是把上一轮的执行记录继续挂着。
 */
function lastResetOf(
  events: OrchestratorEvent[],
  runId: string,
): Map<string, string> {
  const borders = new Map<string, string>();
  for (const event of events) {
    if (event.runId !== runId) {
      continue;
    }
    const resetId = event.type === 'node.reset' ? event.nodeId
      : event.type === 'review.verdict' ? event.rework?.nodeId
        : event.type === 'approval.decided' ? event.resetNodeId : undefined;
    if (resetId) {
      borders.set(resetId, event.at);
    }
  }
  return borders;
}

export function deriveEvents(
  run: RunFacts,
  events: OrchestratorEvent[],
  resolve: AgentLabelResolver = () => undefined,
): EventView[] {
  const scoped = events.filter((event) => event.runId === run.id);
  const resetBorders = lastResetOf(scoped, run.id);

  const views: EventView[] = [];

  for (const event of scoped) {
    const nodeId =
      'nodeId' in event
        ? event.nodeId
        : event.type === 'approval.requested'
          ? event.record.nodeId
          : undefined;

    // 发生在最后一次重置之前的节点事件属于已经作废的那一轮。重置事件本身
    // 要留下——它是「从这里重新开始」的标记。
    if (nodeId !== undefined && event.type !== 'node.reset') {
      const border = resetBorders.get(nodeId);
      if (border !== undefined && event.at < border) {
        continue;
      }
    }

    const node = nodeId ? run.nodes[nodeId] : undefined;
    const output = event.type === 'agent.output' ? event : undefined;

    // 旧版本把解析器认不出的整行原样当正文写进了 journal，读出来再补一次
    // 解析：status 这类进度噪音丢弃，thinking 重新归类。已经写死的历史数据
    // 只能这样救，改前端是救不回来的。
    let kind = output?.kind;
    let message = eventMessage(run, event);
    if (output) {
      const revived = reviveLegacyAgentText(output.chunk);
      if (revived === null) {
        continue;
      }
      if (revived !== undefined) {
        kind = revived.kind;
        message = revived.text;
      }
    }

    views.push({
      id: `ev-${views.length}`,
      at: event.at,
      type: eventKind(event),
      message,
      nodeId,
      agent: output ? resolve(output.agentId) ?? output.agentId : node ? nodeAgentLabel(node, resolve) : undefined,
      kind,
      toolName: output?.toolName,
    });
  }

  return views;
}

export function deriveRunDetail(
  run: RunFacts,
  events: OrchestratorEvent[],
  resolve: AgentLabelResolver,
): RunDetailView {
  return {
    ...deriveRunView(run),
    nodes: deriveNodes(run, resolve),
    edges: deriveEdges(run),
    events: deriveEvents(run, events, resolve),
  };
}

/* ------------------------------------------------------------------ *
 * 四泳道：以实现节点为任务卡，把下游审查/审批状态折叠成泳道
 * ------------------------------------------------------------------ */

export interface BoardCardView {
  id: string;
  lane: BoardLane;
  implement: NodeView;
  focus: NodeView;
  review?: NodeView;
  approval?: NodeView;
}

export function deriveBoard(
  nodes: NodeView[],
  edges: EdgeView[],
): Record<BoardLane, BoardCardView[]> {
  const byId = new Map(nodes.map((node) => [node.id, node] as const));
  const outgoing = new Map<string, string[]>();
  for (const node of nodes) {
    outgoing.set(node.id, []);
  }
  for (const edge of edges) {
    if (byId.has(edge.source) && byId.has(edge.target)) {
      outgoing.get(edge.source)?.push(edge.target);
    }
  }

  const downstream = (id: string): NodeView[] =>
    (outgoing.get(id) ?? [])
      .map((next) => byId.get(next))
      .filter((node): node is NodeView => Boolean(node));

  const lanes: Record<BoardLane, BoardCardView[]> = {
    working: [],
    needs_you: [],
    in_review: [],
    ready: [],
  };

  for (const implement of nodes) {
    if (implement.type !== 'implement') {
      continue;
    }
    const direct = downstream(implement.id);
    const review = direct.find((node) => node.type === 'review');
    const approval =
      (review?.status === 'waiting_approval' ? review : undefined) ??
      direct.find((node) => node.type === 'approval') ??
      (review
        ? downstream(review.id).find((node) => node.type === 'approval')
        : undefined);

    let lane: BoardLane = 'working';
    if (approval?.status === 'waiting_approval') {
      lane = 'needs_you';
    } else if (
      review?.status === 'running' ||
      (implement.status === 'completed' && review && review.status !== 'completed')
    ) {
      lane = 'in_review';
    } else if (
      implement.status === 'completed' &&
      (!review || review.status === 'completed') &&
      (!approval || approval.status === 'completed')
    ) {
      lane = 'ready';
    }

    const focus =
      lane === 'needs_you' && approval
        ? approval
        : lane === 'in_review' && review
          ? review
          : implement;

    lanes[lane].push({
      id: implement.id,
      lane,
      implement,
      focus,
      review,
      approval,
    });
  }

  return lanes;
}

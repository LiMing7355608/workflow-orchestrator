import type {
  BoardLane,
  ConversationEntry,
  ConversationOutput,
  DagAmendment,
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
  const statuses = nodes.map((node) => deriveNodeStatus(run, node));
  const anyRunning = statuses.includes('running');

  /**
   * 判据的第一条：**有节点在跑，整体就是在运行。**
   *
   * 这条压过暂停与完成的判断——「有人在干活」是最高优先级的事实。否则会出现
   * 「界面说已暂停、底下还有 Agent 在烧 token」这种最不该有的组合。
   */
  if (anyRunning) {
    return 'running';
  }

  const awaitingHuman = statuses.includes('waiting_approval');
  // 「在等人」与「已暂停」相遇时，暂停优先。
  //
  // 两者都表示编排器没在推进，但含义不同：前者是「我等着你批」，后者是
  // 「你让我停了」。用户按过停止之后还显示「待你处理」，会让人以为它仍在
  // 等审批，而实际上这轮已经停了；点继续则回到 waiting_for_boss（审批记录
  // 从没被删掉）。
  //
  // 「在等人」也压过完成态：节点都跑完了、只剩一个人工审批卡着，那不算
  // 交付完成——它还在等一个人。
  if ((awaitingHuman || run.planDraft) && !run.pausedAt) {
    return 'waiting_for_boss';
  }

  // 完成态压过暂停：一次已经跑完的运行，不该因为后来被点了停止就倒退成
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
     *   跑完的运行永远标成失败——失败事实是 append-only 的事件，删不掉。
     * - 只看「没有 frozenAt」：每个刚创建、正在拆解几十秒的运行都会被误判
     *   成失败，用户看到的是「刚建就挂了」。
     *
     * 所以冻结是那条分界线：`frozenAt` 一旦存在，拆解那一段历史就再也不能
     * 决定运行状态。
     */
    return run.planFailure ? 'failed' : 'draft';
  }

  // 有失败、且没有任何节点还能被调度：卡死了。
  // `ready` 要算进来——只要还有一个能跑的节点，就不是死局。
  if (nodes.some((node) => node.failureReason) && !statuses.includes('ready')) {
    return 'failed';
  }

  /**
   * 到这里没有节点在跑。用户定下的规则是「所有节点都停了，就是停止」。
   *
   * 这一条修的是一个真实的状态失真：节点被用户打断后回到 `ready`（可重新
   * 调度），但没有任何推进链路在动它，而旧逻辑只看到「有 ready 节点」就判
   * 运行中——界面说在跑，实际上一个 Agent 都没起来。
   *
   * 有 `interruptedAt` 的节点就是「被停下过且还停着」，据此判暂停；没被打断
   * 过、只是刚建好还没轮到，仍然算运行中（`advance` 已经排上了）。
   */
  if (nodes.some((node) => node.interruptedAt !== undefined)) {
    return 'paused';
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
    run.planCheckingAt,
    run.planDraft?.at,
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
    ...(node.deliverables ? { deliverables: node.deliverables } : {}),
    ...(node.acceptance ? { acceptance: node.acceptance } : {}),
    ...(node.delivery ? { delivery: node.delivery } : {}),
    ...(node.startedAt ? { startedAt: node.startedAt } : {}),
    ...(node.finishedAt ? { finishedAt: node.finishedAt } : {}),
    attempts: node.attempts,
    durationMs: duration !== undefined && Number.isFinite(duration) ? duration : undefined,
    escalated: node.escalated,
    // 展示用：状态是 ready/pending，但这一轮是被用户停下的，界面据此说
    // 「已停止，待恢复」而不是「就绪」
    interruptedAt: node.interruptedAt,
    // 失败原因必须能一眼看到。只在事件流里留一句，用户得点进时间线翻到底
    // 才知道它为什么红——这块本该是节点卡片自己说得清的事
    failureReason: node.failureReason,
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
    ...(run.reviewPlan ? { reviewPlan: true } : {}),
    ...(run.planCheckingAt ? { planCheckingAt: run.planCheckingAt } : {}),
    ...(run.planDraft ? { planDraft: run.planDraft } : {}),
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
    case 'plan.checking':
    case 'plan.drafted':
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

/**
 * 一次改图改了什么的紧凑说法。
 *
 * 事件流与会话流都要说这句话，所以只写一份：两处各写一遍，迟早会出现
 * 「流水里说改了 agentId、对话里说改了 title」这种自相矛盾的记录。
 */
function describeChanges(changes: DagAmendment[]): string {
  return changes
    .map((change) => {
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
    })
    .join('；');
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
    case 'plan.checking':
      return '初稿通过结构校验，开始交叉核对需求和任务覆盖。';
    case 'plan.drafted':
      return '任务草案与核对结果已就绪，等待人工确认。';
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
      return `按指令修改任务图（${event.actor}）：${describeChanges(event.changes)}`;
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
    case 'node.message':
      // 正常走不到：deriveEvents 会先把它整个跳过（它有自己那条会话视图）。
      // 留这一行是为了「跳过的那行被谁删掉」时不至于渲染出一条空消息——
      // 静默地少一行，比显式地说错一行更难发现。
      return `${event.role === 'user' ? '用户' : '节点执行者'}：${event.text}`;
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
    // 对话不进事件流：它有自己的视图（deriveConversation / deriveNodeConversation）。
    // 放进流水会让同一句话在界面上出现两次，而流水里没有「谁在跟谁说话」这个
    // 位置——一条用户消息夹在节点事件中间，读起来像是系统自己发出的。
    //
    // 节点会话同理：节点面板里的会话区与这条流水是两处刻意分工的视图
    // （见 NodeDetailPanel 的注释），一条 node.message 若同时出现在两边，
    // 用户会以为同一句话被发了两次。
    if (event.type === 'orchestrator.message' || event.type === 'node.message' || event.type === 'role.message') {
      continue;
    }

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

/**
 * 编排器会话：把「人说过的话」与「编排器做过的决定」拼成一条时间线。
 *
 * 三个刻意的决定：
 *
 * 1. **首条来自 `run.goal`，不来自事件**。目标就是用户最初说的那句话，
 *    事件里再存一份，就多了「两份目标互相矛盾」这种无处裁决的状态。
 * 2. **系统行也在这条流里**。拆解开始/失败、图生成、改图结果都是用户读这段
 *    对话时要看到的上下文：「我要求改 agent，然后它卡在拆解失败」比一条孤零零
 *    的回复有用得多。
 * 3. **只排时刻，不重排语义**。同一毫秒里的几条事件必须保持落盘顺序——
 *    「用户说 → 拆解失败 → 编排器回答」的顺序颠倒过来，读起来就成了它在
 *    回答一件还没发生的事。`sort` 的稳定性正好保证这一点。
 */
export function deriveConversation(
  run: RunFacts,
  events: OrchestratorEvent[],
): ConversationEntry[] {
  const entries: ConversationEntry[] = [];

  const goal = run.goal.trim();
  if (goal) {
    entries.push({
      id: 'conv-goal',
      at: run.createdAt,
      role: 'user',
      text: run.goal,
    });
  }

  // id 用位置生成而不是 uuid：这条流每次读都从事实重新组装，位置就是它的
  // 身份——用随机 id 会让 React 每次刷新都重建所有节点，滚动位置与展开状态
  // 一起丢。
  const push = (entry: Omit<ConversationEntry, 'id'>): void => {
    entries.push({ id: `conv-${entries.length}`, ...entry });
  };

  /**
   * 当前正在进行的拆解那条系统行。
   *
   * 拆解期间 Agent 的输出（thinking / tool / 正文）没有 nodeId，它们属于
   * 「这一次拆解」，要挂到发起它的那条行的 outputs 上——散进流水里就变成
   * 一串没有主语的条目，读的人不知道是谁在说话。
   */
  let planEntry: ConversationEntry | undefined;

  /**
   * 还没有归属的编排器输出。
   *
   * 改图时 Agent 已经在跑了，`dag.amended` 却要等它交出结果才落——中间这些
   * 输出先攥在这里，等结论行下来再挂上去。直接丢掉就等于「只给结论不给过程」。
   */
  let pendingOutputs: ConversationOutput[] = [];

  for (const event of events) {
    if (event.runId !== run.id) {
      continue;
    }
    switch (event.type) {
      case 'orchestrator.message':
        planEntry = undefined;
        push({
          at: event.at,
          role: event.role,
          text: event.text,
          // 只有为 true 才写这个字段：`interrupt: false` 会让「是否打断过」
          // 多出一个假的事实值，界面也得分两种情况判它
          ...(event.interrupt ? { interrupt: true } : {}),
        });
        break;
      case 'plan.started': {
        // 新建一条系统行并记住它：这次拆解后续的输出要挂到它下面
        const entry: ConversationEntry = {
          id: 'pending',
          at: event.at,
          role: 'system',
          text: `开始拆解任务图（${event.agentId}）`,
          tone: 'info',
          outputs: [],
        };
        push(entry);
        planEntry = entries[entries.length - 1];
        break;
      }
      case 'plan.checking':
        push({ at: event.at, role: 'system', text: '交叉核对任务草案（' + event.agentId + '）', tone: 'info', outputs: [] });
        planEntry = entries.at(-1);
        break;
      case 'agent.output':
        // nodeId 为空 = 编排器自己的执行输出（拆解或改图时还没有节点）。
        // 有正在进行的拆解就挂到那条行下面；否则先攥着，等这次改图的
        // `dag.amended` 落下来再挂到它下面——改图过程同样是「它是怎么想的」，
        // 扔掉的话用户只能看到一个结论，没法判断该不该接受。
        if (event.nodeId === undefined) {
          const output: ConversationOutput = {
            id: `out-${planEntry?.outputs?.length ?? pendingOutputs.length}`,
            at: event.at,
            kind: event.kind,
            text: event.chunk,
            toolName: event.toolName,
          };
          if (planEntry?.outputs) {
            planEntry.outputs.push(output);
          } else {
            pendingOutputs.push(output);
          }
        }
        break;
      case 'plan.failed':
        planEntry = undefined;
        // 原因原样带出：它是人决定「改目标还是换 Agent」的唯一依据
        push({
          at: event.at,
          role: 'system',
          text: `拆解失败：${event.message}`,
          tone: 'warning',
        });
        break;
      case 'run.frozen': {
        planEntry = undefined;
        // 优先用这次冻结带进来的节点数，而不是当前的 `run.nodeOrder`：
        // 冻结之后还可能有 dag.amended 增删节点，读后者会把「这次生成了几个」
        // 说成「现在有几个」
        const count = event.nodes?.length ?? run.nodeOrder.length;
        push({
          at: event.at,
          role: 'system',
          text: `任务图已生成：${count} 个节点`,
          tone: 'success',
        });
        break;
      }
      case 'dag.amended':
        // 这次改图的执行过程挂到结论行下面，默认收起、可展开
        push({
          at: event.at,
          role: 'system',
          text:
            event.changes.length > 0
              ? `改图：${describeChanges(event.changes)}`
              : '改图：没有需要修改的地方',
          tone: 'info',
          ...(pendingOutputs.length > 0 ? { outputs: pendingOutputs } : {}),
        });
        pendingOutputs = [];
        break;
      default:
        break;
    }
  }

  return entries.sort((left, right) => left.at.localeCompare(right.at));
}

/**
 * 节点开始执行时那一行的括号内容。
 *
 * 刻意不接 `AgentLabelResolver`：`deriveNodeConversation` 的签名只有运行事实、
 * 事件与 nodeId，多一个回调会让「同一个节点在不同调用点显示成两个名字」成为
 * 可能。要平台名的界面读 `NodeView.agent` 就够了——那里已经解析过一次。
 */
function nodeActorLabel(run: RunFacts, nodeId: string): string | undefined {
  const node = run.nodes[nodeId];
  const who = node?.executor?.trim() || node?.agentId?.trim();
  return who || undefined;
}

/**
 * 节点会话：这个节点「跑了几轮、每轮说了什么、中途被人插过什么话」。
 *
 * 与 `deriveConversation` 同一套组装思路（系统行也在流里、按时刻稳定排序、
 * id 用位置生成），差别只有两处，但两处都必须说清：
 *
 * 1. **`agent.output` 不单独成条**。一次节点执行动辄几十条输出，摊成流水就
 *    把「我中途改过要求」这件事彻底埋掉了。它们统一挂到所属那一轮执行
 *    （最近一条 `node.started`）的 `outputs` 下面，形态与编排器会话一致。
 * 2. **不做重置切片**。事件流视图（deriveEvents）会把最后一次 `node.reset`
 *    之前的事件全部切掉，因为那是「已经作废的一轮执行」。这里**不切**：
 *    `node.message` 里的人话是可审计的历史，重置作废的是执行事实，不是
 *    「我当时要求过什么」——而且提示词注入读的是完整历史（见 buildPrompt），
 *    会话里切掉、提示词里还在，两边就会互相矛盾。
 *
 * 归属规则：`agent.output` 只挂到当前这一轮。`node.completed` / `node.failed`
 * / `node.interrupted` / `node.reset` 都把「当前这一轮」关掉，于是打断之后
 * 才姗姗来迟的收尾输出不会被算进下一轮——它属于被打断的那一轮。
 */
export function deriveNodeConversation(
  run: RunFacts,
  events: OrchestratorEvent[],
  nodeId: string,
): ConversationEntry[] {
  const entries: ConversationEntry[] = [];

  // id 用位置生成而不是 uuid：理由与 deriveConversation 完全一样——这条流
  // 每次读都从事实重新组装，位置就是它的身份。
  const push = (entry: Omit<ConversationEntry, 'id'>): ConversationEntry => {
    const next: ConversationEntry = { id: `node-conv-${entries.length}`, ...entry };
    entries.push(next);
    return next;
  };

  const actor = nodeActorLabel(run, nodeId);
  /** 当前这一轮执行的那条系统行；`outputs` 往它下面挂 */
  let executionEntry: ConversationEntry | undefined;

  for (const event of events) {
    if (event.runId !== run.id) {
      continue;
    }
    // 只认「带 nodeId 且指向这个节点」的事件。运行级事件（run.paused 等）
    // 不属于任何一个节点，混进来会让每个节点的会话都长得一样。
    if (!('nodeId' in event) || event.nodeId !== nodeId) {
      continue;
    }

    switch (event.type) {
      case 'node.message':
        push({
          at: event.at,
          role: event.role,
          text: event.text,
          // 只有 true 才写：`interrupt: false` 会让「是否打断过」多出一个
          // 假的事实值，界面也得分两种情况判它
          ...(event.interrupt ? { interrupt: true } : {}),
        });
        // 刻意不动 `executionEntry`：插话发生在一次执行**进行中**，它不是
        // 新的一轮。新的轮次由随后那条 node.started 划开。
        break;

      case 'node.started':
        executionEntry = push({
          at: event.at,
          role: 'system',
          text: actor ? `开始执行（${actor}）` : '开始执行',
          tone: 'info',
          // 即使这一轮一句话都没说，也留一个空数组：界面据此知道「这一轮
          // 有输出区」，不必再判一次 undefined
          outputs: [],
        });
        break;

      case 'node.completed':
        executionEntry = undefined;
        push({ at: event.at, role: 'system', text: '完成', tone: 'success' });
        break;

      case 'node.failed':
        executionEntry = undefined;
        // 原因原样带出：它是人决定「再跑一次还是先改要求」的唯一依据
        push({ at: event.at, role: 'system', text: `失败：${event.reason}`, tone: 'warning' });
        break;

      case 'node.interrupted':
        executionEntry = undefined;
        // 措辞与事件流一致，不用「失败」：它不是这个节点的结论
        push({ at: event.at, role: 'system', text: `被停止：${event.reason}`, tone: 'warning' });
        break;

      case 'node.reset':
        executionEntry = undefined;
        push({ at: event.at, role: 'system', text: `已重置：${event.reason}`, tone: 'info' });
        break;

      case 'agent.output': {
        // 空正文不发：一个空思考块一个字都没说，落进会话就是凭空占一行
        const text = event.chunk.trim();
        if (!text || !executionEntry?.outputs) {
          break;
        }
        executionEntry.outputs.push({
          id: `${executionEntry.id}-out-${executionEntry.outputs.length}`,
          at: event.at,
          kind: event.kind,
          text: event.chunk,
          toolName: event.toolName,
        });
        break;
      }

      default:
        break;
    }
  }

  // 同一毫秒里的几条必须保持落盘顺序：`sort` 的稳定性正好保证这一点，
  // 「插话 → 被停止」的顺序颠倒过来，读起来就成了「它先停了，我才说话」。
  return entries.sort((left, right) => left.at.localeCompare(right.at));
}

/**
 * 每个节点的会话，只保留有内容的那些。
 *
 * 先按 nodeId 分一次桶再算：`deriveRunDetail` 是每次读运行详情都要跑一遍的
 * 热路径（SSE 每来一条事件就刷新一次），对每个节点各扫一遍全量事件会退化成
 * O(节点数 × 事件数)。分桶之后总成本仍然是 O(事件数)。
 */
function deriveNodeConversations(
  run: RunFacts,
  events: OrchestratorEvent[],
): Record<string, ConversationEntry[]> {
  const byNode = new Map<string, OrchestratorEvent[]>();
  for (const event of events) {
    // `agent.output` 的 nodeId 是可选字段（图生成期间的输出没有节点），
    // 所以 `'nodeId' in event` 收窄之后还得再挡一次 undefined。
    const nodeId = 'nodeId' in event ? event.nodeId : undefined;
    if (event.runId !== run.id || nodeId === undefined) {
      continue;
    }
    const bucket = byNode.get(nodeId);
    if (bucket) {
      bucket.push(event);
    } else {
      byNode.set(nodeId, [event]);
    }
  }

  const result: Record<string, ConversationEntry[]> = {};
  for (const [nodeId, scoped] of byNode) {
    const entries = deriveNodeConversation(run, scoped, nodeId);
    // 空会话不放键：绝大多数节点从没被插过话，给每个节点塞一个空数组
    // 只会让每次刷新的响应体白白变大
    if (entries.length > 0) {
      result[nodeId] = entries;
    }
  }
  return result;
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
    conversation: deriveConversation(run, events),
    nodeConversations: deriveNodeConversations(run, events),
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

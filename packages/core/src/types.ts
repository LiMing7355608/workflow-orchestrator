/**
 * 领域类型：事实与视图分离。
 *
 * 铁律：展示状态从不入库。`RunFacts` / `NodeFacts` 只记录发生了什么
 * （开始时刻、结束时刻、裁决、尝试次数），`RunView` 里的 status、进度、
 * 泳道全部由 `derive.ts` 在读取时算出来。
 *
 * 这样前端不需要等后端把某个 status 字段写对，编排器也不需要维护
 * 「状态字段和真实执行情况一致」这条永远会漂移的约束。
 */

import type { AgentEventKind } from './parsers.js';

export type RunStage = 'spec' | 'decompose' | 'orchestrate' | 'execute';

export type RunStatus =
  | 'draft'
  | 'running'
  | 'waiting_for_boss'
  | 'completed'
  | 'paused'
  /**
   * 拆解阶段就失败了：图从没冻结，也没有任何节点可以跑。
   *
   * 为什么要与 `paused` 分开：暂停是「人按了停止，随时可以继续」，失败是
   * 「这一轮没有可以继续的对象」——继续这个动作对一个没有图的运行毫无意义。
   * 合成一个值的话，界面只能含糊地说「已停止」，用户会一直等一个不会到来
   * 的节点。它也只由「有拆解失败事实 + 图从未冻结」派生，见 deriveRunStatus。
   */
  | 'failed';

export type NodeType = 'implement' | 'review' | 'approval' | 'route';

export type NodeStatus =
  | 'pending'
  | 'ready'
  | 'running'
  | 'completed'
  | 'failed'
  | 'waiting_approval'
  | 'retry'
  /**
   * 被用户停止（不是失败）。
   *
   * 这个值只服务于「界面该怎么叫它」：内核的 `deriveNodeStatus` **永不**返回
   * 它，节点被停下之后立刻回到可调度状态（ready 或 pending），因为一次停下
   * 不该让节点永远跑不起来——用户点「继续」时它必须还能被重新派发。
   *
   * 展示层拿 `NodeView.interruptedAt` 把它显示成「已停止，待恢复」。把它做成
   * 推导状态的一部分是危险的：就绪集合按状态值过滤，一旦该节点带着这个状态
   * 值，它就被永久踢出就绪集合，停止→继续会变成「什么都没发生」（这是上一轮
   * 用 `attempts > 0 → retry` 时踩过的同一个坑）。
   */
  | 'interrupted';

export type ReviewVerdict = 'approved' | 'changes_requested';

export type ApprovalDecision = 'approve' | 'reject' | 'handoff';

export type ApprovalStatus = 'pending' | 'approved' | 'rejected' | 'handed_off';

/** 拆解失败时带出来的一条具体问题（结构不合法、Agent 缺失等）。 */
export interface PlanIssue {
  kind: string;
  message: string;
}

/**
 * 最近一次「拆解任务图」的失败。
 *
 * 为什么要落成事实，而不是只留在事件流里：`run.created` 之后到图冻结之前，
 * 这个运行没有任何节点可供派生状态——唯一的依据就是「拆解成功了吗」。
 * 状态是派生物，它必须能从事实算出来，否则界面上这个运行会永远显示
 * 「运行中」，而实际上干活的那个进程早就退出了。
 */
export interface PlanFailure {
  at: string;
  message: string;
  /** Planner 给的校验问题；Agent 压根跑不起来时为空 */
  issues?: PlanIssue[];
}

/** 一次编排的持久事实。 */
export interface RunFacts {
  id: string;
  title: string;
  summary: string;
  /** 原始目标描述，Planner 的输入 */
  goal: string;
  /**
   * 这个运行在哪儿干活：目标仓库的绝对路径。
   *
   * 为什么必须落成运行级事实，而不是服务端的一个常量：Agent 的 cwd、节点分支、
   * 合并结果全都来自这个目录。把它做成全局值，等于强制所有运行都在「启动
   * server 的那个仓库」里交付——用户让它写一个 Python 计算器，成果却出现在
   * 编排器自己的 TS monorepo 里，而那个目录从来没人选过。
   *
   * 新旧兼容：这个字段是后加的，早期 journal 里的 `run.created` 没有它。
   * `reduce` 会把它压成空串，读取侧（服务端的工作区分派）见到空串就回落到
   * 默认根目录，见 packages/server/src/app.ts 的 workspaceFor。
   */
  workspaceRoot: string;
  specVersion: string;
  stage: RunStage;
  /** 注意：这里没有 status 字段——运行状态由 frozenAt / pausedAt / completedAt 与节点事实推导 */
  createdAt: string;
  /** DAG 冻结时刻。冻结后图结构不再变化 */
  frozenAt?: string;
  pausedAt?: string;
  completedAt?: string;
  /** 节点顺序，保证渲染稳定 */
  nodeOrder: string[];
  nodes: Record<string, NodeFacts>;
  /**
   * 最近一次拆解失败。
   *
   * 只影响「还没有图」的运行：`deriveRunStatus` 仅在 `frozenAt` 缺省时读它，
   * 一个已经冻结并跑完的运行不该因为早期那次失败被永远标红。
   * 重新拆解（`plan.started`）会清掉它。
   */
  planFailure?: PlanFailure;
  /**
   * 通过对话下发的图改动，累计追加。
   *
   * 与 `frozenAt` 的关系见 `dag.amended` 的注释：冻结拦的是自动流程，
   * 拦不住也不该拦「用户明确要求改图」。改动不进 nodes 之外的地方——
   * 节点事实照旧是唯一的结构来源，这里只是审计流水。
   */
  amendments?: DagAmendment[];
}

/** 单个节点的持久事实。 */
export interface NodeFacts {
  id: string;
  type: NodeType;
  title: string;
  description: string;
  dependsOn: string[];
  /** 独占文件范围，串并行安全的静态保障 */
  files: string[];
  /** 执行该节点的 Agent；审批与路由节点为空 */
  agentId?: string;
  /** 人类审批人与编排器节点使用的展示名 */
  executor?: string;
  /**
   * 路由节点的动作。
   *
   * 目前只有 `merge` 一种：普通 route 节点是零副作用的纯逻辑闸门，
   * 带 action 的 route 才是「把各节点分支汇入集成分支」这类真干活的编排动作。
   * 挂在 route 上而不是新增节点类型，是为了不改变既有 NodeType 的分类语义——
   * 它依然没有 Agent、没有独占文件范围，仍然由编排器自己执行。
   */
  action?: 'merge';
  attempts: number;
  maxAttempts: number;
  startedAt?: string;
  finishedAt?: string;
  /**
   * 最近一次被用户停下的时刻。
   *
   * 与 `failureReason` 刻意分成两栏：「被停下」和「执行失败」是两种不同的事实。
   * 前者是人的决定，可恢复；后者是执行层给出的裁决，需要人介入。混用一栏的话
   * 停止→继续之后节点会停在失败状态，用户只能新建一个运行。
   *
   * 它不参与状态判定（见 `deriveNodeStatus`），只用于展示；`node.started`
   * 会清掉它——一旦重新开始，「待恢复」这个展示就不成立了。
   */
  interruptedAt?: string;
  verdict?: ReviewVerdict;
  failureReason?: string;
  /** 审查超限后升级到人工 */
  escalated?: boolean;
  /**
   * 最近一次采集到的产物统计，仅供展示与提示词预算判断。
   *
   * diff 原文一律不进事实——它可能有几百 KB，写进事件日志等于
   * 每重放一次就要在内存里搬一遍，而且这些字节对状态机毫无用处。
   */
  artifactBytes?: number;
  /** 产物命中的路径，用于看板显示「改了哪些文件」 */
  artifactFiles?: string[];
  /**
   * Agent 自己报出来的原生会话 id（Claude 的 session_id、Codex 的 thread_id 等）。
   *
   * 存进事实是因为会话续跑（`session.derive: 'hooked'` 那类平台）只能靠它：
   * 进程退出后唯一还能接上上一轮上下文的东西就是这个 id，而它只出现在
   * 流式输出里，晚一步不落账就永久丢了。
   */
  nativeSessionId?: string;
  /**
   * 最近一次续跑时实际传给 CLI 的会话 id。
   *
   * 与 `nativeSessionId` 刻意分开存：后者是 hook 从输出里捕获的「平台说它是
   * 谁」，这里记的是「我们这一轮用了谁」。uuidv5 派生出来的 id 永远进不了
   * `nativeSessionId`（平台根本没报过），但它确实被用了，排障时必须看得见。
   */
  lastResumeSessionId?: string;
  /**
   * 成功合并后所在的集成分支名。
   *
   * 只记分支不记 commit：分支是后续操作的稳定锚点，而 commit 会被
   * 后续合并在同一分支上不断前移，写进事实里第二天就是错的。
   */
  mergedBranch?: string;
}

/**
 * 一次图结构的实际改动。由服务端比对「旧图 → 新图」算出来，逐项记账。
 *
 * 只描述「哪个节点的什么变了」：改名、换 Agent、增删节点都落在这一个形状里，
 * 审计时不必再按事件类型分叉。已开始节点的改动永远到不了这里——它们在服务端
 * 就被拒了，见 packages/server/src/amend.ts 的白名单。
 */
export interface DagAmendment {
  kind: 'update-node' | 'add-node' | 'remove-node';
  nodeId: string;
  /** 改了哪些字段，以及新旧值，用于审计与界面回显 */
  fields?: Array<{ field: string; from?: string; to?: string }>;
  /**
   * 节点的新事实。
   *
   * `add-node` 必须带：图里凭空多出来的节点没有别的来源，光有 nodeId 什么也
   * 投影不出来。`update-node` 也带一份，但 reduce 只从里面取白名单字段，
   * 于是「谁在哪个字段上越权」不取决于事件生产者的自觉。
   *
   * `fields` 是给人看的字符串对照，不能当数据源：files 是数组、maxAttempts 是
   * 数字，压成字符串再解析回来必然丢类型。两者刻意分工。
   */
  node?: NodeFacts;
}

/** 审批记录：不可变追加，每次请求与决策各一条。 */
export interface ApprovalRecord {
  id: string;
  runId: string;
  nodeId: string;
  status: ApprovalStatus;
  actor?: string;
  reason?: string;
  requestedAt: string;
  decidedAt?: string;
  handedOffTo?: string;
}

/** 投影状态：所有事实的内存视图，可由事件日志完整重放。 */
export interface ProjectState {
  runs: Record<string, RunFacts>;
  approvals: ApprovalRecord[];
}

/* ------------------------------------------------------------------ *
 * 事件：唯一的事实写入通道
 * ------------------------------------------------------------------ */

export interface BaseEvent {
  at: string;
  runId: string;
}

export type OrchestratorEvent =
  | (BaseEvent & { type: 'run.created'; run: RunFacts })
  | (BaseEvent & {
      /**
       * 图已冻结，进入执行阶段。
       *
       * `nodes` 是这次冻结带进来的节点图。为什么节点随冻结事件落，而不是继续
       * 塞在 `run.created` 里：拆解是异步的，创建的那一刻还没有图可带。把节点
       * 挂在冻结事件上，「先有运行、后有图」这个既定顺序才落在事实里。
       *
       * 可选是为了重放历史：旧日志的 `run.created` 自带节点，它后面那条冻结
       * 事件什么也不带。缺省即表示「这次冻结不引入新节点」。
       */
      type: 'run.frozen';
      nodes?: NodeFacts[];
    })
  | (BaseEvent & {
      /**
       * 编排器开始拆解任务图。
       *
       * 这条事件存在的唯一理由是可观测：拆解要真调一个 CLI Agent，几十秒里
       * 界面只能靠它回答「现在到底在干什么」。`agentId` 记的是这次实际要用
       * 的 Agent——没有可用 Agent 时它也会被记下来（见 app.ts 的回落），
       * 因为「谁都没得用」同样是一条需要被看见的事实。
       */
      type: 'plan.started';
      agentId: string;
    })
  | (BaseEvent & {
      /**
       * 拆解失败：这一轮没有图，也没有可以继续的对象。
       *
       * 与 `run.paused` 分开：暂停是可恢复的人为动作，失败是结论。界面据它
       * 给出「重新拆解」的入口，`deriveRunStatus` 据它派生 `failed`。
       */
      type: 'plan.failed';
      message: string;
      issues?: PlanIssue[];
    })
  | (BaseEvent & { type: 'run.paused' })
  | (BaseEvent & { type: 'run.resumed' })
  | (BaseEvent & { type: 'run.completed' })
  | (BaseEvent & { type: 'node.started'; nodeId: string })
  | (BaseEvent & { type: 'node.completed'; nodeId: string })
  | (BaseEvent & { type: 'node.failed'; nodeId: string; reason: string })
  | (BaseEvent & {
      /**
       * 节点被用户停下，不是失败。
       *
       * 为什么要与 `node.failed` 分开，而不是在 failed 上加个标记位：
       * - 两者的可恢复性完全相反。打断是人的决定，重放一次就能接着跑；
       *   失败是执行层的裁决，必须有人看。
       * - 投影层要清的东西也不同。失败要留 `failureReason` 与 `finishedAt`
       *   （「什么时候失败了、为什么」是排障必需）；打断要把它们全清掉，
       *   因为这一轮压根没有结局，留着它就会把节点挡在就绪集合外面。
       *
       * 参考实现把这件事拆成「进程退出了」与「这个 session 该被判定终止」两位，
       * 并写明「探测失败不是死亡的证明」。这里对称地成立：一次被掐断的执行
       * 不是失败，它只是还没跑完。
       */
      type: 'node.interrupted';
      nodeId: string;
      /** 为什么被打断（例如「运行被用户停止」），仅用于界面与审计 */
      reason: string;
    })
  | (BaseEvent & { type: 'node.reset'; nodeId: string; reason: string })
  | (BaseEvent & {
      /**
       * 用户通过对话明确要求改图，改动已生效。
       *
       * 为什么需要它，而不是复用 `node.reset`：
       * - `frozenAt` 的语义是「自动流程不许再动图」。它防的是 Planner 反复
       *   重拆、编排器自说自话地改结构，而不是防人。用户在运行详情页里下指令
       *   （「审查那个节点换成 codex」）本身就是一次显式授权，冻结对它无效。
       * - `node.reset` 的语义是「审查驳回，退回重做」：它清的是执行事实，
       *   图结构一动不动。用户改图恰恰只动结构、不动执行事实。
       * 两者都能改事实，但审计上必须能分开回答「这是机器回退的还是人改的」，
       * 所以走一条独立事件、独立记账。
       */
      type: 'dag.amended';
      /** 谁下的指令（X-Actor → body.actor → anonymous） */
      actor: string;
      /** 用户的自然语言指令原文，排障时要能回答「哪句话导致了这次改图」 */
      reason: string;
      /** 这次实际生效的改动；被拒的改动不进事件，只走接口返回值 */
      changes: DagAmendment[];
    })
  | (BaseEvent & { type: 'review.verdict'; nodeId: string; verdict: ReviewVerdict })
  | (BaseEvent & { type: 'review.escalated'; nodeId: string })
  | (BaseEvent & { type: 'approval.requested'; record: ApprovalRecord })
  | (BaseEvent & {
      type: 'approval.decided';
      approvalId: string;
      decision: ApprovalDecision;
      actor: string;
      reason?: string;
    })
  | (BaseEvent & {
      type: 'agent.output';
      nodeId: string;
      agentId: string;
      chunk: string;
      /**
       * 解析器给出的细分类型。老日志没有这个字段，读时按 text 处理，
       * 因此它只能是可选的——加必填字段等于让历史事件全部变成非法数据。
       */
      kind?: AgentEventKind;
      /** kind 为 tool 时的工具名，事件流要显示成「调用工具 X」 */
      toolName?: string;
    })
  | (BaseEvent & {
      /** 采集到 Agent 的原生会话 id。续跑要用，因此必须进事实而不是只走事件流。 */
      type: 'agent.session';
      nodeId: string;
      agentId: string;
      sessionId: string;
    })
  | (BaseEvent & {
      /**
       * 这一轮复用了上一轮的会话。
       *
       * 与 `agent.session` 是两个方向：那条是「平台告诉我们它是谁」（捕获），
       * 这条是「我们决定用谁」（复用）。合并成一条会让重放时分不清某个 id
       * 是捕获来的还是派生来的，而这两者的可信度完全不同。
       */
      type: 'node.resumed_session';
      nodeId: string;
      agentId: string;
      sessionId: string;
      /** 为什么能续跑（派生方式等），仅用于排障展示 */
      reason?: string;
    })
  | (BaseEvent & {
      /** 产物采集完成。只带统计量与落盘位置，diff 原文在文件里。 */
      type: 'node.artifact';
      nodeId: string;
      bytes: number;
      files: string[];
      /** diff 文件路径；工作区不可采集或存盘失败时缺省 */
      diffPath?: string;
    })
  | (BaseEvent & {
      /** 节点分支已汇入集成分支。只在真的合进去之后发，不预发。 */
      type: 'node.merged';
      nodeId: string;
      branch: string;
      /** 本次真的合进去的节点 id，顺序即合并顺序 */
      merged: string[];
    })
  | (BaseEvent & {
      /**
       * 合并冲突。
       *
       * 刻意不在这里写完成态：冲突的结论是「这次合并没有成功」，
       * 由编排器随后补一条 node.failed 把它钉死。事件各管一件事，
       * 重放时也不会出现「既冲突又完成」的矛盾事实。
       */
      type: 'node.merge_conflict';
      nodeId: string;
      branch: string;
      /** 冲突文件列表，来自 git 的 unmerged 路径 */
      conflicts: string[];
      reason: string;
    });

export type EventType = OrchestratorEvent['type'];

/* ------------------------------------------------------------------ *
 * 视图：API 返回形状，前端直接消费
 * ------------------------------------------------------------------ */

export interface RunView {
  id: string;
  title: string;
  /** 目标摘要：取目标的第一个段落，用于表格与卡片这种窄位置 */
  summary: string;
  /**
   * 完整目标原文（含调用方追加的补充要求）。
   *
   * summary 只截了首段，界面在需要让人看全「这次到底要做什么」时必须读它——
   * 否则用户只能看到一个被砍掉的目标，连自己写了哪些约束都看不到。
   */
  goal: string;
  status: RunStatus;
  stage: RunStage;
  /**
   * 这次运行的目标仓库绝对路径，透出给界面回答「成果会落在哪」。
   *
   * 空串表示旧日志（字段还没被写下来的那些运行），调用方不要把它当路径用。
   */
  workspaceRoot: string;
  /**
   * 拆解失败的原因。
   *
   * 透出到视图而不是让前端自己从事件流里捞：事件流是给人读的流水，文案随时
   * 会改；而「这个运行为什么没有图」是结构化的结论，界面要拿它渲染失败态。
   */
  planFailure?: PlanFailure;
  /** 已完成节点占比，读时算 */
  progress: number;
  nodeCount: number;
  specVersion: string;
  updatedAt: string;
}

export interface NodeView {
  id: string;
  title: string;
  description: string;
  type: NodeType;
  status: NodeStatus;
  /** 平台名，由 agentId 查目录得到 */
  agent: string;
  agentId?: string;
  dependsOn: string[];
  files: string[];
  attempts: number;
  durationMs?: number;
  escalated?: boolean;
  /**
   * 最近一次被停止的时刻，仅供展示（「已停止，待恢复」）。
   *
   * 刻意不影响 `status`：那个字段要回答的是「这个节点现在能不能被调度」，
   * 而被停下之后答案是「能」。见 `NodeStatus` 里 `'interrupted'` 的注释。
   */
  interruptedAt?: string;
  /** 上游产物的统计量；没有产物采集时缺省 */
  artifactBytes?: number;
  artifactFiles?: string[];
  /** 原生会话 id，透出给前端展示与「从这一轮续跑」的入口 */
  nativeSessionId?: string;
  /** 已合并所在的集成分支；没合成功过或缺省 */
  mergedBranch?: string;
}

export interface EdgeView {
  id: string;
  source: string;
  target: string;
  label?: string;
}

export interface EventView {
  id: string;
  at: string;
  type: 'stage' | 'agent' | 'review' | 'approval' | 'system';
  message: string;
  nodeId?: string;
  agent?: string;
  /**
   * agent 类事件的细分（text / thinking / status / tool / result / usage / session / error）。
   *
   * 与 `type` 正交：`type` 决定这一行归到哪个筛选页签，`kind` 只用于给同一
   * 页签里的条目加个更细的小标记，前端不该拿它做控制流。
   *
   * 例外是 `thinking`：它承载的是「这段文字的分量比正文轻」这件事，前端
   * 必须据此换一套渲染（muted + 折叠），否则模型的内部独白会和交付内容
   * 在视觉上完全平等。`status` 则相反——进度信号不进事件流，这里留着它
   * 只是为了让历史日志里的旧数据不被当成正文。
   */
  kind?: AgentEventKind;
  toolName?: string;
}

export interface RunDetailView extends RunView {
  nodes: NodeView[];
  edges: EdgeView[];
  events: EventView[];
}

export interface ApprovalView extends ApprovalRecord {
  runTitle: string;
  nodeTitle: string;
}

/* ------------------------------------------------------------------ *
 * 泳道：与看板四列一一对应，全部由节点视图推导
 * ------------------------------------------------------------------ */

export type BoardLane = 'working' | 'needs_you' | 'in_review' | 'ready';

export const boardLaneOrder: BoardLane[] = [
  'working',
  'needs_you',
  'in_review',
  'ready',
];

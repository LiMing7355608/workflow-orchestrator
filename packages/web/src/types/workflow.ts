export type RunStage = 'spec' | 'decompose' | 'orchestrate' | 'execute';

export type RunStatus =
  | 'running'
  | 'waiting_for_boss'
  | 'completed'
  | 'paused'
  | 'draft'
  /**
   * 拆解阶段就失败了：图从没生成，也没有任何节点可以跑。
   *
   * 与 `paused` 分成两个值：暂停是「随时能继续」，失败是「没有可以继续的对象」。
   * 后端只在「有拆解失败事实且图从未冻结」时给出这个值，见 core 的 deriveRunStatus。
   */
  | 'failed';

/** 拆解失败时带出来的一条具体问题 */
export interface PlanIssue {
  kind: string;
  message: string;
}

/**
 * 拆解失败的原因。
 *
 * 结构化的结论，不是事件流里的一句话：界面要拿它渲染失败态，文案不该被
 * 当成接口契约来依赖。
 */
export interface PlanFailure {
  at: string;
  message: string;
  issues?: PlanIssue[];
}

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
   * 后端不会把这个值放进 `status` 字段——它落的是 `interruptedAt`，而 status
   * 仍然给 ready/pending，因为节点必须还能被重新调度。这一份声明承载的是
   * 展示态：由 `displayNodeStatus` 在读取时算出来，见 lib/workflow-meta.ts。
   */
  | 'interrupted';

export interface WorkflowRunSummary {
  id: string;
  title: string;
  /** 目标摘要：只取首段，用于表格与卡片 */
  summary: string;
  /** 完整目标原文，含调用方追加的补充要求 */
  goal: string;
  status: RunStatus;
  stage: RunStage;
  progress: number;
  nodeCount: number;
  specVersion: string;
  updatedAt: string;
  /**
   * 最近一次拆解失败。
   *
   * 有值且节点为空，说明这个运行停在「没有图」的状态上：它需要人重新拆解，
   * 而不是继续推进。
   */
  planFailure?: PlanFailure;
}

export interface WorkflowNode {
  id: string;
  title: string;
  description: string;
  type: NodeType;
  status: NodeStatus;
  /** 执行者名称。有 agentId 时以 Agent 目录里的平台名为准 */
  agent: string;
  /** 绑定的可调度 Agent id；人类审批与编排器节点为空 */
  agentId?: string;
  dependsOn: string[];
  files: string[];
  attempts: number;
  durationMs?: number;
  /**
   * 最近一次被用户停止的时刻。
   *
   * 有值时状态多半仍是 ready：后端刻意不把「被停止」做成会挡住调度的状态值，
   * 否则点「继续」也调度不到它。界面要显示「已停止，待恢复」就读这个字段
   * （见 displayNodeStatus）。
   */
  interruptedAt?: string;
  /** 失败原因。挂在节点上而不是只在事件里，卡片与面板才能直接说清为什么红 */
  failureReason?: string;
}

export interface WorkflowEdge {
  id: string;
  source: string;
  target: string;
  label?: string;
}

/**
 * Agent 输出的细分类型，与后端 `AgentEventKind` 一一对应。
 *
 * 前端刻意不引 `@orchestrator/core` 的类型：两边各留一份声明，后端加字段时
 * 这里只是少一个标记，不会让整页编译不过。
 *
 * `thinking` 是「分量更轻的文字」，`status` 是「不是文字」——后者后端不发，
 * 留着它只是为了历史数据不被当成正文渲染。
 */
export type AgentEventKind =
  | 'text'
  | 'thinking'
  | 'status'
  | 'tool'
  | 'result'
  | 'usage'
  | 'session'
  | 'error';

export interface WorkflowEvent {
  id: string;
  at: string;
  type: 'stage' | 'agent' | 'review' | 'approval' | 'system';
  message: string;
  nodeId?: string;
  agent?: string;
  /** agent 类事件的细分标记；老事件没有这个字段 */
  kind?: AgentEventKind;
  /** kind 为 tool 时的工具名 */
  toolName?: string;
}

export interface WorkflowRunDetail extends WorkflowRunSummary {
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  events: WorkflowEvent[];
  /**
   * 编排器会话：用户 / 编排器 / 系统行，后端按时刻排好。
   *
   * 它是运行详情的一部分而不是另开一个接口，理由见后端 core 的
   * `RunDetailView.conversation`：面板打开时第一屏就要它。
   */
  conversation: ConversationEntry[];
  /**
   * 每个节点自己的会话，键是 nodeId；没有会话的节点不在这个表里。
   *
   * 与 `conversation` 一并返回而不是再开一个接口：节点面板要的第一屏同样是
   * 「这个节点这一路是怎么干的」，多一次往返就多一次会失败、会晚到的请求，
   * 而它派的还是同一批事件。
   */
  nodeConversations: Record<string, ConversationEntry[]>;
}

/**
 * 会话流里的一条。
 *
 * 与后端 core 的 `ConversationEntry` 一一对应，刻意各留一份声明（理由同
 * `AgentEventKind`）：后端加字段时这里只是少一个标记，不会让整页编译不过。
 */
export interface ConversationEntry {
  id: string;
  at: string;
  /**
   * `agent` 只出现在节点会话里：它是编排器替节点执行者记的一句回执
   * （「已按新要求重启」），或者这一轮执行里被归到轮次下面的东西。
   * 编排器会话永远不会给这个值。
   */
  role: 'user' | 'orchestrator' | 'agent' | 'system';
  text: string;
  /** 系统行的色调：阶段变化是 info，失败是 warning，图生成成功是 success */
  tone?: 'info' | 'warning' | 'success';
  /** 这条是用户在拆解中途插的话，界面要标出来 */
  interrupt?: boolean;
  /**
   * 这次拆解过程中 Agent 的输出（思考、工具调用、正文）。
   *
   * 默认收起，展开才看——它可能有几十步，一直铺开会把整段对话冲散。
   */
  outputs?: ConversationOutput[];
}

/** 拆解过程中的一句输出。 */
export interface ConversationOutput {
  id: string;
  at: string;
  kind?: string;
  text: string;
  toolName?: string;
}

/**
 * 一次图结构改动的回显。
 *
 * 与后端 `DagAmendment` 保持同一形状（这里刻意不复用 core 的类型，理由见
 * `AgentEventKind` 的注释：前端宁愿少一个字段，也不愿因为跨包类型变更而整页编译不过）。
 */
export interface DagAmendment {
  kind: 'update-node' | 'add-node' | 'remove-node';
  nodeId: string;
  /** 改了哪些字段、新旧值各是什么；add-node 时是新节点的关键字段 */
  fields?: Array<{ field: string; from?: string; to?: string }>;
}

/** 被拒绝的改动：为什么没改成，逐条说清 */
export interface AmendmentRejection {
  nodeId: string;
  reason: string;
}

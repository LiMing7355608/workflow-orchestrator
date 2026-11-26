/**
 * @orchestrator/core —— 编排内核。
 *
 * 三层职责，严格单向依赖：
 *   OBSERVE  外部事实经事件进入日志（journal）
 *   UPDATE   事件归约成持久事实（reduce），展示状态不入库
 *   DERIVE   读取时计算视图、进度与泳道（derive / scheduler）
 *
 * 本包不引入任何 Node 内置模块，前端可以直接打包同一份类型与 Agent 目录。
 */

export type {
  ApprovalDecision,
  ApprovalRecord,
  ApprovalStatus,
  ApprovalView,
  BaseEvent,
  BoardLane,
  ConversationEntry,
  DagAmendment,
  EdgeView,
  EventType,
  EventView,
  NodeFacts,
  NodeStatus,
  NodeType,
  NodeView,
  OrchestratorEvent,
  PlanFailure,
  PlanIssue,
  ProjectState,
  ReviewVerdict,
  RunDetailView,
  RunFacts,
  RunRole,
  RunStage,
  RunStatus,
  RunView,
  SavedTaskFiles,
  TaskDeliverable,
} from './types.js';

export { boardLaneOrder } from './types.js';
export { isWorkspaceFilePath } from './workspace-file.js';

export {
  deriveBoard,
  deriveConversation,
  deriveEdges,
  deriveEvents,
  deriveNodeConversation,
  deriveNodeStatus,
  deriveNodeView,
  deriveNodes,
  deriveProgress,
  deriveRunDetail,
  deriveRunStatus,
  deriveRunView,
  deriveUpdatedAt,
} from './derive.js';

export type { AgentLabelResolver, BoardCardView } from './derive.js';

export {
  DEFAULT_CONCURRENCY,
  filesConflict,
  isRunSettled,
  pendingHumanWork,
  pickBatch,
  readyNodes,
  shouldEscalate,
} from './scheduler.js';

export {
  DEFAULT_AGENT_PROFILES,
  buildAgentArgv,
  findAgent,
  findAgentByLabel,
} from './agents.js';

export type {
  AgentAvailability,
  AgentCapabilities,
  AgentConfigFile,
  AgentLaunchSpec,
  AgentParserId,
  AgentProfile,
  AgentSessionSpec,
  AgentTransport,
  PermissionPolicy,
  SessionDerive,
} from './agents.js';

export { EventBus, emptyState, reduce, replay } from './journal.js';

export type { EventListener } from './journal.js';

export { createParser } from './parsers.js';

export type {
  AgentEvent,
  AgentEventKind,
  AgentOutputParser,
  AgentUsage,
} from './parsers.js';

export { resolveSession } from './session.js';

export type { SessionResolution } from './session.js';

export {
  advanceRun,
  createAgentEventRelay,
  nodeInFlightKey,
  parseVerdict,
  reworkTarget,
  runNode,
  runSingleNode,
} from './orchestrator.js';

export type {
  AdvanceDeps,
  AdvanceResult,
  AdvanceStopReason,
  RunNodeResult,
} from './orchestrator.js';

export type {
  AgentCancelRequest,
  AgentRunRequest,
  AgentRunResult,
  AgentRunner,
  MergeRequest,
  MergeResult,
  NodeArtifact,
  WorkspacePort,
} from './execution.js';

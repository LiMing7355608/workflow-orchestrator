import type { AgentProfile } from '../types/agent';
import type { ActivityView, BlackboardView, InterviewView, MeetingSettings, MeetingSummary, MeetingView, PlanDraftView } from '../types/operations';
import type {
  AmendmentRejection,
  ConversationEntry,
  DagAmendment,
  WorkflowEvent,
  WorkflowRunDetail,
  WorkflowRunSummary,
} from '../types/workflow';
import { getActor } from './identity';

/**
 * 后端接口封装。
 *
 * 全部函数在失败时返回 null 而不抛异常——调用方据此决定回落静态数据，
 * 这样没起后端时页面照样能看，不会整页白屏。
 */

const API_BASE = '';

async function operation<T>(path: string, method: 'GET' | 'POST' | 'DELETE', body?: unknown): Promise<T> {
  const response = await fetch(API_BASE + path, {
    method,
    headers: {
      Accept: 'application/json',
      'X-Actor': encodeURIComponent(getActor()),
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await response.json().catch(() => null) as (T & { message?: string }) | null;
  if (!response.ok || !data) throw new Error(data?.message ?? '操作失败，请检查本地服务后重试。');
  return data;
}

export function startInterview(idea: string, workspaceRoot: string, agentId: string, model?: string) {
  return operation<InterviewView>('/api/specs', 'POST', { idea, workspaceRoot, agentId, model });
}

export function fetchInterview(workspaceRoot: string, id: string, signal?: AbortSignal) {
  const query = new URLSearchParams({ workspaceRoot });
  return requestJson<InterviewView>('/api/specs/' + encodeURIComponent(id) + '?' + query, { signal });
}

export function submitInterviewAnswer(session: InterviewView, answer?: string) {
  return operation<InterviewView>('/api/specs/' + encodeURIComponent(session.id) + '/answer', 'POST', {
    workspaceRoot: session.workspaceRoot, revision: session.revision, answer,
  });
}

export function deleteRun(id: string) {
  return operation<{ ok: boolean }>('/api/runs/' + encodeURIComponent(id), 'DELETE');
}

export function fetchBlackboard(id: string) {
  return requestJson<BlackboardView>('/api/runs/' + encodeURIComponent(id) + '/blackboard');
}

export function postBlackboard(id: string, text: string) {
  return operation<BlackboardView['entries'][number]>('/api/runs/' + encodeURIComponent(id) + '/blackboard', 'POST', { text });
}

export function fetchPlanDraft(id: string, signal?: AbortSignal) {
  return requestJson<PlanDraftView>('/api/runs/' + encodeURIComponent(id) + '/plan-review', { signal });
}

export function confirmPlanDraft(id: string, revision: string) {
  return operation<{ ok: boolean }>('/api/runs/' + encodeURIComponent(id) + '/plan-review/approve', 'POST', { revision });
}

export function fetchMeetings(signal?: AbortSignal) {
  return requestJson<MeetingSummary[]>('/api/meetings', { signal });
}

export function fetchMeeting(id: string, signal?: AbortSignal) {
  return requestJson<MeetingView>('/api/meetings/' + encodeURIComponent(id), { signal });
}

export function createMeeting(settings: MeetingSettings & { workspaceRoot: string }) {
  return operation<MeetingView>('/api/meetings', 'POST', settings);
}

export function updateMeeting(id: string, settings: MeetingSettings & { revision: number }) {
  return operation<MeetingView>('/api/meetings/' + encodeURIComponent(id) + '/settings', 'POST', settings);
}

export function meetingAction(id: string, action: 'organize' | 'discuss' | 'summarize' | 'pause') {
  return operation<MeetingView>('/api/meetings/' + encodeURIComponent(id) + '/' + action, 'POST');
}

export function sendMeetingNote(id: string, text: string) {
  return operation<MeetingView>('/api/meetings/' + encodeURIComponent(id) + '/note', 'POST', { text });
}

export function fetchAgentActivity() {
  return requestJson<ActivityView>('/api/agents/activity');
}

async function requestJson<T>(
  path: string,
  init?: RequestInit,
): Promise<T | null> {
  try {
    // 用 Headers 而不是内联对象：把 init.headers 一并继承下来，
    // 将来某个调用点自带请求头时不会因为展开顺序把身份头整片覆盖掉
    const headers = new Headers(init?.headers);
    headers.set('Accept', 'application/json');
    // 每个请求都带上当前身份：后端按 X-Actor → body.actor → anonymous 的顺序解析。
    // 头里只能放 latin-1，中文名字必须先编码——直接塞会让 Headers.set 抛
    // TypeError，而那个异常会被这里吞掉，表现为「所有接口都失败」。
    headers.set('X-Actor', encodeURIComponent(getActor()));
    if (init?.body) {
      headers.set('Content-Type', 'application/json');
    }

    const response = await fetch(`${API_BASE}${path}`, { ...init, headers });
    if (!response.ok) {
      return null;
    }
    return (await response.json()) as T;
  } catch {
    return null;
  }
}

export function fetchRuns(): Promise<WorkflowRunSummary[] | null> {
  return requestJson<WorkflowRunSummary[]>('/api/runs');
}

export function fetchRunDetail(
  runId: string,
): Promise<WorkflowRunDetail | null> {
  return requestJson<WorkflowRunDetail>(`/api/runs/${encodeURIComponent(runId)}`);
}

export interface CreateRunInput {
  title: string;
  goal: string;
  specId?: string;
  reviewPlan?: boolean;
  requireDeliverables?: boolean;
  specSettings?: { granularity: 'coarse' | 'medium' | 'fine'; reviewRounds: number };
  /** 省略时由 Planner 现生成；给出则跳过规划直接冻结 */
  dag?: unknown;
  /**
   * 这次运行在哪儿干活：目标仓库的绝对路径。
   *
   * 省略时后端按 `AGENT_TARGET_DIR` → 服务启动目录回落。给了就必须可用：
   * 路径不存在或不是 git 仓库时后端返回 400，绝不静默换成默认目录
   * （用户填错路径却在他自己的目录里跑，是最糟的失败方式）。
   */
  workspaceRoot?: string;
  /** 拆图用哪个 Agent */
  plannerAgentId?: string;
  /** 覆盖 DAG 里的实现节点 Agent */
  implementAgentId?: string;
  /** 覆盖 DAG 里的审查节点 Agent */
  reviewAgentId?: string;
  /**
   * 这次运行允许同时跑几个节点。
   *
   * 省略时按服务级配置。给了就是运行自己的属性：调度器一次派发的节点数
   * 直接按它来，而不是永远按服务的缺省值排队。
   */
  concurrency?: number;
}

/** 当前执行配置：真实执行器还是回放。 */
export interface RuntimeInfo {
  runner: string;
  workspace: string;
  concurrency: number;
  plannerAgentId: string | null;
  /**
   * 服务级默认目标目录，没有配置就是 null。
   *
   * null 表示「必须由用户自己选」——前端不要预填任何东西。
   */
  defaultWorkspaceRoot: string | null;
  /** 只有 Windows 才提供原生目录选择框，前端据此决定要不要显示「浏览…」 */
  canPickDirectory: boolean;
}

export function fetchRuntime(): Promise<RuntimeInfo | null> {
  return requestJson<RuntimeInfo>('/api/runtime');
}

export interface PickDirectoryResult {
  /** 用户选了路径。取消或失败时为 false */
  picked: boolean;
  path?: string;
  /** 失败原因，例如「只在 Windows 上提供」 */
  reason?: 'cancelled' | 'unsupported' | 'failed';
  message?: string;
}

/**
 * 弹原生的目录选择框。
 *
 * 必须是后端弹：浏览器的 File System Access API 只给 handle，拿不到绝对路径，
 * 而编排器要的正是能传给 git 的绝对路径。
 */
export function pickDirectory(): Promise<PickDirectoryResult | null> {
  return requestJson<PickDirectoryResult>('/api/fs/pick-directory');
}

export interface CreateRunResult extends WorkflowRunDetail {
  /**
   * 规划摘要。
   *
   * 拆解改成异步之后它恒为 `null`：图是在这个响应返回之后才生成的，
   * 摘要没有地方可以随响应带出来。字段留着是为了不改变响应形状。
   */
  plan?: {
    attempts: number;
    agentId: string;
    agentLabel: string;
    issues: unknown[];
  } | null;
}

/**
 * 创建失败的形状。
 *
 * 拆解失败不再走这里——它发生在响应返回之后，以 `plan.failed` 事件的形式
 * 进事实，由详情页呈现。这里保留 `issues` / `attempts` 是为了兼容只可能
 * 出现在旧后端上的两条错误码（`plan_rejected` / `planner_failed`）。
 */
export interface CreateRunFailure {
  error: string;
  message?: string;
  issues?: unknown[];
  attempts?: number;
}

export type CreateRunOutcome =
  | { ok: true; run: CreateRunResult }
  | { ok: false; failure: CreateRunFailure };

/**
 * 创建运行。
 *
 * 后端已经把「拆解」挪到后台：这个请求只负责落一条 `run.created` 就返回，
 * 拿到 `id` 就可以跳转，不必等图。所以这里不再需要像以前那样为 422 的
 * 校验问题单独铺一条展示路径——真正的失败会以事件形式到达详情页。
 *
 * 仍然不走通用的 requestJson：body 不合法（400）时后端会带上具体字段问题，
 * 那是「为什么没建成」的唯一解释，不能在失败分支上丢掉。
 */
export async function createRun(
  input: CreateRunInput,
): Promise<CreateRunOutcome> {
  try {
    const response = await fetch(`${API_BASE}/api/runs`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        // 与 requestJson 保持同一约定：头里只放编码后的名字
        'X-Actor': encodeURIComponent(getActor()),
      },
      body: JSON.stringify(input),
    });
    const payload = (await response.json().catch(() => undefined)) as
      | CreateRunResult
      | CreateRunFailure
      | undefined;

    if (!response.ok || !payload) {
      return {
        ok: false,
        failure:
          (payload as CreateRunFailure | undefined) ?? {
            error: `http_${response.status}`,
          },
      };
    }
    return { ok: true, run: payload as CreateRunResult };
  } catch (error) {
    return {
      ok: false,
      failure: { error: 'network', message: (error as Error).message },
    };
  }
}

export function fetchAgents(): Promise<AgentProfile[] | null> {
  return requestJson<AgentProfile[]>('/api/agents');
}

export function probeAgents(): Promise<AgentProfile[] | null> {
  return requestJson<AgentProfile[]>('/api/agents/probe', { method: 'POST' });
}

/** 后端认定当前请求的审批人是谁。用于核对本地身份是否被网关注入的头覆盖。 */
export function fetchIdentity(): Promise<{ actor: string } | null> {
  return requestJson<{ actor: string }>('/api/identity');
}

export function pauseRun(runId: string): Promise<unknown> {
  return requestJson(`/api/runs/${encodeURIComponent(runId)}/pause`, {
    method: 'POST',
  });
}

export function resumeRun(runId: string): Promise<unknown> {
  return requestJson(`/api/runs/${encodeURIComponent(runId)}/resume`, {
    method: 'POST',
  });
}

/**
 * 重试失败的节点。
 *
 * 执行阶段卡死的运行不能靠「继续」恢复：没有就绪节点可调度。这个接口把
 * 失败的节点重置回可调度状态，再推进一次。
 */
export function retryFailedNodes(runId: string): Promise<unknown> {
  return requestJson(`/api/runs/${encodeURIComponent(runId)}/retry-failed`, {
    method: 'POST',
  });
}

/**
 * 强制停止的结果。
 *
 * `cancelledAgents` 是后端**确认**终止的 Agent 数量，不是「发过几次终止请求」：
 * 这个区别决定提示文案能不能说「已停止」。所以成功与失败要分开看——
 * 请求失败（null）时组件只说「停止请求没有成功」，绝不说停止已生效。
 */
export interface StopRunResult {
  ok: boolean;
  cancelledAgents: number;
  status: string;
}

export function stopRun(runId: string): Promise<StopRunResult | null> {
  return requestJson<StopRunResult>(
    `/api/runs/${encodeURIComponent(runId)}/stop`,
    { method: 'POST' },
  );
}

export interface ApprovalDecisionInput {
  decision: 'approve' | 'reject' | 'handoff';
  actor: string;
  reason?: string;
  handoffTo?: string;
}

export async function decideApproval(
  runId: string,
  nodeId: string,
  input: ApprovalDecisionInput,
): Promise<{ ok: true } | { ok: false; message: string }> {
  const fallback = '审批没有提交，请检查后端连接。';
  try {
    const response = await fetch(
      `/api/runs/${encodeURIComponent(runId)}/nodes/${encodeURIComponent(nodeId)}/approval`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
      },
    );
    if (response.ok) {
      return { ok: true };
    }
    const body = await response.json() as { message?: string };
    return { ok: false, message: body.message ?? fallback };
  } catch {
    return { ok: false, message: fallback };
  }
}

/* ------------------------------------------------------------------ *
 * 节点级控制：单跑 / 停止 / 重置
 *
 * 粒度细到单个节点，是因为「整轮跑完再看」与「先跑这一个」是两种不同的
 * 工作节奏。为了重跑一个节点去新建一次运行，代价是把前面的执行事实全丢掉。
 * ------------------------------------------------------------------ */

/**
 * 节点级动作的公共实现。
 *
 * 只回一个布尔：false 同时覆盖「后端拒绝（409，该节点正在执行）」与
 * 「后端没响应」。两者对用户的可执行动作是同一个——等一会儿再点，
 * 所以不在这里分叉；抛异常则会让每个调用点各写一份 try。
 */
async function postNodeAction(
  runId: string,
  nodeId: string,
  action: 'run' | 'stop' | 'reset',
): Promise<boolean> {
  const result = await requestJson<unknown>(
    `/api/runs/${encodeURIComponent(runId)}/nodes/${encodeURIComponent(nodeId)}/${action}`,
    { method: 'POST' },
  );
  return result !== null;
}

/** 只跑这一个节点，不等整轮编排。 */
export function runNode(runId: string, nodeId: string): Promise<boolean> {
  return postNodeAction(runId, nodeId, 'run');
}

/** 只停这一个节点的 Agent 进程：不动整轮运行的状态。 */
export function stopNode(runId: string, nodeId: string): Promise<boolean> {
  return postNodeAction(runId, nodeId, 'stop');
}

/** 退回重做：清掉这一轮的执行事实，让它能被重新派发。 */
export function resetNode(runId: string, nodeId: string): Promise<boolean> {
  return postNodeAction(runId, nodeId, 'reset');
}

/** 节点产物：diff 原文 + 统计量。统计量由后端按返回的 diff 现算。 */
export interface NodeArtifactView {
  diff: string;
  files: string[];
  bytes: number;
}

/**
 * 取某个节点落盘的产物 diff。
 *
 * 没有产物时后端给 404，这里与网络失败一样返回 null——组件据此显示
 * 「该节点没有产出变更」这条降级文案，而不是弹错误。
 */
export function fetchNodeArtifact(
  runId: string,
  nodeId: string,
): Promise<NodeArtifactView | null> {
  return requestJson<NodeArtifactView>(
    `/api/runs/${encodeURIComponent(runId)}/nodes/${encodeURIComponent(nodeId)}/artifact`,
  );
}

/**
 * 取某个节点的事件。
 *
 * 详情面板的执行输出走内存过滤（run.events 里已有同一批视图，且随 SSE
 * 自动更新），这条接口是给外部调用与将来的分页留的，面板本身不用它。
 */
export function fetchNodeEvents(
  runId: string,
  nodeId: string,
): Promise<WorkflowEvent[] | null> {
  return requestJson<WorkflowEvent[]>(
    `/api/runs/${encodeURIComponent(runId)}/nodes/${encodeURIComponent(nodeId)}/events`,
  );
}

/* ------------------------------------------------------------------ *
 * 编排器对话
 * ------------------------------------------------------------------ */

export interface AmendmentInput {
  text: string;
  /** 省略时后端按请求头里的身份记账 */
  actor?: string;
}

/**
 * 一次对话的结果。
 *
 * `applied` / `rejected` 都由后端算出，界面只负责铺开——「实际改了什么」
 * 不能让前端猜，也不该让模型复述：唯一权威的答案就是真正落地的那几条。
 */
export interface AmendmentResult {
  reply: string;
  applied: DagAmendment[];
  rejected: AmendmentRejection[];
  /**
   * 后端随响应带回落库之后的完整会话。
   *
   * 面板本身以重新拉取的 `run.conversation` 为唯一来源（见 OrchestratorPanel
   * 的注释：两份对话状态迟早会分叉），这个字段留给「只要会话、不关心图」的
   * 调用方，也用来核对这条回复确实已经落进事实。
   */
  conversation?: ConversationEntry[];
  /**
   * 指令没有落成改动时的错误码（`instruction_rejected` / `planner_failed` /
   * `run_not_found`…）。此时 `reply` 里是后端给的可读原因。
   *
   * 单独留一个字段而不是只靠 `reply` 的文案，是为了界面能把「拒绝」和
   * 「改了 0 处」这两种结局区分开：前者要说清为什么，后者是正常结论。
   */
  failure?: string;
  /** 后端给出的校验问题（只有 422 会带） */
  issues?: unknown[];
}

/**
 * 给编排器下一句指令。
 *
 * 不走通用 `requestJson`：指令被拒时后端在 422 里给了原因与校验问题，
 * 那是用户唯一能知道「为什么没改成」的信息，不能在失败分支上丢掉。
 * 返回 null 只代表网络层失败（后端没起、断网），与「指令被拒」不是一回事。
 */
export async function sendOrchestratorMessage(
  runId: string,
  input: AmendmentInput,
): Promise<AmendmentResult | null> {
  try {
    const response = await fetch(
      `${API_BASE}/api/runs/${encodeURIComponent(runId)}/messages`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          // 与其余写接口同一约定：头里只放编码后的名字
          'X-Actor': encodeURIComponent(getActor()),
        },
        body: JSON.stringify(input),
      },
    );

    const payload = (await response.json().catch(() => undefined)) as
      | (AmendmentResult & { error?: string; message?: string })
      | undefined;

    if (!response.ok || !payload) {
      return {
        reply:
          payload?.message ?? '指令没有生效：后端拒绝了这次请求。',
        applied: [],
        rejected: [],
        failure: payload?.error ?? `http_${response.status}`,
        issues: payload?.issues,
        // 失败路径也会带会话：用户那句话与编排器的解释都已经落库了
        conversation: payload?.conversation,
      };
    }

    return {
      reply: payload.reply,
      applied: payload.applied ?? [],
      rejected: payload.rejected ?? [],
      conversation: payload.conversation,
    };
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ *
 * 节点会话：对单个节点说一句话
 * ------------------------------------------------------------------ */

/**
 * 对某个节点说一句话的结果。
 *
 * `interrupted` 决定界面该说什么：true 是「打断了正在跑的那一轮，已按新要求
 * 重启」；false 是「记下了，下次运行该节点时生效」。这两句话对用户意味着
 * 完全不同的下一步，所以由后端判、前端不复述。
 */
export interface NodeMessageResult {
  ok: boolean;
  interrupted: boolean;
  /** 后端写下的回执原文，同时也会以 agent 消息落进会话 */
  reply: string;
  /** 落库之后的节点会话，界面用它立刻替换掉当前那份 */
  conversation: ConversationEntry[];
}

/**
 * 给节点发一句话。
 *
 * 不走通用 `requestJson`：404（运行/节点不存在）与 400（空消息）都会带上
 * `error` 码，那是「为什么没发出去」的唯一依据，不能在失败分支上丢掉。
 * 返回 null 只代表网络层失败。
 */
export async function sendNodeMessage(
  runId: string,
  nodeId: string,
  input: { text: string; actor?: string },
): Promise<NodeMessageResult | null> {
  try {
    const response = await fetch(
      `${API_BASE}/api/runs/${encodeURIComponent(runId)}/nodes/${encodeURIComponent(nodeId)}/messages`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          // 与其余写接口同一约定：头里只放编码后的名字
          'X-Actor': encodeURIComponent(getActor()),
        },
        body: JSON.stringify(input),
      },
    );

    const payload = (await response.json().catch(() => undefined)) as
      | (NodeMessageResult & { error?: string; message?: string })
      | undefined;

    if (!response.ok || !payload) {
      return null;
    }

    return {
      ok: payload.ok,
      interrupted: payload.interrupted === true,
      reply: payload.reply,
      conversation: payload.conversation ?? [],
    };
  } catch {
    return null;
  }
}

/** SSE 负载：服务端把事实事件与已翻译好的视图一起发过来。 */
export interface RunEventPayload {
  runId: string;
  event?: WorkflowEvent;
}

/**
 * 订阅事件流。`onEvent` 可能被高频调用，调用方自己决定要不要防抖。
 * 返回取消订阅函数。
 */
export function subscribeRunEvents(
  onEvent: (payload: RunEventPayload) => void,
): () => void {
  if (typeof EventSource === 'undefined') {
    return () => {};
  }

  const source = new EventSource(`${API_BASE}/events`);
  source.onmessage = (message) => {
    try {
      onEvent(JSON.parse(message.data) as RunEventPayload);
    } catch {
      // 心跳或格式异常直接忽略
    }
  };

  return () => {
    source.close();
  };
}

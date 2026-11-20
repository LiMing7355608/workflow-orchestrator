/**
 * 执行层端口。
 *
 * 编排器不关心 Agent 是子进程、HTTP 还是本地回放，也不关心工作区是
 * git worktree 还是临时目录——只认这里的几个端口。这样调度逻辑可以完全
 * 在没有真实进程的情况下被测试。
 */

import type { PermissionPolicy } from './agents.js';

export interface AgentRunRequest {
  runId: string;
  nodeId: string;
  agentId: string;
  /** 可执行文件名 */
  bin: string;
  /** 已经组装好、不需要再经过 shell 的参数 */
  argv: string[];
  /** 走 stdin 的提示词；Agent 从命令行读提示词时为 undefined */
  stdin?: string;
  /** 节点独占的工作目录 */
  cwd: string;
  timeoutMs: number;
  /** 权限档位。审查节点固定用 default，不追加任何提权参数 */
  policy: PermissionPolicy;
  /** Explicit model selection for transports that negotiate it outside argv. */
  model?: string;
  /** Optional for short structured turns on clients that expose an effort selector. */
  reasoningEffort?: 'low';
  /**
   * 要接着哪个会话继续跑。
   *
   * CLI 那条路一直靠 argv 传（`--resume <id>`），所以这个字段在那条路上是
   * 冗余的；但「走 SDK / 走协议」的几条路根本不看 argv——它们的会话是协议
   * 层面的对象，只能通过参数告诉它们。没有这个字段，那几条路的续跑就是空话：
   * 编排器明明算出了 id、还落了 `node.resumed_session` 事件，实际却是全新会话。
   *
   * 缺省表示「开一个新的」。
   */
  sessionId?: string;
  signal?: AbortSignal;
}

export interface AgentRunResult {
  ok: boolean;
  exitCode: number | null;
  /** 汇总后的输出，用于审查裁决解析与失败原因 */
  output: string;
  error?: string;
  /** 是否因为超时被终止 */
  timedOut?: boolean;
  /**
   * 是否因为外部终止（用户点了「停止」）而结束。
   *
   * 与 `timedOut` 分开：超时是 Agent 自己的问题，取消是人的决定。
   * 两者都 `ok: false`，但「谁让它停的」决定了看板上该说哪句话，
   * 所以不能合并成一个布尔。
   */
  cancelled?: boolean;
}

/**
 * 终止请求。
 *
 * `nodeId` 可选：给节点是「只停这一个」，不给就是「这个运行里的全停」。
 * 语义上没有第三个维度——终止永远按运行隔离，绝不跨 run 误杀。
 */
export interface AgentCancelRequest {
  runId: string;
  nodeId?: string;
}

export interface AgentRunner {
  /** 执行一次 Agent，过程中把增量输出回传。 */
  run(
    request: AgentRunRequest,
    onChunk: (chunk: string) => void,
  ): Promise<AgentRunResult>;
  /**
   * 终止某个运行（或某个节点）正在执行的 Agent。
   *
   * 做成可选方法：回放器、HTTP 执行器之类的实现未必有「进程」可停，
   * 调用方必须容忍它不存在，并且不能因此假装终止成功。
   *
   * 返回值是**实际**终止的数量，不是「发出了多少次终止请求」——护栏在
   * 实现方：只有确认目标已经不再执行，才允许把它算进去。宣称停掉了但
   * 进程还在跑，是终止路径上最坏的一种谎。
   */
  cancel?(request: AgentCancelRequest): Promise<number>;
}

/**
 * 节点产物：一次执行在工作区里留下的改动快照。
 *
 * 只带统一 diff 文本与统计量，diff 原文由调用方自行落盘——
 * 事件日志里只放 bytes / files，否则日志会被 diff 撑爆。
 */
export interface NodeArtifact {
  /** 统一 diff 文本，可能为空（工作区不是 git 仓库，或节点什么都没改） */
  diff: string;
  /** 改动到的路径 */
  files: string[];
  /** diff 字节数（按 UTF-8 计），用于判断该不该在提示词里全文嵌入 */
  bytes: number;
  capturedAt: string;
}

/**
 * 一次合并请求。
 *
 * 刻意不在这里决定「合到哪」的策略：目标分支名由调用方给，
 * 内核只是把请求原样转交给工作区实现。这样 git 工作区能合到
 * `run/<runId>`，将来若出现别的版本化实现，也能用它自己的命名规则。
 */
export interface MergeRequest {
  runId: string;
  /** 参与合并的节点分支，按顺序合并 */
  nodeIds: string[];
  /** 合并目标分支名，由调用方决定 */
  targetBranch: string;
}

/**
 * 合并结果。
 *
 * 冲突不是异常：它是「部分成功」的正常结局，必须能把已经合进去的
 * 节点如实报出来，否则重试时调用方只能整批重来，分不清谁进了谁没进。
 */
export type MergeResult =
  | { ok: true; branch: string; merged: string[]; commit?: string }
  | { ok: false; branch: string; conflicts: string[]; merged: string[]; reason: string };

/**
 * 工作区端口：为节点准备独立工作目录。
 *
 * 一个实例只服务一个目标仓库——不同运行可能指向完全不同的仓库，所以编排器
 * 拿到的不是「全局唯一的工作区」，而是「按运行取工作区」的工厂，
 * 见 `AdvanceDeps.workspaceFor`。
 */
export interface WorkspacePort {
  /** 为节点准备独立工作目录，返回绝对路径。必须在 Agent 启动之前完成。 */
  prepare(runId: string, nodeId: string, upstreamIds?: string[]): Promise<string>;
  /** 提交节点改动并保留分支，供下游节点读取。 */
  publish?(runId: string, nodeId: string): Promise<string | void>;
  /** 释放工作目录。清理失败不应让编排器崩溃。 */
  release(runId: string, nodeId: string): Promise<void>;
  /**
   * 采集节点产物。
   *
   * 刻意做成可选方法：只有基于 git 的工作区才谈得上「改动」，
   * 临时目录实现没有基线可比，调用方必须容忍它不存在。
   * 实现方也不该抛异常——采集失败只意味着拿不到 diff，
   * 不能因此把一次成功的执行判成失败。
   */
  capture?(runId: string, nodeId: string): Promise<NodeArtifact>;
  /**
   * 把若干节点分支合并到目标分支。
   *
   * 与 capture 同理做成可选：临时目录工作区根本没有版本历史，
   * 「合并」对它没有意义。调用方必须显式处理「没有这个方法」的情况，
   * 并把它当成失败上报——不能因为缺方法就假装合并成功。
   * 实现方同样不该抛异常：git 的每一种失败都要落成结构化的 MergeResult。
   */
  merge?(request: MergeRequest): Promise<MergeResult>;
}

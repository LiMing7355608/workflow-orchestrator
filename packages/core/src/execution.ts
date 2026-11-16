/**
 * 执行层端口。
 *
 * 编排器不关心 Agent 是子进程、HTTP 还是本地回放，也不关心工作区是
 * git worktree 还是临时目录——只认这三个接口。这样调度逻辑可以完全
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
}

export interface AgentRunResult {
  ok: boolean;
  exitCode: number | null;
  /** 汇总后的输出，用于审查裁决解析与失败原因 */
  output: string;
  error?: string;
  /** 是否因为超时被终止 */
  timedOut?: boolean;
}

export interface AgentRunner {
  /** 执行一次 Agent，过程中把增量输出回传。 */
  run(
    request: AgentRunRequest,
    onChunk: (chunk: string) => void,
  ): Promise<AgentRunResult>;
}

export interface WorkspacePort {
  /** 为节点准备独立工作目录，返回绝对路径。必须在 Agent 启动之前完成。 */
  prepare(runId: string, nodeId: string): Promise<string>;
  /** 释放工作目录。清理失败不应让编排器崩溃。 */
  release(runId: string, nodeId: string): Promise<void>;
}

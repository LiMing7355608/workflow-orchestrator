/**
 * 外部 Agent 的声明式适配。
 *
 * 接一个平台不需要写代码，只需要一条 profile：
 * 可执行文件叫什么、参数怎么拼、输出怎么解析、具备哪些能力、
 * 权限档位映射成什么参数、原生会话 id 从哪来。
 *
 * 契约与 `GET /api/agents` 的返回形状保持一致，
 * 后端接入后前端只需把 data/agents.ts 换成 fetch。
 */

/** 输出解析器标识。新平台只有输出格式与现有解析器都不同时，才需要新增一种。 */
export type AgentParserId =
  | 'claude-stream-json'
  | 'codex-json'
  | 'opencode-json'
  | 'dsh-json'
  | 'json-result'
  | 'plain';

/**
 * 可用性三态。
 * - ready：已安装，且参数在本机真跑通过
 * - installed：已安装，但参数按官方文档写、尚未实测
 * - missing：本机找不到可执行文件
 */
export type AgentAvailability = 'ready' | 'installed' | 'missing';

/**
 * 与厂商无关的权限档位。编排器只认这四档，
 * 每个平台各自映射到自己的原生开关。
 *
 * `default` 是最保守的一档：不追加任何提权参数，
 * 审查节点必须用它，配合 worktree 的只读挂载保证只读。
 */
export type PermissionPolicy =
  | 'default'
  | 'accept-edits'
  | 'auto'
  | 'bypass-permissions';

/**
 * 原生会话 id 的来源。
 * - uuidv5：由编排器 session id 确定性派生，重启后能重算，无需事先保存
 * - hooked：依赖平台 hook 或流式输出捕获，拿不到时续跑要降级为新跑
 * - none：平台不支持续跑
 */
export type SessionDerive = 'uuidv5' | 'hooked' | 'none';

export interface AgentCapabilities {
  /** 能否实时流式输出 */
  streaming: boolean;
  /** 能否保证结构化输出 */
  structured: boolean;
  /** 能否按会话 id 续跑 */
  resume: boolean;
  /** 能否调用工具（读写文件） */
  tools: boolean;
}

export interface AgentLaunchSpec {
  /** 可执行文件名 */
  bin: string;
  /**
   * 参数模板。占位符：
   *   {prompt}   提示词（仅当 stdin=false 时使用）
   *   {model}    节点指定的模型
   *   {session}  续跑用的会话 id
   *   {workdir}  节点工作目录
   */
  args: string[];
  /** 提示词走 stdin（避免 Windows 上 shell 转义问题） */
  stdin: boolean;
  parser: AgentParserId;
  /** 指定模型时追加的参数，如 ['--model', '{model}'] */
  modelArgs?: string[];
}

/** 走配置文件而非命令行参数的接入方式。 */
export interface AgentConfigFile {
  /** 指向该文件的环变量 */
  envVar: string;
  /** 文件内容模板（TOML/JSON/YAML） */
  template: string;
  /** 为什么必须走文件 */
  description: string;
}

export interface AgentSessionSpec {
  derive: SessionDerive;
  /** 续跑时追加的参数，{session} 为原生会话 id */
  resumeArgs: string[];
}

export interface AgentProfile {
  id: string;
  /** 界面显示名 */
  label: string;
  /** 供应方 */
  vendor: string;
  /** 厂商图标路径（public 下） */
  logo: string;
  transport?: 'cli' | 'claude-sdk' | 'codex-app-server' | 'dsh-sdk' | 'acp' | 'http-model';
  defaultModel?: string;
  launch: AgentLaunchSpec;
  capabilities: AgentCapabilities;
  availability: AgentAvailability;
  /** 是否纳入可调度池，供 Planner 选择 */
  enabled: boolean;
  /** 权限档位到原生参数的映射 */
  permissionArgs: Record<PermissionPolicy, string[]>;
  session: AgentSessionSpec;
  configFiles?: AgentConfigFile[];
  /** Windows 上 npm 装成 .cmd shim 时，长命令行需要绕过 shim 直启 Node 入口 */
  windowsShim?: 'bypass' | 'keep';
  /** 探测到的版本号 */
  version?: string;
  /** 参数出处：官方文档或本地源码路径，换版本后据此复核 */
  source?: string;
  /** 给使用者的提示：权限模式、易错点 */
  note?: string;
  timeoutMs: number;
}

export interface ModelDirectory {
  models: Array<{ id: string; name: string; group?: string }>;
  defaultModel?: string;
  source: string;
  checkedAt: string;
  message?: string;
}

export interface ModelProvider {
  id: string;
  label: string;
  protocol: 'openai' | 'anthropic';
  baseUrl: string;
  model?: string;
  hasKey: boolean;
}

export type ModelProviderSettings = Omit<ModelProvider, 'hasKey' | 'id'> & { id?: string; apiKey?: string };

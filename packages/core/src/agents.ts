/**
 * Agent 目录：外部 CLI Agent 的声明式适配。
 *
 * 这里是唯一的事实源，前端与后端都从这里读。接一个平台不需要写代码，
 * 只需要一条 profile：可执行文件叫什么、参数怎么拼、输出怎么解析、
 * 权限映射成什么开关、原生会话 id 从哪来。
 *
 * 本文件刻意不引入任何 Node 内置模块，这样前端可以直接打包同一份数据。
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
 * 各平台各自映射到自己的原生开关。
 *
 * `default` 是最保守的一档：不追加任何提权参数。审查节点必须用它，
 * 但只读不能只靠 CLI 参数保证，还要配合 worktree 侧的限制。
 */
export type PermissionPolicy =
  | 'default'
  | 'accept-edits'
  | 'auto'
  | 'bypass-permissions';

/**
 * 驱动一个 Agent 的方式。
 *
 * - `cli`：拼 argv、起子进程、解析 stdout。所有平台都能走这条路，
 *   代价是模型名映射、会话续跑、权限开关全由我们手工拼（见 `buildAgentArgv`）。
 * - `claude-sdk`：官方 Agent SDK。上面那些差异本来就是这个 SDK 的职责，
 *   执行器只需要把请求翻译成 Options，再把消息流还原成事件。
 */
/**
 * 这个 Agent 用哪种方式驱动。
 *
 * - `cli`：拼 argv、起进程、解析 stdout。缺省值，旧目录与旧日志都走它。
 * - `claude-sdk`：官方 Agent SDK（会话、权限、模型名由 SDK 负责）
 * - `codex-app-server`：Codex 的 app-server 协议（JSON-RPC over stdio）
 * - `dsh-sdk`：DeepSeek Harness 官方 client SDK
 * - `acp`：Agent Client Protocol，任何实现了它的 agent 都能接
 *
 * 每条路的差别都只在「怎么把提示词送进去、怎么把输出翻译成 AgentEvent」，
 * 编排层只认 `AgentRunner` 一个接口。
 */
export type AgentTransport =
  | 'cli'
  | 'claude-sdk'
  | 'codex-app-server'
  | 'dsh-sdk'
  | 'acp'
  | 'http-model';

/**
 * 原生会话 id 的来源。
 * - uuidv5：由编排器 session id 确定性派生，重启后能重算
 * - hooked：依赖平台 hook 或流式输出捕获，拿不到时续跑降级为新跑
 * - none：平台不支持续跑
 */
export type SessionDerive = 'uuidv5' | 'hooked' | 'none';

export interface AgentCapabilities {
  streaming: boolean;
  structured: boolean;
  resume: boolean;
  tools: boolean;
}

export interface AgentLaunchSpec {
  bin: string;
  /** 参数模板，支持 {prompt} {model} {session} {workdir} 占位符 */
  args: string[];
  /** 提示词走 stdin，避免 Windows 上 shell 拼接重新解释参数 */
  stdin: boolean;
  parser: AgentParserId;
  modelArgs?: string[];
}

export interface AgentConfigFile {
  envVar: string;
  template: string;
  description: string;
}

export interface AgentSessionSpec {
  derive: SessionDerive;
  /** 续跑时追加的参数，{session} 为原生会话 id */
  resumeArgs: string[];
  /**
   * 首轮启动时就指定会话 id 用。没有这一项的 Agent 只能等平台自己发 id，
   * 于是 uuidv5 派生型也会退化成「只能续、建不出来」。
   */
  newSessionArgs?: string[];
}

export interface AgentProfile {
  id: string;
  label: string;
  vendor: string;
  /** 厂商图标路径，前端从 public 下取 */
  logo: string;
  /**
   * 这个 Agent 用哪种方式驱动，缺省视为 `'cli'`。
   *
   * 缺省不能是必填：`transport` 是后加的，磁盘上的旧目录、测试里手写的
   * profile、以及第三方塞进来的配置都不会带它。把缺省当成 `'cli'`，
   * 这些旧数据的行为与加这个字段之前完全一致——它们本来就是拼 argv 跑的。
   * 反过来说，只有显式声明 `'claude-sdk'` 才会换执行路径，任何一条旧日志
   * 与旧 profile 的语义都不会被悄悄改写。
   */
  transport?: AgentTransport;
  /** Configured default for a model endpoint. */
  defaultModel?: string;
  launch: AgentLaunchSpec;
  capabilities: AgentCapabilities;
  availability: AgentAvailability;
  /** 是否纳入可调度池 */
  enabled: boolean;
  permissionArgs: Record<PermissionPolicy, string[]>;
  session: AgentSessionSpec;
  configFiles?: AgentConfigFile[];
  windowsShim?: 'bypass' | 'keep';
  version?: string;
  source?: string;
  note?: string;
  timeoutMs: number;
}

export const DEFAULT_AGENT_PROFILES: AgentProfile[] = [
  {
    id: 'claude',
    label: 'Claude Code',
    vendor: 'Anthropic',
    logo: '/logos/claude.svg',
    // 换官方 SDK 驱动：模型名映射、会话、权限档位都归 SDK 管，
    // 下面的 launch 只保留「声明它有哪些能力、参数怎么拼」的历史形态，
    // CLI 执行器仍可拿它兜底（比如 SDK 那一路临时不可用时）
    transport: 'claude-sdk',
    launch: {
      bin: 'claude',
      args: [
        '-p',
        '--output-format',
        'stream-json',
        '--verbose',
        '--allowedTools',
        'Read,Glob,Grep,LS',
      ],
      stdin: true,
      parser: 'claude-stream-json',
      modelArgs: ['--model', '{model}'],
    },
    capabilities: { streaming: true, structured: true, resume: true, tools: true },
    /**
     * 走 SDK 之后本机实测**真的产出了回答**，所以是 ready。
     *
     * 结论变化有据：上一版判 installed 是因为凭证指向 tokenhub 网关，模型请求被
     * 判 402（服务 ID 不匹配），一次回答都没产出。凭证改成 DeepSeek 官方
     * Anthropic 兼容端点（`api.deepseek.com/anthropic`）之后，SDK 0.3.326 真跑
     * 「只回复两个字：收到」用时 4.9 秒：init 报 `deepseek-v4-flash[1m]`，
     * 拿到 thinking（空）与 text（「收到」）两个块，result `is_error=false`。
     *
     * 注意「不传 model」这件事是刻意的：SDK 的 `options.model` 省略即用
     * `~/.claude/settings.json` 里的默认值。我们的 profile 不该替用户决定模型名
     * ——本机这份配置改过两次，每次都是网关侧的名字对不上，把名字写死在代码里
     * 只会让同一个错误再犯一次。
     */
    availability: 'ready',
    enabled: true,
    permissionArgs: {
      default: ['--permission-mode', 'plan'],
      'accept-edits': ['--permission-mode', 'acceptEdits'],
      auto: ['--permission-mode', 'auto'],
      'bypass-permissions': ['--permission-mode', 'bypassPermissions'],
    },
    /**
     * 会话 id 由 **claude 自己生成**，我们只负责捕获。
     *
     * 上一版是 `derive: 'uuidv5'`——自己按 (runId, nodeId) 算一个确定性的 id，
     * 首轮用 `--session-id` 把它钉进去。那个设计有一个致命的语义错配：
     * `--session-id` 的语义是「创建并占用这个 id」，**不幂等**。那个 id 一旦
     * 被创建过（哪怕那一次执行失败了、transcript 已经落盘），再传就报
     * `Session ID ... is already in use`。
     *
     * 而 `attempts` 只在审查驳回时 +1、执行失败不涨，于是重试永远被当成首轮、
     * 永远拿同一个 id 去「创建」、永远撞同一堵墙——那个节点从此跑不起来。
     *
     * 改成 `hooked` 就是让 claude 自己铸 id：首轮不带任何会话参数，SDK 的
     * `system/init` 消息带回真实 id，`claude-sdk` 执行器把它转成 `agent.session`
     * 事件落进 `node.nativeSessionId`，下一轮用 `--resume <id>` 接上。
     *
     * 这条路上每一步都幂等：没 id 就是新会话，有 id 就是续跑，不存在「创建一个
     * 已经存在的 id」这种操作。
     */
    session: {
      derive: 'hooked',
      resumeArgs: ['--resume', '{session}'],
    },
    windowsShim: 'bypass',
    version: '2.1.278',
    source: 'claude --help（参数已核验）',
    note: '走官方 Agent SDK。不传 model，用 ~/.claude/settings.json 的默认值——模型名属于部署环境，不该写死在目录里。本机实测：DeepSeek 官方 Anthropic 兼容端点下 4.9 秒产出回答。',
    timeoutMs: 600_000,
  },
  /**
   * dsh（走 dsh-sdk）**不在默认目录里了**，但实现完整保留着：
   * packages/server/src/runners/dsh-sdk.ts 919 行，transport 'dsh-sdk'
   * 仍然可用——只要有人手工把它加回目录。
   *
   * 撤下的原因是它与桌面版存在无法调和的运行时冲突：dsh-sdk-client 内部
   * 用 process.execPath 去跑 dsh 的 JS 模块，而 Electron 打包后 server 就是
   * 被 ELECTRON_RUN_AS_NODE=1 启动的，process.execPath 指向 Electron 自己。
   * dsh 的 native addon 一看 V8 指纹是 Electron 就直接拒绝启动：
   *
   *   node-addon-require-builtin unsupported: Unsupported/no-context
   *   (unsupported Electron runtime fingerprint: V8 14.0.365.10-electron.0)
   *
   * 同样的能力由 dsh-acp 提供：它 spawn 系统上的 dsh --profile acp 子进程，
   * 拿到的是真 Node，native addon 不炸，会话续跑也验证过。
   */
  {
    id: 'dsh-acp',
    label: 'DeepSeek Harness（ACP）',
    vendor: 'DeepSeek',
    logo: '/logos/dsh.svg',
    launch: {
      bin: 'dsh',
      // ACP 是常驻的 JSON-RPC 进程，不是一次性命令：这一串既是启动参数也是
      // 「怎么进协议模式」的声明。
      args: ['--profile', 'acp'],
      stdin: true,
      // 翻译在 AcpRunner 内部完成，但它按 dsh-json 的词汇出线，所以解析器
      // 仍然写这个值——core 因此一行都不用改。
      parser: 'dsh-json',
    },
    capabilities: { streaming: true, structured: true, resume: true, tools: true },
    /**
     * 与 `dsh` 并列的第二种驱动方式，值得单列而不是替换它。
     *
     * 差别在取消：SDK 那条路的协议里没有行级取消，只能关会话再杀进程；ACP 有
     * 真正的 `session/cancel` 请求，Agent 能自己收尾。这是「打断节点」这条链上
     * 更干净的一条路，所以两个条目共存，由用户在新建运行时选。
     */
    transport: 'acp',
    availability: 'ready',
    enabled: true,
    permissionArgs: {
      default: [],
      'accept-edits': [],
      auto: [],
      'bypass-permissions': [],
    },
    session: { derive: 'hooked', resumeArgs: [] },
    windowsShim: 'bypass',
    version: '0.2.0-rc.2',
    source: '本机实测：dsh --profile acp，2.9 秒产出回答（2026-11-17）',
    /**
     * 不写 `modelArgs`：这里的 argv 同时是启动命令，塞 `--model {model}` 等于
     * 递给 agent 一个它未必认识的参数。模型选择走 ACP 的
     * `session/set_config_option`，runner 已按 agent 暴露的选项自动映射。
     */
    note: '走 Agent Client Protocol。取消有协议级 session/cancel，比杀进程干净；模型由 set_config_option 协商，不走 argv。',
    timeoutMs: 600_000,
  },
  {
    id: 'codex',
    label: 'Codex CLI',
    vendor: 'OpenAI',
    logo: '/logos/codex.svg',
    launch: {
      bin: 'codex',
      args: ['exec', '--json', '--skip-git-repo-check', '{prompt}'],
      stdin: false,
      parser: 'codex-json',
      modelArgs: ['-m', '{model}'],
    },
    capabilities: { streaming: true, structured: false, resume: false, tools: true },
    /**
     * 走 Codex 的 app-server 协议。
     *
     * `launch.args` 里的 `exec --json` 是 CLI 那条路的形状，这条路忽略它：
     * app-server 是常驻的 JSON-RPC 进程，靠 thread/turn 驱动，而不是一次性的
     * 命令行调用。两条路共用一份 profile，参数留给 CLI 用。
     */
    transport: 'codex-app-server',
    availability: 'installed',
    enabled: true,
    permissionArgs: {
      default: ['--sandbox', 'read-only'],
      'accept-edits': ['--sandbox', 'workspace-write'],
      auto: ['--sandbox', 'workspace-write', '-c', 'approvals_reviewer="auto_review"'],
      'bypass-permissions': ['--dangerously-bypass-approvals-and-sandbox'],
    },
    /**
     * 会话 id 由 codex 自己分配（app-server 的 `thread.id`），我们只捕获。
     *
     * 上一版是 `derive: 'none'`——直接宣告「不支持续跑」。它其实支持：
     * app-server 有 `thread/resume`（参数 `threadId`），CLI 有
     * `codex resume <id> -- <prompt>`。一直没接是因为一个隐藏前提：首轮
     * `thread/start` 带了 `ephemeral: true`，会话根本不落盘，没有东西可恢复。
     *
     * 现在首轮不再声明 ephemeral（走平台默认的持久化），`thread.started`
     * 带回的 `thread_id` 被 `pickSessionId` 提取成 `agent.session` 事实，
     * 下一轮拿它发 `thread/resume`。
     *
     * `resumeArgs` 留空：这条路走 JSON-RPC，不看 argv。CLI 那条路的续跑是
     * `codex resume <id> -- <prompt>`（子命令形式），现有模板语法表达不了。
     */
    session: { derive: 'hooked', resumeArgs: [] },
    windowsShim: 'bypass',
    source: 'codex exec --json（官方文档）',
    note: '审查使用只读沙箱，规划和实现可在各自工作区内写入。',
    timeoutMs: 300_000,
  },
  {
    id: 'opencode',
    label: 'OpenCode',
    vendor: 'SST',
    logo: '/logos/opencode.svg',
    launch: {
      bin: 'opencode',
      args: ['run', '{prompt}', '--format', 'json'],
      stdin: false,
      parser: 'opencode-json',
      modelArgs: ['-m', '{model}'],
    },
    capabilities: { streaming: true, structured: false, resume: true, tools: true },
    availability: 'installed',
    enabled: true,
    // v2 只剩 --auto；完整放行靠配置文件里的 permission: "allow"。
    permissionArgs: {
      default: [],
      'accept-edits': [],
      auto: ['--auto'],
      'bypass-permissions': ['--auto'],
    },
    session: { derive: 'hooked', resumeArgs: ['--session', '{session}'] },
    configFiles: [
      {
        envVar: 'OPENCODE_CONFIG',
        template: '{"agent":{"orchestrator":{"permission":"allow"}}}',
        description:
          'v2 移除了 --model / --agent / --dangerously-skip-permissions，模型与审批覆盖只能走配置文件',
      },
    ],
    windowsShim: 'bypass',
    source: 'opencode run --format json（NDJSON，官方文档）',
    note: '输出是 NDJSON：step_start / text / tool_use / step_finish / error。模型不走命令行，要写配置文件。',
    timeoutMs: 300_000,
  },
  {
    id: 'qoder',
    label: 'Qoder CLI',
    vendor: 'Qoder',
    logo: '/logos/qoder.svg',
    launch: {
      bin: 'qoder',
      args: ['-p', '--output-format', 'stream-json'],
      stdin: true,
      parser: 'claude-stream-json',
      modelArgs: ['-m', '{model}'],
    },
    capabilities: { streaming: true, structured: true, resume: true, tools: true },
    availability: 'missing',
    enabled: false,
    permissionArgs: {
      default: [],
      'accept-edits': ['--permission-mode', 'accept_edits'],
      auto: ['--permission-mode', 'accept_edits'],
      'bypass-permissions': ['--permission-mode', 'accept_edits'],
    },
    /**
     * 仍是 uuidv5：它接口对齐 Claude Code，用 `--session-id` 钉住首轮是那套语义。
     *
     * `newSessionArgs` 原本漏了——于是「确定性派生」这个声明从来没生效过：
     * 首轮不钉 id，后续 `--resume` 永远接不上（它 `enabled: false`，本地没装，
     * 所以一直没人发现）。这里补齐，让声明和实现对得上。
     */
    session: {
      derive: 'uuidv5',
      resumeArgs: ['--resume', '{session}'],
      newSessionArgs: ['--session-id', '{session}'],
    },
    source: 'docs.qoder.com/cli/run-in-scripts',
    note: '接口刻意对齐 Claude Code，因此复用同一套解析器。无头模式需 accept_edits 才能改文件。',
    timeoutMs: 300_000,
  },
  {
    id: 'workbuddy',
    label: 'WorkBuddy',
    vendor: '腾讯',
    logo: '/logos/workbuddy.svg',
    launch: {
      bin: 'codebuddy',
      args: ['-p', '--output-format', 'json'],
      stdin: true,
      parser: 'json-result',
      modelArgs: ['--model', '{model}'],
    },
    capabilities: { streaming: false, structured: true, resume: false, tools: true },
    availability: 'missing',
    enabled: false,
    permissionArgs: {
      default: [],
      'accept-edits': ['--dangerously-skip-permissions'],
      auto: ['--dangerously-skip-permissions'],
      'bypass-permissions': ['--dangerously-skip-permissions'],
    },
    session: { derive: 'none', resumeArgs: [] },
    source: 'npm @tencent-ai/codebuddy-code',
    note: '可执行文件名是 codebuddy，不是 workbuddy。没有中间权限档，只有显式跳过确认。',
    timeoutMs: 300_000,
  },
  {
    id: 'zcode',
    label: 'Z Code',
    vendor: '智谱',
    logo: '/logos/zcode.svg',
    launch: {
      bin: 'zcode',
      args: ['--prompt', '{prompt}', '--mode', 'build', '--json'],
      stdin: false,
      parser: 'json-result',
    },
    capabilities: { streaming: false, structured: true, resume: false, tools: true },
    availability: 'missing',
    enabled: false,
    // 权限模式与 --mode 共用同一个开关，改档时要整条替换 args 里的 build。
    permissionArgs: {
      default: [],
      'accept-edits': [],
      auto: [],
      'bypass-permissions': [],
    },
    session: { derive: 'none', resumeArgs: [] },
    source: 'zcode.z.ai / zai-org/ZCode',
    note: '权限模式 plan / build / edit / yolo 与 --mode 是同一个开关，编排器改档时需整条替换 args。',
    timeoutMs: 300_000,
  },
  {
    id: 'trae',
    label: 'Trae CLI',
    vendor: '字节跳动',
    logo: '/logos/trae.svg',
    launch: {
      bin: 'trae-cli',
      args: ['run', '{prompt}'],
      stdin: false,
      parser: 'plain',
      modelArgs: ['--model', '{model}'],
    },
    capabilities: { streaming: false, structured: false, resume: false, tools: true },
    availability: 'missing',
    enabled: false,
    permissionArgs: {
      default: [],
      'accept-edits': [],
      auto: [],
      'bypass-permissions': [],
    },
    session: { derive: 'none', resumeArgs: [] },
    source: 'bytedance/trae-agent',
    note: '有两个同名 CLI：开源 trae-cli（本预设）与商业版 traecli。输出为纯文本，只能整体取回。',
    timeoutMs: 600_000,
  },
];

export function findAgent(
  id: string | undefined,
  catalog: AgentProfile[] = DEFAULT_AGENT_PROFILES,
): AgentProfile | undefined {
  if (!id) {
    return undefined;
  }
  return catalog.find((agent) => agent.id === id);
}

/** 按平台名反查。历史数据只存了执行者名字时用它兜底。 */
export function findAgentByLabel(
  label: string,
  catalog: AgentProfile[] = DEFAULT_AGENT_PROFILES,
): AgentProfile | undefined {
  return catalog.find((agent) => agent.label === label);
}

const PLACEHOLDER_TOKENS = ['prompt', 'model', 'session', 'workdir'] as const;

/** 是否残留未被替换的已知占位符。 */
function hasUnresolvedPlaceholder(value: string): boolean {
  return PLACEHOLDER_TOKENS.some((token) => value.includes(`{${token}}`));
}

/**
 * 拼出实际要执行的 argv。
 *
 * 占位符替换只做字面量替换，不做 shell 转义——参数从不经过 shell，
 * 提示词一律走 stdin，这是 Windows 上 `.cmd` 包装唯一安全的用法。
 *
 * `resume` 为真时把 profile 里声明的 `session.resumeArgs` 展开后**追加在
 * 最后**。这是近似：不同 CLI 的续跑参数集无法穷举，有的要替换掉原有的
 * 子命令（`codex exec` → `codex resume`），有的只是纯追加（`claude --resume`）。
 * 精确判断需要为每个平台写一套重写规则，那等于把 profile 的声明式好处
 * 全部换成手写分支。因此这里选择「args 在前、resumeArgs 在后」的简单拼接，
 * 让纯追加型 CLI 立刻可用；子命令替换型平台的续跑参数需要先在 profile 里
 * 校准，或等 profile 增加重写字段。
 */
export function buildAgentArgv(
  profile: AgentProfile,
  options: {
    prompt?: string;
    model?: string;
    session?: string;
    workdir?: string;
    policy?: PermissionPolicy;
    /** 是否续跑：为真时追加 profile.session.resumeArgs */
    resume?: boolean;
  } = {},
): string[] {
  const policy = options.policy ?? 'default';
  const replacements: Record<string, string | undefined> = {
    '{prompt}': options.prompt,
    '{model}': options.model,
    '{session}': options.session,
    '{workdir}': options.workdir,
  };

  const expand = (value: string): string => {
    let out = value;
    for (const [token, replacement] of Object.entries(replacements)) {
      if (replacement !== undefined) {
        out = out.split(token).join(replacement);
      }
    }
    return out;
  };

  const argv = [profile.launch.bin];
  for (const arg of profile.launch.args) {
    // stdin 模式下提示词不进参数表
    if (profile.launch.stdin && arg === '{prompt}') {
      continue;
    }
    const expanded = expand(arg);
    // 只看已知占位符是否残留。不能判断「是否含 {」——提示词正文里就可能有
    // 花括号（比如要求 Agent 输出 JSON），那会把整条参数误判成未替换。
    if (hasUnresolvedPlaceholder(expanded)) {
      continue;
    }
    argv.push(expanded);
  }

  if (options.model && profile.transport !== 'acp' && profile.transport !== 'http-model') {
    argv.push(...(profile.launch.modelArgs ?? ['--model', '{model}']).map(expand));
  }

  argv.push(...profile.permissionArgs[policy]);

  if (options.resume) {
    for (const arg of profile.session.resumeArgs) {
      const expanded = expand(arg);
      // {session} 没给就整条丢掉：拼出字面量 `--resume {session}` 只会让
      // CLI 在参数解析阶段就失败，那比「这一轮没续上」糟糕得多。
      if (hasUnresolvedPlaceholder(expanded)) {
        continue;
      }
      argv.push(expanded);
    }
  } else if (options.session) {
    // 首轮就把会话 id 钉住。不定期指定的话平台侧根本不存在这个会话，
    // 后面重跑时的 --resume 自然是接不上的。
    for (const arg of profile.session.newSessionArgs ?? []) {
      const expanded = expand(arg);
      if (hasUnresolvedPlaceholder(expanded)) {
        continue;
      }
      argv.push(expanded);
    }
  }

  return argv;
}

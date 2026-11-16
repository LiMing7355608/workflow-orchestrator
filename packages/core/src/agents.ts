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
    // 装了、但这台机器上跑不通：Claude Code 被配成指向 deepseek-v4-flash，
    // 它报 unrecognized_model。按定义「可直接调用」要求本机实测跑通，
    // 所以这里只能是仅安装，不能凭 --version 就认定可用
    availability: 'installed',
    enabled: true,
    permissionArgs: {
      default: ['--permission-mode', 'plan'],
      'accept-edits': ['--permission-mode', 'acceptEdits'],
      auto: ['--permission-mode', 'auto'],
      'bypass-permissions': ['--permission-mode', 'bypassPermissions'],
    },
    session: {
      derive: 'uuidv5',
      resumeArgs: ['--resume', '{session}'],
      newSessionArgs: ['--session-id', '{session}'],
    },
    windowsShim: 'bypass',
    version: '2.1.278',
    source: 'claude --help（参数已核验）',
    note: '这台机器上 claude 被配成指向 deepseek-v4-flash，非交互执行会报 unrecognized_model，先修模型配置再用。',
    timeoutMs: 600_000,
  },
  {
    id: 'dsh',
    label: 'DeepSeek Harness',
    vendor: 'DeepSeek',
    logo: '/logos/dsh.svg',
    launch: {
      bin: 'dsh',
      args: ['--profile', 'headless', '--json'],
      stdin: true,
      parser: 'dsh-json',
    },
    capabilities: { streaming: true, structured: true, resume: true, tools: true },
    availability: 'ready',
    enabled: true,
    // headless profile 没有权限开关：审批请求以事件形式到来，由编排器应答。
    permissionArgs: {
      default: [],
      'accept-edits': [],
      auto: [],
      'bypass-permissions': [],
    },
    // 续跑靠 ACP 的 session/resume；headless 拿不到原生 id 时退化为新跑。
    session: { derive: 'hooked', resumeArgs: [] },
    windowsShim: 'bypass',
    version: '0.2.0-rc.2',
    source: 'apps/cli README + packages/bundle/headless（本机实测）',
    note: '任务从 stdin 传入。无 hook 面，终端会话通常拿不到原生 id，续跑会退化为新跑。',
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
    availability: 'installed',
    enabled: true,
    permissionArgs: {
      default: [],
      'accept-edits': ['--ask-for-approval', 'on-request'],
      auto: [
        '--ask-for-approval',
        'on-request',
        '-c',
        'approvals_reviewer="auto_review"',
      ],
      'bypass-permissions': ['--dangerously-bypass-approvals-and-sandbox'],
    },
    session: { derive: 'hooked', resumeArgs: ['resume', '{session}'] },
    windowsShim: 'bypass',
    source: 'codex exec --json（官方文档）',
    note: '默认沙箱只读，需要写盘时加到 bypass 档。工作区信任要显式写 -c projects={...trust_level="trusted"}。',
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
    session: { derive: 'uuidv5', resumeArgs: ['--resume', '{session}'] },
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

  if (options.model) {
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

import type { AgentProfile } from '../types/agent';

/**
 * 主流 CLI Agent 预设。
 *
 * 参数一律来自各平台官方文档；`availability: 'ready'` 的语义严格限定为
 * 「在本机真的跑通过」，查了文档但没装、没跑过的一律不标 ready。
 *
 * 刻意不收录自研玩具型 Agent：编排器只接用户本来就信任的模型工具，
 * 而不是再造一个需要自己维护的 Agent 循环。
 *
 * 权限映射与续跑参数走与厂商无关的抽象：
 * 编排器只认四档权限，各平台自己翻译成原生开关。
 */
export const seedAgents: AgentProfile[] = [
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
    capabilities: {
      streaming: true,
      structured: true,
      resume: true,
      tools: true,
    },
    availability: 'ready',
    enabled: true,
    permissionArgs: {
      default: ['--permission-mode', 'plan'],
      'accept-edits': ['--permission-mode', 'acceptEdits'],
      auto: ['--permission-mode', 'auto'],
      'bypass-permissions': ['--permission-mode', 'bypassPermissions'],
    },
    session: { derive: 'uuidv5', resumeArgs: ['--resume', '{session}'] },
    windowsShim: 'bypass',
    version: '2.1.278',
    source: 'claude --help（本机实测）',
    note: '提示词走 stdin。审查节点用 plan 档，实现节点用 acceptEdits 并放开 Write/Edit。',
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
    capabilities: {
      streaming: true,
      structured: true,
      resume: true,
      tools: true,
    },
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
    capabilities: {
      streaming: true,
      structured: false,
      resume: false,
      tools: true,
    },
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
    capabilities: {
      streaming: true,
      structured: false,
      resume: true,
      tools: true,
    },
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
    capabilities: {
      streaming: true,
      structured: true,
      resume: true,
      tools: true,
    },
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
    capabilities: {
      streaming: false,
      structured: true,
      resume: false,
      tools: true,
    },
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
    capabilities: {
      streaming: false,
      structured: true,
      resume: false,
      tools: true,
    },
    availability: 'missing',
    enabled: false,
    // 权限与 --mode 共用同一个开关，改档时要同时替换 args 里的 build。
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
    capabilities: {
      streaming: false,
      structured: false,
      resume: false,
      tools: true,
    },
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

export function findAgent(id: string | undefined): AgentProfile | undefined {
  if (!id) {
    return undefined;
  }
  return seedAgents.find((agent) => agent.id === id);
}

/**
 * 按平台名反查。节点历史数据只存了执行者名字，
 * 后端接管后应改为只认 agentId，这里只是过渡期的兜底。
 */
export function findAgentByLabel(label: string): AgentProfile | undefined {
  return seedAgents.find((agent) => agent.label === label);
}

/** 把 profile 拼成可复制的命令行（含权限档位的默认开关）。 */
export function formatCommand(
  profile: AgentProfile,
  policy: keyof AgentProfile['permissionArgs'] = 'default',
): string {
  const parts = [
    profile.launch.bin,
    ...profile.launch.args,
    ...profile.permissionArgs[policy],
  ];
  if (profile.launch.stdin) {
    parts.push('< prompt.txt');
  }
  return parts.join(' ');
}

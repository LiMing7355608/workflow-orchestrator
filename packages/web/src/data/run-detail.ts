import { seedRuns } from './seed';
import type {
  NodeStatus,
  WorkflowEdge,
  WorkflowEvent,
  WorkflowNode,
  WorkflowRunDetail,
  WorkflowRunSummary,
} from '../types/workflow';

function minutesAgo(minutes: number): string {
  return new Date(Date.now() - minutes * 60_000).toISOString();
}

const collabNodes: WorkflowNode[] = [
  {
    id: 'impl-account',
    title: '账号与登录',
    description: '手机号注册、扫码登录、设备管理与退出登录。',
    type: 'implement',
    status: 'completed',
    agent: '实现 Agent A',
    dependsOn: [],
    files: ['src/auth/**'],
    attempts: 1,
    durationMs: 182_000,
  },
  {
    id: 'review-account',
    title: '账号安全审查',
    description: '检查登录态、设备信任与敏感操作的权限边界。',
    type: 'review',
    status: 'completed',
    agent: '审查 Agent',
    dependsOn: ['impl-account'],
    files: ['src/auth/**'],
    attempts: 1,
    durationMs: 42_000,
  },
  {
    id: 'impl-message',
    title: '消息与会话',
    description: '单聊、群聊、文本与文件消息、未读计数和失败重试。',
    type: 'implement',
    status: 'completed',
    agent: '实现 Agent B',
    dependsOn: [],
    files: ['src/chat/**'],
    attempts: 1,
    durationMs: 265_000,
  },
  {
    id: 'review-message',
    title: '消息一致性审查',
    description: '核对消息顺序、未读状态和弱网重试的一致性。',
    type: 'review',
    status: 'running',
    agent: '审查 Agent',
    dependsOn: ['impl-message'],
    files: ['src/chat/**'],
    attempts: 1,
  },
  {
    id: 'impl-contacts',
    title: '通讯录与好友',
    description: '好友申请、备注、分组、黑名单和通讯录搜索。',
    type: 'implement',
    status: 'ready',
    agent: '实现 Agent A',
    dependsOn: ['review-account'],
    files: ['src/contacts/**'],
    attempts: 1,
  },
  {
    id: 'review-contacts',
    title: '权限与隐私审查',
    description: '确认好友关系、黑名单和资料可见范围的权限。',
    type: 'review',
    status: 'pending',
    agent: '审查 Agent',
    dependsOn: ['impl-contacts'],
    files: ['src/contacts/**'],
    attempts: 1,
  },
  {
    id: 'impl-notify',
    title: '通知与设置',
    description: '新消息通知、免打扰、隐私设置与通用设置。',
    type: 'implement',
    status: 'completed',
    agent: '实现 Agent C',
    dependsOn: [],
    files: ['src/notifications/**'],
    attempts: 1,
    durationMs: 98_000,
  },
  {
    id: 'approval-notify',
    title: '通知策略审批',
    description: '确认首期通知频率、免打扰默认值和隐私边界。',
    type: 'approval',
    status: 'waiting_approval',
    agent: '审批人 · 老板',
    dependsOn: ['impl-notify'],
    files: ['src/notifications/**'],
    attempts: 1,
  },
  {
    id: 'gate-quality',
    title: '质量门禁',
    description: '汇总审查与审批结果，决定是否进入下一批实现任务。',
    type: 'route',
    status: 'pending',
    agent: '编排器',
    dependsOn: ['review-account', 'review-message', 'approval-notify'],
    files: [],
    attempts: 1,
  },
  {
    id: 'impl-groups',
    title: '群组与权限',
    description: '群创建、成员管理、群公告和群权限设置。',
    type: 'implement',
    status: 'pending',
    agent: '实现 Agent B',
    dependsOn: ['gate-quality'],
    files: ['src/groups/**'],
    attempts: 1,
  },
  {
    id: 'review-groups',
    title: '群组权限审查',
    description: '检查群管理操作、成员边界和敏感操作确认。',
    type: 'review',
    status: 'pending',
    agent: '审查 Agent',
    dependsOn: ['impl-groups'],
    files: ['src/groups/**'],
    attempts: 1,
  },
  {
    id: 'impl-search',
    title: '搜索与索引',
    description: '联系人、会话和消息的本地搜索与索引更新。',
    type: 'implement',
    status: 'pending',
    agent: '实现 Agent C',
    dependsOn: ['gate-quality'],
    files: ['src/search/**'],
    attempts: 1,
  },
  {
    id: 'review-search',
    title: '搜索质量审查',
    description: '验证搜索结果相关性、空状态和索引一致性。',
    type: 'review',
    status: 'pending',
    agent: '审查 Agent',
    dependsOn: ['impl-search'],
    files: ['src/search/**'],
    attempts: 1,
  },
  {
    id: 'deliver',
    title: '合并与交付',
    description: '全部审查通过后合并分支并发布本批产物。',
    type: 'route',
    status: 'pending',
    agent: '编排器',
    dependsOn: ['review-contacts', 'review-groups', 'review-search'],
    files: [],
    attempts: 1,
  },
];

const collabEdges: WorkflowEdge[] = [
  { id: 'e-account', source: 'impl-account', target: 'review-account' },
  { id: 'e-message', source: 'impl-message', target: 'review-message' },
  { id: 'e-notify', source: 'impl-notify', target: 'approval-notify' },
  { id: 'e-contacts', source: 'review-account', target: 'impl-contacts' },
  { id: 'e-contacts-review', source: 'impl-contacts', target: 'review-contacts' },
  {
    id: 'e-account-gate',
    source: 'review-account',
    target: 'gate-quality',
    label: '通过',
  },
  { id: 'e-message-gate', source: 'review-message', target: 'gate-quality' },
  {
    id: 'e-approval-gate',
    source: 'approval-notify',
    target: 'gate-quality',
    label: '批准',
  },
  { id: 'e-group-start', source: 'gate-quality', target: 'impl-groups' },
  { id: 'e-search-start', source: 'gate-quality', target: 'impl-search' },
  { id: 'e-group-review', source: 'impl-groups', target: 'review-groups' },
  { id: 'e-search-review', source: 'impl-search', target: 'review-search' },
  {
    id: 'e-group-deliver',
    source: 'review-groups',
    target: 'deliver',
    label: '通过',
  },
  {
    id: 'e-search-deliver',
    source: 'review-search',
    target: 'deliver',
    label: '通过',
  },
  {
    id: 'e-contacts-deliver',
    source: 'review-contacts',
    target: 'deliver',
    label: '通过',
  },
];

const collabEvents: WorkflowEvent[] = [
  {
    id: 'ev-1',
    at: minutesAgo(42),
    type: 'stage',
    message: '设计规格 v1.2 已冻结，开始任务分解。',
  },
  {
    id: 'ev-2',
    at: minutesAgo(31),
    type: 'agent',
    message: 'PM Agent 完成 14 个任务与依赖关系生成。',
    agent: '产品经理 Agent',
  },
  {
    id: 'ev-3',
    at: minutesAgo(18),
    type: 'review',
    message: '账号安全审查通过，允许进入通讯录实现。',
    nodeId: 'review-account',
    agent: '审查 Agent',
  },
  {
    id: 'ev-4',
    at: minutesAgo(9),
    type: 'agent',
    message: '消息一致性审查开始，读取消息模块变更。',
    nodeId: 'review-message',
    agent: '审查 Agent',
  },
  {
    id: 'ev-5',
    at: minutesAgo(5),
    type: 'approval',
    message: '通知策略等待老板确认默认免打扰规则。',
    nodeId: 'approval-notify',
  },
  {
    id: 'ev-6',
    at: minutesAgo(2),
    type: 'system',
    message: '运行保持运行中，等待审查与审批结果。',
  },
];

function buildCollabDetail(run: WorkflowRunSummary): WorkflowRunDetail {
  return {
    ...run,
    nodeCount: collabNodes.length,
    nodes: collabNodes,
    edges: collabEdges,
    events: collabEvents,
  };
}

function genericNodeStatus(runStatus: WorkflowRunSummary['status'], step: number): NodeStatus {
  if (runStatus === 'completed') {
    return 'completed';
  }
  if (runStatus === 'waiting_for_boss') {
    if (step <= 3) return 'completed';
    if (step === 4) return 'waiting_approval';
    return 'pending';
  }
  if (runStatus === 'paused') {
    return step === 0 ? 'completed' : 'pending';
  }
  if (step === 0) return 'completed';
  if (step === 1) return 'running';
  return 'pending';
}

function buildGenericDetail(run: WorkflowRunSummary): WorkflowRunDetail {
  const status = (step: number) => genericNodeStatus(run.status, step);
  const duration = (step: number) =>
    status(step) === 'completed' ? 90_000 + step * 35_000 : undefined;

  const nodes: WorkflowNode[] = [
    {
      id: 'g-spec',
      title: '设计规格冻结',
      description: '锁定目标、范围、约束与验收基线。',
      type: 'route',
      status: status(0),
      agent: '编排器',
      dependsOn: [],
      files: [],
      attempts: 1,
      durationMs: duration(0),
    },
    {
      id: 'g-core',
      title: '核心流程实现',
      description: '实现本期最重要的用户主路径。',
      type: 'implement',
      status: status(1),
      agent: '实现 Agent',
      dependsOn: ['g-spec'],
      files: ['src/core/**'],
      attempts: 1,
      durationMs: duration(1),
    },
    {
      id: 'g-review',
      title: '核心流程审查',
      description: '独立检查主路径的边界、异常与验收条件。',
      type: 'review',
      status: status(2),
      agent: '审查 Agent',
      dependsOn: ['g-core'],
      files: ['src/core/**'],
      attempts: 1,
      durationMs: duration(2),
    },
    {
      id: 'g-notify',
      title: '通知与设置',
      description: '实现通知、免打扰与基础设置。',
      type: 'implement',
      status: status(3),
      agent: '实现 Agent',
      dependsOn: ['g-core'],
      files: ['src/notifications/**'],
      attempts: 1,
      durationMs: duration(3),
    },
    {
      id: 'g-approval',
      title: '范围确认',
      description: '确认本期范围与需要老板拍板的业务规则。',
      type: 'approval',
      status: status(4),
      agent: '审批人 · 老板',
      dependsOn: ['g-notify'],
      files: [],
      attempts: 1,
      durationMs: duration(4),
    },
    {
      id: 'g-gate',
      title: '质量门禁',
      description: '汇总审查与审批结果，决定是否继续。',
      type: 'route',
      status: status(5),
      agent: '编排器',
      dependsOn: ['g-review', 'g-approval'],
      files: [],
      attempts: 1,
      durationMs: duration(5),
    },
    {
      id: 'g-polish',
      title: '体验与边界处理',
      description: '补齐空状态、错误提示和边界场景。',
      type: 'implement',
      status: status(6),
      agent: '实现 Agent',
      dependsOn: ['g-gate'],
      files: ['src/ui/**'],
      attempts: 1,
      durationMs: duration(6),
    },
    {
      id: 'g-deliver',
      title: '合并与交付',
      description: '合并分支并输出可运行的交付物。',
      type: 'route',
      status: status(7),
      agent: '编排器',
      dependsOn: ['g-polish'],
      files: [],
      attempts: 1,
      durationMs: duration(7),
    },
  ];

  const edges: WorkflowEdge[] = [
    { id: 'ge-1', source: 'g-spec', target: 'g-core' },
    { id: 'ge-2', source: 'g-core', target: 'g-review' },
    { id: 'ge-3', source: 'g-core', target: 'g-notify' },
    { id: 'ge-4', source: 'g-notify', target: 'g-approval' },
    {
      id: 'ge-5',
      source: 'g-review',
      target: 'g-gate',
      label: '通过',
    },
    {
      id: 'ge-6',
      source: 'g-approval',
      target: 'g-gate',
      label: '批准',
    },
    { id: 'ge-7', source: 'g-gate', target: 'g-polish' },
    { id: 'ge-8', source: 'g-polish', target: 'g-deliver' },
  ];

  const events: WorkflowEvent[] = [
    {
      id: 'gev-1',
      at: minutesAgo(48),
      type: 'stage',
      message: '设计规格已冻结，进入任务分解。',
    },
    {
      id: 'gev-2',
      at: minutesAgo(34),
      type: 'agent',
      message: 'PM Agent 已生成任务与依赖关系。',
      agent: '产品经理 Agent',
    },
    {
      id: 'gev-3',
      at: minutesAgo(8),
      type:
        run.status === 'waiting_for_boss'
          ? 'approval'
          : run.status === 'paused'
            ? 'system'
            : 'agent',
      message:
        run.status === 'waiting_for_boss'
          ? '范围确认等待老板处理。'
          : run.status === 'paused'
            ? '运行已暂停，等待恢复条件。'
            : '核心流程正在执行。',
      agent: run.status === 'waiting_for_boss' ? undefined : '编排器',
    },
  ];

  return {
    ...run,
    nodeCount: nodes.length,
    nodes,
    edges,
    events,
  };
}

export function getRunDetail(runId: string): WorkflowRunDetail | undefined {
  const run = seedRuns.find((item) => item.id === runId);
  if (!run) {
    return undefined;
  }
  if (run.id === 'run-collab-core') {
    return buildCollabDetail(run);
  }
  return buildGenericDetail(run);
}

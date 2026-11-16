import type {
  NodeFacts,
  OrchestratorEvent,
  RunFacts,
} from '@orchestrator/core';

function iso(base: number, offsetMs: number): string {
  return new Date(base + offsetMs).toISOString();
}

const MINUTE = 60_000;

/**
 * 首次启动时的示例运行。
 *
 * 只写事实事件，不写任何 status 字段——跑起来之后界面上的进度、
 * 泳道、状态全都是 replay 之后现算的。这条运行刻意停在
 * 「一个审查在跑、一个审批在等人」的状态，四个泳道都能看到内容。
 */
export function buildSeedEvents(now: Date): OrchestratorEvent[] {
  const base = now.getTime() - 3 * 60 * MINUTE;
  const runId = 'run-collab-core';

  const node = (
    partial: Omit<NodeFacts, 'attempts' | 'maxAttempts'> &
      Partial<Pick<NodeFacts, 'attempts' | 'maxAttempts'>>,
  ): NodeFacts => ({
    // 没被退回过就是 0：显示成 1 会让看板以为每个节点都重试过一轮
    attempts: 0,
    maxAttempts: 3,
    ...partial,
  });

  const nodes: Record<string, NodeFacts> = {
    'impl-account': node({
      id: 'impl-account',
      type: 'implement',
      title: '账号与登录',
      description: '手机号注册、扫码登录、设备管理与退出登录。',
      dependsOn: [],
      files: ['src/auth/**'],
      agentId: 'claude',
    }),
    'review-account': node({
      id: 'review-account',
      type: 'review',
      title: '账号安全审查',
      description: '检查登录态、设备信任与敏感操作的权限边界。',
      dependsOn: ['impl-account'],
      files: ['src/auth/**'],
      agentId: 'opencode',
    }),
    'impl-message': node({
      id: 'impl-message',
      type: 'implement',
      title: '消息与会话',
      description: '单聊、群聊、文本与文件消息、未读计数和失败重试。',
      dependsOn: [],
      files: ['src/chat/**'],
      agentId: 'codex',
    }),
    'review-message': node({
      id: 'review-message',
      type: 'review',
      title: '消息一致性审查',
      description: '核对消息顺序、未读状态和弱网重试的一致性。',
      dependsOn: ['impl-message'],
      files: ['src/chat/**'],
      agentId: 'opencode',
    }),
    'impl-contacts': node({
      id: 'impl-contacts',
      type: 'implement',
      title: '通讯录与好友',
      description: '好友申请、备注、分组、黑名单和通讯录搜索。',
      dependsOn: ['review-account'],
      files: ['src/contacts/**'],
      agentId: 'claude',
    }),
    'approval-contacts': node({
      id: 'approval-contacts',
      type: 'approval',
      title: '隐私边界审批',
      description: '确认通讯录可见范围与黑名单的业务规则。',
      dependsOn: ['impl-contacts'],
      files: [],
      executor: '审批人 · 老板',
    }),
    'gate-quality': node({
      id: 'gate-quality',
      type: 'route',
      title: '质量门禁',
      description: '汇总审查与审批结果，决定是否进入下一批实现。',
      dependsOn: ['review-account', 'review-message', 'approval-contacts'],
      files: [],
      executor: '编排器',
    }),
    deliver: node({
      id: 'deliver',
      type: 'route',
      title: '合并与交付',
      description: '全部审查通过后合并分支并发布本批产物。',
      dependsOn: ['gate-quality'],
      files: [],
      executor: '编排器',
    }),
  };

  const run: RunFacts = {
    id: runId,
    title: '团队协作平台 · 首期核心体验',
    summary: '账号、消息、通讯录与通知的首期编排',
    goal: '做出团队协作平台的首期核心体验，覆盖账号、消息和通讯录三条主路径。',
    /**
     * 示例数据没有真实目标目录。
     *
     * 空串是「目录未知」的哨兵值：读取侧见到它就回落到服务端默认根目录，
     * 而写一个假路径会让看板声称这份演示运行改过某个真实仓库。
     */
    workspaceRoot: '',
    specVersion: 'v1.2',
    stage: 'execute',
    createdAt: iso(base, 0),
    nodeOrder: [
      'impl-account',
      'review-account',
      'impl-message',
      'review-message',
      'impl-contacts',
      'approval-contacts',
      'gate-quality',
      'deliver',
    ],
    nodes,
  };

  const requestedAt = iso(base, 128 * MINUTE);

  return [
    { type: 'run.created', at: iso(base, 0), runId, run },
    { type: 'run.frozen', at: iso(base, 1 * MINUTE), runId },

    { type: 'node.started', at: iso(base, 2 * MINUTE), runId, nodeId: 'impl-account' },
    { type: 'node.completed', at: iso(base, 5 * MINUTE), runId, nodeId: 'impl-account' },

    { type: 'node.started', at: iso(base, 6 * MINUTE), runId, nodeId: 'review-account' },
    { type: 'review.verdict', at: iso(base, 9 * MINUTE), runId, nodeId: 'review-account', verdict: 'approved' },
    { type: 'node.completed', at: iso(base, 9 * MINUTE), runId, nodeId: 'review-account' },

    { type: 'node.started', at: iso(base, 10 * MINUTE), runId, nodeId: 'impl-message' },
    { type: 'node.completed', at: iso(base, 14 * MINUTE), runId, nodeId: 'impl-message' },

    // 示例数据不造「正在执行」的节点：那需要真的有一个进程在跑，
    // 否则启动自愈会把它判成僵死并落 interrupted。要看运行中的效果，
    // 请新建一个运行让真实 Agent 跑起来。
    { type: 'node.started', at: iso(base, 14 * MINUTE), runId, nodeId: 'review-message' },
    { type: 'node.completed', at: iso(base, 16 * MINUTE), runId, nodeId: 'review-message' },

    { type: 'node.started', at: iso(base, 10 * MINUTE), runId, nodeId: 'impl-contacts' },
    { type: 'node.completed', at: iso(base, 13 * MINUTE), runId, nodeId: 'impl-contacts' },

    {
      type: 'approval.requested',
      at: requestedAt,
      runId,
      record: {
        id: 'ap-contacts-1',
        runId,
        nodeId: 'approval-contacts',
        status: 'pending',
        requestedAt,
      },
    },
  ];
}

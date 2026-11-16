import type { WorkflowRunSummary } from '../types/workflow';

function minutesAgo(minutes: number): string {
  return new Date(Date.now() - minutes * 60_000).toISOString();
}

export const seedRuns: WorkflowRunSummary[] = [
  {
    id: 'run-collab-core',
    title: '团队协作平台 · 首期核心体验',
    summary: '账号、消息、通讯录与通知的首期编排',
    goal:
      '账号、消息、通讯录与通知的首期编排\n\n补充要求：分解粒度：中；并行度：2；审查轮次：1 轮',
    status: 'running',
    stage: 'execute',
    progress: 62,
    nodeCount: 14,
    specVersion: 'v1.2',
    updatedAt: minutesAgo(12),
  },
  {
    id: 'run-content-mvp',
    title: '内容社区 · MVP',
    summary: '发布、推荐流与互动闭环的任务编排',
    goal:
      '发布、推荐流与互动闭环的任务编排\n\n补充要求：分解粒度：粗；并行度：3；审查轮次：2 轮',
    status: 'waiting_for_boss',
    stage: 'execute',
    progress: 78,
    nodeCount: 8,
    specVersion: 'v0.9',
    updatedAt: minutesAgo(46),
  },
  {
    id: 'run-campus-market',
    title: '校园二手交易平台',
    summary: '商品发布、搜索与站内沟通的首期闭环',
    goal:
      '商品发布、搜索与站内沟通的首期闭环\n\n补充要求：分解粒度：中；并行度：2；审查轮次：1 轮',
    status: 'completed',
    stage: 'execute',
    progress: 100,
    nodeCount: 8,
    specVersion: 'v1.0',
    updatedAt: minutesAgo(26 * 60),
  },
  {
    id: 'run-collab-notify',
    title: '团队协作平台 · 通知迭代',
    summary: '群管理、消息免打扰与通知策略调整',
    goal:
      '群管理、消息免打扰与通知策略调整\n\n补充要求：分解粒度：细；并行度：1；审查轮次：2 轮',
    status: 'paused',
    stage: 'orchestrate',
    progress: 34,
    nodeCount: 8,
    specVersion: 'v0.4',
    updatedAt: minutesAgo(3 * 24 * 60),
  },
];

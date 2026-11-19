import {
  Brain,
  Code2,
  GitBranch,
  ShieldCheck,
  UserCheck,
  type LucideIcon,
} from 'lucide-react';
import type { BadgeTone } from '../components/ui/Badge';
import type { NodeStatus, NodeType, WorkflowNode } from '../types/workflow';

export interface NodeTypeMeta {
  label: string;
  icon: LucideIcon;
  tile: string;
  dot: string;
  color: string;
}

export const nodeTypeMeta: Record<NodeType, NodeTypeMeta> = {
  implement: {
    label: '实现',
    icon: Code2,
    tile: 'bg-accent-soft text-accent',
    dot: 'bg-accent',
    color: '#2563eb',
  },
  review: {
    label: '审查',
    icon: ShieldCheck,
    tile: 'bg-review-soft text-review',
    dot: 'bg-review',
    color: '#6d28d9',
  },
  approval: {
    label: '审批',
    icon: UserCheck,
    tile: 'bg-warning-soft text-warning',
    dot: 'bg-warning',
    color: '#b45309',
  },
  route: {
    label: '编排',
    icon: GitBranch,
    tile: 'bg-subtle text-muted',
    dot: 'bg-passive',
    color: '#9ca3af',
  },
};

export interface NodeStatusMeta {
  label: string;
  dot: string;
  text: string;
  tone: BadgeTone;
  color: string;
}

export const nodeStatusMeta: Record<NodeStatus, NodeStatusMeta> = {
  pending: {
    label: '待执行',
    dot: 'bg-passive',
    text: 'text-passive',
    tone: 'neutral',
    color: '#9ca3af',
  },
  ready: {
    label: '就绪',
    dot: 'bg-accent',
    text: 'text-accent',
    tone: 'blue',
    color: '#2563eb',
  },
  running: {
    label: '运行中',
    dot: 'bg-accent animate-pulse',
    text: 'text-accent',
    tone: 'blue',
    color: '#2563eb',
  },
  completed: {
    label: '已完成',
    dot: 'bg-success',
    text: 'text-success',
    tone: 'green',
    color: '#15803d',
  },
  failed: {
    label: '失败',
    dot: 'bg-danger',
    text: 'text-danger',
    tone: 'red',
    color: '#b91c1c',
  },
  waiting_approval: {
    label: '待审批',
    dot: 'bg-warning',
    text: 'text-warning',
    tone: 'amber',
    color: '#b45309',
  },
  retry: {
    label: '退回重做',
    dot: 'bg-coral',
    text: 'text-coral',
    tone: 'coral',
    color: '#c2410c',
  },
  interrupted: {
    // 用 warning 而不是 danger：被用户停下不是「这里坏了」，
    // 它只是没跑完，点一下继续就能接上
    label: '已停止',
    dot: 'bg-warning',
    text: 'text-warning',
    tone: 'amber',
    color: '#b45309',
  },
};

/**
 * 节点的展示态。
 *
 * 后端给的 `status` 回答的是「现在能不能被调度」：一次被停止的执行会被清空
 * 全部执行事实，于是节点回到 ready/pending——它随时可以被重新派发，这正是
 * 「继续」能续上的原因。但界面上说「就绪」会让用户以为这轮根本没跑过。
 *
 * 所以「已停止」只在展示层补：有 `interruptedAt` 且尚未重新开始（status 仍是
 * ready/pending）时显示为 interrupted。刻意不回写进 status，也不参与任何调度
 * 判断——一旦它成为真状态值，节点就会被踢出就绪集合，停止之后再也继续不上。
 */
export function displayNodeStatus(node: WorkflowNode): NodeStatus {
  if (
    node.interruptedAt &&
    (node.status === 'ready' || node.status === 'pending')
  ) {
    return 'interrupted';
  }
  return node.status;
}

export interface ThinkingMeta {
  icon: LucideIcon;
  /** 进行中的标题 */
  runningLabel: string;
  /** 落定之后的标题 */
  settledLabel: string;
  /** 左侧竖线：用中性分隔色而不是语义色，思考不该抢注意力 */
  rail: string;
  /** 图标色 */
  iconText: string;
  /** 正文色 */
  text: string;
}

/**
 * 思考块的视觉映射。
 *
 * 抽在这里而不是写死在时间线里，是因为「这是一段弱化的内部独白」是同一种
 * 语义：事件流、将来的会话视图都该长成同一个样子，各写一份必然走形。
 * 三处约束刻在这里，改动时不必回头翻组件：竖线 2px 表层级、图标 muted、
 * 正文 muted 且明显弱于正式回答。
 */
export const thinkingMeta: ThinkingMeta = {
  icon: Brain,
  runningLabel: '思考中',
  settledLabel: '思考完毕',
  rail: 'border-line-strong',
  iconText: 'text-muted',
  text: 'text-muted',
};

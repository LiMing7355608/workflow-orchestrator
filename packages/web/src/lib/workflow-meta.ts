import {
  Code2,
  GitBranch,
  ShieldCheck,
  UserCheck,
  type LucideIcon,
} from 'lucide-react';
import type { BadgeTone } from '../components/ui/Badge';
import type { NodeStatus, NodeType } from '../types/workflow';

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
    label: '路由',
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
    label: '待定',
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
};

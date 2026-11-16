import {
  filesConflict,
  type AgentProfile,
  type AgentAvailability,
} from '@orchestrator/core';
import type { Dag, DagNode } from './schema.js';

export type DagIssueKind =
  | 'missing-dependency'
  | 'duplicate-id'
  | 'cycle'
  | 'file-conflict'
  | 'unknown-agent'
  | 'disabled-agent'
  | 'agent-not-installed'
  | 'missing-agent'
  | 'action-not-allowed';

export interface DagIssue {
  kind: DagIssueKind;
  message: string;
  nodeIds: string[];
}

export interface ValidationResult {
  ok: boolean;
  issues: DagIssue[];
}

/**
 * 五条冻结校验。
 *
 * 校验不通过的 DAG 拒绝冻结，Planner 需要重新生成——这里不做自动修复，
 * 因为修复过的图已经不代表 Planner 的真实意图了。
 */
export function validateDag(
  dag: Dag,
  catalog: AgentProfile[],
  options: { requireInstalled?: boolean } = {},
): ValidationResult {
  const issues: DagIssue[] = [];
  const byId = new Map<string, DagNode>();

  for (const node of dag.nodes) {
    if (byId.has(node.id)) {
      issues.push({
        kind: 'duplicate-id',
        message: `节点 id 重复：${node.id}`,
        nodeIds: [node.id],
      });
      continue;
    }
    byId.set(node.id, node);
  }

  // 1. 依赖存在性
  for (const node of dag.nodes) {
    for (const dependency of node.dependsOn) {
      if (!byId.has(dependency)) {
        issues.push({
          kind: 'missing-dependency',
          message: `节点 ${node.id} 依赖了不存在的节点 ${dependency}`,
          nodeIds: [node.id, dependency],
        });
      }
    }
  }

  // 2. 无环性
  const cycle = findCycle(dag.nodes, byId);
  if (cycle) {
    issues.push({
      kind: 'cycle',
      message: `执行图存在环：${cycle.join(' → ')}`,
      nodeIds: cycle,
    });
  }

  // 3. 并行实现节点的文件范围不得相交
  const implements_ = dag.nodes.filter((node) => node.type === 'implement');
  for (let i = 0; i < implements_.length; i += 1) {
    for (let j = i + 1; j < implements_.length; j += 1) {
      const left = implements_[i];
      const right = implements_[j];
      if (!left || !right) {
        continue;
      }
      if (areOrdered(left, right, byId)) {
        // 有先后关系，允许范围重叠
        continue;
      }
      if (filesConflict(left.files, right.files)) {
        issues.push({
          kind: 'file-conflict',
          message: `并行节点 ${left.id} 与 ${right.id} 的独占文件范围相交`,
          nodeIds: [left.id, right.id],
        });
      }
    }
  }

  // 4. action 只能挂在 route 上。
  // 其他节点类型各自有明确职责，让它们顺手改仓库历史会把
  // 「谁的改动进了集成分支」这条追踪线索搅乱；合并必须是显式的编排动作。
  for (const node of dag.nodes) {
    if (node.action && node.type !== 'route') {
      issues.push({
        kind: 'action-not-allowed',
        message: `节点 ${node.id} 是 ${node.type} 节点，只有 route 节点允许声明 action`,
        nodeIds: [node.id],
      });
    }
  }

  // 5. Agent 可用性
  for (const node of dag.nodes) {
    const needsAgent = node.type === 'implement' || node.type === 'review';
    if (!needsAgent) {
      continue;
    }
    if (!node.agentId) {
      issues.push({
        kind: 'missing-agent',
        message: `节点 ${node.id} 是${node.type === 'review' ? '审查' : '实现'}节点，必须指定 agentId`,
        nodeIds: [node.id],
      });
      continue;
    }
    const profile = catalog.find((agent) => agent.id === node.agentId);
    if (!profile) {
      issues.push({
        kind: 'unknown-agent',
        message: `节点 ${node.id} 引用了目录里不存在的 Agent：${node.agentId}`,
        nodeIds: [node.id],
      });
      continue;
    }
    if (!profile.enabled) {
      issues.push({
        kind: 'disabled-agent',
        message: `节点 ${node.id} 引用的 ${profile.label} 未启用`,
        nodeIds: [node.id],
      });
    }
    if (options.requireInstalled && profile.availability === 'missing') {
      issues.push({
        kind: 'agent-not-installed',
        message: `节点 ${node.id} 引用的 ${profile.label} 在本机未安装`,
        nodeIds: [node.id],
      });
    }
  }

  return { ok: issues.length === 0, issues };
}

/** 检测环并返回环上的节点序列。 */
function findCycle(
  nodes: DagNode[],
  byId: Map<string, DagNode>,
): string[] | undefined {
  const state = new Map<string, 'visiting' | 'done'>();
  const stack: string[] = [];

  const visit = (id: string): string[] | undefined => {
    const current = byId.get(id);
    if (!current) {
      return undefined;
    }
    const status = state.get(id);
    if (status === 'done') {
      return undefined;
    }
    if (status === 'visiting') {
      const start = stack.indexOf(id);
      return [...stack.slice(start), id];
    }

    state.set(id, 'visiting');
    stack.push(id);
    for (const dependency of current.dependsOn) {
      const found = visit(dependency);
      if (found) {
        return found;
      }
    }
    stack.pop();
    state.set(id, 'done');
    return undefined;
  };

  for (const node of nodes) {
    const found = visit(node.id);
    if (found) {
      return found;
    }
  }
  return undefined;
}

/** 两个节点之间是否存在祖先/后代关系（含传递）。 */
function areOrdered(
  left: DagNode,
  right: DagNode,
  byId: Map<string, DagNode>,
): boolean {
  const reaches = (from: string, target: string): boolean => {
    const seen = new Set<string>();
    const queue = [from];
    while (queue.length > 0) {
      const current = queue.shift();
      if (current === undefined) {
        break;
      }
      if (current === target) {
        return true;
      }
      if (seen.has(current)) {
        continue;
      }
      seen.add(current);
      const node = byId.get(current);
      if (!node) {
        continue;
      }
      queue.push(...node.dependsOn);
    }
    return false;
  };

  return reaches(left.id, right.id) || reaches(right.id, left.id);
}

/** 供 API 层复用的可用性标签。 */
export const availabilityOrder: AgentAvailability[] = [
  'ready',
  'installed',
  'missing',
];

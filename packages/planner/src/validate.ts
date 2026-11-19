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
  /** 结构层错误（字段缺失、枚举越界）。也要回灌给 Agent，否则它会一直重犯 */
  | 'schema-invalid'
  | 'action-not-allowed'
  | 'missing-deliverable'
  | 'invalid-deliverable'
  | 'missing-acceptance'
  | 'incomplete-delivery';

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
  options: { requireInstalled?: boolean; requireDeliverables?: boolean } = {},
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

  const ancestry = new Map<string, Set<string>>();
  function ancestors(id: string) {
    const known = ancestry.get(id);
    if (known) return known;
    const found = findAncestors(id, byId);
    ancestry.set(id, found);
    return found;
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
      if (ancestors(left.id).has(right.id) || ancestors(right.id).has(left.id)) {
        // 有先后关系，允许范围重叠
        continue;
      }
      if (filesConflict(
        [...left.files, ...(left.deliverables ?? []).map((item) => item.path)],
        [...right.files, ...(right.deliverables ?? []).map((item) => item.path)],
      )) {
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

  for (const node of dag.nodes) {
    const declared = node.deliverables ?? [];
    const unique = new Set(declared.map(({ path }) => path.toLowerCase()));
    if (declared.length > 0 && (node.type !== 'implement' || unique.size !== declared.length ||
        declared.some(({ path }) => node.files.length > 0 && !filesConflict([path], node.files)))) {
      issues.push({ kind: 'invalid-deliverable', message: `节点 ${node.id} 的交付文件须属于实现节点，路径须唯一并落在改动范围内`, nodeIds: [node.id] });
    }
    if (options.requireDeliverables && node.type === 'implement' && declared.length === 0) {
      issues.push({ kind: 'missing-deliverable', message: `节点 ${node.id} 至少需要一个具体的交付文件`, nodeIds: [node.id] });
    }
    if (options.requireDeliverables && (node.type === 'implement' || node.type === 'review') && !node.acceptance?.length) {
      issues.push({ kind: 'missing-acceptance', message: `节点 ${node.id} 需要至少一个可核对的验收条件`, nodeIds: [node.id] });
    }
  }

  if (options.requireDeliverables && implements_.length > 0 && !cycle) {
    const mergeNodes = dag.nodes.filter((node) => node.action === 'merge');
    const approved = new Set<string>();
    for (const merge of mergeNodes) {
      for (const id of ancestors(merge.id)) {
        if (byId.get(id)?.type !== 'approval') continue;
        for (const upstream of ancestors(id)) approved.add(upstream);
      }
    }
    const missing = implements_.filter((node) => !approved.has(node.id));
    if (missing.length > 0) {
      issues.push({
        kind: 'incomplete-delivery', nodeIds: missing.map((node) => node.id),
        message: '每个实现节点都需要一条经过人工审批并进入合并交付的依赖链。',
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

function findAncestors(id: string, byId: Map<string, DagNode>): Set<string> {
  const seen = new Set<string>();
  const queue = [...(byId.get(id)?.dependsOn ?? [])];
  for (let index = 0; index < queue.length; index += 1) {
    const current = queue[index]!;
    if (seen.has(current)) continue;
    seen.add(current);
    queue.push(...(byId.get(current)?.dependsOn ?? []));
  }
  return seen;
}

/** 供 API 层复用的可用性标签。 */
export const availabilityOrder: AgentAvailability[] = [
  'ready',
  'installed',
  'missing',
];

import type { DagAmendment, NodeFacts, RunFacts } from '@orchestrator/core';
import { AMENDABLE_FIELDS, type Dag, type DagNode } from '@orchestrator/planner';

/**
 * 白名单闸门：把「Agent 交回来的新图」与「当前图」比对，算出真正能落地的改动。
 *
 * 为什么判定放在服务端而不是 Planner 里：
 * Planner 拿到的只是一张图，它不知道哪个节点已经跑过了。而「已开始的节点不许改」
 * 这条边界如果交给模型自觉，等于没有边界——模型换个说法、多改一个节点，
 * 事实就被篡改了，而且没有任何一处能拦住它。所以：
 *   Planner 负责「提出一张合法的新图」（结构层面），
 *   这里负责「哪些改动允许生效」（审计层面）。
 *
 * 被拒的改动一律带上可读理由返回给界面。静默丢弃是最差的选择：用户会以为
 * 指令已经照办，直到运行跑完才发现图没变。
 */

export interface RejectedAmendment {
  nodeId: string;
  reason: string;
}

export interface AmendmentPlan {
  applied: DagAmendment[];
  rejected: RejectedAmendment[];
}

/** 允许被 `add-node` 引入的节点类型：审批要人、路由是编排器自己的事，都不外挂。 */
const ADDABLE_TYPES: ReadonlyArray<DagNode['type']> = ['implement', 'review'];

/** 审计回显里单个字段值的长度上限，避免一段长描述把整条回复撑爆。 */
const FIELD_VALUE_LIMIT = 48;

function clip(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > FIELD_VALUE_LIMIT
    ? `${trimmed.slice(0, FIELD_VALUE_LIMIT)}…`
    : trimmed;
}

/** 图节点 → 节点事实。`base` 存在时保留它的执行事实（attempts 等）。 */
function factsFromNode(node: DagNode, base?: NodeFacts): NodeFacts {
  return {
    ...base,
    id: node.id,
    type: node.type,
    title: node.title,
    description: node.description,
    dependsOn: node.dependsOn,
    files: node.files,
    agentId: node.agentId,
    executor: node.executor,
    action: node.action,
    attempts: base?.attempts ?? 0,
    maxAttempts: node.maxAttempts,
  };
}

/**
 * 由运行事实重建 Planner 契约形状的 DAG。
 *
 * 为什么不让 Planner 直接吃 `NodeFacts`：事实里塞满了执行过程（attempts、
 * 产物统计、会话 id），把整包丢给 Agent 只会让 prompt 变成一堵墙。反过来，
 * 让 Planner 依赖 core 的事实类型又会让「图」这层契约跟着执行层一起漂。
 * 转换只在这一处发生，两边各自稳定。
 */
export function dagFromFacts(run: RunFacts): Dag {
  const nodes: DagNode[] = [];
  for (const id of run.nodeOrder) {
    const facts = run.nodes[id];
    if (!facts) {
      continue;
    }
    nodes.push({
      id: facts.id,
      type: facts.type,
      title: facts.title,
      description: facts.description,
      dependsOn: [...facts.dependsOn],
      files: [...facts.files],
      agentId: facts.agentId,
      executor: facts.executor,
      maxAttempts: facts.maxAttempts,
      action: facts.action,
    });
  }
  return {
    title: run.title,
    summary: run.summary,
    specVersion: run.specVersion,
    nodes,
  };
}

/** 节点是否已经产生执行事实（开始过或结束过）。 */
function isStarted(facts: NodeFacts | undefined): boolean {
  return Boolean(facts?.startedAt || facts?.finishedAt);
}

/** 已开始节点为什么不能改，写成一句人能读懂的话。 */
function lockedReason(facts: NodeFacts): string {
  const when = facts.startedAt ?? facts.finishedAt;
  return `节点已经开始执行（${when}），图结构对它的职责已经生效，不能再改；要换做法请新建一个节点`;
}

/** 字段值压成审计用的字符串。数组用逗号连接，空值用 `—` 表示。 */
function fieldText(field: string, node: DagNode): string | undefined {
  switch (field) {
    case 'agentId':
      return clip(node.agentId);
    case 'title':
      return clip(node.title);
    case 'description':
      return clip(node.description);
    case 'files':
      return clip(node.files.join(', '));
    case 'maxAttempts':
      return String(node.maxAttempts);
    default:
      return undefined;
  }
}

/** 允许通过对话修改的字段集合，来自 Planner 那一份白名单，两边不会各自漂移。 */
const amendable = new Set<string>(AMENDABLE_FIELDS);

function sameList(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((item, index) => item === right[index]);
}

/**
 * 新旧图比对。
 *
 * 只有 `run` 里存在并且确实开始过的节点才算「锁定」；新加进来的节点天然
 * 不在事实里，因此永远可改——这正是「把消息模块拆成两个节点」需要的那种自由。
 */
export function diffDag(current: Dag, next: Dag, run: RunFacts): AmendmentPlan {
  const applied: DagAmendment[] = [];
  const rejected: RejectedAmendment[] = [];

  const currentById = new Map(current.nodes.map((node) => [node.id, node] as const));
  const nextById = new Map(next.nodes.map((node) => [node.id, node] as const));

  for (const node of next.nodes) {
    const before = currentById.get(node.id);

    // ---- 新增 ----
    if (!before) {
      if (!ADDABLE_TYPES.includes(node.type)) {
        rejected.push({
          nodeId: node.id,
          reason: `新增节点只允许 implement 或 review，${node.type} 节点请直接在 DAG 里定义`,
        });
        continue;
      }
      if (!node.agentId) {
        rejected.push({
          nodeId: node.id,
          reason: '新增的实现 / 审查节点必须指定 agentId',
        });
        continue;
      }
      applied.push({
        kind: 'add-node',
        nodeId: node.id,
        fields: [
          { field: 'type', to: node.type },
          { field: 'agentId', to: node.agentId },
          { field: 'dependsOn', to: node.dependsOn.join(', ') || '—' },
        ],
        node: factsFromNode(node),
      });
      continue;
    }

    // ---- 修改 ----
    const facts = run.nodes[node.id];
    const locked = isStarted(facts);

    // 越权字段：type 与 dependsOn 一律不许通过对话改
    const illegal: string[] = [];
    if (before.type !== node.type) {
      illegal.push('type');
    }
    if (!sameList(before.dependsOn, node.dependsOn)) {
      illegal.push('dependsOn');
    }
    if (illegal.length > 0) {
      rejected.push({
        nodeId: node.id,
        reason: `只允许改 ${AMENDABLE_FIELDS.join(' / ')}；${illegal.join('、')} 不在允许修改的字段里`,
      });
    }

    const fields: Array<{ field: string; from?: string; to?: string }> = [];
    for (const field of AMENDABLE_FIELDS) {
      if (field === 'agentId') {
        if (before.agentId !== node.agentId) {
          fields.push({
            field,
            from: fieldText(field, before),
            to: fieldText(field, node),
          });
        }
        continue;
      }
      if (field === 'files') {
        if (!sameList(before.files, node.files)) {
          fields.push({
            field,
            from: fieldText(field, before),
            to: fieldText(field, node),
          });
        }
        continue;
      }
      if (field === 'maxAttempts') {
        if (before.maxAttempts !== node.maxAttempts) {
          fields.push({
            field,
            from: fieldText(field, before),
            to: fieldText(field, node),
          });
        }
        continue;
      }
      // title / description
      if (before[field] !== node[field]) {
        fields.push({
          field,
          from: fieldText(field, before),
          to: fieldText(field, node),
        });
      }
    }

    if (fields.length === 0) {
      continue;
    }

    if (locked && facts) {
      rejected.push({ nodeId: node.id, reason: lockedReason(facts) });
      continue;
    }

    // 只把白名单字段的新值带进事件：`node` 里其余字段取自当前图，
    // 免得一条「改标题」的改动顺手把别的字段也覆盖成本轮 Agent 的想象。
    const merged: DagNode = { ...before };
    for (const change of fields) {
      if (!amendable.has(change.field)) {
        continue;
      }
      if (change.field === 'files') {
        merged.files = [...node.files];
      } else if (change.field === 'maxAttempts') {
        merged.maxAttempts = node.maxAttempts;
      } else if (change.field === 'agentId') {
        merged.agentId = node.agentId;
      } else if (change.field === 'title') {
        merged.title = node.title;
      } else if (change.field === 'description') {
        merged.description = node.description;
      }
    }

    applied.push({
      kind: 'update-node',
      nodeId: node.id,
      fields,
      node: factsFromNode(merged, facts),
    });
  }

  // ---- 删除 ----
  for (const node of current.nodes) {
    if (nextById.has(node.id)) {
      continue;
    }
    const facts = run.nodes[node.id];
    if (facts && isStarted(facts)) {
      rejected.push({ nodeId: node.id, reason: lockedReason(facts) });
      continue;
    }
    // 被已开始节点依赖：删掉它会让下游节点的历史失去依据（那条边指向空气）
    const blockedBy = current.nodes.find(
      (candidate) =>
        candidate.id !== node.id &&
        candidate.dependsOn.includes(node.id) &&
        isStarted(run.nodes[candidate.id]),
    );
    if (blockedBy) {
      rejected.push({
        nodeId: node.id,
        reason: `节点 ${blockedBy.id} 已经开始执行，并且依赖这个节点，删掉它会让那条依赖指向不存在的上游`,
      });
      continue;
    }
    applied.push({ kind: 'remove-node', nodeId: node.id });
  }

  return { applied, rejected };
}

/** 一条改动的中文回显。界面直接铺这里的结果，不再自己拼句子。 */
export function describeAmendment(amendment: DagAmendment): string {
  if (amendment.kind === 'add-node') {
    const agent = amendment.fields?.find((field) => field.field === 'agentId')?.to;
    return `新增节点 ${amendment.nodeId}${agent ? `（由 ${agent} 执行）` : ''}`;
  }
  if (amendment.kind === 'remove-node') {
    return `移除节点 ${amendment.nodeId}`;
  }
  const fields = (amendment.fields ?? [])
    .map((field) => `${field.field}：${field.from ?? '—'} → ${field.to ?? '—'}`)
    .join('，');
  return `${amendment.nodeId} 的 ${fields}`;
}

/**
 * 拼给用户的回复。
 *
 * 刻意由后端拼而不是让 Agent 自由发挥：这条回复要回答的是「到底改了什么」，
 * 而唯一权威的答案就是服务端真正落地的 `applied` / `rejected`。让模型自己
 * 复述一遍，就会出现「它说换了 codex，图上还是 claude」这类最难查的偏差。
 */
export function buildAmendmentReply(plan: AmendmentPlan): string {
  if (plan.applied.length === 0 && plan.rejected.length === 0) {
    return '没有需要修改的地方：这张图已经符合你的指令。';
  }

  const lines: string[] = [];
  if (plan.applied.length > 0) {
    lines.push('已按指令修改任务图：');
    for (const amendment of plan.applied) {
      lines.push(`- ${describeAmendment(amendment)}`);
    }
  }
  if (plan.rejected.length > 0) {
    if (lines.length > 0) {
      lines.push('');
    }
    lines.push('这些改动没有生效：');
    for (const item of plan.rejected) {
      lines.push(`- ${item.nodeId}：${item.reason}`);
    }
  }
  return lines.join('\n');
}

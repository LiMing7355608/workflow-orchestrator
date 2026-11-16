import { deriveNodeStatus } from './derive.js';
import type { NodeFacts, RunFacts } from './types.js';

/** 默认并发上限。真实值由配置控制，避免一次拉起太多 Agent 进程。 */
export const DEFAULT_CONCURRENCY = 3;

/**
 * 把 glob 归一成可比较的路径前缀。
 *
 * `src/auth/**` → `src/auth`，`src/**\/*.ts` → `src`。
 * 这是并行安全的静态近似，不是完整的 glob 交集判定——
 * 真正的隔离由每个节点独占的 worktree 兜底。
 */
function normalizePattern(pattern: string): string {
  const trimmed = pattern.replace(/\\/g, '/').trim();
  const wildcard = trimmed.search(/[*?[]/);
  const prefix = wildcard === -1 ? trimmed : trimmed.slice(0, wildcard);
  return prefix.replace(/\/+$/, '');
}

function sharesPrefix(a: string, b: string): boolean {
  if (a === '' || b === '') {
    // 空模式视为覆盖全仓，与任何范围冲突
    return true;
  }
  return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

/** 两个节点的独占文件范围是否相交。相交的节点不允许同批并行。 */
export function filesConflict(left: string[], right: string[]): boolean {
  if (left.length === 0 || right.length === 0) {
    return false;
  }
  for (const a of left) {
    for (const b of right) {
      if (sharesPrefix(normalizePattern(a), normalizePattern(b))) {
        return true;
      }
    }
  }
  return false;
}

/** 当前进入就绪集合的节点：依赖全部完成、自身尚未开始。 */
export function readyNodes(run: RunFacts): NodeFacts[] {
  return run.nodeOrder
    .map((id) => run.nodes[id])
    .filter((node): node is NodeFacts => Boolean(node))
    .filter((node) => deriveNodeStatus(run, node) === 'ready');
}

/**
 * 从就绪集合里挑出这一批可以并行执行的节点。
 *
 * 规则：按并发上限截断，且批内实现节点的独占文件范围必须互不相交。
 * 审查与审批节点没有文件范围，不参与冲突检查。
 */
export function pickBatch(
  run: RunFacts,
  concurrency: number = DEFAULT_CONCURRENCY,
): NodeFacts[] {
  const batch: NodeFacts[] = [];

  for (const node of readyNodes(run)) {
    if (batch.length >= concurrency) {
      break;
    }
    const conflict = batch.some(
      (picked) =>
        picked.type === 'implement' &&
        node.type === 'implement' &&
        filesConflict(picked.files, node.files),
    );
    if (conflict) {
      continue;
    }
    batch.push(node);
  }

  return batch;
}

/**
 * 审查被驳回的次数是否已经超限。
 * 超限后不再自动回退，而是升级到人工审批。
 */
export function shouldEscalate(node: NodeFacts): boolean {
  return node.attempts > node.maxAttempts;
}

/**
 * 一轮调度之后，是否应当宣告整次运行结束。
 * 判据是事实：所有节点都已完成，且没有节点还在跑。
 */
export function isRunSettled(run: RunFacts): boolean {
  const nodes = Object.values(run.nodes);
  if (nodes.length === 0) {
    return false;
  }
  return nodes.every((node) => deriveNodeStatus(run, node) === 'completed');
}

/** 是否存在需要人工介入的节点（审批等待或审查超限升级）。 */
export function pendingHumanWork(run: RunFacts): NodeFacts[] {
  return Object.values(run.nodes).filter(
    (node) => deriveNodeStatus(run, node) === 'waiting_approval',
  );
}

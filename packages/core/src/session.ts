/**
 * 会话解析：决定一次节点执行能不能接上上一轮的 Agent 会话。
 *
 * 节点重跑（审查驳回、审批退回、运行恢复）时，最贵的成本是 Agent 重新
 * 建立上下文。能不能续跑完全取决于平台提供什么样的会话锚点：
 * 我们自己派生的 uuidv5，还是从流式输出里捕获到的原生 id。
 *
 * 本文件刻意不引入任何 Node 内置模块——UUID 派生需要 node:crypto，
 * 那部分由宿主注入（`deriveId`），内核只负责判断「该用谁、能不能用」。
 * 这样前端打包同一份逻辑时不会被 Node 内置模块拖住。
 */

import type { AgentProfile } from './agents.js';
import type { NodeFacts } from './types.js';

export interface SessionResolution {
  /** 可复用的原生会话 id；没有则可复用时为 undefined */
  sessionId?: string;
  /** 是不是续跑 */
  resumable: boolean;
  /** 说明为什么不能续跑，用于事件与排障 */
  reason?: string;
  /**
   * 首轮启动时就该钉住的会话 id。确定性派生型永远有值，
   * 钩子捕获型只有在本轮之前就拿到过 id 时才有。
   */
  plannedSessionId?: string;
}

/**
 * 判断某节点的这一轮执行能不能复用上一轮会话。
 *
 * 判定顺序是有原因的：先看平台支不支持（不支持就别再往下算了），
 * 再看是不是第一次跑（首次执行没有「上一轮」可言），最后才按 derive
 * 方式取 id。任何一条走不通都返回「不可续跑 + 原因」，理由从不吞掉——
 * 续跑降级成新跑是正常行为，但必须能被日志解释清楚。
 *
 * `runId` 单独作为参数，而不是从 `NodeFacts` 里取：事实表本身就是以 run
 * 为单位组织的，节点不必重复记 runId。它只在 `uuidv5` 分支里被用到——
 * 派生器要「同一对 (runId, nodeId) 永远得到同一个 id」，runId 缺了这条
 * 性质就无从谈起。
 */
export function resolveSession(
  agent: AgentProfile,
  facts: NodeFacts,
  deriveId?: (runId: string, nodeId: string) => string,
  runId = '',
): SessionResolution {
  const spec = agent.session;

  if (spec.derive === 'none') {
    return { resumable: false, reason: '该 Agent 不支持续跑' };
  }

  // 确定性派生型即使首轮也先算好 id：平台侧得先有这个会话，
  // 后面才谈得上按同一个 id 接上。首轮把它通过 newSessionArgs 钉进去。
  const plannedSessionId =
    spec.derive === 'uuidv5' && deriveId ? deriveId(runId, facts.id) : undefined;

  /**
   * 「首轮不续」这条只对 `uuidv5` 成立。
   *
   * uuidv5 的 id 是算出来的，首轮必须用 `--session-id` 把它钉进平台，否则
   * 后面永远接不上——所以首轮不能带 `--resume`。
   *
   * 而 `hooked` 的 id 是**捕获来的**：有就是有（上一轮真跑过），没有就是没有。
   * 早先这里不看 derive 模式、一律用 `attempts === 0` 判首轮，后果是「用户重置
   * 节点后重跑」被当成首轮——reset 不涨 attempts，于是捕获到的会话 id 被丢弃，
   * 每次都开新会话。实测撞到过：一个 dsh 节点第一轮记住「7391」、第二轮问它，
   * 它答得出来，但那是 dsh 自己的 profile 复用了会话，不是我们在续跑；换成两个
   * 不同节点就会互相串话。
   */
  if (facts.attempts === 0 && spec.derive === 'uuidv5') {
    // 首次执行没有上一轮上下文，把续跑参数传进去只会换来一句「会话不存在」
    return { resumable: false, reason: '首次执行', plannedSessionId };
  }

  if (spec.derive === 'hooked') {
    // 原生 id 只出现在流式输出里：回放、无 hook、Agent 提前崩掉都拿不到。
    // 拿不到就降级为新跑，这不是错误。
    if (!facts.nativeSessionId) {
      return {
        resumable: false,
        reason: '没有捕获到原生会话 id',
        plannedSessionId,
      };
    }
    return { sessionId: facts.nativeSessionId, resumable: true };
  }

  // derive === 'uuidv5'：由编排器自己派生，重启后算得出同一个 id，
  // 所以这里不存在「没捕获到 id」的降级，缺的只可能是派生器本身。
  if (!deriveId || !plannedSessionId) {
    return { resumable: false, reason: '缺少确定性派生器' };
  }
  return {
    sessionId: plannedSessionId,
    resumable: true,
    plannedSessionId,
  };
}

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_AGENT_PROFILES,
  resolveSession,
  type AgentProfile,
  type NodeFacts,
} from '../src/index';

function agentOf(id: string): AgentProfile {
  const found = DEFAULT_AGENT_PROFILES.find((profile) => profile.id === id);
  if (!found) {
    throw new Error(`目录里没有 ${id}`);
  }
  return found;
}

function node(partial: Partial<NodeFacts> = {}): NodeFacts {
  return {
    id: 'impl-a',
    type: 'implement',
    title: '实现',
    description: '',
    dependsOn: [],
    files: [],
    attempts: 0,
    maxAttempts: 3,
    ...partial,
  };
}

describe('会话解析：续跑判定', () => {
  it("derive 为 none 的平台永远不续跑", () => {
    // workbuddy 的 profile 声明 derive: 'none'
    const result = resolveSession(
      agentOf('workbuddy'),
      node({ attempts: 2, nativeSessionId: 'sess-x' }),
    );

    expect(result.resumable).toBe(false);
    expect(result.sessionId).toBeUndefined();
    expect(result.reason).toBe('该 Agent 不支持续跑');
  });

  it('首次执行不续跑，即使平台支持派生', () => {
    const result = resolveSession(
      agentOf('claude'),
      node({ attempts: 0 }),
      () => 'never-used',
    );

    expect(result.resumable).toBe(false);
    expect(result.sessionId).toBeUndefined();
    expect(result.reason).toBe('没有捕获到原生会话 id');
  });

  it('hooked 平台捕获到原生会话 id 时续跑', () => {
    const result = resolveSession(
      agentOf('dsh-acp'),
      node({ attempts: 1, nativeSessionId: 'acp-session-7' }),
    );

    expect(result.resumable).toBe(true);
    expect(result.sessionId).toBe('acp-session-7');
    expect(result.reason).toBeUndefined();
  });

  it('hooked 平台没捕获到原生 id 时降级为新跑，并说明原因', () => {
    // 回放 / 无 hook 场景下的正常降级，不是错误
    const result = resolveSession(agentOf('dsh-acp'), node({ attempts: 1 }));

    expect(result.resumable).toBe(false);
    expect(result.sessionId).toBeUndefined();
    expect(result.reason).toBe('没有捕获到原生会话 id');
  });

  it('uuidv5 平台用注入的派生器算出 id，runId 与 nodeId 都传进去', () => {
    const seen: Array<[string, string]> = [];
    const result = resolveSession(
      agentOf('qoder'),
      node({ id: 'impl-b', attempts: 1 }),
      (runId, nodeId) => {
        seen.push([runId, nodeId]);
        return `uuid-${runId}-${nodeId}`;
      },
      'run-9',
    );

    expect(seen).toEqual([['run-9', 'impl-b']]);
    expect(result.resumable).toBe(true);
    expect(result.sessionId).toBe('uuid-run-9-impl-b');
    expect(result.reason).toBeUndefined();
  });

  it('uuidv5 平台没有注入派生器时不续跑', () => {
    const result = resolveSession(agentOf('qoder'), node({ attempts: 1 }), undefined, 'run-9');

    expect(result.resumable).toBe(false);
    expect(result.sessionId).toBeUndefined();
    expect(result.reason).toBe('缺少确定性派生器');
  });
});

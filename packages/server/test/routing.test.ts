import { describe, expect, it } from 'vitest';
import type {
  AgentCancelRequest,
  AgentProfile,
  AgentRunRequest,
  AgentRunResult,
  AgentRunner,
  AgentTransport,
} from '@orchestrator/core';
import { transportResolver } from '../src/runners/routing.js';

/**
 * 分派器的两个职责：按 transport 选执行器、取消时广播。
 *
 * 用假的 AgentRunner 验，不碰真的 SDK 与进程：这里要断言的是「选谁」，
 * 不是「它跑得好不好」。
 */

function fakeRunner(name: string): AgentRunner & {
  calls: AgentRunRequest[];
  cancels: AgentCancelRequest[];
} {
  const calls: AgentRunRequest[] = [];
  const cancels: AgentCancelRequest[] = [];
  return {
    calls,
    cancels,
    run(request: AgentRunRequest): Promise<AgentRunResult> {
      calls.push(request);
      return Promise.resolve({ ok: true, exitCode: 0, output: name });
    },
    cancel(request: AgentCancelRequest): Promise<number> {
      cancels.push(request);
      return Promise.resolve(1);
    },
  };
}

/**
 * 复刻 RoutingAgentRunner 的分派规则，但注入假执行器。
 *
 * 直接 new RoutingAgentRunner 会拉起真的 SpawnAgentRunner / ClaudeSdkRunner，
 * 那两条路都会去碰外部世界。这里只关心分派表本身。
 */
class TestRouter implements AgentRunner {
  readonly cli = fakeRunner('cli');
  readonly sdk = fakeRunner('sdk');

  constructor(private readonly transportOf: (agentId: string) => AgentTransport) {}

  run(request: AgentRunRequest, _onChunk: (chunk: string) => void) {
    return (this.transportOf(request.agentId) === 'claude-sdk'
      ? this.sdk
      : this.cli
    ).run(request, _onChunk);
  }

  async cancel(request: AgentCancelRequest): Promise<number> {
    const counts = await Promise.all([
      this.cli.cancel?.(request) ?? 0,
      this.sdk.cancel?.(request) ?? 0,
    ]);
    return counts.reduce((sum, count) => sum + count, 0);
  }
}

function profile(id: string, transport?: AgentTransport): AgentProfile {
  return { id, transport } as AgentProfile;
}

function request(agentId: string): AgentRunRequest {
  return {
    runId: 'run-routing',
    nodeId: 'n1',
    agentId,
    bin: agentId,
    argv: [],
    cwd: '.',
    timeoutMs: 1000,
    policy: 'default',
  };
}

describe('按 transport 分派执行器', () => {
  it('声明 claude-sdk 的走 SDK，其余走 CLI', async () => {
    const router = new TestRouter(
      transportResolver(() => [profile('claude', 'claude-sdk'), profile('codex')]),
    );

    await router.run(request('claude'), () => {});
    await router.run(request('codex'), () => {});

    expect(router.sdk.calls.map((call) => call.agentId)).toEqual(['claude']);
    expect(router.cli.calls.map((call) => call.agentId)).toEqual(['codex']);
  });

  it('没声明 transport 的按 cli 处理（旧目录兼容）', async () => {
    const router = new TestRouter(transportResolver(() => [profile('legacy')]));
    await router.run(request('legacy'), () => {});
    expect(router.cli.calls).toHaveLength(1);
    expect(router.sdk.calls).toHaveLength(0);
  });

  it('目录里没有的 agent 也按 cli 处理，不静默跳过', async () => {
    const router = new TestRouter(transportResolver(() => []));
    await router.run(request('unknown'), () => {});
    expect(router.cli.calls).toHaveLength(1);
  });

  it('目录是 getter，探测之后换了 transport 立刻生效', () => {
    let catalog: AgentProfile[] = [profile('claude', 'claude-sdk')];
    const resolve = transportResolver(() => catalog);
    expect(resolve('claude')).toBe('claude-sdk');

    // 探测把目录整体替换（真实场景：用户新装/卸载了某个平台）
    catalog = [profile('claude')];
    expect(resolve('claude')).toBe('cli');
  });

  it('取消广播给所有执行器，数量相加', async () => {
    const router = new TestRouter(transportResolver(() => []));
    const total = await router.cancel({ runId: 'run-routing' });

    // 两个执行器都收到同一个请求：我们不知道它当初落在哪条路上
    expect(router.cli.cancels).toHaveLength(1);
    expect(router.sdk.cancels).toHaveLength(1);
    expect(total).toBe(2);
  });
});

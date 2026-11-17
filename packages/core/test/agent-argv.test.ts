import { describe, expect, it } from 'vitest';
import { DEFAULT_AGENT_PROFILES, buildAgentArgv, type AgentProfile } from '../src/index';

/**
 * 会话参数怎么拼进启动参数，取决于这个平台声明了哪种 `session.derive`：
 *
 * - `uuidv5`：编排器自己算出确定性的 id，**首轮就用 `--session-id` 钉住**，
 *   后续 `--resume`。qoder 仍是这种（它接口对齐 Claude Code）。
 * - `hooked`：**不钉**，让平台自己铸 id，编排器从流式输出里捕获，下一轮
 *   `--resume`。claude 与 dsh 走这条。
 *
 * claude 从 uuidv5 改成 hooked 是因为前者在它身上有个无法绕过的语义冲突：
 * `--session-id` 是「创建并占用」，不幂等，那个 id 一旦被用过就永久报
 * `already in use`，而 `attempts` 只在审查驳回时涨——执行失败重试永远被当成
 * 首轮，那个节点从此跑不起来。
 */

const claude = DEFAULT_AGENT_PROFILES.find((agent) => agent.id === 'claude');
const dsh = DEFAULT_AGENT_PROFILES.find((agent) => agent.id === 'dsh-acp');
const qoder = DEFAULT_AGENT_PROFILES.find((agent) => agent.id === 'qoder');

describe('会话参数拼装', () => {
  it('uuidv5 平台在首轮就把会话 id 钉进启动参数', () => {
    expect(qoder).toBeDefined();
    const argv = buildAgentArgv(qoder as AgentProfile, {
      prompt: '做点什么',
      policy: 'default',
      session: 'sess-1',
      resume: false,
    });

    // 首轮不指定的话平台侧不存在该会话，后面 --resume 就接不上
    expect(argv).toContain('--session-id');
    expect(argv[argv.indexOf('--session-id') + 1]).toBe('sess-1');
    expect(argv).not.toContain('--resume');
  });

  it('uuidv5 平台续跑用 --resume，不再重复指定 --session-id', () => {
    const argv = buildAgentArgv(qoder as AgentProfile, {
      prompt: '做点什么',
      policy: 'default',
      session: 'sess-1',
      resume: true,
    });

    expect(argv).toContain('--resume');
    expect(argv[argv.indexOf('--resume') + 1]).toBe('sess-1');
    expect(argv).not.toContain('--session-id');
  });

  it('hooked 平台首轮**不**钉会话 id，让平台自己铸', () => {
    expect(claude).toBeDefined();
    const argv = buildAgentArgv(claude as AgentProfile, {
      prompt: '做点什么',
      policy: 'default',
      session: 'sess-1',
      resume: false,
    });

    /**
     * 这一条是从失败里学来的。钉住一个自己算的 id 意味着「创建一个已经存在的
     * 会话」这种操作会出现——而它对 claude 是硬错误，不是覆盖。
     */
    expect(argv).not.toContain('--session-id');
    expect(argv).not.toContain('--resume');
  });

  it('hooked 平台续跑用 --resume 接上捕获到的 id', () => {
    const argv = buildAgentArgv(claude as AgentProfile, {
      prompt: '做点什么',
      policy: 'default',
      session: 'captured-uuid',
      resume: true,
    });

    expect(argv).toContain('--resume');
    expect(argv[argv.indexOf('--resume') + 1]).toBe('captured-uuid');
  });

  it('dsh 也是 hooked：首轮不带会话参数', () => {
    expect(dsh).toBeDefined();
    const argv = buildAgentArgv(dsh as AgentProfile, {
      prompt: '做点什么',
      policy: 'default',
      session: 'sess-1',
      resume: false,
    });

    expect(argv).not.toContain('--session-id');
    expect(argv).not.toContain('--resume');
  });

  it('提示词里的 JSON 花括号不会被误判成未替换占位符', () => {
    const argv = buildAgentArgv(claude as AgentProfile, {
      prompt: '{"title":"x","nodes":[]}',
      policy: 'default',
      session: 'sess-1',
    });

    // claude 走 stdin，提示词本来就不该进 argv
    expect(argv.some((arg) => arg.includes('nodes'))).toBe(false);
  });
});

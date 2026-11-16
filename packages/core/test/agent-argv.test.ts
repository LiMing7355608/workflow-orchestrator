import { describe, expect, it } from 'vitest';
import { DEFAULT_AGENT_PROFILES, buildAgentArgv } from '../src/index';

const claude = DEFAULT_AGENT_PROFILES.find((agent) => agent.id === 'claude');
const dsh = DEFAULT_AGENT_PROFILES.find((agent) => agent.id === 'dsh');

describe('会话参数拼装', () => {
  it('确定性派生型在首轮就把会话 id 钉进启动参数', () => {
    expect(claude).toBeDefined();
    const argv = buildAgentArgv(claude!, {
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

  it('续跑用 --resume，不再重复指定 --session-id', () => {
    const argv = buildAgentArgv(claude!, {
      prompt: '做点什么',
      policy: 'default',
      session: 'sess-1',
      resume: true,
    });

    expect(argv).toContain('--resume');
    expect(argv[argv.indexOf('--resume') + 1]).toBe('sess-1');
    expect(argv).not.toContain('--session-id');
  });

  it('没有会话 id 时两套参数都不出现，不拼出字面量占位符', () => {
    const argv = buildAgentArgv(claude!, {
      prompt: '做点什么',
      policy: 'default',
    });

    expect(argv).not.toContain('--session-id');
    expect(argv).not.toContain('--resume');
    expect(argv.some((arg) => arg.includes('{session}'))).toBe(false);
  });

  it('不支持续跑的 Agent 即使给了 session 也不拼参数', () => {
    expect(dsh).toBeDefined();
    const argv = buildAgentArgv(dsh!, {
      prompt: '做点什么',
      policy: 'default',
      session: 'sess-1',
      resume: true,
    });

    // dsh 的 resumeArgs / newSessionArgs 都是空，不该凭空出现会话参数
    expect(argv.some((arg) => arg.includes('sess-1'))).toBe(false);
  });

  it('提示词里的 JSON 花括号不会被误判成未替换占位符', () => {
    const argv = buildAgentArgv(claude!, {
      prompt: '{"title":"x","nodes":[]}',
      policy: 'default',
      session: 'sess-1',
    });

    // claude 走 stdin，提示词本来就不该进 argv
    expect(argv.some((arg) => arg.includes('nodes'))).toBe(false);
    expect(argv).toContain('--session-id');
  });
});

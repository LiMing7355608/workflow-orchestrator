import { describe, expect, it } from 'vitest';
import type { AgentRunRequest } from '@orchestrator/core';

/**
 * Codex 走 app-server 时，提示词是从 argv 里「猜」出来的。
 *
 * 这个猜法出过一个把整条编排链路废掉的 bug：`argv[0]` 是**程序名**（`codex`），
 * 而扫描从 0 开始。`codex` 不以 `-` 开头、也不是子命令，于是被当成第一个候选
 * 直接返回——不管节点写了什么任务，Agent 收到的提示词永远是「codex」。它把这
 * 理解成「用户在问 Codex 是什么」，于是每次都在自我介绍、读自己的 skill 文档。
 *
 * 对照：`acp.ts` 处理过同一个坑（「argv[0] 是程序名，照搬整条 argv 会把 bin 名
 * 当参数交给 agent」）。这里是同一个约定的另一半。
 */

/** 与 codex.ts 里一致：这些开关的参数值是独立的一个 token，要连值一起跳。 */
const VALUE_FLAGS = new Set([
  '--sandbox',
  '--cd',
  '-C',
  '--model',
  '-m',
  '--profile',
  '-p',
]);

/** 与 codex.ts 里一致：这些是子命令，不是提示词。 */
const SUBCOMMANDS = new Set(['exec', 'app-server']);

function pickPrompt(request: AgentRunRequest): string {
  const stdin = request.stdin;
  if (stdin !== undefined && stdin.trim() !== '') {
    return stdin;
  }

  const argv = request.argv;
  const separator = argv.lastIndexOf('--');
  if (separator >= 0 && separator < argv.length - 1) {
    const text = argv
      .slice(separator + 1)
      .filter((arg) => !VALUE_FLAGS.has(arg))
      .join(' ')
      .trim();
    if (text !== '') {
      return text;
    }
  }

  const start = argv[0] === request.bin ? 1 : 0;

  for (let index = start; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === undefined) {
      continue;
    }
    if (arg.startsWith('-')) {
      if (VALUE_FLAGS.has(arg)) {
        index += 1;
      }
      continue;
    }
    if (SUBCOMMANDS.has(arg)) {
      continue;
    }
    return arg;
  }

  return argv.slice(start).join(' ').trim();
}

function request(partial: Partial<AgentRunRequest>): AgentRunRequest {
  return {
    runId: 'run-codex-prompt',
    nodeId: 'impl-a',
    agentId: 'codex',
    bin: 'codex',
    argv: [],
    cwd: '.',
    timeoutMs: 1000,
    policy: 'default',
    ...partial,
  };
}

const TASK = '# 任务：实现计算器\n在 src/ 下实现四则运算';

describe('codex 从 argv 里取提示词', () => {
  it('程序名 codex 绝不能被当成提示词', () => {
    // 这就是那次事故的原样形状
    const prompt = pickPrompt(
      request({ argv: ['codex', 'exec', '--json', '--skip-git-repo-check', TASK] }),
    );
    expect(prompt).toBe(TASK);
    expect(prompt).not.toBe('codex');
  });

  it('跳过带值的开关，不能把它的值当提示词', () => {
    // `--sandbox read-only` 里的 read-only 不是任务
    const prompt = pickPrompt(
      request({
        argv: ['codex', 'exec', '--json', '--sandbox', 'read-only', TASK],
      }),
    );
    expect(prompt).toBe(TASK);
  });

  it('开关出现在提示词之后也不影响', () => {
    const prompt = pickPrompt(
      request({ argv: ['codex', 'exec', '--json', TASK, '--sandbox', 'read-only'] }),
    );
    expect(prompt).toBe(TASK);
  });

  it('stdin 优先：给了 stdin 就完全不看 argv', () => {
    const prompt = pickPrompt(
      request({ stdin: TASK, argv: ['codex', 'exec', '--json', '别的'] }),
    );
    expect(prompt).toBe(TASK);
  });

  it('argv 里没有程序名时（外部调用方传纯参数表），第一个真参数就是提示词', () => {
    const prompt = pickPrompt(request({ bin: 'codex', argv: ['--json', TASK] }));
    expect(prompt).toBe(TASK);
  });

  it('只有程序名、没有任务时，返回空串而不是 bin 名', () => {
    const prompt = pickPrompt(request({ argv: ['codex'] }));
    expect(prompt).toBe('');
  });
});

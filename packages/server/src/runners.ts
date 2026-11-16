import { spawn } from 'node:child_process';
import type {
  AgentRunRequest,
  AgentRunResult,
  AgentRunner,
} from '@orchestrator/core';
import { resolveExecutable } from './probe.js';

/**
 * 真实 Agent 执行器。
 *
 * 参数从不经过 shell：`resolveExecutable` 负责把 Windows 上的 .ps1 / .cmd
 * 包装成宿主命令，其余参数逐项传入，提示词走 stdin。这样提示词里的引号、
 * 管道符不会被重新解释。
 */
export class SpawnAgentRunner implements AgentRunner {
  async run(
    request: AgentRunRequest,
    onChunk: (chunk: string) => void,
  ): Promise<AgentRunResult> {
    const resolved = await resolveExecutable(request.bin);
    if (!resolved) {
      return {
        ok: false,
        exitCode: null,
        output: '',
        error: `找不到可执行文件：${request.bin}`,
      };
    }

    const args = [...resolved.prefixArgs, ...request.argv.slice(1)];

    return new Promise<AgentRunResult>((resolvePromise) => {
      let output = '';
      let timedOut = false;
      let settled = false;

      const child = spawn(resolved.command, args, {
        cwd: request.cwd,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      const finish = (result: AgentRunResult): void => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        resolvePromise(result);
      };

      const timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGKILL');
      }, request.timeoutMs);

      child.stdout?.on('data', (data: Buffer) => {
        const text = data.toString('utf8');
        output += text;
        onChunk(text);
      });
      child.stderr?.on('data', (data: Buffer) => {
        const text = data.toString('utf8');
        output += text;
        onChunk(text);
      });

      child.on('error', (error) => {
        finish({
          ok: false,
          exitCode: null,
          output,
          error: error.message,
        });
      });

      child.on('close', (code) => {
        finish({
          ok: !timedOut && code === 0,
          exitCode: code,
          output,
          timedOut,
          error:
            timedOut
              ? 'timeout'
              : code === 0
                ? undefined
                : `exit code ${code ?? 'unknown'}`,
        });
      });

      if (request.stdin !== undefined) {
        child.stdin?.write(request.stdin);
      }
      child.stdin?.end();
    });
  }
}

const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 回放执行器：不启动任何进程，按脚本产出确定性输出。
 *
 * 存在的意义有两个——CI 里没有 Agent 也要能跑通整条编排链路；
 * 演示时不必消耗真实 token。审查节点第一轮故意驳回，用来驱动回退分支。
 */
export class MockAgentRunner implements AgentRunner {
  private readonly reviewAttempts = new Map<string, number>();

  async run(
    request: AgentRunRequest,
    onChunk: (chunk: string) => void,
  ): Promise<AgentRunResult> {
    const key = `${request.runId}/${request.nodeId}`;
    // 提示词可能走 stdin，也可能作为位置参数传（不同 CLI 习惯不同），
    // 所以整条命令都要看，不能只查 stdin
    const haystack = `${request.stdin ?? ''} ${request.argv.join(' ')}`;
    const isReview = haystack.includes('VERDICT:');

    const lines = isReview
      ? [
          '读取变更范围…',
          '核对边界条件与验收条件…',
        ]
      : [
          `在 ${request.nodeId} 的独占范围内实施变更…`,
          '写入文件并自检…',
        ];

    for (const line of lines) {
      await delay(120);
      onChunk(`${line}\n`);
    }

    let output = lines.join('\n');

    if (isReview) {
      const attempt = (this.reviewAttempts.get(key) ?? 0) + 1;
      this.reviewAttempts.set(key, attempt);
      // 第一轮从严驳回，第二轮放行：回退链路能被完整演示出来
      const verdict = attempt === 1 ? 'CHANGES_REQUESTED' : 'APPROVED';
      await delay(120);
      onChunk(`VERDICT: ${verdict}\n`);
      output += `\nVERDICT: ${verdict}`;
    }

    return { ok: true, exitCode: 0, output };
  }
}

import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  AgentRunRequest,
  AgentRunResult,
  AgentRunner,
} from '@orchestrator/core';
import { PLANNER_PROMPT_MARKER } from '@orchestrator/planner';
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
 * 回放用的规划结果。
 *
 * 从 prompt 里的 agentId 白名单取真实可用的 Agent，保证产出的 DAG 能过校验——
 * 回放器如果给出一张不合法的图，演示就会卡在「规划失败」而不是展示编排本身。
 */
function buildMockPlan(prompt: string): string {
  const match = /白名单：([^\n]*)/.exec(prompt);
  const ids = (match?.[1] ?? '')
    .split(/[,，、\s]+/)
    .map((item) => item.trim())
    .filter(Boolean);

  const primary = ids[0];
  if (!primary) {
    return JSON.stringify({ title: '无可用 Agent', summary: '目录里没有可调度的 Agent', nodes: [] });
  }
  // 有第二个可用 Agent 就让审查换人，体现异构审查
  const reviewer = ids[1] ?? primary;

  const isDoc = /文案|文档|撰写|写作/.test(/^GOAL: (.+)$/m.exec(prompt)?.[1] ?? '');
  const nodes = isDoc
    ? [
        {
          id: 'impl-doc',
          type: 'implement',
          title: '撰写正文',
          description: '按目标写出可交付的初稿',
          dependsOn: [],
          files: ['docs/**'],
          agentId: primary,
          maxAttempts: 3,
        },
      ]
    : [
        {
          id: 'impl-core',
          type: 'implement',
          title: '实现核心流程',
          description: '按目标实现主路径并自测',
          dependsOn: [],
          files: ['src/core/**'],
          agentId: primary,
          maxAttempts: 3,
        },
        {
          id: 'review-core',
          type: 'review',
          title: '核心流程审查',
          description: '独立核对正确性、边界条件与验收标准',
          dependsOn: ['impl-core'],
          files: ['src/core/**'],
          agentId: reviewer,
          maxAttempts: 3,
        },
      ];

  return JSON.stringify(
    {
      title: isDoc ? '文档产出计划' : '核心功能计划',
      summary: '由规划 Agent 生成的任务图',
      specVersion: 'v1.0',
      nodes,
    },
    null,
    2,
  );
}

/**
 * 回放执行器：不启动任何进程，按脚本产出确定性输出。
 *
 * 存在的意义有两个——CI 里没有 Agent 也要能跑通整条编排链路；
 * 演示时不必消耗真实 token。审查节点第一轮故意驳回，用来驱动回退分支；
 * 规划请求则直接给出一张能过校验的 DAG。
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

    if (haystack.includes(PLANNER_PROMPT_MARKER)) {
      await delay(80);
      const json = buildMockPlan(haystack);
      const output = `\`\`\`json\n${json}\n\`\`\``;
      onChunk(output);
      return { ok: true, exitCode: 0, output };
    }

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

    // 实现节点真的落一份产物：这样 diff 采集、产物落盘、审查提示词里的
    // 「被审变更」在演示与 CI 里都有真实内容，而不是一条空链路。
    if (!isReview) {
      try {
        const dir = join(request.cwd, 'src');
        await mkdir(dir, { recursive: true });
        await writeFile(
          join(dir, `${request.nodeId}.md`),
          `# ${request.nodeId}\n\n由回放执行器生成，用于演示产物采集与审查上下文。\n`,
          'utf8',
        );
      } catch {
        // 工作区不可写时不影响回放本身
      }
    }

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

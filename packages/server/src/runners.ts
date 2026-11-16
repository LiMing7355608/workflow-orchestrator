import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  AgentCancelRequest,
  AgentRunRequest,
  AgentRunResult,
  AgentRunner,
} from '@orchestrator/core';
import {
  PLANNER_AMEND_MARKER,
  PLANNER_PROMPT_MARKER,
  PLAN_FILENAME,
  extractCurrentDagFromPrompt,
  type Dag,
} from '@orchestrator/planner';
import { resolveExecutable } from './probe.js';
import { isPidAlive, killProcessTree } from './process-tree.js';
import { silentLog, type LogSink } from './log.js';
import type { ProcessRegistry } from './registry.js';

/**
 * SIGTERM 之后给进程多少毫秒自己退出，超时才升级到 SIGKILL。
 *
 * 参考实现的护栏语义是「先请、再杀」：Agent 收到 SIGTERM 后往往还要落盘、
 * 提交、释放 worktree，直接 SIGKILL 会把半截产物留在原地。
 */
const TERM_GRACE_MS = 800;

/** SIGKILL 之后还愿意等多久来确认它真的死了（回执不是同步的）。 */
const KILL_GRACE_MS = 400;

/**
 * 一次正在执行的 Agent 子进程。
 *
 * `cancelled` 是取消意图，不是结论：它由 cancel 先立起来，能不能算「已终止」
 * 要等进程真的退出才知道。两件事分开是因为中间的窗口里进程可能还活着。
 */
interface ActiveAgent {
  nodeId: string;
  child: ChildProcess;
  cancelled: boolean;
}

/**
 * 存活探测。
 *
 * 与 ProcessRegistry 里的判定同源：只有 ESRCH 才判死，EPERM 之类的
 * 「问不出来」一律判活。终止路径上宁可多等一轮，也不能把一个还活着的
 * 进程记成已经停掉。
 */
/** 等进程退出；到点没退就返回 false（表示「还活着」，不是「不知道」）。 */
function waitForExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve(true);
  }
  return new Promise<boolean>((resolve) => {
    let timer: NodeJS.Timeout | undefined;
    const onExit = (): void => {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
      resolve(true);
    };
    timer = setTimeout(() => {
      child.off('exit', onExit);
      resolve(false);
    }, timeoutMs);
    child.once('exit', onExit);
  });
}

/**
 * 发信号。进程刚好在这瞬间退出属于正常竞态，不算故障。
 *
 * 注意：这里只用来做「温和请一次」以外的场景；真正的终止走
 * killProcessTree——单杀进程会留下 .cmd 包装下的 node 孤儿子进程。
 */
function signalChild(
  child: ChildProcess,
  signal: NodeJS.Signals,
  log: LogSink,
): void {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  try {
    child.kill(signal);
  } catch (error) {
    log.debug('向 Agent 进程发信号失败', { signal, error });
  }
}

/** 组合键：runId 与 nodeId 之间用 NUL 分开，避免 run-1 前缀误配 run-10。 */
function activeKey(runId: string, nodeId: string): string {
  return `${runId}\u0000${nodeId}`;
}

/**
 * 真实 Agent 执行器。
 *
 * 参数从不经过 shell：`resolveExecutable` 负责把 Windows 上的 .ps1 / .cmd
 * 包装成宿主命令，其余参数逐项传入，提示词走 stdin。这样提示词里的引号、
 * 管道符不会被重新解释。
 */
export class SpawnAgentRunner implements AgentRunner {
  /**
   * 正在跑的子进程，按 runId + nodeId 索引。
   *
   * 为什么不用 ProcessRegistry 那份磁盘记录来终止：那是「重启后认领孤儿」的
   * 账本，允许滞后、允许被别的实例覆盖；终止必须打在当前进程树里真实存在的
   * 那个 ChildProcess 句柄上。两者各管一件事，这里只攒内存句柄。
   * 同一个 key 允许多条：取消语义是「这个 run 的这个节点正在跑的全部停掉」。
   */
  private readonly active = new Map<string, ActiveAgent[]>();

  /**
   * registry 可选：登记是为了让 server 崩溃重启后能认出孤儿进程，
   * 但它不是执行的前提。不传就是「不登记」，行为与之前完全一致。
   * log 同样可选：注入的是最小的日志面，不让本模块认识 fastify。
   */
  constructor(
    private readonly registry?: ProcessRegistry,
    private readonly log: LogSink = silentLog,
  ) {}

  /**
   * 终止正在执行的 Agent。
   *
   * 时序（每一步都为「别在进程还活着的时候宣称已停止」服务）：
   *   1. 先立取消意图——进程可能自己先退出，那时再打标记就晚了；
   *   2. SIGTERM，等宽限期，让它把落盘和收尾做完；
   *   3. 宽限期到了还活着，才 SIGKILL；
   *   4. 只有确认进程已经不在，才把它计入返回值。
   *
   * 第 4 步是这条链上唯一说真话的地方：信号发出去了不等于死掉了。
   * 参考实现的措辞是「failed probes are NOT proof of death」——我们这里连
   * 「探测到活着」都不足以宣称停止，必须拿到进程退出的实据。
   */
  async cancel(request: AgentCancelRequest): Promise<number> {
    const targets: ActiveAgent[] = [];
    for (const [key, bucket] of this.active) {
      if (!key.startsWith(`${request.runId}\u0000`)) {
        continue;
      }
      for (const entry of bucket) {
        if (request.nodeId === undefined || entry.nodeId === request.nodeId) {
          targets.push(entry);
        }
      }
    }

    if (targets.length === 0) {
      // 没有任何在跑的 Agent：这是「停得早了点」，不是失败。
      return 0;
    }

    for (const entry of targets) {
      entry.cancelled = true;
    }

    // 并发停：一串 Agent 串行等宽限期，会让「停止」的响应时间随并发度线性增长
    const outcomes = await Promise.all(
      targets.map((entry) => this.stopOne(entry, request.runId)),
    );
    return outcomes.filter(Boolean).length;
  }

  /**
   * 停掉一个子进程，返回是否**确认**已终止。时序见 cancel。
   *
   * 必须杀整棵树：`.cmd` 包装让我们 spawn 的是 cmd.exe，真正的 Agent 是它的
   * node 子进程。只杀 cmd.exe 会留下一个还在写事件、还在烧 token 的孤儿，
   * 而这边却「确认退出」成功——界面显示已停止，实际没停。
   */
  private async stopOne(entry: ActiveAgent, runId: string): Promise<boolean> {
    const pid = entry.child.pid;

    // 先请：给它机会把落盘、提交、释放 worktree 做完
    await killProcessTree(pid, { force: false, log: this.log });
    if (await waitForExit(entry.child, TERM_GRACE_MS)) {
      return true;
    }

    // 宽限期用尽：它不肯自己走。这一路很常见——CLI 收到 SIGTERM 后还在跑
    // 收尾钩子——所以不是异常，不告警。
    await killProcessTree(pid, { force: true, log: this.log });
    if (await waitForExit(entry.child, KILL_GRACE_MS)) {
      return true;
    }

    // 强杀整棵树后仍未退出：不许算作已终止。
    // 宁可少报一个数，也不能让界面显示「已停止」而进程还在烧 token——
    // 参考实现把这条写成「failed probes are NOT proof of death」，
    // 在这里对称地成立：探测到「还活着」就更不是「已停止」的证明。
    if (isPidAlive(pid)) {
      this.log.warn('Agent 进程未能确认终止', {
        runId,
        nodeId: entry.nodeId,
        pid,
      });
    }
    return false;
  }

  async run(
    request: AgentRunRequest,
    onChunk: (chunk: string) => void,
  ): Promise<AgentRunResult> {
    const resolved = await resolveExecutable(request.bin);
    if (request.signal?.aborted) {
      return { ok: false, exitCode: null, output: '', cancelled: true };
    }
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

      const registry = this.registry;
      const pid = child.pid;

      // 登记为「正在跑」。必须在 spawn 之后立刻做：cancel 与 run 之间的
      // 窗口只要存在，用户点了停止就可能落到空表上，进程随后照跑不误。
      const entry: ActiveAgent = {
        nodeId: request.nodeId,
        child,
        cancelled: false,
      };
      const key = activeKey(request.runId, request.nodeId);
      const existing = this.active.get(key);
      if (existing) {
        existing.push(entry);
      } else {
        this.active.set(key, [entry]);
      }

      const forget = (): void => {
        const list = this.active.get(key);
        if (!list) {
          return;
        }
        const index = list.indexOf(entry);
        if (index >= 0) {
          list.splice(index, 1);
        }
        if (list.length === 0) {
          this.active.delete(key);
        }
      };

      // 登记要先落定再结算：进程可能在 register 写完之前就 close，
      // 抢跑会让 unregister 发生在 register 之前，磁盘上留下一条
      // 永远没人删的幽灵记录。登记失败只打日志——让「记不下 pid」
      // 把一次正常的 Agent 执行判成失败是本末倒置。
      const registered =
        pid !== undefined && registry
          ? registry
              .register({
                pid,
                runId: request.runId,
                nodeId: request.nodeId,
                agentId: request.agentId,
                bin: request.bin,
                startedAt: new Date().toISOString(),
              })
              .catch((error: unknown) => {
                this.log.warn('子进程登记失败', { pid, error });
              })
          : Promise.resolve();

      const finish = (result: AgentRunResult): void => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        forget();
        // 注销不阻塞结算：结果已经确定，删记录失败最多留一条孤儿记录，
        // 由下一次启动的 reap 收掉。
        if (pid !== undefined && registry) {
          void registered
            .then(() => registry.unregister(pid))
            .catch((error: unknown) => {
              this.log.warn('子进程注销失败', { pid, error });
            });
        }
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
        // 被取消的执行一律不算成功，哪怕 CLI 收到 SIGTERM 后自己以 0 退出：
        // 一次被中途掐断的运行没有产出可信结果，让它冒充成功会污染下游审查。
        const cancelled = entry.cancelled && !timedOut;
        finish({
          ok: !timedOut && !cancelled && code === 0,
          exitCode: code,
          output,
          timedOut,
          cancelled,
          error: timedOut
            ? 'timeout'
            : cancelled
              ? 'cancelled'
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
function buildMockPlan(prompt: string, includeDelivery: boolean): string {
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

  // 目标后面常带着前端拼进来的设置尾注，标题与摘要只取真正的目标那一段
  const goalText = (/^GOAL: (.+)$/m.exec(prompt)?.[1] ?? '').trim();
  const goalHead = goalText.split('补充要求')[0]?.trim() ?? '';
  const isDoc = /文案|文档|撰写|写作/.test(goalHead);
  const nodes: Dag['nodes'] = isDoc
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
          files: ['src/impl-core.md'],
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

  if (includeDelivery && !isDoc) {
    nodes.splice(1, 0, {
      id: 'impl-integration',
      type: 'implement',
      title: '接入核心流程',
      description: '读取核心节点的产物并生成集成说明',
      dependsOn: ['impl-core'],
      files: ['src/impl-integration.md'],
      agentId: primary,
      maxAttempts: 3,
    });
    nodes[2]!.dependsOn = ['impl-integration'];
  }
  if (includeDelivery) {
    const finalTask = nodes.at(-1)!;
    nodes.push(
      { id: 'approval', type: 'approval', title: '人工验收', description: '确认审查和交付结果',
        dependsOn: [finalTask.id], files: [], maxAttempts: 3 },
      { id: 'merge', type: 'route', title: '合并交付', description: '将节点产物汇入集成分支',
        dependsOn: ['approval'], files: [], action: 'merge', maxAttempts: 3 },
    );
  }

  return JSON.stringify(
    {
      // 用目标本身当标题与摘要：写死「核心功能计划」会让列表里每条都长得一样，
      // 完全看不出这轮在做什么
      title: goalHead.slice(0, 28) || (isDoc ? '文档产出计划' : '核心功能计划'),
      summary: goalHead || '由规划 Agent 生成的任务图',
      specVersion: 'v1.0',
      nodes,
    },
    null,
    2,
  );
}

/**
 * 回放用的「改图」结果。
 *
 * 改图链路只认工作区里的交付文件，所以这里必须产出**真实存在**的一份图：
 * 不能像规划那样把 JSON 打给 stdout 了事，那样演示会卡在「Agent 没有交付」
 * 上，看起来像编排器坏了。
 *
 * 做法是拿 prompt 里的当前图当基准，只改一个字段——回放器的职责是让链路
 * 走通，不是替用户决定怎么改图。优先改一个**未锁定**的审查节点，换成本机
 * 另一个可用 Agent，正好演示「审查那个节点换成 codex」这类指令的效果；
 * 如果所有审查节点都已在跑，仍然给出这次改动，让「后端拒绝已开始的节点」
 * 这条安全边界在演示里也走得到。
 */
function buildMockAmendment(prompt: string): string | undefined {
  const current = extractCurrentDagFromPrompt(prompt);
  if (!current) {
    return undefined;
  }

  const match = /白名单：([^\n]*)/.exec(prompt);
  const ids = (match?.[1] ?? '')
    .split(/[,，、\s]+/)
    .map((item) => item.trim())
    .filter(Boolean);

  // 已锁定节点从 prompt 的锁定段落里读回来，与真实 Agent 看到的是同一份信息
  const lockedSection = /## 已锁定的节点[^\n]*\n([\s\S]*?)(?:\n## |\n*$)/.exec(prompt)?.[1] ?? '';
  const locked = new Set(
    lockedSection
      .split('\n')
      .map((line) => /^-\s+(\S+)/.exec(line.trim())?.[1])
      .filter((id): id is string => Boolean(id)),
  );

  /** 换成本机另一个可用 Agent；没有第二个可用 Agent 时退回原值。 */
  const alternative = (currentAgent: string | undefined): string | undefined =>
    ids.find((id) => id !== currentAgent);

  const editable = current.nodes.filter((node) => !locked.has(node.id));
  const review =
    editable.find((node) => node.type === 'review') ??
    current.nodes.find((node) => node.type === 'review') ??
    editable.find((node) => node.type === 'implement');

  if (review) {
    const nextAgent = alternative(review.agentId) ?? review.agentId;
    if (nextAgent) {
      review.agentId = nextAgent;
    }
  }

  return JSON.stringify(current, null, 2);
}

/**
 * 回放执行器：不启动任何进程，按脚本产出确定性输出。
 *
 * 存在的意义有两个——CI 里没有 Agent 也要能跑通整条编排链路；
 * 演示时不必消耗真实 token。审查节点第一轮故意驳回，用来驱动回退分支；
 * 规划请求则直接给出一张能过校验的 DAG。
 */
/** 一次正在进行的回放。取消落在标记上，落不到进程上——回放本来就没有进程。 */
interface ReplaySlot {
  nodeId: string;
  cancelled: boolean;
}

/** 回放被打断时写进输出的一行，让看板能解释「为什么话说到一半就没了」。 */
const CANCELLED_NOTE = '（回放已取消）\n';

export class MockAgentRunner implements AgentRunner {
  constructor(private readonly includeDelivery = false) {}

  private readonly reviewAttempts = new Map<string, number>();

  /**
   * 正在回放的单元。
   *
   * 回放器没有进程可杀，取消只能是「per-node 的取消标记」：cancel 立标记，
   * 正在跑的那次 run 在每个产出点检查它并提前收尾。返回值与
   * SpawnAgentRunner 同一份契约——是真正被打断的数量，不是发出去的请求数。
   */
  private readonly replaying = new Map<string, ReplaySlot>();

  async cancel(request: AgentCancelRequest): Promise<number> {
    let stopped = 0;
    for (const [key, slot] of this.replaying) {
      if (!key.startsWith(`${request.runId}\u0000`)) {
        continue;
      }
      if (request.nodeId !== undefined && slot.nodeId !== request.nodeId) {
        continue;
      }
      // 这里只立意图：是不是真停下了，由那次 run 的返回值说话
      slot.cancelled = true;
      stopped += 1;
    }
    return stopped;
  }

  async run(
    request: AgentRunRequest,
    onChunk: (chunk: string) => void,
  ): Promise<AgentRunResult> {
    if (request.signal?.aborted) {
      return this.cancelledResult('');
    }
    const key = activeKey(request.runId, request.nodeId);
    const slot: ReplaySlot = { nodeId: request.nodeId, cancelled: false };
    this.replaying.set(key, slot);
    try {
      return await this.replay(request, onChunk, slot);
    } finally {
      // 只删自己那一条：同 key 的另一次回放可能已经把表项换掉了
      if (this.replaying.get(key) === slot) {
        this.replaying.delete(key);
      }
    }
  }

  /** 取消后的统一结局：非成功、带 cancelled，输出停在被打断的那一刻。 */
  private cancelledResult(output: string): AgentRunResult {
    return { ok: false, exitCode: null, output, cancelled: true, error: 'cancelled' };
  }

  /** 真正产出回放内容。取消在每个投入点之间生效，绝不假装已经跑完。 */
  private async replay(
    request: AgentRunRequest,
    onChunk: (chunk: string) => void,
    slot: ReplaySlot,
  ): Promise<AgentRunResult> {
    // 回退轮次仍按 run+node 记：取消不该把审查的驳回次数重置掉
    const key = `${request.runId}/${request.nodeId}`;
    // 提示词可能走 stdin，也可能作为位置参数传（不同 CLI 习惯不同），
    // 所以整条命令都要看，不能只查 stdin
    const haystack = `${request.stdin ?? ''} ${request.argv.join(' ')}`;

    // 改图必须先于规划判定：两条链路共用「写文件交付」的约定，
    // 但交付内容与判定标准完全不同，混在一个分支里迟早会互相污染。
    if (haystack.includes(PLANNER_AMEND_MARKER)) {
      await delay(80);
      if (slot.cancelled) {
        return this.cancelledResult('');
      }
      const json = buildMockAmendment(haystack);
      if (!json) {
        return {
          ok: false,
          exitCode: 1,
          output: '',
          error: '回放器没能在提示词里找到当前任务图',
        };
      }
      try {
        // 改图链路只读交付文件，不解析 stdout：回放器也必须真的落盘，
        // 否则演示会一直停在「Agent 没有交付修改后的图」
        await writeFile(join(request.cwd, PLAN_FILENAME), json, 'utf8');
      } catch (error) {
        return {
          ok: false,
          exitCode: 1,
          output: '',
          error: `交付文件写入失败：${(error as Error).message}`,
        };
      }
      const output = `已把修改后的任务图写入 ${PLAN_FILENAME}`;
      onChunk(output);
      return { ok: true, exitCode: 0, output };
    }

    if (haystack.includes(PLANNER_PROMPT_MARKER)) {
      await delay(80);
      if (slot.cancelled) {
        return this.cancelledResult('');
      }
      const json = buildMockPlan(haystack, this.includeDelivery);
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
        const dir = join(request.cwd, request.nodeId === 'impl-doc' ? 'docs' : 'src');
        await mkdir(dir, { recursive: true });
        const upstream = this.includeDelivery && request.nodeId === 'impl-integration'
          ? await readFile(join(dir, 'impl-core.md'), 'utf8')
          : '';
        await writeFile(
          join(dir, `${request.nodeId}.md`),
          `# ${request.nodeId}\n\n由回放执行器生成，用于演示产物采集与审查上下文。\n${upstream}`,
          'utf8',
        );
      } catch (error) {
        return { ok: false, exitCode: 1, output: '', error: (error as Error).message };
      }
    }

    let output = '';
    for (const line of lines) {
      if (slot.cancelled) {
        onChunk(CANCELLED_NOTE);
        return this.cancelledResult([output, CANCELLED_NOTE.trim()].filter(Boolean).join('\n'));
      }
      await delay(120);
      // 等完这一拍后再看一次：取消很可能就发生在等待期间
      if (slot.cancelled) {
        onChunk(CANCELLED_NOTE);
        return this.cancelledResult([output, CANCELLED_NOTE.trim()].filter(Boolean).join('\n'));
      }
      onChunk(`${line}\n`);
      output = output ? `${output}\n${line}` : line;
    }

    if (isReview) {
      // 裁决是审查唯一有意义的产物。还没说出口就被停掉，就绝不能补一个：
      // 一次被打断的审查凭空给出 APPROVED，会让上游白跑的回退消失。
      if (slot.cancelled) {
        onChunk(CANCELLED_NOTE);
        return this.cancelledResult([output, CANCELLED_NOTE.trim()].join('\n'));
      }
      const attempt = (this.reviewAttempts.get(key) ?? 0) + 1;
      this.reviewAttempts.set(key, attempt);
      // 第一轮从严驳回，第二轮放行：回退链路能被完整演示出来
      const verdict = attempt === 1 ? 'CHANGES_REQUESTED' : 'APPROVED';
      await delay(120);
      if (slot.cancelled) {
        onChunk(CANCELLED_NOTE);
        return this.cancelledResult([output, CANCELLED_NOTE.trim()].join('\n'));
      }
      onChunk(`VERDICT: ${verdict}\n`);
      output += `\nVERDICT: ${verdict}`;
    }

    return { ok: true, exitCode: 0, output };
  }
}

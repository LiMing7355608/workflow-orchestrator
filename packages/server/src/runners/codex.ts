/**
 * CodexAppServerRunner：走官方 app-server 协议（JSON-RPC over stdio）驱动 Codex。
 *
 * 为什么不再拼 `codex exec --json`：那条路把「会话生命周期」压在命令行参数里。
 * 一次执行要先建会话、再提交一个 turn、再等它终态，而这三步在 exec 里被折叠成
 * 「一次性投喂 + 猜 stdout 什么时候算说完了」。猜错的两种后果都很贵：早了就把
 * 半截正文当交付，晚了就挂到超时。app-server 把这三步显式化成 RPC，turn 的终态
 * 由服务端通知给出，不再需要人从输出形状里推断。
 *
 * 刻意不动 core 的契约：`AgentRunner.run` 的 `onChunk` 仍然是字符串通道。本执行器
 * 把每条协议消息**还原成 `codex exec --json` 的一行**再交出去，上层继续用 profile
 * 里声明的 `codex-json` 解析器。理由见 `CodexAppServerWire.emitLine`。
 *
 * 来源声明：本文件的协议适配层移植并改写自 deepseek-harness 仓库的
 * `packages/subagent/subagent-codex/src/wire.ts`（`CodexAppServerWire`，711 行）
 * 与 `.../src/run.ts`（进程生命周期）。原实现为 MIT 许可，允许复制与改写。
 * 移植时的差异只有四处，均为契约差异而非逻辑改写：
 *   1. 去掉 `import type { ContentBlock } from '@deepseek-ai/dsh-llm'`——我们的
 *      交付是**一条字符串**，没有多段内容块的语义；
 *   2. 去掉 `import type { SubagentResult } from '@deepseek-ai/dsh-subagent'`——
 *      换成我们的 `AgentRunResult`（见 `CodexAppServerRunner.run`）；
 *   3. 原实现的失败事实（stage/category/httpStatus）是给上层品牌化诊断用的三元组，
 *      我们不需要品牌，只需要一句人能读的话，因此收敛成 `CodexWireError.stage` +
 *      可读文案（见 `describeFailure`）；
 *   4. 进程由本文件自己 spawn（原实现走它的 SubprocessHandle 接缝），终止统一走
 *      `killProcessTree`——**必须杀整棵树**，理由见 `process-tree.ts` 的文件头。
 */

import { spawn, type ChildProcess } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';
import { JsonRpcLineTransport, JsonRpcResponseError } from '@deepseek-ai/dsh-sdk-protocol';
import { createParser } from '@orchestrator/core';
import type {
  AgentCancelRequest,
  AgentEvent,
  AgentRunRequest,
  AgentRunResult,
  AgentRunner,
  PermissionPolicy,
} from '@orchestrator/core';
import { silentLog, type LogSink } from '../log.js';
import { killProcessTree } from '../process-tree.js';
import { resolveExecutable } from '../probe.js';
import { activeKey, belongsToRun } from '../runner-key.js';

type JsonObject = Record<string, unknown>;

/**
 * 进入 app-server 模式的固定参数。
 *
 * `app-server` 是子命令，`--stdio` 声明走标准输入输出而不是它自己的监听端口。
 * 与参考实现（codex 0.153.4 / 0.162+ 实测）完全一致；除了这两项之外**不加任何
 * 参数**——app-server 的参数面很窄，多猜一个开关就会让进程在握手之前退出。
 */
const APP_SERVER_ARGS: readonly string[] = ['app-server', '--stdio'];

/**
 * 先请进程退场的宽限期。
 *
 * 与 `runners.ts` 的 TERM_GRACE_MS 同一个数、同一个理由：收到终止请求后 Codex
 * 往往还要把这次 turn 的日志刷完，直接 SIGKILL 会留下半截状态。
 */
const TERM_GRACE_MS = 800;

/** 强杀之后还愿意等多久来确认它真的死了（taskkill 的回执不是同步的）。 */
const KILL_GRACE_MS = 400;

/**
 * 取消时等这一次 run 结算的总预算。
 *
 * 取值要盖过 run 收尾的最坏路径（TERM_GRACE_MS + KILL_GRACE_MS + 协议收尾），
 * 否则「进程已经停了但 finally 还在跑」会被误报成「未确认终止」。与
 * `claude-sdk.ts` 的 ABORT_CONFIRM_MS 取同一个数：两条路的确认语义必须一致。
 */
const CANCEL_CONFIRM_MS = 3_000;

/** 无人值守时的审批应答理由。写清楚原因，落在诊断里，不让它变成沉默。 */
const UNATTENDED_DENY_REASON =
  '这个编排运行是无人值守的：没有人能回答 Codex 的审批询问，因此不授予任何交互式权限。';

/**
 * 与厂商无关的权限档位 → `thread/start` 的原生权限字段。
 *
 * codex 的权限是**两个正交维度**的组合：approvalPolicy（要不要问人）与
 * sandbox（能碰什么）。我们的四档正好能落在这张表上，且每一格都能说清依据：
 *   - default（审查节点）：只问「沙箱默认值」。参考实现实测过的组合里，
 *     裸 `approvalPolicy: 'never'` 就是只读——审查只读文件，不该能改；
 *   - accept-edits：能改文件但不问人，等价于 codex 的 `--full-auto`
 *     （`approvalPolicy: never` + `sandbox: workspace-write`）；
 *   - auto：把审批交给 codex 自己的自动审核器（`approvalsReviewer`），
 *     这是参考实现实测过的『approve-for-me』，也是我们语义上最接近「自动批准」
 *     的一档——它的询问由服务端自答，不会打回给我们；
 *   - bypass-permissions：不问人 + 不限沙箱，与参考实现同名同义。
 */
const POLICY_THREAD_PARAMS: Record<PermissionPolicy, JsonObject> = {
  default: { approvalPolicy: 'never' },
  'accept-edits': { approvalPolicy: 'never', sandbox: 'workspace-write' },
  auto: {
    approvalPolicy: 'on-request',
    approvalsReviewer: 'auto_review',
    sandbox: 'workspace-write',
  },
  'bypass-permissions': { approvalPolicy: 'never', sandbox: 'danger-full-access' },
};

/** 拿不到档位时的兜底：只读、不问人。安全方向永远是「少给权限」。 */
const FALLBACK_THREAD_PARAMS: JsonObject = { approvalPolicy: 'never' };

/* ------------------------------------------------------------------ *
 * 小工具：外部数据一律 unknown，宁可返回 undefined 也不猜
 * ------------------------------------------------------------------ */

function asObject(value: unknown): JsonObject | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as JsonObject)
    : undefined;
}

/** 协议约定的必填字段缺失 = 协议不兼容，必须显式失败，不能当空值糊过去。 */
function requireObject(value: unknown, label: string): JsonObject {
  const record = asObject(value);
  if (!record) {
    throw new Error(`codex app-server 返回的 ${label} 不是对象`);
  }
  return record;
}

function requireId(value: unknown, label: string): string {
  if (typeof value !== 'string' || value === '') {
    throw new Error(`codex app-server 返回的 ${label} 不是非空字符串`);
  }
  return value;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 手写 deferred：目标 Node 20 没有 `Promise.withResolvers`。 */
function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

/** abort 一个控制器。已经 abort 过不算故障。 */
function abortQuietly(controller: AbortController, reason: string): void {
  if (controller.signal.aborted) {
    return;
  }
  try {
    controller.abort(new Error(reason));
  } catch {
    // 极老版本 Node 对 abort 抛错；这里无论如何都已经尽力了
  }
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error('这次 codex 执行被中断');
}

/** 让一个已有的 promise 也能被 signal 打断（completion 等待用）。 */
async function raceSignal<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    // 别把没人接的 rejection 丢给 unhandledRejection
    void pending.catch(() => {});
    throw abortReason(signal);
  }
  let rejectAbort!: (error: Error) => void;
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectAbort = reject;
  });
  const onAbort = (): void => {
    rejectAbort(abortReason(signal));
  };
  signal.addEventListener('abort', onAbort, { once: true });
  try {
    return await Promise.race([pending, aborted]);
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}

/**
 * 从 argv 里取一个带值参数。
 *
 * 与 `claude-sdk.ts` 里的同名函数逻辑一致、故意各写一份：那个文件正在被接线，
 * 让两个执行器互相 import 会把「改一处 claude」变成「顺带动 codex」。这里的用途
 * 也只有一个——记下**调用方要求了什么**（模型名），读不出来就退回 codex 自己的
 * 配置，绝不替运维现场做选择。
 */
function argValue(argv: string[], flag: string): string | undefined {
  const index = argv.indexOf(flag);
  const value = index >= 0 ? argv[index + 1] : undefined;
  return value !== undefined && !value.startsWith('-') ? value : undefined;
}

/**
 * `codex exec` 里「带值的开关」。
 *
 * 为什么需要这张表：profile 的 argv 形状是
 * `exec --json --skip-git-repo-check {prompt} --sandbox read-only`——提示词在中间，
 * 后面还跟着权限参数。所以「取最后一个非 `-` 开头的参数」会拿到 `read-only`。
 * 想认出提示词，就必须知道哪些 token 是别人的值。
 */
const VALUE_FLAGS = new Set([
  '--sandbox',
  '-s',
  '--model',
  '-m',
  '-c',
  '--config',
  '--cd',
  '-C',
  '--output-schema',
  '--color',
  '-i',
  '--image',
  '--add-dir',
  '--profile',
  '-p',
  '--enable',
  '--disable',
]);

/** 这些是 codex 的子命令，出现在 argv 里但不是提示词。 */
const SUBCOMMANDS = new Set([
  'exec',
  'resume',
  'app-server',
  'login',
  'logout',
  'mcp',
  'completion',
  'apply',
]);

/**
 * 从运行请求里取提示词。
 *
 * argv 里的参数是给「拼命令行」那条路准备的（`codex exec --json <prompt>`），
 * app-server 只吃一个纯文本任务，所以这里必须把它单独捞出来：
 *   1. 走 stdin 的平台直接用它（最可靠：没有引号与空格的解释问题）。
 *      这是**首选**，接线时把 profile 的 `stdin` 打开就永远不必猜；
 *   2. 有 `--` 分隔符时，后面全部是位置参数；
 *   3. 否则逐个扫：跳过 flag、跳过 flag 的值、跳过子命令，剩下的第一个就是提示词。
 *
 * 三段都是启发式，但兜底是「全都不像提示词就把整条命令交出去」——宁可让 codex
 * 收到一条脏提示词并明确报错，也不能静默把一次执行变成空任务。
 */
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

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === undefined) {
      continue;
    }
    if (arg.startsWith('-')) {
      if (VALUE_FLAGS.has(arg)) {
        // 连它的值一起跳：`--sandbox read-only` 里的 `read-only` 不是提示词
        index += 1;
      }
      continue;
    }
    if (SUBCOMMANDS.has(arg)) {
      continue;
    }
    return arg;
  }

  return argv.join(' ').trim();
}

/* ------------------------------------------------------------------ *
 * 失败诊断：四种故障说四种话
 * ------------------------------------------------------------------ */

/** 失败发生的阶段。分开命名是为了让「起不来 / 握手 / 建线程 / 跑 turn」一眼可辨。 */
export type CodexStage =
  | 'executable'
  | 'spawn'
  | 'initialize'
  | 'thread-start'
  | 'turn-start'
  | 'turn';

/** 协议层失败。带上阶段，上层据此决定说哪句话。 */
export class CodexWireError extends Error {
  constructor(
    readonly stage: CodexStage,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'CodexWireError';
  }
}

interface ProcessOutcome {
  code: number | null;
  signal: NodeJS.Signals | null;
}

function outcomeText(outcome: ProcessOutcome | undefined): string {
  if (outcome === undefined) {
    return '';
  }
  const parts: string[] = [];
  if (outcome.code !== null) {
    parts.push(`exit=${outcome.code}`);
  }
  if (outcome.signal !== null) {
    parts.push(`signal=${outcome.signal}`);
  }
  return parts.length > 0 ? `；codex 进程已退出（${parts.join(', ')}）` : '';
}

/**
 * 把阶段、原因、进程结局拼成一句可读的失败说明。
 *
 * 为什么要分阶段：同一条 "JSON-RPC input closed" 在握手阶段意味着「版本不对或
 * 子命令不存在」，在 turn 阶段却意味着「Agent 跑到一半崩了」。笼统报一句
 * "codex 失败" 等于把两种完全不同的处置办法（换版本 / 重跑）混成一条。
 */
function describeFailure(input: {
  stage: CodexStage;
  detail: string;
  outcome?: ProcessOutcome;
}): string {
  const tail = outcomeText(input.outcome);
  switch (input.stage) {
    case 'executable':
      return `找不到 codex 可执行文件：${input.detail}（PATH 里没有，或者它不是可执行文件）`;
    case 'spawn':
      return `codex app-server 进程起不来：${input.detail}${tail}`;
    case 'initialize':
      return `codex app-server 协议握手失败，可能是 codex 版本过老、不支持 app-server 的 JSON-RPC 接口：${input.detail}${tail}`;
    case 'thread-start':
      return `codex 拒绝了 thread/start（会话参数不被这个版本接受）：${input.detail}${tail}`;
    case 'turn-start':
      return `codex 无法开始这一轮任务（turn/start）：${input.detail}${tail}`;
    case 'turn':
      return `codex turn 失败：${input.detail}${tail}`;
    default:
      return `codex 执行失败：${input.detail}${tail}`;
  }
}

/* ------------------------------------------------------------------ *
 * 协议适配层
 * ------------------------------------------------------------------ */

/** 一个 turn 的终态。由服务端的 `turn/completed` 通知给出，不由我们推测。 */
export interface CodexTurnOutcome {
  readonly status: 'completed' | 'interrupted' | 'failed';
  /** 交付正文；`completed` 时非空 */
  readonly output: string;
  /** 失败时的可读原因（已含 codexErrorInfo 与 HTTP 状态） */
  readonly failure?: string;
}

/**
 * `codex app-server` 的一次连接与它上面唯一的会话/turn。
 *
 * 刻意不提供通用的 request 接口：能发哪些方法属于**产品契约**，多开一个口子
 * 就等于允许任意调用方向私有协议里塞东西。
 */
export class CodexAppServerWire {
  private readonly transport: JsonRpcLineTransport;
  /** 协议异常（非法通知、监听器抛错）的汇聚点：让正在 await 的一方立刻醒。 */
  private readonly fatal = deferred<never>();
  private threadId: string | undefined;
  private turnId: string | undefined;
  private pendingTurnId: string | undefined;
  private completion:
    | { promise: Promise<JsonObject>; resolve: (params: JsonObject) => void }
    | undefined;
  /**
   * `turn/start` 的响应还没到、终态通知却先到了的缓冲。
   *
   * 这不是防御性编程，而是实测存在的顺序：服务端可以在一次 flush 里先发
   * `turn/completed` 再回响应。丢掉这些通知会让这个 turn 永远等不到终态。
   */
  private readonly earlyNotifications: Array<{ method: string; params: JsonObject }> = [];
  private lastFinalAnswer: string | undefined;
  private lastPartialAnswer: string | undefined;
  private lastUnphasedAnswer: string | undefined;
  private diagnostic: string | undefined;
  private pendingDiagnostic: string | undefined;
  private closed = false;

  constructor(
    private readonly options: {
      input: Readable;
      output: Writable;
      /** thread/start 的权限字段，见 POLICY_THREAD_PARAMS */
      threadParams: JsonObject;
      model?: string;
      /** 每合成一行 `codex exec --json` 形状的输出就回调一次（同步） */
      onLine: (line: string) => void;
      log?: LogSink;
    },
  ) {
    this.transport = new JsonRpcLineTransport(options.input, options.output);
    // 协议异常可能在当前 await 之外才到；先把它标为已观察，避免 unhandledRejection
    void this.fatal.promise.catch(() => {});

    this.transport.onRequest((method, params) => this.handleServerRequest(method, params));
    this.transport.onNotification((method, params) => {
      try {
        this.handleNotification(method, params);
      } catch (error) {
        this.fatal.reject(error);
      }
    });
    const log = options.log ?? silentLog;
    // 管道会在对端消失后抛 EPIPE。这些监听器要活到流销毁为止，
    // 否则一条迟到的写入错误会变成 EventEmitter 的 uncaught 异常。
    options.input.on('error', (error: Error) => {
      this.fatal.reject(error);
      log.debug('codex app-server 输入流出错', { error: error.message });
    });
    options.output.on('error', (error: Error) => {
      this.fatal.reject(error);
      log.debug('codex app-server 输出流出错', { error: error.message });
    });
  }

  private get log(): LogSink {
    return this.options.log ?? silentLog;
  }

  /** 开始读帧。 */
  start(): void {
    this.transport.start();
  }

  /**
   * 握手：`initialize` → `initialized` 通知。
   *
   * app-server 要求先声明客户端身份与能力，之后才接受产品方法；跳过这一步的
   * 结果不是「降级」，而是每条请求都拿到错误帧。`experimentalApi: false` 是刻意的：
   * 我们只用稳定面，不为了一个 ephemeral 会话去要求实验开关。
   */
  async initialize(signal: AbortSignal): Promise<void> {
    requireObject(
      await this.request(
        'initialize',
        {
          clientInfo: { name: 'workflow-orchestrator', title: 'Workflow Orchestrator', version: '0.1.0' },
          capabilities: { experimentalApi: false, requestAttestation: false },
        },
        signal,
        'initialize',
      ),
      'initialize 响应',
    );
    this.transport.notify('initialized');
    // 等这一帧真的写出去再往下走：立刻发 thread/start 会与它竞争同一个写队列，
    // 而某些版本对「未 initialized 就建线程」是直接拒绝的。
    await raceSignal(this.transport.flush(), signal);
  }

  /**
   * 建本节点专用的临时会话，并**立刻**把会话 id 交给事件流。
   *
   * 会话身份来自 RPC 响应而不是通知，所以这里自己合成一行 `thread.started`，
   * 让上层的 `agent.session` 事实与会话真正建立的那一刻对齐——晚一拍落库，
   * 界面上就会出现「Agent 已经在说话，但还不知道它在哪个会话里」。
   */
  async startThread(cwd: string, signal: AbortSignal): Promise<void> {
    const response = requireObject(
      await this.request(
        'thread/start',
        {
          cwd,
          // 节点工作区是一次性的，会话记录没有留存价值
          ephemeral: true,
          ...(this.options.model === undefined ? {} : { model: this.options.model }),
          ...this.options.threadParams,
        },
        signal,
        'thread-start',
      ),
      'thread/start 响应',
    );
    const thread = requireObject(response.thread, 'thread/start thread');
    this.threadId = requireId(thread.id, 'thread/start thread id');
    if (thread.ephemeral === false) {
      // 老版本可能不返回这个字段，所以只认显式的 false。
      // 会话落盘不是执行失败（工作区本身会被丢弃），但要留痕，方便解释磁盘上的残留。
      this.log.warn('codex 没有建立临时会话，会话记录会落盘', { threadId: this.threadId });
    }
    this.emitLine({ type: 'thread.started', thread_id: this.threadId });
  }

  /**
   * 提交这一轮任务并等它的终态。
   *
   * 返回而不是抛：turn 失败是**执行结果**（要落成 node.failed 的原因），
   * 而协议失败（非法帧、传输断开）是另一回事，继续抛。
   */
  async runTurn(prompt: string, signal: AbortSignal): Promise<CodexTurnOutcome> {
    const completion = deferred<JsonObject>();
    this.completion = completion;
    const threadId = this.threadId as string;

    try {
      const response = requireObject(
        await this.request(
          'turn/start',
          {
            threadId,
            input: [{ type: 'text', text: prompt, text_elements: [] }],
          },
          signal,
          'turn-start',
        ),
        'turn/start 响应',
      );
      const turn = requireObject(response.turn, 'turn/start turn');
      this.commitTurnId(requireId(turn.id, 'turn/start turn id'));
    } catch (error) {
      this.completion = undefined;
      throw error;
    }

    let params: JsonObject;
    try {
      params = await this.guarded(completion.promise, signal);
    } finally {
      this.completion = undefined;
    }
    const terminal = requireObject(params.turn, 'turn/completed turn');
    const status = terminal.status;
    if (status === 'completed') {
      const output = this.collectOutput() ?? '';
      this.commitTurnLine(terminal, undefined, output);
      return output.trim() === ''
        ? {
            status: 'completed',
            output,
            failure: 'codex 报告这一轮已完成，但没有交付任何正文（协议异常）',
          }
        : { status: 'completed', output };
    }
    if (status === 'interrupted') {
      // 我们没有发过取消却收到 interrupted：这是 codex 自己停的，不是人的决定。
      // 两者都 ok:false，但只有后者能记成 node.interrupted（见 core 的注释）。
      return { status: 'interrupted', output: this.collectOutput() ?? '' };
    }
    const failure = turnFailureText(terminal);
    this.commitTurnLine(terminal, failure, this.collectOutput() ?? '');
    return { status: 'failed', output: this.collectOutput() ?? '', failure };
  }

  /** 交付正文：最终答复 > 部分答复 > 无 phase 的答复。都取不到就是没交付。 */
  collectOutput(): string | undefined {
    const selected = this.lastFinalAnswer ?? this.lastPartialAnswer ?? this.lastUnphasedAnswer;
    return selected !== undefined && selected.trim() !== '' ? selected : undefined;
  }

  /** 无人值守这一路做过哪些拒绝，用来解释「为什么它什么都没干」。 */
  collectDiagnostic(): string | undefined {
    return this.diagnostic;
  }

  /** 尽力而为的服务端中断。本地终止（关传输 + 杀树）才是权威。 */
  interrupt(): void {
    if (this.threadId === undefined || this.turnId === undefined || this.closed) {
      return;
    }
    void this.transport
      .request('turn/interrupt', { threadId: this.threadId, turnId: this.turnId })
      .catch(() => {
        // 对端已经不在时这里必然失败，本地终止不受影响
      });
  }

  /** 断开监听并让挂起的请求全部 reject。幂等。 */
  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.transport.close();
  }

  /* ---------------- 内部：请求与守卫 ---------------- */

  /**
   * 发一个产品方法，合并「协议致命错误」与「被 signal 打断」两条提前退出的路。
   *
   * 传输层自己会在输入流关闭/出错时 fail 掉挂起的请求（见 transport 的
   * onInputEnd/failPending），所以这里只需要额外盯住**协议异常**这一条——
   * 它发生在通知处理里，不经过任何 pending 请求。
   */
  private async request(
    method: string,
    params: JsonObject,
    signal: AbortSignal,
    stage: CodexStage,
  ): Promise<unknown> {
    try {
      return await this.guarded(this.transport.request(method, params, signal), signal);
    } catch (error) {
      if (error instanceof CodexWireError) {
        throw error;
      }
      if (error instanceof JsonRpcResponseError) {
        const code = error.code === undefined ? '' : `（JSON-RPC ${error.code}）`;
        throw new CodexWireError(stage, `${error.message}${code}`, { cause: error });
      }
      throw new CodexWireError(stage, errorText(error), { cause: error });
    }
  }

  private async guarded<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
    return raceSignal(Promise.race([this.fatal.promise, pending]), signal);
  }

  private emitLine(payload: JsonObject): void {
    let line: string;
    try {
      line = `${JSON.stringify(payload)}\n`;
    } catch (error) {
      // 协议对象不可能有循环引用；真出现了也只是少一帧观测，不该让执行失败
      this.log.debug('codex 协议消息无法序列化', { error: errorText(error) });
      return;
    }
    this.options.onLine(line);
  }

  /* ---------------- 内部：turn 身份的两段提交 ---------------- */

  /**
   * turn 身份要两段提交：先记「待确认」，等 `turn/start` 响应到齐才转正。
   *
   * 因为通知可能早于响应（见 earlyNotifications）。在校验上这两个阶段必须分开：
   * 待确认阶段只允许「唯一且一致」的候选 id，转正时还要与响应里的 id 对齐——
   * 否则一条串了会话的通知就能把我们的终态等待指到别的 turn 上去。
   */
  private observePendingTurnId(id: string): void {
    if (this.completion === undefined) {
      throw new Error('codex app-server 在 turn/start 之前就引用了某个 turn');
    }
    if (this.pendingTurnId !== undefined && this.pendingTurnId !== id) {
      throw new Error('codex app-server 同时引用了两个不同的 turn');
    }
    this.pendingTurnId = id;
  }

  private commitTurnId(id: string): void {
    if (this.pendingTurnId !== undefined && this.pendingTurnId !== id) {
      throw new Error('turn/start 响应里的 turn 与通知里的 turn 不一致');
    }
    this.turnId = id;
    const diagnostic = this.pendingDiagnostic;
    this.pendingDiagnostic = undefined;
    if (diagnostic !== undefined) {
      this.diagnostic = diagnostic;
    }
    const buffered = this.earlyNotifications.splice(0);
    for (const notification of buffered) {
      this.handleNotification(notification.method, notification.params);
    }
  }

  /**
   * 校验这条通知/请求说的是**我们这条会话的这个 turn**。
   *
   * 返回 `true` 表示 turn 身份还在待确认阶段，调用方应当把与之相关的诊断延后——
   * 那时 lease 还没转正，写下的话会在 id 被否掉之后变成一句错话。
   */
  private inspectIds(params: JsonObject, nullableTurn = false): boolean {
    if (params.threadId !== this.threadId) {
      throw new Error('codex app-server 引用了不属于本次执行的会话');
    }
    if (nullableTurn && (params.turnId === null || params.turnId === undefined)) {
      return false;
    }
    const id = requireId(params.turnId, '通知/请求里的 turn id');
    if (this.turnId === undefined) {
      this.observePendingTurnId(id);
      return true;
    }
    if (id !== this.turnId) {
      throw new Error('codex app-server 引用了不属于本次执行的 turn');
    }
    return false;
  }

  /* ---------------- 内部：权限应答 ---------------- */

  /**
   * 服务端发来的权限请求。
   *
   * 一律拒绝，理由是**没有人能批准**：编排器是无人值守的，把审批挂在这里等着，
   * 结果只能是整个节点卡到超时。拒绝会让 codex 换一条不需要审批的路，或者把
   * 「需要人工」写进答复里——两者都比静默挂起可交付。
   *
   * 这里没有自由文本的理由字段（与 claude 的 canUseTool 不同）：codex 的应答是
   * 结构化枚举，拒绝的原因只能落在**诊断**里，供人排查「为什么它什么都没干」。
   */
  private handleServerRequest(method: string, params: JsonObject): Promise<unknown> {
    try {
      switch (method) {
        case 'item/commandExecution/requestApproval':
        case 'item/fileChange/requestApproval': {
          // 两个方法的应答形状相同，只是诊断里要分清「问的是命令还是改文件」
          const decision = unattendedDecision(params);
          const request =
            method === 'item/commandExecution/requestApproval' ? 'command approval' : 'file approval';
          this.recordRequestDecision(params, request, decision === 'cancel' ? 'cancelled' : 'declined');
          return Promise.resolve({ decision });
        }
        case 'item/permissions/requestApproval':
          this.recordRequestDecision(params, 'permission grant', 'denied');
          // 空授权对象 = 一条新权限都不给；scope 取 turn，绝不外溢到别的执行
          return Promise.resolve({ permissions: {}, scope: 'turn' });
        case 'item/tool/requestUserInput':
          this.recordRequestDecision(params, 'user input', 'empty response');
          return Promise.resolve({ answers: {} });
        case 'mcpServer/elicitation/request':
          this.recordRequestDecision(params, 'MCP elicitation', 'declined', true);
          return Promise.resolve({ action: 'decline', content: null, _meta: null });
        default:
          // 认不出的服务端请求意味着协议面不同步。回一个错误帧让它知道，
          // 同时把整次执行判成协议失败——装作没看见会让 turn 卡在一个
          // 我们永远等不到的响应上。
          throw new Error(`codex app-server 发来了这个执行器不认识的请求：${method}`);
      }
    } catch (error) {
      this.fatal.reject(error);
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
  }

  private recordRequestDecision(
    params: JsonObject,
    request: string,
    decision: string,
    nullableTurn = false,
  ): void {
    const provisional = this.inspectIds(params, nullableTurn);
    const text = `Codex 无人值守应答（请求：${request}；应答：${decision}）：${UNATTENDED_DENY_REASON}`;
    if (provisional) {
      this.pendingDiagnostic = text;
      return;
    }
    this.diagnostic = text;
  }

  /* ---------------- 内部：通知分派 ---------------- */

  private handleNotification(method: string, params: JsonObject): void {
    if (method === 'turn/started') {
      if (params.threadId !== this.threadId) {
        return;
      }
      const turn = requireObject(params.turn, 'turn/started turn');
      if (this.completion !== undefined && this.turnId === undefined) {
        this.observePendingTurnId(requireId(turn.id, 'turn/started turn id'));
      }
      return;
    }

    if (method === 'item/started' || method === 'item/completed') {
      if (params.threadId !== this.threadId) {
        return;
      }
      const turnId = requireId(params.turnId, 'item 通知里的 turn id');
      if (this.turnId === undefined) {
        // turn 还没转正：先缓冲，等 commitTurnId 重放。乱序丢弃会让我们
        // 永久丢掉这一轮的全部内容。
        if (this.completion !== undefined) {
          this.observePendingTurnId(turnId);
          this.earlyNotifications.push({ method, params });
        }
        return;
      }
      if (turnId !== this.turnId) {
        return;
      }
      this.handleItem(method === 'item/started' ? 'started' : 'completed', params);
      return;
    }

    if (method === 'turn/completed') {
      if (params.threadId !== this.threadId) {
        return;
      }
      const turn = requireObject(params.turn, 'turn/completed turn');
      const turnId = requireId(turn.id, 'turn/completed turn id');
      const completion = this.completion;
      if (completion === undefined) {
        // 我们已经不再等这一轮了（被取消、或已结算）。旧终态不能改写结论。
        return;
      }
      if (this.turnId === undefined) {
        this.observePendingTurnId(turnId);
        this.earlyNotifications.push({ method, params });
        return;
      }
      if (turnId !== this.turnId) {
        return;
      }
      const status = turn.status;
      if (status !== 'completed' && status !== 'interrupted' && status !== 'failed') {
        throw new Error(`codex app-server 给出了非法的 turn 终态：${String(status)}`);
      }
      completion.resolve(params);
    }
  }

  /** 一条 item 通知：先收正文，再还原成 `codex exec --json` 的 item 行。 */
  private handleItem(event: 'started' | 'completed', params: JsonObject): void {
    const item = asObject(params.item);
    if (!item) {
      return;
    }
    if (event === 'completed') {
      this.recordAnswer(item);
    } else if (!STARTED_ITEM_TYPES.has(String(item.type))) {
      // `item.started` 只对**工具类**有意义（上层的解析器也只认这一类）：
      // agentMessage 在 started 时正文还是空的，发出去要么被解析器退化成
      // 「整行原文」铺进时间线，要么多一条空事件。等 completed 那一次就够。
      return;
    }
    const wireItem = toWireItem(item);
    if (wireItem === undefined) {
      // 认不出的 item 类型不进事件流。丢一帧元信息好过把一坨 JSON 当正文铺进时间线。
      this.log.debug('跳过不映射的 codex item', { type: item.type, event });
      return;
    }
    this.emitLine({ type: event === 'started' ? 'item.started' : 'item.completed', item: wireItem });
  }

  /**
   * 收集候选正文，按「离交付有多近」分三档。
   *
   * codex 会用 phase 声明这段文本的地位：`final_answer` 是交付，`partial_answer`
   * 是可能还有后文的稳定段落，`commentary` 只是过程播报。把它们混成一坨，
   * 会让「最后说了什么」变成「最后一条消息是什么」——这两件事不一样。
   */
  private recordAnswer(item: JsonObject): void {
    if (item.type !== 'agentMessage') {
      return;
    }
    const text = typeof item.text === 'string' ? item.text : undefined;
    if (text === undefined) {
      return;
    }
    const phase = item.phase;
    if (phase === 'final_answer') {
      this.lastFinalAnswer = text;
    } else if (phase === 'partial_answer') {
      this.lastPartialAnswer = text;
    } else if (phase === null || phase === undefined) {
      this.lastUnphasedAnswer = text;
    }
    // commentary 与未知 phase：是过程，不是交付，不参与 collectOutput
  }

  /**
   * 合成终态那一行。
   *
   * 只在**本地确实拿到了终态**时发，所以调用点在 runTurn 里而不是通知处理器里：
   * 通知处理器可能被取消路径抢跑，而取消不该在时间线上留下一句「已完成」。
   */
  private commitTurnLine(
    terminal: JsonObject,
    failure: string | undefined,
    output: string,
  ): void {
    if (failure === undefined) {
      const payload: JsonObject = { type: 'turn.completed' };
      if (output.trim() !== '') {
        payload.last_agent_message = output;
      }
      const usage = asObject(terminal.usage);
      if (usage) {
        payload.usage = usage;
      }
      this.emitLine(payload);
      return;
    }
    this.emitLine({ type: 'turn.failed', error: { message: failure } });
  }
}

/* ------------------------------------------------------------------ *
 * 协议消息 → `codex exec --json` 形状的还原
 * ------------------------------------------------------------------ */

/**
 * 为什么是「序列化回 JSON 行」而不是给 `AgentRunner` 加一条 `runEvents()`：
 *
 * 上层（`core/orchestrator.ts`）本来就按 profile 声明的 parser 解析 `onChunk`
 * 的字节流，而 `codex-json` 解析器认识的正是 `codex exec --json` 的行形状。
 * app-server 与 exec --json 描述的是同一件事（thread / item / turn 三段），
 * 只是传输方式不同。把协议消息还原成一行，就能让现成的解析器、事件类型、
 * 回放器、前端一个字都不动，多付的只是一次 JSON.stringify。
 *
 * 另一条路（新增 `runEvents()` 端口）代价大得多：core 的契约要改，编排器要维护
 * 两条截然不同的事件产生路径，而收益只是省掉一次序列化。不换。
 */
/**
 * 这些 item 类型在 `item.started` 阶段就值得进事件流：它们一出现就说明
 * 「Agent 开始动手了」，而入参摘要（命令、路径）此时已经可读。
 */
const STARTED_ITEM_TYPES = new Set<string>(['commandExecution', 'fileChange', 'mcpToolCall']);

function toWireItem(item: JsonObject): JsonObject | undefined {
  const type = typeof item.type === 'string' ? item.type : undefined;
  if (type === undefined) {
    return undefined;
  }
  switch (type) {
    case 'agentMessage': {
      const text = typeof item.text === 'string' ? item.text : undefined;
      return text === undefined ? undefined : { type: 'agent_message', text };
    }
    case 'reasoning': {
      // app-server 把推理摘要放在 summary / text 两处，解析器只认 text 一类的字段
      return { type: 'reasoning', text: reasoningText(item) };
    }
    case 'commandExecution': {
      // codex 的 command 可能是 argv 数组，解析器只认字符串。不归一化的话
      // tool 事件会退化成只剩一个 "command_execution"，看不出它跑的是什么。
      const command = commandText(item.command);
      return command === undefined
        ? { type: 'command_execution' }
        : { type: 'command_execution', command };
    }
    case 'fileChange': {
      return { type: 'file_change', name: firstChangePath(item) ?? 'file_change' };
    }
    case 'mcpToolCall': {
      return { type: 'mcp_tool_call', name: typeof item.name === 'string' ? item.name : 'mcp_tool_call' };
    }
    case 'error': {
      const message = typeof item.message === 'string' ? item.message : 'codex 报告了一个错误 item';
      return { type: 'error', message };
    }
    default:
      return undefined;
  }
}

function reasoningText(item: JsonObject): string | undefined {
  if (typeof item.text === 'string' && item.text.trim() !== '') {
    return item.text;
  }
  const summary = item.summary;
  if (typeof summary === 'string') {
    return summary.trim() === '' ? undefined : summary;
  }
  if (Array.isArray(summary)) {
    const parts = summary.filter((part): part is string => typeof part === 'string' && part.trim() !== '');
    return parts.length > 0 ? parts.join('\n') : undefined;
  }
  return undefined;
}

function commandText(value: unknown): string | undefined {
  if (typeof value === 'string') {
    return value.trim() === '' ? undefined : value;
  }
  if (Array.isArray(value)) {
    const parts = value.filter((part): part is string => typeof part === 'string' && part.trim() !== '');
    return parts.length > 0 ? parts.join(' ') : undefined;
  }
  return undefined;
}

function firstChangePath(item: JsonObject): string | undefined {
  const changes = item.changes;
  if (!Array.isArray(changes)) {
    return undefined;
  }
  for (const change of changes) {
    const record = asObject(change);
    const path = record?.path;
    if (typeof path === 'string' && path !== '') {
      return path;
    }
  }
  return undefined;
}

/**
 * 从 `turn.error` 里取出人话。
 *
 * codex 的失败信息有两层：`codexErrorInfo` 是个**枚举**（告诉我们属于哪一类问题），
 * `message` 是原始文案（常常是英文长句）。只给枚举太抽象，只给原文又常常是
 * 一坨上游 JSON。所以两者都翻：枚举翻成中文归类，原信息附在后面。
 */
function turnFailureText(turn: JsonObject): string {
  const error = asObject(turn.error);
  const parts: string[] = [`turn 状态 ${String(turn.status)}`];

  const info = error?.codexErrorInfo;
  const category = describeErrorInfo(info);
  if (category !== undefined) {
    parts.push(category);
  }

  const message = typeof error?.message === 'string' ? error.message.trim() : '';
  if (message !== '') {
    parts.push(`原始信息：${message}`);
  }
  return parts.join('；');
}

/** `codexErrorInfo` 的两种形状：字符串枚举，或「分类 → 明细」的单键对象。 */
function describeErrorInfo(info: unknown): string | undefined {
  if (typeof info === 'string') {
    switch (info) {
      case 'contextWindowExceeded':
        return '上下文窗口已用尽（codexErrorInfo=contextWindowExceeded）';
      case 'sessionBudgetExceeded':
      case 'usageLimitExceeded':
        return '用量额度已用尽（codexErrorInfo 额度类）';
      case 'serverOverloaded':
      case 'internalServerError':
        return 'OpenAI 服务端过载或内部错误（codexErrorInfo 服务端类）';
      case 'cyberPolicy':
      case 'misalignmentPolicyViolation':
      case 'unauthorized':
        return `请求被策略拒绝（codexErrorInfo=${info}）`;
      case 'sandboxError':
        return '沙箱拒绝执行这次操作（codexErrorInfo=sandboxError）';
      case 'badRequest':
      case 'threadRollbackFailed':
      case 'other':
        return `请求被 codex 拒绝（codexErrorInfo=${info}）`;
      case 'activeTurnNotSteerable':
        return '当前 turn 不接受追加输入（codexErrorInfo=activeTurnNotSteerable）';
      default:
        return `codexErrorInfo=${info}`;
    }
  }

  const record = asObject(info);
  if (!record) {
    return undefined;
  }
  const keys = Object.keys(record);
  const first = keys.length === 1 ? keys[0] : undefined;
  if (first === undefined) {
    return undefined;
  }
  const detail = asObject(record[first]);
  const status = detail?.httpStatusCode;
  const http = typeof status === 'number' ? `，HTTP ${status}` : '';
  switch (first) {
    case 'httpConnectionFailed':
      return `连不上 OpenAI 的接口${http}（codexErrorInfo=httpConnectionFailed）`;
    case 'responseStreamConnectionFailed':
    case 'responseStreamDisconnected':
      return `响应流中断${http}（codexErrorInfo=${first}）`;
    case 'responseTooManyFailedAttempts':
      return `重试次数用尽${http}（codexErrorInfo=responseTooManyFailedAttempts）`;
    default:
      return `codexErrorInfo=${first}${http}`;
  }
}

/**
 * 无人值守时的审批答案。
 *
 * `availableDecisions` 是服务端给出的可选项。能在其中找到 `cancel` 就用它
 * （最干脆：直接终止这次操作），否则退 `decline`（拒绝这一次，turn 继续）。
 * 两个都没有也退 `decline`——拒绝永远是安全方向，不值得为了一条协议瑕疵
 * 把整个节点判死。
 */
function unattendedDecision(params: JsonObject): 'cancel' | 'decline' {
  const available = params.availableDecisions;
  if (Array.isArray(available)) {
    if (available.includes('cancel')) {
      return 'cancel';
    }
    if (available.includes('decline')) {
      return 'decline';
    }
  }
  return 'decline';
}

/* ------------------------------------------------------------------ *
 * 进程与取消
 * ------------------------------------------------------------------ */

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

/** 等一次 run 结算；到点没结算就返回 false。 */
function settleWithin(settled: Promise<void>, timeoutMs: number): Promise<boolean> {
  return Promise.race([
    settled.then(() => true),
    new Promise<boolean>((resolve) => {
      setTimeout(() => resolve(false), timeoutMs);
    }),
  ]);
}

/**
 * 一次正在跑的 app-server 执行。
 *
 * `cancelled` / `timedOut` 都是**意图**，不是结论：它们由 cancel、超时计时器、
 * 外部 abort 先立起来，能不能算「已终止」要看 `settled` 有没有兑现。
 * 与 `claude-sdk.ts` 的 SdkSlot 完全同一套语义——只有这样 cancel 的返回值
 * 才仍然是「确认终止的数量」，而不是「发出去的信号数」。
 */
interface CodexSlot {
  nodeId: string;
  controller: AbortController;
  cancelled: boolean;
  timedOut: boolean;
  wire?: CodexAppServerWire;
  child?: ChildProcess;
  settled: Promise<void>;
  markSettled: () => void;
}

/**
 * Codex 执行器（app-server 协议）。
 *
 * 与 `SpawnAgentRunner` 的差别只在「怎么把话说给 Agent、怎么读回来说了什么」；
 * 对编排器而言两者是同一个端口：同名方法、同一份 `AgentRunResult`、
 * 同一套 cancel 语义（返回值是确认终止的数量）。
 */
export class CodexAppServerRunner implements AgentRunner {
  /**
   * 正在跑的执行，按 runId + nodeId 索引。同一个 key 允许多条：
   * 取消语义是「这个 run 的这个节点正在跑的全部停掉」。
   */
  private readonly active = new Map<string, CodexSlot[]>();

  constructor(private readonly log: LogSink = silentLog) {}

  /**
   * 终止正在跑的执行，返回**确认**结算的数量。
   *
   * 时序与另外两条执行器对齐：先立取消意图 → 打断协议等待 → 先请进程树退场 →
   * 等到这一次 run 真的结算了才算数。第三步之后仍然等，是因为「信号发出去了」
   * 与「进程没了」之间隔着一个真实的窗口——在这个窗口里宣称已停止，就是
   * 让界面显示已停止而 codex 还在烧 token。
   */
  async cancel(request: AgentCancelRequest): Promise<number> {
    const targets: CodexSlot[] = [];
    for (const [key, bucket] of this.active) {
      if (!belongsToRun(key, request.runId)) {
        continue;
      }
      for (const slot of bucket) {
        if (request.nodeId === undefined || slot.nodeId === request.nodeId) {
          targets.push(slot);
        }
      }
    }

    if (targets.length === 0) {
      // 没有任何在跑的执行：这是「停得早了点」，不是失败
      return 0;
    }

    // 并发停：串行等宽限期会让「停止」的响应时间随并发度线性增长
    const outcomes = await Promise.all(
      targets.map((slot) => this.stopOne(slot, request.runId)),
    );
    return outcomes.filter(Boolean).length;
  }

  /** 停一个执行，返回是否**确认**已结算。时序见 cancel。 */
  private async stopOne(slot: CodexSlot, runId: string): Promise<boolean> {
    slot.cancelled = true;

    // 顺序很重要：先打断「正在等的那一步」，再动进程。
    // 反过来（先杀进程）会让 codex 的 stdout 先关，我们拿到的是一个
    // 「传输断了」的模糊错误，而不是一次干净的取消。
    abortQuietly(slot.controller, '编排器取消了这次 codex 运行');
    slot.wire?.interrupt();
    await killProcessTree(slot.child?.pid, { force: false, log: this.log });

    // run 的收尾（finally）会自己把进程树收干净，必要时升级到强杀，
    // 所以这里只需要等——它结算了就说明进程树已经处理完了。
    let confirmed = await settleWithin(slot.settled, CANCEL_CONFIRM_MS);
    if (!confirmed) {
      // 兜底：它连宽限期过了都没结算，说明卡在了某个我们没料到的等待上。
      // 关掉传输能让所有挂起的请求立即 reject，再补一刀强杀。
      slot.wire?.close();
      await killProcessTree(slot.child?.pid, { force: true, log: this.log });
      confirmed = await settleWithin(slot.settled, KILL_GRACE_MS * 2);
    }
    if (!confirmed) {
      // 宁可不计入返回数量，也不许让界面显示「已停止」而进程还在跑
      this.log.warn('codex 执行未能确认终止', { runId, nodeId: slot.nodeId });
    }
    return confirmed;
  }

  async run(
    request: AgentRunRequest,
    onChunk: (chunk: string) => void,
  ): Promise<AgentRunResult> {
    if (request.signal?.aborted) {
      return { ok: false, exitCode: null, output: '', cancelled: true, error: 'cancelled' };
    }

    // app-server 只吃一个纯文本任务；argv 里那些 exec 参数在这里没有意义。
    const prompt = pickPrompt(request);
    if (prompt.trim() === '') {
      return { ok: false, exitCode: null, output: '', error: '这次执行没有提示词' };
    }

    const resolved = await resolveExecutable(request.bin);
    if (!resolved) {
      return {
        ok: false,
        exitCode: null,
        output: '',
        error: describeFailure({ stage: 'executable', detail: request.bin }),
      };
    }

    const { promise: settled, resolve: markSettled } = deferred<void>();
    const slot: CodexSlot = {
      nodeId: request.nodeId,
      controller: new AbortController(),
      cancelled: false,
      timedOut: false,
      settled,
      markSettled,
    };
    const key = activeKey(request.runId, request.nodeId);
    this.track(key, slot);

    // 上层的中止（用户点停止会 abort 整条链路）与取消同义：都是人让它停的
    const onExternalAbort = (): void => {
      slot.cancelled = true;
      abortQuietly(slot.controller, '编排器中止了这次运行');
    };
    request.signal?.addEventListener('abort', onExternalAbort);

    const timer = setTimeout(() => {
      // 超时与取消必须分开：前者是 Agent 自己的问题，后者是人的决定
      slot.timedOut = true;
      abortQuietly(slot.controller, 'codex 执行超时');
      slot.wire?.interrupt();
      void killProcessTree(slot.child?.pid, { force: false, log: this.log });
    }, request.timeoutMs);

    // 与上层同一份解析器：这样 result.output 与时间线上看到的完全同源，
    // 不会出现「事件里有、裁决解析时却没有」这种两套真相。
    const parser = createParser('codex-json');
    let transcript = '';
    let finalText: string | undefined;
    const collect = (events: AgentEvent[]): void => {
      for (const event of events) {
        if (event.kind === 'text' && event.text) {
          transcript = transcript === '' ? event.text : `${transcript}\n${event.text}`;
        }
        if (event.kind === 'result' && event.text) {
          finalText = event.text;
        }
      }
    };

    let child: ChildProcess | undefined;
    let wire: CodexAppServerWire | undefined;
    let outcome: ProcessOutcome | undefined;
    let stage: CodexStage = 'spawn';
    let turn: CodexTurnOutcome | undefined;
    let thrown: string | undefined;

    try {
      child = spawn(resolved.command, [...resolved.prefixArgs, ...APP_SERVER_ARGS], {
        cwd: request.cwd,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      slot.child = child;

      // spawn 的失败是异步报告的（ENOENT / EACCES 走 'error' 事件），
      // 不等这个 'spawn' 事件就往下发请求，会在一个根本不存在的管道上写。
      await new Promise<void>((resolve, reject) => {
        const onSpawn = (): void => {
          child?.off('error', onError);
          resolve();
        };
        const onError = (error: Error): void => {
          child?.off('spawn', onSpawn);
          reject(new CodexWireError('spawn', error.message, { cause: error }));
        };
        child?.once('spawn', onSpawn);
        child?.once('error', onError);
      });

      child.on('exit', (code, signal) => {
        outcome = { code, signal };
      });
      // 子进程的运行期错误（EPIPE 等）如果没人听，会变成 uncaught 异常。
      // 它不影响结论：传输层与进程退出各自有权威来源。
      child.on('error', (error: Error) => {
        this.log.debug('codex 子进程收到错误事件', {
          runId: request.runId,
          nodeId: request.nodeId,
          error: error.message,
        });
      });
      child.stderr?.on('data', (data: Buffer) => {
        // stderr 是诊断面，不是协议面：只记日志，绝不混进事件流
        this.log.debug('codex app-server stderr', {
          runId: request.runId,
          nodeId: request.nodeId,
          text: data.toString('utf8').slice(0, 2_000),
        });
      });

      const stdin = child.stdin;
      const stdout = child.stdout;
      if (!stdin || !stdout) {
        throw new CodexWireError('spawn', '子进程没有可用的标准输入/标准输出管道');
      }

      wire = new CodexAppServerWire({
        input: stdout,
        output: stdin,
        threadParams: POLICY_THREAD_PARAMS[request.policy] ?? FALLBACK_THREAD_PARAMS,
        // profile 的 modelArgs 是 `-m {model}`，两种写法都要认：读不出来就交给
        // codex 自己的配置，绝不替运维现场选模型
        model: argValue(request.argv, '--model') ?? argValue(request.argv, '-m'),
        log: this.log,
        onLine: (line) => {
          // 同步路径：上层要求 onChunk 不 await（见 core 的 createAgentEventRelay）
          onChunk(line);
          collect(parser.push(line));
        },
      });
      slot.wire = wire;

      wire.start();
      stage = 'initialize';
      await wire.initialize(slot.controller.signal);
      stage = 'thread-start';
      await wire.startThread(request.cwd, slot.controller.signal);
      stage = 'turn-start';
      turn = await wire.runTurn(prompt, slot.controller.signal);
      // 尾行兜底：正常收尾时不该还有残留，但异常中断后剩下的半行必须冲掉
      collect(parser.finish());
    } catch (error) {
      thrown = describeFailure({
        stage: error instanceof CodexWireError ? error.stage : stage,
        detail: errorText(error),
        outcome,
      });
    } finally {
      clearTimeout(timer);
      request.signal?.removeEventListener('abort', onExternalAbort);
      // 先摘表再收尾：cancel 已经拿到 slot（它捕的是对象），而新的 cancel
      // 不该再找到一条已经结束的执行。
      this.forget(key, slot);
      // 收尾顺序：先断协议（不再往里写），再关 stdin，最后请进程树退场。
      wire?.close();
      try {
        child?.stdin?.end();
      } catch {
        // stdin 可能已经因为对端退出而关掉了，这不算故障
      }
      if (child !== undefined) {
        // app-server 是长驻服务，turn 结束后它不会自己退出：
        // 不主动收掉，每个节点都会留一个还在等输入的 codex 进程。
        await killProcessTree(child.pid, { force: false, log: this.log });
        if (!(await waitForExit(child, TERM_GRACE_MS))) {
          await killProcessTree(child.pid, { force: true, log: this.log });
          await waitForExit(child, KILL_GRACE_MS);
        }
      }
      markSettled();
    }

    // 正文：turn 终态行里的 last_agent_message（= wire 收集到的交付正文）优先；
    // 协议没收全时退回 wire 自己的收集，再退回 transcript。
    // transcript 里混着过程播报与工具回灌，对 parseVerdict 是噪声，所以排最后。
    const output = finalText ?? wire?.collectOutput() ?? transcript;

    // 结算优先级：超时 → 取消 → 抛错 → turn 终态。顺序是刻意的：
    // 取消本身也会让协议等待抛错，把「人让它停的」记成执行失败，
    // 会把一次可恢复的中断写成需要人介入的故障。
    if (slot.timedOut) {
      return { ok: false, exitCode: null, output, timedOut: true, error: 'timeout' };
    }
    if (slot.cancelled) {
      return { ok: false, exitCode: null, output, cancelled: true, error: 'cancelled' };
    }
    if (thrown !== undefined) {
      return { ok: false, exitCode: outcome?.code ?? null, output, error: thrown };
    }
    if (turn === undefined) {
      return {
        ok: false,
        exitCode: outcome?.code ?? null,
        output,
        error: 'codex app-server 结束了但没有给出 turn 结果（协议异常）',
      };
    }
    if (turn.status === 'completed') {
      if (turn.failure !== undefined) {
        // 「completed 但没正文」：协议上完成了，交付上什么都没有。
        // 不能当成功——上层靠 output 做审查裁决，空正文只会换来一次空裁决。
        return { ok: false, exitCode: outcome?.code ?? null, output, error: turn.failure };
      }
      return { ok: true, exitCode: 0, output };
    }
    if (turn.status === 'interrupted') {
      // codex 自己中断的（不是我们发过取消）：这是它的执行结果，不是人的决定
      return {
        ok: false,
        exitCode: outcome?.code ?? null,
        output,
        error: 'codex 自己中断了这一轮（本次执行没有发过取消请求）',
      };
    }
    const diagnostic = wire?.collectDiagnostic();
    const failure = turn.failure ?? 'codex turn 失败但没有给出原因';
    return {
      ok: false,
      exitCode: outcome?.code ?? null,
      output,
      error: diagnostic === undefined ? failure : `${failure}；${diagnostic}`,
    };
  }

  private track(key: string, slot: CodexSlot): void {
    const bucket = this.active.get(key);
    if (bucket) {
      bucket.push(slot);
      return;
    }
    this.active.set(key, [slot]);
  }

  private forget(key: string, slot: CodexSlot): void {
    const bucket = this.active.get(key);
    if (!bucket) {
      return;
    }
    const index = bucket.indexOf(slot);
    if (index >= 0) {
      bucket.splice(index, 1);
    }
    if (bucket.length === 0) {
      this.active.delete(key);
    }
  }
}

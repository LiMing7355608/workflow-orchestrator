/**
 * ClaudeSdkRunner：用官方 Agent SDK 驱动 Claude Code。
 *
 * 为什么要有这一路：拼 argv + 解析 stdout 那条路在 Windows 上背了一串本不该
 * 我们背的东西——`.cmd` shim 得用 `cmd.exe` 包一层（于是「杀进程」先杀到的是
 * cmd.exe）、模型名要自己映射、会话续跑与权限档位要自己拼参数。这些全是
 * 这个 SDK 的职责，它自己起 CLI、自己管会话、自己把权限档位翻译成原生模式。
 *
 * 刻意不动 core 的契约：`AgentRunner.run` 的 `onChunk` 仍然是字符串通道，
 * 本执行器把 SDK 的消息流**还原成 CLI stream-json 的一行**再交出去，上层
 * 继续用 profile 里声明的 `claude-stream-json` 解析器。理由见 `toWireLine`。
 *
 * ── 续跑 ──────────────────────────────────────────────────────────────
 *
 * `Options` 里续跑相关的字段有三个，语义完全不同，混用会静默地换掉会话：
 *   - `resume`：**接上**某个已有会话（历史从磁盘 transcript 里读回来）；
 *   - `sessionId`：指定这一轮新会话的 id（SDK 要求合法 UUID），与 `resume` 互斥；
 *   - `continue`：接上「当前目录最近的那个会话」——不确定，本执行器从不用。
 *
 * 所以这条路的做法是：
 *   1. `request.sessionId` 有值 → `resume`，不设 `sessionId`；
 *   2. 没有值 → 看 argv 里有没有 `--session-id`（core 按 profile 的
 *      `session.newSessionArgs` 拼进来的确定性 id），有就设 `sessionId` 把它钉住。
 *      这一步是「重启后还能续」的前提：profile 声明 `session.derive: 'uuidv5'`，
 *      接下去的每一轮拿到的都是同一个算出来的 id，首轮不落在它上面就永远续不上。
 *
 * 续跑失败（会话被清理、transcript 不在本机）时退回新建重跑一次，条件见
 * `run` 里的注释；退回必须留痕（`log.warn`），因为 core 在调用之前就已经落了
 * `node.resumed_session`。
 *
 * 取消与超时**不会**丢掉会话：`stream.close()` 关的是这一次的传输与子进程，
 * 不是磁盘上的 transcript；销毁会话是 `deleteSession()` / `archiveSession()`，
 * 本执行器从不调用它们。否则「打断 → 继续」就变成了「打断 → 重来」。
 */

import { createParser } from '@orchestrator/core';
import type {
  AgentCancelRequest,
  AgentEvent,
  AgentRunRequest,
  AgentRunResult,
  AgentRunner,
  PermissionPolicy,
} from '@orchestrator/core';
import type {
  Options,
  PermissionMode,
  Query,
  SDKMessage,
  SDKResultMessage,
} from '@anthropic-ai/claude-agent-sdk';
import { silentLog, type LogSink } from '../log.js';
import { activeKey, belongsToRun } from '../runner-key.js';

/** SDK 运行时面。用 type-only 的 `typeof import` 表达，不引入任何运行时代码。 */
type SdkModule = typeof import('@anthropic-ai/claude-agent-sdk');

/**
 * `abortController.abort()` 之后还愿意等多久，来确认这一次 run 真的结算了。
 *
 * 与进程树那一路的 TERM/KILL 宽限期同一个道理：发出信号不等于停住了。
 * 取值比那边宽：SDK 有自己的传输层要收尾，比单个进程多一步。
 */
const ABORT_CONFIRM_MS = 3_000;

/** 无人值守时对工具权限的统一回答。写清楚原因，模型看到的是「为什么被拒」。 */
const UNATTENDED_DENY =
  '这个编排运行是无人值守的：没有人能回答权限询问，因此该操作被拒绝。请改用已授权的工具，或在回答里说明需要人工执行的部分。';

/**
 * 与厂商无关的权限档位 → SDK 原生模式。
 *
 * 这只是**兜底表**：真正的第一来源是 profile 声明的 `--permission-mode`
 * （见 `resolvePermissionMode`）。两边同义，因为 claude 的 profile 用的
 * 本来就是 SDK 的词汇；表在这里是为了 argv 里没有那一项时（比如外部覆盖了
 * profile）也能落到正确的档位。
 */
const POLICY_DEFAULT_MODE: Record<PermissionPolicy, PermissionMode> = {
  // review 节点固定用 default。CLI 那一路给的是 `--permission-mode plan`，
  // 这里保持同义：审查只读，不给它改文件的能力。
  default: 'plan',
  'accept-edits': 'acceptEdits',
  auto: 'auto',
  'bypass-permissions': 'bypassPermissions',
};

/** SDK 认得的原生模式。argv 里的值不在其中就当没写，绝不把脏值塞给 SDK。 */
const KNOWN_PERMISSION_MODES: readonly PermissionMode[] = [
  'default',
  'acceptEdits',
  'bypassPermissions',
  'plan',
  'dontAsk',
  'auto',
];

/**
 * 一次正在跑的 SDK 会话。
 *
 * `cancelled` / `timedOut` 都是**意图**，不是结论：它们由 cancel / 超时计时器
 * 先立起来，能不能算「已终止」要看 `settled` 有没有兑现——与进程树那一路
 * 完全同一套语义，只有这样 cancel 的返回值才还是「确认终止的数量」。
 */
interface SdkSlot {
  nodeId: string;
  controller: AbortController;
  cancelled: boolean;
  timedOut: boolean;
  /** 这次 run 结算时兑现，无论成功、失败还是被取消。 */
  settled: Promise<void>;
  /** 兑现 settled。重复调用是安全的。 */
  markSettled: () => void;
}

/** 手写 deferred：目标 Node 20 没有 `Promise.withResolvers`。 */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** abort 一个控制器。已经 abort 过、或者 reason 被别处设过，都不算故障。 */
function abortQuietly(controller: AbortController, reason?: string): void {
  if (controller.signal.aborted) {
    return;
  }
  try {
    controller.abort(reason === undefined ? undefined : new Error(reason));
  } catch {
    // Node 只在极老版本上对 abort 抛错；这里无论如何都已经尽力了
  }
}

/**
 * 从 argv 里取一个带值参数。
 *
 * SDK 接管之后 argv 不再是「执行方式」，它只剩一个用途：记下**调用方要求了
 * 什么**。core 的 `buildAgentArgv` 已经把 profile 的声明展开进去了（
 * `--permission-mode`、`--model`、`--allowedTools`），从 argv 反读比让执行器
 * 再依赖一次 Agent 目录少一层耦合；读不出来也只是退回缺省，不会改变权限语义。
 */
function argValue(argv: string[], flag: string): string | undefined {
  const index = argv.indexOf(flag);
  const value = index >= 0 ? argv[index + 1] : undefined;
  return value !== undefined && !value.startsWith('-') ? value : undefined;
}

/**
 * 决定这次会话的权限模式。
 *
 * 优先级是刻意的：
 *   1. profile 声明给 SDK 的原生模式（argv 里的 `--permission-mode`）。
 *      它在编排器里由 `profile.permissionArgs[policy]` 展开而来，是编排层
 *      对「这个节点该有多大权限」的唯一决定；
 *   2. 兜底表按我们的四档换算（外部覆盖 profile、或 argv 缺项时）；
 *   3. 都没有就 `'acceptEdits'`——无人值守的 DAG 节点默认要能改文件，
 *      否则实现节点永远交付不了产物，那比放宽权限更糟。
 */
function resolvePermissionMode(policy: PermissionPolicy, argv: string[]): PermissionMode {
  const declared = argValue(argv, '--permission-mode');
  if (declared !== undefined) {
    const matched = KNOWN_PERMISSION_MODES.find((mode) => mode === declared);
    if (matched) {
      return matched;
    }
  }
  return POLICY_DEFAULT_MODE[policy] ?? 'acceptEdits';
}

/** 这类 system 消息带不带会话元信息。带才放行，理由见 `toWireLine`。 */
function systemSessionId(message: SDKMessage): string | undefined {
  const value = (message as { session_id?: unknown }).session_id;
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/**
 * 会话 id 的合法形状。
 *
 * 依据是 SDK 自己的声明（`Options.sessionId`：「Must be a valid UUID」）。这里
 * 只用来挡「钉住首轮 id」那一条——`resume` 的文档没有这个限制，交给 CLI 判，
 * 判不过就退回新建（见 `run` 的降级分支）。
 */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * 这一轮要接着哪个会话。
 *
 * `request.sessionId` 是唯一权威：core 的 `resolveSession` 算好之后传进来，
 * 走 SDK 这条路根本不看 argv（`--resume` 那条是给 CLI 执行器的）。
 * argv 作为兜底读一次，是为了让「有人绕过编排器、直接拼 argv 调这个类」的
 * 用法不至于静默地失去续跑——读不出来也只是退回新建，不会改变别的语义。
 */
function resolveResumeId(request: AgentRunRequest): string | undefined {
  return request.sessionId ?? argValue(request.argv, '--resume');
}

/**
 * 把一条 SDKMessage 还原成 CLI stream-json 的一行；返回 undefined 表示不喂解析器。
 *
 * 为什么选这条（序列化回 JSON 行）而不是给 `AgentRunner` 加一个 `runEvents()`：
 * 实测核对了 0.3.326 的消息结构——assistant 带 `message.content` 块
 * （text / thinking / tool_use / tool_result）、user 带回灌的 tool_result、
 * result 带 `result` 与 `usage`、system/init 带 `session_id`——与
 * `claude -p --output-format stream-json` 是同一份线上格式（这个 SDK 起的就是
 * 那个 CLI）。既然结构一致，还原成一行就能让现成的 `claude-stream-json`
 * 解析器原样工作：core 的类型、编排器、回放器一个字都不用动，多付的只是
 * 一次 JSON.stringify。加 `runEvents()` 则要改 core 的端口，还要让编排器
 * 维持两条截然不同的事件产生路径——为了省一次序列化，不值。
 *
 * 但「一致」只覆盖那四类。SDK 还会发一堆 CLI 时代不存在的纯元信息帧
 * （hook_started / hook_response / tool_progress / keep_alive …），
 * 它们不在白名单里：解析器对认不出的行是**原样当正文**，放进去等于把一坨
 * JSON 铺进时间线，冒充 Agent 说过的话。此处宁可丢一帧元信息，也不能污染
 * 「Agent 到底说了什么」这个唯一的事实。
 */
function toWireLine(message: SDKMessage): string | undefined {
  switch (message.type) {
    case 'assistant':
    case 'user':
      return JSON.stringify(message);
    case 'result':
      return JSON.stringify(resultWire(message));
    case 'system':
      // system 是个大杂烩：init 与 status 带 session_id（要落 agent.session），
      // hook_* / task_* / files_persisted 之类不带。不带的那一类如果照发，
      // 解析器会因为「没有 session id」把它退化成一条正文——正是上面说的污染。
      return systemSessionId(message) === undefined ? undefined : JSON.stringify(message);
    default:
      return undefined;
  }
}

/**
 * 错误结果要补一个 `result` 字段。
 *
 * `SDKResultError` 没有 `result`，原因放在 `errors: string[]` 里。解析器只认
 * `result` / `text` / `output`，缺了它就退化成「整行原文」——错误文本会以
 * 一条 JSON 的形式出现在看板上。这里把 `errors` 拼成一句话补进去，
 * 让错误走正常通道：人读到的是原因，不是转义后的花括号。
 */
function resultWire(message: SDKResultMessage): Record<string, unknown> {
  if (message.subtype === 'success') {
    return message as unknown as Record<string, unknown>;
  }
  return {
    type: 'result',
    subtype: message.subtype,
    is_error: true,
    result: message.errors.length > 0 ? message.errors.join('; ') : message.subtype,
    session_id: message.session_id,
    usage: message.usage,
  };
}

/** 从 result 消息里取「为什么失败」。成功型错误（is_error）也要能取出原因。 */
function resultFailure(message: SDKResultMessage): string {
  if (message.subtype === 'success') {
    // 实测：模型/网关拒绝时，还是会给一条 subtype=success 但 is_error=true 的
    // result，正文就是错误原文（本机那次是网关的 402）。所以这里先看正文。
    const text = message.result.trim();
    return text === '' ? 'Agent 报告出错但没有给出原因' : text;
  }
  return message.errors.length > 0 ? message.errors.join('; ') : `Agent 提前结束：${message.subtype}`;
}

/**
 * 官方 SDK 执行器。
 *
 * 与 `SpawnAgentRunner` 的差别只在「怎么把话说给 Agent、怎么读回来说了什么」；
 * 对编排器而言两者是同一个端口：同名的方法、同一份 `AgentRunResult`、
 * 同一套 cancel 语义（返回值是确认终止的数量）。
 */
export class ClaudeSdkRunner implements AgentRunner {
  /**
   * 正在跑的会话，按 runId + nodeId 索引。同一个 key 允许多条：
   * 取消语义是「这个 run 的这个节点正在跑的全部停掉」。
   */
  private readonly active = new Map<string, SdkSlot[]>();

  /**
   * SDK 模块的加载结果。
   *
   * 用动态 import 而不是顶层 import，理由有两条：
   *   1. 它声明 peer `zod ^4`，我们用的是 3.25。实测 import 与 query 都正常，
   *      但真出现与 zod 相关的运行时炸裂时，动态 import 把爆炸半径限制在
   *      claude 节点上——server 照样起得来，其它 Agent 照样能跑；
   *   2. 这一路不是每个部署都用得上，没必要在启动时就把它和它自带的 CLI 一起加载。
   */
  private sdkModule?: Promise<SdkModule>;

  constructor(private readonly log: LogSink = silentLog) {}

  private loadSdk(): Promise<SdkModule> {
    this.sdkModule ??= import('@anthropic-ai/claude-agent-sdk').catch((error: unknown) => {
      // 只在这一拍清缓存：加载失败通常是环境问题（包被裁掉、装坏了）。
      // 留一条 rejected promise 在那儿，会让之后每一次 claude 节点都复用它，
      // 连「装好之后再试一次」的机会都没有。
      this.sdkModule = undefined;
      throw error;
    });
    return this.sdkModule;
  }

  /**
   * 终止正在跑的会话，返回**确认**结算的数量。
   *
   * 时序与进程树那一路对齐：先立取消意图 → abort → 等到这一次 run 真的结算了
   * 才算数。abort 只是请求，SDK 的传输层还要收尾；宣称停掉了但会话还在，
   * 是终止路径上最坏的一种谎，所以这里宁可等满宽限期后报「没确认」。
   */
  async cancel(request: AgentCancelRequest): Promise<number> {
    const targets: SdkSlot[] = [];
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
      // 没有任何在跑的会话：这是「停得早了点」，不是失败
      return 0;
    }

    // 并发停：串行等宽限期会让「停止」的响应时间随并发度线性增长
    const outcomes = await Promise.all(
      targets.map((slot) => this.stopOne(slot, request.runId)),
    );
    return outcomes.filter(Boolean).length;
  }

  /** 停一个会话，返回是否**确认**已结算。时序见 cancel。 */
  private async stopOne(slot: SdkSlot, runId: string): Promise<boolean> {
    slot.cancelled = true;
    abortQuietly(slot.controller, '编排器取消了这次 Agent 运行');

    const confirmed = await Promise.race([
      slot.settled.then(() => true),
      delay(ABORT_CONFIRM_MS).then(() => false),
    ]);
    if (!confirmed) {
      // 宽限期用尽仍未结算：不许算作已终止。宁可少报一个数，也不能让界面
      // 显示「已停止」而会话还在烧 token。
      this.log.warn('SDK 会话未能确认终止', { runId, nodeId: slot.nodeId });
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

    // claude 的 profile 把提示词放在 stdin；没走 stdin 的平台会把提示词当位置参数。
    // 两种来源都要认，否则换成 SDK 之后会对着空提示词跑一次会话。
    const prompt = request.stdin ?? request.argv.join(' ');
    if (prompt.trim() === '') {
      return { ok: false, exitCode: null, output: '', error: '这次执行没有提示词' };
    }

    const { promise: settled, resolve: markSettled } = deferred();
    const slot: SdkSlot = {
      nodeId: request.nodeId,
      controller: new AbortController(),
      cancelled: false,
      timedOut: false,
      settled,
      markSettled,
    };
    const key = activeKey(request.runId, request.nodeId);
    this.track(key, slot);

    // 上层的中止（用户点停止会 abort 整条链路）与取消同义：都是人让它停的。
    const onExternalAbort = (): void => {
      slot.cancelled = true;
      abortQuietly(slot.controller, '编排器中止了这次运行');
    };
    request.signal?.addEventListener('abort', onExternalAbort);

    const timer = setTimeout(() => {
      // 超时与取消必须分开：前者是 Agent 自己的问题，后者是人的决定，
      // 看板上要说的话完全不同（见 core 里 AgentRunResult 的注释）。
      slot.timedOut = true;
      abortQuietly(slot.controller, 'Agent 超时');
    }, request.timeoutMs);

    // 用与上层同一份解析器算正文：这样 result.output 与时间线上看到的
    // 完全同源，不会出现「事件里有、裁决解析时却没有」这种两套真相。
    const parser = createParser('claude-stream-json');
    let transcript = '';
    let finalText: string | undefined;
    let lastResult: SDKResultMessage | undefined;
    let thrown: string | undefined;
    let stream: Query | undefined;

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

    /**
     * 这一轮要试的 Options 序列。
     *
     * 长度 2 = 「先续跑，失败再新建」；长度 1 = 直接新建。做成「先试后降级」而不是
     * 先探测会话是否存在，是因为 SDK 没有暴露「这个 id 能不能续」的查询面——
     * 探测的唯一办法就是真起一次，既然要起，就让它顺便把活干完。
     */
    const resumeId = resolveResumeId(request);
    const plan: Options[] =
      resumeId === undefined
        ? [this.buildOptions(request, slot)]
        : [this.buildOptions(request, slot, resumeId), this.buildOptions(request, slot)];
    /**
     * 这次尝试是否已经收到过 SDK 的消息。
     *
     * 降级的前提条件之一：收到过消息说明提示词已经被处理（模型可能已经开始
     * 改文件），那时重跑会造成重复副作用；只有「一条消息都没有」才谈得上
     * 安全退回。
     */
    let receivedAny = false;

    try {
      const sdk = await this.loadSdk();
      for (let index = 0; index < plan.length; index += 1) {
        const isLast = index === plan.length - 1;
        thrown = undefined;
        try {
          stream = sdk.query({ prompt, options: plan[index]! });
          for await (const message of stream) {
            receivedAny = true;
            const line = toWireLine(message);
            if (line === undefined) {
              // 元信息帧：不进事件流，但在 debug 里留个痕迹，排查「少了一帧」时有据可查
              this.log.debug('跳过不映射的 SDK 消息', {
                runId: request.runId,
                nodeId: request.nodeId,
                type: message.type,
                subtype: (message as { subtype?: unknown }).subtype,
              });
              continue;
            }
            const chunk = `${line}\n`;
            onChunk(chunk);
            collect(parser.push(chunk));
            if (message.type === 'result') {
              lastResult = message;
            }
          }
          // 尾行兜底：解析器按行缓冲，正常收尾时这里不该还有内容，
          // 但异常中断后残留的半行必须冲掉，否则它永远进不了事件流
          collect(parser.finish());
          break;
        } catch (error) {
          thrown = errorText(error);
          // 续跑失败能不能退回新建，取决于三件事同时成立：
          //   1. 后面还有一次「新建」可试（isLast 为假）；
          //   2. 这一次尝试**一条消息都没收到**（提示词没被处理，重跑无副作用）；
          //   3. 没有人让我们停（取消/超时之后不该再开一次会话）。
          // 缺任何一条都保持原有的失败路径——把「续跑失败」硬说成「重来一次」
          // 会让一次真正跑了一半的会话被重放。
          if (isLast || receivedAny || slot.cancelled || slot.timedOut) {
            break;
          }
          // 用 warn 而不是 debug 的理由与另外两个执行器一致：core 的 executeNode
          // 在调用本执行器**之前**就落了 `node.resumed_session`（说这一轮沿用了
          // 那个会话），退回新建之后那条事件就成了假话。debug 在默认级别下既不
          // 落盘也不上界面，等于把「记录与事实不一致」藏起来。
          this.log.warn(
            'claude 会话续跑失败，退回新建会话（看板上的 node.resumed_session 因此与事实不符）',
            {
              runId: request.runId,
              nodeId: request.nodeId,
              sessionId: resumeId,
              error: thrown,
            },
          );
          // 先关掉这一次的流再重试：一个还挂着的 Query 会继续占着它的子进程。
          try {
            stream?.close();
          } catch (closeError) {
            this.log.debug('关闭续跑失败的 SDK 会话时出错', {
              runId: request.runId,
              error: closeError,
            });
          }
          stream = undefined;
        }
      }
    } catch (error) {
      // 走到这里的是 loadSdk 之类的、与单次尝试无关的失败
      thrown = errorText(error);
    } finally {
      clearTimeout(timer);
      request.signal?.removeEventListener('abort', onExternalAbort);
      this.forget(key, slot);
      // 关掉会话是「释放 SDK 侧的传输与子进程」，与「这次 run 结算了」是两件事：
      // 先结算，再关。关失败也不能改写结果——那是清理问题，不是执行问题。
      try {
        stream?.close();
      } catch (error) {
        this.log.debug('关闭 SDK 会话时出错', { runId: request.runId, error });
      }
      markSettled();
    }

    // 正文以 result 消息为准：它才是 Agent 交付的最终答复，而 transcript 里
    // 还混着工具回灌与中间播报（它们对看板有用，对 parseVerdict 是噪声）。
    const output = finalText ?? transcript;

    // 结算优先级：超时 → 取消 → 抛错 → result → 连 result 都没有。
    // 顺序是刻意的：abort 本身也会让迭代抛错，把「人让它停的」记成执行失败，
    // 会把一次可恢复的中断写成需要人介入的故障。
    if (slot.timedOut) {
      return { ok: false, exitCode: null, output, timedOut: true, error: 'timeout' };
    }
    if (slot.cancelled) {
      return { ok: false, exitCode: null, output, cancelled: true, error: 'cancelled' };
    }

    if (lastResult) {
      if (lastResult.subtype === 'success' && !lastResult.is_error) {
        if (thrown !== undefined) {
          // 拿到成功结果之后迭代还抛错，多半是收尾阶段的传输噪声。
          // 这一轮的回答已经完整落地，不能因为清理出错把它判成失败。
          this.log.debug('SDK 会话收尾时报错，但已拿到成功结果', {
            runId: request.runId,
            nodeId: request.nodeId,
            error: thrown,
          });
        }
        return { ok: true, exitCode: 0, output };
      }
      return { ok: false, exitCode: 1, output, error: resultFailure(lastResult) };
    }

    // 一条 result 都没有：这是协议层面的异常，别假装成功
    return {
      ok: false,
      exitCode: null,
      output,
      error: thrown ?? 'Agent 结束但没有给出 result 消息',
    };
  }

  /**
   * 组装这一次会话的 SDK Options。
   *
   * 只放「这次执行真需要」的项，别的全部交给 SDK 的缺省行为：
   * `env` 不传就是继承父进程（传了会**整体替换**，连 PATH / 凭证都丢），
   * 会话目录不传就是 cwd。
   *
   * @param resume 要接上的会话 id。给了就设 `resume`（读旧 transcript）；
   * 不给则看 argv 里有没有 `--session-id`，有就把它**钉住**当成这一轮的会话 id。
   */
  private buildOptions(request: AgentRunRequest, slot: SdkSlot, resume?: string): Options {
    const permissionMode = resolvePermissionMode(request.policy, request.argv);
    const model = request.model ?? argValue(request.argv, '--model');
    const allowed = argValue(request.argv, '--allowedTools');

    const options: Options = {
      // 每个 run 一个控制器：cancel 只停这一次执行，绝不波及同 run 的其它节点
      abortController: slot.controller,
      cwd: request.cwd,
      permissionMode,
      // 这里**必须**留住会话记录（SDK 的缺省就是 true，所以不写这一项）。
      //
      // 上一版显式写了 `persistSession: false`，理由是「节点工作区是一次性的，
      // 会话记录没有留存价值」。那个理由只在「每轮都是新会话」的前提下成立：
      // claude 的续跑靠的正是磁盘上的 transcript（`~/.claude/projects/…`），
      // 关掉落盘等于把 `--resume` / `options.resume` 这条路整个废掉——上一版
      // 因此是每次开新会话。要续跑就得付出这份代价：节点会话记录会留在磁盘上。
      // 清理会话是另一个动作（`deleteSession()` / `archiveSession()`），
      // 本执行器从不调用它们：取消与超时只停当前执行，不该顺手销毁上下文。
      //
      /**
       * 权限闸门：按 policy 分档，不再一律拒绝。
       *
       * 上一版这里无条件 `deny`，理由是「无人值守，没人能回答询问」。那个理由
       * 只对**询问**成立，对**工具执行**不成立：`canUseTool` 在每次工具执行前
       * 都会被调用，一律拒绝等于把 Bash、Read、Grep 这些全封了。实测表现是
       * Agent 想跑 `wc -m` 数一下字数都被驳回，反复换写法反复被拒，最后交一堆
       * 「需要人工执行」的说明回来。
       *
       * 现在的分档与 `policy` 语义对齐：
       * - `plan`（审查节点的默认档）：只读，任何要写或要执行的都拒——审查本来
       *   就不该改文件，这条是对的。
       * - 其余三档：放行。节点的整个意义就是在 worktree 里改代码、跑测试，
       *   拦住等于什么都没干成。隔离靠的是每条 run 一个独立 worktree，不是靠
       *   在这里逐条审批。
       */
      canUseTool: () =>
        permissionMode === 'plan'
          ? Promise.resolve({
              behavior: 'deny' as const,
              message: '只读审查：这个节点不修改文件、也不执行命令。',
            })
          : Promise.resolve({
              behavior: 'allow' as const,
              updatedInput: {},
            }),
      onElicitation: () => Promise.resolve({ action: 'decline' as const }),
      // 对话框兜底：不声明 supportedDialogKinds，SDK 就按「本消费者渲染不了
      // 对话框」处理，自行退化成无对话框行为；这条只是万一它照样发过来时的回答。
      onUserDialog: () => Promise.resolve({ behavior: 'cancelled' as const }),
      // AskUserQuestion 是唯一会让非交互会话永久阻塞的工具，必须禁掉。
      // plan 模式再加一道：ExitPlanMode 在无人值守下没有任何人能批准。
      disallowedTools:
        permissionMode === 'plan'
          ? ['AskUserQuestion', 'ExitPlanMode']
          : ['AskUserQuestion'],
    };

    if (model !== undefined) {
      // 调用方在 argv 里点了名就照办。不传则用 CLI 自己的配置——
      // 那是运维现场的事，不归编排器替它选。
      options.model = model;
    }
    if (allowed !== undefined) {
      const tools = allowed
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean);
      if (tools.length > 0) {
        // 与 CLI 的 --allowedTools 同义：免询问放行，而不是「只准用这些」。
        // profile 里这条声明因此原样迁移，语义不变。
        options.allowedTools = tools;
      }
    }
    if (permissionMode === 'bypassPermissions') {
      // SDK 的硬性要求：不提这一项就拒绝进入 bypassPermissions
      options.allowDangerouslySkipPermissions = true;
    }

    if (resume !== undefined) {
      // 续跑：让 CLI 从磁盘 transcript 恢复这个会话的历史再处理新提示词。
      // **不要**同时设 `sessionId`——SDK 明说两者互斥（除非配 forkSession，
      // 而 fork 出来的是新 id，等于把续跑变成「另开一支」，回传的 id 也就变了）。
      options.resume = resume;
    } else {
      const pinned = argValue(request.argv, '--session-id');
      if (pinned !== undefined) {
        if (UUID_PATTERN.test(pinned)) {
          // 首轮把会话 id 钉住。这一步不是优化，是续跑能成立的前提：
          // profile 声明的是 `session.derive: 'uuidv5'`，core 每一轮都按
          // (runId, nodeId) 算出同一个 id 拿去续跑；首轮若不落在这个 id 上，
          // 后面那一次 `resume` 找的永远是另一个会话（上一版就是这样，
          // 于是「续跑」实际每次都退化成了新建）。
          options.sessionId = pinned;
        } else {
          // 不是合法 UUID：塞进去 SDK 会直接拒启动。这一项只可能由外部误传，
          // 属于配置问题，要让人看见，所以用 warn 而不是 debug。
          this.log.warn('argv 里的 --session-id 不是合法 UUID，忽略它（这一轮会是全新会话）', {
            runId: request.runId,
            nodeId: request.nodeId,
            sessionId: pinned,
          });
        }
      }
    }

    return options;
  }

  private track(key: string, slot: SdkSlot): void {
    const bucket = this.active.get(key);
    if (bucket) {
      bucket.push(slot);
      return;
    }
    this.active.set(key, [slot]);
  }

  private forget(key: string, slot: SdkSlot): void {
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

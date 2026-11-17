/**
 * DshSdkRunner：用官方 client SDK 驱动 DeepSeek Harness。
 *
 * 为什么要有这一路：拼 `dsh --profile headless --json` 那条路把「怎么起 runtime、
 * 怎么握手、怎么收尾」全压在 argv 与 stdout 上——而 headless 是一条**面向人的
 * 一次性 CLI 通道**，它没有会话句柄、没有结构化终止原因、没有取消通道。SDK 这
 * 一路换成 stdio JSON-RPC：`initialize` 握手、`session/prompt`、`session/wait`
 * 都是协议里的东西，终止原因（`turn/end` 的 `reason.kind`）是结构化的，
 * 收尾有 SDK 自己的 dispose 阶梯（stdin EOF → SIGTERM → SIGKILL）。
 *
 * 逻辑来源：`deepseek-harness` 仓库的
 * `packages/subagent/subagent-dsh-sdk/src/run.ts` 与 `src/index.ts`。
 * 只搬逻辑不搬类型——那边 import 的 `dsh-brand` / `dsh-llm` / `dsh-session` /
 * `dsh-subagent` / `dsh-subprocess` 一个都没装，凡是需要的结构都在本文件里
 * 用最小定义重写，或者用 SDK 公开的 `RunResult` / `HarnessNotification`。
 *
 * 与 CLI 那一路的两处**实测**差异（不是偏好，是硬事实）：
 *
 *   1. profile 不能沿用 `--profile headless`。SDK 的握手走 `sdk` profile，
 *      本机实测（`initialize` 等满 10 秒）：
 *        profile=sdk      → 握手 2884ms，跑通，`finishReason=completed`
 *        profile=headless → `RequestTimeoutError: initialize timed out after 10000ms`
 *      headless 的 bundle 列表里没有 `dsh-sdk-jsonrpc-server`，它不服务 RPC。
 *      所以 `request.argv` 里的 `--profile` / `--json` 一律不搬进 SDK 配置。
 *   2. `request.bin` 不能直接当可执行文件喂给 SDK。SDK 起的是
 *      `process.execPath <dsh 的 js 模块> --profile sdk`：它要的是**一个 Node
 *      模块路径**，不是 Windows 上 `where dsh` 找到的 `.ps1` / `.cmd` shim。
 *      实测 `resolveExecutable('dsh')` 在本机给的是 `dsh.ps1`；把它当模块喂进去
 *      等于让 node 去加载 PowerShell 脚本。见 `pickDshModule`。
 */

import { createParser } from '@orchestrator/core';
import type {
  AgentCancelRequest,
  AgentEvent,
  AgentRunRequest,
  AgentRunResult,
  AgentRunner,
} from '@orchestrator/core';
import type {
  DeepSeekHarness,
  DeepSeekHarnessOptions,
  HarnessNotification,
  HarnessSession,
  RunResult,
} from '@deepseek-ai/dsh-sdk-client';
import { silentLog, type LogSink } from '../log.js';
import { isPidAlive, killProcessTree } from '../process-tree.js';
import { resolveExecutable } from '../probe.js';
import { activeKey, belongsToRun } from '../runner-key.js';

/** SDK 的运行面。用 type-only 的 `typeof import` 表达，不引入运行时代码。 */
type SdkModule = typeof import('@deepseek-ai/dsh-sdk-client');

/**
 * SDK 服务协议的那个 profile 名。
 *
 * 这是 SDK 自己的缺省值，不是我们的选择：实测只有它能完成 `initialize` 握手。
 * 写成常量而不是省掉，是为了让「不沿用 argv 里的 headless」这件事在代码里
 * 有个可以指认的名字。
 */
const SDK_PROFILE = 'sdk';

/**
 * 关会话（SDK 自己的 dispose 阶梯）愿意等多久才补刀。
 *
 * 比 `SpawnAgentRunner` 的 TERM 宽限期长：SDK 的阶梯本身是「stdin EOF 宽限
 * 6 秒 → SIGTERM 宽限 3 秒 → SIGKILL」，我们要等的是这一整套走完。
 */
const CLOSE_CONFIRM_MS = 10_000;

/** 补刀（杀整棵树）之后还愿意等多久才认账。与进程树那一路的 KILL 宽限同一量级。 */
const KILL_CONFIRM_MS = 3_000;

/**
 * 握手超时的上限。
 *
 * SDK 缺省 10 秒；本机冷启动实测 2.9–5.2 秒，余量不大。这里改成「跟本次运行的
 * 超时走，但不超过 60 秒」：调用方给了 600 秒就没必要 10 秒就判死，而一次
 * 短超时的运行也不该把时间全花在握手上。
 */
const MAX_INITIALIZE_MS = 60_000;

/**
 * 一次正在跑的 SDK 会话。
 *
 * `cancelled` / `timedOut` 都是**意图**，不是结论：它们由 cancel / 超时计时器
 * 先立起来，能不能算「已终止」要看 `settled` 有没有兑现——与进程树那一路
 * 完全同一套语义，只有这样 cancel 的返回值才还是「确认终止的数量」。
 */
interface SdkSlot {
  nodeId: string;
  /** 持有这一次运行的 runtime 子进程。cwd / profile 都是按运行独立的。 */
  harness: DeepSeekHarness;
  cancelled: boolean;
  timedOut: boolean;
  /** 这次 run 结算（含 runtime 收尾）时兑现，无论成功、失败还是被取消。 */
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

/** 等这一次 run 结算，超时返回 false。`settled` 的语义见 SdkSlot。 */
async function settledWithin(slot: SdkSlot, ms: number): Promise<boolean> {
  return Promise.race([slot.settled.then(() => true), delay(ms).then(() => false)]);
}

/**
 * 会话 id 为什么不自己铸（上一版是 `mintedSessionId()`）。
 *
 * 自己铸一个形状相同的 id 喂给 SDK，确实能让事件流在第一条 prompt 之前就有
 * 过滤键；但那个 id 与 SDK 的真实会话身份之间没有任何保证——续跑要拿它去
 * `resumeSession()`，铸错了就等于每次都在赌一个不存在的会话。改成由
 * `harness.session()` 铸：它返回的 handle 立刻带 `id`（纯本地构造，不发 wire
 * 流量），既保留了「prompt 之前就知道 id」这个性质，又保证这个 id 就是
 * runtime 认的那一个。
 */

/* ------------------------------------------------------------------ *
 * 续跑：resumeSession 是这条路上唯一的入口
 * ------------------------------------------------------------------ */

/**
 * 为什么这一路必须显式调 `resumeSession`（而不是像 CLI 那样拼参数）：
 * SDK 的 `run(input, {sessionId})` 对未知 id 是「**创建**它」，不是「接上它」
 * ——传一个旧 id 只会得到一个同名的空会话，上下文一个字都不在。真正的续跑
 * 只有 `harness.resumeSession(id)`：它从 runtime 配置的持久化 store 里恢复历史，
 * store 里没有就 reject（本机实测：`session "…" not found`）。
 *
 * 取消与超时会不会把它弄丢：不会。这条路的取消/超时只走 `harness.close()`
 * （关的是 runtime 子进程），历史留在 store 里；本机实测「关掉一个 harness、
 * 再开一个新的 resumeSession 同一个 id」上下文完整接上。会话的销毁是另一件
 * 事，SDK 这一层根本没有暴露它。
 */

/* ------------------------------------------------------------------ *
 * runtime 子进程 pid：拿它才能杀整棵树
 * ------------------------------------------------------------------ */

/**
 * 读 SDK 托管的 runtime 子进程 pid。
 *
 * 为什么只能这样读：`HarnessClient.child` 是 TS 的 `private`，运行时可读但没有
 * 公开访问器（0.2.2-rc.3 实测：`Object.keys(client)` 里有 `child`，`child.pid`
 * 是 number，`close()` 之后该进程已不在）。这里把「伸手进私有字段」写成一个
 * 有名字的函数，而不是散在逻辑里，因为它**是**这个文件里唯一的版本脆弱点：
 * SDK 换了内部结构，这里会返回 undefined，而调用方（`stopOne`）必须容忍
 * 「没 pid」——那时只剩 SDK 自己的 dispose 阶梯，报不出「已确认终止」。
 */
function runtimePid(harness: DeepSeekHarness): number | undefined {
  const holder = harness.client as unknown as { child?: { pid?: number } };
  const pid = holder.child?.pid;
  return typeof pid === 'number' && Number.isInteger(pid) && pid > 0 ? pid : undefined;
}

/* ------------------------------------------------------------------ *
 * 最小值取值工具：外部数据一律 unknown，宁可返回 undefined 也不猜
 * ------------------------------------------------------------------ */

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as JsonRecord)
    : undefined;
}

function readString(source: unknown, ...keys: string[]): string | undefined {
  const record = asRecord(source);
  if (!record) {
    return undefined;
  }
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim() !== '') {
      return value;
    }
  }
  return undefined;
}

function readNumber(source: unknown, key: string): number | undefined {
  const value = asRecord(source)?.[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/**
 * 一行 wire JSON。只用来喂解析器与看板，不参与任何判断。
 *
 * 这里不做 try/catch：入参全部由本文件现拼的普通对象组成，没有循环引用，
 * `JSON.stringify` 不会抛。多包一层只会掩盖真正的拼装错误。
 */
function wire(payload: JsonRecord): string {
  return JSON.stringify(payload);
}

/* ------------------------------------------------------------------ *
 * 输出翻译：SDK 的 session 事件 → dsh-json 的行
 * ------------------------------------------------------------------ */

/**
 * 为什么要序列化回 `dsh-json` 的行，而不是给 `AgentRunner` 加一个 `runEvents()`：
 *
 * `AgentRunner.run` 的 `onChunk` 是字符串通道，上层用 profile 里声明的
 * `dsh-json` 解析器把它翻成 `AgentEvent`。SDK 给的是 `SessionEvent` 对象
 * （`{ type, seq, time, data }`），结构上**能**无损映射到 dsh 自己的行格式：
 *
 *   assistant/message → text（块）/ thinking（块）/ tool_call（块）
 *   step/start        → step_start
 *   step/end          → step_end（带 usage）
 *   turn/start        → turn_start
 *   turn/end          → turn_end（带 reason）
 *   （收尾）          → final（带 session_id）
 *
 * 既然能还原，就让现成的解析器原样工作：core 的类型、编排器、回放器一个字都
 * 不用动，代价只是一次 JSON.stringify。这与 `claude-sdk.ts` 是同一个取舍
 * ——两条 SDK 路线都选择「不新增端口」，否则编排器要维持两条截然不同的事件
 * 产生路径。与那条唯一的不同：这里的映射表是**手写**的（dsh 的线上格式不是
 * CLI 的 stdout 格式），词汇表取自 `packages/core/src/parsers.ts` 里
 * `handleDshLine` 认得的那几种 type。
 *
 * 反方向（认不出的 type）一律**不产出**。解析器对认不出的行是原样当正文，
 * 而 dsh 的会话事件里满是纯元信息（`request/header`、`system/message`、
 * `agent/inbox/spliced`、`session/title` …）。放进去等于把一坨 JSON 铺进
 * 时间线冒充 Agent 说过的话——宁可丢一帧元信息，也不能污染「Agent 到底说了
 * 什么」这个唯一的事实。
 */

/**
 * 跨事件的状态：usage 出现在 `assistant/message` 上，而它该挂到 `step_end`。
 *
 * 为什么挪到 step_end：core 的解析器只把 `step_end` / `turn_end` 这类
 * **结算阶段**上的用量当数（`SETTLEMENT_PHASES`）。挂在消息上会漏，而照着
 * 每条消息累加又会在成本账上重复计入。
 */
interface WireState {
  pendingUsage: JsonRecord | undefined;
}

/**
 * `tool-call` 块的 `arguments` 是**模型产出的 JSON 字符串**，不是对象。
 *
 * 不能原样当字符串丢给解析器：它会把整段 JSON 当成工具入参摘要铺进时间线。
 * 解析成功就交对象，让解析器按 `command` / `path` / `pattern` 这些字段自己
 * 拼一句人话；解析失败（模型给了半截 JSON）退回原字符串——那是模型失控的
 * 证据，不该被抹掉。
 */
function parseArguments(raw: unknown): unknown {
  if (typeof raw !== 'string') {
    return raw;
  }
  const text = raw.trim();
  if (text === '') {
    return undefined;
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return raw;
  }
}

/** `assistant/message` 的正文块 → 若干行。空 text 块丢掉，理由见下。 */
function translateAssistantMessage(data: JsonRecord | undefined, state: WireState): string[] {
  const message = asRecord(data?.message);
  const blocks = Array.isArray(message?.content) ? message.content : [];
  const lines: string[] = [];

  for (const block of blocks) {
    const item = asRecord(block);
    const blockType = readString(item, 'type');

    if (blockType === 'text') {
      const text = readString(item, 'text');
      // 空 text 块必须跳过：解析器对 `{"type":"text","text":""}` 认不出正文，
      // 会退化成「整行原文」，于是时间线上多出一行花括号。thinking 的处理相反，
      // 见下——空思考是真实存在的语义，不是噪声。
      if (text !== undefined) {
        lines.push(wire({ type: 'text', text }));
      }
      continue;
    }

    if (blockType === 'reasoning') {
      // 空的 reasoning 也照实给出：它确实是模型说的一句话，只是没有内容。
      // 丢不丢由编排层按「有没有正文」判定，解析层不替编排层做回收决策。
      lines.push(wire({ type: 'thinking', text: readString(item, 'text') ?? '' }));
      continue;
    }

    if (blockType === 'tool-call') {
      lines.push(
        wire({
          type: 'tool_call',
          name: readString(item, 'name') ?? 'tool',
          input: parseArguments(item?.arguments),
        }),
      );
      continue;
    }

    // image / file / tool-addition / tool-removal：dsh-json 的词汇表里没有对应
    // 语义。硬翻成 text 会把一段引用信息伪装成正文，所以留空。
  }

  const usage = asRecord(data?.usage);
  if (usage) {
    state.pendingUsage = usage;
  }
  return lines;
}

/** 一条 session 事件 → 零到多行。返回空数组表示「这一帧不进事件流」。 */
function translateEvent(event: unknown, state: WireState): string[] {
  const record = asRecord(event);
  const type = readString(record, 'type');
  const data = asRecord(record?.data);

  switch (type) {
    case 'assistant/message':
      return translateAssistantMessage(data, state);

    case 'step/start':
      return [wire({ type: 'step_start', turn: readNumber(data, 'turn'), step: readNumber(data, 'step') })];

    case 'step/end': {
      const usage = state.pendingUsage;
      state.pendingUsage = undefined;
      return [
        wire({
          type: 'step_end',
          turn: readNumber(data, 'turn'),
          step: readNumber(data, 'step'),
          ...(usage ? { usage } : {}),
        }),
      ];
    }

    case 'turn/start':
      return [wire({ type: 'turn_start', turn: readNumber(data, 'turn') })];

    case 'turn/end': {
      // 没有 step_end 的 turn（比如在 step 边界外就被中止）在这里把用量交出去，
      // 免得它随着 pendingUsage 一起消失。交过一次就清空，不会重复计入。
      const usage = state.pendingUsage;
      state.pendingUsage = undefined;
      return [
        wire({
          type: 'turn_end',
          turn: readNumber(data, 'turn'),
          reason: data?.reason,
          ...(usage ? { usage } : {}),
        }),
      ];
    }

    default:
      return [];
  }
}

/** 会话 id 行。放在最前面，让时间线的第一条事件就带上原生会话 id。 */
function sessionWireLine(sessionId: string): string {
  return wire({ type: 'session', session_id: sessionId });
}

/**
 * 收尾的 final 行：`output` 的来源。
 *
 * 为什么单独补一行而不是让编排层去看最后一条 text：审查节点要用 `output` 做
 * 裁决，而 dsh 的一条回答可能被拆成多个 text 块（还有工具调用夹在中间）。
 * `RunResult.finalResponse` 是 SDK 按它自己的规则选出的「最后一条 assistant
 * 消息的正文」——那是权威的最终答复，把它作为一条 result 事件交出去，
 * 裁决解析与看板就同源了。
 */
function finalWireLine(result: RunResult | undefined, sessionId: string): string | undefined {
  const text = result?.finalResponse ?? '';
  if (text.trim() === '') {
    // 没有最终正文（被取消、被中止、模型什么都没说）：不造一个空 result，
    // 否则 `output` 会从「部分正文」退化成「空字符串」
    return undefined;
  }
  return wire({ type: 'final', text, session_id: sessionId });
}

/**
 * 终止原因 → 我们这边的裁决。
 *
 * 取值来自 `turn/end` 的 `reason.kind`（参考实现 `sdkChildOutcome` 的同一张表）。
 * `aborted` 刻意与「我们发的取消」分开：走到这里说明不是我们让它停的，
 * 那是 runtime 侧的中止，属于执行失败。
 */
function judgeFinish(reason: string | null): { ok: boolean; error?: string } {
  switch (reason) {
    case 'completed':
      return { ok: true };
    case 'max-tokens':
      return { ok: false, error: 'Agent 达到输出上限，回答被截断' };
    case 'blocked':
      return { ok: false, error: '模型拒绝了这次请求（blocked）' };
    case 'interrupted':
      return { ok: false, error: '运行被 runtime 中断（interrupted）' };
    case 'aborted':
      return { ok: false, error: '运行被 runtime 中止，且不是编排器发起的取消（aborted）' };
    case 'error':
      return { ok: false, error: 'runtime 报告执行错误（error）' };
    case null:
      return { ok: false, error: 'Agent 结束但没有给出 turn 终止原因' };
    default:
      return { ok: false, error: `Agent 以未识别的原因结束：${reason}` };
  }
}

/**
 * `request.bin` 能不能当一个 Node 模块交给 SDK。
 *
 * SDK 的 `dshBin` 语义是「dsh 的 js 模块路径」，它会被塞进
 * `process.execPath <模块> --profile ...`。所以只有解析结果是 `.js` / `.mjs` /
 * `.cjs`（例如 profile 把 bin 直接指向某个 `lib/bin.js`）才用得上；本机实测
 * `resolveExecutable('dsh')` 给的是 `dsh.ps1`，那不是模块。
 *
 * 拿不到就返回 undefined，让 SDK 用它自己依赖里的 `@deepseek-ai/dsh`
 * ——那是唯一能保证「与 client 同版本」的入口（SDK 会校验两边的版本号相等），
 * 而机器上全局装的 dsh 是另一个版本（本机：全局 0.2.0-rc.2，client 要 0.2.2-rc.3）。
 */
function pickDshModule(path: string | undefined): string | undefined {
  return path !== undefined && /\.(?:m|c)?js$/i.test(path) ? path : undefined;
}

/**
 * 官方 SDK 执行器。
 *
 * 与 `SpawnAgentRunner` 的差别只在「怎么把话说给 Agent、怎么读回来说了什么」；
 * 对编排器而言两者是同一个端口：同名的方法、同一份 `AgentRunResult`、
 * 同一套 cancel 语义（返回值是确认终止的数量）。
 */
export class DshSdkRunner implements AgentRunner {
  /**
   * 正在跑的会话，按 runId + nodeId 索引。同一个 key 允许多条：
   * 取消语义是「这个 run 的这个节点正在跑的全部停掉」。
   */
  private readonly active = new Map<string, SdkSlot[]>();

  /**
   * SDK 模块的加载结果。
   *
   * 用动态 import 而不是顶层 import：这一路不是每个部署都用得上，没必要在
   * server 启动时就把 SDK 和它自带的 runtime 一起拖进来；也让「SDK 装坏了」
   * 的爆炸半径只覆盖 dsh 节点——server 照样起得来，别的 Agent 照样能跑。
   */
  private sdkModule?: Promise<SdkModule>;

  constructor(private readonly log: LogSink = silentLog) {}

  private loadSdk(): Promise<SdkModule> {
    this.sdkModule ??= import('@deepseek-ai/dsh-sdk-client').catch((error: unknown) => {
      // 只在这一拍清缓存：加载失败通常是环境问题（包被裁掉、装坏了）。
      // 留一条 rejected promise 在那儿，会让之后每一次 dsh 节点都复用它，
      // 连「装好之后再试一次」的机会都没有。
      this.sdkModule = undefined;
      throw error;
    });
    return this.sdkModule;
  }

  /**
   * 终止正在跑的会话，返回**确认**结算的数量。
   *
   * 时序与进程树那一路对齐：先立取消意图 → 关会话 → 等确认。关会话不是
   * 可选的收尾步骤，它是这条链上唯一能停住 runtime 的动作（协议里没有
   * 行级的 prompt 取消：参考实现的原话是「There is no wire-level prompt
   * cancel: dispose settles the result locally」）。
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

    // 第一刀是关会话：SDK 自己的 dispose 阶梯（stdin EOF → SIGTERM → SIGKILL）
    // 会一直等到进程真的退出。这里不等它的返回值，因为同一件事 run() 的
    // finally 也在等，两边拿的是同一个 closeTask。
    void this.closeQuietly(slot, runId);
    if (await settledWithin(slot, CLOSE_CONFIRM_MS)) {
      return true;
    }

    // 第二刀杀整棵树：SDK 的阶梯只终止它直接 spawn 的那个 node，挡不住它
    // 下面的孙子进程（工具里起的 pwsh 之类）。留下一个还在烧 token 的孤儿，
    // 而这边宣称「已停止」，是终止路径上最坏的一种谎。
    const pid = runtimePid(slot.harness);
    this.log.warn('dsh 会话未按时收尾，强制终止整棵进程树', {
      runId,
      nodeId: slot.nodeId,
      pid,
    });
    await killProcessTree(pid, { force: true, log: this.log });

    if (await settledWithin(slot, KILL_CONFIRM_MS)) {
      return true;
    }
    // 进程确实没了也算确认：settled 可能还卡在 SDK 的收尾上，但「runtime
    // 已经不在」是同一个事实的另一个证据
    if (pid !== undefined && !isPidAlive(pid)) {
      return true;
    }

    // 两刀都没拿到实据：不许算作已终止。宁可少报一个数，也不能让界面
    // 显示「已停止」而会话还在烧 token
    this.log.warn('dsh 会话未能确认终止', { runId, nodeId: slot.nodeId, pid });
    return false;
  }

  async run(
    request: AgentRunRequest,
    onChunk: (chunk: string) => void,
  ): Promise<AgentRunResult> {
    if (request.signal?.aborted) {
      return { ok: false, exitCode: null, output: '', cancelled: true, error: 'cancelled' };
    }

    // dsh 的 profile 把提示词放在 stdin；没走 stdin 的平台会把提示词当位置参数。
    // 两种来源都要认，否则换成 SDK 之后会对着空提示词跑一次会话。
    // 注意：argv 里只剩**提示词**有意义，`--profile` / `--json` 一律不进来
    // （理由见文件头）。
    const prompt = request.stdin ?? request.argv.join(' ');
    if (prompt.trim() === '') {
      return { ok: false, exitCode: null, output: '', error: '这次执行没有提示词' };
    }

    let sdk: SdkModule;
    try {
      sdk = await this.loadSdk();
    } catch (error) {
      return {
        ok: false,
        exitCode: null,
        output: '',
        error: `dsh SDK 加载失败：${errorText(error)}`,
      };
    }

    // bin 只用来选 dsh 模块（见 pickDshModule）；解析失败不阻断执行——
    // SDK 自带同版本的 runtime，PATH 上没有 dsh 也能跑。
    const executable = await resolveExecutable(request.bin).catch((error: unknown) => {
      this.log.debug('解析 dsh 可执行文件失败，改用 SDK 自带 runtime', {
        runId: request.runId,
        bin: request.bin,
        error: errorText(error),
      });
      return undefined;
    });
    const dshBin = pickDshModule(executable?.path);
    this.log.debug('dsh SDK 启动方式', {
      runId: request.runId,
      nodeId: request.nodeId,
      bin: request.bin,
      resolvedPath: executable?.path,
      dshModule: dshBin ?? '（SDK 自带 @deepseek-ai/dsh）',
      profile: SDK_PROFILE,
    });

    const harness = new sdk.DeepSeekHarness(this.buildOptions(request, dshBin));

    const { promise: settled, resolve: markSettled } = deferred();
    const slot: SdkSlot = {
      nodeId: request.nodeId,
      harness,
      cancelled: false,
      timedOut: false,
      settled,
      markSettled,
    };
    const key = activeKey(request.runId, request.nodeId);
    this.track(key, slot);

    // 用与上层同一份解析器算正文：这样 result.output 与时间线上看到的
    // 完全同源，不会出现「事件里有、裁决解析时却没有」这种两套真相。
    const parser = createParser('dsh-json');
    const state: WireState = { pendingUsage: undefined };
    let transcript = '';
    let finalText: string | undefined;
    let output = '';

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

    const emit = (line: string): void => {
      const chunk = `${line}\n`;
      onChunk(chunk);
      collect(parser.push(chunk));
    };

    // 同一条事件可能走两个来源（直播的通知流 + 收尾时 RunResult.events 的补齐），
    // 按 seq 去重：dsh 的每条会话事件都带自己唯一的序号
    const fed = new Set<number>();
    const feedEvent = (event: unknown): void => {
      const seq = readNumber(event, 'seq');
      if (seq !== undefined) {
        if (fed.has(seq)) {
          return;
        }
        fed.add(seq);
      }
      const lines = translateEvent(event, state);
      for (const line of lines) {
        emit(line);
      }
    };

    // 上层的中止（用户点停止会 abort 整条链路）与取消同义：都是人让它停的。
    // 协议里没有行级取消，唯一的停法是关会话。
    const onExternalAbort = (): void => {
      slot.cancelled = true;
      void this.closeQuietly(slot, request.runId);
    };
    request.signal?.addEventListener('abort', onExternalAbort);

    const timer = setTimeout(() => {
      // 超时与取消必须分开：前者是 Agent 自己的问题，后者是人的决定，
      // 看板上要说的话完全不同（见 core 里 AgentRunResult 的注释）。
      slot.timedOut = true;
      void this.closeQuietly(slot, request.runId);
    }, request.timeoutMs);

    let result: RunResult | undefined;
    let thrown: string | undefined;
    /** 这一轮真正跑在哪个会话上。续跑没成时它是新建的那个（见 openSession）。 */
    let session: HarnessSession | undefined;

    try {
      // 续跑还是新建，只能在这里定：`request.sessionId` 是编排器算出的唯一权威
      // （它已经落了 `node.resumed_session`，见 core 的 executeNode）。
      session = await this.openSession(harness, request, slot);
      if (session !== undefined) {
        // 原生会话 id 立刻进事实。续跑时它就是上一轮那个 id——`resumeSession`
        // 不换 id，handle 的 `id` 就是你传进去的那个；新建时是 SDK 铸的那个。
        emit(sessionWireLine(session.id));
        const rootId = session.id;
        result = await session.run(prompt, {
          // 直播通道：通知在 wire 到达时就喂给解析器，看板不必等整轮跑完
          onNotification: (notification: HarnessNotification) => {
            const event = rootSessionEvent(notification, rootId);
            if (event !== undefined) {
              feedEvent(event);
            }
          },
        });
      }
    } catch (error) {
      thrown = errorText(error);
    } finally {
      clearTimeout(timer);
      request.signal?.removeEventListener('abort', onExternalAbort);
      try {
        // 补齐通道：取消 / 超时 / 失败时通知流可能提前断在半路，这里把
        // RunResult 里已经有的事件补进去（去重靠 seq），少丢一句话
        for (const event of result?.events ?? []) {
          feedEvent(event);
        }
        // 会话都没开成（resume 期间被取消/超时）：连 session 行都还没发，
        // 补一条带空 id 的 final 只会凭空造出一个「会话」。
        const line = session === undefined ? undefined : finalWireLine(result, session.id);
        if (line !== undefined) {
          emit(line);
        }
        // 尾行兜底：解析器按行缓冲，正常收尾时这里不该还有内容，
        // 但异常中断后残留的半行必须冲掉，否则它永远进不了事件流
        collect(parser.finish());
        output = finalText ?? transcript;
      } finally {
        // 关会话是「释放 SDK 侧的 runtime 子进程」，与「这次 run 结算了」是
        // 两件事：先拿到输出，再收尾，最后才兑现 settled。关失败也不能改写
        // 结果——那是清理问题，不是执行问题。
        await this.closeQuietly(slot, request.runId);
        this.forget(key, slot);
        markSettled();
      }
    }

    // 结算优先级：超时 → 取消 → 抛错 → 终止原因。
    // 顺序是刻意的：关会话本身会让 await 抛错，把「人让它停的」记成执行失败，
    // 会把一次可恢复的中断写成需要人介入的故障。
    if (slot.timedOut) {
      return { ok: false, exitCode: null, output, timedOut: true, error: 'timeout' };
    }
    if (slot.cancelled) {
      return { ok: false, exitCode: null, output, cancelled: true, error: 'cancelled' };
    }

    if (result === undefined) {
      // 一条 RunResult 都没有：这是协议 / 传输层面的异常，别假装成功。
      // 已经拿到的部分正文仍然交出去——审查节点看到半句比看到空更接近事实。
      return {
        ok: false,
        exitCode: null,
        output,
        error: thrown ?? 'dsh 运行结束但没有给出结果',
      };
    }

    const verdict = judgeFinish(result.finishReason);
    if (verdict.ok) {
      // 拿到成功结果之后还抛错，多半是收尾阶段的传输噪声。这一轮的回答
      // 已经完整落地，不能因为清理出错把它判成失败。
      if (thrown !== undefined) {
        this.log.debug('dsh 会话收尾时报错，但已拿到成功结果', {
          runId: request.runId,
          nodeId: request.nodeId,
          error: thrown,
        });
      }
      return { ok: true, exitCode: 0, output };
    }
    return { ok: false, exitCode: 1, output, error: verdict.error ?? thrown ?? 'dsh 运行失败' };
  }

  /**
   * 组装这一次运行的 SDK 配置。
   *
   * 只放「这次执行真需要」的项：
   *   - `cwd` 是会话工作目录（节点独占的工作区，Agent 的文件操作落在它下面）；
   *   - `processCwd` 是 runtime 进程自己的目录，同样指向节点工作区——两者
   *     分开是因为 SDK 会二次解析相对路径，混用会让 `worker` 变成 `worker/worker`；
   *   - `env` 不传就是继承父进程（含 `DSH_HOME` 与凭证）。传了会**整体替换**，
   *     连 PATH 和凭证一起丢——参考实现宁可自己先 scrub 再合并，我们没那个
   *     需要，就不碰；
   *   - `dshHome` 不传：隔离一个 home 要预先装好 profile 与凭证，编排器不自建。
   *     这是刻意的边界：多实例并跑会共享同一份会话记录，但那是部署该决定的事。
   */
  private buildOptions(request: AgentRunRequest, dshBin: string | undefined): DeepSeekHarnessOptions {
    const options: DeepSeekHarnessOptions = {
      cwd: request.cwd,
      processCwd: request.cwd,
      profile: SDK_PROFILE,
      // 握手要装插件、起插件树，比一次普通请求慢得多；上限跟本次运行走
      initializeTimeoutMs: Math.min(request.timeoutMs, MAX_INITIALIZE_MS),
      // requestTimeoutMs 不设：协议默认是无上限等待。超时由我们自己管
      // （request.timeoutMs + 关会话），这样「谁让它停的」只有一个来源，
      // 也不会出现 SDK 判了超时我们却当成成功。
      //
      // onUserQuestion 不设：无人值守的编排节点没有人能回答，runtime 会按
      // 「没有应答者就 fail closed」处理（实测的运行上下文自述如此）。
      // 给它一个假答案反而会污染模型的判断。
    };
    if (dshBin !== undefined) {
      // 调用方把 bin 指到了一个 js 模块上就照办（见 pickDshModule）
      options.dshBin = dshBin;
    }
    return options;
  }

  /**
   * 决定这一轮跑在哪个会话上：能续就续，续不上就新建。
   *
   * 判据只有一个：`request.sessionId` 有没有值。它是 core 的 `resolveSession`
   * 算出来的，`hooked` 派生型平台靠上一轮从事件流里捕获的原生 id 填它 ——
   * 这个文件没有任何资格自己判断「能不能续」（比如去猜 argv 里有没有 id）。
   *
   * 续跑失败**一律不判节点失败**：会话被清理、id 过期、store 换了 home，都是
   * 部署现场的正常变化，让节点整轮失败等于把「上下文丢了」升级成「活干不成」。
   * 退回新建并把原因写下来，至少这一轮还能交付。
   *
   * 为什么用 `log.warn` 而不是 `log.debug`：core 的 executeNode 在调用本执行器
   * **之前**就落了 `node.resumed_session`（说「这一轮沿用了这个会话」）。退回
   * 新建之后，那条事件就成了假话。`debug` 在默认级别下既不落盘也不上界面，
   * 等于把「记录与事实不一致」藏起来；只有 `warn` 能让它在运行日志里留下
   * 一条可检索的痕迹。这是本次续跑改造里唯一会「说一套做一套」的地方，
   * 必须在默认可见的级别上报。
   *
   * @returns 打开的会话；`undefined` 表示续跑期间被取消/超时，不该再新建。
   */
  private async openSession(
    harness: DeepSeekHarness,
    request: AgentRunRequest,
    slot: SdkSlot,
  ): Promise<HarnessSession | undefined> {
    const wanted = request.sessionId;
    if (wanted === undefined) {
      // 没有上一轮可接：让 SDK 铸一个新 id（理由见文件里那段「会话 id 为什么
      // 不自己铸」）。这条分支就是「新建」，也是旧行为的全部。
      return harness.session();
    }

    try {
      const resumed = await harness.resumeSession(wanted);
      this.log.debug('dsh 会话续跑成功', {
        runId: request.runId,
        nodeId: request.nodeId,
        sessionId: resumed.id,
      });
      return resumed;
    } catch (error) {
      // 取消/超时会关掉 runtime，resume 的失败只是它的后果。这时候再新建一个
      // 会话没有任何意义（人已经让它停了），而且 harness 已经关过，
      // `session().run()` 只会再抛一次。直接交回控制权，让结算按意图走。
      if (slot.cancelled || slot.timedOut) {
        this.log.debug('dsh 续跑期间被取消/超时，不再新建会话', {
          runId: request.runId,
          nodeId: request.nodeId,
          sessionId: wanted,
        });
        return undefined;
      }
      this.log.warn('dsh 会话续跑失败，退回新建会话（看板上的 node.resumed_session 因此与事实不符）', {
        runId: request.runId,
        nodeId: request.nodeId,
        sessionId: wanted,
        error: errorText(error),
      });
      // 退回新建：同一个 harness 上重开一个空会话。`resumeSession` 失败时
      // SDK 会重建 client（见 DeepSeekHarness.start 的失败分支），所以这里
      // 拿到的 handle 仍然可跑。
      return harness.session();
    }
  }

  /** 关会话，永不抛。失败只是清理问题，不能改写这次执行的结果。 */
  private async closeQuietly(slot: SdkSlot, runId: string): Promise<void> {
    try {
      await slot.harness.close();
    } catch (error) {
      this.log.debug('关闭 dsh 会话时出错', {
        runId,
        nodeId: slot.nodeId,
        error: errorText(error),
      });
    }
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

/**
 * 从通知里取出**根会话**的 session 事件。
 *
 * `subscribeSessionTree` 会把子代理（dsh 自己的 subagent 工具）的事件也送上来。
 * 那些不属于这次节点的产出：混进正文会让审查节点去裁决子代理的中间播报。
 * 所以只认 `sessionId` 等于本次会话的那一条，其余交给日志（排查「少了一帧」
 * 时有据可查）。
 */
function rootSessionEvent(
  notification: HarnessNotification,
  sessionId: string,
): unknown | undefined {
  if (notification.method !== 'session.event') {
    return undefined;
  }
  const params = asRecord(notification.params);
  return params?.sessionId === sessionId ? params.event : undefined;
}

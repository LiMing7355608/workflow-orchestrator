/**
 * AcpRunner：用 Agent Client Protocol 驱动**任何**实现了 ACP 的 agent。
 *
 * 为什么要有这一路：前面两条路（`SpawnAgentRunner` 拼 argv、`ClaudeSdkRunner` 用
 * 官方 SDK）都绑死在某一家 CLI 的词汇上——参数怎么拼、输出怎么解析、会话 id 从哪来。
 * ACP 把这些换成了一个有版本的 JSON-RPC 契约：`initialize` 协商能力，`session/new`
 * 建会话，`session/prompt` 提交任务，`session/update` 回流结构化更新，
 * `session/cancel` 请求停止。只要一个 agent 讲这套协议，编排器就能调度它，
 * 而这个文件里没有一行代码认识某一家 agent 的名字。
 *
 * ── 一次 run 的时序 ────────────────────────────────────────────────────
 *
 *   1. spawn：`bin` + `argv` 经 `resolveExecutable` 解析成真能执行的东西
 *      （Windows 上 npm 装的 `.cmd` / `.ps1` 必须借宿主跑），`cwd` 就是节点工作目录。
 *      stdio 三条全是管道：stdin 是协议出口，stdout 是协议入口，stderr 只做诊断。
 *      注意 `argv[0]` 是**程序名**（`buildAgentArgv` 以 `bin` 打头），必须丢掉，
 *      否则 `cmd.exe /c dsh.cmd dsh --profile acp` 会在参数解析阶段就退出。
 *   2. `initialize`：必须第一个发。我们声明 `clientCapabilities: {}`——见下文「能力」。
 *   3. `session/new`：`cwd` 传绝对路径，`mcpServers` 传空数组。
 *   4. `session/set_config_option`（可选）：有显式模型时协商，兼容 argv 里的默认模型提示。
 *      但 argv 同时是启动命令，所以往 `modelArgs` 里写 `--model {model}` 有风险，
 *      详见 `applyModel` 的注释。
 *   5. `session/prompt`：`request.stdin ?? argv.join(' ')` 作为一个 text 内容块提交。
 *   6. 收尾：关连接（agent 侧的 quiescent teardown 由「客户端断开」触发），
 *      然后 EOF + 进程树终止。节点会话是一次性的，不需要 `session/close`：
 *      那个方法是为「agent 进程还活着、只释放一个会话」准备的，而我们每次都会
 *      把这个进程连同它的子孙一起收掉。
 *
 * ── update（ACP）→ AgentEvent（我们）的完整映射 ────────────────────────
 *
 *   | ACP `sessionUpdate`       | AgentEvent                                  | 说明 |
 *   |---------------------------|---------------------------------------------|------|
 *   | `agent_message_chunk`     | `text`                                      | 只取 text 块；同时累积进 output |
 *   | `agent_thought_chunk`     | `thinking`                                  | 模型的内部独白，与正式回答分开 |
 *   | `tool_call`               | `tool`（toolName + 入参摘要）                 | 一次调用的开始 |
 *   | `tool_call_update`        | 仅在 `status === 'failed'` 时发 `error`       | 进度噪声不落时间线；失败必须留痕 |
 *   | `usage_update`            | `result.usage`（挂在结算那一行）              | 见下文「用量」 |
 *   | `notice`                  | 仅 `severity === 'error'` 时发 `error`        | info/warning 是纯提示，不进内容流 |
 *   | `user_message_chunk`      | 丢弃                                        | 我们自己说的话回显，不是 agent 说了什么 |
 *   | `plan`                    | 丢弃                                        | 理由见 `translateUpdate` |
 *   | `current_mode_update`     | 丢弃                                        | 同上 |
 *   | `config_option_update`    | 丢弃                                        | 同上 |
 *   | `available_commands_update` | 丢弃                                      | 同上 |
 *   | `session_info_update`     | 丢弃                                        | 同上 |
 *   | `compaction_update`       | 丢弃                                        | 我们没广播 `session.compaction` 能力 |
 *   | `compaction_summary_chunk`| 丢弃                                        | 同上 |
 *   | 未知变体                   | 丢弃                                        | 更新的协议版本才有；不猜 |
 *
 *   另有两条**不是** update 来的事件：
 *   - `session`：`session/new` 返回后立刻发一次，原生会话 id 从这里进事实；
 *   - `result`：拿到 `PromptResponse` 的那一拍发一次，正文是这一轮累积的助手输出，
 *     `usage` 一起挂在它上面。
 *
 * ── AgentEvent → onChunk 的线上形状 ───────────────────────────────────
 *
 *   core 的 `AgentRunner.run` 只有一个字符串通道（`onChunk`），编排层会拿 profile
 *   声明的 parser 去读它。所以这里的**翻译发生在 runner 内部**——ACP 是结构化的，
 *   不该先把它压成文本再让行解析器去猜——翻译结果按 `dsh-json` 的词汇逐行吐出：
 *
 *     text → {"type":"text","text":…}          thinking → {"type":"thinking","text":…}
 *     tool → {"type":"tool_call","name":…,      error    → {"type":"error","text":…}
 *             "input":{"description":…}}
 *     session → {"type":"session","session_id":…}
 *     result  → {"type":"final","text":…,"usage":…}
 *
 *   为什么是这套词汇：`dsh-json` 是我们自己的格式，与 `AgentEvent` 一一对应，
 *   且 core 里已经有解析器能读它。这样接线只需要 profile 声明
 *   `launch.parser: 'dsh-json'` + `transport: 'acp'`，core 一行都不用改。
 *   代价写在明处：`dsh-json` 的 tool 事件只从入参里取摘要、没有独立摘要字段，
 *   所以工具摘要被塞进 `input.description`，时间线上会多一个 `description=`
 *   前缀——那是解析器的字段名，不是我们编的内容。
 *
 * ── 用量 ──────────────────────────────────────────────────────────────
 *
 *   ACP 的 `usage_update` 报的是**上下文占用**：`used`（当前上下文里的 token 数）
 *   与 `size`（上下文窗口容量）。`used` 是真实消耗的输入量，映射成
 *   `promptTokens` / `totalTokens`；`size` 是容量上限，**刻意丢掉**——
 *   把窗口大小写成「合计 token」会让成本账凭空翻几十倍。
 *   会话级 `cost`（金额）在 `AgentUsage` 里没有对应字段，只能进 debug 日志。
 *
 * ── 能力（initialize 里我们声明什么）────────────────────────────────────
 *
 *   一个都不声明。fs 与 terminal 那两组方法是「编辑器替 agent 读写缓冲区、
 *   提供终端视图」用的：我们不是编辑器，节点工作区就是 agent 自己的进程能直接
 *   读写的目录，替它代理文件只会多一层没人看的中间态。不声明就是明确告诉 agent
 *   「自己动手」，协议里这是合法且正确的缺省。
 *
 * ── 权限请求：无人值守一律拒绝 ──────────────────────────────────────────
 *
 *   `session/request_permission` 是 agent 在运行时问「能不能动这个」。这个编排
 *   运行里没有任何人坐在屏幕前，所以一律挑 `reject_once` / `reject_always` 选项
 *   回答；一个 reject 选项都没有时回 `cancelled`（协议里「没得选」的合法答案）。
 *   注意 `bypass-permissions` 档在这里**同样拒绝**：四档 policy 是给 CLI 那一路
 *   拼参数用的，不是客户端应答开关——替调用方回答「可以」等于把一个本该由人
 *   承担的风险静默转移给流程。将来若要放开，只改 `answerPermission` 一处。
 *
 *   理由为什么只落在日志与错误摘要里：ACP 的应答只有「选了哪个选项」或
 *   `cancelled`，没有一句自由文本能回给模型。模型看到的是「被拒绝」这个结果，
 *   人看到的是本文件里的理由 + 运行日志里的记录。
 *
 * ── 续跑（`request.sessionId` 有值时）──────────────────────────────────
 *
 *   `initialize` 之后不再无条件 `session/new`，而是先看 agent 有没有广播
 *   `sessionCapabilities.resume`：
 *
 *   - 有：发 `session/resume { sessionId, cwd, mcpServers }`。这个方法**只恢复
 *     会话状态、不回放历史消息**（回放是 `session/load` 的事，我们不要——
 *     上一轮的正文已经在事实里了，重放一遍等于让看板把同一句话说两次）。
 *     响应里没有 `sessionId`：续的就是请求里那个 id，回传也必须用它。
 *   - 没有：退回 `session/new`。协议里缺省这个能力是合法的，不是错误。
 *   - 发了但失败（会话不存在 / 不可续跑 / cwd 对不上）：同样退回 `session/new`。
 *
 *   退回新建一定要在**默认可见**的级别上报（这里是 `log.warn`）：core 的
 *   executeNode 在调用本执行器之前就落了 `node.resumed_session`，退回之后那条
 *   事件就成了假话。`debug` 在默认级别下既不落盘也不上界面，等于把不一致藏了。
 *
 * ── 取消 ──────────────────────────────────────────────────────────────
 *
 *   两条腿一起走，缺一条都不完整：
 *   - 协议：`session/cancel` 通知，给 agent 机会自己把这一轮收干净；
 *   - 进程：`killProcessTree`，先 EOF + 温和终止，宽限期过了才强杀整棵树
 *     （`.cmd` 包装下真正的 agent 是 cmd.exe 的子进程，只杀父进程会留下孤儿）。
 *   返回值是**确认终止**的数量：只有拿到子进程 `exit` 这个实据才计数。
 *   进程退出在这里比「run 结算了」更直接——它回答的正是「还有没有东西在跑」。
 *
 * ── 接线方（profile）需要声明的 ────────────────────────────────────────
 *
 *   `transport: 'acp'`、`launch.parser: 'dsh-json'`、
 *   `launch.bin` = agent 可执行文件（如 `dsh`）、`launch.args` = 启动它所需的参数
 *   （如 `['--profile', 'acp']`）、`launch.stdin: true`（提示词走 stdin 通道，
 *   即 `request.stdin`），以及 `capabilities.structured: true`。
 *   `launch.modelArgs` 建议留空：它会被拼进 agent 的命令行，而 ACP agent 的模型
 *   是由 `session/set_config_option` 选的，不是命令行参数。真要指定模型，靠的是
 *   agent 在 `session/new` 里暴露 `category: 'model'` 的选择项（本文件已自动映射）。
 */

import { spawn, type ChildProcessByStdio } from 'node:child_process';
import type { AgentProfile } from '@orchestrator/core';
import type { ModelDirectory } from '../model-providers.js';
import { Readable, Writable } from 'node:stream';
import {
  client as createClientApp,
  methods,
  ndJsonStream,
  PROTOCOL_VERSION,
} from '@agentclientprotocol/sdk';
import type {
  ClientConnection,
  ClientContext,
  ContentBlock,
  InitializeResponse,
  NewSessionResponse,
  PermissionOption,
  RequestPermissionResponse,
  SessionUpdate,
  StopReason,
} from '@agentclientprotocol/sdk';
import type {
  AgentCancelRequest,
  AgentEvent,
  AgentRunRequest,
  AgentRunResult,
  AgentRunner,
  AgentUsage,
} from '@orchestrator/core';
import { silentLog, type LogSink } from '../log.js';
import { resolveExecutable } from '../probe.js';
import { killProcessTree } from '../process-tree.js';
import { activeKey, belongsToRun } from '../runner-key.js';
import type { ProcessRegistry } from '../registry.js';

/* ------------------------------------------------------------------ *
 * 阈值与固定文案
 * ------------------------------------------------------------------ */

/**
 * 温和终止之后给多久自己退出。
 *
 * 与进程树那一路同一个取值：agent 收到终止信号后往往还要落盘、释放子进程，
 * 直接强杀会把半截产物留在工作区。
 */
const TERM_GRACE_MS = 800;

/** 强杀整棵树之后还愿意等多久来确认它真的没了（回执不是同步的）。 */
const KILL_GRACE_MS = 400;

/**
 * stdin EOF 之后、**一个信号都不发**的等待窗口。
 *
 * ACP 的优雅收尾就藏在这里：读端收到 EOF，agent 排空更新、flush 持久化、
 * 把它的子孙进程收干净，然后自己退出。在这段窗口里抢着发终止信号，等于把
 * 它本该做的收尾工作打断——所以正常结束时给得宽（1.5 秒），取消时给得紧
 * （400 毫秒）：取消是人的决定，慢不得，而正常结束该让 agent 把话说完整。
 */
const SHUTDOWN_EOF_GRACE_MS = 1_500;

/** 取消路径上的 EOF 宽限。见 SHUTDOWN_EOF_GRACE_MS。 */
const CANCEL_EOF_GRACE_MS = 400;

/** 诊断用的 stderr 尾巴长度：够看出崩在哪，又不会把日志撑爆。 */
const STDERR_TAIL_CHARS = 2_000;

/**
 * 拼进 `AgentRunResult.error` 的 stderr 长度。
 *
 * 这个字符串最终会进 `node.failed` 的 reason（看板上给人看的那一句），
 * 所以比日志里留的尾巴更短：主句是原因，stderr 只是佐证。
 */
const ERROR_TAIL_CHARS = 800;

/** 工具入参摘要的长度上限。时间线上这一截是用来扫一眼的。 */
const SUMMARY_MAX_CHARS = 80;

/** 摘要里优先取用的入参字段，按信息量排：命令 > 路径 > 模式 > 查询 > 描述。 */
const SUMMARY_KEYS = [
  'command',
  'cmd',
  'file_path',
  'filePath',
  'path',
  'pattern',
  'glob',
  'query',
  'url',
  'description',
  'prompt',
] as const;

/** `initialize` 里报给 agent 的客户端身份。纯诊断用，协议不依赖它。 */
const CLIENT_INFO = { name: 'workflow-orchestrator', version: '0.1.0' } as const;

/**
 * 无人值守时拒绝权限请求的理由。
 *
 * 它进不了协议应答（ACP 没有这个字段），但每一处拒绝都带着它写日志，
 * 所以排查「为什么 agent 说它没权限」时能一路对上这句话。
 */
const UNATTENDED_DENY_REASON =
  '这个编排运行是无人值守的：没有人能回答 ACP 的权限询问，因此一律拒绝';

/* ------------------------------------------------------------------ *
 * 小工具
 * ------------------------------------------------------------------ */

/** 手写 deferred：目标 Node 20 没有 `Promise.withResolvers`。 */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** 等一个 promise 到点没兑现就返回 false（表示「没等到」，不是「失败」）。 */
function within(promise: Promise<void>, timeoutMs: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => {
      resolve(false);
    }, timeoutMs);
    void promise.then(() => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** 从 argv 里取一个带值参数（`--model X`）。读不出来就是「调用方没点名」。 */
function argValue(argv: string[], flag: string): string | undefined {
  const index = argv.indexOf(flag);
  const value = index >= 0 ? argv[index + 1] : undefined;
  return value !== undefined && !value.startsWith('-') ? value : undefined;
}

/** 拼失败原因：主句在前，附加事实放在括号里，一条都不丢。 */
function withDetail(base: string, parts: (string | undefined)[]): string {
  const extra = parts.filter((item): item is string => item !== undefined && item.trim() !== '');
  return extra.length === 0 ? base : `${base}（${extra.join('；')}）`;
}

/* ------------------------------------------------------------------ *
 * ACP 内容与工具：从协议形状里取出人能读的那一句
 * ------------------------------------------------------------------ */

/**
 * 取一个内容块的文本。
 *
 * 非 text 块（图片、音频、资源链接）返回空串：我们在 prompt 里只发 text，
 * agent 回流的图片在这个通道里没有地方可渲染，硬塞成 base64 只会污染时间线。
 */
function contentText(block: ContentBlock): string {
  return block.type === 'text' ? block.text : '';
}

/** 多行入参只取第一句有内容的话。 */
function firstMeaningfulLine(value: string): string {
  const line = value.split('\n').find((item) => item.trim() !== '') ?? '';
  return line.trim();
}

/**
 * 把 `rawInput` 压成一行 `key=value · key=value` 的摘要。
 *
 * 为什么不直接把整个 rawInput 铺出去：一次编辑或一次命令的入参动辄上万字符，
 * 铺进时间线等于把「它调了什么」淹成一片括号。这里只回答「它在哪个文件、
 * 跑什么命令」。拼不出任何字段就返回 undefined，上层退化成只有工具名。
 *
 * 这段逻辑与 core/parsers.ts 里的同名工具同义，但那边没有导出、本文件也不许
 * 改 core，所以在这里留一份小拷贝——只抄「取哪几个键、截多长」，不抄行为以外的
 * 任何东西。
 */
function summarizeInput(input: unknown): string | undefined {
  if (typeof input === 'string') {
    const line = firstMeaningfulLine(input);
    return line === '' ? undefined : line.slice(0, SUMMARY_MAX_CHARS);
  }
  const record = asRecord(input);
  if (!record) {
    return undefined;
  }
  const parts: string[] = [];
  for (const key of SUMMARY_KEYS) {
    const value = record[key];
    if (typeof value !== 'string' || value.trim() === '') {
      continue;
    }
    parts.push(`${key}=${firstMeaningfulLine(value)}`);
    if (parts.length >= 2) {
      break;
    }
  }
  return parts.length === 0 ? undefined : parts.join(' · ').slice(0, SUMMARY_MAX_CHARS);
}

/**
 * 一次工具调用的 AgentEvent。
 *
 * 摘要优先从 `rawInput` 里挖（那里面才有命令和路径），挖不出才退回 `title`：
 * 有的 agent 把 `title` 写成一句人话，有的只写工具名（dsh-acp 就是后者），
 * 两种都要能落出一条有信息的事件。
 */
function toolEvent(call: {
  title?: string | null;
  name?: string | null;
  kind?: string | null;
  rawInput?: unknown;
  toolCallId?: string;
}): AgentEvent {
  const summary = summarizeInput(call.rawInput) ?? call.title ?? call.name ?? call.toolCallId;
  return {
    kind: 'tool',
    toolName: call.name ?? call.kind ?? 'tool',
    text: summary,
  };
}

/* ------------------------------------------------------------------ *
 * update → AgentEvent 的翻译
 * ------------------------------------------------------------------ */

/**
 * 把一条 ACP `session/update` 翻译成 0..n 个 `AgentEvent`。
 *
 * 刻意做成纯函数：状态累积（正文、用量）留在调用点，翻译只管「这条 update
 * 在语义上等于什么」。这样映射表就是这张 switch，读的人不用在闭包里绕。
 *
 * 为什么进度类 update（plan / mode / config / commands / session_info）一律丢弃：
 * 编排层对 `status` 事件的策略是「只有结算那一拍带用量才值得落库」（见
 * `createAgentEventRelay`），其余 status 直接被扔掉。在这里就丢掉，可以让
 * 「事件流里没有的东西 = 我们没发的东西」这条因果保持简单，而不是发出一堆
 * 注定被上层筛掉的噪声。
 */
export function translateUpdate(update: SessionUpdate): AgentEvent[] {
  switch (update.sessionUpdate) {
    case 'agent_message_chunk': {
      const text = contentText(update.content);
      return text === '' ? [] : [{ kind: 'text', text }];
    }

    case 'agent_thought_chunk': {
      const text = contentText(update.content);
      return text === '' ? [] : [{ kind: 'thinking', text }];
    }

    case 'tool_call':
      return [toolEvent(update)];

    case 'tool_call_update': {
      // 一次调用的生命周期会发好几条 update（pending → in_progress → completed）。
      // 全发出去等于把同一次调用在时间线上重复四遍；只有失败是新事实。
      if (update.status !== 'failed') {
        return [];
      }
      const label = update.title ?? update.name ?? update.toolCallId;
      return [{ kind: 'error', text: `工具调用失败：${label}` }];
    }

    case 'notice': {
      // notice 是「给用户的临时提示」，按协议 agent 只在我们广播了
      // session.notices 能力时才发；我们没广播，所以收到的都是约定之外的东西。
      // 只有 error 级值得进事件流，info/warning 是纯噪声。
      if (update.severity !== 'error') {
        return [];
      }
      const detail = update.description ?? undefined;
      return [{ kind: 'error', text: detail ? `${update.title}：${detail}` : update.title }];
    }

    case 'user_message_chunk':
    case 'plan':
    case 'available_commands_update':
    case 'current_mode_update':
    case 'config_option_update':
    case 'session_info_update':
    case 'usage_update':
    case 'compaction_update':
    case 'compaction_summary_chunk':
      return [];

    default:
      // ACP 的 update 联合是开放的（新版本会加变体）。认不出来的不猜、不冒充正文。
      return [];
  }
}

/**
 * `usage_update` → `AgentUsage`。
 *
 * `used` 是当前上下文里的 token 数，也就是这一轮真实喂进去的输入量，所以
 * 同时记进 `promptTokens` 与 `totalTokens`。`size`（窗口容量）刻意不进任何字段：
 * 把「窗口有多大」写成「花了多少」会让成本账凭空翻几十倍。
 */
export function contextUsage(used: number): AgentUsage | undefined {
  if (!Number.isFinite(used) || used <= 0) {
    return undefined;
  }
  return { promptTokens: used, totalTokens: used };
}

/* ------------------------------------------------------------------ *
 * AgentEvent → onChunk 的线上形状
 * ------------------------------------------------------------------ */

/**
 * 一条 `AgentEvent` → 一行 `dsh-json`。返回 undefined 表示「这类事件不上线」。
 *
 * 白名单而不是直传：编排层对认不出的行是**原样当正文**，放进去等于把一坨 JSON
 * 铺进时间线冒充 agent 说的话。宁可少一帧，也不污染「agent 到底说了什么」。
 */
export function toWireLine(event: AgentEvent): string | undefined {
  switch (event.kind) {
    case 'text':
      return event.text ? JSON.stringify({ type: 'text', text: event.text }) : undefined;

    case 'thinking':
      return event.text ? JSON.stringify({ type: 'thinking', text: event.text }) : undefined;

    case 'tool': {
      // dsh-json 的 tool 事件从入参里取摘要（没有独立摘要字段），所以摘要落到
      // `input.description`——解析器会给它加一个 `description=` 前缀，见文件头。
      const input = event.text ? { description: event.text } : undefined;
      return JSON.stringify({
        type: 'tool_call',
        name: event.toolName ?? 'tool',
        ...(input === undefined ? {} : { input }),
      });
    }

    case 'error':
      return event.text ? JSON.stringify({ type: 'error', text: event.text }) : undefined;

    case 'session':
      return event.sessionId
        ? JSON.stringify({ type: 'session', session_id: event.sessionId })
        : undefined;

    case 'result': {
      // 结算行同时是 result 与 usage 的唯一载体：正文为空、又没有用量时不上线，
      // 否则解析器会把这一行当成「认不出」的正文原样铺到时间线上。
      if (!event.text && !event.usage) {
        return undefined;
      }
      return JSON.stringify({
        type: 'final',
        text: event.text ?? '',
        ...(event.usage === undefined ? {} : { usage: event.usage }),
      });
    }

    case 'usage':
      // 用量不单独出行：dsh-json 只有 final 那一行会同时产出 result 与 usage
      // 两个事件。单开一行等于让用量在时间线上被记两次。
      return undefined;

    case 'status':
      // 本执行器不发 status（进度类 update 在翻译阶段就丢掉了，理由见 translateUpdate）。
      // 留这个分支只是为了在将来有人往这里塞 status 时，别让 JSON 混进正文。
      return undefined;
  }
}

/* ------------------------------------------------------------------ *
 * 一次正在跑的 ACP 会话
 * ------------------------------------------------------------------ */

type AcpChild = ChildProcessByStdio<Writable, Readable, Readable>;

/**
 * 一次正在跑的 ACP 会话。
 *
 * `cancelled` / `timedOut` 都是**意图**，不是结论：它们由 cancel / 超时计时器
 * 先立起来，能不能算「已终止」要看 `exited` 有没有兑现。两件事分开，是因为
 * 中间的窗口里进程可能还活着——宣称停掉了但进程还在跑，是终止路径上最坏的一种谎。
 */
interface AcpSlot {
  nodeId: string;
  child: AcpChild;
  /** 协议连接。连上之后才能发 cancel，收尾时关掉它。 */
  connection?: ClientConnection;
  /** 会话建立后才有：`session/cancel` 必须有 sessionId 才发得出去。 */
  sessionId?: string;
  cancelled: boolean;
  timedOut: boolean;
  /** 子进程真的退出了——确认终止的唯一实据。 */
  exited: Promise<void>;
  /**
   * 收尾阶梯的共享结果：谁先来谁定义这一趟，后到者拿同一个 promise。
   * 取消与 run 自己的收尾会重叠，没有它就等于对同一个 pid 重复下手。
   */
  stopping?: Promise<boolean>;
}

/** 本轮被拒掉的权限请求，攒起来以便把「为什么失败」说圆。 */
interface PermissionLedger {
  count: number;
  kinds: string[];
}

/* ------------------------------------------------------------------ *
 * 执行器
 * ------------------------------------------------------------------ */

/**
 * 一次「把会话准备好」的结果。
 *
 * 刻意只有这两项：ACP 的新建响应与会话续跑响应都带 `modes` / `configOptions`，
 * 但我们只用得上模型选择项（`applyModel`）与最终的会话 id。把整个响应传下去
 * 会诱导后来的人去读那些我们没有语义的字段。
 */
interface OpenedSession {
  sessionId: string;
  configOptions: NewSessionResponse['configOptions'];
}

/**
 * 这一轮该走 `session/resume` 还是 `session/new`。
 *
 * 抽成纯函数不是为了好看，是为了让这条判定能被测到：真正的 `openSession` 要
 * 起进程、发协议请求，单测里没法覆盖「agent 没广播 resume 能力」这种分支。
 * 判定只依赖两项输入，两者都是**外部给的事实**，这里不做任何猜测：
 *   1. `requestedId` —— core 的 `resolveSession` 算出的会话 id（没有就是新建）；
 *   2. `capabilities` —— `initialize` 里 agent 自报的能力（缺省即不支持）。
 */
export type SessionOpening =
  /** 接上这个会话。`sessionId` 就是请求里那个 id，不是新铸的。 */
  | { opening: 'resume'; sessionId: string }
  /** 新建。`lostResume` 为真表示「本来要续，续不了」——这时必须留痕。 */
  | { opening: 'new'; reason: string; lostResume: boolean };

export function planSessionOpening(
  requestedId: string | undefined,
  /**
   * 允许缺省：协议里 `agentCapabilities` 是可选的，老 agent 只实现
   * `session/new`，压根不广播能力块。缺省按「不支持续跑」处理——发
   * `session/resume` 会被当成未知方法打回来，那不是续跑失败，是我们违反了
   * 刚协商完的能力。
   */
  capabilities: InitializeResponse['agentCapabilities'] | null | undefined,
): SessionOpening {
  if (requestedId === undefined) {
    return { opening: 'new', reason: '本次执行没有可续跑的会话 id', lostResume: false };
  }
  // 缺省（undefined / null）就是「没有这个能力」：协议里这合法，老 agent 只
  // 实现了 session/new。此时发 session/resume 会被当成未知方法打回来，
  // 那不是续跑失败，是我们违反了刚协商完的能力。
  if (capabilities?.sessionCapabilities?.resume == null) {
    return {
      opening: 'new',
      reason: 'agent 未广播 session/resume 能力',
      lostResume: true,
    };
  }
  return { opening: 'resume', sessionId: requestedId };
}

/**
 * ACP 执行器。
 *
 * 与另外两条路的差别只在「怎么把话说给 agent、怎么读回来说了什么」；
 * 对编排器而言三者是同一个端口：同名的方法、同一份 `AgentRunResult`、
 * 同一套 cancel 语义（返回值是确认终止的数量）。
 */
export class AcpRunner implements AgentRunner {
  /**
   * 正在跑的会话，按 `activeKey(runId, nodeId)` 索引。
   * 同一个 key 允许多条：取消语义是「这个 run 的这个节点正在跑的全部停掉」。
   */
  private readonly active = new Map<string, AcpSlot[]>();

  constructor(
    private readonly log: LogSink = silentLog,
    /**
     * 进程账本。可选：不传就是「不登记」，行为与接入账本之前一致。
     *
     * 但生产上必须传——server 崩溃重启后，`ProcessRegistry.reap` 只认账本里
     * 的记录，没登记的 ACP agent 会一直跑下去，既烧 token 又占着 worktree。
     */
    private readonly registry?: ProcessRegistry,
  ) {}

  /* ---------------------------------------------------------------- *
   * 取消
   * ---------------------------------------------------------------- */

  /**
   * 终止正在跑的会话，返回**确认**终止的数量。
   *
   * 并发停而不是串行：串行等宽限期会让「停止」的响应时间随并发度线性增长。
   */
  async cancel(request: AgentCancelRequest): Promise<number> {
    const targets: AcpSlot[] = [];
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

    for (const slot of targets) {
      slot.cancelled = true;
    }

    const outcomes = await Promise.all(
      targets.map((slot) =>
        this.interrupt(slot, {
          runId: request.runId,
          notifyAgent: true,
          eofGraceMs: CANCEL_EOF_GRACE_MS,
        }),
      ),
    );
    return outcomes.filter(Boolean).length;
  }

  /**
   * 让一个会话停下来，返回是否**确认**终止。
   *
   * 只做动作、不碰标志位：取消、超时、外部中止都要走这条链，但它们对结果的
   * 含义完全不同（见 core 里 `AgentRunResult` 的注释），标志由各自的调用点立。
   *
   * 同一个会话的收尾阶梯只跑一遍：取消那条腿与 run 自己的收尾会在时间上重叠，
   * 各跑一遍等于对同一个 pid 重复 taskkill，只会在日志里留下「进程不存在」的
   * 噪声，还可能让两个 taskkill 互相踩。谁先到谁定义这一趟，后到者共享结果。
   *
   * `notifyAgent` 区分两种场景，混在一起会伤害两边：
   * - 取消/超时：要先告诉 agent「这一轮不要了」，它才有机会自己收干净；
   * - 正常结束：此时再发一次取消没有任何意义，只会在日志里留一条
   *   「ACP connection closed」的噪声——话说完了就该挂断。
   */
  private interrupt(
    slot: AcpSlot,
    options: { runId: string; notifyAgent: boolean; eofGraceMs: number },
  ): Promise<boolean> {
    slot.stopping ??= this.runStopLadder(slot, options);
    return slot.stopping;
  }

  /** 收尾阶梯本体：EOF → 温和终止 → 强杀整棵树。每一档都只等到「确认退出」为止。 */
  private async runStopLadder(
    slot: AcpSlot,
    options: { runId: string; notifyAgent: boolean; eofGraceMs: number },
  ): Promise<boolean> {
    const { runId } = options;

    if (options.notifyAgent) {
      await this.requestCancel(slot);
    }

    const pid = slot.child.pid;
    // 第一步永远是 EOF：0 字节的读端就是「我不再说了」，ACP 的优雅收尾从这里开始。
    // 这一步不发任何信号，只把决定权交给 agent。
    try {
      slot.child.stdin.end();
    } catch (error) {
      this.log.debug('结束 ACP stdin 时出错', { runId, nodeId: slot.nodeId, error });
    }
    if (await within(slot.exited, options.eofGraceMs)) {
      return true;
    }

    // 再请：给它机会把落盘、提交、释放子进程做完
    await killProcessTree(pid, { force: false, log: this.log });
    if (await within(slot.exited, TERM_GRACE_MS)) {
      return true;
    }

    // 宽限期用尽：它不肯自己走。终止杀整棵树——只杀父进程会留下还在烧 token 的孤儿。
    await killProcessTree(pid, { force: true, log: this.log });
    if (await within(slot.exited, KILL_GRACE_MS)) {
      return true;
    }

    // 强杀整棵树后仍未确认退出：不许算作已终止。宁可少报一个数，
    // 也不能让界面显示「已停止」而进程还在跑。
    this.log.warn('ACP agent 未能确认终止', { runId, nodeId: slot.nodeId, pid });
    return false;
  }

  /**
   * 协议级取消：告诉 agent「这一轮不要了」，让它自己收干净。
   *
   * 失败不是故障：进程已经走了、会话已经不在，都是正常竞态。
   * 真正保证「停下来」的是下面的进程树终止，不是这条通知。
   */
  private async requestCancel(slot: AcpSlot): Promise<void> {
    const { connection, sessionId } = slot;
    if (!connection || !sessionId) {
      return;
    }
    try {
      await connection.agent.notify(methods.agent.session.cancel, { sessionId });
    } catch (error) {
      this.log.debug('ACP session/cancel 未被接受', { nodeId: slot.nodeId, error });
    }
  }

  /* ---------------------------------------------------------------- *
   * 执行
   * ---------------------------------------------------------------- */

  async run(
    request: AgentRunRequest,
    onChunk: (chunk: string) => void,
  ): Promise<AgentRunResult> {
    if (request.signal?.aborted) {
      return { ok: false, exitCode: null, output: '', cancelled: true, error: 'cancelled' };
    }

    /*
     * argv 的第 0 项是**程序名**，不是参数。
     *
     * `core.buildAgentArgv` 永远以 `profile.launch.bin` 打头，`SpawnAgentRunner`
     * 也照这个约定 `slice(1)`。照搬整条 argv 会把 bin 名当成第一个参数交给 agent
     * （`cmd.exe /c dsh.cmd dsh --profile acp`），agent 在参数解析阶段就会退出——
     * 而这种失败看起来像是「握手失败」，排查方向会全错。
     *
     * 只在它确实等于 `request.bin` 时才丢：别的调用方若传的是纯参数表，
     * 一个真参数都不该被砍掉。
     */
    const argv = request.argv[0] === request.bin ? request.argv.slice(1) : request.argv;

    // 两条来源都要认：profile 声明走 stdin 的（我们推荐的）从这里拿提示词，
    // 声明成位置参数的从 argv 拿。漏一边就会对着空提示词跑一次会话。
    const prompt = request.stdin ?? argv.join(' ');
    if (prompt.trim() === '') {
      return { ok: false, exitCode: null, output: '', error: '这次执行没有提示词' };
    }

    const resolved = await resolveExecutable(request.bin);
    if (!resolved) {
      // 解析不到就是解析不到：不猜路径、不回退到别的可执行文件
      return {
        ok: false,
        exitCode: null,
        output: '',
        error: `本机解析不到 ACP agent 可执行文件：${request.bin}`,
      };
    }

    const child = spawn(resolved.command, [...resolved.prefixArgs, ...argv], {
      cwd: request.cwd,
      // 三条都是管道：stdin 是协议出口，stdout 是协议入口。
      // stderr 留着是因为 agent 多半把自己的日志写在上面，出错时那是唯一线索。
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });

    /**
     * 登记进进程账本。
     *
     * 不登记的后果是**重启之后这批进程彻底失管**：reap 只认账本里的记录，
     * 账本里没有的孤儿既不会被终止、也不会出现在运维视图里。CLI 那条路一直是
     * 登记的，ACP 这条不能因为「进程是协议层的」就例外——它同样是本机上真实
     * 跑着、会烧 token 的子进程。
     */
    const registry = this.registry;
    const registered =
      registry && child.pid !== undefined
        ? registry
            .register({
              pid: child.pid,
              runId: request.runId,
              nodeId: request.nodeId,
              agentId: request.agentId,
              bin: request.bin,
              startedAt: new Date().toISOString(),
            })
            .catch((error: unknown) => {
              // 登记失败不影响执行：账本是善后手段，不是前提
              this.log.warn('ACP 子进程登记失败', { pid: child.pid, error });
            })
        : Promise.resolve();

    const { promise: exited, resolve: markExited } = deferred();
    let exitCode: number | null = null;
    let spawnFailure: string | undefined;
    let stderrTail = '';

    // 'error' 必须有人听：spawn 失败（ENOENT / EACCES）会在这上面抛，
    // 没人听就是整个进程的未捕获异常。
    child.once('error', (error) => {
      spawnFailure = errorText(error);
      markExited();
    });
    child.once('exit', (code) => {
      exitCode = code;
      markExited();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      // 只留尾巴：够看出崩在哪，又不至于把日志撑爆
      stderrTail = `${stderrTail}${chunk.toString('utf8')}`.slice(-STDERR_TAIL_CHARS);
    });

    const slot: AcpSlot = {
      nodeId: request.nodeId,
      child,
      cancelled: false,
      timedOut: false,
      exited,
    };
    const key = activeKey(request.runId, request.nodeId);
    this.track(key, slot);

    // 本轮的可观测状态。翻译层只负责「这条 update 等于什么事件」，
    // 需要跨 update 累积的东西（正文、用量、权限记录）都在这里。
    const state = {
      sessionId: undefined as string | undefined,
      /** 助手正文。这是 `output` 的唯一来源，也是审查裁决读的那一份。 */
      output: '',
      lastMessageId: undefined as string | undefined,
      usage: undefined as AgentUsage | undefined,
      permission: { count: 0, kinds: [] } as PermissionLedger,
    };

    const emit = (events: AgentEvent[]): void => {
      for (const event of events) {
        const line = toWireLine(event);
        if (line === undefined) {
          continue;
        }
        try {
          onChunk(`${line}\n`);
        } catch (error) {
          // 上层回调抛错不能穿透进协议的消息分发里：那会把一条通知的失败
          // 放大成整个连接的失败。这里记下来继续跑，结算时也已经有正文了。
          this.log.debug('转发 ACP 事件时上层回调抛错', { nodeId: request.nodeId, error });
        }
      }
    };

    /**
     * 累积助手正文。
     *
     * chunk 是**增量**，不是完整消息，所以同一 messageId 内直接相接——按 chunk
     * 加换行会把一句话拆成一行一个词。只有 `messageId` 变了才断行：协议里
     * 「同一个 message 的 chunk 共享同一个 messageId」是唯一的换行依据。
     * 拿不到 messageId 的 agent 就只能接受拼接，这一点无从补救。
     */
    const appendAssistant = (text: string, messageId: string | null | undefined): void => {
      if (text === '') {
        return;
      }
      const boundary = messageId !== undefined && messageId !== null;
      if (boundary && state.output !== '' && messageId !== state.lastMessageId) {
        state.output += '\n';
      }
      if (boundary) {
        state.lastMessageId = messageId;
      }
      state.output += text;
    };

    /**
     * 无人值守的权限应答。
     *
     * 一律拒绝，理由见文件头。`reject_once` / `reject_always` 优先于
     * `cancelled`：前者是协议里明确的「不行」，agent 收到就能继续找别的路；
     * 后者只是「这次没结论」，容易被理解成连接出了问题。
     */
    const answerPermission = (options: PermissionOption[]): RequestPermissionResponse => {
      const reject = options.find(
        (item) => item.kind === 'reject_once' || item.kind === 'reject_always',
      );
      return reject === undefined
        ? { outcome: { outcome: 'cancelled' } }
        : { outcome: { outcome: 'selected', optionId: reject.optionId } };
    };

    const app = createClientApp({ name: CLIENT_INFO.name })
      .onNotification(methods.client.session.update, ({ params }) => {
        // 一条连接上可能挂着多个会话；只认自己这一个
        if (params.sessionId !== state.sessionId) {
          return;
        }
        const update = params.update;

        // 累积先于翻译：翻译是「给看板看的」，output 是「给裁决与失败原因看的」，
        // 两条路各自成立，但都从同一条 update 出发。
        if (update.sessionUpdate === 'agent_message_chunk') {
          appendAssistant(contentText(update.content), update.messageId);
        } else if (update.sessionUpdate === 'usage_update') {
          // `used` 才是消耗；`size`（窗口容量）刻意丢掉，理由见 contextUsage
          state.usage = contextUsage(update.used) ?? state.usage;
        }

        emit(translateUpdate(update));
      })
      .onRequest(methods.client.session.requestPermission, ({ params }) => {
        const kind = params.toolCall.kind ?? 'unknown';
        const label = params.toolCall.title ?? params.toolCall.name ?? params.toolCall.kind ?? '未知操作';
        state.permission.count += 1;
        if (!state.permission.kinds.includes(kind)) {
          state.permission.kinds.push(kind);
        }
        const response = answerPermission(params.options);
        this.log.debug('拒绝了 ACP 权限请求', {
          runId: request.runId,
          nodeId: request.nodeId,
          reason: UNATTENDED_DENY_REASON,
          tool: label,
          kind,
          answered: response.outcome.outcome,
        });
        return response;
      });

    const connection = app.connect(
      ndJsonStream(
        Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
        Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
      ),
    );
    slot.connection = connection;

    // 上层的中止（用户点停止会 abort 整条链路）与取消同义：都是人让它停的。
    const onAbort = (): void => {
      if (slot.cancelled) {
        return;
      }
      slot.cancelled = true;
      void this.interrupt(slot, {
        runId: request.runId,
        notifyAgent: true,
        eofGraceMs: CANCEL_EOF_GRACE_MS,
      });
    };
    request.signal?.addEventListener('abort', onAbort);

    const timer = setTimeout(() => {
      // 超时与取消必须分开：前者是 agent 自己的问题，后者是人的决定，
      // 看板上要说的话完全不同。
      slot.timedOut = true;
      void this.interrupt(slot, {
        runId: request.runId,
        notifyAgent: true,
        eofGraceMs: CANCEL_EOF_GRACE_MS,
      });
    }, request.timeoutMs);

    let stopReason: StopReason | undefined;
    let thrown: string | undefined;

    try {
      const agent = connection.agent;

      // 第一步必须是 initialize：它协商协议版本与双方能力。
      const initialized = await agent.request(methods.agent.initialize, {
        protocolVersion: PROTOCOL_VERSION,
        // 一个可选能力都不声明：我们不代理文件、不提供终端，理由见文件头。
        clientCapabilities: {},
        clientInfo: { ...CLIENT_INFO },
      });
      assertProtocolVersion(initialized, request, this.log);

      // 续跑还是新建，只能在这里定：`request.sessionId` 是编排器算出的唯一权威。
      const opened = await this.openSession(agent, initialized, { request, slot });
      state.sessionId = opened.sessionId;
      slot.sessionId = opened.sessionId;
      // 原生会话 id 立刻进事实：之后即便这一轮失败，看板上也知道它跑在哪。
      // 续跑时这里发出去的必须是**上游传进来的那个 id**，见 openSession 的注释。
      emit([{ kind: 'session', sessionId: opened.sessionId }]);

      const config = await this.applyModel(agent, opened, { request, argv });
      if (request.reasoningEffort) {
        const effort = config?.find((item) => item.category === 'thought_level');
        if (effort?.type === 'select' && effort.currentValue !== request.reasoningEffort) {
          const low = effort.options.flatMap((item) => 'group' in item ? item.options : [item])
            .find((item) => item.value === request.reasoningEffort);
          if (low) {
            await agent.request(methods.agent.session.setConfigOption, {
              sessionId: opened.sessionId, configId: effort.id, value: low.value,
            }).catch((error: unknown) => this.log.debug('ACP 保持客户端推理设置', { runId: request.runId, error }));
          }
        }
      }

      const response = await agent.request(methods.agent.session.prompt, {
        sessionId: opened.sessionId,
        prompt: [{ type: 'text', text: prompt }],
      });
      stopReason = response.stopReason;
    } catch (error) {
      thrown = errorText(error);
    } finally {
      clearTimeout(timer);
      request.signal?.removeEventListener('abort', onAbort);
      this.forget(key, slot);

      // 进程已经退出，账本里的记录就没有保留价值了。
      // 放在 finally 的开头：后面任何一步清理抛错，都不该让这条记录留下成为
      // 下一次启动 reap 眼中的「孤儿」。
      if (registry && child.pid !== undefined) {
        void registered
          .then(() => registry.unregister(child.pid!))
          .catch((error: unknown) => {
            this.log.warn('ACP 子进程注销失败', { pid: child.pid, error });
          });
      }

      // 结算行：只有在真的拿到 PromptResponse 时才发。
      // 没有结算就报 result（还带着用量），等于把一次异常中断写成「这一轮跑完了」。
      if (stopReason !== undefined) {
        emit([
          {
            kind: 'result',
            text: state.output,
            ...(state.usage === undefined ? {} : { usage: state.usage }),
          },
        ]);
      }

      // 关连接与收进程是两件事：先断开（agent 侧的 quiescent teardown 由
      // 客户端断开触发），再收进程。这里的收尾**不发协议取消**——话说完了就挂断，
      // 取消通知只在「要它中途停下」时才该出现（见 interrupt 的注释）。
      // 清理失败不能改写结果：那是清理问题，不是执行问题。
      try {
        connection.close();
      } catch (error) {
        this.log.debug('关闭 ACP 连接时出错', { runId: request.runId, error });
      }
      await this.interrupt(slot, {
        runId: request.runId,
        notifyAgent: false,
        eofGraceMs: SHUTDOWN_EOF_GRACE_MS,
      });
    }

    const output = state.output;
    const detail = this.permissionDetail(state.permission);
    // agent 的 stderr 往往是一大片进度行，整段塞进失败原因只会让人读不到重点。
    // 这里只带最后 ERROR_TAIL_CHARS 个字符——够看出崩在哪，又不至于淹掉主句。
    const stderr = stderrTail.trim().slice(-ERROR_TAIL_CHARS);
    const stderrDetail = stderr === '' ? undefined : `agent stderr 末尾：${stderr}`;

    // 结算优先级：超时 → 取消 → 抛错 → stopReason。
    // 顺序是刻意的：终止本身也会让挂起的请求抛错，把「人让它停的」记成执行失败，
    // 会把一次可恢复的中断写成需要人介入的故障。
    if (slot.timedOut) {
      return { ok: false, exitCode: null, output, timedOut: true, error: 'timeout' };
    }
    if (slot.cancelled) {
      return { ok: false, exitCode: null, output, cancelled: true, error: 'cancelled' };
    }

    if (thrown !== undefined) {
      return {
        ok: false,
        exitCode,
        output,
        error: withDetail(
          // spawn 失败时协议请求的抛错只是后果，真正的原因在这一句
          spawnFailure === undefined ? thrown : `${spawnFailure}（协议请求因此中断：${thrown}）`,
          [stderrDetail, detail],
        ),
      };
    }

    if (stopReason === undefined) {
      // 既没抛错也没拿到 stopReason：协议层面说不通，绝不假装成功
      return {
        ok: false,
        exitCode,
        output,
        error: withDetail('ACP agent 结束了这一轮但没有给出 stopReason', [
          stderrDetail,
          detail,
        ]),
      };
    }

    if (stopReason === 'end_turn') {
      // 成功时 exitCode 一律报 0：进程是我们自己收掉的，它的退出码
      // （往往是终止信号导致的 null 或非零）说明不了这一轮干得好不好。
      return { ok: true, exitCode: 0, output };
    }

    return {
      ok: false,
      exitCode,
      output,
      error: withDetail(stopReasonFailure(stopReason), [detail]),
    };
  }

  /**
   * 决定这一轮跑在哪个会话上：能续就续，续不上就新建。
   *
   * 判据只有 `request.sessionId` 有没有值（它是 core 的 `resolveSession` 算出来的，
   * `hooked` 派生型平台靠上一轮从事件流里捕获的原生 id 填它）。除此之外还要看
   * 一件事：**agent 有没有广播 `sessionCapabilities.resume`**。没广播就发
   * `session/resume`，agent 会按「未知方法」把整轮打回来——那不是续跑失败，
   * 是我们违反了自己的能力协商。
   *
   * 退回新建一律不判节点失败，理由见文件头「续跑」那段：会话被清理、agent
   * 换了持久化目录，都是部署现场的正常变化，让节点整轮失败等于把「上下文丢了」
   * 升级成「活干不成」。
   */
  private async openSession(
    agent: ClientContext,
    initialized: InitializeResponse,
    input: { request: AgentRunRequest; slot: AcpSlot },
  ): Promise<OpenedSession> {
    const { request, slot } = input;
    const plan = planSessionOpening(request.sessionId, initialized.agentCapabilities);
    if (plan.opening === 'new') {
      if (plan.lostResume) {
        // 用 warn 而不是 debug 的理由见文件头「续跑」那段：core 已经落了
        // `node.resumed_session`，退回新建之后那条事件就是假话。
        this.log.warn(
          'ACP 会话续跑不可用，退回新建会话（看板上的 node.resumed_session 因此与事实不符）',
          {
            runId: request.runId,
            nodeId: request.nodeId,
            sessionId: request.sessionId,
            reason: plan.reason,
            agent: initialized.agentInfo?.name,
          },
        );
      }
      return this.createSession(agent, request);
    }
    const wanted = plan.sessionId;

    try {
      const resumed = await agent.request(methods.agent.session.resume, {
        sessionId: wanted,
        cwd: request.cwd,
        // 与 session/new 保持同一份声明：会话要能看到的东西只有节点工作区。
        mcpServers: [],
      });
      this.log.debug('ACP 会话续跑成功', {
        runId: request.runId,
        nodeId: request.nodeId,
        sessionId: wanted,
      });
      // 响应里**没有** sessionId（`ResumeSessionResponse` 只有 modes / configOptions）。
      // 续的就是请求里那个 id，回传也必须用它：这里若拿新建响应的 id 顶上，
      // 等于把新会话的 id 当成旧的上报，`node.nativeSessionId` 会指向一个
      // 与上下文无关的会话。
      return { sessionId: wanted, configOptions: resumed.configOptions };
    } catch (error) {
      // 取消/超时会把进程收掉，续跑请求的失败只是它的后果，不该记成「续跑失败」。
      // 原样抛出：结算按 timedOut / cancelled 的优先级归类（见 run 的尾段）。
      if (slot.cancelled || slot.timedOut) {
        throw error;
      }
      this.log.warn(
        'ACP 会话续跑失败，退回新建会话（看板上的 node.resumed_session 因此与事实不符）',
        {
          runId: request.runId,
          nodeId: request.nodeId,
          sessionId: wanted,
          error: errorText(error),
        },
      );
      return this.createSession(agent, request);
    }
  }

  /** 新建一个会话。就是续跑不成时的退路，也是没有 id 时的正常路径。 */
  private async createSession(
    agent: ClientContext,
    request: AgentRunRequest,
  ): Promise<OpenedSession> {
    const created = await agent.request(methods.agent.session.new, {
      cwd: request.cwd,
      // 不挂 MCP：节点工作区自足，挂什么是 profile 的事，这里没有那个通道，
      // 也不偷偷默认一组（默认 MCP 等于替调用方决定它能看见什么）。
      mcpServers: [],
    });
    return { sessionId: created.sessionId, configOptions: created.configOptions };
  }

  /**
   * 按 argv 里点名的模型改会话选择。
   *
   * 产品规格和会议显式传入模型时，需得到 ACP 会话确认。旧的 argv 选择保持兼容。
   *
   * 注意 argv 同时是**启动命令**：往 ACP profile 的 `modelArgs` 里写
   * `--model {model}` 会把一个 agent 未必认识的参数塞进它的命令行。真要固定
   * 模型，靠的是这条 `set_config_option` 通路（agent 暴露了 model 选择项时才生效），
   * 而不是命令行。
   */
  private async applyModel(
    agent: ClientContext,
    opened: OpenedSession,
    input: { request: AgentRunRequest; argv: string[] },
  ): Promise<OpenedSession['configOptions']> {
    const { request } = input;
    const wanted = request.model ?? argValue(input.argv, '--model');
    if (!wanted) return opened.configOptions;

    const option = opened.configOptions?.find((item) => item.category === 'model' || item.id === 'model');
    if (option?.type !== 'select') {
      if (request.model) throw new Error('该 ACP 客户端未提供会话模型选择，请使用客户端默认模型。');
      return opened.configOptions;
    }

    const choices = option.options.flatMap((item) => 'group' in item ? item.options : [item]);
    const matchesName = (name: string) => name.toLowerCase() === wanted.toLowerCase();
    const selected = choices.find((item) => item.value === wanted)
      ?? choices.find((item) => matchesName(item.name) && item.value === option.currentValue)
      ?? choices.find((item) => matchesName(item.name));
    if (!selected) {
      if (request.model) {
        throw new Error('客户端未提供模型 ' + wanted + '。可选模型：' + choices.map((item) => item.name).join('、'));
      }
      return opened.configOptions;
    }
    if (selected.value === option.currentValue) return opened.configOptions;

    try {
      const changed = await agent.request(methods.agent.session.setConfigOption, {
        sessionId: opened.sessionId,
        configId: option.id,
        value: selected.value,
      });
      const resulting = changed.configOptions.find((item) => item.id === option.id);
      if (request.model && (resulting?.type !== 'select' || resulting.currentValue !== selected.value)) {
        throw new Error('客户端未确认该模型已生效。');
      }
      return changed.configOptions;
    } catch (error) {
      if (request.model) throw error;
      this.log.warn('ACP 设置模型失败，继续用 agent 当前选择', {
        runId: request.runId, nodeId: request.nodeId, requested: wanted, error,
      });
      return opened.configOptions;
    }
  }

  /** 把权限拒绝记录拼成一句人话；一次都没拒过就返回 undefined。 */
  private permissionDetail(ledger: PermissionLedger): string | undefined {
    if (ledger.count === 0) {
      return undefined;
    }
    const kinds = ledger.kinds.length === 0 ? '' : `：${ledger.kinds.join('、')}`;
    return `${UNATTENDED_DENY_REASON}，共拒绝 ${ledger.count} 次权限请求${kinds}`;
  }

  private track(key: string, slot: AcpSlot): void {
    const bucket = this.active.get(key);
    if (bucket) {
      bucket.push(slot);
      return;
    }
    this.active.set(key, [slot]);
  }

  private forget(key: string, slot: AcpSlot): void {
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

/* ------------------------------------------------------------------ *
 * 协议细节
 * ------------------------------------------------------------------ */

/**
 * 校验 agent 回的协议版本。
 *
 * ACP 的破坏性变更只升这个号，其余扩展都走 capabilities。所以版本对不上就是
 * 真的对不上——硬跑下去只会在更深处炸出更难读的错误（字段缺失、方法不存在）。
 * 报错里带上双方版本，人能立刻判断是客户端旧了还是 agent 新了。
 */
function assertProtocolVersion(
  initialized: InitializeResponse,
  request: AgentRunRequest,
  log: LogSink,
): void {
  const reported = initialized.protocolVersion;
  if (reported === PROTOCOL_VERSION) {
    log.debug('ACP 握手完成', {
      runId: request.runId,
      nodeId: request.nodeId,
      agent: initialized.agentInfo?.name,
      version: initialized.agentInfo?.version,
      // 能力只落日志：我们不改行为，它是排查「为什么 agent 不发某个 update」的唯一依据
      capabilities: initialized.agentCapabilities,
    });
    return;
  }
  throw new Error(
    `ACP 协议版本不兼容：agent 报 ${String(reported)}，本客户端只说 ${String(PROTOCOL_VERSION)}`,
  );
}

/** `StopReason` → 一句人能读的失败原因。成功（end_turn）不走这里。 */
function stopReasonFailure(reason: StopReason): string {
  switch (reason) {
    case 'max_tokens':
      return 'agent 的回答被 max_tokens 截断，交付不完整';
    case 'max_turn_requests':
      return 'agent 用光了轮次预算（max_turn_requests），任务没有跑完';
    case 'refusal':
      return 'agent 拒绝执行这次请求（refusal）';
    case 'cancelled':
      // agent 自己取消了这一轮，而发起取消的不是我们（我们的取消在上面就返回了）
      return 'agent 自己取消了这一轮（cancelled），而编排器并没有要求停止';
    case 'end_turn':
      // 调用方已经拦住了这一支；留在这里是为了让这个 switch 对联合类型穷尽
      return 'agent 正常结束（end_turn）';
    default:
      // 联合是封闭的，但未来 SDK 可能加变体：未知终止原因一律当失败，
      // 绝不把一次不明不白的收场记成完成。
      return `agent 以未知原因结束（stopReason=${String(reason)}）`;
  }
}

export async function listAcpModels(profile: AgentProfile, cwd: string): Promise<ModelDirectory> {
  const executable = await resolveExecutable(profile.launch.bin);
  if (!executable) throw new Error('找不到 ACP 客户端。');
  const child = spawn(executable.command, [...executable.prefixArgs, ...profile.launch.args], {
    cwd, windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'],
  });
  const closed = new AbortController();
  child.on('error', () => closed.abort());
  child.on('exit', () => closed.abort());
  const signal = AbortSignal.any([closed.signal, AbortSignal.timeout(15_000)]);
  const connection = createClientApp({ name: CLIENT_INFO.name }).connect(ndJsonStream(
    Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
    Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
  ));
  const stop = () => connection.close();
  signal.addEventListener('abort', stop, { once: true });
  try {
    const agent = connection.agent;
    await agent.request(methods.agent.initialize, {
      protocolVersion: PROTOCOL_VERSION, clientCapabilities: {}, clientInfo: { ...CLIENT_INFO },
    });
    const opened = await agent.request(methods.agent.session.new, { cwd, mcpServers: [] });
    const option = opened.configOptions?.find((item) => item.category === 'model' || item.id === 'model');
    const models = option?.type === 'select' ? option.options.flatMap((item) => 'group' in item
      ? item.options.map((model) => ({ id: model.value, name: model.name, group: item.name }))
      : [{ id: item.value, name: item.name }]) : [];
    return {
      models, defaultModel: option?.type === 'select' ? option.currentValue : undefined,
      source: 'ACP 会话配置', checkedAt: new Date().toISOString(),
      message: models.length ? undefined : '客户端没有发布可选模型。可以沿用客户端默认配置。',
    };
  } finally {
    signal.removeEventListener('abort', stop);
    connection.close();
    child.stdin.end();
    if (child.exitCode === null && child.signalCode === null) await killProcessTree(child.pid, { force: true, log: silentLog });
  }
}

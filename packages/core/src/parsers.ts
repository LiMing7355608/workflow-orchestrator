/**
 * Agent 输出解析器：把各平台 CLI 的输出翻译成统一的结构化事件。
 *
 * 为什么需要它：Agent 的 stdout 本来是给人看的文本，直接灌进事件流等于把
 * 「Agent 到底干了什么」压平成一大坨字符串——看板分不清哪句是回答、哪行是
 * 工具调用、token 花了多少、有没有原生会话 id。解析器只做一件事：把一行行
 * 原始输出翻译成带类型的 `AgentEvent`，至于怎么变成事件事实由编排器决定。
 *
 * 铁律：兼容而非严格。
 * 官方 CLI 的事件结构随版本漂移（字段改名、新增事件类型、把结构化输出降级成
 * 纯文本），任何一处不匹配都只能退化成一条原文 `text` 事件，绝不能抛异常、
 * 也不能静默丢内容。解析器是观测管道：它唯一允许的失败模式是「少解析出结构，
 * 多保留原文」。丢结构只是少一个筛选项，丢内容就是审计断层。
 *
 * 本文件不引入任何 Node 内置模块：前端要能直接打包同一份实现。
 */

import type { AgentParserId } from './agents.js';

/**
 * 事件的语义分级。
 *
 * `thinking` 与 `status` 是后补的两类，补它们的原因是缺了它们就只能退化：
 * 模型的内部独白会和正式回答混成一片正文，而 `{"type":"status","phase":...}`
 * 这种纯进度信号会带着一坨 JSON 直接铺进时间线。语义上它们完全不同——
 * 一个是「它在想」（弱化的内容），一个是「它进行到哪了」（不是内容），
 * 所以必须是两个独立的 kind，而不是塞进 text 再让前端去猜。
 */
export type AgentEventKind =
  | 'text'
  | 'thinking'
  | 'status'
  | 'tool'
  | 'result'
  | 'usage'
  | 'session'
  | 'error';

export interface AgentUsage {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
}

export interface AgentEvent {
  kind: AgentEventKind;
  /** text / thinking / result / error 的正文；tool 事件里存入参摘要或工具描述 */
  text?: string;
  /** tool 事件的工具名 */
  toolName?: string;
  /**
   * status 事件的阶段（turn_start / step_start / step_end …）。
   *
   * 为什么阶段要单独成字段而不是拼进 text：编排层要按阶段判断该不该落事件
   * （只有 step_end 带用量才值得记），靠文案匹配会在 CLI 换个措辞时静默失效。
   */
  phase?: string;
  usage?: AgentUsage;
  /** session 事件的原生会话 id */
  sessionId?: string;
}

export interface AgentOutputParser {
  /** 喂入一段原始输出，返回本次新解析出的事件 */
  push(chunk: string): AgentEvent[];
  /** 输入结束时调用，冲掉缓冲区里不完整的行 */
  finish(): AgentEvent[];
}

/* ------------------------------------------------------------------ *
 * 取值工具：所有外部数据都是 unknown，宁可返回 undefined 也不猜
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

function readNumber(source: unknown, ...keys: string[]): number | undefined {
  const record = asRecord(source);
  if (!record) {
    return undefined;
  }
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'number' && Number.isFinite(value)) {
      return value;
    }
  }
  return undefined;
}

/** usage 在各家 CLI 里叫法都不一样，这里把常见别名一次收干净。 */
function normalizeUsage(record: JsonRecord): AgentUsage | undefined {
  const prompt = readNumber(
    record,
    'promptTokens',
    'prompt_tokens',
    'input_tokens',
    'inputTokens',
    'input',
  );
  const completion = readNumber(
    record,
    'completionTokens',
    'completion_tokens',
    'output_tokens',
    'outputTokens',
    'output',
  );
  const total = readNumber(record, 'totalTokens', 'total_tokens', 'total');

  if (prompt === undefined && completion === undefined && total === undefined) {
    return undefined;
  }

  return {
    promptTokens: prompt,
    completionTokens: completion,
    totalTokens:
      total ?? (prompt !== undefined && completion !== undefined ? prompt + completion : undefined),
  };
}

const USAGE_CONTAINER_KEYS = ['usage', 'token_usage', 'usage_metadata', 'tokens'] as const;

/**
 * 从若干候选对象里挖 usage。
 *
 * 候选既可能是事件本身（codex 的 turn.completed 把 usage 放在顶层），
 * 也可能是 message / part 这种子对象，因此两个方向都试一遍。
 */
function extractUsage(...sources: unknown[]): AgentUsage | undefined {
  for (const source of sources) {
    const record = asRecord(source);
    if (!record) {
      continue;
    }
    const own = normalizeUsage(record);
    if (own) {
      return own;
    }
    for (const key of USAGE_CONTAINER_KEYS) {
      const nested = asRecord(record[key]);
      if (!nested) {
        continue;
      }
      const usage = normalizeUsage(nested);
      if (usage) {
        return usage;
      }
    }
  }
  return undefined;
}

/** 会话 id 同样有多个别名。刻意不含裸 `id`：事件自身的 id 常是序号，取错了会污染事实。 */
function pickSessionId(...sources: unknown[]): string | undefined {
  for (const source of sources) {
    const value = readString(
      source,
      'session_id',
      'sessionId',
      'sessionID',
      'thread_id',
      'threadId',
      'conversation_id',
      'conversationId',
    );
    if (value) {
      return value;
    }
  }
  return undefined;
}

/** content 既可能是字符串，也可能是内容块数组。 */
function flattenText(value: unknown): string | undefined {
  if (typeof value === 'string') {
    return value.trim() ? value : undefined;
  }
  if (Array.isArray(value)) {
    const parts = value
      .map((item) => (typeof item === 'string' ? item : readString(item, 'text', 'content')))
      .filter((item): item is string => Boolean(item && item.trim()));
    return parts.length > 0 ? parts.join('\n') : undefined;
  }
  return undefined;
}

function tryParseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/** 解析一行 NDJSON。非对象（数字、数组、纯文本）一律视为「没认出」。 */
function parseLineObject(line: string): JsonRecord | undefined {
  return asRecord(tryParseJson(line.trim()));
}

function errorText(record: JsonRecord | undefined, fallback: string): string {
  if (!record) {
    return fallback;
  }
  const direct = readString(record, 'error', 'message', 'text', 'reason', 'detail');
  if (direct) {
    return direct;
  }
  // 多数平台的 error 是嵌套对象，取里面那句人能读的话
  return readString(asRecord(record.error), 'message', 'text', 'detail') ?? fallback;
}

/** 认不出来的内容一律原样保留。丢内容比丢结构严重得多。 */
function textEvent(text: string): AgentEvent {
  return { kind: 'text', text };
}

/* ------------------------------------------------------------------ *
 * 工具入参摘要：只留「这次调用冲谁去的」那一句
 * ------------------------------------------------------------------ */

/**
 * 摘要里优先取用的入参字段。
 *
 * 刻意不含 `name`：它和工具名重复，摘要变成「name=read_file」等于什么都没说。
 * 顺序按信息量排：命令 > 路径 > 模式 > 查询 > 描述。
 */
const SUMMARY_INPUT_KEYS = [
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

/** 摘要长度上限：时间线上这一截是要用来扫一眼的，不是用来读的。 */
const SUMMARY_MAX_CHARS = 80;

/** 摘要最多拼几个字段。多于两个就开始像 JSON 了。 */
const SUMMARY_MAX_PARTS = 2;

function truncateSummary(value: string): string {
  return value.length > SUMMARY_MAX_CHARS ? `${value.slice(0, SUMMARY_MAX_CHARS)}…` : value;
}

/** 多行入参（补丁、prompt）只取第一句有内容的话，剩下的交给原文。 */
function firstMeaningfulLine(value: string): string {
  const line = value.split('\n').find((item) => item.trim() !== '') ?? '';
  return line.trim();
}

/**
 * 把工具入参压成一行 `key=value · key=value` 的短摘要。
 *
 * 为什么不能整段贴 JSON：一次 apply_patch 或 Read 的入参动辄上万字符，
 * 铺进时间线等于把「它调了什么」淹成一片括号，而人真正想知道的只是
 * 「它在哪个文件、跑什么命令」。拼不出任何字段就返回 undefined，
 * 上层据此退化成只有工具名的单行，而不是给一个空括号。
 */
function summarizeToolInput(input: unknown): string | undefined {
  if (typeof input === 'string') {
    const line = firstMeaningfulLine(input);
    return line ? truncateSummary(line) : undefined;
  }

  const record = asRecord(input);
  if (!record) {
    return undefined;
  }

  const parts: string[] = [];
  for (const key of SUMMARY_INPUT_KEYS) {
    const value = record[key];
    if (typeof value !== 'string' || value.trim() === '') {
      continue;
    }
    parts.push(`${key}=${firstMeaningfulLine(value)}`);
    if (parts.length >= SUMMARY_MAX_PARTS) {
      break;
    }
  }

  return parts.length > 0 ? truncateSummary(parts.join(' · ')) : undefined;
}

/** 入参可能包在若干别名容器里，也可能直接摊在事件顶层。两处都找。 */
const SUMMARY_INPUT_CONTAINERS = [
  'input',
  'args',
  'arguments',
  'params',
  'parameters',
  'tool_input',
] as const;

function readToolSummary(record: JsonRecord): string | undefined {
  for (const key of SUMMARY_INPUT_CONTAINERS) {
    const nested = summarizeToolInput(record[key]);
    if (nested) {
      return nested;
    }
  }
  return summarizeToolInput(record);
}

/* ------------------------------------------------------------------ *
 * 进度信号：只有结算那一拍才带用量
 * ------------------------------------------------------------------ */

/**
 * 结算阶段的别名。
 *
 * 用量只在「这一段/这一轮结束」时才有意义：`turn_start` 上即便带着
 * token 计数，它也是到目前为止的累计值，落一条只会在成本账上重复计入。
 * 各平台叫法不同，这里一次收干净。
 */
const SETTLEMENT_PHASES = new Set(['step_end', 'turn_end', 'step_finish', 'complete', 'completed']);

function statusEvent(phase: string | undefined, record: JsonRecord): AgentEvent {
  return {
    kind: 'status',
    phase: phase ?? 'status',
    text: readString(record, 'text', 'message', 'detail'),
    usage: phase && SETTLEMENT_PHASES.has(phase) ? extractUsage(record) : undefined,
  };
}

/* ------------------------------------------------------------------ *
 * 行缓冲：NDJSON 的 chunk 边界必然切在行中间
 * ------------------------------------------------------------------ */

function createLineParser(handle: (line: string) => AgentEvent[]): AgentOutputParser {
  let buffer = '';

  const consume = (line: string, out: AgentEvent[]): void => {
    // 只剥行尾 CR（Windows 换行）；行内空白是输出的一部分，不能替 Agent 清理
    const clean = line.endsWith('\r') ? line.slice(0, -1) : line;
    if (!clean.trim()) {
      // 空行不含信息，不占事件位，否则一个空行刷屏式的 CLI 会把看板淹了
      return;
    }
    out.push(...handle(clean));
  };

  return {
    push(chunk: string): AgentEvent[] {
      const events: AgentEvent[] = [];
      buffer += chunk;
      let index = buffer.indexOf('\n');
      while (index !== -1) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        consume(line, events);
        index = buffer.indexOf('\n');
      }
      return events;
    },
    finish(): AgentEvent[] {
      const events: AgentEvent[] = [];
      // 最后一行常常没有换行符：残留 buffer 就是它，继续丢掉等于吞掉尾行
      const rest = buffer;
      buffer = '';
      consume(rest, events);
      return events;
    },
  };
}

/* ------------------------------------------------------------------ *
 * claude-stream-json：Claude Code / Qoder 的 --output-format stream-json
 * ------------------------------------------------------------------ */

function handleClaudeLine(line: string): AgentEvent[] {
  const record = parseLineObject(line);
  if (!record) {
    return [textEvent(line)];
  }

  const type = readString(record, 'type');
  const sessionId = pickSessionId(record);

  if (type === 'system') {
    // init 行只有会话/模型等元信息，本身没有对话内容。
    // 有 session id 就落一条会话事件，没有就原样保留，免得吞掉可能是正文的输出。
    return sessionId ? [{ kind: 'session', sessionId }] : [textEvent(line)];
  }

  if (type === 'assistant' || type === 'user') {
    const message = asRecord(record.message);
    const events: AgentEvent[] = [];

    const blocks = Array.isArray(message?.content) ? message.content : [];
    for (const block of blocks) {
      const item = asRecord(block);
      if (!item) {
        continue;
      }
      const blockType = readString(item, 'type');
      if (blockType === 'text') {
        const value = readString(item, 'text');
        if (value) {
          events.push({ kind: 'text', text: value });
        }
        continue;
      }
      if (blockType === 'tool_use') {
        // 工具入参不进事件流：一次 Read 就能塞进上万字符，会把其它事件全部淹掉。
        // 只记「调用了哪个工具」，原文仍在 stdout 汇总结果里。
        events.push({ kind: 'tool', toolName: readString(item, 'name') ?? 'tool' });
        continue;
      }
      if (blockType === 'thinking' || blockType === 'redacted_thinking' || blockType === 'reasoning') {
        // 思考块是模型的内部独白，不是回答：映射成 thinking 让渲染层降级到
        // muted + 折叠，否则它会和正式回答在视觉上完全平等。
        // redacted_thinking 只有签名没有正文，text 缺省——交给编排层当空内容丢掉。
        events.push({
          kind: 'thinking',
          text: readString(item, 'thinking', 'text', 'reasoning'),
        });
        continue;
      }
      if (blockType === 'tool_result') {
        // 工具结果回灌是显式内容块，保留下来
        const value = flattenText(item.content) ?? readString(item, 'text');
        if (value) {
          events.push({ kind: 'text', text: value });
        }
      }
    }

    const plain =
      typeof message?.content === 'string'
        ? message.content
        : readString(record, 'text', 'result');
    if (plain && plain.trim()) {
      events.push({ kind: 'text', text: plain });
    }

    const usage = extractUsage(message, record);
    if (usage) {
      events.push({ kind: 'usage', usage });
    }

    if (events.length === 0) {
      return [textEvent(line)];
    }
    // 每条消息都带 session id，这里一律补上，去重交给编排器
    if (sessionId) {
      events.push({ kind: 'session', sessionId });
    }
    return events;
  }

  if (type === 'result') {
    const events: AgentEvent[] = [];
    const value = readString(record, 'result', 'text', 'output');
    const subtype = readString(record, 'subtype') ?? '';
    const isError = record.is_error === true || subtype.startsWith('error');

    if (isError) {
      events.push({ kind: 'error', text: value ?? line });
    } else if (value) {
      events.push({ kind: 'result', text: value });
    }

    const usage = extractUsage(record);
    if (usage) {
      events.push({ kind: 'usage', usage });
    }
    if (sessionId) {
      events.push({ kind: 'session', sessionId });
    }
    return events.length > 0 ? events : [textEvent(line)];
  }

  if (type === 'error') {
    return [{ kind: 'error', text: errorText(record, line) }];
  }

  if (type === 'status') {
    // 进度信号不是内容：解析成 status，落不落事件由编排层按「有没有用量」决定
    return [statusEvent(readString(record, 'phase', 'subtype'), record)];
  }

  return [textEvent(line)];
}

/* ------------------------------------------------------------------ *
 * codex-json：codex exec --json
 * ------------------------------------------------------------------ */

function handleCodexLine(line: string): AgentEvent[] {
  const record = parseLineObject(line);
  if (!record) {
    return [textEvent(line)];
  }

  // 新版把类型放在扁平 `type` 上，老版塞在 `msg.type` 里。两套都认：
  // 一次 CLI 升级不该让整条链路退化成纯文本。
  const msg = asRecord(record.msg);
  const type = readString(msg, 'type') ?? readString(record, 'type');
  const sessionId = pickSessionId(record, msg);

  switch (type) {
    case 'thread.started':
    case 'session_configured':
      return sessionId ? [{ kind: 'session', sessionId }] : [textEvent(line)];

    case 'turn.started':
    case 'turn_context':
      // 只有元信息，没有可展示内容；产出事件只会制造噪声
      return [];

    case 'item.started': {
      const item = asRecord(record.item);
      if (readString(item, 'type') === 'command_execution') {
        return [{ kind: 'tool', toolName: readString(item, 'command') ?? 'command_execution' }];
      }
      return [];
    }

    case 'item.completed':
    case 'item.updated': {
      const item = asRecord(record.item) ?? record;
      const itemType = readString(item, 'type') ?? '';
      const value =
        readString(item, 'text', 'message', 'content', 'aggregated_output') ??
        flattenText(item.content);

      if (itemType === 'agent_message') {
        return value ? [{ kind: 'text', text: value }] : [textEvent(line)];
      }
      if (itemType === 'reasoning' || itemType === 'reasoning_summary') {
        // codex 的推理摘要曾经混在 agent_message 里一起当正文：它是模型在
        // 自言自语，不是交付给用户的话，必须降一级渲染
        return [{ kind: 'thinking', text: value }];
      }
      if (itemType === 'command_execution') {
        return [
          {
            kind: 'tool',
            toolName: readString(item, 'command') ?? 'command_execution',
            text: value,
          },
        ];
      }
      if (itemType === 'file_change' || itemType === 'patch' || itemType === 'mcp_tool_call') {
        return [{ kind: 'tool', toolName: readString(item, 'name') ?? itemType, text: value }];
      }
      if (itemType === 'error') {
        return [{ kind: 'error', text: errorText(item, line) }];
      }
      // 未知 item 类型：有正文当正文，没有就整行原文
      return value ? [{ kind: 'text', text: value }] : [textEvent(line)];
    }

    case 'turn.completed': {
      const events: AgentEvent[] = [];
      const usage = extractUsage(record);
      if (usage) {
        events.push({ kind: 'usage', usage });
      }
      const value = readString(record, 'last_agent_message', 'text', 'message');
      if (value) {
        events.push({ kind: 'result', text: value });
      }
      return events;
    }

    case 'token_count': {
      const usage = extractUsage(msg, record);
      return usage ? [{ kind: 'usage', usage }] : [];
    }

    // ---- 老格式（msg.type） ----
    case 'agent_message': {
      const value = readString(msg, 'message', 'text') ?? readString(record, 'text', 'message');
      return value ? [{ kind: 'text', text: value }] : [textEvent(line)];
    }

    case 'agent_reasoning': {
      // 老格式的推理同样只是内部独白。空文本也认——它是 thinking 事件，
      // 编排层会按「有没有正文」决定丢不丢，退化成正文明明更糟
      const value = readString(msg, 'message', 'text') ?? readString(record, 'text', 'message');
      return [{ kind: 'thinking', text: value }];
    }

    case 'task_complete': {
      const events: AgentEvent[] = [];
      const value =
        readString(msg, 'last_agent_message', 'message') ?? readString(record, 'text', 'message');
      if (value) {
        events.push({ kind: 'result', text: value });
      }
      const usage = extractUsage(msg, record);
      if (usage) {
        events.push({ kind: 'usage', usage });
      }
      return events.length > 0 ? events : [textEvent(line)];
    }

    case 'turn.failed':
    case 'error':
      return [{ kind: 'error', text: errorText(record, line) }];

    default:
      return [textEvent(line)];
  }
}

/* ------------------------------------------------------------------ *
 * opencode-json：opencode run --format json
 * ------------------------------------------------------------------ */

function handleOpencodeLine(line: string): AgentEvent[] {
  const record = parseLineObject(line);
  if (!record) {
    return [textEvent(line)];
  }

  const type = readString(record, 'type');
  const part = asRecord(record.part);
  const sessionId = pickSessionId(record, part);

  switch (type) {
    case 'step_start':
      return sessionId ? [{ kind: 'session', sessionId }] : [];

    case 'text': {
      const value = readString(part, 'text') ?? readString(record, 'text');
      if (!value) {
        return [textEvent(line)];
      }
      // opencode 把推理也塞在 text 事件里，只靠 part.type 区分。不认这一层
      // 就会把模型的自我推演当成回答铺进时间线
      const reasoning =
        readString(part, 'type') === 'reasoning' || readString(record, 'subtype') === 'reasoning';
      return [{ kind: reasoning ? 'thinking' : 'text', text: value }];
    }

    case 'reasoning': {
      const value = readString(part, 'text', 'reasoning') ?? readString(record, 'text');
      return [{ kind: 'thinking', text: value }];
    }

    case 'tool_use': {
      const toolName =
        readString(part, 'tool', 'name') ?? readString(record, 'tool', 'name') ?? 'tool';
      // state.output 是工具真实返回（可能整份文件），不展开；
      // state.title 只有一句话，留着帮助看懂这次调用在干什么
      const title = readString(asRecord(part?.state), 'title');
      return [{ kind: 'tool', toolName, text: title }];
    }

    case 'step_finish': {
      const events: AgentEvent[] = [];
      const usage = extractUsage(part, record);
      if (usage) {
        events.push({ kind: 'usage', usage });
      }
      if (readString(part, 'reason') === 'error') {
        events.push({ kind: 'error', text: errorText(record, line) });
      }
      return events;
    }

    case 'error':
      return [{ kind: 'error', text: errorText(part ?? record, line) }];

    default:
      return [textEvent(line)];
  }
}

/* ------------------------------------------------------------------ *
 * dsh-json：DeepSeek Harness headless --json（自有格式）
 * ------------------------------------------------------------------ */

function handleDshLine(line: string): AgentEvent[] {
  const record = parseLineObject(line);
  if (!record) {
    return [textEvent(line)];
  }

  const type = readString(record, 'type');
  const sessionId = pickSessionId(record);

  switch (type) {
    case 'session':
      return sessionId ? [{ kind: 'session', sessionId }] : [textEvent(line)];

    case 'text': {
      const value = readString(record, 'text', 'content', 'delta');
      return value ? [{ kind: 'text', text: value }] : [textEvent(line)];
    }

    case 'tool_call':
      // 入参不进事件流，但摘要必须进：只有工具名的话，「它到底对谁动手」无从知晓。
      // 摘要由 summarizeToolInput 保证是一行短文本，不会把原始 JSON 带出来
      return [
        {
          kind: 'tool',
          toolName: readString(record, 'name', 'tool', 'toolName') ?? 'tool',
          text: readToolSummary(record),
        },
      ];

    case 'thinking':
    case 'reasoning': {
      // 空文本的 thinking 是真实存在的（{"type":"thinking","text":""}）。
      // 这里照实给出 thinking 事件：它确实是模型说的一句话，只是没有内容，
      // 丢不丢由编排层按「有没有正文」判定——解析层不替编排层做回收决策
      return [
        {
          kind: 'thinking',
          text: readString(record, 'text', 'thinking', 'content', 'delta'),
        },
      ];
    }

    case 'status':
    case 'step_start':
    case 'step_end':
    case 'turn_start':
    case 'turn_end': {
      // 进度信号不是内容。它一旦退化成 text，时间线上就多出一整行
      // `{"type":"status","phase":"turn_start","turn":1}`。
      // 用量的落库留到编排层：只有 step_end 那一拍真带 usage
      const phase =
        type === 'status'
          ? readString(record, 'phase', 'stage', 'subtype')
          : type;
      return [statusEvent(phase, record)];
    }

    case 'tool_result': {
      // 显式的结果事件：正文保留，没有正文就退化成一条工具事件
      const value = readString(record, 'output', 'text', 'result', 'content');
      if (value) {
        return [{ kind: 'text', text: value }];
      }
      const toolName = readString(record, 'name', 'tool', 'toolName');
      return toolName ? [{ kind: 'tool', toolName }] : [textEvent(line)];
    }

    case 'final': {
      const events: AgentEvent[] = [];
      const value = readString(record, 'text', 'result', 'message', 'content', 'output');
      if (value) {
        events.push({ kind: 'result', text: value });
      }
      const usage = extractUsage(record);
      if (usage) {
        events.push({ kind: 'usage', usage });
      }
      if (sessionId) {
        events.push({ kind: 'session', sessionId });
      }
      return events.length > 0 ? events : [textEvent(line)];
    }

    case 'error':
      return [{ kind: 'error', text: errorText(record, line) }];

    default:
      return [textEvent(line)];
  }
}

/* ------------------------------------------------------------------ *
 * json-result：整段输出是一个 JSON 文档（codebuddy / zcode）
 * ------------------------------------------------------------------ */

/**
 * 取出整段文档里的 JSON 对象。
 *
 * 有的 CLI 会把它包进 ```json 代码块，或者在 JSON 前后加一句人话，
 * 所以先直解析，再试代码块，最后退回「首个 { 到最后一个 }」的切片。
 */
function extractJsonDocument(raw: string): unknown {
  const direct = tryParseJson(raw.trim());
  if (direct !== undefined) {
    return direct;
  }

  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(raw);
  const inner = fenced?.[1];
  if (inner) {
    const parsed = tryParseJson(inner.trim());
    if (parsed !== undefined) {
      return parsed;
    }
  }

  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start >= 0 && end > start) {
    return tryParseJson(raw.slice(start, end + 1));
  }
  return undefined;
}

function createJsonResultParser(): AgentOutputParser {
  let buffer = '';

  return {
    // 整段 JSON 只有到 EOF 才是完整文档，中途解析只能得到半截，
    // 所以 push 阶段一律不产出事件——这也是流式看板会比真实进程晚一步的原因
    push(chunk: string): AgentEvent[] {
      buffer += chunk;
      return [];
    },
    finish(): AgentEvent[] {
      const raw = buffer;
      buffer = '';
      if (!raw.trim()) {
        return [];
      }

      const record = asRecord(extractJsonDocument(raw));
      if (!record) {
        // 不是 JSON，或者顶层不是对象：退回纯文本，一个字符都不丢
        return [textEvent(raw)];
      }

      const events: AgentEvent[] = [];
      const nested = asRecord(record.data) ?? asRecord(record.result);
      const value =
        readString(record, 'result', 'text', 'content', 'message', 'output', 'response') ??
        readString(nested, 'text', 'content', 'message', 'output');
      if (value) {
        events.push({ kind: 'result', text: value });
      }

      const usage = extractUsage(record, nested);
      if (usage) {
        events.push({ kind: 'usage', usage });
      }

      const sessionId = pickSessionId(record, nested);
      if (sessionId) {
        events.push({ kind: 'session', sessionId });
      }

      // JSON 合法但一个已知字段都没命中：原文照发，宁可多一行也不猜
      return events.length > 0 ? events : [textEvent(raw)];
    },
  };
}

/* ------------------------------------------------------------------ *
 * plain：没有结构的纯文本
 * ------------------------------------------------------------------ */

function createPlainParser(): AgentOutputParser {
  return {
    // 纯文本平台没有任何可切分结构，逐块直传：行缓冲只会让看板晚看到输出，
    // 换行与缩进原样保留，交给渲染层处理
    push(chunk: string): AgentEvent[] {
      return chunk ? [textEvent(chunk)] : [];
    },
    finish(): AgentEvent[] {
      return [];
    },
  };
}

/**
 * 按 profile 声明的 parser id 造解析器。
 *
 * default 分支是运行时的防守：profile 可能来自外部配置（API 覆盖、磁盘上的
 * 旧数据），parser 字段未必在编译期类型内。认不出来就当纯文本，绝不因为
 * 一个拼错的 id 让 Agent 的输出整段消失。
 */
export function createParser(id: AgentParserId): AgentOutputParser {
  switch (id) {
    case 'claude-stream-json':
      return createLineParser(handleClaudeLine);
    case 'codex-json':
      return createLineParser(handleCodexLine);
    case 'opencode-json':
      return createLineParser(handleOpencodeLine);
    case 'dsh-json':
      return createLineParser(handleDshLine);
    case 'json-result':
      return createJsonResultParser();
    case 'plain':
      return createPlainParser();
    default:
      return createPlainParser();
  }
}

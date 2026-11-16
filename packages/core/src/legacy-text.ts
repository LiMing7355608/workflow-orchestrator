import type { AgentEventKind } from './parsers.js';

export interface RevivedAgentLine {
  kind: AgentEventKind;
  text: string;
  phase?: string;
}

/**
 * 读取时的旧数据兼容。
 *
 * 早期版本把解析器认不出的行原样当正文落库，于是 journal 里存的是
 * `{"type":"thinking","text":"..."}`、`{"type":"status","phase":"step_start"}`
 * 这样的整行 JSON。它们是**已经写死的事实**，前端再怎么改也解析不出来——
 * 只有在这里补一次解析，旧运行才能正确显示。
 *
 * 返回值：
 * - `undefined` 表示这行不是旧格式，调用方原样处理
 * - `null` 表示这行没有保留价值（纯进度噪音、空思考），应当丢弃
 * - `RevivedAgentLine` 表示重新归类后的内容
 */
export function reviveLegacyAgentText(
  raw: string,
): RevivedAgentLine | null | undefined {
  const trimmed = raw.trim();
  // 只要求以 { 开头：以 } 结尾是「完整 JSON」的特征，不是「值得尝试解析」的
  // 前提。被长度上限截断的行恰恰没有收尾括号，卡在这里就再也救不回来了。
  if (!trimmed.startsWith('{')) {
    return undefined;
  }

  let value: unknown;
  try {
    value = JSON.parse(trimmed);
  } catch {
    // 解析失败可能是「chunk 被截断」：编排层对超长输出有长度上限，
    // 一条很长的 thinking 会以半截 JSON 落库。这种情况仍要尽力认出来，
    // 否则它就被当成正文糊在时间线上——正是这次要修的症状。
    return reviveTruncatedLine(trimmed);
  }

  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return undefined;
  }

  const record = value as Record<string, unknown>;
  const type = record['type'];
  if (typeof type !== 'string') {
    return undefined;
  }

  switch (type) {
    case 'status':
      // 进度信号不是内容。旧版本把它当正文落库，现在读取时丢弃。
      return null;

    case 'thinking':
    case 'reasoning': {
      const text = typeof record['text'] === 'string' ? record['text'] : '';
      // 空思考块（只有签名、只有类型）是纯噪音
      return text.trim() ? { kind: 'thinking', text } : null;
    }

    case 'session':
      // 会话建立已经由 agent.session 事件承载，正文里这行是重复的
      return null;

    default:
      return undefined;
  }
}

/** 把 JSON 字符串字面量里的转义还原成真实文本（含被截断的尾巴）。 */
function unescapeJsonFragment(raw: string): string {
  return raw.replace(/\\(u[0-9a-fA-F]{4}|[\s\S])/g, (match, token: string) => {
    switch (token) {
      case 'n':
        return '\n';
      case 't':
        return '\t';
      case 'r':
        return '\r';
      case 'b':
        return '\b';
      case 'f':
        return '\f';
      case '"':
        return '"';
      case '\\':
        return '\\';
      case '/':
        return '/';
      default:
        if (token.startsWith('u') && token.length === 5) {
          const code = Number.parseInt(token.slice(1), 16);
          return Number.isNaN(code) ? match : String.fromCharCode(code);
        }
        return match;
    }
  });
}

/**
 * 认出被截断的整行 JSON。
 *
 * 只做能确定的事：status 一律丢弃（它没有保留价值），thinking / reasoning
 * 把正文抠出来。认不出就返回 undefined，让调用方原样显示——宁可多显示一行
 * 噪音，也不能把 Agent 的真实输出吞掉。
 */
function reviveTruncatedLine(trimmed: string): RevivedAgentLine | null | undefined {
  const typeMatch = /^\{\s*"type"\s*:\s*"([^"]+)"/.exec(trimmed);
  if (!typeMatch) {
    return undefined;
  }

  const type = typeMatch[1];
  if (type === 'status' || type === 'session') {
    return null;
  }
  if (type !== 'thinking' && type !== 'reasoning') {
    return undefined;
  }

  const textMatch = /"text"\s*:\s*"([\s\S]*)$/.exec(trimmed);
  if (!textMatch?.[1]) {
    return null;
  }
  const text = unescapeJsonFragment(textMatch[1]);
  return text.trim() ? { kind: 'thinking', text } : null;
}

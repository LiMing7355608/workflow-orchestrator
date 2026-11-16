import { describe, expect, it } from 'vitest';
import type { AgentParserId } from '../src/agents';
import { createParser, type AgentEvent, type AgentOutputParser } from '../src/parsers';

/**
 * 解析器测试全部是纯函数测试：不启动进程、不碰文件系统。
 *
 * 关注点只有三件事——正常输出能不能解出结构、认不出来的内容有没有原样留下、
 * 被 chunk 边界切断的行会不会丢。
 */

function parseAll(id: AgentParserId, text: string): AgentEvent[] {
  const parser: AgentOutputParser = createParser(id);
  return [...parser.push(text), ...parser.finish()];
}

const kinds = (events: AgentEvent[]): string[] => events.map((event) => event.kind);
const bodies = (events: AgentEvent[]): Array<string | undefined> =>
  events
    .filter((event) => event.kind === 'text' || event.kind === 'result' || event.kind === 'error')
    .map((event) => event.text);

/* ------------------------------------------------------------------ *
 * 四种 NDJSON 解析器共通的退化路径
 * ------------------------------------------------------------------ */

const NDJSON_PARSERS = [
  'claude-stream-json',
  'codex-json',
  'opencode-json',
  'dsh-json',
] as const;

/** 每种 NDJSON 里一条「一定能解出正文」的行，用于验证跨 chunk 的断行。 */
const SAMPLE_LINES: Record<(typeof NDJSON_PARSERS)[number], string> = {
  'claude-stream-json':
    '{"type":"assistant","message":{"content":[{"type":"text","text":"半行测试"}]}}',
  'codex-json': '{"type":"item.completed","item":{"type":"agent_message","text":"半行测试"}}',
  'opencode-json': '{"type":"text","part":{"type":"text","text":"半行测试"}}',
  'dsh-json': '{"type":"text","text":"半行测试"}',
};

describe.each(NDJSON_PARSERS)('%s 的退化策略', (id) => {
  it('非 JSON 行原样保留为 text', () => {
    const line = '<<< 这不是 JSON >>>';
    expect(parseAll(id, `${line}\n`)).toEqual([{ kind: 'text', text: line }]);
  });

  it('未知事件类型原样保留为 text', () => {
    const line = '{"type":"future.event","payload":"未实现的新事件"}';
    expect(parseAll(id, line)).toEqual([{ kind: 'text', text: line }]);
  });

  it('被切断的行不会提前产出半截事件，拼接后完整解出', () => {
    const line = SAMPLE_LINES[id];
    const parser = createParser(id);
    // 切在 JSON 中间：这一刀必须只进缓冲区，不能产出任何事件
    expect(parser.push(line.slice(0, 20))).toEqual([]);
    const events = [...parser.push(line.slice(20)), ...parser.finish()];
    expect(bodies(events)).toEqual(['半行测试']);
  });
});

/* ------------------------------------------------------------------ *
 * claude-stream-json
 * ------------------------------------------------------------------ */

describe('claude-stream-json', () => {
  const ndjson = [
    '{"type":"system","subtype":"init","session_id":"sess-1","model":"claude-sonnet-4"}',
    '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"先看文件"},{"type":"tool_use","id":"t1","name":"Read","input":{"file_path":"a.ts"}}]},"session_id":"sess-1"}',
    '{"type":"assistant","message":{"content":[{"type":"tool_result","tool_use_id":"t1","content":"export const a = 1"}],"usage":{"input_tokens":12,"output_tokens":3}},"session_id":"sess-1"}',
    // 最后一行故意不带换行符：验证 finish() 会把它当尾行处理
    '{"type":"result","subtype":"success","is_error":false,"result":"改好了","session_id":"sess-1","usage":{"input_tokens":100,"output_tokens":40}}',
  ].join('\n');

  it('典型输出解出正文、工具、用量与会话', () => {
    const events = parseAll('claude-stream-json', ndjson);

    expect(kinds(events)).toEqual([
      'session',
      'text',
      'tool',
      'session',
      'text',
      'usage',
      'session',
      'result',
      'usage',
      'session',
    ]);

    const tool = events.find((event) => event.kind === 'tool');
    expect(tool?.toolName).toBe('Read');
    // 工具入参刻意不进事件流
    expect(tool?.text).toBeUndefined();

    expect(bodies(events)).toEqual(['先看文件', 'export const a = 1', '改好了']);
  });

  it('result 事件里能取出 sessionId 与 usage', () => {
    const events = parseAll('claude-stream-json', ndjson);
    const usages = events.filter((event) => event.kind === 'usage').map((event) => event.usage);
    expect(usages).toEqual([
      { promptTokens: 12, completionTokens: 3, totalTokens: 15 },
      { promptTokens: 100, completionTokens: 40, totalTokens: 140 },
    ]);

    const sessions = events
      .filter((event) => event.kind === 'session')
      .map((event) => event.sessionId);
    expect(sessions).toEqual(['sess-1', 'sess-1', 'sess-1', 'sess-1']);
  });

  it('is_error 的 result 降级为 error 事件', () => {
    const events = parseAll(
      'claude-stream-json',
      '{"type":"result","subtype":"error_max_turns","is_error":true,"result":"超过轮次上限"}',
    );
    expect(kinds(events)).toEqual(['error']);
    expect(events[0]?.text).toBe('超过轮次上限');
  });

  it('system 行没有 session id 时保留原文而不是吞掉', () => {
    const line = '{"type":"system","subtype":"hook","detail":"hook 输出"}';
    expect(parseAll('claude-stream-json', line)).toEqual([{ kind: 'text', text: line }]);
  });
});

/* ------------------------------------------------------------------ *
 * codex-json
 * ------------------------------------------------------------------ */

describe('codex-json', () => {
  it('thread / item / turn 与 token_count 各归其位', () => {
    const ndjson = [
      '{"type":"thread.started","thread_id":"th-9"}',
      '{"type":"turn.started"}',
      '{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"我在读代码"}}',
      '{"type":"item.completed","item":{"id":"item_1","type":"command_execution","command":"pnpm test","aggregated_output":"ok"}}',
      '{"type":"token_count","input_tokens":11,"output_tokens":4}',
      '{"type":"turn.completed","usage":{"input_tokens":30,"output_tokens":9}}',
    ].join('\n');

    const events = parseAll('codex-json', ndjson);

    expect(kinds(events)).toEqual(['session', 'text', 'tool', 'usage', 'usage']);
    expect(events[0]?.sessionId).toBe('th-9');
    expect(events[2]?.toolName).toBe('pnpm test');
    expect(events[3]?.usage).toEqual({ promptTokens: 11, completionTokens: 4, totalTokens: 15 });
    expect(events[4]?.usage).toEqual({ promptTokens: 30, completionTokens: 9, totalTokens: 39 });
  });

  it('turn.completed 带最终消息时同时给出 result', () => {
    const events = parseAll(
      'codex-json',
      '{"type":"turn.completed","last_agent_message":"全部改完","usage":{"input_tokens":5,"output_tokens":2}}',
    );
    expect(kinds(events)).toEqual(['usage', 'result']);
    expect(events[1]?.text).toBe('全部改完');
  });

  it('老版 msg.type 格式也能认', () => {
    const ndjson = [
      '{"id":"0","msg":{"type":"session_configured","session_id":"old-1"}}',
      '{"id":"1","msg":{"type":"agent_message","message":"老格式正文"}}',
      '{"id":"2","msg":{"type":"task_complete","last_agent_message":"老格式完成"}}',
    ].join('\n');

    const events = parseAll('codex-json', ndjson);
    expect(kinds(events)).toEqual(['session', 'text', 'result']);
    expect(events[0]?.sessionId).toBe('old-1');
    expect(bodies(events)).toEqual(['老格式正文', '老格式完成']);
  });
});

/* ------------------------------------------------------------------ *
 * opencode-json
 * ------------------------------------------------------------------ */

describe('opencode-json', () => {
  it('step_start / text / tool_use / step_finish / error 依次解出', () => {
    const ndjson = [
      '{"type":"step_start","sessionID":"ses-7","part":{"type":"step-start"}}',
      '{"type":"text","sessionID":"ses-7","part":{"type":"text","text":"开始实现"}}',
      '{"type":"tool_use","sessionID":"ses-7","part":{"type":"tool","tool":"bash","state":{"title":"运行 pnpm test","output":"很长的输出"}}}',
      '{"type":"step_finish","sessionID":"ses-7","part":{"type":"step-finish","reason":"stop","tokens":{"input":20,"output":6}}}',
      '{"type":"error","part":{"error":{"message":"模型超时"}}}',
    ].join('\n');

    const events = parseAll('opencode-json', ndjson);

    expect(kinds(events)).toEqual(['session', 'text', 'tool', 'usage', 'error']);
    expect(events[0]?.sessionId).toBe('ses-7');
    expect(events[2]?.toolName).toBe('bash');
    expect(events[2]?.text).toBe('运行 pnpm test');
    expect(events[3]?.usage).toEqual({ promptTokens: 20, completionTokens: 6, totalTokens: 26 });
    expect(events[4]?.text).toBe('模型超时');
  });
});

/* ------------------------------------------------------------------ *
 * dsh-json
 * ------------------------------------------------------------------ */

describe('dsh-json', () => {
  it('session / text / tool_call / tool_result / final / error 依次解出', () => {
    const ndjson = [
      '{"type":"session","sessionId":"dsh-1"}',
      '{"type":"text","text":"先看仓库"}',
      '{"type":"tool_call","name":"read_file"}',
      '{"type":"tool_result","name":"read_file","output":"文件内容"}',
      '{"type":"final","text":"改完了","usage":{"prompt_tokens":9,"completion_tokens":4}}',
      '{"type":"error","message":"沙箱拒绝写盘"}',
    ].join('\n');

    const events = parseAll('dsh-json', ndjson);

    expect(kinds(events)).toEqual(['session', 'text', 'tool', 'text', 'result', 'usage', 'error']);
    expect(events[0]?.sessionId).toBe('dsh-1');
    expect(events[2]?.toolName).toBe('read_file');
    expect(bodies(events)).toEqual(['先看仓库', '文件内容', '改完了', '沙箱拒绝写盘']);
    expect(events[5]?.usage).toEqual({ promptTokens: 9, completionTokens: 4, totalTokens: 13 });
  });

  it('tool_result 没有正文时退化为工具事件而不是丢失', () => {
    const events = parseAll('dsh-json', '{"type":"tool_result","name":"apply_patch"}');
    expect(events).toEqual([{ kind: 'tool', toolName: 'apply_patch' }]);
  });
});

/* ------------------------------------------------------------------ *
 * json-result
 * ------------------------------------------------------------------ */

describe('json-result', () => {
  it('整段 JSON 在 finish 时才解析出结果、用量与会话', () => {
    const doc = JSON.stringify(
      {
        result: '任务完成',
        usage: { input_tokens: 7, output_tokens: 5 },
        session_id: 'z-1',
      },
      null,
      2,
    );

    const parser = createParser('json-result');
    // 中途 push 不产出事件：半截 JSON 解析不出任何东西
    expect(parser.push(doc.slice(0, 30))).toEqual([]);
    const events = [...parser.push(doc.slice(30)), ...parser.finish()];

    expect(kinds(events)).toEqual(['result', 'usage', 'session']);
    expect(events[0]?.text).toBe('任务完成');
    expect(events[1]?.usage).toEqual({ promptTokens: 7, completionTokens: 5, totalTokens: 12 });
    expect(events[2]?.sessionId).toBe('z-1');
  });

  it('被 ```json 代码块包起来时也能取出', () => {
    const events = parseAll('json-result', '```json\n{"text":"包在代码块里"}\n```');
    expect(kinds(events)).toEqual(['result']);
    expect(events[0]?.text).toBe('包在代码块里');
  });

  it('不是 JSON 时整段退化为 text', () => {
    const raw = '命令行把它当纯文本吐了出来：done';
    expect(parseAll('json-result', raw)).toEqual([{ kind: 'text', text: raw }]);
  });

  it('JSON 合法但没有已知字段时原文照发', () => {
    const raw = '{"something_else":1}';
    expect(parseAll('json-result', raw)).toEqual([{ kind: 'text', text: raw }]);
  });

  it('空输出不产出任何事件', () => {
    expect(parseAll('json-result', '   \n  ')).toEqual([]);
  });
});

/* ------------------------------------------------------------------ *
 * plain
 * ------------------------------------------------------------------ */

describe('plain', () => {
  it('每一块内容都是 text 事件，不做行缓冲', () => {
    const parser = createParser('plain');
    expect(parser.push('第一段\n')).toEqual([{ kind: 'text', text: '第一段\n' }]);
    expect(parser.push('第二段，没有换行')).toEqual([{ kind: 'text', text: '第二段，没有换行' }]);
    expect(parser.finish()).toEqual([]);
  });

  it('空块不产出事件', () => {
    expect(parseAll('plain', '')).toEqual([]);
  });
});

import { expect, it } from 'vitest';
import { compactOutput, replyFromOutput } from '../src/lib/agent-output';

it('合并旧日志中的流式片段，保留真实换行并去掉重复的最终回复', () => {
  const json = '{\n  "title": "阅读 任务图",\n  "summary": "' + '方案 '.repeat(1200) + '"\n}';
  const pieces = [...json].map((message) => ({ kind: 'text', message, at: '2026-11-26T01:00:00.000Z' }));
  const final = { kind: 'result', message: json, at: '2026-11-26T01:00:01.000Z' };
  expect(compactOutput([...pieces, final], 'message')).toEqual([final]);
  expect(replyFromOutput(pieces)).toBe(json);
});

it('保持工具事件和其他 Agent 消息各自的边界', () => {
  const output = [
    { kind: 'text', agent: 'a', text: '前', at: 'a' },
    { kind: 'tool', agent: 'a', text: '读取文件', at: 'b' },
    { kind: 'text', agent: 'a', text: '后', at: 'c' },
    { kind: 'text', agent: 'b', text: '独立', at: 'd' },
  ];
  expect(compactOutput(output, 'text')).toEqual(output);
});

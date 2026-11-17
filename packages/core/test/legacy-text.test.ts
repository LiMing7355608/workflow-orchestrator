import { describe, expect, it } from 'vitest';
import { reviveLegacyAgentText } from '../src/legacy-text.js';
import { deriveEvents } from '../src/derive.js';
import type { OrchestratorEvent, RunFacts } from '../src/types.js';

describe('旧数据兼容解析', () => {
  it('完整的 thinking 行还原成 thinking', () => {
    const result = reviveLegacyAgentText('{"type":"thinking","text":"先看仓库"}');
    expect(result).toEqual({ kind: 'thinking', text: '先看仓库' });
  });

  it('空 thinking 是噪音，丢弃', () => {
    expect(reviveLegacyAgentText('{"type":"thinking","text":""}')).toBeNull();
  });

  it('status 是进度信号不是内容，丢弃', () => {
    expect(
      reviveLegacyAgentText('{"type":"status","phase":"step_start","turn":1}'),
    ).toBeNull();
  });

  it('session 行重复了 agent.session 事件，丢弃', () => {
    expect(reviveLegacyAgentText('{"type":"session","sessionId":"s-1"}')).toBeNull();
  });

  it('被长度上限截断的 thinking 仍要认出来，并还原转义', () => {
    // 编排层对 chunk 有长度上限，半截 JSON 是真实存在的数据
    const raw =
      '{"type":"thinking","text":"I ran \\"import calc.app\\" and it was cut';
    const result = reviveLegacyAgentText(raw);
    expect(result?.kind).toBe('thinking');
    expect(result?.text).toContain('I ran "import calc.app" and it was cut');
  });

  it('截断的 status 也不该漏出来', () => {
    expect(reviveLegacyAgentText('{"type":"status","phase":"step_start","turn')).toBeNull();
  });

  it('普通正文原样放行', () => {
    expect(reviveLegacyAgentText('普通的输出文本')).toBeUndefined();
  });

  it('不是 JSON 的花括号文本不要误判', () => {
    expect(reviveLegacyAgentText('{不是 JSON}')).toBeUndefined();
  });

  it('非事件形状的对象也不动', () => {
    expect(reviveLegacyAgentText('{"nodes":[]}')).toBeUndefined();
  });
});

describe('deriveEvents 对旧数据的处理', () => {
  const run: RunFacts = {
    id: 'run-legacy',
    title: '旧数据',
    summary: '',
    goal: '',
    // 旧日志里没有这个字段：空串是归约后的哨兵值，读取侧据它回落默认根目录
    workspaceRoot: '',
    specVersion: 'v1.0',
    stage: 'execute',
    createdAt: '2026-01-01T00:00:00.000Z',
    nodeOrder: ['n1'],
    nodes: {
      n1: {
        id: 'n1',
        type: 'implement',
        title: '甲',
        description: '',
        dependsOn: [],
        files: [],
        agentId: 'dsh-acp',
        attempts: 0,
        maxAttempts: 3,
      },
    },
  };

  function output(at: string, chunk: string): OrchestratorEvent {
    return {
      type: 'agent.output',
      at,
      runId: 'run-legacy',
      nodeId: 'n1',
      agentId: 'dsh-acp',
      chunk,
      kind: 'text',
    };
  }

  it('丢弃 status、归类 thinking、保留正文', () => {
    const views = deriveEvents(run, [
      output('2026-01-01T00:00:00.000Z', '{"type":"status","phase":"step_start"}'),
      output('2026-01-01T00:00:01.000Z', '{"type":"thinking","text":"想一想"}'),
      output('2026-01-01T00:00:02.000Z', '真正的输出'),
    ]);

    expect(views).toHaveLength(2);
    expect(views[0]?.kind).toBe('thinking');
    expect(views[0]?.message).toBe('想一想');
    expect(views[1]?.kind).toBe('text');
    expect(views[1]?.message).toBe('真正的输出');
  });

  it('事件 id 在过滤之后仍然连续', () => {
    const views = deriveEvents(run, [
      output('2026-01-01T00:00:00.000Z', '{"type":"status","phase":"turn_start"}'),
      output('2026-01-01T00:00:01.000Z', '正文'),
    ]);
    expect(views.map((view) => view.id)).toEqual(['ev-0']);
  });
});

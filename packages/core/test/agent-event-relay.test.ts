import { describe, expect, it } from 'vitest';
import { createAgentEventRelay } from '../src/orchestrator.js';
import type { OrchestratorEvent } from '../src/types.js';

describe('Agent 事件转发', () => {
  it('保留流式空白并批量落盘，同时记录运行级会话和完整结果', async () => {
    const events: OrchestratorEvent[] = [];
    const relay = createAgentEventRelay({
      now: () => '2026-11-26T01:00:00.000Z',
      async emit(event) { events.push(event); },
    }, { runId: 'run-test', agentId: 'codex' });
    const sessionId = 'b0b9dd31-75d8-4725-9e68-e2f94a60c76a';
    const response = '{\n  "title": "任务图",\n  "summary": "' + '保留分隔符 '.repeat(420) + '"\n}';
    relay.forward([{ kind: 'session', sessionId }]);
    for (const fragment of response) relay.forward([{ kind: 'text', text: fragment }]);
    relay.forward([{ kind: 'tool', toolName: 'read' }, { kind: 'result', text: response }]);
    await relay.flush();

    expect(events.map(({ type }) => type)).toEqual(['agent.session', 'agent.output', 'agent.output', 'agent.output']);
    expect(events[0]).toMatchObject({ sessionId, runId: 'run-test' });
    expect(events[1]).toMatchObject({ kind: 'text', chunk: response });
    expect(events[2]).toMatchObject({ kind: 'tool' });
    expect(events[3]).toMatchObject({ kind: 'result', chunk: response });
  });
});

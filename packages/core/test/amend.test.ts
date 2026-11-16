import { describe, expect, it } from 'vitest';
import {
  deriveRunDetail,
  emptyState,
  reduce,
  replay,
  type NodeFacts,
  type OrchestratorEvent,
  type ProjectState,
  type RunFacts,
} from '../src/index';

/**
 * 对话改图（`dag.amended`）的投影行为。
 *
 * 这里只验「事件 → 事实」这一层：改动的合法性（已开始节点不许动、字段白名单）
 * 由服务端在发出事件之前判定，投影层负责的是一件更要命的事——
 * 无论事件写成什么样，图都不能被改成一张自相矛盾的图。
 */

const AT = '2026-11-16T00:00:00.000Z';
const RUN_ID = 'run-amend';

function node(
  partial: Partial<NodeFacts> & Pick<NodeFacts, 'id' | 'type'>,
): NodeFacts {
  return {
    title: partial.id,
    description: '',
    dependsOn: [],
    files: [],
    attempts: 0,
    maxAttempts: 3,
    ...partial,
  };
}

function buildRun(nodes: NodeFacts[]): RunFacts {
  return {
    id: RUN_ID,
    title: '改图测试',
    summary: '',
    goal: '验证对话改图的投影',
    workspaceRoot: '/tmp/target-repo',
    specVersion: 'v1.0',
    stage: 'execute',
    createdAt: AT,
    frozenAt: AT,
    nodeOrder: nodes.map((item) => item.id),
    nodes: Object.fromEntries(nodes.map((item) => [item.id, item])),
  };
}

/** 造一份只有 run.created 的初始状态。 */
function seeded(run: RunFacts): ProjectState {
  return reduce(emptyState(), { type: 'run.created', at: AT, runId: RUN_ID, run });
}

function apply(state: ProjectState, event: OrchestratorEvent): ProjectState {
  return reduce(state, event);
}

const baseRun = (): RunFacts =>
  buildRun([
    node({ id: 'impl-chat', type: 'implement', agentId: 'claude', files: ['src/chat/**'] }),
    node({
      id: 'review-chat',
      type: 'review',
      agentId: 'opencode',
      dependsOn: ['impl-chat'],
      files: ['src/chat/**'],
    }),
  ]);

describe('dag.amended 投影', () => {
  it('update-node 只改白名单字段，执行事实原样保留', () => {
    // 一个已经跑过一轮的实现节点：attempts 与产物统计都是「发生过的事」
    const run = baseRun();
    run.nodes['impl-chat'] = {
      ...run.nodes['impl-chat']!,
      attempts: 2,
      artifactBytes: 120,
      artifactFiles: ['src/chat/a.ts'],
    };

    const state = apply(seeded(run), {
      type: 'dag.amended',
      at: AT,
      runId: RUN_ID,
      actor: 'YG',
      reason: '实现换成 codex，标题也改一下',
      changes: [
        {
          kind: 'update-node',
          nodeId: 'impl-chat',
          fields: [
            { field: 'agentId', from: 'claude', to: 'codex' },
            { field: 'title', from: 'impl-chat', to: '消息模块实现' },
          ],
          node: {
            ...run.nodes['impl-chat']!,
            agentId: 'codex',
            title: '消息模块实现',
            // 越权字段：投影层必须无视它们
            dependsOn: ['review-chat'],
            attempts: 99,
          },
        },
      ],
    });

    const updated = state.runs[RUN_ID]?.nodes['impl-chat'];
    expect(updated?.agentId).toBe('codex');
    expect(updated?.title).toBe('消息模块实现');
    // 结构字段与执行事实都不许被这条事件改掉
    expect(updated?.dependsOn).toEqual([]);
    expect(updated?.attempts).toBe(2);
    expect(updated?.artifactBytes).toBe(120);
  });

  it('add-node 追加到 nodes 与 nodeOrder 末尾，并随事实一起可被派发', () => {
    const run = baseRun();
    const added = node({
      id: 'impl-chat-ui',
      type: 'implement',
      agentId: 'codex',
      dependsOn: ['impl-chat'],
      files: ['src/chat/ui/**'],
    });

    const state = apply(seeded(run), {
      type: 'dag.amended',
      at: AT,
      runId: RUN_ID,
      actor: 'YG',
      reason: '把消息模块拆成两个节点',
      changes: [{ kind: 'add-node', nodeId: 'impl-chat-ui', node: added }],
    });

    const next = state.runs[RUN_ID]!;
    expect(next.nodeOrder).toEqual(['impl-chat', 'review-chat', 'impl-chat-ui']);
    expect(next.nodes['impl-chat-ui']).toEqual(added);
  });

  it('remove-node 同时从 nodes 与 nodeOrder 里拿掉', () => {
    const run = baseRun();

    const state = apply(seeded(run), {
      type: 'dag.amended',
      at: AT,
      runId: RUN_ID,
      actor: 'YG',
      reason: '这个节点多余',
      changes: [{ kind: 'remove-node', nodeId: 'review-chat' }],
    });

    const next = state.runs[RUN_ID]!;
    expect(next.nodeOrder).toEqual(['impl-chat']);
    expect(next.nodes['review-chat']).toBeUndefined();
  });

  it('改动累计进 amendments，空的改动不记账', () => {
    const run = baseRun();
    let state = seeded(run);

    state = apply(state, {
      type: 'dag.amended',
      at: AT,
      runId: RUN_ID,
      actor: 'YG',
      reason: '换 agent',
      changes: [
        {
          kind: 'update-node',
          nodeId: 'review-chat',
          fields: [{ field: 'agentId', from: 'opencode', to: 'codex' }],
          node: { ...run.nodes['review-chat']!, agentId: 'codex' },
        },
      ],
    });

    state = apply(state, {
      type: 'dag.amended',
      at: AT,
      runId: RUN_ID,
      actor: 'YG',
      reason: '再加一个节点',
      changes: [
        {
          kind: 'add-node',
          nodeId: 'impl-extra',
          node: node({ id: 'impl-extra', type: 'implement', agentId: 'claude' }),
        },
      ],
    });

    // 什么都没改的一次对话：不该在审计流水里留下空行
    state = apply(state, {
      type: 'dag.amended',
      at: AT,
      runId: RUN_ID,
      actor: 'YG',
      reason: '随便聊两句',
      changes: [],
    });

    const next = state.runs[RUN_ID]!;
    expect(next.amendments).toHaveLength(2);
    expect(next.amendments?.map((item) => item.kind)).toEqual([
      'update-node',
      'add-node',
    ]);
  });

  it('重放与逐步投影得到同一份事实', () => {
    const run = baseRun();
    const events: OrchestratorEvent[] = [
      { type: 'run.created', at: AT, runId: RUN_ID, run },
      {
        type: 'dag.amended',
        at: AT,
        runId: RUN_ID,
        actor: 'YG',
        reason: '审查换人',
        changes: [
          {
            kind: 'update-node',
            nodeId: 'review-chat',
            fields: [{ field: 'agentId', from: 'opencode', to: 'codex' }],
            node: { ...run.nodes['review-chat']!, agentId: 'codex' },
          },
        ],
      },
      {
        type: 'dag.amended',
        at: AT,
        runId: RUN_ID,
        actor: 'YG',
        reason: '去掉多余节点',
        changes: [{ kind: 'remove-node', nodeId: 'impl-chat' }],
      },
    ];

    const replayed = replay(events).runs[RUN_ID]!;
    const stepped = reduce(seeded(run), events[1]!);

    expect(Object.keys(replayed.nodes)).toEqual(['review-chat']);
    expect(replayed.nodeOrder).toEqual(['review-chat']);
    // 第二次改动删掉了 review-chat 的上游，图本身可能已经不自洽——
    // 那是服务端该拦的事，这里要的只是「投影忠实执行了事件」
    expect(stepped.runs[RUN_ID]?.nodes['review-chat']?.agentId).toBe('codex');
  });

  it('改图在事件流里是一行可审计的记录', () => {
    const run = baseRun();
    const events: OrchestratorEvent[] = [
      { type: 'run.created', at: AT, runId: RUN_ID, run },
      {
        type: 'dag.amended',
        at: AT,
        runId: RUN_ID,
        actor: 'YG',
        reason: '审查那个节点换成 codex',
        changes: [
          {
            kind: 'update-node',
            nodeId: 'review-chat',
            fields: [{ field: 'agentId', from: 'opencode', to: 'codex' }],
            node: { ...run.nodes['review-chat']!, agentId: 'codex' },
          },
        ],
      },
    ];

    const detail = deriveRunDetail(replay(events).runs[RUN_ID]!, events, () => undefined);
    const amendEvent = detail.events.find((item) => item.message.includes('按指令修改任务图'));
    expect(amendEvent?.type).toBe('stage');
    expect(amendEvent?.message).toContain('YG');
    expect(amendEvent?.message).toContain('agentId：opencode → codex');
  });
});

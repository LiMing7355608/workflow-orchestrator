import { describe, expect, it } from 'vitest';
import type { NodeFacts, RunFacts } from '@orchestrator/core';
import { parseDag, type Dag } from '@orchestrator/planner';
import { buildAmendmentReply, dagFromFacts, diffDag } from '../src/amend';

/**
 * 白名单闸门的判定。
 *
 * 这些用例直接打 `diffDag`：它是「哪条改动允许生效」的唯一判据，而接口层
 * 只负责把它的结论转成 HTTP。把判定单独验一遍，比只验证「接口返回 200」
 * 有用得多——后者在规则被悄悄放宽时依然是绿的。
 */

const AT = '2026-11-16T00:00:00.000Z';

function node(partial: Partial<NodeFacts> & Pick<NodeFacts, 'id' | 'type'>): NodeFacts {
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

const run: RunFacts = {
  id: 'run-diff',
  title: '消息模块',
  summary: '',
  goal: '实现消息模块',
  workspaceRoot: '/tmp/target-repo',
  specVersion: 'v1.0',
  stage: 'execute',
  createdAt: AT,
  frozenAt: AT,
  nodeOrder: ['impl-chat', 'review-chat'],
  nodes: {
    'impl-chat': node({
      id: 'impl-chat',
      type: 'implement',
      title: '实现消息模块',
      agentId: 'claude',
      files: ['src/chat/**'],
      startedAt: AT,
      finishedAt: AT,
    }),
    'review-chat': node({
      id: 'review-chat',
      type: 'review',
      title: '审查消息模块',
      agentId: 'claude',
      dependsOn: ['impl-chat'],
      files: ['src/chat/**'],
    }),
  },
};

/** 由事实重建的图，作为「当前图」。 */
const current = (): Dag => dagFromFacts(run);

/** 在当前图上做一次改动后重新解析，模拟 Planner 交回来的新图。 */
function edit(mutate: (dag: Dag) => void): Dag {
  const dag = JSON.parse(JSON.stringify(current())) as Dag;
  mutate(dag);
  // 走一遍 schema：白名单判定必须建立在合法图上，与真实链路的输入一致
  return parseDag(dag);
}

/**
 * 不经过 schema 的改动，只给「删到一张空图」这类用例。
 *
 * 真实链路里 `nodes` 至少有一个节点（schema 就是这么定的），所以要构造
 * 「删掉唯一那个已开始节点」的局面，只能在 schema 之外动手。
 */
function editRaw(mutate: (dag: Dag) => void): Dag {
  const dag = JSON.parse(JSON.stringify(current())) as Dag;
  mutate(dag);
  return dag;
}

describe('dagFromFacts', () => {
  it('只带图结构，不带执行过程', () => {
    const dag = dagFromFacts(run);
    expect(dag.nodes.map((item) => item.id)).toEqual(['impl-chat', 'review-chat']);
    expect(dag.nodes[0]?.agentId).toBe('claude');
    // 事实里的 attempts / startedAt 不该出现在 Planner 契约里
    expect(dag.nodes[0]).not.toHaveProperty('attempts');
    expect(dag.nodes[0]).not.toHaveProperty('startedAt');
  });
});

describe('diffDag：修改', () => {
  it('未开始节点的白名单字段改动生效，并带出新旧值', () => {
    const plan = diffDag(
      current(),
      edit((dag) => {
        const review = dag.nodes.find((item) => item.id === 'review-chat');
        if (review) review.agentId = 'codex';
      }),
      run,
    );

    expect(plan.rejected).toEqual([]);
    expect(plan.applied).toHaveLength(1);
    const amendment = plan.applied[0]!;
    expect(amendment.kind).toBe('update-node');
    expect(amendment.nodeId).toBe('review-chat');
    expect(amendment.fields).toEqual([
      { field: 'agentId', from: 'claude', to: 'codex' },
    ]);
    // 事件里带的新节点事实必须只含白名单字段的新值
    expect(amendment.node?.agentId).toBe('codex');
    expect(amendment.node?.dependsOn).toEqual(['impl-chat']);
  });

  it('已开始节点的改动被拒，理由写清已经开始执行了', () => {
    const plan = diffDag(
      current(),
      edit((dag) => {
        const impl = dag.nodes.find((item) => item.id === 'impl-chat');
        if (impl) impl.agentId = 'codex';
      }),
      run,
    );

    expect(plan.applied).toEqual([]);
    expect(plan.rejected).toHaveLength(1);
    expect(plan.rejected[0]?.nodeId).toBe('impl-chat');
    expect(plan.rejected[0]?.reason).toContain('已经开始执行');
  });

  it('越权字段（dependsOn）被拒，但同一次里的白名单改动照旧生效', () => {
    const plan = diffDag(
      current(),
      edit((dag) => {
        const review = dag.nodes.find((item) => item.id === 'review-chat');
        if (review) {
          review.dependsOn = [];
          review.title = '审查消息模块（含边界）';
        }
      }),
      run,
    );

    // 依赖关系属于「重画图」，必须拒；标题属于白名单，必须生效
    expect(plan.rejected).toHaveLength(1);
    expect(plan.rejected[0]?.reason).toContain('dependsOn');
    expect(plan.applied).toHaveLength(1);
    expect(plan.applied[0]?.fields?.map((field) => field.field)).toEqual(['title']);
    // 生效的改动里不能夹带被拒的那一项
    expect(plan.applied[0]?.node?.dependsOn).toEqual(['impl-chat']);
  });

  it('没有改动时不产生任何记录', () => {
    const plan = diffDag(current(), current(), run);
    expect(plan).toEqual({ applied: [], rejected: [] });
    expect(buildAmendmentReply(plan)).toContain('没有需要修改的地方');
  });
});

describe('diffDag：新增与删除', () => {
  it('新增 implement 节点生效，并记下 type / agentId / 依赖', () => {
    const plan = diffDag(
      current(),
      edit((dag) => {
        dag.nodes.push(
          parseDag({
            title: 'x',
            nodes: [
              {
                id: 'impl-chat-ui',
                type: 'implement',
                title: '消息界面',
                agentId: 'codex',
                dependsOn: ['impl-chat'],
                files: ['src/chat/ui/**'],
              },
            ],
          }).nodes[0]!,
        );
      }),
      run,
    );

    expect(plan.rejected).toEqual([]);
    expect(plan.applied).toHaveLength(1);
    const amendment = plan.applied[0]!;
    expect(amendment.kind).toBe('add-node');
    expect(amendment.nodeId).toBe('impl-chat-ui');
    expect(amendment.node?.attempts).toBe(0);
    expect(amendment.fields).toEqual([
      { field: 'type', to: 'implement' },
      { field: 'agentId', to: 'codex' },
      { field: 'dependsOn', to: 'impl-chat' },
    ]);
  });

  it('新增审批节点被拒：审批要人，不外挂', () => {
    const plan = diffDag(
      current(),
      edit((dag) => {
        dag.nodes.push(
          parseDag({
            title: 'x',
            nodes: [
              {
                id: 'approval-extra',
                type: 'approval',
                title: '人工确认',
                executor: 'YG',
                dependsOn: ['impl-chat'],
              },
            ],
          }).nodes[0]!,
        );
      }),
      run,
    );

    expect(plan.applied).toEqual([]);
    expect(plan.rejected[0]?.reason).toContain('只允许 implement 或 review');
  });

  it('删除未被依赖的未开始节点生效', () => {
    const plan = diffDag(
      current(),
      edit((dag) => {
        dag.nodes = dag.nodes.filter((item) => item.id !== 'review-chat');
      }),
      run,
    );

    expect(plan.rejected).toEqual([]);
    expect(plan.applied).toEqual([{ kind: 'remove-node', nodeId: 'review-chat' }]);
  });

  it('删除未开始节点时，连带删掉依赖它的已开始下游也算被拒', () => {
    // 只删 impl-chat、留下已开始的 review-chat：那条依赖会指向空气，
    // 所以真正能生效的只有「已开始的 impl-chat 不许删」这一条判定
    const plan = diffDag(
      current(),
      editRaw((dag) => {
        dag.nodes = dag.nodes.filter((item) => item.id !== 'impl-chat');
      }),
      run,
    );

    // impl-chat 已开始 → 拒
    expect(plan.rejected.map((item) => item.nodeId)).toEqual(['impl-chat']);
    expect(plan.rejected[0]?.reason).toContain('已经开始执行');
    // review-chat 没被请求删除，因此没有 remove-node 改动
    expect(plan.applied).toEqual([]);
  });

  it('删除被已开始节点依赖的节点被拒，理由指出那条依赖', () => {
    // 造一个「审查已开始、且依赖 impl-chat」的局面，删 impl-chat 就断了历史
    const startedReview: RunFacts = {
      ...run,
      nodes: {
        ...run.nodes,
        'review-chat': { ...run.nodes['review-chat']!, startedAt: AT },
        // impl-chat 改成「没开始过」，让判定落到依赖规则上而不是锁定规则上
        'impl-chat': node({
          id: 'impl-chat',
          type: 'implement',
          title: '实现消息模块',
          agentId: 'claude',
          files: ['src/chat/**'],
        }),
      },
    };

    const plan = diffDag(
      dagFromFacts(startedReview),
      editRaw((dag) => {
        dag.nodes = dag.nodes.filter((item) => item.id !== 'impl-chat');
      }),
      startedReview,
    );

    expect(plan.applied).toEqual([]);
    expect(plan.rejected).toHaveLength(1);
    expect(plan.rejected[0]?.nodeId).toBe('impl-chat');
    expect(plan.rejected[0]?.reason).toContain('review-chat');
    expect(plan.rejected[0]?.reason).toContain('依赖');
  });
});

describe('buildAmendmentReply', () => {
  it('逐条铺开生效与未生效的改动', () => {
    const text = buildAmendmentReply({
      applied: [
        {
          kind: 'update-node',
          nodeId: 'review-chat',
          fields: [{ field: 'agentId', from: 'claude', to: 'codex' }],
        },
      ],
      rejected: [{ nodeId: 'impl-chat', reason: '节点已经开始执行' }],
    });

    expect(text).toContain('已按指令修改任务图');
    expect(text).toContain('review-chat 的 agentId：claude → codex');
    expect(text).toContain('这些改动没有生效');
    expect(text).toContain('impl-chat：节点已经开始执行');
  });
});

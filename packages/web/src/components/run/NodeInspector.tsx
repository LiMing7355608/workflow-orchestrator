import { ChevronRight, Maximize2 } from 'lucide-react';
import { cn } from '../../lib/cn';
import { displayNodeStatus, nodeStatusMeta, nodeTypeMeta } from '../../lib/workflow-meta';
import type {
  NodeStatus,
  WorkflowNode,
  WorkflowRunDetail,
} from '../../types/workflow';
import { AgentChip } from '../agents/AgentChip';
import { Badge } from '../ui/Badge';
import { Button } from '../ui/Button';
import { CollapsibleText } from '../ui/CollapsibleText';
import { Progress } from '../ui/Progress';

/**
 * 右侧运行概览栏。
 *
 * 它曾经兼任「节点详情」——一个节点四五十条事件被塞进 320px 宽的一列里，
 * 长段落读不动、diff 只能看个开头。现在节点详情搬去了独立的大面板
 * （见 NodeDetailPanel），这一栏回到运行级视角：进度、节点状态统计、待处理
 * 事项、参与 Agent。选中节点只留一条摘要和「展开详情」入口，用来确认
 * 「高亮的是这个」并一键进面板。
 */

interface NodeInspectorProps {
  run: WorkflowRunDetail;
  /** 当前选中的节点，仅用于摘要卡与高亮；详情由 NodeDetailPanel 承载 */
  node: WorkflowNode | null;
  /** 语义不变：用于高亮，以及在概览/摘要里点条目打开详情面板 */
  onSelectNode: (nodeId: string | null) => void;
  className?: string;
}

const statusOrder: NodeStatus[] = [
  'completed',
  'running',
  'waiting_approval',
  'ready',
  // 统计按展示态算，所以「已停止」也要有一格；它与 ready 互斥（见 displayNodeStatus）
  'interrupted',
  'pending',
  'retry',
  'failed',
];

function RunOverview({
  run,
  onSelectNode,
}: {
  run: WorkflowRunDetail;
  onSelectNode: (nodeId: string) => void;
}) {
  const counts: Partial<Record<NodeStatus, number>> = {};
  const agents = new Map<string, { total: number; running: number }>();

  for (const node of run.nodes) {
    // 按展示态统计：被停止的节点在后端仍是 ready，直接计数会让概览里
    // 既看不到「已停止」，又把读者引向「它还在排队」
    counts[displayNodeStatus(node)] =
      (counts[displayNodeStatus(node)] ?? 0) + 1;

    const current = agents.get(node.agent) ?? { total: 0, running: 0 };
    current.total += 1;
    if (node.status === 'running') {
      current.running += 1;
    }
    agents.set(node.agent, current);
  }

  const waitingNodes = run.nodes.filter(
    (node) => node.status === 'waiting_approval',
  );
  const progressTone =
    run.status === 'completed'
      ? 'green'
      : run.status === 'waiting_for_boss'
        ? 'amber'
        : 'blue';

  return (
    <>
      <div className="border-b border-line px-4 py-3">
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-[12px] font-medium text-ink">运行概览</h2>
          <span className="text-[10px] text-passive">
            {run.nodes.length} 个节点
          </span>
        </div>
        {/*
          这里显示完整目标而不是 summary：summary 只截了首段，用户看不到自己
          追加的补充要求（粒度、并行度、审查轮次）。默认折叠两行，需要时展开。
        */}
        <CollapsibleText
          text={run.goal || run.summary}
          lines={2}
          threshold={20}
          className="mt-1 whitespace-pre-line text-[10px] leading-4 text-muted"
        />
      </div>

      <div className="flex-1 space-y-5 overflow-y-auto p-4">
        <section>
          <div className="flex items-center justify-between text-[10px] text-passive">
            <span>总进度</span>
            <span className="tabular-nums">{run.progress}%</span>
          </div>
          <Progress
            value={run.progress}
            tone={progressTone}
            label="运行总进度"
            className="mt-2"
          />
        </section>

        <section>
          <h3 className="text-[10px] font-medium text-muted">节点状态</h3>
          <div className="mt-2 space-y-1.5">
            {statusOrder
              .filter((status) => (counts[status] ?? 0) > 0)
              .map((status) => {
                const meta = nodeStatusMeta[status];
                return (
                  <div
                    key={status}
                    className="flex items-center gap-2 text-[11px]"
                  >
                    <span
                      className={cn('h-1.5 w-1.5 rounded-full', meta.dot)}
                    />
                    <span className="text-muted">{meta.label}</span>
                    <span className="ml-auto tabular-nums text-ink">
                      {counts[status]}
                    </span>
                  </div>
                );
              })}
          </div>
        </section>

        <section>
          <div className="flex items-center justify-between">
            <h3 className="text-[10px] font-medium text-muted">待你处理</h3>
            <span className="text-[10px] text-passive">
              {waitingNodes.length}
            </span>
          </div>

          {waitingNodes.length > 0 ? (
            <div className="mt-2 space-y-1.5">
              {waitingNodes.map((node) => (
                <button
                  key={node.id}
                  type="button"
                  onClick={() => onSelectNode(node.id)}
                  className="flex w-full items-center gap-2 rounded-lg border border-warning/20 bg-warning-soft/60 px-2.5 py-2 text-left transition-colors hover:border-warning/40"
                >
                  <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-warning" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[11px] font-medium text-ink">
                      {node.title}
                    </span>
                    <AgentChip
                      agentId={node.agentId}
                      label={node.agent}
                      className="mt-0.5 text-[10px] text-muted"
                      iconClassName="h-3 w-3"
                    />
                  </span>
                  <ChevronRight
                    className="h-3.5 w-3.5 shrink-0 text-passive"
                    strokeWidth={1.8}
                  />
                </button>
              ))}
            </div>
          ) : (
            <p className="mt-2 text-[11px] text-passive">
              当前没有待处理事项。
            </p>
          )}
        </section>

        <section>
          <h3 className="text-[10px] font-medium text-muted">参与 Agent</h3>
          <div className="mt-2 space-y-2">
            {Array.from(agents.entries()).map(([agentName, info]) => (
              <div
                key={agentName}
                className="flex items-center gap-2 text-[11px]"
              >
                <AgentChip
                  label={agentName}
                  iconOnly
                  className="shrink-0"
                  iconClassName="h-3.5 w-3.5"
                />
                <span className="truncate text-muted">{agentName}</span>
                <span className="ml-auto shrink-0 text-[10px] text-passive">
                  {info.running > 0
                    ? `${info.running} 运行中`
                    : `${info.total} 个节点`}
                </span>
              </div>
            ))}
          </div>
        </section>
      </div>
    </>
  );
}

/**
 * 选中节点摘要。
 *
 * 只在「有选中」时出现，回答两件事：高亮的是哪个节点、点哪儿去看全过程。
 * 它刻意不复述时间线——详情已经在面板里了，这里再抄一遍就等于回到从前。
 */
function SelectedNodeSummary({
  node,
  onOpen,
}: {
  node: WorkflowNode;
  onOpen: (nodeId: string) => void;
}) {
  const typeMeta = nodeTypeMeta[node.type];
  const statusMeta = nodeStatusMeta[displayNodeStatus(node)];
  const Icon = typeMeta.icon;

  return (
    <div className="shrink-0 border-b border-line bg-subtle/30 px-4 py-3">
      <div className="flex items-center gap-2">
        <span
          className={cn(
            'grid h-6 w-6 shrink-0 place-items-center rounded-md',
            typeMeta.tile,
          )}
        >
          <Icon className="h-3 w-3" strokeWidth={1.8} />
        </span>
        <span className="min-w-0 flex-1 truncate text-[11px] font-medium text-ink">
          {node.title}
        </span>
        <Badge tone={statusMeta.tone} dot>
          {statusMeta.label}
        </Badge>
      </div>

      {/*
        把描述也放进来：用户点节点是想知道「这个要做什么」，只给标题等于让他
        再点一次。窄栏里默认两行，长任务书可以就地展开，不必开大面板。
      */}
      {node.description ? (
        <CollapsibleText
          text={node.description}
          lines={2}
          threshold={60}
          className="mt-1.5 text-[11px] leading-4 text-muted"
        />
      ) : null}

      <Button
        size="sm"
        variant="secondary"
        className="mt-2 w-full"
        onClick={() => onOpen(node.id)}
      >
        <Maximize2 className="h-3.5 w-3.5" strokeWidth={1.8} />
        展开节点详情
      </Button>
    </div>
  );
}

export function NodeInspector({
  run,
  node,
  onSelectNode,
  className,
}: NodeInspectorProps) {
  return (
    <aside
      className={cn(
        'flex h-full flex-col overflow-hidden bg-surface max-[1100px]:h-auto max-[1100px]:overflow-visible',
        className,
      )}
    >
      {node ? (
        <SelectedNodeSummary node={node} onOpen={onSelectNode} />
      ) : null}
      <RunOverview run={run} onSelectNode={onSelectNode} />
    </aside>
  );
}

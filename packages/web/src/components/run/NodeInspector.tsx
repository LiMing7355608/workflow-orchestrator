import {
  ArrowLeft,
  ChevronRight,
  FileCode2,
  GitBranch,
  ShieldAlert,
  X,
} from 'lucide-react';
import { useState } from 'react';
import { decideApproval } from '../../lib/api';
import { cn } from '../../lib/cn';
import { formatDuration } from '../../lib/format';
import { nodeStatusMeta, nodeTypeMeta } from '../../lib/workflow-meta';
import type {
  NodeStatus,
  WorkflowNode,
  WorkflowRunDetail,
} from '../../types/workflow';
import { AgentChip } from '../agents/AgentChip';
import { Badge } from '../ui/Badge';
import { Button } from '../ui/Button';
import { Progress } from '../ui/Progress';

interface NodeInspectorProps {
  run: WorkflowRunDetail;
  node: WorkflowNode | null;
  onSelectNode: (nodeId: string | null) => void;
  /** 审批落盘后刷新运行详情 */
  onApprovalDecided?: () => void;
  className?: string;
}

const statusOrder: NodeStatus[] = [
  'completed',
  'running',
  'waiting_approval',
  'ready',
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
    counts[node.status] = (counts[node.status] ?? 0) + 1;

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
        <p className="mt-1 text-[10px] leading-4 text-muted">{run.summary}</p>
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

/** 审批人。演示阶段固定为当前审批小组，接入身份后由会话决定。 */
const ACTOR = '第二组';

function ApprovalActions({
  runId,
  node,
  onDone,
}: {
  runId: string;
  node: WorkflowNode;
  onDone?: () => void;
}) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState<'approve' | 'reject' | 'handoff' | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);

  async function submit(decision: 'approve' | 'reject' | 'handoff') {
    setBusy(decision);
    setError(null);
    const result = await decideApproval(runId, node.id, {
      decision,
      actor: ACTOR,
      reason: reason.trim() || undefined,
    });
    setBusy(null);
    if (!result) {
      // 后端没接上时不谎报成功
      setError('后端未响应，审批没有提交。');
      return;
    }
    setReason('');
    onDone?.();
  }

  return (
    <div className="px-4 py-3">
      <div className="rounded-lg border border-warning/20 bg-warning-soft/70 p-3">
        <div className="flex items-center gap-2 text-[11px] font-medium text-warning">
          <ShieldAlert className="h-3.5 w-3.5" strokeWidth={1.8} />
          等待人工审批
        </div>
        <p className="mt-1.5 text-[10px] leading-4 text-muted">
          批准推进下游；驳回把上游「{node.dependsOn[0] ?? '无依赖'}」退回重做，
          已跑完的下游一并作废；转交追加一条新的审批记录。
        </p>

        <input
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          placeholder="审批理由（可选）"
          aria-label="审批理由"
          className="mt-2.5 h-7 w-full rounded-md border border-line bg-surface px-2 text-[11px] text-ink placeholder:text-passive transition-colors focus:border-line-strong focus:outline-none focus:ring-2 focus:ring-accent/20"
        />

        <div className="mt-2 flex items-center gap-1.5">
          <Button
            size="sm"
            onClick={() => void submit('approve')}
            disabled={busy !== null}
          >
            {busy === 'approve' ? '提交中' : '批准'}
          </Button>
          <Button
            size="sm"
            variant="secondary"
            onClick={() => void submit('reject')}
            disabled={busy !== null}
          >
            驳回
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => void submit('handoff')}
            disabled={busy !== null}
          >
            转交
          </Button>
        </div>

        {error ? (
          <p className="mt-2 text-[10px] leading-4 text-danger">{error}</p>
        ) : null}
      </div>
    </div>
  );
}

function NodeDetail({
  run,
  node,
  onSelectNode,
  onApprovalDecided,
}: {
  run: WorkflowRunDetail;
  node: WorkflowNode;
  onSelectNode: (nodeId: string | null) => void;
  onApprovalDecided?: () => void;
}) {
  const typeMeta = nodeTypeMeta[node.type];
  const statusMeta = nodeStatusMeta[node.status];
  const Icon = typeMeta.icon;
  const dependencies = node.dependsOn.map((id) => ({
    id,
    title: run.nodes.find((item) => item.id === id)?.title ?? id,
  }));

  return (
    <>
      <div className="flex items-center gap-2 border-b border-line px-4 py-3">
        <button
          type="button"
          onClick={() => onSelectNode(null)}
          className="inline-flex items-center gap-1 text-[11px] text-muted transition-colors hover:text-ink"
        >
          <ArrowLeft className="h-3.5 w-3.5" strokeWidth={1.8} />
          概览
        </button>
        <button
          type="button"
          aria-label="关闭节点详情"
          onClick={() => onSelectNode(null)}
          className="ml-auto grid h-6 w-6 place-items-center rounded-md text-passive transition-colors hover:bg-subtle hover:text-ink"
        >
          <X className="h-3.5 w-3.5" strokeWidth={1.8} />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto">
        <div className="border-b border-line px-4 py-4">
          <div className="flex items-center gap-2">
            <span
              className={cn(
                'grid h-7 w-7 place-items-center rounded-md',
                typeMeta.tile,
              )}
            >
              <Icon className="h-3.5 w-3.5" strokeWidth={1.8} />
            </span>
            <span className="text-[10px] text-muted">
              {typeMeta.label}节点
            </span>
            <Badge tone={statusMeta.tone} dot className="ml-auto">
              {statusMeta.label}
            </Badge>
          </div>

          <h2 className="mt-2 text-[15px] font-medium leading-5 text-ink">
            {node.title}
          </h2>
          <p className="mt-1 text-[11px] leading-5 text-muted">
            {node.description}
          </p>
        </div>

        <div className="border-b border-line px-4 py-3">
          <div className="grid grid-cols-2 gap-3 text-[11px]">
            <div>
              <span className="block text-[10px] text-passive">
                执行 Agent
              </span>
              <AgentChip
                agentId={node.agentId}
                label={node.agent}
                className="mt-1 text-ink"
                iconClassName="h-3.5 w-3.5"
              />
            </div>
            <div>
              <span className="block text-[10px] text-passive">耗时</span>
              <span className="mt-1 block tabular-nums text-ink">
                {formatDuration(node.durationMs)}
              </span>
            </div>
            <div>
              <span className="block text-[10px] text-passive">
                尝试次数
              </span>
              <span className="mt-1 block tabular-nums text-ink">
                {node.attempts}
              </span>
            </div>
            <div>
              <span className="block text-[10px] text-passive">
                上游依赖
              </span>
              <span className="mt-1 block tabular-nums text-ink">
                {node.dependsOn.length}
              </span>
            </div>
          </div>
        </div>

        <div className="border-b border-line px-4 py-3">
          <h3 className="flex items-center gap-1.5 text-[10px] font-medium text-muted">
            <GitBranch className="h-3 w-3" strokeWidth={1.8} />
            依赖
          </h3>

          {dependencies.length > 0 ? (
            <div className="mt-2 space-y-1.5">
              {dependencies.map((dependency) => (
                <button
                  key={dependency.id}
                  type="button"
                  onClick={() => onSelectNode(dependency.id)}
                  className="flex w-full items-center gap-2 rounded-md border border-line bg-subtle/40 px-2 py-1.5 text-left text-[11px] text-muted transition-colors hover:border-line-strong hover:text-ink"
                >
                  <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-passive" />
                  <span className="truncate">{dependency.title}</span>
                  <ChevronRight
                    className="ml-auto h-3 w-3 shrink-0 text-passive"
                    strokeWidth={1.8}
                  />
                </button>
              ))}
            </div>
          ) : (
            <p className="mt-2 text-[11px] text-passive">无上游依赖</p>
          )}
        </div>

        <div className="border-b border-line px-4 py-3">
          <h3 className="flex items-center gap-1.5 text-[10px] font-medium text-muted">
            <FileCode2 className="h-3 w-3" strokeWidth={1.8} />
            文件范围
          </h3>

          {node.files.length > 0 ? (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {node.files.map((file) => (
                <code
                  key={file}
                  className="rounded border border-line bg-subtle/60 px-1.5 py-0.5 font-mono text-[10px] text-muted"
                >
                  {file}
                </code>
              ))}
            </div>
          ) : (
            <p className="mt-2 text-[11px] text-passive">
              该节点不独占文件
            </p>
          )}
        </div>

        {node.status === 'waiting_approval' ? (
          <ApprovalActions
            runId={run.id}
            node={node}
            onDone={onApprovalDecided}
          />
        ) : null}
      </div>
    </>
  );
}

export function NodeInspector({
  run,
  node,
  onSelectNode,
  onApprovalDecided,
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
        <NodeDetail
          run={run}
          node={node}
          onSelectNode={onSelectNode}
          onApprovalDecided={onApprovalDecided}
        />
      ) : (
        <RunOverview run={run} onSelectNode={onSelectNode} />
      )}
    </aside>
  );
}

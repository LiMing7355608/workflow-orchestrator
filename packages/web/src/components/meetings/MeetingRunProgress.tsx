import { ArrowUpRight, GitBranch } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { fetchRunDetail, resumeRun, stopRun } from '../../lib/api';
import { useApiResource, useLiveRefresh } from '../../lib/use-api';
import { displayNodeStatus, nodeStatusMeta } from '../../lib/workflow-meta';
import { RunStatusBadge } from '../run/RunStatusBadge';
import { NodeDetailPanel } from '../run/NodeDetailPanel';
import { OrchestratorPanel } from '../run/OrchestratorPanel';
import { PlanReviewPanel, PlanningSteps } from '../run/PlanReviewPanel';
import { Button, buttonStyles } from '../ui/Button';
import { Card } from '../ui/Card';

export function MeetingRunProgress({ id }: { id: string }) {
  const { data: run, source, loading, reload } = useApiResource(() => fetchRunDetail(id), null);
  useLiveRefresh(source === 'live', reload, { runId: id, refreshIntervalMs: 500 });
  const [discuss, setDiscuss] = useState(false);
  const [nodeId, setNodeId] = useState<string | null>(null);
  const [review, setReview] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState('');

  async function pauseOrResume() {
    if (!run) return;
    setBusy(true);
    setFailure('');
    try {
      const response = await (run.status === 'paused' ? resumeRun(id) : stopRun(id));
      if (!response) throw new Error('操作失败，请重试。');
      reload();
    } catch (error) { setFailure((error as Error).message); }
    finally { setBusy(false); }
  }

  return <Card className="space-y-3 p-4" aria-label="关联任务拆解">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <h2 className="flex items-center gap-2 text-sm font-semibold text-ink"><GitBranch className="size-4 text-accent" />关联任务拆解</h2>
      <Link to={'/runs/' + id} className={buttonStyles({ variant: 'ghost', size: 'sm' })}>运行详情<ArrowUpRight className="size-3.5" /></Link>
    </div>
    {!run ? <p className="text-xs text-muted">{loading ? '正在读取运行进度…' : '无法读取关联运行。'}</p> : <>
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
        <strong className="min-w-0 flex-1 break-words text-ink">{run.title}</strong>
        <RunStatusBadge status={run.status} hasGraph={run.nodes.length > 0} /><span>{run.progress}%</span>
      </div>
      {run.nodes.length === 0 && !run.planFailure &&
        <PlanningSteps phase={run.planDraft ? 'approval' : run.planCheckingAt ? 'checking' : 'drafting'} />}
      {run.planFailure && <p className="text-xs text-danger">{run.planFailure.message}</p>}
      <div className="flex flex-wrap gap-2">
        {['paused', 'draft', 'running', 'waiting_for_boss'].includes(run.status) && <Button size="sm" variant="secondary" disabled={busy}
          onClick={() => void pauseOrResume()}>{run.status === 'paused' ? '继续运行' : '暂停运行'}</Button>}
        <Button size="sm" variant="secondary" onClick={() => setDiscuss(true)}>和编排器对话</Button>
        {run.planDraft && <Button size="sm" variant="secondary" aria-expanded={review} onClick={() => setReview(!review)}>
          {review ? '收起草案' : '审核待确认草案'}
        </Button>}
      </div>
      {failure && <p role="alert" className="text-xs text-danger">{failure}</p>}
      {run.planDraft && review && <div className="h-[min(68dvh,600px)] overflow-hidden rounded-lg border border-line">
        <PlanReviewPanel key={run.planDraft.revision} runId={id} revision={run.planDraft.revision} at={run.planDraft.at}
          paused={run.status === 'paused'} onCommit={reload} onDiscuss={() => setDiscuss(true)} />
      </div>}
      {run.nodes.length > 0 && <details className="rounded-lg border border-line">
        <summary className="cursor-pointer rounded-lg px-3 py-2 text-xs font-medium text-ink">{run.nodes.length} 个任务节点</summary>
        <div className="max-h-72 divide-y divide-line overflow-auto border-t border-line">
          {run.nodes.map((node) => <button type="button" key={node.id} onClick={() => setNodeId(node.id)}
            className="flex w-full items-center gap-3 px-3 py-2 text-left text-xs hover:bg-subtle">
            <span className="min-w-0 flex-1 break-words text-ink">{node.title}</span>
            <span className="shrink-0 text-muted">{nodeStatusMeta[displayNodeStatus(node)].label}</span>
          </button>)}
        </div>
      </details>}
      <OrchestratorPanel run={run} open={discuss} onClose={() => setDiscuss(false)} onRunChanged={reload} />
      <NodeDetailPanel run={run} node={run.nodes.find((node) => node.id === nodeId) ?? null}
        onClose={() => setNodeId(null)} onSelectNode={setNodeId} onRunChanged={reload} />
    </>}
  </Card>;
}

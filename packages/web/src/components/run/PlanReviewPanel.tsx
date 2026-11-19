import { Check, Circle, CircleAlert, GitBranch, ListTree, Loader2, MessageSquare } from 'lucide-react';
import { useCallback, useState } from 'react';
import { confirmPlanDraft, fetchPlanDraft } from '../../lib/api';
import { useApiResource } from '../../lib/use-api';
import type { PlanDraftView } from '../../types/operations';
import { Button } from '../ui/Button';

type DraftNode = PlanDraftView['dag']['nodes'][number];
const nodeNames = { implement: '实现', review: '审查', approval: '人工审批', route: '编排动作' };

function groupByDependency(nodes: DraftNode[]) {
  const remaining = new Map(nodes.map((node) => [node.id, node]));
  const reached = new Set<string>();
  const rows: DraftNode[][] = [];
  while (remaining.size) {
    const row = [...remaining.values()].filter((node) => node.dependsOn.every((id) => reached.has(id)));
    if (!row.length) break;
    rows.push(row);
    for (const node of row) { reached.add(node.id); remaining.delete(node.id); }
  }
  return rows;
}

export function PlanningSteps({ phase }: { phase: 'drafting' | 'checking' | 'approval' }) {
  const current = phase === 'drafting' ? 0 : phase === 'checking' ? 1 : 2;
  return (
    <ol className="grid grid-cols-3 gap-2 border-b border-line bg-surface px-4 py-3" aria-label="拆解进程">
      {['规格与任务分解', '结构与覆盖核对', '人工确认'].map((step, index) => {
        const Icon = index < current ? Check : index === current && index < 2 ? Loader2 : Circle;
        return (
          <li key={step} aria-current={index === current ? 'step' : undefined}
            className={`flex items-center gap-1.5 rounded-lg px-2 py-2 text-[11px] font-medium ${index === current ? 'bg-accent-soft text-accent' : 'text-muted'}`}>
            <Icon className={`size-3 shrink-0 ${index === current && index < 2 ? 'animate-spin motion-reduce:animate-none' : ''}`} />
            {step}
          </li>
        );
      })}
    </ol>
  );
}

export function PlanReviewPanel({ runId, revision, paused, onDiscuss, onCommit }: {
  runId: string; revision: string; paused: boolean; onDiscuss: () => void; onCommit: () => void;
}) {
  const read = useCallback((signal?: AbortSignal) => fetchPlanDraft(runId, signal), [runId, revision]);
  const { data, loading, reload } = useApiResource(read, null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const plan = data?.revision === revision ? data : null;
  const groups = plan ? groupByDependency(plan.dag.nodes) : [];
  const openIssues = plan?.verification.findings.filter((finding) => finding.severity === 'required').length ?? 0;

  async function approve() {
    setBusy(true);
    setError('');
    try { await confirmPlanDraft(runId, revision); onCommit(); }
    catch (failure) { setError((failure as Error).message); }
    finally { setBusy(false); }
  }

  return (
    <section className="flex h-full min-h-0 flex-col bg-canvas" aria-label="任务草案">
      <PlanningSteps phase="approval" />
      <div className="min-h-0 flex-1 overflow-auto p-4 sm:p-5">
        <div className="mx-auto max-w-[960px] space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <h2 className="text-lg font-semibold text-ink">任务草案</h2>
              {plan && <p className="mt-0.5 text-xs text-muted">{plan.dag.nodes.length} 个节点 · {groups.length} 层依赖 · {plan.attempts} 次生成尝试</p>}
            </div>
            <div className="flex flex-wrap gap-2">
              <Button variant="secondary" size="sm" onClick={onDiscuss}><MessageSquare className="size-3.5" />补充或要求重拆</Button>
              <Button size="sm" onClick={() => void approve()} disabled={!plan || busy || paused}>{busy ? '正在提交…' : openIssues ? '带待核项确认并派发' : '确认草案并派发'}</Button>
            </div>
          </div>
          {error && <p role="alert" className="text-xs text-danger">{error}</p>}
          {paused && <p role="status" className="text-xs text-muted">运行已暂停，继续后可以确认草案。</p>}
          {!plan ? <div className="py-6 text-xs text-muted">{loading ? '正在读取草案…' : <Button size="sm" variant="secondary" onClick={reload}>重读草案</Button>}</div> : (
            <>
              <div className="rounded-xl border border-line bg-surface p-4">
                <div className="flex items-center gap-2 text-sm font-semibold text-ink">
                  {openIssues || plan.verification.status === 'unavailable' ? <CircleAlert className="size-4 text-warning" /> : <Check className="size-4 text-success" />}
                  核对结果
                </div>
                <p className="mt-2 text-xs leading-5 text-muted">通过结构校验 · 依赖有效 · 图无环 · 并行实现范围无重叠</p>
                <p className="mt-1 break-words text-xs leading-5 text-ink">{plan.verification.status === 'unavailable' ? '交叉核对未完成。' : '交叉核对反馈。'} {plan.verification.summary}</p>
                {plan.verification.findings.length > 0 && <ul className="mt-2 space-y-1.5">
                  {plan.verification.findings.map((finding, index) => <li key={index} className="rounded bg-subtle px-2 py-1.5 text-[11px] leading-5 text-ink">
                    <strong className={finding.severity === 'required' ? 'text-warning' : 'text-muted'}>{finding.severity === 'required' ? '待修正' : '建议'}</strong> {finding.text}
                    {finding.nodeIds.length > 0 && <span className="ml-2 font-mono text-muted">{finding.nodeIds.join(' · ')}</span>}
                  </li>)}
                </ul>}
              </div>
              <div className="space-y-2">
                <h3 className="flex items-center gap-2 text-sm font-semibold text-ink"><ListTree className="size-4 text-accent" />按依赖展开</h3>
                {groups.map((group, index) => <details key={index} open={index === 0} className="rounded-xl border border-line bg-surface">
                  <summary className="cursor-pointer px-3 py-2.5 text-xs font-semibold text-ink">第 {index + 1} 层 · {group.length} 个节点</summary>
                  <div className="divide-y divide-line border-t border-line px-3">
                    {group.map((node) => <details key={node.id} className="py-2.5">
                      <summary className="cursor-pointer text-xs text-ink"><span className="mr-2 text-accent">{nodeNames[node.type]}</span>{node.title}</summary>
                      <div className="space-y-1.5 pl-3 pt-2 text-xs text-muted">
                        <p className="whitespace-pre-wrap break-words leading-5">{node.description}</p>
                        {node.dependsOn.length > 0 && <p className="flex items-start gap-1.5"><GitBranch className="mt-0.5 size-3 shrink-0" />依赖 {node.dependsOn.join('、')}</p>}
                        {node.agentId && <p>Agent {node.agentId}</p>}
                        {node.files.length > 0 && <p className="break-words font-mono">{node.files.join('、')}</p>}
                      </div>
                    </details>)}
                  </div>
                </details>)}
              </div>
            </>
          )}
        </div>
      </div>
    </section>
  );
}

import { ArrowDown, Check, ChevronDown, Circle, CircleAlert, Copy, Download, Folder, Layers3, Loader2, MessageSquare } from 'lucide-react';
import { useMemo, useState } from 'react';
import { confirmPlanDraft, fetchBlackboard, fetchPlanDraft } from '../../lib/api';
import { cn } from '../../lib/cn';
import { formatClock, formatDateTime } from '../../lib/format';
import { useApiResource, useLiveRefresh } from '../../lib/use-api';
import { displayNodeStatus, nodeStatusMeta, nodeTypeMeta } from '../../lib/workflow-meta';
import type { PlanDraftView } from '../../types/operations';
import type { NodeType, SavedTaskFiles, TaskDeliverable, WorkflowNode, WorkflowRunDetail } from '../../types/workflow';
import { Button, buttonStyles } from '../ui/Button';
import { NodeTimes, TaskBreakdown } from './TaskBreakdown';

interface PlanTask {
  id: string;
  title: string;
  type: NodeType;
  description: string;
  dependsOn: string[];
  files: string[];
  agentId?: string;
  agent?: string;
  deliverables?: TaskDeliverable[];
  acceptance?: string[];
  delivery?: SavedTaskFiles;
}

function groupByDependency(tasks: PlanTask[]) {
  const remaining = new Map(tasks.map((node) => [node.id, node]));
  const reached = new Set<string>();
  const groups: PlanTask[][] = [];
  while (remaining.size > 0) {
    const ready = [...remaining.values()].filter((node) => node.dependsOn.every((id) => reached.has(id)));
    if (ready.length === 0) return [...groups, [...remaining.values()]];
    groups.push(ready);
    for (const node of ready) {
      reached.add(node.id);
      remaining.delete(node.id);
    }
  }
  return groups;
}

export function PlanningSteps({ phase }: { phase: 'drafting' | 'checking' | 'approval' }) {
  const current = phase === 'drafting' ? 0 : phase === 'checking' ? 1 : 2;
  return <ol className="grid grid-cols-3 gap-2 border-b border-line bg-surface px-4 py-2.5" aria-label="拆解进程">
    {['任务拆解', '核对交付与验收', '人工确认'].map((step, index) => {
      const Icon = index < current ? Check : index === current && index < 2 ? Loader2 : Circle;
      return <li key={step} aria-current={index === current ? 'step' : undefined}
        className={cn('flex items-center gap-1.5 rounded-lg px-2.5 py-2 text-xs font-medium', index === current ? 'bg-accent-soft text-accent' : 'text-muted')}>
        <Icon className={cn('size-3.5 shrink-0', index === current && index < 2 && 'animate-spin motion-reduce:animate-none')} />
        {step}
      </li>;
    })}
  </ol>;
}

function PlanFiles({ runId, draft, directory, archive }: { runId: string; draft?: boolean; directory?: string | null; archive?: boolean }) {
  const base = '/api/runs/' + encodeURIComponent(runId);
  return <section className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-line bg-surface px-3 py-2.5" aria-label="已写入的规划文件">
    <div className="min-w-0">
      <p className="flex items-center gap-1.5 text-xs font-semibold text-ink"><Folder className="size-3.5 shrink-0 text-accent" />本地文件</p>
      {directory && <p className="mt-1 break-all font-mono text-[10px] text-muted">{directory}</p>}
    </div>
    <div className="flex flex-wrap gap-1.5">
      {['spec.md', draft ? 'plan-draft.json' : 'plan.json'].map((name) => <a key={name} href={base + '/plan-files/' + name}
        className={buttonStyles({ size: 'sm', variant: 'secondary', className: 'font-mono text-[11px]' })}>
        <Download className="size-3" />{name}
      </a>)}
      {archive && <a href={base + '/output'} className={buttonStyles({ size: 'sm', variant: 'secondary' })}><Download className="size-3.5" />下载集成 ZIP</a>}
    </div>
  </section>;
}

function TaskPlan({
  runId, tasks, liveNodes, onDetails,
}: {
  runId: string; tasks: PlanTask[];
  liveNodes?: WorkflowNode[];
  onDetails?: (id: string) => void;
}) {
  const groups = useMemo(() => groupByDependency(tasks), [tasks]);
  const labels = useMemo(() => new Map(tasks.map((task) => [task.id, task.title])), [tasks]);
  const actual = useMemo(() => new Map(liveNodes?.map((node) => [node.id, node])), [liveNodes]);
  const [opened, setOpened] = useState<Set<string>>(() => new Set());
  const [collapsed, setCollapsed] = useState<Set<number>>(() => new Set());
  const fileCount = tasks.reduce((sum, task) => sum + (task.deliverables?.filter((item) => item.kind !== 'remove').length ?? 0), 0);
  const finished = liveNodes?.filter((node) => node.status === 'completed').length;

  function toggle<T>(previous: Set<T>, key: T) {
    const next = new Set(previous);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    return next;
  }

  return <section aria-label="分层任务清单" className="space-y-3">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <div>
        <h3 className="flex items-center gap-2 text-sm font-semibold text-ink"><Layers3 className="size-4 text-accent" />按依赖展开</h3>
        <p className="mt-0.5 text-[11px] text-muted">{tasks.length} 个节点 · {groups.length} 个依赖层 · {fileCount} 项计划文件{finished !== undefined && ' · ' + finished + ' 个已完成'}</p>
      </div>
      <div className="flex gap-0.5">
        <Button variant="ghost" size="sm" onClick={() => { setCollapsed(new Set()); setOpened(new Set(tasks.map((task) => task.id))); }}>展开全部</Button>
        <Button variant="ghost" size="sm" onClick={() => setOpened(new Set())}>收起详情</Button>
      </div>
    </div>
    {groups.map((group, index) => {
      const shown = !collapsed.has(index);
      return <div key={index} className="overflow-hidden rounded-xl border border-line bg-surface">
        <button type="button" aria-expanded={shown} onClick={() => setCollapsed((current) => toggle(current, index))}
          className="flex w-full items-center gap-2 bg-subtle/55 px-3.5 py-2.5 text-left font-medium hover:bg-subtle">
          <span className="grid size-5 place-items-center rounded-md bg-surface text-[10px] tabular-nums text-accent">{index + 1}</span>
          <span className="text-xs text-ink">依赖层 {index + 1}</span>
          <span className="text-[11px] text-muted">{group.length} 项{group.length > 1 && ' · 无层内依赖'}</span>
          <ChevronDown className={cn('ml-auto size-4 text-muted transition-transform motion-reduce:transition-none', !shown && '-rotate-90')} />
        </button>
        {shown && <div className="divide-y divide-line border-t border-line">
          {group.map((task) => {
            const node = actual.get(task.id);
            const meta = nodeTypeMeta[task.type];
            const status = node && nodeStatusMeta[displayNodeStatus(node)];
            const expanded = opened.has(task.id);
            return <article key={task.id} className={cn(expanded && 'bg-accent-soft/15')}>
              <button type="button" aria-expanded={expanded} onClick={() => setOpened((current) => toggle(current, task.id))}
                className="grid w-full grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2.5 px-3.5 py-2.5 text-left hover:bg-subtle/45">
                <span className={cn('grid size-8 shrink-0 place-items-center rounded-lg', meta.tile)}><meta.icon className="size-4" /></span>
                <span className="min-w-0">
                  <span className="block break-words text-xs font-semibold text-ink">{task.title}</span>
                  <span className="mt-0.5 flex flex-wrap gap-x-1.5 text-[10px] text-muted">
                    <span>{meta.label}</span>{task.type === 'route' ? <span>· 编排器</span> : (task.agent || task.agentId) && <span>· {task.agent || task.agentId}</span>}
                    {Boolean(task.delivery || task.deliverables?.length) && <span>· {task.delivery ? `已落盘 ${task.delivery.fileCount} 项` : `计划交付 ${task.deliverables?.length} 项`}</span>}
                  </span>
                </span>
                <span className="flex items-center gap-2">
                  {status && <span className={cn('text-[10px]', status.text)}>{status.label}</span>}
                  <ChevronDown className={cn('size-3.5 text-muted transition-transform motion-reduce:transition-none', !expanded && '-rotate-90')} />
                </span>
              </button>
              {expanded && <div className="space-y-2.5 px-4 pb-3 pl-[54px]">
                {node && <NodeTimes node={node} />}
                {node?.failureReason && <p className="break-words rounded bg-red-50 px-2 py-1.5 text-xs text-danger">{node.failureReason}</p>}
                <TaskBreakdown task={task} runId={runId} dependencies={labels} onSelectNode={onDetails} />
                {onDetails && <Button size="sm" variant="secondary" onClick={() => onDetails(task.id)}>打开节点记录</Button>}
              </div>}
            </article>;
          })}
        </div>}
      </div>;
    })}
  </section>;
}

export function PlanReviewPanel({ runId, revision, at, paused, onDiscuss, onCommit }: {
  runId: string; revision: string; at: string; paused: boolean; onDiscuss: () => void; onCommit: () => void;
}) {
  const { data, loading, reload } = useApiResource(() => fetchPlanDraft(runId), null);
  const { data: board } = useApiResource(() => fetchBlackboard(runId), null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const plan = data?.revision === revision ? data : null;
  const openIssues = plan?.verification.findings.filter((finding) => finding.severity === 'required').length ?? 0;

  async function approve() {
    setBusy(true);
    setError('');
    try { await confirmPlanDraft(runId, revision); onCommit(); }
    catch (failure) { setError((failure as Error).message); }
    finally { setBusy(false); }
  }

  return <section className="flex h-full min-h-0 flex-col bg-canvas" aria-label="任务草案">
    <PlanningSteps phase="approval" />
    <div className="min-h-0 flex-1 overflow-auto p-4 sm:p-5">
      <div className="mx-auto max-w-[980px] space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h2 className="text-xl font-semibold tracking-tight text-ink">任务草案</h2>
            <p className="mt-1 text-[11px] text-muted">生成于 <time dateTime={at}>{formatDateTime(at)} · {formatClock(at)}</time>{plan && ' · ' + plan.attempts + ' 次生成尝试'}</p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" size="sm" onClick={onDiscuss}><MessageSquare className="size-3.5" />补充或要求重拆</Button>
            <Button size="sm" disabled={!plan || busy || paused} onClick={() => void approve()}>{busy ? '正在提交…' : openIssues ? '带待核项确认并派发' : '确认草案并派发'}</Button>
          </div>
        </div>
        {(error || paused) && <p role="status" className={cn('text-xs', error ? 'text-danger' : 'text-muted')}>{error || '运行已暂停，继续后可以确认草案。'}</p>}
        {plan ? <>
          <PlanFiles runId={runId} draft directory={board?.directory} />
          <Verification verification={plan.verification} tasks={plan.dag.nodes} />
          <TaskPlan runId={runId} tasks={plan.dag.nodes} />
        </> : <div className="py-6 text-xs text-muted">{loading ? '正在读取草案…' : <Button size="sm" variant="secondary" onClick={reload}>重读草案</Button>}</div>}
      </div>
    </div>
  </section>;
}

function Verification({ verification, tasks }: { verification: PlanDraftView['verification']; tasks: PlanTask[] }) {
  const required = verification.findings.some((finding) => finding.severity === 'required');
  const needsAttention = required || verification.status === 'unavailable';
  const Icon = needsAttention ? CircleAlert : Check;
  const labels = new Map(tasks.map((task) => [task.id, task.title]));
  return <details open={needsAttention} className="group rounded-xl border border-line bg-surface">
    <summary className="flex cursor-pointer list-none items-center gap-2 px-3.5 py-2.5 text-xs font-semibold text-ink">
      <Icon className={cn('size-4', needsAttention ? 'text-warning' : 'text-success')} />
      核对结果
      <span className="font-normal text-muted">{verification.status === 'unavailable' ? '交叉核对未完成' : '已交叉核对 · ' + verification.findings.length + ' 条反馈'}</span>
      <ChevronDown className="ml-auto size-3.5 -rotate-90 text-muted group-open:rotate-0" />
    </summary>
    <div className="space-y-2 border-t border-line px-3.5 py-2.5 text-xs leading-5 text-muted">
      <p>结构、依赖、环路和并行范围已校验。</p>
      <p className="break-words text-ink">{verification.summary}</p>
      {verification.findings.length > 0 && <ul className="space-y-1">
        {verification.findings.map((finding, index) => <li key={index} className="rounded-md bg-subtle px-2 py-1.5">
          <strong className={finding.severity === 'required' ? 'text-warning' : 'text-ink'}>{finding.severity === 'required' ? '待修正' : '建议'}</strong> {finding.text}
          {finding.nodeIds.length > 0 && <span className="mt-0.5 block text-[11px]">{finding.nodeIds.map((id) => labels.get(id) ?? id).join(' · ')}</span>}
        </li>)}
      </ul>}
    </div>
  </details>;
}

export function RunPlanPanel({ run, live, onSelectNode }: { run: WorkflowRunDetail; live: boolean; onSelectNode: (id: string) => void }) {
  const { data: board, source, reload } = useApiResource(() => live ? fetchBlackboard(run.id) : Promise.resolve(null), null);
  useLiveRefresh(source === 'live', reload, { runId: run.id, refreshIntervalMs: 700 });
  const integration = run.nodes.filter((node) => node.type === 'route' && node.delivery)
    .sort((a, b) => (b.finishedAt ?? '').localeCompare(a.finishedAt ?? ''))[0];
  const [copyNotice, setCopyNotice] = useState('');
  const separator = board?.directory?.includes('\\') ? '\\' : '/';
  const outputDirectory = integration?.delivery && board?.directory
    ? [board.directory, 'output', integration.delivery.revision].join(separator) : undefined;
  async function copyDirectory() {
    if (!outputDirectory) return;
    try {
      await navigator.clipboard.writeText(outputDirectory);
      setCopyNotice('已复制');
    } catch {
      setCopyNotice('请手动选中路径复制');
    }
  }
  return <section className="workspace-scroll h-full bg-canvas p-4 sm:p-5" aria-label="任务拆解" tabIndex={0}>
    <div className="mx-auto max-w-[980px] space-y-3">
      <h2 className="text-xl font-semibold tracking-tight text-ink">任务拆解</h2>
      {(board?.directory || board?.hasOutput) && <PlanFiles runId={run.id} directory={board?.directory} archive={board?.hasOutput} />}
      {outputDirectory && <div className="flex flex-wrap items-start justify-between gap-2 rounded-xl border border-emerald-200 bg-emerald-50/65 px-3.5 py-2.5 text-xs">
        <div className="min-w-0 flex-1">
          <p className="flex items-center gap-1.5 font-semibold text-emerald-800"><ArrowDown className="size-3.5" />交付目录 · {integration?.delivery?.fileCount} 个文件</p>
          <p className="mt-1 select-all break-all font-mono text-[10px] text-emerald-900">{outputDirectory}</p>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <span className="text-[10px] text-emerald-800" role="status">{copyNotice}</span>
          <Button size="sm" variant="secondary" onClick={() => void copyDirectory()}><Copy className="size-3.5" />复制路径</Button>
        </div>
      </div>}
      <TaskPlan tasks={run.nodes} liveNodes={run.nodes} runId={run.id} onDetails={onSelectNode} />
    </div>
  </section>;
}

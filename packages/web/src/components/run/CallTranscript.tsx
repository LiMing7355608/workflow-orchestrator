import { Clock3, FileText } from 'lucide-react';
import { useState } from 'react';
import { modelLabel } from '../agents/AgentModelField';
import { compactOutput, replyFromOutput } from '../../lib/agent-output';
import { fetchAgentActivity } from '../../lib/api';
import { formatDateTime } from '../../lib/format';
import { eventToolLabel } from '../../lib/workflow-meta';
import { useApiResource, useLiveRefresh } from '../../lib/use-api';
import type { AgentInterval } from '../../types/operations';
import type { WorkflowRunDetail } from '../../types/workflow';
import { Button } from '../ui/Button';
import { CollapsibleText } from '../ui/CollapsibleText';
import { AgentReply } from './AgentReply';

export function CallTranscript({ initial, run, onShowAll }: {
  initial: AgentInterval;
  run: WorkflowRunDetail;
  onShowAll: () => void;
}) {
  const { data, reload, source } = useApiResource(
    () => fetchAgentActivity(run.id), null,
  );
  const call = data?.intervals.find((item) => item.id === initial.id) ?? initial;
  useLiveRefresh(!call.finishedAt && source === 'live', reload, { runId: run.id, refreshIntervalMs: 750 });
  const [fullTrace, setFullTrace] = useState(false);
  const output = run.events.filter((item) =>
    item.kind && (initial.nodeId ? item.nodeId === initial.nodeId : !item.nodeId) &&
    (item.agent === call.agentLabel || item.agent === call.agentId) &&
    item.at >= call.startedAt && (!call.finishedAt || item.at <= call.finishedAt));
  const reply = replyFromOutput(output);
  const trace = compactOutput(output.filter((item) => item.kind !== 'result' && item.kind !== 'text' && item.kind !== 'usage'), 'message');
  const visible = fullTrace ? trace : trace.slice(-24);

  return <section aria-label="本次 Agent 对话" className="space-y-3">
    <div className="rounded-xl border border-line bg-subtle/35 px-3 py-2.5">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="break-words text-sm font-semibold text-ink">{call.title}</h3>
          <p className="text-[11px] text-muted">{call.agentLabel}{call.model && ' · ' + modelLabel(call.model)}</p>
        </div>
        <Button size="sm" variant="secondary" onClick={onShowAll}>编排器全部对话</Button>
      </div>
      <p className="mt-2 flex flex-wrap items-center gap-1.5 text-[10px] text-muted">
        <Clock3 className="size-3.5" />
        <time dateTime={call.startedAt}>{formatDateTime(call.startedAt)}</time>
        {call.finishedAt && <>到 <time dateTime={call.finishedAt}>{formatDateTime(call.finishedAt)}</time></>}
      </p>
      <CollapsibleText text={call.role === 'plan' ? run.goal : call.description} lines={3}
        className="mt-2 whitespace-pre-wrap text-xs leading-relaxed text-muted" />
    </div>
    {reply && <article className="rounded-xl border border-line px-3 py-2.5">
      <h4 className="flex items-center gap-1.5 text-xs font-medium text-ink"><FileText className="size-3.5 text-accent" />Agent 回复</h4>
      <div className="mt-2"><AgentReply text={reply} active={!call.finishedAt} /></div>
    </article>}
    {trace.length > 0 && <details className="rounded-xl border border-line px-3 py-2.5">
      <summary className="cursor-pointer text-xs font-medium text-ink">调用记录 · {trace.length} 条</summary>
      <ul className="mt-2 divide-y divide-line">
        {visible.map((item) => <li key={item.id} className="py-1.5">
          <details>
            <summary className="cursor-pointer text-[11px] text-muted">{item.kind === 'tool'
              ? eventToolLabel(item) : item.kind === 'error' ? '调用错误' : item.kind === 'status' ? '工作流状态' : '过程输出'}
              {' · ' + formatDateTime(item.at)}</summary>
            <p className="mt-1 whitespace-pre-wrap text-xs leading-relaxed text-ink [overflow-wrap:anywhere]">{item.message}</p>
          </details>
        </li>)}
      </ul>
      {trace.length > 24 && !fullTrace && <Button size="sm" variant="ghost" onClick={() => setFullTrace(true)}>显示更早记录</Button>}
    </details>}
    {!output.length && <p className="py-2 text-xs text-muted">{call.finishedAt ? '这一时段没有已保存的 Agent 输出。' : (call.progress || '正在等 Agent 返回。')}</p>}
  </section>;
}

import { ArrowUpRight, Clock3, Send } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { fetchAgentActivity, fetchRoleMessages, sendRoleMessage } from '../../lib/api';
import { cn } from '../../lib/cn';
import { formatDateTime } from '../../lib/format';
import { useApiResource, useLiveRefresh } from '../../lib/use-api';
import type { AgentInterval, RunRole } from '../../types/operations';
import type { WorkflowRunDetail } from '../../types/workflow';
import { modelLabel } from '../agents/AgentModelField';
import { Button } from '../ui/Button';
import { MarkdownText } from '../ui/MarkdownDocument';
import { CallTranscript } from './CallTranscript';

export const roleLabels: Record<RunRole, string> = { product: '产品经理', engineering: '工程师', review: '审查员' };
export const roleScopes: RunRole[] = ['product', 'engineering', 'review'];

export function roleForCall(call: AgentInterval): RunRole | undefined {
  if (call.role === 'dialogue') return call.roleScope;
  if (call.role === 'implement') return 'engineering';
  if (call.role === 'check' || call.role === 'review') return 'review';
  if (call.role === 'plan') return 'product';
  return undefined;
}

export function RoleDialogue({ run, scope, initialCall, onForward }: {
  run: WorkflowRunDetail; scope: RunRole; initialCall?: AgentInterval | null; onForward: (text: string) => void;
}) {
  const { data, loading, source, reload } = useApiResource(() => fetchRoleMessages(run.id, scope), null);
  const { data: activity, reload: reloadActivity } = useApiResource(() => fetchAgentActivity(run.id), null);
  useLiveRefresh(source === 'live', () => { reload(); reloadActivity(); }, { runId: run.id, refreshIntervalMs: 500 });
  const [call, setCall] = useState(initialCall?.role === 'dialogue' ? null : initialCall);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  const [showEarlier, setShowEarlier] = useState(false);
  const scroll = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  const busy = sending || data?.pending;
  const label = roleLabels[scope];
  const messages = data?.messages ?? [];
  const calls = (activity?.intervals ?? []).filter((item) => roleForCall(item) === scope && item.role !== 'dialogue');
  const legacy = run.nodes.filter((node) => (scope === 'engineering' && node.type === 'implement') ||
    (scope === 'review' && node.type === 'review')).flatMap((node) =>
    (run.nodeConversations[node.id] ?? []).filter((entry) => entry.role === 'user' || entry.role === 'agent')
      .map((entry) => ({ ...entry, task: node.title })));

  useEffect(() => {
    if (scroll.current && !call && follow.current) scroll.current.scrollTop = scroll.current.scrollHeight;
  }, [messages.length, call, busy]);

  async function send() {
    if (!draft.trim() || busy || !data?.available) return;
    setSending(true);
    setError('');
    try {
      await sendRoleMessage(run.id, scope, draft.trim());
      setDraft('');
      setCall(null);
      follow.current = true;
    } catch (failure) {
      setError((failure as Error).message);
    } finally {
      setSending(false);
      reload();
    }
  }

  return <>
    <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-line px-4 py-2.5 sm:px-5">
      <div>
        <h3 className="text-xs font-semibold text-ink">{label}</h3>
        <p className="mt-0.5 text-[11px] text-muted">{data?.agent
          ? data.agent.label + (data.agent.model ? ' · ' + modelLabel(data.agent.model) : '')
          : loading ? '正在读取角色配置…' : '暂无可用 Agent'}</p>
      </div>
      {calls.length > 0 && <details className="max-w-full rounded-lg border border-line px-2.5 py-1.5 text-[11px]">
        <summary className="cursor-pointer font-medium text-ink">任务调用 · {calls.length}</summary>
        <div className="workspace-scroll mt-1.5 max-h-40">
          {calls.map((item) => <button key={item.id} type="button" onClick={() => setCall(item)}
            className="flex w-full flex-wrap items-center gap-x-2 rounded px-1.5 py-1 text-left hover:bg-subtle">
            <span className="break-words text-ink">{item.title}</span><time className="text-muted" dateTime={item.startedAt}>{formatDateTime(item.startedAt)}</time>
          </button>)}
        </div>
      </details>}
    </div>
    <div ref={scroll} className="workspace-scroll min-h-0 flex-1 space-y-3 px-4 py-3 sm:px-5" tabIndex={0} aria-label={label + '对话'}
      onScroll={(event) => {
        const view = event.currentTarget;
        follow.current = view.scrollHeight - view.scrollTop - view.clientHeight < 80;
      }}>
      {call ? <CallTranscript key={call.id} initial={call} run={run} onShowAll={() => setCall(null)} allLabel="返回角色对话" /> : <>
        {legacy.length > 0 && <details className="rounded-lg border border-line p-2.5 text-xs">
          <summary className="cursor-pointer text-muted">旧版节点留言 · {legacy.length} 条</summary>
          <div className="mt-2 space-y-2">{legacy.map((entry) => <div key={entry.task + entry.id}>
            <p className="text-[11px] text-muted">{entry.task} · {entry.role === 'user' ? '你' : '回执'} · {formatDateTime(entry.at)}</p>
            <MarkdownText text={entry.text} />
          </div>)}</div>
        </details>}
        {messages.length > 60 && !showEarlier &&
          <Button size="sm" variant="ghost" onClick={() => { follow.current = false; setShowEarlier(true); }}>显示早期对话</Button>}
        {!messages.length && <p className="px-1 py-2 text-xs text-muted">可以请{label}核对当前需求和任务，整理修改建议。</p>}
        {(showEarlier ? messages : messages.slice(-60)).map((message) => <article key={message.id}
          className={cn('min-w-0 rounded-xl border border-line px-3 py-2.5',
            message.role === 'user' ? 'ml-6 bg-accent-soft/45' : message.role === 'system' ? 'bg-warning-soft/40' : 'mr-6 bg-subtle/25')}>
          <div className="mb-1 flex flex-wrap items-center gap-1.5 text-[11px] text-muted">
            <span className="font-semibold text-ink">{message.author}</span>
            {message.model && <span>{modelLabel(message.model)}</span>}
            <Clock3 className="size-3" /><time dateTime={message.at}>{formatDateTime(message.at)}</time>
          </div>
          <MarkdownText text={message.text} />
          {message.role === 'agent' && <Button size="sm" variant="ghost" className="mt-1 text-accent" onClick={() => onForward(message.text)}>
            <ArrowUpRight className="size-3.5" />提交建议给总控
          </Button>}
        </article>)}
      </>}
    </div>
    <form className="shrink-0 border-t border-line px-4 py-3 sm:px-5" onSubmit={(event) => { event.preventDefault(); void send(); }}>
      <div className="flex items-end gap-2">
        <textarea rows={2} aria-label={'给' + label + '的消息'} maxLength={8000} value={draft} placeholder={'向' + label + '提出问题或请它给出调整建议…'}
          onChange={(event) => setDraft(event.target.value)} className="min-w-0 flex-1 resize-y rounded-lg border border-line px-3 py-2 text-xs" />
        <Button size="sm" type="submit" disabled={!data?.available || busy || !draft.trim()}><Send className="size-3.5" />发送</Button>
      </div>
      {(busy || error) && <p role="status" className={cn('mt-1 text-[11px]', error ? 'text-danger' : 'text-muted')}>{error || label + '正在回复…'}</p>}
    </form>
  </>;
}

import { ArrowLeft, ArrowUpRight, MessageCircle, Pause, Play, Plus, Settings2, UsersRound } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { modelLabel } from '../components/agents/AgentModelField';
import { MeetingEditor, inputStyle } from '../components/meetings/MeetingEditor';
import { MeetingFlow, type MeetingSpeaker } from '../components/meetings/MeetingFlow';
import { MeetingRunProgress } from '../components/meetings/MeetingRunProgress';
import { Button, buttonStyles } from '../components/ui/Button';
import { Card } from '../components/ui/Card';
import { MarkdownDocument, MarkdownText } from '../components/ui/MarkdownDocument';
import { createMeeting, fetchAgents, fetchInterview, fetchMeeting, fetchMeetings, fetchRuntime, meetingAction, sendMeetingNote, updateMeeting } from '../lib/api';
import { cn } from '../lib/cn';
import { useApiResource, useLiveRefresh } from '../lib/use-api';
import { usePageTitle } from '../lib/use-page-title';
import type { AgentProfile } from '../types/agent';
import type { InterviewView, MeetingSettings, MeetingSummary, MeetingView } from '../types/operations';

const statuses: Record<MeetingSummary['status'], string> = {
  draft: '待讨论', organizing: '正在分配角色', running: '进行中', paused: '已暂停', failed: '失败', complete: '已有方案',
};
const formatTime = (at: string) => new Date(at).toLocaleTimeString('zh-CN', { hour12: false });
const specLink = (id: string) => '/new?spec=' + id;

export function MeetingsPage() {
  usePageTitle('会议协作');
  const { meetingId } = useParams();
  const [query] = useSearchParams();
  const sourceSpecId = query.get('spec');
  const { data: catalogue } = useApiResource(fetchAgents, []);
  const { data: runtime } = useApiResource(fetchRuntime, null);
  const agents = useMemo(() => catalogue.filter((agent) => agent.enabled && agent.availability !== 'missing')
    .sort((a, b) => Number(b.availability === 'ready') - Number(a.availability === 'ready')), [catalogue]);

  return <div className="mx-auto max-w-[1440px] space-y-4 px-4 py-5 sm:px-6">
    {runtime?.runner === 'mock' && <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">当前使用回放模式。</p>}
    {meetingId ? <MeetingRoom key={meetingId} id={meetingId} agents={agents} /> :
      <MeetingIndex key={sourceSpecId ?? 'all'} agents={agents} sourceSpecId={sourceSpecId}
        canBrowse={Boolean(runtime?.canPickDirectory)} directory={runtime?.defaultWorkspaceRoot ?? undefined} />}
  </div>;
}

function meetingBrief(spec: InterviewView): MeetingSettings {
  const title = spec.idea.split('\n')[0]!.slice(0, 56) + ' · 规格讨论';
  const questions = spec.rounds.at(-1)?.questions.map((question) => '• ' + question.title + ' · ' + question.question).join('\n');
  const agenda = [spec.idea, questions && '待讨论的问题\n' + questions].filter(Boolean).join('\n\n').slice(0, 8000);
  return { title, agenda, host: { agentId: spec.agentId, model: spec.model }, mode: 'auto', roundControl: 'host', roles: [], rounds: 2 };
}

function MeetingIndex({ agents, sourceSpecId, canBrowse, directory }: {
  agents: AgentProfile[]; sourceSpecId: string | null; canBrowse: boolean; directory?: string;
}) {
  const { data: meetings, loading, source, reload } = useApiResource(() => fetchMeetings(undefined, sourceSpecId ?? undefined), []);
  useLiveRefresh(source === 'live', reload, { refreshIntervalMs: 700 });
  const [spec, setSpec] = useState<InterviewView | null>();
  useEffect(() => {
    if (!sourceSpecId) return;
    const controller = new AbortController();
    void fetchInterview(sourceSpecId, null, controller.signal).then((next) => {
      if (!controller.signal.aborted) setSpec(next);
    });
    return () => controller.abort();
  }, [sourceSpecId]);
  const [creating, setCreating] = useState(Boolean(sourceSpecId));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const navigate = useNavigate();

  async function create(settings: MeetingSettings, workspaceRoot: string) {
    setBusy(true);
    setError('');
    try {
      const room = await createMeeting({ ...settings, workspaceRoot, sourceSpecId: sourceSpecId ?? undefined });
      if (settings.mode === 'auto') await meetingAction(room.id, 'organize').catch(() => {});
      navigate('/meetings/' + room.id);
    } catch (failure) { setError((failure as Error).message); }
    finally { setBusy(false); }
  }

  return <>
    <header className="flex flex-wrap items-start justify-between gap-3">
      <div>
        {sourceSpecId && <Link className="mb-2 inline-flex items-center gap-1 text-xs text-accent hover:underline" to={specLink(sourceSpecId)}>
          <ArrowLeft className="size-3.5" />规格访谈
        </Link>}
        <h1 className="text-3xl font-semibold tracking-tight text-ink">{sourceSpecId ? '规格协作会议' : '会议协作'}</h1>
        <p className="mt-1 text-sm text-muted">安排成员独立分析，由主持人整理决议。</p>
      </div>
      {!creating && <Button onClick={() => setCreating(true)}><Plus className="size-4" />新建会议</Button>}
    </header>
    {sourceSpecId && !spec && <p className="text-xs text-muted">{spec === undefined ? '正在读取关联规格…' : '无法读取关联规格。'}</p>}
    {creating && (!sourceSpecId || spec) && <Card className="space-y-3 p-4 sm:p-5">
      <h2 className="text-sm font-semibold text-ink">新建会议</h2>
      {error && <p className="text-xs text-danger" role="alert">{error}</p>}
      <MeetingEditor agents={agents} canBrowse={canBrowse} directory={spec?.workspaceRoot ?? directory} fixedDirectory={Boolean(spec)}
        prefill={spec ? meetingBrief(spec) : undefined} busy={busy} onSave={create} onCancel={() => setCreating(false)} />
    </Card>}
    <Card className="divide-y divide-line" aria-label="会议记录">
      {!meetings.length && <p className="p-4 text-sm text-muted">{loading ? '正在读取会议…' : '这里还没有会议记录。'}</p>}
      {meetings.map((room) => <Link key={room.id} to={'/meetings/' + room.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-3 hover:bg-subtle/50">
        <span className="flex min-w-0 items-center gap-2 break-words text-sm font-medium text-ink"><UsersRound className="size-4 shrink-0 text-accent" />{room.title}</span>
        <span className="flex flex-wrap gap-3 text-[11px] text-muted">{statuses[room.status]}{room.round > 0 && ' · 第 ' + room.round + ' 轮'}
          <time dateTime={room.updatedAt}>{new Date(room.updatedAt).toLocaleString('zh-CN')}</time></span>
      </Link>)}
    </Card>
  </>;
}

type Action = 'organize' | 'discuss' | 'summarize' | 'pause';

function MeetingRoom({ id, agents }: { id: string; agents: AgentProfile[] }) {
  const { data: room, source, loading, reload } = useApiResource(() => fetchMeeting(id), null);
  useLiveRefresh(source === 'live', reload, { runId: id, refreshIntervalMs: 300 });
  const [picked, setPicked] = useState<string | null>(null);
  const [speaker, setSpeaker] = useState<MeetingSpeaker | null>(null);
  const discussionRef = useRef<HTMLDivElement>(null);
  const deliveryRef = useRef<HTMLDivElement>(null);
  const [editing, setEditing] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const inProgress = room?.status === 'running' || room?.status === 'organizing';
  const intervals = room?.turns.map((turn) => ({ ...turn,
    agentLabel: agents.find((agent) => agent.id === turn.agentId)?.label ?? turn.agentId,
  })).reverse() ?? [];
  const active = intervals.filter((turn) => turn.status === 'running');
  useEffect(() => {
    if (!inProgress) return;
    const timer = window.setInterval(reload, 2500);
    return () => window.clearInterval(timer);
  }, [inProgress, reload]);

  async function action(kind: Action) {
    setBusy(true);
    setError('');
    try { await meetingAction(id, kind); }
    catch (failure) { setError((failure as Error).message); }
    finally { setBusy(false); reload(); }
  }

  async function save(settings: MeetingSettings) {
    if (editing === null) return;
    setBusy(true);
    setError('');
    try { await updateMeeting(id, { ...settings, revision: editing }); setEditing(null); }
    catch (failure) { setError((failure as Error).message); }
    finally { setBusy(false); reload(); }
  }

  if (!room) return <Card className="p-4 text-sm text-muted">{loading ? '正在读取会议…' : '无法读取这场会议。'}</Card>;
  const reportUrl = '/api/meetings/' + id + '/report';
  function selectSpeaker(voice: MeetingSpeaker) {
    setSpeaker(voice);
    discussionRef.current?.scrollIntoView({ block: 'nearest' });
  }
  return <>
    <Link className="inline-flex items-center gap-1.5 text-xs font-medium text-muted hover:text-accent" to="/meetings">
      <ArrowLeft className="size-3.5" />会议协作
    </Link>
    <header className="flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0">
        <h1 className="break-words text-2xl font-semibold text-ink">{room.title}</h1>
        <p className="mt-1 text-xs text-muted">{statuses[room.status]} · {room.roles.length} 位成员 · {room.roundControl === 'host' ? '主持人判断收敛' : '人工设定轮次'}
          {room.round > 0 && ' · 第 ' + room.round + ' 轮'}</p>
      </div>
      <div className="flex flex-wrap gap-2">
        {room.sourceSpecId && !room.linkedRunId && <Link to={specLink(room.sourceSpecId)}
          className={buttonStyles({ variant: 'secondary', size: 'sm' })}>返回规格访谈<ArrowUpRight className="size-3.5" /></Link>}
        {inProgress ? <Button variant="secondary" disabled={busy} onClick={() => void action('pause')}><Pause className="size-4" />暂停讨论</Button> : <>
          <Button variant="secondary" disabled={busy || editing !== null} onClick={() => setEditing(room.revision)}><Settings2 className="size-4" />编辑会议</Button>
          {room.mode === 'auto' && <Button variant="secondary" disabled={busy || editing !== null} onClick={() => void action('organize')}>
            <UsersRound className="size-4" />{room.roles.length ? '重新分配角色' : '自动分配角色'}
          </Button>}
          <Button disabled={busy || editing !== null || !room.roles.length} onClick={() => void action('discuss')}>
            <Play className="size-4" />{room.round ? '继续讨论' : '开始讨论'}
          </Button>
        </>}
      </div>
    </header>
    {(error || room.error) && <p role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-danger">{error || room.error}</p>}
    {editing !== null && <Card className="space-y-4 p-4">
      <h2 className="text-sm font-semibold text-ink">会议设置</h2>
      <MeetingEditor agents={agents} initial={room} directory={room.workspaceRoot} canBrowse={false} busy={busy} onSave={save}
        onCancel={() => { setError(''); setEditing(null); }} />
    </Card>}
    <MeetingFlow room={room} catalogue={agents} intervals={intervals} speaker={speaker} picked={picked}
      onSpeaker={(voice) => { setPicked(null); selectSpeaker(voice); }}
      onTurn={(turnId) => {
        setPicked(turnId);
        const turn = intervals.find((item) => item.id === turnId);
        if (turn?.lane) selectSpeaker(turn.lane === '主持人' ? 'host' : `role:${turn.lane}`);
      }}
      onDelivery={() => { deliveryRef.current?.scrollIntoView({ block: 'nearest' }); deliveryRef.current?.focus({ preventScroll: true }); }} />
    <div className="meeting-room-grid">
      <div ref={discussionRef} className="min-w-0">
        <MeetingChat room={room} inProgress={inProgress} active={active.map((turn) => turn.lane ?? turn.agentLabel)} reload={reload}
          speaker={speaker} onClearSpeaker={() => { setPicked(null); setSpeaker(null); }} />
      </div>
      <div className="min-w-0 space-y-3">
        <div ref={deliveryRef} tabIndex={-1} aria-label="会议方案交付">
        <Card className="space-y-3 p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-sm font-semibold text-ink">会议方案</h2>
            {!inProgress && (!room.report || room.reportStale) && room.messages.some((entry) => entry.kind === 'agent') &&
              <Button size="sm" variant="secondary" disabled={busy || editing !== null} onClick={() => void action('summarize')}>汇总现有发言</Button>}
          </div>
          {room.report ? <>
            {room.reportStale && <p className="text-xs text-warning">有新发言或成员调整，可重新汇总后再采纳。</p>}
            <MarkdownDocument title="会议方案 Markdown" text={room.report} filename="solution.md" downloadHref={reportUrl} />
            <div className="flex flex-wrap gap-2">
              {room.status === 'complete' && !room.reportStale && !room.linkedRunId &&
                <Link to={room.sourceSpecId ? specLink(room.sourceSpecId) : '/new?meeting=' + id} className={buttonStyles({ size: 'sm' })}>
                  {room.sourceSpecId ? '回规格页采纳方案' : '用方案新建运行'}
                </Link>}
            </div>
          </> : <p className="text-xs text-muted">主持人汇总成员意见后，方案会出现在这里。</p>}
        </Card>
        </div>
        {room.linkedRunId && <MeetingRunProgress key={room.linkedRunId} id={room.linkedRunId} />}
        <details className="rounded-xl border border-line bg-surface px-4 py-3">
          <summary className="cursor-pointer text-sm font-semibold text-ink">议题与成员</summary>
          <p className="mt-2 whitespace-pre-wrap break-words text-xs leading-5 text-ink">{room.agenda}</p>
          <p className="mt-1 break-all text-[11px] text-muted">{room.workspaceRoot}</p>
          <div className="mt-2 grid gap-2 sm:grid-cols-2">
            {[{ ...room.host, name: '主持人', responsibility: '组织讨论并汇总决议', prompt: '' }, ...room.roles].map((role) =>
              <div key={role.name} className="min-w-0 rounded-lg border border-line px-2.5 py-2">
                <p className="break-words text-xs font-semibold text-ink">{role.name}</p>
                <p className="break-words text-[11px] text-muted">{agents.find((agent) => agent.id === role.agentId)?.label ?? role.agentId}
                  {' · ' + (role.model ? modelLabel(role.model) : '默认模型')}</p>
                <p className="mt-1 break-words text-xs text-ink">{role.responsibility}</p>
                {role.prompt && <details className="mt-1 text-[11px] text-muted"><summary className="cursor-pointer">角色提示词</summary>
                  <p className="mt-1 whitespace-pre-wrap break-words">{role.prompt}</p></details>}
              </div>)}
          </div>
        </details>
      </div>
    </div>
  </>;
}

function MeetingChat({ room, inProgress, active, reload, speaker, onClearSpeaker }: {
  room: MeetingView; inProgress: boolean; active: string[]; reload: () => void;
  speaker: MeetingSpeaker | null; onClearSpeaker: () => void;
}) {
  const [note, setNote] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  const scroll = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  const name = speaker === 'host' ? '主持人' : speaker?.slice(5);
  const messages = room.messages.filter((message) => !speaker || (speaker === 'host'
    ? message.kind === 'host' : message.kind === 'agent' && message.author === name));
  useEffect(() => { follow.current = true; }, [speaker]);
  useEffect(() => {
    const panel = scroll.current;
    if (panel && follow.current) panel.scrollTop = panel.scrollHeight;
  }, [messages.length, inProgress, speaker]);

  async function speak(interrupt: boolean) {
    if (!note.trim() || sending) return;
    setSending(true);
    setError('');
    try { await sendMeetingNote(room.id, note.trim(), interrupt); setNote(''); }
    catch (failure) { setError((failure as Error).message); }
    finally { setSending(false); reload(); }
  }

  let previousRound: number | undefined;
  return <Card className="min-w-0 space-y-3 p-4">
    <header className="flex flex-wrap items-center justify-between gap-2">
      <h2 className="flex items-center gap-2 text-sm font-semibold text-ink"><MessageCircle className="size-4 text-accent" />{name ? name + '的发言' : '会议群聊'}</h2>
      {speaker && <Button size="sm" variant="ghost" onClick={onClearSpeaker}>查看群聊</Button>}
    </header>
    <div ref={scroll} onScroll={() => {
      const view = scroll.current;
      if (view) follow.current = view.scrollHeight - view.scrollTop - view.clientHeight < 80;
    }} className="min-h-56 max-h-[min(57dvh,650px)] space-y-3 overflow-auto rounded-xl bg-subtle/40 p-3" role="log" aria-label="会议发言">
      {!messages.length && <p className="text-xs text-muted">{name ? '这个角色还没有发言。' : '讨论开始后，各成员的发言会出现在这里。'}</p>}
      {messages.map((message) => {
        const divider = message.round !== undefined && message.round !== previousRound;
        if (message.round !== undefined) previousRound = message.round;
        return <div key={message.id}>
          {divider && <div className="mb-2 text-center text-[10px] text-muted">第 {message.round} 轮</div>}
          <div className={cn('flex items-start gap-2', message.kind === 'human' && 'flex-row-reverse')}>
            <div className={cn('grid size-7 shrink-0 place-items-center rounded-full text-[11px] font-semibold',
              message.kind === 'host' ? 'bg-review-soft text-review' : 'bg-accent-soft text-accent')} aria-hidden="true">{message.author.slice(0, 1)}</div>
            <article className={cn('min-w-0 max-w-[85%] rounded-xl border border-line px-3 py-2.5',
              message.kind === 'human' ? 'border-accent/20 bg-accent-soft/75' : message.kind === 'host' ? 'bg-review-soft/40' : 'bg-surface')}>
              <header className="mb-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[10px] text-muted">
                <span className="font-semibold text-ink">{message.author}</span>
                {message.model && <span className="break-all">{modelLabel(message.model)}</span>}
                <time dateTime={message.at}>{formatTime(message.at)}</time>
              </header>
              <MarkdownText text={message.text} />
            </article>
          </div>
        </div>;
      })}
      {inProgress && <p role="status" className="text-[11px] text-accent">{[...new Set(active)].join('、') || '主持人'} 正在处理…</p>}
    </div>
    <form onSubmit={(event) => { event.preventDefault(); void speak(false); }} className="space-y-2">
      <label className="block space-y-1 text-xs font-medium text-muted"><span>向群聊发言</span>
        <textarea className={inputStyle} value={note} onChange={(event) => setNote(event.target.value)} maxLength={4000}
          rows={2} placeholder="补充条件、纠正方向或提出新问题" />
      </label>
      {error && <p role="alert" className="text-xs text-danger">{error}</p>}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" size="sm" disabled={!note.trim() || sending}>{sending ? '正在发送…' : '发送发言'}</Button>
        {inProgress && <Button type="button" size="sm" variant="secondary" disabled={!note.trim() || sending}
          onClick={() => void speak(true)}>打断并发送</Button>}
      </div>
    </form>
  </Card>;
}

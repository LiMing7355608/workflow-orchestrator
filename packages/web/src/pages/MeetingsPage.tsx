import { ArrowLeft, Download, MessageCircle, Pause, Play, Plus, Settings2, UsersRound } from 'lucide-react';
import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ActiveFlow, ActivityTimeline } from '../components/agents/AgentActivityPanel';
import { MeetingEditor, inputStyle } from '../components/meetings/MeetingEditor';
import { Button, buttonStyles } from '../components/ui/Button';
import { Card } from '../components/ui/Card';
import { createMeeting, fetchAgents, fetchMeeting, fetchMeetings, fetchRuntime, meetingAction, sendMeetingNote, updateMeeting } from '../lib/api';
import { useApiResource, useLiveRefresh } from '../lib/use-api';
import { usePageTitle } from '../lib/use-page-title';
import type { AgentProfile } from '../types/agent';
import type { MeetingSettings, MeetingSummary } from '../types/operations';

const statuses: Record<MeetingSummary['status'], string> = {
  draft: '待讨论', organizing: '正在分配角色', running: '进行中', paused: '已暂停', failed: '失败', complete: '已有方案',
};
const formatTime = (at: string) => new Date(at).toLocaleString('zh-CN', { hour12: false });

export function MeetingsPage() {
  usePageTitle('会议协作');
  const { meetingId } = useParams();
  const { data: catalogue } = useApiResource(fetchAgents, []);
  const { data: runtime } = useApiResource(fetchRuntime, null);
  const agents = useMemo(() => catalogue.filter((agent) => agent.enabled && agent.availability !== 'missing')
    .sort((a, b) => Number(b.availability === 'ready') - Number(a.availability === 'ready')), [catalogue]);
  const replay = runtime?.runner === 'mock';
  return <div className="mx-auto max-w-[1580px] space-y-4 px-4 py-5 sm:px-6">
    {replay && <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">当前使用回放模式，Agent 发言由回放执行器生成。</p>}
    {meetingId ? <MeetingRoom key={meetingId} id={meetingId} agents={agents} /> :
      <MeetingIndex agents={agents} canBrowse={Boolean(runtime?.canPickDirectory)} directory={runtime?.defaultWorkspaceRoot ?? undefined} />}
  </div>;
}

function MeetingIndex({ agents, canBrowse, directory }: { agents: AgentProfile[]; canBrowse: boolean; directory?: string }) {
  const { data: meetings, source, loading, reload } = useApiResource(fetchMeetings, []);
  useLiveRefresh(source === 'live', reload, { refreshIntervalMs: 600 });
  const navigate = useNavigate();
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function create(settings: MeetingSettings, workspaceRoot: string) {
    setBusy(true);
    setError('');
    try {
      const room = await createMeeting({ ...settings, workspaceRoot });
      if (settings.mode === 'auto') {
        try { await meetingAction(room.id, 'organize'); }
        catch { /* The saved room can retry organization from its toolbar. */ }
      }
      navigate('/meetings/' + room.id);
    } catch (failure) {
      setError((failure as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return <>
    <header className="flex flex-wrap items-end justify-between gap-3">
      <div><h1 className="text-3xl font-semibold tracking-tight text-ink">会议协作</h1>
        <p className="mt-1 text-sm text-muted">安排成员围绕议题讨论，保留发言并汇总方案。</p></div>
      {!creating && <Button onClick={() => setCreating(true)}><Plus className="size-4" />新建会议</Button>}
    </header>
    {creating && <Card className="space-y-4 p-4 sm:p-5">
      <h2 className="text-sm font-semibold text-ink">新建会议</h2>
      {error && <p className="text-xs text-danger" role="alert">{error}</p>}
      <MeetingEditor agents={agents} canBrowse={canBrowse} directory={directory} busy={busy} onSave={create}
        onCancel={() => { setError(''); setCreating(false); }} />
    </Card>}
    <Card className="divide-y divide-line" aria-label="会议记录">
      {meetings.length === 0 && <p className="p-5 text-sm text-muted">{loading ? '正在读取会议…' : source === 'live' ? '这里还没有会议记录。' : '暂时无法读取会议服务。'}</p>}
      {meetings.map((room) => <Link key={room.id} to={'/meetings/' + room.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-3 hover:bg-subtle/50">
        <span className="flex min-w-0 items-center gap-2 text-sm font-medium text-ink"><UsersRound className="size-4 shrink-0 text-accent" />{room.title}</span>
        <span className="flex flex-wrap items-center gap-3 text-[11px] text-muted">{statuses[room.status]}{room.round > 0 && ` · 第 ${room.round} 轮`}<time dateTime={room.updatedAt}>{formatTime(room.updatedAt)}</time></span>
      </Link>)}
    </Card>
  </>;
}

function MeetingRoom({ id, agents }: { id: string; agents: AgentProfile[] }) {
  const { data: room, source, loading, reload } = useApiResource(() => fetchMeeting(id), null);
  useLiveRefresh(source === 'live', reload, { runId: id, refreshIntervalMs: 300 });
  const [picked, setPicked] = useState<string | null>(null);
  const [editingRevision, setEditingRevision] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const [sending, setSending] = useState(false);
  const [noteError, setNoteError] = useState('');
  const inProgress = room?.status === 'running' || room?.status === 'organizing';
  const intervals = useMemo(() => room?.turns.map((turn) => ({ ...turn,
    agentLabel: agents.find((agent) => agent.id === turn.agentId)?.label ?? turn.agentId,
  })).reverse() ?? [], [room?.turns, agents]);
  const selected = intervals.find((turn) => turn.id === picked);
  const reportUrl = '/api/meetings/' + encodeURIComponent(id) + '/report';
  useEffect(() => {
    if (!inProgress) return;
    const timer = window.setInterval(reload, 2500);
    return () => window.clearInterval(timer);
  }, [inProgress, reload]);

  async function action(kind: 'organize' | 'discuss' | 'summarize' | 'pause') {
    setBusy(true);
    setError('');
    try { await meetingAction(id, kind); }
    catch (failure) { setError((failure as Error).message); }
    finally { setBusy(false); reload(); }
  }

  async function save(settings: MeetingSettings) {
    if (editingRevision === null) return;
    setBusy(true);
    setError('');
    try { await updateMeeting(id, { ...settings, revision: editingRevision }); setEditingRevision(null); }
    catch (failure) { setError((failure as Error).message); }
    finally { setBusy(false); reload(); }
  }

  async function speak(event: FormEvent) {
    event.preventDefault();
    if (!note.trim()) return;
    setSending(true);
    setNoteError('');
    try { await sendMeetingNote(id, note.trim()); setNote(''); }
    catch (failure) { setNoteError((failure as Error).message); }
    finally { setSending(false); reload(); }
  }

  return <>
    <Link className="inline-flex items-center gap-1.5 text-xs font-medium text-muted hover:text-accent" to="/meetings"><ArrowLeft className="size-3.5" />会议协作</Link>
    {!room ? <Card className="p-4 text-sm text-muted">{loading ? '正在读取会议…' : error || '无法读取这场会议。'}</Card> : <>
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="break-words text-2xl font-semibold text-ink">{room.title}</h1>
          <p className="mt-1 text-xs text-muted">{statuses[room.status]} · {room.roles.length} 位成员{room.round > 0 && ` · 第 ${room.round} 轮`}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          {inProgress ? <Button variant="secondary" disabled={busy} onClick={() => void action('pause')}><Pause className="size-4" />暂停讨论</Button> : <>
            <Button variant="secondary" disabled={busy || editingRevision !== null} onClick={() => setEditingRevision(room.revision)}><Settings2 className="size-4" />编辑会议</Button>
            {room.mode === 'auto' && <Button variant="secondary" disabled={busy || editingRevision !== null} onClick={() => void action('organize')}><UsersRound className="size-4" />{room.roles.length ? '重新分配角色' : '自动分配角色'}</Button>}
            <Button disabled={busy || editingRevision !== null || room.roles.length === 0} onClick={() => void action('discuss')}><Play className="size-4" />{room.round ? '继续讨论' : '开始讨论'}</Button>
          </>}
        </div>
      </header>
      {(error || room.error) && <p className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-danger" role="alert">{error || room.error}</p>}
      {editingRevision !== null ? <Card className="space-y-4 p-4 sm:p-5"><h2 className="text-sm font-semibold text-ink">会议设置</h2>
        <MeetingEditor agents={agents} initial={room} directory={room.workspaceRoot} canBrowse={false} busy={busy} onSave={save}
          onCancel={() => { setError(''); setEditingRevision(null); }} />
      </Card> : <Card className="space-y-3 p-4">
        <p className="whitespace-pre-wrap break-words text-sm text-ink">{room.agenda}</p>
        <p className="break-all text-[11px] text-muted">目录 {room.workspaceRoot}</p>
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {[{ ...room.host, name: '主持人', responsibility: '组织讨论并汇总决议', prompt: '' }, ...room.roles].map((role, index) =>
            <div key={index} className="min-w-0 rounded-lg border border-line bg-subtle/35 px-3 py-2">
              <p className="break-words text-xs font-semibold text-ink">{role.name}</p>
              <p className="break-words text-[11px] text-muted">{agents.find((agent) => agent.id === role.agentId)?.label ?? role.agentId} · {role.model ?? '默认模型'}</p>
              <p className="mt-1 break-words text-xs text-ink">{role.responsibility}</p>
              {role.prompt && <details className="mt-1 text-[11px] text-muted"><summary className="cursor-pointer">角色提示词</summary><p className="mt-1 whitespace-pre-wrap break-words">{role.prompt}</p></details>}
            </div>)}
        </div>
      </Card>}
      <Card className="space-y-4 p-4">
        <ActiveFlow entries={intervals} picked={picked} onPick={setPicked} output={room.report ? { link: reportUrl, name: 'solution.md', description: room.reportStale ? '上次方案' : '会议方案' } : undefined}
          reports={room.messages.filter((message) => message.kind === 'agent').slice(-3).reverse().map((message) => message.author + ' · ' + message.text)} />
        <ActivityTimeline intervals={intervals} picked={picked} onPick={setPicked} />
        {selected && <p className="rounded-lg border border-line px-3 py-2 text-xs text-muted">{selected.title} · {selected.progress || selected.description}</p>}
      </Card>
      <div className="grid items-start gap-4 xl:grid-cols-2">
        <Card className="space-y-3 p-4">
          <h2 className="flex items-center gap-2 text-sm font-semibold text-ink"><MessageCircle className="size-4 text-accent" />会议记录</h2>
          <div className="max-h-[520px] space-y-2 overflow-auto" aria-label="会议发言">
            {room.messages.length === 0 && <p className="text-xs text-muted">讨论开始后，成员发言会出现在这里。</p>}
            {room.messages.map((message) => <article key={message.id} className={'rounded-lg border border-line px-3 py-2 ' + (message.kind === 'human' ? 'bg-accent-soft/65' : 'bg-subtle/25')}>
              <header className="mb-1 flex flex-wrap justify-between gap-1 text-[11px] text-muted">
                <span className="font-semibold text-ink">{message.author}{message.kind === 'human' ? ' · 人工发言' : ` · 第 ${message.round} 轮`}{message.model && ` · ${message.model}`}</span>
                <time dateTime={message.at}>{formatTime(message.at)}</time>
              </header>
              <p className="whitespace-pre-wrap break-words text-xs leading-5 text-ink">{message.text}</p>
            </article>)}
          </div>
          <form onSubmit={speak} className="space-y-2">
            <label className="block space-y-1 text-xs font-medium text-muted"><span>人工发言</span><textarea className={inputStyle} value={note} onChange={(event) => setNote(event.target.value)} maxLength={4000} rows={2} placeholder="补充条件、纠正方向或提出新问题。" /></label>
            {noteError && <p className="text-xs text-danger" role="alert">{noteError}</p>}
            <Button type="submit" size="sm" disabled={!note.trim() || sending}>{sending ? '正在发送…' : '发送发言'}</Button>
          </form>
        </Card>
        <Card className="space-y-3 p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-sm font-semibold text-ink">会议方案</h2>
            {!inProgress && (!room.report || room.reportStale) && room.messages.some((entry) => entry.kind === 'agent') &&
              <Button size="sm" variant="secondary" disabled={busy || editingRevision !== null} onClick={() => void action('summarize')}>汇总现有发言</Button>}
          </div>
          {room.report ? <>
            {room.reportStale && <p className="text-xs text-amber-800">这是上次方案，可汇总现有发言以纳入最新补充，或继续讨论。</p>}
            <pre className="max-h-[520px] overflow-auto whitespace-pre-wrap break-words rounded-lg border border-line bg-subtle/35 p-3 font-sans text-xs leading-6 text-ink">{room.report}</pre>
            <div className="flex flex-wrap gap-2">
              <a className={buttonStyles({ variant: 'secondary', size: 'sm' })} href={reportUrl}><Download className="size-3.5" />下载方案</a>
              {!room.reportStale && <Link to={'/new?meeting=' + encodeURIComponent(id)} className={buttonStyles({ size: 'sm' })}>用方案新建运行</Link>}
            </div>
          </> : <p className="text-xs text-muted">主持人汇总成员意见后，方案会出现在这里。</p>}
        </Card>
      </div>
    </>}
  </>;
}

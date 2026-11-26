import { Activity, ArrowUpRight, Bot, ChevronDown, Clock3, FileText, FolderOutput, MessageCircle, ShieldCheck, Waypoints } from 'lucide-react';
import { useEffect, useState } from 'react';
import { fetchAgentActivity, fetchBlackboard } from '../../lib/api';
import { cn } from '../../lib/cn';
import { formatDuration } from '../../lib/format';
import { useApiResource, useLiveRefresh } from '../../lib/use-api';
import type { AgentInterval } from '../../types/operations';
import { Button } from '../ui/Button';
import { Card } from '../ui/Card';
import { modelLabel } from './AgentModelField';
import { AgentLogo } from './AgentLogo';

const roles: Record<AgentInterval['role'], string> = {
  spec: '规格访谈', plan: 'PM 分解', check: '草案核对', amend: '调整编排',
  implement: '实现', review: '审查', meeting: '会议', dialogue: '角色对话',
};
const states: Record<AgentInterval['status'], string> = {
  running: '运行中', completed: '已返回', failed: '失败', interrupted: '已中断',
};
const memberKey = (entry: AgentInterval) => entry.agentId + '/' + (entry.lane ?? entry.role);
const ticks = [0, 25, 50, 75, 100];
const timeFormat = new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
const dateFormat = new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });

function useCurrentTime(running: boolean) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    setNow(Date.now());
    if (!running) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [running]);
  return now;
}

function packIntervals<T extends { left: number; width: number }>(lane: T[]) {
  const tracks: T[][] = [];
  for (const entry of [...lane].sort((a, b) => a.left - b.left)) {
    const track = tracks.find((items) => {
      const prior = items.at(-1)!;
      return prior.left + prior.width <= entry.left;
    });
    if (track) track.push(entry);
    else tracks.push([entry]);
  }
  return tracks;
}

interface TimelineProps {
  intervals: AgentInterval[];
  picked: string | null;
  onPick: (id: string) => void;
}

export function ActivityTimeline({ intervals, picked, onPick }: TimelineProps) {
  const live = intervals.some((entry) => entry.status === 'running');
  const now = useCurrentTime(live);
  const [range, setRange] = useState<'recent' | 'all'>('recent');
  const series = intervals.flatMap((entry) => {
    const start = Date.parse(entry.startedAt);
    const end = entry.finishedAt ? Date.parse(entry.finishedAt) : now;
    return Number.isFinite(start) && Number.isFinite(end) ? [{ entry, start, end: Math.max(start, end) }] : [];
  });
  if (!series.length) return null;

  const last = Math.max(...series.map(({ end }) => end));
  const start = Math.min(...series.map((call) => call.start), last - 15_000);
  const first = range === 'recent' ? Math.max(start, last - 900_000) : start;
  const span = last - first;
  const duration = span + Math.max(1_000, span * 0.03);
  const clock = duration >= 86_400_000 ? dateFormat : timeFormat;
  const shown = series.filter((call) => call.end >= first).map((call) => {
    const left = (Math.max(call.start, first) - first) / duration * 100;
    return { ...call, left, width: Math.min(100 - left, Math.max(1.35, (call.end - Math.max(call.start, first)) / duration * 100)) };
  });
  const lanes = new Map<string, typeof shown>();
  for (const call of shown) {
    const key = memberKey(call.entry);
    const lane = lanes.get(key) ?? [];
    lane.push(call);
    lanes.set(key, lane);
  }

  return <section className="min-w-0" aria-label="时间图谱">
    <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
      <h3 className="flex items-center gap-2 text-[13px] font-semibold text-ink"><Clock3 className="size-4 text-muted" />时间图谱</h3>
      <select aria-label="时间图谱范围" value={range} onChange={(event) => setRange(event.target.value === 'all' ? 'all' : 'recent')}
        className="rounded-md border border-line bg-surface px-2 py-1 text-[11px] text-muted">
        <option value="recent">最近 15 分钟</option><option value="all">完整时间范围</option>
      </select>
    </div>
    <div className="activity-timeline overflow-x-auto rounded-xl border border-line bg-surface focus-visible:ring-2 focus-visible:ring-accent"
      role="region" aria-label="调用时间泳道" tabIndex={0}>
      <div className="min-w-[470px]">
        <div className="activity-lane border-b border-line bg-subtle/40 py-2 text-[10px] text-muted">
          <span>Agent · 职责</span>
          <div className="flex justify-between gap-2 font-mono tabular-nums">
            {ticks.map((tick) => {
              const at = first + duration * tick / 100;
              return <time key={tick} dateTime={new Date(at).toISOString()}>{clock.format(at)}</time>;
            })}
          </div>
        </div>
        {[...lanes].map(([key, lane]) => {
          const { entry } = lane[0]!;
          return <div key={key} className="activity-lane border-b border-line py-2 last:border-b-0">
            <div className="min-w-0 self-center" title={entry.agentLabel}>
              <p className="truncate text-[11px] font-medium text-ink">{entry.lane ?? roles[entry.role]}</p>
              <p className="truncate text-[10px] text-muted">{entry.agentLabel}{entry.model && " · " + modelLabel(entry.model)}</p>
            </div>
            <div className="relative space-y-1">
              {live && <span aria-hidden="true" className="pointer-events-none absolute inset-y-0 z-10 w-px bg-accent/45"
                style={{ left: span / duration * 100 + '%' }} />}
              {packIntervals(lane).map((track, index) => <div key={index} className="activity-track relative h-6 rounded-md">
                {track.map((call) => {
                  const { entry: item, left, width, start, end } = call;
                  const label = item.title + ' · ' + states[item.status] + ' · ' + clock.format(start) + ' · ' + formatDuration(end - start);
                  return <button type="button" key={item.id} aria-pressed={item.id === picked} aria-label={'打开对话 · ' + label}
                    title={label} onClick={() => onPick(item.id)} data-state={item.status}
                    className={cn('activity-span absolute inset-y-0.5 overflow-hidden truncate rounded text-left text-[10px] font-medium hover:ring-1 hover:ring-accent focus-visible:ring-2 focus-visible:ring-accent',
                      width >= 12 && 'px-1.5', item.id === picked && 'z-20 ring-1 ring-accent')}
                    style={{ left: left + '%', width: width + '%' }}>{width >= 12 && item.title}</button>;
                })}
              </div>)}
            </div>
          </div>;
        })}
      </div>
    </div>
  </section>;
}

interface FlowOutput { link: string; name: string; description: string }

function FlowMembers({ entries, picked, onPick, now }: Pick<TimelineProps, 'picked' | 'onPick'> & { entries: AgentInterval[]; now: number }) {
  const [expanded, setExpanded] = useState(false);
  const groups = new Map<string, AgentInterval[]>();
  for (const entry of entries) {
    const key = memberKey(entry);
    const items = groups.get(key) ?? [];
    items.push(entry);
    groups.set(key, items);
  }
  const rows = [...groups].map(([id, history]) => ({
    id, history, current: history.find((entry) => entry.status === 'running') ?? history[0]!,
  })).sort((a, b) => Number(b.current.status === 'running') - Number(a.current.status === 'running'));
  const visible = expanded ? rows : rows.slice(0, 4);
  return <div className="space-y-1.5">
    {visible.map(({ id, current, history }) => <button key={id} data-flow-member={id} data-state={current.status} type="button"
      onClick={() => onPick(current.id)} aria-pressed={history.some((entry) => entry.id === picked)}
      aria-label={'打开 ' + current.agentLabel + ' · ' + current.title + ' 的对话'}
      className="activity-member flex w-full min-w-0 items-start gap-2 rounded-lg border px-2 py-2.5 text-left">
      <AgentLogo src={current.agentLogo} label={current.agentLabel} className="mt-0.5 size-6 shrink-0 rounded-md" />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-xs font-semibold text-ink" title={current.title}>{current.lane ?? current.title}</span>
        <span className="block truncate text-[10px] text-muted" title={current.agentLabel}>{current.agentLabel}</span>
        {current.model && <span className="block truncate text-[10px] font-medium text-accent" title={modelLabel(current.model)}>
          {modelLabel(current.model)}
        </span>}
      </span>
      <span className="shrink-0 text-right text-[10px]">
        <span className="activity-state block" data-state={current.status}>
          {current.status === 'running' ? formatDuration(Math.max(0, now - Date.parse(current.startedAt))) : states[current.status]}
        </span>
        {history.length > 1 && <span className="block text-muted">{history.length} 次</span>}
      </span>
    </button>)}
    {rows.length > 4 && <Button size="sm" variant="ghost" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>
      <ChevronDown className={cn('size-3.5', expanded && 'rotate-180')} />{expanded ? '收起成员' : '显示另外 ' + (rows.length - 4) + ' 项'}
    </Button>}
  </div>;
}

export function ActiveFlow({ entries, picked, onPick, output, reports = [], title, idleLabel }: {
  entries: AgentInterval[];
  picked: string | null;
  onPick: (id: string) => void;
  output?: FlowOutput;
  reports?: string[];
  title?: string;
  idleLabel?: string;
}) {
  const planning = entries.filter((entry) => entry.role === 'plan' || entry.role === 'amend');
  const review = entries.filter((entry) => entry.role === 'check' || entry.role === 'review' || entry.roleScope === 'review');
  const workers = entries.filter((entry) => entry.role === 'implement' || entry.role === 'spec' ||
    entry.role === 'meeting' || (entry.role === 'dialogue' && entry.roleScope !== 'review'));
  const meeting = entries.some((entry) => entry.role === 'meeting');
  const active = entries.filter((entry) => entry.status === 'running');
  const now = useCurrentTime(active.length > 0);
  const coordinator = planning.find((entry) => entry.status === 'running') ?? planning[0];
  const flowTitle = title ?? entries[0]?.runTitle;
  const firstLinkActive = workers.some((entry) => entry.status === 'running');
  const secondLinkActive = review.some((entry) => entry.status === 'running');

  if (!flowTitle && !entries.length) return <p className="rounded-lg border border-dashed border-line p-4 text-xs text-muted">暂无 Agent 调用记录。</p>;
  return <section aria-label="实时调用拓扑" className="activity-board">
    <div className="activity-board-grid">
      <section className="relative min-w-0 space-y-2" aria-label={meeting ? '与会 Agent' : '执行 Agent'}>
        <h3 className="flex h-5 items-center gap-1.5 text-xs font-semibold text-muted"><Bot className="size-3.5" />{meeting ? '与会 Agent' : '执行 Agent'}</h3>
        {workers.length ? <FlowMembers entries={workers} picked={picked} onPick={onPick} now={now} /> :
          <p className="activity-empty rounded-lg border border-dashed border-line p-3 text-xs text-muted">等待分派任务</p>}
        <span className="activity-connector" data-live={firstLinkActive} aria-hidden="true" />
      </section>
      <section className="relative min-w-0 space-y-2" aria-label={meeting ? '会议调度' : '编排器'}>
        <h3 className="flex h-5 items-center gap-1.5 text-xs font-semibold text-accent"><Waypoints className="size-3.5" />{meeting ? '会议调度' : '编排器'}</h3>
        <div className="rounded-xl border border-accent/20 bg-accent-soft/25 px-3 py-2.5">
          <p className="line-clamp-2 text-xs font-semibold leading-5 text-ink [overflow-wrap:anywhere]" title={flowTitle}>{flowTitle}</p>
          <div className="mt-2 flex flex-wrap items-center gap-2 text-[10px] text-muted">
            <span className={cn('size-1.5 rounded-full', active.length ? 'bg-accent' : 'bg-line-strong')} />
            {active.length ? active.length + ' 项执行中' : idleLabel ?? (entries.length ? '当前无活动调用' : '等待 Agent 启动')}
          </div>
          {coordinator && <button type="button" aria-label={'打开编排器对话 · ' + coordinator.title}
            data-flow-member={memberKey(coordinator)} aria-pressed={coordinator.id === picked}
            onClick={() => onPick(coordinator.id)}
            className="activity-member mt-2 flex w-full min-w-0 items-center gap-1.5 rounded-md border px-2 py-1.5 text-left">
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[11px] font-medium text-ink" title={coordinator.agentLabel}>{coordinator.agentLabel}</span>
              {coordinator.model && <span className="block truncate text-[10px] text-accent" title={modelLabel(coordinator.model)}>{modelLabel(coordinator.model)}</span>}
            </span>
            <MessageCircle className="size-3.5 shrink-0 text-muted" aria-hidden="true" />
          </button>}
        </div>
        <span className="activity-connector" data-live={secondLinkActive} aria-hidden="true" />
      </section>
      <section className="min-w-0 space-y-2" aria-label={meeting ? '方案交付' : '审查与交付'}>
        <h3 className="flex h-5 items-center gap-1.5 text-xs font-semibold text-muted"><ShieldCheck className="size-3.5" />{meeting ? '方案交付' : '审查与交付'}</h3>
        {review.length > 0 && <FlowMembers entries={review} picked={picked} onPick={onPick} now={now} />}
        <div className="rounded-lg border border-line bg-surface px-2.5 py-2 text-[11px]">
          {output ? <a href={output.link} className="flex min-w-0 items-center gap-1.5 text-accent hover:underline" title={output.description}>
            <FolderOutput className="size-3.5 shrink-0" /><span className="truncate">{output.name}</span><ArrowUpRight className="size-3 shrink-0" />
          </a> : <p className="flex items-center gap-1.5 text-muted"><FolderOutput className="size-3.5" />等待交付产物</p>}
          {reports.length > 0 && <details className="mt-1.5">
            <summary className="flex cursor-pointer list-none items-center gap-1.5 text-muted"><FileText className="size-3.5" />任务报告<ChevronDown className="size-3.5" /></summary>
            <ul className="mt-1 space-y-1 break-words text-ink [overflow-wrap:anywhere]">{reports.map((report, index) =>
              <li key={index} className="border-t border-line py-1">{report}</li>)}</ul>
          </details>}
        </div>
      </section>
    </div>
  </section>;
}

export function AgentActivityPanel({ runId, title, onOpen, idleLabel }: {
  runId: string;
  title: string;
  idleLabel?: string;
  onOpen: (entry: AgentInterval) => void;
}) {
  const { data, source, reload, loading } = useApiResource(() => fetchAgentActivity(runId), null);
  const { data: board, reload: reloadBoard } = useApiResource(() => fetchBlackboard(runId), null);
  useLiveRefresh(source === 'live', reload, { runId, refreshIntervalMs: 500 });
  useLiveRefresh(source === 'live', reloadBoard, { runId, refreshIntervalMs: 1800 });
  const [picked, setPicked] = useState<string | null>(null);
  const entries = data?.intervals ?? [];
  const active = entries.filter((entry) => entry.status === 'running');
  const working = new Set(active.map((entry) => entry.agentId)).size;
  const reports = board?.entries.filter((entry) => entry.source === 'agent').slice(-3)
    .map((entry) => entry.author + ' · ' + entry.text) ?? [];

  function open(id: string) {
    const entry = entries.find((item) => item.id === id);
    if (!entry) return;
    setPicked(id);
    onOpen(entry);
  }

  return <Card className="min-w-0 overflow-hidden">
    <header className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-4 py-3">
      <h2 className="flex items-center gap-2 text-sm font-semibold text-ink"><Activity className="size-4 text-accent" />Agent 监控</h2>
      <div className="flex items-center gap-2 text-[11px] tabular-nums text-muted">
        {active.length > 0 && <span className="size-1.5 rounded-full bg-success" />}
        <span>{loading && !data ? '读取中…' : data ? working + ' 个 Agent · ' + active.length + ' 项执行中' : '暂时无法读取'}</span>
        {data?.mode === 'mock' && <span>回放</span>}
      </div>
    </header>
    <div className="space-y-4 p-3 sm:p-4">
      <ActiveFlow entries={entries} title={title} picked={picked} onPick={open} idleLabel={idleLabel}
        output={board?.hasOutput ? { link: '/api/runs/' + encodeURIComponent(runId) + '/output', name: '下载集成产物', description: '已落盘的交付文件' } : undefined}
        reports={reports} />
      <ActivityTimeline intervals={entries} picked={picked} onPick={open} />
    </div>
  </Card>;
}

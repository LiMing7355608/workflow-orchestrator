import { Activity, ArrowRight, Clock3, FileText, FolderOutput, Radio } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { fetchAgentActivity, fetchBlackboard, fetchMeeting } from '../../lib/api';
import { cn } from '../../lib/cn';
import { useApiResource, useLiveRefresh } from '../../lib/use-api';
import type { AgentInterval } from '../../types/operations';
import { Card } from '../ui/Card';
import { AgentLogo } from './AgentLogo';

const roleLabel: Record<AgentInterval['role'], string> = {
  spec: '规格访谈', plan: 'PM 分解', check: '草案核对', amend: '调整编排', implement: '实现', review: '审查', meeting: '会议',
};
const memberKey = (entry: AgentInterval) => entry.agentId + "/" + (entry.lane ?? entry.role);
const statusLabel: Record<AgentInterval['status'], string> = {
  running: '运行中', completed: '已返回', failed: '失败', interrupted: '已中断',
};
const ticks = [0, 25, 50, 75, 100];
const formatTime = (time: number, includeDate = false) => new Intl.DateTimeFormat('zh-CN', {
  ...(includeDate ? { month: '2-digit', day: '2-digit' } : {}),
  hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
}).format(time);

function elapsed(from: number, to: number) {
  const seconds = Math.max(0, Math.floor((to - from) / 1000));
  return seconds < 60 ? seconds + ' 秒' : Math.floor(seconds / 60) + ' 分 ' + seconds % 60 + ' 秒';
}

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

export function ActivityTimeline({ intervals, picked, onPick }: {
  intervals: AgentInterval[];
  picked: string | null;
  onPick: (id: string) => void;
}) {
  const now = useCurrentTime(intervals.some((entry) => entry.status === 'running'));
  const [focus, setFocus] = useState(true);
  const series = intervals.map((entry) => ({
    ...entry,
    start: Date.parse(entry.startedAt),
    end: entry.finishedAt ? Date.parse(entry.finishedAt) : now,
  })).filter((entry) => Number.isFinite(entry.start) && Number.isFinite(entry.end));
  const live = series.some((entry) => entry.status === 'running');
  if (!series.length) return <p className="rounded-xl border border-dashed border-line p-4 text-xs text-muted">执行开始后，时间图谱会显示每次调用的起止时间。</p>;

  const last = Math.max(...series.map((entry) => Math.max(entry.start, entry.end)));
  const earliest = Math.min(...series.map((entry) => entry.start), last - 15_000);
  const first = focus ? Math.max(earliest, last - 15 * 60_000) : earliest;
  const duration = last - first + Math.max(600, Math.round((last - first) * 0.035));
  const shown = series.filter((entry) => entry.end >= first);
  const lanes = new Map<string, typeof shown>();
  for (const entry of shown) {
    const key = memberKey(entry);
    const lane = lanes.get(key) ?? [];
    lane.push(entry);
    lanes.set(key, lane);
  }
  return (
    <section aria-label="时间图谱">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <h3 className="flex items-center gap-2 text-[13px] font-semibold text-ink"><Clock3 className="size-4 text-muted" />时间图谱</h3>
        <div className="flex items-center gap-2 text-[10px] text-muted">
          <span className="hidden sm:inline">{live ? '实时推进' : '执行回看'}</span>
          <select aria-label="时间图谱范围" value={focus ? 'recent' : 'all'} onChange={(event) => setFocus(event.target.value === 'recent')}
            className="rounded-lg border border-line bg-surface px-2 py-1.5 text-ink">
            <option value="recent">最近 15 分钟</option><option value="all">完整时间范围</option>
          </select>
        </div>
      </div>
      <div className="overflow-x-auto rounded-xl border border-line">
        <div className="min-w-[550px]">
          <div className="grid grid-cols-[142px_minmax(0,1fr)] gap-3 border-b border-line bg-subtle/40 px-3 py-2 text-[10px] font-medium text-muted">
            <div>成员与职责</div>
            <div className="flex justify-between gap-2 font-mono tabular-nums">
              {ticks.map((percent) => <time key={percent}>{formatTime(first + duration * percent / 100, duration >= 86_400_000)}</time>)}
            </div>
          </div>
          {[...lanes].map(([key, lane]) => (
            <div key={key} className="grid grid-cols-[142px_minmax(0,1fr)] gap-3 border-b border-line px-3 py-2.5 last:border-b-0">
              <div className="min-w-0 self-center">
                <p className="truncate text-[11px] font-semibold text-ink" title={lane[0]!.agentLabel}>{lane[0]!.lane ?? roleLabel[lane[0]!.role]}</p>
                <p className="truncate text-[10px] text-muted">{lane[0]!.agentLabel}</p>
              </div>
              <div className="relative space-y-1">
                {live && <div aria-hidden="true" className="pointer-events-none absolute inset-y-0 z-10 border-l border-accent/55" style={{ left: (last - first) / duration * 100 + '%' }} />}
                {packIntervals(lane).map((track, index) => (
                  <div className="relative h-7 rounded-md bg-subtle/60" key={index}>
                    <div className="pointer-events-none absolute inset-0 flex justify-between" aria-hidden="true">
                      {ticks.map((tick) => <span key={tick} className="border-l border-line" />)}
                    </div>
                    {track.map((entry) => {
                      const left = Math.min(98, (Math.max(entry.start, first) - first) / duration * 100);
                      const width = Math.min(100 - left, Math.max(1, (entry.end - Math.max(entry.start, first)) / duration * 100));
                      const label = entry.title + ' · ' + statusLabel[entry.status] + ' · ' + formatTime(entry.start) + ' · ' + elapsed(entry.start, entry.end);
                      return <button type="button" key={entry.id} aria-pressed={entry.id === picked} onClick={() => onPick(entry.id)} title={label} aria-label={label}
                        data-state={entry.status} className={cn('activity-span absolute inset-y-1 min-w-[6px] truncate rounded-sm px-1 text-left text-[9px] font-medium text-ink hover:ring-1 hover:ring-accent', entry.id === picked && 'z-10 ring-2 ring-accent')}
                        style={{ left: left + '%', width: width + '%' }}>{entry.title}</button>;
                    })}
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function packIntervals<T extends { start: number; end: number }>(lane: T[]) {
  const tracks: T[][] = [];
  for (const entry of [...lane].sort((a, b) => a.start - b.start)) {
    const track = tracks.find((items) => items[items.length - 1]!.end < entry.start);
    if (track) track.push(entry);
    else tracks.push([entry]);
  }
  return tracks;
}

interface FlowOutput { link: string; name: string; description: string }

function FlowConnection({ live, output = false }: { live: boolean; output?: boolean }) {
  const curve = output ? 'M1 7 C10 7 17 25 35 25' : 'M1 17 C13 17 23 17 35 17';
  return <svg className="activity-wire" aria-hidden="true" viewBox="0 0 36 34" preserveAspectRatio="none" data-live={live}>
    <path className="activity-wire-base" d={curve} pathLength={100} />
    {live && <path className="activity-wire-pulse" d={curve} pathLength={100} />}
    <circle cx="2" cy={output ? '7' : '17'} r="1.5" />
    <circle cx="34" cy={output ? '25' : '17'} r="1.5" />
  </svg>;
}

export function ActiveFlow({ entries, picked, onPick, output, reports = [] }: {
  entries: AgentInterval[]; picked: string | null; onPick: (id: string) => void; output?: FlowOutput; reports?: string[];
}) {
  const current = entries.filter((entry) => entry.status === 'running');
  const now = useCurrentTime(current.length > 0);
  const first = entries[0];
  if (!first) return <div className="rounded-xl border border-dashed border-line px-4 py-4 text-xs text-muted">Agent 开始执行后，这里会显示分工和协作路径。</div>;
  const members = new Map<string, AgentInterval[]>();
  for (const entry of entries) {
    const key = memberKey(entry);
    const history = members.get(key) ?? [];
    history.push(entry);
    members.set(key, history);
  }
  const group = [...members].sort(([, a], [, b]) => Number(b.some((entry) => entry.status === 'running')) - Number(a.some((entry) => entry.status === 'running')));
  const latest = [...current, ...entries.filter((entry) => entry.status !== 'running')];
  const workKind = first.role === 'meeting' ? '会议协调' : first.role === 'spec' ? '设计规格' : '工作流编排';
  const coordinator = entries.find((entry) => entry.role === 'plan' || entry.lane === '主持人' || entry.role === 'spec');
  const detailPath = first.role === 'meeting' ? '/meetings/' + first.runId : first.role === 'spec' ? undefined : '/runs/' + first.runId;
  return <section aria-label="实时调用拓扑" className="activity-map rounded-xl border border-line p-3 sm:p-4">
    <div className="activity-map-grid">
      <div className="min-w-0 space-y-2">
        <h3 className="text-[11px] font-semibold text-muted">执行成员 <span className="tabular-nums text-accent">{members.size}</span></h3>
        {group.map(([key, history]) => {
          const head = history[0]!;
          const active = history.filter((entry) => entry.status === 'running');
          const shown = [...active, ...history.filter((entry) => entry.status !== 'running').slice(0, Math.max(0, 3 - active.length))];
          return <div key={key} className="relative rounded-lg border border-line bg-surface p-2.5" data-active={active.length > 0}>
            <div className="mb-2 flex items-center gap-2">
              <AgentLogo label={head.agentLabel} className="size-6 shrink-0" />
              <div className="min-w-0 flex-1">
                <p className="truncate text-xs font-semibold text-ink" title={head.agentLabel}>{head.lane ?? head.agentLabel}</p>
                <p className="truncate text-[10px] text-muted">{head.lane ? head.agentLabel : roleLabel[head.role]}{head.model && ` · ${head.model}`}</p>
              </div>
              {active.length > 0 && <span className="activity-live-dot shrink-0" title="有调用在运行" />}
            </div>
            {shown.map((entry) => <button type="button" key={entry.id} aria-pressed={entry.id === picked} onClick={() => onPick(entry.id)} className={cn('block w-full min-w-0 rounded-md px-1.5 py-1 text-left hover:bg-subtle', entry.id === picked && 'bg-accent-soft')}>
              <div className="flex items-center justify-between gap-1">
                <span className="truncate text-[11px] font-medium text-ink" title={entry.title}>{entry.title}</span>
                <span className="activity-state shrink-0 text-[10px]" data-state={entry.status}>{entry.status === 'running' ? elapsed(Date.parse(entry.startedAt), now) : statusLabel[entry.status]}</span>
              </div>
              <p className="truncate text-[10px] text-muted" title={entry.progress || entry.description}>{entry.progress || entry.description}</p>
            </button>)}
            <FlowConnection live={active.length > 0} />
          </div>;
        })}
      </div>
      <div className="activity-hub relative min-w-0 space-y-2">
        <h3 className="text-[11px] font-semibold text-muted">调度与汇总</h3>
        <div className="flex flex-col rounded-lg border border-blue-200/80 bg-surface/95 shadow-sm">
          <div className="border-b border-line bg-accent-soft/35 p-3">
            <div className="flex items-center gap-1.5 text-[10px] font-semibold text-accent"><Radio className="size-3.5" />{workKind}<span className="ml-auto whitespace-nowrap">{current.length} 个执行中</span></div>
            <p className="mt-1.5 break-words text-sm font-semibold text-ink">{first.runTitle}</p>
            {coordinator && <p className="mt-0.5 truncate text-[10px] text-muted" title={coordinator.agentLabel}>协调 Agent · {coordinator.agentLabel}{coordinator.model && ` · ${coordinator.model}`}</p>}
          </div>
          <div className="divide-y divide-line px-2.5" aria-label="调用进程">
            {latest.slice(0, Math.max(6, current.length)).map((entry) => <button key={entry.id} type="button" aria-pressed={entry.id === picked} onClick={() => onPick(entry.id)}
              className={cn('flex w-full items-center gap-1.5 px-1 py-1.5 text-left hover:bg-subtle', entry.id === picked && 'bg-accent-soft')}>
              <span className="min-w-0 flex-1 truncate text-[11px] text-ink" title={entry.title}>{entry.title}</span>
              <span className="activity-state shrink-0 text-[10px]" data-state={entry.status}>{statusLabel[entry.status]}</span>
            </button>)}
          </div>
          {detailPath && <Link to={detailPath} className="flex items-center justify-end gap-1 border-t border-line px-3 py-2 text-[11px] font-medium text-accent">打开详情<ArrowRight className="size-3" /></Link>}
        </div>
      </div>
      <div className="min-w-0 space-y-2">
        <h3 className="text-[11px] font-semibold text-muted">产物与报告</h3>
        <div className="activity-result relative rounded-lg border border-line bg-surface p-2.5">
          <FlowConnection live={false} output />
          <h4 className="flex items-center gap-1.5 text-[11px] font-semibold text-ink"><FolderOutput className="size-3.5 text-accent" />产物</h4>
          {output ? <a className="mt-1 block break-words text-[11px] font-medium text-accent hover:underline" href={output.link}>{output.name} · {output.description}</a> :
            <p className="mt-1 text-[11px] text-muted">暂无可下载产物</p>}
        </div>
        <div className="activity-result relative rounded-lg border border-line bg-surface p-2.5">
          <FlowConnection live={false} output />
          <h4 className="flex items-center gap-1.5 text-[11px] font-semibold text-ink"><FileText className="size-3.5 text-emerald-700" />任务报告</h4>
          {reports.length > 0 ? <ul className="mt-1 space-y-1">
            {reports.map((report, index) => <li className="line-clamp-2 text-[11px] text-muted" key={index} title={report}>{report}</li>)}
          </ul> : <p className="mt-1 text-[11px] text-muted">等待 Agent 回传报告</p>}
        </div>
      </div>
    </div>
  </section>;
}

function RunFlow({ entries, picked, onPick }: { entries: AgentInterval[]; picked: string | null; onPick: (id: string) => void }) {
  const first = entries[0]!;
  const id = first.runId;
  const reportType = first.role === 'meeting' ? 'meeting' : first.role === 'spec' ? 'none' : 'run';
  const { data: results, reload } = useApiResource(async () => {
    if (reportType === 'run') {
      const board = await fetchBlackboard(id);
      return {
        output: board?.hasOutput ? { link: '/api/runs/' + encodeURIComponent(id) + '/output', name: 'output.zip', description: '运行产物' } : undefined,
        reports: board?.entries.filter((entry) => entry.source === 'agent').slice(-3).reverse().map((entry) => entry.author + ' · ' + entry.text) ?? [],
      };
    }
    if (reportType === 'meeting') {
      const room = await fetchMeeting(id);
      return {
        output: room?.report ? { link: '/api/meetings/' + encodeURIComponent(id) + '/report', name: 'solution.md', description: room.reportStale ? '上次方案' : '会议方案' } : undefined,
        reports: room?.messages.filter((message) => message.kind === 'agent').slice(-3).reverse().map((message) => message.author + ' · ' + message.text) ?? [],
      };
    }
    return { output: undefined, reports: [] };
  }, null);
  useLiveRefresh(reportType !== 'none', reload, { runId: id, refreshIntervalMs: 1000 });
  return <ActiveFlow entries={entries} picked={picked} onPick={onPick} output={results?.output} reports={results?.reports} />;
}

export function AgentActivityPanel() {
  const { data, source, reload, loading } = useApiResource(fetchAgentActivity, null);
  useLiveRefresh(source === 'live', reload, { refreshIntervalMs: 550 });
  const [runFilter, setRunFilter] = useState('');
  const [picked, setPicked] = useState<string | null>(null);
  const intervals = useMemo(() => data?.intervals ?? [], [data]);
  const runs = useMemo(() => new Map(intervals.map((entry) => [entry.runId, entry.runTitle])), [intervals]);
  const scoped = (!runFilter || runs.has(runFilter)) && runFilter ? intervals.filter((entry) => entry.runId === runFilter) : intervals;
  const running = scoped.filter((entry) => entry.status === 'running');
  const selected = scoped.find((entry) => entry.id === picked);
  const focusId = selected?.runId ?? running[0]?.runId ?? scoped[0]?.runId;
  const flow = scoped.filter((entry) => entry.runId === focusId);
  const link = selected?.role === 'meeting' ? '/meetings/' + selected.runId : selected?.role === 'spec' ? undefined : '/runs/' + selected?.runId;
  return (
    <Card className="space-y-4 p-4 sm:p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="flex items-center gap-2 text-sm font-semibold text-ink"><Activity className="size-4 text-accent" />Agent 运行监控</h2>
          <p className="mt-1 text-xs text-muted">{loading && !data ? '正在读取…' : '当前 ' + running.length + ' 个 Agent 调用正在执行'}{data?.mode === 'mock' ? ' · 回放模式' : ''}</p>
        </div>
        <label className="flex items-center gap-2 text-[11px] text-muted">运行范围
          <select aria-label="按运行筛选" value={runs.has(runFilter) ? runFilter : ''} onChange={(event) => { setRunFilter(event.target.value); setPicked(null); }}
            className="max-w-[215px] rounded-lg border border-line bg-surface px-2 py-1.5 text-[11px] text-ink">
            <option value="">全部运行</option>
            {[...runs].map(([id, title]) => <option value={id} key={id}>{title}</option>)}
          </select>
        </label>
      </div>
      {focusId && flow.length > 0 ? <RunFlow key={focusId} entries={flow} picked={picked} onPick={setPicked} /> :
        <ActiveFlow entries={[]} picked={picked} onPick={setPicked} />}
      <ActivityTimeline intervals={scoped} picked={picked} onPick={setPicked} />
      {selected && (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-line bg-subtle/35 px-3 py-2.5">
          <div className="min-w-0">
            <p className="text-xs font-semibold text-ink">{selected.title} · {statusLabel[selected.status]}</p>
            <p className="mt-0.5 break-words text-[11px] text-muted">{selected.description}</p>
          </div>
          {link && <Link className="flex items-center gap-1.5 text-xs font-medium text-accent" to={link}>查看{selected.role === 'meeting' ? '会议' : '运行'}<ArrowRight className="size-3.5" /></Link>}
        </div>
      )}
    </Card>
  );
}

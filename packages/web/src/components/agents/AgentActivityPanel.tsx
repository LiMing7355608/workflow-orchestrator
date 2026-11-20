import { Activity, ArrowUpRight, ChevronDown, Clock3, FileText, FolderOutput, MessageCircle, Waypoints } from 'lucide-react';
import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
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
  implement: '实现', review: '审查', meeting: '会议',
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
              <p className="truncate text-[10px] text-muted">{entry.agentLabel}</p>
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

function useFlowPaths(ref: RefObject<HTMLDivElement | null>, layoutKey: string) {
  const [paths, setPaths] = useState<Array<{ id: string; d: string }>>([]);
  useLayoutEffect(() => {
    const root = ref.current;
    if (!root) return;
    const hub = root.querySelector('[data-flow-hub]');
    const tiles = [...root.querySelectorAll<HTMLElement>('[data-flow-member]')];
    if (!hub) return;
    function measure() {
      const frame = root!.getBoundingClientRect();
      const target = hub!.getBoundingClientRect();
      const lines = tiles.flatMap((tile, index) => {
        const rect = tile.getBoundingClientRect();
        if (target.left - rect.right < 8) return [];
        const x1 = rect.right - frame.left;
        const x2 = target.left - frame.left;
        const rail = (x1 + x2) / 2;
        const y1 = rect.top + rect.height / 2 - frame.top;
        const y2 = target.top - frame.top + 12 + Math.min(96, target.height - 24) * (index + 1) / (tiles.length + 1);
        return [{ id: tile.dataset.flowMember!, d: 'M' + x1 + ' ' + y1 + ' C' + rail + ' ' + y1 + ' ' + rail + ' ' + y2 + ' ' + x2 + ' ' + y2 }];
      });
      setPaths((previous) => previous.length === lines.length && previous.every((line, index) => line.id === lines[index]?.id && line.d === lines[index]?.d) ? previous : lines);
    }
    const observer = new ResizeObserver(measure);
    observer.observe(root);
    observer.observe(hub);
    for (const tile of tiles) observer.observe(tile);
    measure();
    return () => observer.disconnect();
  }, [ref, layoutKey]);
  return paths;
}

export function ActiveFlow({ entries, picked, onPick, output, reports = [], title }: {
  entries: AgentInterval[];
  picked: string | null;
  onPick: (id: string) => void;
  output?: FlowOutput;
  reports?: string[];
  title?: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const board = useRef<HTMLDivElement>(null);
  const active = entries.filter((entry) => entry.status === 'running');
  const now = useCurrentTime(active.length > 0);
  const groups = new Map<string, AgentInterval[]>();
  for (const entry of entries) {
    const key = memberKey(entry);
    const history = groups.get(key) ?? [];
    history.push(entry);
    groups.set(key, history);
  }
  const rows = [...groups].map(([id, history]) => {
    const running = history.filter((entry) => entry.status === 'running');
    return { id, history, current: running[0] ?? history[0]!, active: running.length };
  }).sort((a, b) => Number(b.active > 0) - Number(a.active > 0));
  const visible = expanded ? rows : rows.slice(0, 4);
  const paths = useFlowPaths(board, visible.map((row) => row.id).join('|'));
  const first = entries[0];

  if (!first) return <p className="rounded-lg border border-dashed border-line p-4 text-xs text-muted">暂无 Agent 调用记录。</p>;
  return <section aria-label="实时调用拓扑" className="activity-board">
    <div className="activity-board-grid relative" ref={board}>
      <svg className="pointer-events-none absolute inset-0 h-full w-full overflow-visible" aria-hidden="true">
        {paths.map((path) => {
          const live = visible.some((row) => row.id === path.id && row.active);
          return <g key={path.id} data-live={live}>
            <path d={path.d} className="activity-connection" />
            {live && <path d={path.d} pathLength={100} className="activity-connection-motion" />}
          </g>;
        })}
      </svg>
      <div className="relative min-w-0 space-y-1.5">
        {visible.map(({ id, current, active, history }) => <button key={id} data-flow-member={id} data-state={current.status} type="button"
          onClick={() => onPick(current.id)} aria-pressed={history.some((entry) => entry.id === picked)}
          aria-label={'打开 ' + current.agentLabel + ' · ' + current.title + ' 的对话'}
          className="activity-member flex w-full items-center gap-2.5 rounded-lg border px-2.5 py-2 text-left">
          <AgentLogo src={current.agentLogo} label={current.agentLabel} className="size-7 shrink-0 rounded-lg" />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[12px] font-semibold text-ink" title={current.title}>{current.lane ?? current.title}</span>
            <span className="block truncate text-[10px] text-muted" title={current.agentLabel}>{current.agentLabel}{current.model && ' · ' + modelLabel(current.model)}</span>
          </span>
          <span className="min-w-0 shrink-0 text-right text-[10px]">
            <span className="activity-state block" data-state={current.status}>{active ? formatDuration(Math.max(0, now - Date.parse(current.startedAt))) : states[current.status]}</span>
            {history.length > 1 && <span className="block text-muted">{history.length} 次调用</span>}
          </span>
          <MessageCircle className="size-3.5 shrink-0 text-muted" aria-hidden="true" />
        </button>)}
        {rows.length > 4 && <Button size="sm" variant="ghost" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>
          <ChevronDown className={cn('size-3.5', expanded && 'rotate-180')} />{expanded ? '收起成员' : '展开另外 ' + (rows.length - 4) + ' 项'}
        </Button>}
      </div>
      <div data-flow-hub className="relative min-w-0 self-start rounded-xl border border-line bg-surface">
        <div className="border-b border-line px-3 py-2.5">
          <div className="flex items-center justify-between gap-2 text-[10px] text-muted">
            <span className="flex items-center gap-1.5"><Waypoints className="size-3.5 text-accent" />{first.role === 'meeting' ? '会议调度' : '调度与交付'}</span>
            <span className={cn('shrink-0 tabular-nums', active.length > 0 && 'font-medium text-accent')}>{active.length} 项执行中</span>
          </div>
          <p className="mt-1 line-clamp-2 break-words text-[13px] font-semibold text-ink [overflow-wrap:anywhere]" title={title ?? first.runTitle}>{title ?? first.runTitle}</p>
        </div>
        <div className="space-y-1.5 px-3 py-2 text-[11px]">
          {active.length > 0 && <p className="truncate text-accent" title={active[0]?.progress ?? active[0]?.description}>
            {active[0]?.progress ?? active[0]?.title}{active.length > 1 && ' · 另 ' + (active.length - 1) + ' 项'}
          </p>}
          {output ? <a href={output.link} className="flex min-w-0 items-center gap-1.5 text-accent hover:underline" title={output.description}>
            <FolderOutput className="size-3.5 shrink-0" /><span className="truncate">{output.name}</span><ArrowUpRight className="size-3 shrink-0" />
          </a> : <p className="flex items-center gap-1.5 text-muted"><FolderOutput className="size-3.5" />暂无产物</p>}
          {reports.length > 0 && <details>
            <summary className="flex cursor-pointer list-none items-center gap-1.5 text-muted"><FileText className="size-3.5" />任务报告<ChevronDown className="size-3.5" /></summary>
            <ul className="mt-1 space-y-1 break-words text-ink [overflow-wrap:anywhere]">{reports.map((report, index) =>
              <li key={index} className="border-t border-line py-1">{report}</li>)}</ul>
          </details>}
        </div>
      </div>
    </div>
  </section>;
}

export function AgentActivityPanel({ runId, title, onOpen }: {
  runId: string;
  title: string;
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
      <ActiveFlow entries={entries} title={title} picked={picked} onPick={open}
        output={board?.hasOutput ? { link: '/api/runs/' + encodeURIComponent(runId) + '/output', name: '下载集成产物', description: '已落盘的交付文件' } : undefined}
        reports={reports} />
      <ActivityTimeline intervals={entries} picked={picked} onPick={open} />
    </div>
  </Card>;
}

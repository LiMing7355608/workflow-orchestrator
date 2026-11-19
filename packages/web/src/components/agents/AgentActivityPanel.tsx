import { Activity, Clock3 } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { fetchAgentActivity } from '../../lib/api';
import { cn } from '../../lib/cn';
import { useApiResource, useLiveRefresh } from '../../lib/use-api';
import type { AgentInterval } from '../../types/operations';
import { Card } from '../ui/Card';
import { AgentLogo } from './AgentLogo';

const roleLabel: Record<AgentInterval['role'], string> = {
  spec: '规格访谈', plan: 'PM 分解', amend: '改图', implement: '实现', review: '审查',
};

const statusLabel: Record<AgentInterval['status'], string> = {
  running: '执行中', completed: '已返回', failed: '失败', interrupted: '已中断',
};

const statusColor: Record<AgentInterval['status'], string> = {
  running: 'bg-accent/35', completed: 'bg-success/35', failed: 'bg-danger/35', interrupted: 'bg-warning/35',
};

const tickPositions = [0, 25, 50, 75, 100];

function formatTime(time: number, withDate = false): string {
  return new Intl.DateTimeFormat('zh-CN', {
    ...(withDate ? { month: '2-digit', day: '2-digit' } : {}),
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).format(time);
}

function Timeline({ intervals, now }: { intervals: AgentInterval[]; now: number }) {
  const series = intervals.map((entry) => ({
    ...entry,
    start: Date.parse(entry.startedAt),
    end: entry.finishedAt ? Date.parse(entry.finishedAt) : now,
  })).filter((entry) => Number.isFinite(entry.start) && Number.isFinite(entry.end));
  if (!series.length) return <p className="py-5 text-[12px] text-muted">暂无可显示的执行记录。</p>;

  const first = Math.min(...series.map((entry) => entry.start));
  const last = Math.max(first + 5000, ...series.map((entry) => Math.max(entry.start, entry.end)));
  const duration = last - first;
  const lanes = new Map<string, typeof series>();
  for (const entry of series) {
    const key = entry.agentId + '/' + entry.role;
    const lane = lanes.get(key) ?? [];
    lane.push(entry);
    lanes.set(key, lane);
  }
  return (
    <div className="mt-3 overflow-x-auto rounded-xl border border-line">
      <div className="min-w-[650px]">
        <div className="grid grid-cols-[164px_minmax(0,1fr)] gap-4 border-b border-line bg-subtle/50 px-3 py-2 text-[10px] font-medium text-muted">
          <div>Agent / 职责</div>
          <div className="flex justify-between gap-2 font-mono tabular-nums">
            {tickPositions.map((percent) => (
              <time key={percent}>{formatTime(first + duration * percent / 100, duration >= 86_400_000)}</time>
            ))}
          </div>
        </div>
        {[...lanes].map(([key, lane]) => (
          <div key={key} className="grid grid-cols-[164px_minmax(0,1fr)] gap-4 border-b border-line px-3 py-2.5 last:border-b-0">
            <div className="min-w-0 self-center">
              <p className="truncate text-[12px] font-medium text-ink" title={lane[0]!.agentLabel}>{lane[0]!.agentLabel}</p>
              <p className="text-[10px] text-muted">{roleLabel[lane[0]!.role]}</p>
            </div>
            <div className="space-y-1">
              {lane.map((entry) => {
                const left = Math.min(99, (entry.start - first) / duration * 100);
                const width = Math.min(100 - left, Math.max(1, (entry.end - entry.start) / duration * 100));
                const label = entry.title + ' · ' + statusLabel[entry.status] + ' · ' +
                  formatTime(entry.start) + '–' + formatTime(Math.max(entry.end, entry.start));
                return (
                  <div key={entry.id} className="relative h-6 overflow-hidden rounded-md bg-subtle/60">
                    <div className="pointer-events-none absolute inset-0 flex justify-between" aria-hidden="true">
                      {tickPositions.map((tick) => <span key={tick} className="border-l border-line" />)}
                    </div>
                    <div aria-hidden="true" className={cn('absolute bottom-1 top-1 rounded', statusColor[entry.status])}
                      style={{ left: left + '%', width: width + '%' }} />
                    <span className="relative block truncate px-1.5 py-1 text-[10px] font-medium text-ink"
                      title={label + '\n' + entry.description}>{entry.title} · {statusLabel[entry.status]}</span>
                    <span className="sr-only">{label}</span>
                  </div>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

export function AgentActivityPanel() {
  const { data, source, reload, loading } = useApiResource(fetchAgentActivity, null);
  useLiveRefresh(source === 'live', reload, { refreshIntervalMs: 550 });
  const [runFilter, setRunFilter] = useState('');
  const [now, setNow] = useState(Date.now);
  const active = data?.active ?? 0;
  useEffect(() => {
    setNow(Date.now());
    if (active === 0) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [active]);
  const runs = useMemo(() => {
    const entries = data?.intervals ?? [];
    return Array.from(new Map(entries.map((entry) => [entry.runId, entry.runTitle])));
  }, [data]);
  const selected = runs.some(([id]) => id === runFilter) ? runFilter : '';
  const shown = (data?.intervals ?? []).filter((entry) => !selected || entry.runId === selected);
  const executing = shown.filter((entry) => entry.status === 'running');
  const recent = [...executing, ...shown.filter((entry) => entry.status !== 'running').slice(0, 45)];

  return (
    <Card className="mt-5 p-4 sm:p-5">
      <div className="flex flex-wrap items-end justify-between gap-3 border-b border-line pb-3">
        <div>
          <h2 className="flex items-center gap-2 text-[15px] font-semibold text-ink">
            <Activity className="h-4 w-4 text-accent" /> Agent 运行监控
          </h2>
          <p className="mt-1 text-[12px] text-muted">
            {data ? <>当前 <strong className="text-ink">{active}</strong> 个 Agent 调用正在执行{data.mode === 'mock' ? '（回放模式）' : ''}</> :
              (loading ? '正在读取执行状态…' : '本地执行状态暂不可用。')}
          </p>
        </div>
        <label className="flex items-center gap-2 text-[11px] text-muted">
          运行
          <select aria-label="按运行筛选 Agent" value={selected} onChange={(event) => setRunFilter(event.target.value)}
            className="h-8 w-[190px] rounded-lg border border-line bg-surface px-2 text-[11px] text-ink">
            <option value="">全部运行</option>
            {runs.map(([id, title]) => <option value={id} key={id}>{title}</option>)}
          </select>
        </label>
      </div>
      {executing.length > 0 && (
        <div className="mt-3 grid gap-2 lg:grid-cols-2">
          {executing.map((entry) => (
            <article key={entry.id} className="min-w-0 rounded-xl border border-accent/20 bg-accent-soft/30 px-3 py-2.5">
              <div className="flex items-center gap-2">
                <AgentLogo label={entry.agentLabel} className="h-6 w-6 shrink-0" />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[12px] font-semibold text-ink">{entry.agentLabel}</p>
                  <p className="text-[10px] text-muted">{roleLabel[entry.role]}</p>
                </div>
                <span className="whitespace-nowrap text-[10px] font-medium text-accent">执行中</span>
              </div>
              <p className="mt-2 text-[12px] font-medium text-ink">{entry.title}</p>
              <p className="mt-0.5 line-clamp-2 break-words text-[11px] leading-4 text-muted">{entry.description}</p>
              {entry.role === 'spec' ? <p className="mt-1 truncate text-[10px] text-muted">{entry.runTitle}</p> : (
                <Link className="mt-1 block truncate text-[10px] text-accent hover:underline" to={'/runs/' + entry.runId}>{entry.runTitle}</Link>
              )}
            </article>
          ))}
        </div>
      )}
      {data && (
        <div className="mt-4">
          <h3 className="flex items-center gap-2 text-[13px] font-semibold text-ink">
            <Clock3 className="h-4 w-4 text-muted" /> 时间泳道
          </h3>
          <Timeline intervals={recent} now={now} />
        </div>
      )}
    </Card>
  );
}

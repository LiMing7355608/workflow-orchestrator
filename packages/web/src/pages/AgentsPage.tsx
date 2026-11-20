import { ArrowUpRight, ChevronDown, Radio, RefreshCw, Search, Settings2 } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { AgentCard } from '../components/agents/AgentCard';
import { AgentLogo } from '../components/agents/AgentLogo';
import { modelLabel } from '../components/agents/AgentModelField';
import { ModelProviderPanel } from '../components/agents/ModelProviderPanel';
import { Button } from '../components/ui/Button';
import { Card } from '../components/ui/Card';
import { seedAgents } from '../data/agents';
import { fetchAgentActivity, fetchAgents, probeAgents } from '../lib/api';
import { cn } from '../lib/cn';
import { useApiResource, useLiveRefresh } from '../lib/use-api';
import { usePageTitle } from '../lib/use-page-title';
import type { AgentInterval } from '../types/operations';

function activityLink(entry: AgentInterval): string {
  const id = encodeURIComponent(entry.runId);
  if (entry.role === 'spec') return '/new?spec=' + id;
  if (entry.role === 'meeting') return '/meetings/' + id;
  return '/runs/' + id + '?view=monitor';
}

function WorkingAgents() {
  const { data, loading, source, reload } = useApiResource(() => fetchAgentActivity(undefined, true), null);
  useLiveRefresh(source === 'live', reload, { refreshIntervalMs: 600 });
  const entries = data?.intervals ?? [];
  const agents = new Set(entries.map((entry) => entry.agentId)).size;
  return <Card className="overflow-hidden">
    <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-4 py-3 sm:px-5">
      <h2 className="flex items-center gap-2 text-sm font-semibold text-ink"><Radio className="size-4 text-accent" />正在运行的任务</h2>
      {data && <span className="inline-flex items-center gap-1.5 rounded-full bg-subtle px-2.5 py-1 text-[11px] tabular-nums text-muted">
        {entries.length > 0 && <span className="size-1.5 rounded-full bg-success" />}
        {agents} 个 Agent 工作中 · {entries.length} 项任务{data.mode === 'mock' && ' · 回放'}
      </span>}
    </div>
    {entries.length ? <ul className="divide-y divide-line">
      {entries.map((entry) => <li key={entry.id}>
        <Link to={activityLink(entry)} className="flex min-w-0 items-center gap-2.5 px-4 py-2.5 hover:bg-subtle/45 sm:px-5">
          <AgentLogo src={entry.agentLogo} label={entry.agentLabel} className="size-7 shrink-0" />
          <div className="min-w-0 flex-1">
            <p className="truncate text-xs font-semibold text-ink" title={entry.title}>{entry.title}</p>
            <p className="mt-0.5 truncate text-[11px] text-muted" title={entry.runTitle}>{entry.runTitle}</p>
          </div>
          <div className="hidden min-w-0 max-w-[32%] shrink-0 text-right sm:block">
            <p className="truncate text-[11px] font-medium text-muted" title={entry.agentLabel}>{entry.agentLabel}</p>
            {entry.model && <p className="truncate text-[10px] text-muted">{modelLabel(entry.model)}</p>}
          </div>
          <ArrowUpRight className="size-3.5 shrink-0 text-accent" aria-hidden="true" />
        </Link>
      </li>)}
    </ul> : <p className="px-4 py-6 text-sm text-muted sm:px-5">
      {loading && !data ? '正在读取…' : data ? '当前没有正在运行的任务。' : '暂时无法读取运行状态。'}
    </p>}
  </Card>;
}

export function AgentsPage() {
  usePageTitle('Agent 管理');
  const { data: profiles, source, reload } = useApiResource(fetchAgents, seedAgents);
  const [overrides, setOverrides] = useState<Record<string, boolean>>({});
  const [query, setQuery] = useState('');
  const [probing, setProbing] = useState(false);
  const [probeError, setProbeError] = useState('');
  const [configured, setConfigured] = useState(false);
  const keyword = query.trim().toLowerCase();
  const filtered = profiles.filter((agent) => [agent.label, agent.launch.bin, agent.vendor].some((word) => word.toLowerCase().includes(keyword)))
    .sort((a, b) => Number(a.availability === 'missing') - Number(b.availability === 'missing'));

  async function probe() {
    setProbing(true);
    setProbeError('');
    try {
      if (!await probeAgents()) { setProbeError('未能完成探测，请重试。'); return; }
      reload();
    } finally { setProbing(false); }
  }

  return <div className="mx-auto max-w-[1030px] space-y-4 px-4 py-6 sm:px-6 sm:py-7">
    <header><h1 className="text-[26px] font-semibold tracking-tight text-ink">Agent 管理</h1></header>
    <WorkingAgents />
    <Card className="overflow-hidden">
      <button type="button" className="flex w-full items-center gap-2.5 px-4 py-3 text-left text-xs font-semibold text-ink hover:bg-subtle/40 sm:px-5"
        aria-expanded={configured} onClick={() => setConfigured(!configured)}>
        <Settings2 className="size-4 text-muted" />客户端与接口设置
        <ChevronDown className={cn('ml-auto size-4 text-muted', configured && 'rotate-180')} />
      </button>
      {configured && <div className="space-y-3 border-t border-line bg-subtle/25 p-3 sm:p-4">
        <ModelProviderPanel onChanged={reload} />
        <div className="flex flex-wrap items-center gap-2">
          <label className="relative min-w-0 flex-1">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted" />
            <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索客户端" aria-label="搜索客户端"
              className="h-8 w-full rounded-lg border border-line bg-surface pl-8 pr-3 text-xs text-ink" />
          </label>
          <Button variant="secondary" size="sm" disabled={probing || source !== 'live'} onClick={() => void probe()}>
            <RefreshCw className={cn('size-3.5', probing && 'animate-spin motion-reduce:animate-none')} />{probing ? '探测中' : '重新探测'}
          </Button>
        </div>
        {probeError && <p role="alert" className="text-xs text-danger">{probeError}</p>}
        <div className="grid gap-2 lg:grid-cols-2">
          {filtered.map((agent) => <AgentCard key={agent.id} profile={{ ...agent, enabled: overrides[agent.id] ?? agent.enabled }}
            onToggle={(id, enabled) => setOverrides((previous) => ({ ...previous, [id]: enabled }))} />)}
        </div>
        {!filtered.length && <p className="text-xs text-muted">没有匹配的客户端。</p>}
      </div>}
    </Card>
  </div>;
}

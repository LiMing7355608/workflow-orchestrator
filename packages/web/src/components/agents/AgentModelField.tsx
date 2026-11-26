import { Check, ChevronDown, CircleHelp, Loader2, RefreshCw } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import { fetchAgentModels } from '../../lib/api';
import { cn } from '../../lib/cn';
import type { AgentProfile, ModelDirectory } from '../../types/agent';

export function canSelectModel(agent?: AgentProfile): boolean {
  return Boolean(agent && (agent.transport === 'acp' || agent.transport === 'codex-app-server' ||
    agent.transport === 'claude-sdk' || agent.transport === 'http-model' ||
    (!agent.transport || agent.transport === 'cli') && agent.launch.modelArgs));
}

export function modelLabel(value: string) {
  if (!value.startsWith('[')) return value;
  try {
    const ids: unknown = JSON.parse(value);
    if (Array.isArray(ids) && typeof ids.at(-1) === 'string') return ids.at(-1) as string;
  } catch { /* The configured value may be a literal ID. */ }
  return value;
}

export function AgentModelField({ agent, value, onChange, disabled = false, label = '模型' }: {
  agent?: AgentProfile;
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  label?: string;
}) {
  const id = useId();
  const anchor = useRef<HTMLDivElement>(null);
  const generation = useRef(0);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [directory, setDirectory] = useState<ModelDirectory>();
  const [loading, setLoading] = useState(false);
  const [failure, setFailure] = useState('');
  const available = canSelectModel(agent);
  const discovers = agent?.transport === 'acp' || agent?.transport === 'codex-app-server' || agent?.transport === 'http-model';
  const defaultModel = directory?.defaultModel ?? agent?.defaultModel;
  const defaultLabel = defaultModel ? '默认 · ' + modelLabel(defaultModel) : '客户端默认模型';
  const selected = directory?.models.find((model) => model.id === value);
  const filter = query.trim().toLocaleLowerCase();
  const matching = directory?.models.filter((model) =>
    [model.name, modelLabel(model.id), model.group].some((word) => word?.toLocaleLowerCase().includes(filter)),
  ) ?? [];

  useEffect(() => {
    generation.current += 1;
    setOpen(false);
    setDirectory(undefined);
    setFailure('');
    setLoading(false);
    return () => { generation.current += 1; };
  }, [agent?.id]);

  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => {
      if (event.target instanceof Node && !anchor.current?.contains(event.target)) setOpen(false);
    };
    document.addEventListener('pointerdown', close);
    return () => document.removeEventListener('pointerdown', close);
  }, [open]);

  async function refresh() {
    if (!agent || !discovers) return;
    const request = ++generation.current;
    setLoading(true);
    setFailure('');
    try {
      const next = await fetchAgentModels(agent.id, true);
      if (request === generation.current) setDirectory(next);
    } catch (error) {
      if (request === generation.current) setFailure((error as Error).message);
    } finally {
      if (request === generation.current) setLoading(false);
    }
  }

  function choose(model: string) {
    onChange(model);
    setOpen(false);
  }

  return <div ref={anchor} className="relative min-w-0 space-y-1.5" onKeyDown={(event) => {
    if (event.key === 'Escape') { event.stopPropagation(); setOpen(false); anchor.current?.querySelector('button')?.focus(); }
  }}>
    <span id={id + '-label'} className="block text-xs font-medium text-muted">{label}</span>
    <button type="button" aria-labelledby={id + '-label ' + id + '-choice'} aria-expanded={open}
      aria-controls={id + '-choices'} disabled={!available || disabled}
      className={cn('flex h-9 w-full min-w-0 items-center justify-between gap-2 rounded-lg border border-line bg-surface px-2.5 text-left text-xs text-ink transition-colors hover:border-accent/40 disabled:bg-subtle disabled:text-muted',
        open && 'border-accent/50 ring-2 ring-accent/10')}
      onClick={() => { setOpen(!open); if (!open) { setQuery(''); void refresh(); } }}>
      <span id={id + '-choice'} className="truncate">{selected?.name ?? (value ? modelLabel(value) : defaultLabel)}</span>
      <ChevronDown className={cn('size-4 shrink-0 text-muted', open && 'rotate-180')} />
    </button>
    {(!available || !discovers) && <p className="text-[11px] text-muted">{available ? '可填写客户端支持的模型 ID。' : '模型由所选客户端配置。'}</p>}
    {open && <div id={id + '-choices'} className="absolute z-30 mt-1 w-full min-w-0 rounded-xl border border-line bg-surface p-2 shadow-lg">
      <div className="flex gap-1.5">
        <input autoFocus aria-label="搜索或填写模型 ID" value={query} maxLength={512} placeholder="搜索或填写模型 ID"
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); if (query.trim()) choose(matching[0]?.id ?? query.trim()); } }}
          className="h-8 w-full min-w-0 rounded-md border border-line bg-subtle/40 px-2 text-xs text-ink" />
        {discovers && <button type="button" aria-label="刷新模型列表" title="刷新模型列表" disabled={loading} onClick={() => void refresh()}
          className="grid size-8 shrink-0 place-items-center rounded-md text-muted hover:bg-subtle hover:text-accent">
          <RefreshCw className={cn('size-3.5', loading && 'animate-spin motion-reduce:animate-none')} />
        </button>}
      </div>
      <div className="mt-1 max-h-48 overflow-auto overscroll-contain">
        {!filter && <button type="button" onClick={() => choose('')} className="flex w-full items-center gap-2 rounded-md px-2 py-2 text-left text-xs text-muted hover:bg-subtle">
          <CircleHelp className="size-3.5 shrink-0" /><span className="truncate">{defaultLabel}</span>{!value && <Check className="ml-auto size-3.5 text-accent" />}
        </button>}
        {matching.slice(0, 80).map((model) => <button key={model.id} type="button" onClick={() => choose(model.id)}
          className={cn('flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-subtle', model.id === value && 'bg-accent-soft')}>
          <span className="min-w-0 flex-1"><span className="block truncate text-xs font-medium text-ink">{model.name}</span>
            {model.group && <span className="block truncate text-[10px] text-muted">{model.group}</span>}</span>
          {model.id === value && <Check className="size-3.5 shrink-0 text-accent" />}
        </button>)}
        {filter && !matching.some((model) => model.id === query.trim()) && <button type="button" onClick={() => choose(query.trim())}
          className="w-full rounded-md px-2 py-2 text-left text-xs text-accent [overflow-wrap:anywhere] hover:bg-accent-soft">使用 ID {query.trim()}</button>}
      </div>
      {(loading || directory || failure) && <p role="status" className="mt-1 flex items-center gap-1 border-t border-line px-2 pt-1.5 text-[10px] leading-4 text-muted">
        {loading ? <><Loader2 className="size-3 shrink-0 animate-spin motion-reduce:animate-none" />正在读取模型…</> :
          failure || directory?.message || (directory && directory.source + ' · ' + directory.models.length + ' 个 · ' +
            new Date(directory.checkedAt).toLocaleTimeString('zh-CN'))}
      </p>}
    </div>}
  </div>;
}

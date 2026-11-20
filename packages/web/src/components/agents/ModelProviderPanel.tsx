import { KeyRound, Link2, Loader2, Plus } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { discoverModelProvider, fetchModelProviders, removeModelProvider, saveModelProvider } from '../../lib/api';
import { useApiResource } from '../../lib/use-api';
import type { ModelDirectory, ModelProvider, ModelProviderSettings } from '../../types/agent';
import { Button } from '../ui/Button';
import { Card } from '../ui/Card';

const empty: ModelProviderSettings = { label: '', protocol: 'openai', baseUrl: '' };
const field = 'min-h-9 w-full rounded-lg border border-line bg-surface px-2.5 py-2 text-xs text-ink';
const label = 'block min-w-0 space-y-1.5 text-xs font-medium text-muted';
const protocols = { openai: 'OpenAI 兼容', anthropic: 'Anthropic Messages' };

export function ModelProviderPanel({ onChanged }: { onChanged: () => void }) {
  const { data: profiles, source, reload } = useApiResource(fetchModelProviders, []);
  const [form, setForm] = useState<ModelProviderSettings>();
  const [directory, setDirectory] = useState<ModelDirectory>();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [deleting, setDeleting] = useState<string>();
  const original = profiles.find((item) => item.id === form?.id);
  const hasSavedKey = original?.hasKey && original.baseUrl === form?.baseUrl && original.protocol === form?.protocol;

  function edit(profile?: ModelProvider) {
    if (profile) {
      const { hasKey: _hasKey, ...settings } = profile;
      setForm(settings);
    } else setForm({ ...empty });
    setDeleting(undefined);
    setDirectory(undefined);
    setError('');
  }

  async function action(kind: 'read' | 'save' | 'delete', id?: string) {
    if (pending || kind !== 'delete' && !form) return;
    setPending(true);
    setError('');
    try {
      if (kind === 'delete' && id) {
        await removeModelProvider(id);
        if (form?.id === id) setForm(undefined);
        setDeleting(undefined);
      } else if (kind === 'save' && form) {
        if (!form.model?.trim()) throw new Error('请选择默认模型或填写模型 ID。');
        await saveModelProvider(form);
        setForm(undefined);
      } else if (form) {
        setDirectory(await discoverModelProvider(form));
        return;
      }
      reload();
      onChanged();
    } catch (failure) {
      setError((failure as Error).message);
    } finally {
      setPending(false);
    }
  }

  function patch(change: Partial<ModelProviderSettings>) {
    if (form) setForm({ ...form, ...change });
    if ('baseUrl' in change || 'protocol' in change || 'apiKey' in change) setDirectory(undefined);
  }

  function save(event: FormEvent) {
    event.preventDefault();
    void action('save');
  }

  return <Card className="space-y-3 p-4 sm:p-5">
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div>
        <h2 className="flex items-center gap-2 text-sm font-semibold text-ink"><Link2 className="size-4 text-accent" />自定义模型接口</h2>
        <p className="mt-1 text-xs text-muted">接入服务地址和 API 密钥，用于规格访谈、会议、任务拆解和文本审查。</p>
      </div>
      {!form && <Button type="button" variant="secondary" size="sm" onClick={() => edit()} disabled={source !== 'live'}>
        <Plus className="size-4" />添加接口
      </Button>}
    </div>
    {profiles.map((profile) => <div key={profile.id} className="flex flex-wrap items-center gap-2 rounded-lg border border-line px-3 py-2.5">
      <div className="min-w-0 flex-1">
        <p className="break-words text-xs font-semibold text-ink">{profile.label}<span className="ml-2 font-normal text-muted">{protocols[profile.protocol]}</span></p>
        <p className="mt-0.5 truncate text-[11px] text-muted" title={profile.baseUrl}>{profile.model} · {profile.baseUrl}</p>
      </div>
      <Button variant="ghost" size="sm" disabled={pending} onClick={() => edit(profile)}>编辑</Button>
      {deleting === profile.id ? <>
        <Button size="sm" variant="secondary" className="text-danger" disabled={pending} onClick={() => void action('delete', profile.id)}>确认移除</Button>
        <Button size="sm" variant="ghost" onClick={() => setDeleting(undefined)}>取消</Button>
      </> : <Button variant="ghost" size="sm" disabled={pending} onClick={() => setDeleting(profile.id)}>移除</Button>}
    </div>)}
    {form && <form onSubmit={save} className="space-y-3 rounded-xl border border-line bg-subtle/25 p-3 sm:p-4">
      <div className="grid gap-3 sm:grid-cols-2">
        <label className={label}><span>显示名称</span><input className={field} value={form.label} required maxLength={60}
          placeholder="例如 公司模型网关" onChange={(event) => patch({ label: event.target.value })} /></label>
        <label className={label}><span>接口协议</span><select className={field} value={form.protocol} onChange={(event) =>
          patch({ protocol: event.target.value as ModelProviderSettings['protocol'] })}>
          <option value="openai">{protocols.openai}</option><option value="anthropic">{protocols.anthropic}</option>
        </select></label>
        <label className={label}><span>服务地址（Base URL）</span><input className={field} type="url" value={form.baseUrl} required
          placeholder="https://example.com/v1" onChange={(event) => patch({ baseUrl: event.target.value })} /></label>
        <label className={label}><span className="flex items-center gap-1"><KeyRound className="size-3" />API 密钥</span>
          <input className={field} autoComplete="off" value={form.apiKey ?? ''} type="password"
            placeholder={hasSavedKey ? '已保存，留空沿用' : '填写密钥，本机免鉴权服务可留空'}
            onChange={(event) => patch({ apiKey: event.target.value || undefined })} /></label>
        <label className={label}><span>默认模型 ID</span><input className={field} value={form.model ?? ''}
          placeholder="使用接口返回的模型 ID" onChange={(event) => patch({ model: event.target.value || undefined })} /></label>
        {directory?.models.length ? <label className={label}><span>接口返回 {directory.models.length} 个模型</span>
          <select className={field} value={directory.models.some((entry) => entry.id === form.model) ? form.model : ''}
            onChange={(event) => patch({ model: event.target.value || undefined })}>
            <option value="">选择一个模型</option>
            {directory.models.map((entry) => <option key={entry.id} value={entry.id}>{entry.name}</option>)}
          </select></label> : null}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" size="sm" variant="secondary" disabled={pending || !form.label.trim() || !form.baseUrl.trim()}
          onClick={() => void action('read')}>{pending ? <Loader2 className="size-3.5 animate-spin" /> : null}读取模型</Button>
        {directory && !directory.models.length && <span className="text-xs text-muted">接口未列出模型，可手动填写。</span>}
        <div className="ml-auto flex flex-wrap gap-2">
          <Button type="button" size="sm" variant="ghost" disabled={pending} onClick={() => { setForm(undefined); setError(''); }}>取消</Button>
          <Button type="submit" size="sm" disabled={pending}>保存接口</Button>
        </div>
      </div>
    </form>}
    {error && <p role="alert" className="text-xs text-danger">{error}</p>}
    {!form && profiles.length > 0 && <div className="text-xs text-muted">在 <Link to="/new" className="font-medium text-accent hover:underline">新建运行</Link> 或会议里选择已添加的接口。</div>}
  </Card>;
}

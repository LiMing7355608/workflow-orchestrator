import { FolderOpen, Plus, Trash2 } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { pickDirectory } from '../../lib/api';
import type { AgentProfile } from '../../types/agent';
import type { MeetingActor, MeetingRole, MeetingSettings } from '../../types/operations';
import { AgentModelField } from '../agents/AgentModelField';
import { Button } from '../ui/Button';

export const inputStyle = 'w-full rounded-lg border border-line bg-surface px-2.5 py-2 text-xs text-ink placeholder:text-passive';
const labelStyle = 'block space-y-1.5 text-xs font-medium text-muted';

function ActorFields({ agents, value, onChange, host = false }: {
  agents: AgentProfile[]; value: MeetingActor; onChange: (actor: MeetingActor) => void; host?: boolean;
}) {
  const agentId = value.agentId || agents[0]?.id || '';
  return <div className="grid gap-3 sm:grid-cols-2">
    <label className={labelStyle}>
      <span>{host ? '主持 Agent' : '执行 Agent'}</span>
      <select className={inputStyle} value={agentId} onChange={(event) => onChange({ agentId: event.target.value })}>
        {agents.length === 0 && <option value="">暂无可用 Agent</option>}
        {agentId && !agents.some((agent) => agent.id === agentId) && <option value={agentId}>{agentId} · 不可用</option>}
        {agents.map((agent) => <option key={agent.id} value={agent.id}>{agent.label}</option>)}
      </select>
    </label>
    <AgentModelField agent={agents.find((agent) => agent.id === agentId)} value={value.model ?? ''}
      onChange={(model) => onChange({ agentId, model: model.trim() || undefined })} label={host ? '主持模型' : '成员模型'} />
  </div>;
}

export function MeetingEditor({ agents, initial, directory, canBrowse, busy, onSave, onCancel }: {
  agents: AgentProfile[];
  initial?: MeetingSettings;
  directory?: string;
  canBrowse: boolean;
  busy: boolean;
  onSave: (settings: MeetingSettings, root: string) => void;
  onCancel?: () => void;
}) {
  const [settings, setSettings] = useState<MeetingSettings>(initial ?? {
    title: '', agenda: '', mode: 'manual', host: { agentId: '' }, roles: [], rounds: 2,
  });
  const [folder, setFolder] = useState(directory ?? '');
  const [browsing, setBrowsing] = useState(false);
  const [error, setError] = useState('');
  const firstAgent = agents[0]?.id || '';
  const [keys, setKeys] = useState(() => settings.roles.map(() => crypto.randomUUID()));
  const change = (patch: Partial<MeetingSettings>) => setSettings((current) => ({ ...current, ...patch }));

  const updateRole = (index: number, patch: Partial<MeetingRole>) => {
    setSettings((current) => ({ ...current, roles: current.roles.map((role, at) => at === index ? { ...role, ...patch } : role) }));
  };

  async function browse() {
    setBrowsing(true);
    const selected = await pickDirectory();
    setBrowsing(false);
    if (selected?.path) setFolder(selected.path);
    else if (selected?.message) setError(selected.message);
  }

  function save(event: FormEvent) {
    event.preventDefault();
    setError('');
    const host = { ...settings.host, agentId: settings.host.agentId || firstAgent };
    if (!host.agentId || !folder.trim()) { setError('请选择主持 Agent 和会议目录。'); return; }
    onSave({ ...settings, host, roles: settings.roles.map((role) => ({ ...role, agentId: role.agentId || firstAgent })) }, folder.trim());
  }

  return <form onSubmit={save} className="space-y-4">
    <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_130px]">
      <label className={labelStyle}><span>会议名称</span>
        <input className={inputStyle} value={settings.title} onChange={(event) => change({ title: event.target.value })} required maxLength={100} placeholder="例如 校园活动报名方案评审" />
      </label>
      <label className={labelStyle}><span>每次讨论轮数</span>
        <select value={settings.rounds} className={inputStyle} onChange={(event) => change({ rounds: Number(event.target.value) })}>
          {[1, 2, 3, 4].map((rounds) => <option key={rounds} value={rounds}>{rounds} 轮</option>)}
        </select>
      </label>
    </div>
    <label className={labelStyle}><span>议题与预期结果</span>
      <textarea className={inputStyle} value={settings.agenda} onChange={(event) => change({ agenda: event.target.value })} required rows={4} maxLength={8000}
        placeholder="需要讨论什么？希望最后得到哪些决策或方案？" />
    </label>
    <label className={labelStyle}><span>产物目录</span>
      <div className="flex gap-2">
        <input className={inputStyle} value={folder} onChange={(event) => setFolder(event.target.value)} required readOnly={Boolean(initial)} placeholder="选择已有目录或粘贴其绝对路径" />
        {!initial && canBrowse && <Button variant="secondary" type="button" disabled={browsing} onClick={() => void browse()}><FolderOpen className="size-4" />浏览</Button>}
      </div>
    </label>
    <fieldset className="space-y-2 rounded-xl border border-line p-3">
      <legend className="px-1 text-xs font-semibold text-ink">组织方式</legend>
      <div className="flex flex-wrap gap-2">
        {(['manual', 'auto'] as const).map((mode) => <label key={mode} className={`flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs ${settings.mode === mode ? 'border-accent/35 bg-accent-soft' : 'border-line'}`}>
          <input type="radio" name="meeting-mode" checked={settings.mode === mode} onChange={() => change({ mode })} className="accent-accent" />
          {mode === 'manual' ? '手动安排成员' : '主持模型托管分配'}
        </label>)}
      </div>
      <ActorFields agents={agents} value={settings.host} onChange={(host) => change({ host })} host />
    </fieldset>
    <div className="flex flex-wrap items-center justify-between gap-2">
      <h3 className="text-sm font-semibold text-ink">成员角色</h3>
      <Button variant="secondary" size="sm" type="button" disabled={settings.roles.length >= 8 || !firstAgent} onClick={() => {
        setKeys([...keys, crypto.randomUUID()]);
        change({ roles: [...settings.roles, { name: '', responsibility: '', prompt: '', agentId: firstAgent }] });
      }}><Plus className="size-3.5" />添加角色</Button>
    </div>
    {settings.roles.length === 0 && <p className="text-xs text-muted">{settings.mode === 'auto' ? '保存后，主持模型会根据议题分配角色。' : '添加角色，设置该成员的职责、提示词与模型。'}</p>}
    {settings.roles.map((role, index) => <div key={keys[index]} className="space-y-3 rounded-xl border border-line p-3">
      <div className="grid gap-2 sm:grid-cols-[minmax(0,0.8fr)_minmax(0,1fr)_auto]">
        <label className={labelStyle}><span>角色名称</span><input className={inputStyle} value={role.name} required maxLength={60}
          onChange={(event) => updateRole(index, { name: event.target.value })} placeholder="例如 产品经理" /></label>
        <label className={labelStyle}><span>负责事项</span><input className={inputStyle} value={role.responsibility} required maxLength={240}
          onChange={(event) => updateRole(index, { responsibility: event.target.value })} placeholder="例如 核对用户场景与验收" /></label>
        <Button variant="ghost" size="sm" type="button" className="self-end text-danger" onClick={() => {
          setKeys(keys.filter((_, at) => at !== index));
          change({ roles: settings.roles.filter((_, at) => at !== index) });
        }}><Trash2 className="size-3.5" />移除角色</Button>
      </div>
      <ActorFields agents={agents} value={role} onChange={(actor) => updateRole(index, { ...actor, model: actor.model })} />
      <label className={labelStyle}><span>角色提示词</span>
        <textarea className={inputStyle} value={role.prompt} required rows={2} maxLength={4000} onChange={(event) => updateRole(index, { prompt: event.target.value })}
          placeholder="说明如何分析、发现风险和向其他成员提问。" />
      </label>
    </div>)}
    {error && <p className="text-xs text-danger" role="alert">{error}</p>}
    <div className="flex flex-wrap justify-end gap-2">
      {onCancel && <Button variant="secondary" type="button" onClick={onCancel}>取消</Button>}
      <Button type="submit" disabled={busy || !firstAgent}>{busy ? '正在保存…' : initial ? '保存会议设置' : settings.mode === 'auto' ? '创建并分配角色' : '创建会议'}</Button>
    </div>
  </form>;
}

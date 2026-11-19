import { useId } from 'react';
import type { AgentProfile } from '../../types/agent';

export function canSelectModel(agent?: AgentProfile): boolean {
  return Boolean(agent && (agent.transport === 'acp' || agent.transport === 'codex-app-server' ||
    agent.transport === 'claude-sdk' || (!agent.transport || agent.transport === 'cli') && agent.launch.modelArgs));
}

export function AgentModelField({ agent, value, onChange, disabled = false, label = '模型' }: {
  agent?: AgentProfile;
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  label?: string;
}) {
  const id = useId();
  const available = canSelectModel(agent);
  const suggestions = agent?.id === 'dsh-acp' ? ['deepseek-v4-flash', 'deepseek-v4-pro'] : [];
  return (
    <label className="block min-w-0 space-y-1.5 text-[12px] font-medium text-muted">
      <span>{label}</span>
      <input
        value={value}
        onChange={(event) => onChange(event.target.value)}
        disabled={!available || disabled}
        maxLength={128}
        list={suggestions.length ? id : undefined}
        placeholder="客户端默认模型"
        className="h-9 w-full rounded-lg border border-line bg-surface px-2.5 text-[12px] text-ink disabled:bg-subtle"
      />
      {suggestions.length > 0 && <datalist id={id}>{suggestions.map((model) => <option key={model} value={model} />)}</datalist>}
      <span className="block text-[10px] font-normal text-muted">{available ? '留空使用默认值。也可输入客户端支持的模型 ID。' : '由所选 Agent 的客户端配置。'}</span>
    </label>
  );
}
